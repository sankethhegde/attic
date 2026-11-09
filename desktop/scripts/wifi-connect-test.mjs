// The Wi-Fi fix (8 Nov 2026): a client finds the HP by itself, with no "Search again", when the broadcast
// can't reach it (dropped by Wi-Fi, or a firewall) and its address changed.
//   1. The HP's server starts AFTER the client is already looking; discovery (broadcast) is off on it, and
//      the remembered address is wrong. The client keeps trying by itself and connects through the sweep.
//   2. The remembered address is wrong but the HP's PC name is known: it connects by name at once.
// A throwaway server on port 8091, on this PC's network address. Usage (from desktop/): node scripts/wifi-connect-test.mjs [exe]
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const repo = path.join(desktop, '..');
const exe = process.argv[2];
const HTTP_PORT = 8091, CDP_PORT = 9356;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-wifi-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal && /^(10\.|192\.168\.|172\.)/.test(i.address));
if (!lan) { console.log('FAIL  this PC needs a home-network address for this test'); process.exit(1); }

fs.mkdirSync(path.join(tmp, 'share'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: HTTP_PORT, host: '0.0.0.0', discovery: { enabled: false }, https: { enabled: false },
  pairing: { required: true, trustThisPC: true }, shares: [{ id: 'main', name: 'Main drive', rootPath: path.join(tmp, 'share'), deviceType: 'hdd' }] }));
let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(repo, 'server', 'server.js')], { stdio: 'ignore',
    env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(HTTP_PORT) }) });
  for (let i = 0; i < 60; i++) { const h = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/hello`).then(r => r.ok ? r.json() : null, () => null); if (h) return h; await sleep(250); }
  throw new Error('the server didn’t start');
}
async function stopServer() { if (server) { server.kill(); await new Promise(r => server.once('exit', r)); server = null; } }

const profile = path.join(tmp, 'profile');
let tool = null, ws = null, id = 0;
const pending = {};
const send = (method, params = {}) => Promise.race([new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); }), sleep(15000).then(() => ({}))]);
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }); return r.result && !r.result.exceptionDetails ? r.result.result.value : null; };
async function launch() {
  const args = [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`];
  const env = Object.assign({}, process.env, { ATTIC_AUTO_RETRY_MS: '2000', ATTIC_GITHUB_API: 'off' });
  tool = exe ? spawn(exe, args, { stdio: 'ignore', env }) : spawn(path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', ...args], { cwd: desktop, stdio: 'ignore', env });
  let target;
  for (let i = 0; i < 80 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === 'page'); } catch {} }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } };
}
async function quit() { try { ws.close(); } catch {} if (tool) { tool.kill(); await new Promise(r => tool.once('exit', r)); tool = null; } await sleep(500); }
// Where the window is: the start screen's text, or the HP's own page.
const where = () => ev(`return location.protocol === 'file:' ? 'start: ' + document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400) : location.href`);
async function until(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(400); } return null; }

