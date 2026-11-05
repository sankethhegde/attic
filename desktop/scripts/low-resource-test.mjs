// Phase 3, 3-4 end-to-end test: low-resource mode (T-09) in the real desktop tool against a throwaway
// server (port 8077). The real game watcher runs, pointed at a Steam key of the test's own
// (ATTIC_STEAM_KEY, never Steam's), and sees a real full-screen window. Checks the slower reports at the
// HP, the interface holding still, Settings and the tray, Always on and Off, and that the watcher ends
// with the tool.
// Usage (from desktop/): node scripts/low-resource-test.mjs [path-to-exe]
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const repo = path.join(desktop, '..');
const exe = process.argv[2];
const HTTP_PORT = 8077, CDP_PORT = 9352;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-3-4-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const STEAM_SUB = `Software\\AtticHubTest\\Steam${process.pid}`;
const reg = args => execFileSync('reg.exe', args, { windowsHide: true, stdio: 'ignore' });
const steamGame = id => reg(['add', `HKCU\\${STEAM_SUB}`, '/v', 'RunningAppID', '/t', 'REG_DWORD', '/d', String(id), '/f']);
steamGame(0);

const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
if (!lan) { console.log('FAIL  this PC needs a network address (Wi-Fi or Ethernet) for this test'); process.exit(1); }
const LAN = lan.address;

fs.mkdirSync(path.join(tmp, 'share'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: HTTP_PORT, host: '0.0.0.0', discovery: { enabled: false },
  pairing: { required: true, trustThisPC: true }, shares: [{ id: 'main', name: 'Test share', rootPath: path.join(tmp, 'share'), deviceType: 'hdd' }] }));
const server = spawn(process.execPath, [path.join(repo, 'server', 'server.js')], {
  env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(HTTP_PORT) }), stdio: 'ignore'
});

