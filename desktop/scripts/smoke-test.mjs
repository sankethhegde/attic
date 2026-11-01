// Smoke test: starts a throwaway copy of server/ (temporary shares and data, port 8090), opens the desktop
// tool (or a built exe) pointed at it, signs in, and checks every view renders inside the tool window with
// no console errors. The tool is pre-seeded with the server's address, so a real HP on the network
// can't change the outcome; discovery itself is covered by discovery-test.mjs.
// Usage (from desktop/): node scripts/smoke-test.mjs [path-to-exe]
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const repo = path.join(desktop, '..');
const exe = process.argv[2];
const CDP_PORT = 9341, HTTP_PORT = 8090;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-hub-test-'));
const profile = path.join(tmp, 'profile');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A small share with a folder of documents and a few media files.
const share = path.join(tmp, 'share');
for (const [f, body] of [['Documents/notes.txt', 'notes'], ['Documents/plan.md', '# plan'], ['Photos/sky.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'], ['Music/song.mp3', 'x'], ['clip.mp4', 'x']]) {
  fs.mkdirSync(path.dirname(path.join(share, f)), { recursive: true });
  fs.writeFileSync(path.join(share, f), body);
}
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: HTTP_PORT, host: '127.0.0.1', discovery: { enabled: false },
  shares: [{ id: 'main', name: 'Test share', rootPath: share, deviceType: 'hdd' }] }));
const server = spawn(process.execPath, [path.join(repo, 'server', 'server.js')], {
  env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(HTTP_PORT) }), stdio: 'ignore' });
for (let i = 0; i < 60; i++) { if (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/hello`).then(r => r.ok, () => false)) break; await sleep(250); }
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify({ address: '127.0.0.1', port: HTTP_PORT }));

const args = [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`];
const proc = exe
  ? spawn(exe, args, { stdio: 'ignore' })
  : spawn(path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', ...args], { cwd: desktop, stdio: 'ignore' });

let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === 'page'); } catch {}
}
if (!target) { console.error('Tool window never appeared'); proc.kill(); server.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = {}; const errors = [];
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map(a => a.value || a.description).join(' '));
};
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => {
  const r = await Promise.race([send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }), sleep(20000).then(() => null)]);
  if (!r) return 'TIMEOUT';
  return r.result.exceptionDetails ? 'ERR ' + (r.result.exceptionDetails.exception?.description || '') : r.result.result.value;
};
await send('Runtime.enable');

const results = {};
const t0 = Date.now();
for (let i = 0; i < 80; i++) {
  const v = await ev(`return location.protocol === 'http:' && !!window.Attic`).catch(() => false);
  if (v === true) break;
  await sleep(250);
}
results.connectMs = Date.now() - t0;
results.inTool = await ev(`return { desktop: !!window.atticDesktop, version: window.atticDesktop && window.atticDesktop.version, origin: location.origin, title: document.title }`);
results.setup = await ev(`
  for (let i = 0; i < 100 && !document.querySelector('h1'); i++) await new Promise(r => setTimeout(r, 100));
  const h1 = document.querySelector('h1') && document.querySelector('h1').textContent;
  await Attic.api.createMaster({ displayName: 'Test', username: 'master', password: 'test1234' });
  await Attic.api.signIn({ mode: 'master', username: 'master', password: 'test1234', stay: true });
  return h1;`);
await send('Page.reload'); await sleep(2500);

const views = ['#/dashboard', '#/files', '#/files/main/Documents', '#/photos', '#/videos', '#/other', '#/devices', '#/transfers', '#/settings'];
for (const h of views) {
  results[h] = await ev(`
    location.hash = '${h}';
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 100)); if (!document.querySelector('.skel') && document.querySelector('.page')) break; }
    await new Promise(r => setTimeout(r, 400));
    const err = document.querySelector('.state.error');
    const main = document.querySelector('#main');
    const content = main.querySelectorAll('.row, .ptile, .vcard, .otile, .hub-card, .tr-row, .share-card, .set-row, .leg, .dl-row, .state').length;
    return (err ? 'ERROR STATE ' : 'ok') + ' · ' + document.title + ' · ' + content + ' items';`);
}
results.serverSection = await ev(`location.hash = '#/settings'; for (let i = 0; i < 30 && (!document.querySelector('#srv-now') || document.querySelector('#srv-now .skel')); i++) await new Promise(r => setTimeout(r, 100)); return document.querySelector('#srv-now') && document.querySelector('#srv-now').textContent`);
results.reloadKeepsSession = await ev(`return !!(await Attic.api.getSession())`);
results.consoleErrors = errors.filter(e => !/fonts\.(googleapis|gstatic)/.test(e));

console.log(JSON.stringify(results, null, 2));
const failed = results.consoleErrors.length || Object.values(results).some(v => typeof v === 'string' && /^(ERROR STATE|ERR|TIMEOUT)/.test(v));
ws.close(); proc.kill(); server.kill();
setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} process.exit(failed ? 1 : 0); }, 800);
