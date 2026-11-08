// Phase 3, 3-1 end-to-end test: the first-launch choice and Server mode, in the real desktop tool.
// Client: chosen once, then remembered. Server: set up a new server, check an existing folder, start
// it without installing, open its interface (trusted as the HP), see the role in Settings, stop it.
// With an exe, also runs the packaged tool the way the Windows startup task will, windowless, and checks
// the server comes up and serves the interface. Nothing installs a real Windows task.
// Usage (from desktop/): node scripts/mode-test.mjs [path-to-exe]
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const exe = process.argv[2];
const PORT = 8079, CDP_PORT = 9348;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-3-1-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const hello = () => fetch(`http://127.0.0.1:${PORT}/api/hello`).then(r => r.json(), () => null);

let tool = null, ws = null, id = 0;
const pending = {};
async function launchTool(profile) {
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
  const r = await Promise.race([send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }), sleep(30000).then(() => null)]);
  if (!r) return 'TIMEOUT';
  return r.result.exceptionDetails ? 'ERR ' + (r.result.exceptionDetails.exception?.description || '') : r.result.result.value;
};
async function waitFor(cond, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await ev(`try { return (${cond}) || null; } catch (e) { return null; }`).catch(() => null);
    if (v && v !== 'TIMEOUT' && !String(v).startsWith('ERR')) return v;
    await sleep(200);
  }
  return null;
}
// Closes the tool as a person would (so it quits normally and stops what it started), then makes sure.
async function quitTool() {
  if (!tool) return;
  try { await Promise.race([send('Browser.close'), sleep(3000)]); } catch {}
  for (let i = 0; i < 20 && tool.exitCode === null; i++) await sleep(250);
  try { ws.close(); } catch {} try { tool.kill(); } catch {}
  tool = null;
  await sleep(800);
}
const click = sel => ev(`document.querySelector(${JSON.stringify(sel)}).click(); return 1`);

