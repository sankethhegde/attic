// Phase 2, 2-4 end-to-end test: send to device and the Hub Inbox, in the real desktop tool, against a
// throwaway copy of server/ (port 8083). The tool plays the Acer: it pairs through this PC's network
// address and its inbox is a temporary folder (ATTIC_INBOX). The test plays the master on 127.0.0.1 and
// a second device, the "ROG Ally", with its own pairing, sign-in and agent connection.
// Usage (from desktop/): node scripts/send-test.mjs [path-to-exe]
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
const HTTP_PORT = 8083, CDP_PORT = 9346;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-2-4-'));
const INBOX = path.join(tmp, 'inbox');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
if (!lan) { console.log('FAIL  this PC needs a network address (Wi-Fi or Ethernet) for this test'); process.exit(1); }
const LAN = lan.address;

fs.mkdirSync(path.join(tmp, 'share'), { recursive: true });
const hpFile = crypto.randomBytes(300 * 1024);
fs.writeFileSync(path.join(tmp, 'share', 'Budget 2026.xlsx'), hpFile);
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: HTTP_PORT, host: '0.0.0.0', discovery: { enabled: false },
  pairing: { required: true, trustThisPC: true },
  shares: [{ id: 'main', name: 'Test share', rootPath: path.join(tmp, 'share'), deviceType: 'hdd' }] }));
const server = spawn(process.execPath, [path.join(repo, 'server', 'server.js')], {
  env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(HTTP_PORT) }),
  stdio: 'ignore'
});

