// Phase 2, 2-2 end-to-end test: pairing and unpairing in the real desktop tool, against a throwaway copy
// of server/ with pairing required (port 8089). This PC plays both machines: the test talks to the server
// on 127.0.0.1, which the server trusts as the HP itself, and the tool connects through this PC's network
// address, so the server treats it as a new device that has to pair.
// Usage (from desktop/): node scripts/pairing-test.mjs [path-to-exe]
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const repo = path.join(desktop, '..');
const exe = process.argv[2];
const HTTP_PORT = 8089, CDP_PORT = 9344;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-2-2-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal);
if (!lan) { console.log('FAIL  this PC needs a network address (Wi-Fi or Ethernet) for this test'); process.exit(1); }
const LAN = lan.address;

// ---- a throwaway server, pairing on ----
fs.mkdirSync(path.join(tmp, 'share'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'share', 'hello.txt'), 'hi');
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: HTTP_PORT, host: '0.0.0.0', discovery: { enabled: false },
  pairing: { required: true, trustThisPC: true },
  shares: [{ id: 'main', name: 'Test share', rootPath: path.join(tmp, 'share'), deviceType: 'hdd' }] }));
const server = spawn(process.execPath, [path.join(repo, 'server', 'server.js')], {
  env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(HTTP_PORT) }),
  stdio: 'ignore'
});

