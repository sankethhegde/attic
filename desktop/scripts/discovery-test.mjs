// Phase 2, 2-1 end-to-end test: the desktop tool finds a server by itself, opens its interface, survives
// the server going away, accepts a typed address, and reconnects to the remembered server on restart.
// It starts a throwaway copy of server/ (temporary shares and data, port 8088) on this PC.
// Usage (from desktop/): node scripts/discovery-test.mjs [path-to-exe]
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const repo = path.join(desktop, '..');
const exe = process.argv[2];
const HTTP_PORT = 8088, CDP_PORT = 9343;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-2-1-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// ---- a throwaway server ----
fs.mkdirSync(path.join(tmp, 'share'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'share', 'hello.txt'), 'hi');
// Pairing (2-2) is off here: the tool may reach this server through the PC's network address, and this
// test is about finding it. scripts/pairing-test.mjs covers pairing.
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: HTTP_PORT, host: '0.0.0.0', pairing: { required: false },
  shares: [{ id: 'main', name: 'Test share', rootPath: path.join(tmp, 'share'), deviceType: 'hdd' }] }));
let server = null;
function startServer() {
  server = spawn(process.execPath, [path.join(repo, 'server', 'server.js')], {
    env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(HTTP_PORT) }),
    stdio: 'ignore'
  });
}
async function waitHttp(up) {
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/hello`).then(r => r.ok, () => false);
    if (ok === up) return true;
    await sleep(250);
  }
  return false;
}

// ---- the desktop tool, driven over the DevTools protocol ----
const profile = path.join(tmp, 'profile');
let tool = null, ws = null, id = 0;
const pending = {};
async function launchTool() {
  const args = [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`];
  tool = exe ? spawn(exe, args, { stdio: 'ignore' })
    : spawn(path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', ...args], { cwd: desktop, stdio: 'ignore' });
  let target;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === 'page'); } catch {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } };
}
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => {
  const r = await Promise.race([send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }), sleep(20000).then(() => null)]);
  if (!r) return 'TIMEOUT';
  return r.result.exceptionDetails ? 'ERR ' + (r.result.exceptionDetails.exception?.description || '') : r.result.result.value;
};
// Polls the page until `cond` (a JS expression) is truthy; the page may navigate between polls.
async function waitFor(cond, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await ev(`try { return (${cond}) || null; } catch (e) { return null; }`).catch(() => null);
    if (v && v !== 'TIMEOUT' && !String(v).startsWith('ERR')) return v;
    await sleep(300);
  }
  return null;
}
function quitTool() { try { ws.close(); } catch {} try { tool.kill(); } catch {} }

