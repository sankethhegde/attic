// Phase 3, 3-2 end-to-end test: the tray, start with Windows, and notifications for received files, in
// the real desktop tool (with ATTIC_TEST_HOOKS=1, which lets the test read the tray menu and the
// notifications shown). A throwaway server (port 8081) and a stand-in "ROG Ally" that sends files.
// With an exe it also switches the real start-with-Windows entry on and off again; it always ends off.
// Usage (from desktop/): node scripts/tray-test.mjs [path-to-exe]
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const repo = path.join(desktop, '..');
const exe = process.argv[2];
const HTTP_PORT = 8081, CDP_PORT = 9350;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-3-2-'));
const INBOX = path.join(tmp, 'inbox');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
if (!lan) { console.log('FAIL  this PC needs a network address (Wi-Fi or Ethernet) for this test'); process.exit(1); }
const LAN = lan.address;

fs.mkdirSync(path.join(tmp, 'share'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: HTTP_PORT, host: '0.0.0.0', discovery: { enabled: false },
  pairing: { required: true, trustThisPC: true }, shares: [{ id: 'main', name: 'Test share', rootPath: path.join(tmp, 'share'), deviceType: 'hdd' }] }));
const server = spawn(process.execPath, [path.join(repo, 'server', 'server.js')], {
  env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(HTTP_PORT) }), stdio: 'ignore'
});