// The test as the HP: requests from 127.0.0.1 need no pairing. `from` sends from this PC's network
// address instead, which the server treats as another device.
let masterCookie = '';
function hp(method, url, body, from) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: from ? LAN : '127.0.0.1', localAddress: from ? LAN : undefined, port: HTTP_PORT, path: url, method,
      headers: Object.assign({ Cookie: from ? '' : masterCookie }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => {
        const set = res.headers['set-cookie'];
        if (!from && set) masterCookie = set.map(c => c.split(';')[0]).filter(c => /^attic_session=/.test(c)).join('; ') || masterCookie;
        let json = null; try { json = JSON.parse(s); } catch {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
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
const typeCode = code => ev(`const c = document.querySelector('#pr-code'); c.value = '${code}'; c.dispatchEvent(new Event('input')); document.querySelector('.login-card').requestSubmit(); return 1`);

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/hello`).then(r => r.ok, () => false); if (!up) await sleep(250); }
  check('throwaway server starts with pairing required', up, `tool will connect via ${LAN}:${HTTP_PORT}`);
  const hello = (await hp('GET', '/api/hello')).body;

  // The master is set up and signed in from the HP itself, which needs no pairing.
  await hp('POST', '/api/setup', { displayName: 'Test', username: 'master', password: 'test1234' });
  const si = await hp('POST', '/api/session', { mode: 'master', username: 'master', password: 'test1234' });
  check('the HP itself signs in without pairing', si.status === 200, `status ${si.status}`);

  // 1. A new device: the tool opens the HP's interface and lands on the pairing screen.
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify({ serverId: hello.serverId, name: hello.name, address: LAN, port: HTTP_PORT }));
  await launchTool();
  const pairScreen = await waitFor(`location.hash === '#/pair' && document.querySelector('#pr-code') && document.querySelector('#pr-title').textContent`, 20000);
  check('an unpaired tool shows the pairing screen', pairScreen, pairScreen || 'no pairing screen');
  const suggested = await waitFor(`document.querySelector('#pr-name').value`);
  check('the name defaults to this PC’s name', suggested === os.hostname().slice(0, 64), suggested);
  const blocked = (await hp('GET', '/api/files', undefined, true)).status;
  check('an unpaired device is refused everything else', blocked === 403, `GET /api/files → ${blocked}`);

  // 2. A wrong code explains itself; the right one pairs.
  await typeCode('000000');
  const wrong = await waitFor(`document.querySelector('#pr-code-msg').textContent`);
  check('a wrong code gets a reason', wrong, wrong);
  const code = (await hp('POST', '/api/pairing/codes', {})).body.code;
  await typeCode(code.slice(0, 3) + ' ' + code.slice(3));
  const login = await waitFor(`location.hash === '#/login' && document.querySelector('#lg-user') && location.hash`);
  check('the right code pairs and moves on to sign-in', login, login || 'still on ' + await ev('return location.hash'));
  const devs = (await hp('GET', '/api/devices')).body;
  const me = devs.find(d => d.role === 'client');
  check('the HP lists the new device with its name, kind and Windows version', me && me.name === os.hostname().slice(0, 64) && me.os,
    me ? `${me.name} · ${me.kind} · ${me.os}` : JSON.stringify(devs));
  const cookies = await send('Network.getAllCookies');
  const devCookie = ((cookies.result && cookies.result.cookies) || []).find(c => c.name === 'attic_device');
  check('the device token is an HttpOnly cookie the page can’t read', devCookie && devCookie.httpOnly && !(await ev(`return document.cookie`)).includes('attic_device'),
    devCookie ? `expires ${new Date(devCookie.expires * 1000).toISOString().slice(0, 10)}` : 'no cookie');

  // 3. Sign in as master in the tool: Devices shows the HP and this PC; Pair a device issues a code.
  await ev(`const f = document.querySelector('.login-card'); document.querySelector('#lg-master').click();
    f.querySelector('#lg-user').value = 'master'; f.querySelector('#lg-pass').value = 'test1234'; f.requestSubmit(); return 1`);
  await waitFor(`location.hash === '#/dashboard'`);
  await ev(`location.hash = '#/devices'; return 1`);
  const cards = await waitFor(`document.querySelectorAll('.hub-card').length === 2 && [...document.querySelectorAll('.hub-card')].map(c => c.querySelector('.nm').textContent + (c.querySelector('[data-unpair]') ? ' [Unpair]' : '') + (/This device/.test(c.textContent) ? ' (this device)' : '')).join(', ')`);
  check('Devices shows the HP and this PC, with Unpair only on the client', cards && /\[Unpair\] \(this device\)/.test(cards) && !/^[^,]*\[Unpair\]/.test(cards), cards);
  await ev(`document.querySelector('#pair').click(); return 1`);
  const shown = await waitFor(`document.querySelector('.pair-code-big .digits') && document.querySelector('.pair-code-big .digits').textContent`);
  const issued = (await hp('GET', '/api/pairing/codes')).body;
  check('Pair a device shows a code the HP issued', shown && issued.some(c => c.code === shown.replace(/\s/g, '')), `${shown} · ${issued.length} waiting`);
  const left = await waitFor(`/Expires in 9:|Expires in 10:/.test(document.querySelector('#pc-left').textContent) && document.querySelector('#pc-left').textContent`);
  check('it counts down the 10 minutes', left, left);

  // 4. Another device uses the code: the dialog says so, and the list gains a card.
  const ally = await hp('POST', '/api/pairing/claim', { code: shown.replace(/\s/g, ''), name: 'ROG Ally', kind: 'handheld', os: 'Windows 11' }, true);
  const done = await waitFor(`document.querySelector('.pair-done') && document.querySelector('.pair-done b').textContent`, 8000);
  check('the dialog notices the new device joined', ally.status === 201 && done, done || `claim → ${ally.status}`);
  await ev(`document.querySelector('.dialog-actions .btn').click(); return 1`);
  const three = await waitFor(`document.querySelectorAll('.hub-card').length === 3 && document.querySelectorAll('.hub-card').length`, 8000);
  check('the Devices view shows it', three === 3, `${three} cards`);

  // 5. Closing the dialog unused cancels its code.
  await ev(`document.querySelector('#pair').click(); return 1`);
  await waitFor(`document.querySelector('.pair-code-big .digits')`);
  await ev(`document.querySelector('.dialog-actions .btn').click(); return 1`);
  await sleep(800);
  const leftover = (await hp('GET', '/api/pairing/codes')).body;
  check('closing Pair a device unused cancels the code', Array.isArray(leftover) && leftover.length === 0,
    `${leftover.length} code(s) still waiting${leftover.length ? ': ' + leftover.map(c => c.code).join(', ') + ' · dialogs open: ' + await ev(`return document.querySelectorAll('.dialog').length`) : ''}`);

  // 6. Unpair from the card (the ROG Ally), with a confirm.
  await ev(`[...document.querySelectorAll('.hub-card')].find(c => c.querySelector('.nm').textContent === 'ROG Ally').querySelector('[data-unpair]').click(); return 1`);
  const ask = await waitFor(`document.querySelector('.dialog h2') && document.querySelector('.dialog h2').textContent`);
  await ev(`document.querySelector('.dialog .btn-danger').click(); return 1`);
  const two = await waitFor(`document.querySelectorAll('.hub-card').length === 2 && ![...document.querySelectorAll('.nm')].some(n => n.textContent === 'ROG Ally')`, 8000);
  const gone = !(await hp('GET', '/api/devices')).body.some(d => d.name === 'ROG Ally');
  check('Unpair asks first, then removes the device on the HP', ask && two && gone,
    `${ask} · cards ${await ev(`return [...document.querySelectorAll('.nm')].map(n => n.textContent).join('/')`)} · on HP ${gone ? 'gone' : 'still there'} · toast ${await ev(`return [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')`)}`);

  // 7. Restart: the pairing survives (the cookie is kept), so it goes straight to sign-in.
  quitTool();
  await sleep(1500);
  await launchTool();
  const back = await waitFor(`location.protocol === 'http:' && document.querySelector('.login-card, .shell') && location.hash !== '#/pair' && location.hash`, 20000);
  check('after a restart the tool is still paired', back, back || 'asked to pair again');

  // 8. Unpaired on the HP while in use: the tool returns to the pairing screen and says why.
  await ev(`const f = document.querySelector('.login-card'); if (f && f.querySelector('#lg-master')) { f.querySelector('#lg-master').click();
    f.querySelector('#lg-user').value = 'master'; f.querySelector('#lg-pass').value = 'test1234'; f.requestSubmit(); } return 1`);
  await waitFor(`location.hash === '#/dashboard'`);
  await ev(`location.hash = '#/devices'; return 1`);
  await waitFor(`document.querySelectorAll('.hub-card').length === 2`);
  const myId = (await hp('GET', '/api/devices')).body.find(d => d.role === 'client' && d.name === os.hostname().slice(0, 64)).id;
  const un = await hp('DELETE', '/api/devices/' + myId, {});
  check('the HP unpairs this PC while it is in use', un.status === 200, 'status ' + un.status);
  const again = await waitFor(`location.hash === '#/pair' && document.querySelector('.banner-warning') && document.querySelector('.banner-warning').textContent`, 10000);
  check('unpaired while in use: back to pairing, with the reason', again, again || 'stayed on ' + await ev('return location.hash') + ' · ' + await ev("const r = await fetch('/api/devices'); return r.status + ' ' + (await r.text()).slice(0, 160)"));
} catch (e) {
  check('test ran to the end', false, e.message);
} finally {
  quitTool();
  try { server.kill(); } catch {}
  await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