try {
  startServer();
  check('throwaway server starts', await waitHttp(true));
  const hello = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/hello`)).json();

  // 1. First launch: nothing remembered, so it must find the server by broadcast and open its interface.
  await launchTool();
  const started = await waitFor(`location.protocol === 'file:' && document.querySelector('h1') && document.querySelector('h1').textContent`, 5000);
  check('start screen shows while searching', started, started || '');
  // If a real HP is on the network too, the tool rightly asks which one; pick the throwaway server.
  let others = 0;
  const first = await waitFor(`(location.protocol === 'http:' && location.port === '${HTTP_PORT}' && 'opened') || (document.querySelector('[data-id="${hello.serverId}"]') && 'choose:' + document.querySelectorAll('.connect-choice').length)`, 20000);
  if (first && first.startsWith('choose:')) {
    others = Number(first.split(':')[1]) - 1;
    await ev(`document.querySelector('[data-id="${hello.serverId}"]').click(); return 1`);
  }
  const opened = await waitFor(`location.protocol === 'http:' && location.port === '${HTTP_PORT}' && location.href`);
  check('finds the server by itself and opens its interface', opened,
    opened ? opened + (others ? ` (chosen from a list: ${others} other server${others === 1 ? '' : 's'} answered too)` : '') : 'never left the start screen');
  const remembered = JSON.parse(fs.readFileSync(path.join(profile, 'server.json'), 'utf8'));
  check('remembers the server by its id', remembered.serverId === hello.serverId, `${remembered.name} ${remembered.address}:${remembered.port}`);

  // 2. Sign-in happens on the real server, inside the tool.
  const setup = await waitFor(`window.Attic && document.querySelector('h1') && document.querySelector('h1').textContent`);
  check('server-served setup screen loads in the tool', setup, setup);
  const signedIn = await ev(`
    await Attic.api.createMaster({ displayName: 'Test', username: 'master', password: 'test1234' });
    await Attic.api.signIn({ mode: 'master', username: 'master', password: 'test1234', stay: true });
    location.hash = '#/settings'; location.reload(); return true;`);
  const srvText = await waitFor(`document.querySelector('#srv-now') && !document.querySelector('#srv-now .skel') && document.querySelector('#srv-now').textContent`);
  check('Settings shows the connected server', srvText && srvText.includes(String(HTTP_PORT)), srvText || String(signedIn));
  const files = await ev(`location.hash = '#/files/main'; for (let i = 0; i < 40 && !document.querySelector('.vlist .row'); i++) await new Promise(r => setTimeout(r, 150)); return document.querySelectorAll('.vlist .row').length`);
  check('real files list through the tool', files >= 1, `${files} item(s)`);

  // 3. The server goes away: the tool notices and goes back to searching.
  server.kill();
  await waitHttp(false);
  const lost = await waitFor(`location.protocol === 'file:' && document.querySelector('#c-title') && /Can’t reach|Reconnecting|No Attic/.test(document.querySelector('#c-title').textContent) && document.querySelector('#c-title').textContent`, 50000);
  check('notices the server is gone and shows the start screen', lost, lost || 'stayed on the dead page');
  // With a real HP on the network, the search finds it instead and opens it; that's right too. Change
  // server then brings the start screen back for the typed-address checks.
  const notFound = await waitFor(`(location.protocol === 'file:' && document.querySelector('#c-retry') && document.querySelector('#c-title').textContent)
    || (location.protocol === 'http:' && location.port !== '${HTTP_PORT}' && 'moved to the other server at ' + location.host)`, 20000);
  check('ends on a not-found screen with Search again, or on the only other server', notFound, notFound);
  if (String(notFound).startsWith('moved')) {
    await ev(`atticDesktop.server.change(); return 1`);
    await waitFor(`location.protocol === 'file:' && document.querySelector('#c-go') && !document.querySelector('#c-go').disabled`, 20000);
  }

  // 4. A wrong typed address explains itself; a right one connects.
  await ev(`const a = document.querySelector('#c-addr'); a.value = '127.0.0.1:1'; document.querySelector('#c-form').requestSubmit(); return 1`);
  const bad = await waitFor(`document.querySelector('#c-addr-msg').textContent`);
  check('a wrong address gets a reason', bad, bad);
  await ev(`const a = document.querySelector('#c-addr'); a.value = '192.168.1'; document.querySelector('#c-form').requestSubmit(); return 1`);
  const malformed = await waitFor(`/four numbers/.test(document.querySelector('#c-addr-msg').textContent) && document.querySelector('#c-addr-msg').textContent`);
  check('a malformed address is caught', malformed, malformed);
  startServer();
  await waitHttp(true);
  await ev(`const a = document.querySelector('#c-addr'); a.value = 'http://127.0.0.1:${HTTP_PORT}/'; document.querySelector('#c-form').requestSubmit(); return 1`);
  const typed = await waitFor(`location.protocol === 'http:' && location.href`);
  check('a typed address connects', typed, typed);

  // 5. Restart the tool: it goes straight to the remembered server.
  quitTool();
  await sleep(1500);
  fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify(Object.assign(remembered, { address: '127.0.0.1' })));
  const t0 = Date.now();
  await launchTool();
  const again = await waitFor(`location.protocol === 'http:' && location.href`);
  check('restart reconnects to the remembered server', again, again && `${Date.now() - t0} ms`);
} catch (e) {
  check('test ran to the end', false, e.message);
} finally {
  quitTool();
  try { server && server.kill(); } catch {}
  await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