// Requests as the HP's master (127.0.0.1, no pairing), or as the "ROG Ally" from this PC's network
// address with its own cookies. `raw` sends a Buffer as an upload.
const jars = { hp: {}, ally: {} };
function call(who, method, url, body, { raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const ally = who === 'ally';
    const data = body === undefined ? null : raw ? body : Buffer.from(JSON.stringify(body));
    const headers = { Cookie: Object.entries(jars[who]).map(([k, v]) => `${k}=${v}`).join('; ') };
    if (data) Object.assign(headers, raw ? { 'Content-Type': 'application/octet-stream', 'X-Attic-Upload': '1' } : { 'Content-Type': 'application/json' }, { 'Content-Length': data.length });
    const req = http.request({ host: ally ? LAN : '127.0.0.1', localAddress: ally ? LAN : undefined, port: HTTP_PORT, path: url, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        for (const c of res.headers['set-cookie'] || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (v) jars[who][k] = v; else delete jars[who][k]; }
        const buf = Buffer.concat(chunks);
        let json = null; try { json = JSON.parse(buf.toString()); } catch {}
        resolve({ status: res.statusCode, body: json, buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---- the desktop tool, driven over the DevTools protocol ----
const profile = path.join(tmp, 'profile');
// This test is about a client: answer the first-launch question (3-1) up front.
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'mode.json'), JSON.stringify({ mode: 'client' }));
let tool = null, ws = null, id = 0;
const pending = {};
async function launchTool() {
  const args = [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`];
  const env = Object.assign({}, process.env, { ATTIC_INBOX: INBOX });
  tool = exe ? spawn(exe, args, { stdio: 'ignore', env })
    : spawn(path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', ...args], { cwd: desktop, stdio: 'ignore', env });
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
    await sleep(250);
  }
  return null;
}
async function until(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } return null; }
function quitTool() { try { ws.close(); } catch {} try { tool.kill(); } catch {} }
const signInMaster = () => ev(`const f = document.querySelector('.login-card'); document.querySelector('#lg-master').click();
  f.querySelector('#lg-user').value = 'master'; f.querySelector('#lg-pass').value = 'test1234'; f.requestSubmit(); return 1`);
const transfer = async tid => ((await call('hp', 'GET', '/api/transfers')).body || []).find(t => t.id === tid);
let allyWs = null;

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/hello`).then(r => r.ok, () => false); if (!up) await sleep(250); }
  check('throwaway server starts', up, `tool connects via ${LAN}:${HTTP_PORT}, inbox ${INBOX}`);
  const hello = (await call('hp', 'GET', '/api/hello')).body;
  await call('hp', 'POST', '/api/setup', { displayName: 'Test', username: 'master', password: 'test1234' });
  await call('hp', 'POST', '/api/session', { mode: 'master', username: 'master', password: 'test1234' });

  // The "ROG Ally": paired, with a device account signed in on it. Its agent isn't connected yet: offline.
  const allyCode = (await call('hp', 'POST', '/api/pairing/codes', {})).body.code;
  await call('ally', 'POST', '/api/pairing/claim', { code: allyCode, name: 'ROG Ally', kind: 'handheld', os: 'Windows 11' });
  await call('hp', 'POST', '/api/accounts', { displayName: 'Ally user', username: 'ally', password: 'test1234', deviceType: 'handheld' });
  const allySignIn = await call('ally', 'POST', '/api/session', { mode: 'device', username: 'ally', password: 'test1234' });
  check('the stand-in ROG Ally is paired and signed in', jars.ally.attic_device && allySignIn.status === 200, `sign-in ${allySignIn.status}`);

  // 1. The tool pairs and signs in as master.
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify({ serverId: hello.serverId, name: hello.name, address: LAN, port: HTTP_PORT }));
  await launchTool();
  await waitFor(`location.hash === '#/pair' && document.querySelector('#pr-name') && document.querySelector('#pr-name').value`, 20000);
  const code = (await call('hp', 'POST', '/api/pairing/codes', {})).body.code;
  await ev(`const c = document.querySelector('#pr-code'); c.value = '${code}'; c.dispatchEvent(new Event('input')); document.querySelector('.login-card').requestSubmit(); return 1`);
  await waitFor(`location.hash === '#/login'`);
  await signInMaster();
  check('the tool pairs and signs in', await waitFor(`location.hash === '#/dashboard' && 'ok'`), '');
  const acer = (await call('hp', 'GET', '/api/devices')).body.find(d => d.role === 'client' && d.name !== 'ROG Ally');

  // 2. Send from the tool to the offline Ally: the upload reaches the HP and waits there.
  await ev(`location.hash = '#/devices'; return 1`);
  await waitFor(`[...document.querySelectorAll('.hub-card')].some(c => /ROG Ally/.test(c.textContent))`);
  const sendBtns = await ev(`return [...document.querySelectorAll('.hub-card')].map(c => c.querySelector('.nm').textContent + ':' + !!c.querySelector('[data-send]')).join(', ')`);
  check('Send a file is on other clients’ cards only, not the HP’s or this PC’s', /ROG Ally:true/.test(sendBtns) && (sendBtns.match(/:true/g) || []).length === 1, sendBtns);
  // The page is plain http, so it has no crypto.subtle: it sends a pattern the test can rebuild.
  const N = 3 * 1024 * 1024;
  const pattern = n => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 9)) & 255; return b; };
  const hashSent = sha(pattern(N));
  const label = await ev(`
    window.__toasts = [];
    new MutationObserver(() => document.querySelectorAll('.toast').forEach(t => { if (!__toasts.includes(t.textContent)) __toasts.push(t.textContent); }))
      .observe(document.body, { childList: true, subtree: true });
    [...document.querySelectorAll('.hub-card')].find(c => /ROG Ally/.test(c.textContent)).querySelector('[data-send]').click();
    for (let i = 0; i < 40 && !document.querySelector('#sd-in-files'); i++) await new Promise(r => setTimeout(r, 100));
    const bytes = new Uint8Array(${N}); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 9)) & 255;
    const dt = new DataTransfer(); dt.items.add(new File([bytes], 'Gameplay clip.mp4'));
    const inp = document.querySelector('#sd-in-files'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    const btn = document.querySelector('.dialog-actions [data-i="1"]'); const label = btn.textContent; btn.click();
    return label;`);
  check('the Send button says the Ally will collect it later (no agent running there)', /Send for ROG Ally to collect/.test(label), label);
  const toast = await waitFor(`__toasts.find(t => /on the HP/.test(t))`, 20000);
  check('the upload finishes and says the HP holds it', toast, toast || await ev(`return document.querySelector('#sd-error') && document.querySelector('#sd-error').textContent`));
  const waiting = (await call('hp', 'GET', '/api/transfers')).body.find(t => t.fileName === 'Gameplay clip.mp4');
  check('the HP has it queued for the Ally, from the tool', waiting && waiting.status === 'queued' && waiting.size === N && waiting.from === acer.id, waiting && `${waiting.status} · ${waiting.size} bytes`);

  // 3. The Ally comes online: its first message lists the waiting file; it collects it intact.
  allyWs = new WebSocket(`ws://${LAN}:${HTTP_PORT}/api/hub?role=agent`, { headers: { 'X-Attic-Device': jars.ally.attic_device } });
  const msgs = [];
  allyWs.onmessage = m => msgs.push(JSON.parse(m.data));
  const inboxMsg = await until(() => msgs.find(m => m.type === 'inbox'), 5000);
  check('the Ally hears about it as soon as it connects (offline queue)', inboxMsg && inboxMsg.transfers.some(t => t.id === waiting.id), inboxMsg && `${inboxMsg.transfers.length} waiting`);
  const got = await new Promise((resolve, reject) => {
    http.get({ host: LAN, localAddress: LAN, port: HTTP_PORT, path: `/api/transfers/${waiting.id}/file`, headers: { 'X-Attic-Device': jars.ally.attic_device } }, res => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c)));
    }).on('error', reject);
  });
  await call('ally', 'POST', `/api/transfers/${waiting.id}/received`, {});
  check('what the Ally downloads is exactly what the tool sent', got.length === N && sha(got) === hashSent, `${got.length} bytes, sha ${sha(got)} vs ${hashSent}`);
  check('and the HP marks it done', (await transfer(waiting.id)).status === 'done', '');

  // 4. The Ally sends to the tool while it's online: the tool's agent collects it into the Hub Inbox.
  const fromAlly = crypto.randomBytes(1536 * 1024 + 7);
  const t1 = (await call('ally', 'POST', '/api/transfers', { to: acer.id, fileName: 'Save backup.7z', size: fromAlly.length })).body;
  const put = await call('ally', 'PUT', `/api/transfers/${t1.id}/file`, fromAlly, { raw: true });
  check('the Ally sends a file to the tool', put.status === 200, `upload ${put.status}`);
  const t0 = Date.now();
  const done1 = await until(async () => { const t = await transfer(t1.id); return t && t.status === 'done' && t; }, 15000);
  const saved1 = path.join(INBOX, 'Save backup.7z');
  check('the tool collects it into its Hub Inbox and confirms it', done1 && fs.existsSync(saved1) && sha(fs.readFileSync(saved1)) === sha(fromAlly),
    done1 ? `${Date.now() - t0} ms, ${fs.statSync(saved1).size} bytes, intact` : `status ${(await transfer(t1.id) || {}).status}`);
  check('no partial files are left behind', fs.readdirSync(path.join(INBOX, '.attic-partial')).length === 0, fs.readdirSync(path.join(INBOX, '.attic-partial')).join(', '));

  // 4b. BIG=1: a 2 GB file, streamed up as it's generated, must arrive complete in the tool's inbox
  // (the Phase 2 check). It needs about 4 GB free for the HP's copy and the inbox's.
  if (process.env.BIG) {
    const SIZE = 2 * 1024 ** 3, CHUNK = 4 * 1024 * 1024;
    const block = crypto.randomBytes(CHUNK);
    const hash = crypto.createHash('sha256');
    const tb = (await call('ally', 'POST', '/api/transfers', { to: acer.id, fileName: 'Big 2 GB.bin', size: SIZE })).body;
    const tUp = Date.now();
    await new Promise((resolve, reject) => {
      const req = http.request({ host: LAN, localAddress: LAN, port: HTTP_PORT, path: `/api/transfers/${tb.id}/file`, method: 'PUT',
        headers: { Cookie: Object.entries(jars.ally).map(([k, v]) => `${k}=${v}`).join('; '), 'Content-Type': 'application/octet-stream', 'X-Attic-Upload': '1', 'Content-Length': SIZE } },
        res => { res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('upload ' + res.statusCode))); });
      req.on('error', reject);
      let sent = 0;
      const pump = () => {
        while (sent < SIZE) {
          const piece = block.subarray(0, Math.min(CHUNK, SIZE - sent));
          piece[0] = sent / CHUNK & 255; // every block differs a little
          hash.update(piece); sent += piece.length;
          if (!req.write(piece)) return req.once('drain', pump);
        }
        req.end();
      };
      pump();
    });
    const upMs = Date.now() - tUp;
    const doneBig = await until(async () => { const t = await transfer(tb.id); return t && (t.status === 'done' || t.status === 'failed') && t; }, 10 * 60e3);
    const savedBig = path.join(INBOX, 'Big 2 GB.bin');
    const got = doneBig && doneBig.status === 'done' && await new Promise(r => { const h = crypto.createHash('sha256'); fs.createReadStream(savedBig).on('data', d => h.update(d)).on('end', () => r(h.digest('hex'))); });
    check('a 2 GB file arrives complete in the tool’s Hub Inbox', got === hash.digest('hex'),
      doneBig ? `${doneBig.status}; up ${(upMs / 1000).toFixed(0)} s, delivered at ${((doneBig.speed || 0) / 1e6).toFixed(0)} MB/s; SHA-256 ${got ? 'matches' : 'differs'}` : 'not delivered');
    fs.rmSync(savedBig, { force: true });
  }

  // 5. The same name again lands beside it, not over it.
  const t2 = (await call('ally', 'POST', '/api/transfers', { to: acer.id, fileName: 'Save backup.7z', size: 5 })).body;
  await call('ally', 'PUT', `/api/transfers/${t2.id}/file`, Buffer.from('again'), { raw: true });
  const second = await until(() => fs.existsSync(path.join(INBOX, 'Save backup (2).7z')), 10000);
  check('a second file with the same name doesn’t overwrite the first', second && sha(fs.readFileSync(saved1)) === sha(fromAlly), second ? 'Save backup (2).7z' : 'not saved');

  // 6. The tool is closed; a file sent meanwhile waits on the HP, and arrives when the tool starts again.
  quitTool();
  await sleep(1500);
  const later = crypto.randomBytes(200 * 1024);
  const t3 = (await call('ally', 'POST', '/api/transfers', { to: acer.id, fileName: 'Sent while off.pdf', size: later.length })).body;
  await call('ally', 'PUT', `/api/transfers/${t3.id}/file`, later, { raw: true });
  check('a file for the tool waits while it’s closed', (await transfer(t3.id)).status === 'queued', (await transfer(t3.id)).status);
  await launchTool();
  const done3 = await until(async () => { const t = await transfer(t3.id); return t && t.status === 'done'; }, 25000);
  const saved3 = path.join(INBOX, 'Sent while off.pdf');
  check('it’s delivered when the tool comes back online', done3 && fs.existsSync(saved3) && sha(fs.readFileSync(saved3)) === sha(later), done3 ? 'delivered, intact' : 'not delivered');

  // 7. Settings lists what arrived; Files → Send to device sends a file that's on the HP.
  const page = await waitFor(`location.protocol === 'http:' && document.querySelector('.login-card, .shell') && location.hash`, 15000);
  if (page === '#/login') { await signInMaster(); await waitFor(`location.hash === '#/dashboard'`); }
  await ev(`location.hash = '#/settings'; return 1`);
  const recent = await waitFor(`!document.querySelector('#inbox-recent-row').hidden && document.querySelector('#inbox-recent').textContent`);
  check('Settings → Hub Inbox lists the received file', recent && /Sent while off\.pdf/.test(recent), recent);
  await ev(`location.hash = '#/files/main'; return 1`);
  await waitFor(`document.querySelector('.vlist .row')`);
  await ev(`[...document.querySelectorAll('.vlist .row')].find(r => /Budget 2026/.test(r.textContent)).click(); return 1`);
  await waitFor(`document.querySelector('#send-dev')`);
  await ev(`document.querySelector('#send-dev').click();
    for (let i = 0; i < 40 && !document.querySelector('.send-dev'); i++) await new Promise(r => setTimeout(r, 100));
    [...document.querySelectorAll('.send-dev')].find(b => /ROG Ally/.test(b.textContent)).click();
    document.querySelector('.dialog-actions [data-i="1"]').click(); return 1`);
  const fromHP = await until(async () => ((await call('hp', 'GET', '/api/transfers')).body || []).find(t => t.fileName === 'Budget 2026.xlsx' && t.status === 'active' && t.stage === 'deliver' || t.fileName === 'Budget 2026.xlsx' && t.status === 'queued'), 15000);
  check('Files → Send to device sends a file on the HP', fromHP && fromHP.size === hpFile.length, fromHP && `${fromHP.status}, ${fromHP.size} bytes`);

  // 8. Unpairing the Ally cancels anything waiting for it.
  allyWs.close();
  const allyId = (await call('hp', 'GET', '/api/devices')).body.find(d => d.name === 'ROG Ally').id;
  await call('hp', 'DELETE', '/api/devices/' + allyId, {});
  const after = fromHP && await transfer(fromHP.id);
  check('unpairing the Ally cancels what was waiting for it', after && after.status === 'cancelled', after && after.status);
} catch (e) {
  check('test ran to the end', false, e.stack || e.message);
} finally {
  try { allyWs && allyWs.close(); } catch {}
  quitTool();
  try { server.kill(); } catch {}
  await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
