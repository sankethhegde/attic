// Phase 1B smoke test: starts the desktop tool (or a built exe), drives it over the DevTools protocol,
// and checks that every view renders inside the tool window with no console errors.
// Usage: node scripts/smoke-test.mjs [path-to-exe]   (default: the dev build via electron .)
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const exe = process.argv[2];
const port = 9341;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-hub-test-'));
const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`];
const proc = exe
  ? spawn(exe, args, { stdio: 'ignore' })
  : spawn(path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', ...args], { cwd: desktop, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page' && t.url.includes('index.html')); } catch {}
}
if (!target) { console.error('Tool window never appeared'); proc.kill(); process.exit(1); }

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
results.inTool = await ev(`for (let i = 0; i < 100 && !window.Attic; i++) await new Promise(r => setTimeout(r, 100)); return {`);
results.startupMs = Date.now() - t0;
results.inTool = await ev(`return { desktop: !!window.atticDesktop, version: window.atticDesktop && window.atticDesktop.version, protocol: location.protocol, title: document.title }`);
results.setup = await ev(`
  for (let i = 0; i < 100 && !(window.Attic && document.querySelector('h1')); i++) await new Promise(r => setTimeout(r, 100));
  const h1 = document.querySelector('h1') && document.querySelector('h1').textContent;
  await Attic.api.createMaster({ displayName: 'Test', username: 'master', password: 'test1234' });
  await Attic.api.signIn({ mode: 'master', username: 'master', password: 'test1234', stay: true });
  return h1;`);
await send('Page.reload'); await sleep(2500);

const views = ['#/dashboard', '#/files', '#/files/main/Documents', '#/photos', '#/videos', '#/other', '#/devices', '#/transfers', '#/settings', '#/dashboard/videos'];
for (const h of views) {
  results[h] = await ev(`
    location.hash = '${h}';
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 100)); if (!document.querySelector('.skel') && document.querySelector('.page')) break; }
    await new Promise(r => setTimeout(r, 300));
    const err = document.querySelector('.state.error');
    const main = document.querySelector('#main');
    const content = main.querySelectorAll('.row, .ptile, .vcard, .otile, .hub-card, .tr-row, .share-card, .set-row, .leg, .dl-row').length;
    return (err ? 'ERROR STATE ' : 'ok') + ' · ' + document.title + ' · ' + content + ' items';`);
}
results.reloadKeepsSession = await ev(`return !!(await Attic.api.getSession())`);
results.persistsAfterRestartCheck = 'profile ' + profile;
results.consoleErrors = errors.filter(e => !/fonts\.(googleapis|gstatic)/.test(e));

console.log(JSON.stringify(results, null, 2));
ws.close(); proc.kill();
setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} process.exit(results.consoleErrors.length ? 1 : 0); }, 800);