let headless = null;
try {
  // ---- Client ----
  const clientProfile = path.join(tmp, 'client');
  await launchTool(clientProfile);
  const welcome = await waitFor(`document.querySelector('#c-title') && document.querySelectorAll('[data-mode]').length === 2 && document.querySelector('#c-form').hidden && document.querySelector('#c-title').textContent`);
  check('the first launch asks whether this PC is the server or a client', welcome === 'Welcome to Attic Hub', welcome);
  await click('[data-mode="client"]');
  const searching = await waitFor(`/Looking for|No Attic server|Found|More than one/.test(document.querySelector('#c-title').textContent) && document.querySelector('#c-title').textContent`);
  const saved = JSON.parse(fs.readFileSync(path.join(clientProfile, 'mode.json'), 'utf8')).mode;
  check('Client goes on to look for the HP, and is remembered', searching && saved === 'client', `${searching} · mode.json: ${saved}`);
  await quitTool();
  await launchTool(clientProfile);
  const again = await waitFor(`document.querySelector('#c-title') && !document.querySelector('[data-mode]') && document.querySelector('#c-title').textContent`);
  check('a client isn’t asked again on the next start', again && again !== 'Welcome to Attic Hub', again);
  await quitTool();

  // ---- Server ----
  const serverProfile = path.join(tmp, 'server');
  const storage = path.join(tmp, 'Attic storage');
  await launchTool(serverProfile);
  await waitFor(`document.querySelectorAll('[data-mode]').length === 2`);
  await click('[data-mode="server"]');
  const setup = await waitFor(`location.href.endsWith('server.html') && document.querySelector('#s-form') && document.querySelector('#s-store') && document.querySelector('#s-store').value`);
  check('Server opens the server screen, offering a new server with a suggested folder', setup, setup);
  await click('[data-kind="existing"]');
  await waitFor(`document.querySelector('#s-existing')`);
  await ev(`document.querySelector('#s-existing').value = ${JSON.stringify(tmp)}; document.querySelector('#s-form').requestSubmit(); return 1`);
  const bad = await waitFor(`document.querySelector('#s-error').textContent`);
  check('an existing folder without a server is refused, with the reason', /no config\.json/.test(bad || ''), bad);
  await click('[data-kind="new"]');
  await waitFor(`document.querySelector('#s-store')`);
  await ev(`document.querySelector('#s-store').value = ${JSON.stringify(storage)}; document.querySelector('#s-name').value = 'Main storage';
    document.querySelector('#s-port').value = '${PORT}'; document.querySelector('#s-form').requestSubmit(); return 1`);
  const managed = await waitFor(`document.querySelector('.srv-rows') && document.querySelector('.srv-rows').textContent.replace(/\\s+/g, ' ').trim()`);
  const cfg = JSON.parse(fs.readFileSync(path.join(serverProfile, 'server', 'config.json'), 'utf8'));
  check('a new server is created: config.json in the tool’s folder, and the storage folder', managed && /Not installed/.test(managed) && /Not running/.test(managed) && cfg.port === PORT && fs.existsSync(storage) && cfg.shares[0].rootPath === storage,
    managed);
  const buttons = await ev(`return [...document.querySelectorAll('[data-act]')].map(b => b.dataset.act).join(',')`);
  check(exe ? 'the installed tool offers Install and Start now' : 'a development copy offers Start now, not Install', exe ? /install/.test(buttons) && /startNow/.test(buttons) : !/install/.test(buttons) && /startNow/.test(buttons), buttons);

  await click('[data-act="startNow"]');
  const up = await waitFor(`document.querySelector('.srv-rows') && /Answering as/.test(document.querySelector('.srv-rows').textContent) && document.querySelector('.srv-rows').textContent.replace(/\\s+/g, ' ').trim()`, 30000);
  const h = await hello();
  check('Start now runs the server under the supervisor, without installing anything', up && h && h.app === 'Attic' && /until Attic Hub closes/.test(up), up);
  // 8 Nov 2026: the card shows this PC's address on the home network, as the other devices use it.
  const lanIps = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')).map(i => i.address);
  const shownIp = await waitFor(`[...document.querySelectorAll('[data-ip]')].map(e => e.textContent).join(',')`, 5000);
  const addrRow = await waitFor(`[...document.querySelectorAll('.srv-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim()).find(t => t.startsWith('Address'))`, 5000);
  check('the server card shows this PC’s address (like 192.168.1.3), Wi-Fi or Ethernet, and the browser address', shownIp && lanIps.includes(shownIp.split(',')[0]) && /http:\/\/\d+\.\d+\.\d+\.\d+:\d+/.test(addrRow || ''), addrRow);
  const logs = fs.existsSync(path.join(serverProfile, 'server', 'data', 'logs')) && fs.readdirSync(path.join(serverProfile, 'server', 'data', 'logs')).length;
  check('the supervisor writes its log in the server’s data folder', logs, logs ? 'data\\logs' : 'no logs');

  await click('[data-act="open"]');
  const own = await waitFor(`location.href.startsWith('http://localhost:${PORT}/') && document.querySelector('h1') && document.querySelector('h1').textContent`, 20000);
  check('Open Attic shows this server’s own interface, with no pairing (it’s the HP)', own === 'Set up Attic', own);
  await ev(`await Attic.api.createMaster({ displayName: 'HP', username: 'master', password: 'test1234' });
    await Attic.api.signIn({ mode: 'master', username: 'master', password: 'test1234' }); location.hash = '#/settings'; location.reload(); return 1`);
  const role = await waitFor(`document.querySelector('#srv-role') && !document.querySelector('#srv-role .skel') && document.querySelector('#srv-role').textContent.replace(/\\s+/g, ' ').trim()`);
  const hidden = await ev(`return [...document.querySelectorAll('[data-client]')].every(r => r.hidden)`);
  check('Settings says this PC is the server, with Server controls; the client rows are hidden', /The server/.test(role || '') && /Server controls/.test(role || '') && hidden === true, role);
  await click('#srv-controls');
  const back = await waitFor(`location.href.endsWith('server.html') && document.querySelector('[data-act="stop"]') && 'server screen'`);
  check('Server controls returns to the server screen', back, back);
  await click('[data-act="stop"]');
  await waitFor(`document.querySelector('.dialog .btn-primary')`);
  await click('.dialog .btn-primary');
  const stopped = await waitFor(`document.querySelector('.srv-rows') && /Not running/.test(document.querySelector('.srv-rows').textContent) && 'stopped'`, 20000);
  check('Stop stops the server', stopped && !(await hello()), stopped);
  await click('[data-act="startNow"]');
  await waitFor(`/Answering as/.test(document.querySelector('.srv-rows').textContent)`, 30000);
  await quitTool();
  await sleep(1500);
  check('a server started for now stops when the tool closes', !(await hello()), '');

  // ---- the startup task's way of running it (packaged only) ----
  if (exe) {
    const supervisor = path.join(path.dirname(exe), 'resources', 'server', 'service', 'supervisor.js');
    check('the installed tool carries the server and the interface as plain folders', fs.existsSync(supervisor) && fs.existsSync(path.join(path.dirname(supervisor), '..', '..', 'ui', 'index.html')), supervisor);
    const outFile = path.join(tmp, 'headless.txt');
    headless = spawn(exe, [supervisor, `--user-data-dir=${serverProfile}`], { stdio: ['ignore', fs.openSync(outFile, 'w'), fs.openSync(outFile, 'a')] });
    let h2 = null;
    for (let i = 0; i < 60 && !h2; i++) { await sleep(500); h2 = await hello(); }
    const page = h2 && await fetch(`http://127.0.0.1:${PORT}/`).then(r => r.text(), () => '');
    const logDir = path.join(serverProfile, 'server', 'data', 'logs');
    const logTail = () => fs.existsSync(logDir) ? fs.readdirSync(logDir).sort().slice(-1).map(f => fs.readFileSync(path.join(logDir, f), 'utf8').trim().split('\n').slice(-4).join(' | ')).join('') : 'no log';
    check('run as the task runs it (Attic Hub.exe supervisor.js), the server starts with no window', h2 && h2.app === 'Attic' && /<title>/.test(page || ''),
      h2 ? `answers as ${h2.name}, serves the interface` : `not answering; exit ${headless.exitCode}; output: ${fs.readFileSync(outFile, 'utf8').trim().split(/\r?\n/).slice(-3).join(' | ')}`);
    const state = JSON.parse(fs.readFileSync(path.join(serverProfile, 'server', 'data', 'supervisor.json'), 'utf8'));
    check('the supervisor runs it, with its state where the service commands look', state.running && state.serverPid, `supervisor ${state.supervisorPid}, server ${state.serverPid}`);
    fs.writeFileSync(path.join(serverProfile, 'server', 'data', 'supervisor.stop'), 'test');
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) { await sleep(500); gone = headless.exitCode !== null && !(await hello()); }
    check('it stops cleanly when asked, as the Stop button asks', gone, gone ? `exit ${headless.exitCode}` : 'still running');
    headless = null;
  }
} catch (e) {
  check('test ran to the end', false, e.stack || e.message);
} finally {
  await quitTool();
  try { headless && headless.kill(); } catch {}
  await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