const jars = { hp: {}, ally: {} };
const cookieOf = who => Object.entries(jars[who]).map(([k, v]) => `${k}=${v}`).join('; ');
function call(who, method, url, body, raw) {
  return new Promise((resolve, reject) => {
    const ally = who === 'ally';
    const data = body === undefined ? null : raw ? body : Buffer.from(JSON.stringify(body));
    const headers = Object.assign({ Cookie: cookieOf(who) }, data ? (raw ? { 'Content-Type': 'application/octet-stream', 'X-Attic-Upload': '1' } : { 'Content-Type': 'application/json' }) : {}, data ? { 'Content-Length': data.length } : {});
    const req = http.request({ host: ally ? LAN : '127.0.0.1', localAddress: ally ? LAN : undefined, port: HTTP_PORT, path: url, method, headers }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => {
        for (const ck of res.headers['set-cookie'] || []) { const [kv] = ck.split(';'); const [k, v] = kv.split('='); if (v) jars[who][k] = v; else delete jars[who][k]; }
        let json = null; try { json = JSON.parse(Buffer.concat(c).toString()); } catch {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function allySend(to, name, bytes) {
  const t = (await call('ally', 'POST', '/api/transfers', { to, fileName: name, size: bytes.length })).body;
  await call('ally', 'PUT', `/api/transfers/${t.id}/file`, bytes, true);
  return t;
}

const profile = path.join(tmp, 'profile');
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'mode.json'), JSON.stringify({ mode: 'client' }));
// Off to begin with, so a failed run never leaves a start-up entry behind for a test build.
fs.writeFileSync(path.join(profile, 'prefs.json'), JSON.stringify({ startWithWindows: false, notify: { received: true }, trayHintShown: false }));
let tool = null, ws = null, id = 0;
const pending = {};
async function launchTool(extra = []) {
  const args = [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, ...extra];
  const env = Object.assign({}, process.env, { ATTIC_INBOX: INBOX, ATTIC_TEST_HOOKS: '1' });
  tool = exe ? spawn(exe, args, { stdio: 'ignore', env }) : spawn(path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', ...args], { cwd: desktop, stdio: 'ignore', env });
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
const T = (fn, arg) => ev(`return await atticDesktop.test.${fn}(${arg === undefined ? '' : JSON.stringify(arg)})`);
const exited = async ms => { for (let i = 0; i < ms / 200 && tool.exitCode === null; i++) await sleep(200); return tool.exitCode !== null; };

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/hello`).then(r => r.ok, () => false); if (!up) await sleep(250); }
  const hello = (await call('hp', 'GET', '/api/hello')).body;
  await call('hp', 'POST', '/api/setup', { displayName: 'Test', username: 'master', password: 'test1234' });
  await call('hp', 'POST', '/api/session', { mode: 'master', username: 'master', password: 'test1234' });
  await call('ally', 'POST', '/api/pairing/claim', { code: (await call('hp', 'POST', '/api/pairing/codes', {})).body.code, name: 'ROG Ally', kind: 'handheld' });
  await call('hp', 'POST', '/api/accounts', { displayName: 'Ally user', username: 'ally', password: 'test1234', deviceType: 'handheld' });
  await call('ally', 'POST', '/api/session', { mode: 'device', username: 'ally', password: 'test1234' });
  fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify({ serverId: hello.serverId, name: hello.name, address: LAN, port: HTTP_PORT }));

  // 1. Pair; the tray says what the tool is doing.
  await launchTool();
  await waitFor(`location.hash === '#/pair' && document.querySelector('#pr-name') && document.querySelector('#pr-name').value`, 20000);
  await ev(`const c = document.querySelector('#pr-code'); c.value = '${(await call('hp', 'POST', '/api/pairing/codes', {})).body.code}'; c.dispatchEvent(new Event('input')); document.querySelector('.login-card').requestSubmit(); return 1`);
  await waitFor(`location.hash === '#/login'`);
  await ev(`const f = document.querySelector('.login-card'); document.querySelector('#lg-master').click();
    f.querySelector('#lg-user').value = 'master'; f.querySelector('#lg-pass').value = 'test1234'; f.requestSubmit(); return 1`);
  await waitFor(`location.hash === '#/dashboard'`);
  const devices = (await call('hp', 'GET', '/api/devices')).body;
  const acer = devices.find(d => d.role === 'client' && d.name !== 'ROG Ally'), allyDev = devices.find(d => d.name === 'ROG Ally');
  const menu = await T('tray');
  const labels = (menu || []).map(i => i.label);
  check('the tray menu says it’s connected; Open, Hub Inbox, Start with Windows, Notifications (three switches) and Quit',
    labels[0] === `Connected to ${hello.name}` && ['Open Attic Hub', 'Open Hub Inbox', 'Notifications', 'Notify me when files arrive', 'Files I send: delivered or failed',
      'Devices going offline or coming back', 'Quit Attic Hub'].every(l => labels.includes(l)) && labels.some(l => l.startsWith('Start with Windows')),
    labels.join(' | '));
  const sw = menu.find(i => i.label.startsWith('Start with Windows'));
  check(exe ? 'Start with Windows can be switched in the installed app' : 'Start with Windows is for the installed app only (greyed out here)', exe ? sw.enabled : !sw.enabled, `${sw.label} · ${sw.enabled ? 'enabled' : 'disabled'}`);

  // 2. Closing the window (its X) keeps the tool in the tray, and says so once.
  await T('closeWindow');
  await sleep(800);
  const win = await T('window');
  check('closing the window hides it; the tool keeps running', win && win.visible === false && tool.exitCode === null, JSON.stringify(win));
  const hint = (await T('notes')).find(n => /still running/.test(n.title));
  check('the first time, a notification says it’s in the tray', hint, hint && `${hint.title}: ${hint.body}`);

  // 3. While hidden, a file from the Ally arrives and is announced.
  const before = (await T('notes')).length;
  await allySend(acer.id, 'Save backup.7z', crypto.randomBytes(300 * 1024));
  let note = null;
  for (let i = 0; i < 40 && !note; i++) { await sleep(250); note = (await T('notes')).slice(before).find(n => /File received/.test(n.title)); }
  check('a received file shows a Windows notification, even with the window closed (Phase 3 check)', note && note.title === 'File received from ROG Ally' && /Save backup\.7z · 300 KB · in your Hub Inbox/.test(note.body),
    note ? `${note.title}: ${note.body}` : 'none');
  const before2 = (await T('notes')).length;
  for (const n of ['a.jpg', 'b.jpg', 'c.jpg']) await allySend(acer.id, n, Buffer.alloc(1024, 1));
  let batch = null;
  for (let i = 0; i < 40 && !batch; i++) { await sleep(250); batch = (await T('notes')).slice(before2).find(n => /files received/.test(n.title)); }
  await sleep(3000);
  const extra = (await T('notes')).slice(before2).filter(n => /received/.test(n.title)).length;
  check('several files at once make one notification', batch && batch.title === '3 files received from ROG Ally' && extra === 1, batch ? `${batch.title}: ${batch.body}` : 'none');
  const doubled = (await T('notes')).filter(n => /^File received$/.test(n.title)).length;
  check('the HP’s own “file received” events don’t show a second time', doubled === 0, `${doubled} duplicates`);

  // 3b. The HP's events (its side of 3-2): a file this PC sent is delivered, or fails.
  const waitNote = async (re, since, ms = 15000) => { for (let i = 0; i < ms / 250; i++) { const n = (await T('notes')).slice(since).find(x => re.test(x.title)); if (n) return n; await sleep(250); } return null; };
  const sendFromTool = name => ev(`const d = (await Attic.api.listHubDevices()).find(x => x.name === 'ROG Ally');
    const t = await Attic.api.sendToDevice({ files: [{ name: '${name}', size: 2048, source: new File([new Uint8Array(2048)], '${name}') }], to: d }).promise; return t[0].id`);
  const allyFetch = tid => new Promise((resolve, reject) => http.get({ host: LAN, localAddress: LAN, port: HTTP_PORT, path: `/api/transfers/${tid}/file`, headers: { 'X-Attic-Device': jars.ally.attic_device } },
    res => { res.resume(); res.on('end', resolve); }).on('error', reject));
  let since = (await T('notes')).length;
  const t1 = await sendFromTool('Report.pdf');
  await allyFetch(t1);
  await call('ally', 'POST', `/api/transfers/${t1}/received`, {});
  const delivered = await waitNote(/delivered/i, since);
  check('a file sent from this PC: “delivered” when the Ally has it (the HP’s event)', delivered && /Report\.pdf/.test(delivered.body), delivered ? `${delivered.title}: ${delivered.body}` : 'none');
  since = (await T('notes')).length;
  const t2 = await sendFromTool('Big save.7z');
  await call('ally', 'POST', `/api/transfers/${t2}/failed`, { error: 'Not enough space on C:' });
  const failed = await waitNote(/failed/i, since);
  check('… and “failed”, with the reason, when it couldn’t be saved there', failed && /Not enough space/.test(failed.body), failed ? `${failed.title}: ${failed.body}` : 'none');

  // 3c. A device going offline (after the HP's 30 s grace) and coming back.
  const agentWs = () => new Promise(r => { const w = new WebSocket(`ws://${LAN}:${HTTP_PORT}/api/hub?role=agent`, { headers: { 'X-Attic-Device': jars.ally.attic_device } }); w.onmessage = () => r(w); });
  let allyAgent = await agentWs();
  await sleep(1000);
  since = (await T('notes')).length;
  allyAgent.close();
  const offline = await waitNote(/offline/i, since, 50000);
  check('a device that’s been gone half a minute: “offline”', offline && /ROG Ally/.test(offline.title), offline ? offline.title : 'none in 50 s');
  since = (await T('notes')).length;
  allyAgent = await agentWs();
  const online = await waitNote(/online/i, since, 10000);
  check('… and “online” when it’s back', online && /ROG Ally/.test(online.title), online ? online.title : 'none');

  // 4. Turned off from the tray: no notification, and Settings agrees.
  await T('trayClick', 'Notify me when files arrive');
  const before3 = (await T('notes')).length;
  await allySend(acer.id, 'quiet.txt', Buffer.from('shh'));
  await sleep(5000);
  const quiet = fs.existsSync(path.join(INBOX, 'quiet.txt')) && (await T('notes')).length === before3;
  check('switched off, files still arrive but no notification shows', quiet, quiet ? 'quiet.txt saved, nothing shown' : 'notified anyway');
  await T('trayClick', 'Open Attic Hub');
  await sleep(500);
  check('Open Attic Hub in the tray brings the window back', (await T('window')).visible === true, '');
  await ev(`location.hash = '#/settings'; return 1`);
  const setting = await waitFor(`document.querySelector('#h-pc[data-loaded]') && JSON.stringify({ notify: document.querySelector('#pc-notify').checked, start: document.querySelector('#pc-start').checked, startEnabled: !document.querySelector('#pc-start').disabled })`);
  check('Settings → This PC shows the same switches', setting && JSON.parse(setting).notify === false && JSON.parse(setting).startEnabled === !!exe, setting);
  await ev(`const n = document.querySelector('#pc-notify'); n.checked = true; n.dispatchEvent(new Event('change')); return 1`);
  await sleep(500);
  const prefsNow = JSON.parse(fs.readFileSync(path.join(profile, 'prefs.json'), 'utf8'));
  const trayNow = (await T('tray')).find(i => i.label === 'Notify me when files arrive');
  check('switching it back on in Settings is kept, and the tray follows', prefsNow.notify.received === true && trayNow.checked === true, `prefs.json notify.received ${prefsNow.notify.received}`);

  // 5. Start with Windows (the installed app): on, then off again.
  if (exe) {
    await ev(`const s = document.querySelector('#pc-start'); s.checked = true; s.dispatchEvent(new Event('change')); return 1`);
    await sleep(800);
    const on = await T('loginItem');
    await ev(`const s = document.querySelector('#pc-start'); s.checked = false; s.dispatchEvent(new Event('change')); return 1`);
    await sleep(800);
    const off = await T('loginItem');
    check('Start with Windows adds and removes the real start-up entry', on === true && off === false, `on → ${on}, off → ${off}`);
  }

  // 6. Quit from the tray ends it. Something happens while it's closed; started with --hidden, it begins
  // in the tray and catches up on what it missed.
  const late = await sendFromTool('Late.txt');
  await T('trayClick', 'Quit Attic Hub');
  check('Quit Attic Hub in the tray ends the tool', await exited(8000), `exit ${tool.exitCode}`);
  await call('ally', 'POST', `/api/transfers/${late}/failed`, { error: 'The disk is full' });
  await launchTool(['--hidden']);
  const missed = await waitNote(/failed/i, 0, 20000);
  check('on the next start it shows what it missed while closed', missed && /Late\.txt/.test(missed.body), missed ? `${missed.title}: ${missed.body}` : 'nothing shown');
  const hiddenWin = await T('window');
  check('started with Windows (--hidden), it begins in the tray with no window', hiddenWin && hiddenWin.visible === false, JSON.stringify(hiddenWin));
  const repeats = (await T('notes')).filter(n => /delivered/i.test(n.title)).length;
  check('nothing already shown is shown again', repeats === 0, `${repeats} repeats`);
  await T('trayClick', 'Quit Attic Hub');
  await exited(8000);
} catch (e) {
  check('test ran to the end', false, e.stack || e.message);
} finally {
  // Never leave a start-up entry for a test build behind.
  try { if (exe && tool && tool.exitCode === null) await ev(`await atticDesktop.prefs.set({ startWithWindows: false }); return 1`); } catch {}
  try { ws.close(); } catch {} try { tool.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