try {
  // The HP's identity, then off.
  const hello = await startServer();
  await stopServer();
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'mode.json'), JSON.stringify({ mode: 'client' }));
  fs.writeFileSync(path.join(profile, 'prefs.json'), JSON.stringify({ startWithWindows: false, explorerMenu: false, trayHintShown: true, lowResource: 'off' }));
  // Remembered at an address nobody has, under a name nobody has: only the sweep can find it.
  fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify({ serverId: hello.serverId, name: 'NO-SUCH-PC-X1', address: '203.0.113.9', port: HTTP_PORT }));

  // 1. The client starts first and finds nothing; it keeps looking by itself.
  await launch();
  const looking = await until(async () => { const w = await where(); return w && /Try 2. Attic Hub keeps looking by itself/.test(w) && w; }, 40000);
  check('with the HP off, the client says it’s still looking and will try again by itself (no Search again needed)', looking, looking && looking.slice(0, 140));
  // The HP comes on (broadcast off): the client connects by itself.
  const t0 = Date.now();
  await startServer();
  const opened = await until(async () => { const w = await where(); return w && w.startsWith('http') && w; }, 40000);
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'server.json'), 'utf8'));
  check('the HP comes on with broadcasts unreachable: the client connects by itself, through the network sweep', opened && saved.address === lan.address,
    `${opened} after ${Math.round((Date.now() - t0) / 1000)} s; remembered now at ${saved.address}`);
  await quit();

  // 2. A wrong address, but the HP's PC name: found by name at once.
  fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify({ serverId: hello.serverId, name: os.hostname(), address: '203.0.113.9', port: HTTP_PORT }));
  const t1 = Date.now();
  await launch();
  const byName = await until(async () => { const w = await where(); return w && w.startsWith('http') && w; }, 30000);
  const saved2 = JSON.parse(fs.readFileSync(path.join(profile, 'server.json'), 'utf8'));
  check('its address changed but its PC name is known: it connects by name, straight away', byName && saved2.address.toLowerCase() === os.hostname().toLowerCase() && Date.now() - t1 < 15000,
    `${byName} after ${Math.round((Date.now() - t1) / 1000)} s; remembered as ${saved2.address}`);
  await quit();

  // 3. A paired PC, and the HP's address changes (9 Nov 2026 bug: it asked to pair again and the HP
  //    listed it as a new device). The pairing must follow the HP to its new address.
  let master = '';
  const hp = async (method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${HTTP_PORT}${url}`, { method, headers: { Cookie: master, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith('attic_session='));
    if (set) master = set;
    return r.json().catch(() => null);
  };
  await hp('POST', '/api/setup', { displayName: 'Test', username: 'master', password: 'test1234' });
  await hp('POST', '/api/session', { mode: 'master', username: 'master', password: 'test1234' });
  // Paired while the HP was at this PC's network address.
  fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify({ serverId: hello.serverId, name: os.hostname(), address: lan.address, port: HTTP_PORT }));
  await launch();
  const pairScreen = await until(() => ev(`return location.hash === '#/pair' && !!document.querySelector('#pr-code')`), 20000);
  const code = (await hp('POST', '/api/pairing/codes', {})).code;
  await ev(`const c = document.querySelector('#pr-code'); c.value = '${code}'; c.dispatchEvent(new Event('input')); document.querySelector('.login-card').requestSubmit(); return 1`);
  const paired = await until(() => ev(`return location.hash === '#/login' && location.hash`), 15000);
  const clientsBefore = (await hp('GET', '/api/devices')).filter(d => d.role === 'client').length;
  check('set-up: the PC pairs with the HP at its first address', pairScreen && paired && clientsBefore === 1, `${paired} · ${clientsBefore} client(s) on the HP`);
  // That first address now belongs to nobody: the pairing sits at 203.0.113.9, as if the HP moved off it.
  const OLD = '203.0.113.9';
  const jar = ((await send('Network.getAllCookies')).result || {}).cookies || [];
  for (const c of jar.filter(c => /^attic_/.test(c.name) && c.domain === lan.address)) {
    await send('Network.setCookie', { url: `http://${OLD}:${HTTP_PORT}/`, name: c.name, value: c.value, path: c.path, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, expires: c.expires > 0 ? c.expires : undefined });
    await send('Network.deleteCookies', { name: c.name, domain: lan.address });
  }
  await sleep(800);
  await quit();
  // The HP is found again at a different address (here: by its PC name).
  fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify({ serverId: hello.serverId, name: os.hostname(), address: OLD, port: HTTP_PORT }));
  await launch();
  const landed = await until(() => ev(`return location.protocol.startsWith('http') && /^#\\/(login|pair|$)/.test(location.hash || '#/') && document.querySelector('#lg-user, #pr-code') && location.host + ' ' + location.hash`), 30000);
  const clientsAfter = (await hp('GET', '/api/devices')).filter(d => d.role === 'client').length;
  check('the HP at a new address: still paired (sign-in, not the pairing screen), and no new device on the HP',
    landed && /#\/login/.test(landed) && clientsAfter === 1, `${landed} · ${clientsAfter} client(s) on the HP`);
  await quit();
} catch (e) {
  check('the test ran to the end', false, e.stack);
} finally {
  await quit().catch(() => {});
  await stopServer().catch(() => {});
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