const jar = {};
function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = Object.assign({ Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {});
    const req = http.request({ host: '127.0.0.1', port: HTTP_PORT, path: url, method, headers }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => {
        for (const ck of res.headers['set-cookie'] || []) { const [kv] = ck.split(';'); const [k, v] = kv.split('='); if (v) jar[k] = v; else delete jar[k]; }
        let json = null; try { json = JSON.parse(Buffer.concat(c).toString()); } catch {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

const profile = path.join(tmp, 'profile');
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'mode.json'), JSON.stringify({ mode: 'client' }));
fs.writeFileSync(path.join(profile, 'prefs.json'), JSON.stringify({ startWithWindows: false, explorerMenu: false, trayHintShown: true }));
const electron = path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = Object.assign({}, process.env, { ATTIC_INBOX: path.join(tmp, 'inbox'), ATTIC_TEST_HOOKS: '1', ATTIC_STEAM_KEY: STEAM_SUB, ATTIC_GAMEWATCH_MS: '300' });

let tool = null, ws = null, id = 0, fullApp = null;
const pending = {};
async function launchTool() {
  tool = spawn(exe || electron, exe ? [`--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`] : ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`], { cwd: desktop, stdio: 'ignore', env });
  let target;
  for (let i = 0; i < 80 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === 'page'); } catch {} }
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
async function waitFor(cond, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await ev(`try { return (${cond}) || null; } catch (e) { return null; }`).catch(() => null); if (v && v !== 'TIMEOUT' && !String(v).startsWith('ERR')) return v; await sleep(200); }
  return null;
}
async function until(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } return null; }
const T = (fn, arg) => ev(`return await atticDesktop.test.${fn}(${arg === undefined ? '' : JSON.stringify(arg)})`);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lowNow = () => ev(`return document.querySelector('#pc-low-now') ? document.querySelector('#pc-low-now').textContent : null`);
const pressed = () => ev(`const b = document.querySelector('[data-low][aria-pressed="true"]'); return b ? b.dataset.low : null`);
const stillness = () => ev(`const p = document.createElement('div'); p.style.cssText = 'backdrop-filter: blur(8px); transition: opacity 1s; animation: spin 1s linear infinite';
  document.body.append(p); const s = getComputedStyle(p); const out = { blur: s.backdropFilter, transition: s.transitionDuration, anim: s.animationIterationCount,
  cls: document.documentElement.classList.contains('low-resource'), reduced: Attic.ui.reducedMotion() }; p.remove(); return out`);
const acerStatsAt = async () => { const d = (await call('GET', '/api/devices')).body.find(x => x.role === 'client'); return d ? { at: d.statsAt, online: d.online } : null; };
const prefsFile = () => JSON.parse(fs.readFileSync(path.join(profile, 'prefs.json'), 'utf8'));

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/hello`).then(r => r.ok, () => false); if (!up) await sleep(250); }
  const hello = (await call('GET', '/api/hello')).body;
  await call('POST', '/api/setup', { displayName: 'Test', username: 'master', password: 'test1234' });
  await call('POST', '/api/session', { mode: 'master', username: 'master', password: 'test1234' });
  fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify({ serverId: hello.serverId, name: hello.name, address: LAN, port: HTTP_PORT }));

  await launchTool();
  await waitFor(`location.hash === '#/pair' && document.querySelector('#pr-name') && document.querySelector('#pr-name').value`, 20000);
  await ev(`const c = document.querySelector('#pr-code'); c.value = '${(await call('POST', '/api/pairing/codes', {})).body.code}'; c.dispatchEvent(new Event('input')); document.querySelector('.login-card').requestSubmit(); return 1`);
  await waitFor(`location.hash === '#/login'`);
  await ev(`const f = document.querySelector('.login-card'); document.querySelector('#lg-master').click();
    f.querySelector('#lg-user').value = 'master'; f.querySelector('#lg-pass').value = 'test1234'; f.requestSubmit(); return 1`);
  await waitFor(`location.hash === '#/dashboard'`);
  await ev(`location.hash = '#/settings'; return 1`);
  await waitFor(`document.querySelector('#h-pc[data-loaded]')`);

  // 1. Automatic by default; the watcher (compiled on first use) is running; nothing is slowed.
  const p0 = await until(async () => { const p = await T('pace'); return p && p.watcherPid ? p : null; }, 30000);
  const text0 = await until(async () => { const t = await lowNow(); return /^Off now/.test(t || '') ? t : null; });
  check('Settings → This PC: Low-resource mode is Automatic, and off with no game running', (await pressed()) === 'auto' && text0, `${await pressed()} · ${text0}`);
  check('Automatic runs the game watcher, compiled into the tool’s own folder', p0 && alive(p0.watcherPid) && fs.readdirSync(path.join(profile, 'helpers')).some(f => /^attic-gamewatch-.*\.exe$/.test(f)),
    p0 ? `pid ${p0.watcherPid}` : 'no watcher');
  const normal = await stillness();
  check('reports every 3 s, and the interface moves as usual', p0.statsMs === 3000 && !normal.cls && normal.blur !== 'none', JSON.stringify(normal));
  await until(async () => (await acerStatsAt())?.at);

  // 2. A Steam game starts: within a moment, low-resource mode is on.
  steamGame(1245620);
  const text1 = await until(async () => { const t = await lowNow(); return /Steam game/.test(t || '') ? t : null; }, 10000);
  check('a Steam game starting turns it on, and Settings says why', text1, text1);
  const p1 = await T('pace'), still = await stillness();
  check('the agent now reports every 15 s, and reads battery and network every 2 minutes', p1.statsMs === 15000 && p1.slowMs === 120000, JSON.stringify(p1));
  check('the interface holds still: no animations, transitions or blur', still.cls && still.blur === 'none' && parseFloat(still.transition) < 0.001 && still.anim === '1' && still.reduced, JSON.stringify(still));
  const tray1 = await T('tray');
  check('the tray says so', tray1.some(i => i.label === 'Low-resource mode on: a Steam game is running'), tray1.map(i => i.label).slice(0, 3).join(' | '));

  // 3. At the HP: one report straight away at the change, then none for 15 s; the device stays online.
  await sleep(1500);
  const a = await acerStatsAt();
  await sleep(10000);
  const b = await acerStatsAt();
  check('at the HP, reports really slow down, and this PC stays online', a.at === b.at && b.online, `last report ${a.at}, 10 s later ${b.at}, online ${b.online}`);

  // 4. The game ends: back to normal at once.
  steamGame(0);
  const text2 = await until(async () => { const t = await lowNow(); return /^Off now/.test(t || '') ? t : null; }, 10000);
  const c1 = await until(async () => { const s = await acerStatsAt(); return s.at !== b.at ? s : null; }, 3000);
  await sleep(3500);
  const c2 = await acerStatsAt();
  check('the game ending turns it off: a report at once, then every 3 s again', text2 && c1 && c2.at !== c1.at && !(await stillness()).cls, `${c1 && c1.at} → ${c2.at}`);

  // 5. A full-screen app in front counts too (a real full-screen window from another program).
  fs.writeFileSync(path.join(tmp, 'fullscreen.js'), `const { app, BrowserWindow } = require('electron');
    app.whenReady().then(() => { const w = new BrowserWindow({ fullscreen: true, backgroundColor: '#000', alwaysOnTop: true }); w.loadURL('data:text/html,<h1 style="color:#fff">Attic Hub test: full screen</h1>'); w.focus(); });`);
  fullApp = spawn(electron, [path.join(tmp, 'fullscreen.js'), `--user-data-dir=${path.join(tmp, 'fs-profile')}`], { stdio: 'ignore' });
  const text3 = await until(async () => { const t = await lowNow(); return /full-screen app/.test(t || '') ? t : null; }, 15000);
  check('a full-screen app in front turns it on too', text3, text3 || await lowNow());
  fullApp.kill(); fullApp = null;
  const text4 = await until(async () => { const t = await lowNow(); return /^Off now/.test(t || '') ? t : null; }, 10000);
  check('… and closing it turns it off', text4, text4 || await lowNow());

  // 6. Always on: on with no game, and no watcher needed. Off: never, even with a game.
  await ev(`document.querySelector('[data-low="on"]').click(); return 1`);
  const text5 = await until(async () => { const t = await lowNow(); return t === 'On now.' ? t : null; }, 5000);
  const p5 = await T('pace');
  check('Always on: on without a game, and the watcher stops', text5 && p5.statsMs === 15000 && !p5.watcherPid && await until(async () => !alive(p0.watcherPid), 4000),
    `${text5} · ${JSON.stringify(p5)}`);
  await ev(`document.querySelector('[data-low="off"]').click(); return 1`);
  steamGame(1245620);
  await sleep(1500);
  const p6 = await T('pace');
  check('Off: stays off even while a game runs', p6.statsMs === 3000 && !(await stillness()).cls && prefsFile().lowResource === 'off', `prefs.json ${prefsFile().lowResource}`);

  // 7. The tray's choice: Automatic again; the watcher restarts and sees the game still running.
  const trayItems = await T('tray');
  check('the tray shows the choice (Off ticked)', trayItems.find(i => i.label === 'Off')?.checked === true && trayItems.find(i => i.label === 'Automatic: while a game runs')?.checked === false, '');
  await T('trayClick', 'Automatic: while a game runs');
  const text7 = await until(async () => { const t = await lowNow(); return /Steam game/.test(t || '') ? t : null; }, 15000);
  check('choosing Automatic in the tray restarts the watcher; Settings follows', text7 && (await pressed()) === 'auto' && prefsFile().lowResource === 'auto', text7);
  steamGame(0);

  // 8. Quitting the tool ends the watcher too.
  const p8 = await T('pace');
  await T('trayClick', 'Quit Attic Hub');
  await until(async () => tool.exitCode !== null, 8000);
  check('quitting Attic Hub ends the game watcher too', p8.watcherPid && await until(async () => !alive(p8.watcherPid), 5000), `pid ${p8.watcherPid}`);
} catch (e) {
  check('the test ran to the end', false, e.stack);
} finally {
  try { ws.close(); } catch {} try { tool.kill(); } catch {} try { if (fullApp) fullApp.kill(); } catch {}
  try { server.kill(); } catch {}
  try { reg(['delete', 'HKCU\\Software\\AtticHubTest', '/f']); } catch {}
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
