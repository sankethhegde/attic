// Phase 2, 2-5 end-to-end test: the Transfers view on real data, in the real desktop tool, against a
// throwaway copy of server/ (port 8082). Live progress, a finished transfer moving to History, Cancel,
// Retry (re-sent automatically, and again after a reload by choosing the file), filters, search and
// paging. The tool plays the Acer (signed in as master); the test plays a "ROG Ally" with its own pairing,
// device account and uploads.
// Usage (from desktop/): node scripts/transfers-test.mjs [path-to-exe]
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
const HTTP_PORT = 8082, CDP_PORT = 9347;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-2-5-'));
const INBOX = path.join(tmp, 'inbox');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
if (!lan) { console.log('FAIL  this PC needs a network address (Wi-Fi or Ethernet) for this test'); process.exit(1); }
const LAN = lan.address;

fs.mkdirSync(path.join(tmp, 'share'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: HTTP_PORT, host: '0.0.0.0', discovery: { enabled: false },
  pairing: { required: true, trustThisPC: true },
  shares: [{ id: 'main', name: 'Test share', rootPath: path.join(tmp, 'share'), deviceType: 'hdd' }] }));
const server = spawn(process.execPath, [path.join(repo, 'server', 'server.js')], {
  env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(HTTP_PORT) }),
  stdio: 'ignore'
});

// Requests as the HP's master (127.0.0.1) or as the "ROG Ally" (this PC's network address, its cookies).
const jars = { hp: {}, ally: {} };
const cookieOf = who => Object.entries(jars[who]).map(([k, v]) => `${k}=${v}`).join('; ');
function call(who, method, url, body) {
  return new Promise((resolve, reject) => {
    const ally = who === 'ally';
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = Object.assign({ Cookie: cookieOf(who) }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {});
    const req = http.request({ host: ally ? LAN : '127.0.0.1', localAddress: ally ? LAN : undefined, port: HTTP_PORT, path: url, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        for (const c of res.headers['set-cookie'] || []) { const [kv] = c.split(';'); const [k, v] = kv.split('='); if (v) jars[who][k] = v; else delete jars[who][k]; }
        let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
// The Ally uploads `size` bytes in `pieces`, `gapMs` apart, so the upload is slow enough to watch.
function allyUpload(tid, size, { pieces = 1, gapMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: LAN, localAddress: LAN, port: HTTP_PORT, path: `/api/transfers/${tid}/file`, method: 'PUT',
      headers: { Cookie: cookieOf('ally'), 'Content-Type': 'application/octet-stream', 'X-Attic-Upload': '1', 'Content-Length': size } },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    const piece = Math.ceil(size / pieces);
    let sent = 0;
    const step = () => {
      const n = Math.min(piece, size - sent);
      req.write(Buffer.alloc(n, 7)); sent += n;
      if (sent < size) setTimeout(step, gapMs); else req.end();
    };
    step();
  });
}
async function allySend(to, name, size, opts) {
  const t = (await call('ally', 'POST', '/api/transfers', { to, fileName: name, size })).body;
  await allyUpload(t.id, size, opts);
  return t;
}

// ---- the desktop tool, driven over the DevTools protocol ----
const profile = path.join(tmp, 'profile');
let tool = null, ws = null, id = 0;
const pending = {}, events = [];
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
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } else if (d.method) events.push(d); };
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
    await sleep(150);
  }
  return null;
}
async function until(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } return null; }
function quitTool() { try { ws.close(); } catch {} try { tool.kill(); } catch {} }
const transfer = async tid => ((await call('hp', 'GET', '/api/transfers')).body || []).find(t => t.id === tid);
const row = (sel, name) => `[...document.querySelectorAll('${sel} .tr-row')].find(r => r.querySelector('.tr-name').textContent === ${JSON.stringify(name)})`;

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/hello`).then(r => r.ok, () => false); if (!up) await sleep(250); }
  check('throwaway server starts', up, `tool connects via ${LAN}:${HTTP_PORT}`);
  const hello = (await call('hp', 'GET', '/api/hello')).body;
  await call('hp', 'POST', '/api/setup', { displayName: 'Test', username: 'master', password: 'test1234' });
  await call('hp', 'POST', '/api/session', { mode: 'master', username: 'master', password: 'test1234' });
  const allyCode = (await call('hp', 'POST', '/api/pairing/codes', {})).body.code;
  await call('ally', 'POST', '/api/pairing/claim', { code: allyCode, name: 'ROG Ally', kind: 'handheld', os: 'Windows 11' });
  await call('hp', 'POST', '/api/accounts', { displayName: 'Ally user', username: 'ally', password: 'test1234', deviceType: 'handheld' });
  await call('ally', 'POST', '/api/session', { mode: 'device', username: 'ally', password: 'test1234' });

  // The tool pairs, signs in as master and opens Transfers.
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify({ serverId: hello.serverId, name: hello.name, address: LAN, port: HTTP_PORT }));
  await launchTool();
  await waitFor(`location.hash === '#/pair' && document.querySelector('#pr-name') && document.querySelector('#pr-name').value`, 20000);
  const code = (await call('hp', 'POST', '/api/pairing/codes', {})).body.code;
  await ev(`const c = document.querySelector('#pr-code'); c.value = '${code}'; c.dispatchEvent(new Event('input')); document.querySelector('.login-card').requestSubmit(); return 1`);
  await waitFor(`location.hash === '#/login'`);
  await ev(`const f = document.querySelector('.login-card'); document.querySelector('#lg-master').click();
    f.querySelector('#lg-user').value = 'master'; f.querySelector('#lg-pass').value = 'test1234'; f.requestSubmit(); return 1`);
  await waitFor(`location.hash === '#/dashboard'`);
  const acer = (await call('hp', 'GET', '/api/devices')).body.find(d => d.role === 'client' && d.name !== 'ROG Ally');
  const ally = (await call('hp', 'GET', '/api/devices')).body.find(d => d.name === 'ROG Ally');
  await ev(`location.hash = '#/transfers'; return 1`);
  const empty = await waitFor(`document.querySelector('#live.on') && document.querySelector('.tr-quiet') && document.querySelector('#hist').textContent.includes('No history yet') && document.querySelector('#tcount').textContent`);
  check('Transfers starts empty and live: no sample data', empty === 'Nothing moving', empty);

  // 1. Live progress: a slow upload from the Ally to this PC moves in "Now", then lands in History.
  const SIZE = 40 * 1024 * 1024;
  const slow = (await call('ally', 'POST', '/api/transfers', { to: acer.id, fileName: 'Gameplay clip.mp4', size: SIZE })).body;
  const uploading = allyUpload(slow.id, SIZE, { pieces: 20, gapMs: 200 });
  const seen = new Set();
  const tEnd = Date.now() + 8000;
  while (Date.now() < tEnd && seen.size < 3) {
    const w = await ev(`const r = ${row('#now', 'Gameplay clip.mp4')}; return r && r.querySelector('.meter') ? r.querySelector('.meter span').style.width + ' ' + r.querySelector('.c').textContent : null`);
    if (w && !String(w).startsWith('ERR')) seen.add(w);
    await sleep(300);
  }
  check('an upload shows live progress in Now', seen.size >= 3, [...seen].slice(0, 3).map(s => s.split(' · ')[0] + ' · ' + s.split(' · ')[1]).join(' | '));
  const sentBy = await ev(`const r = ${row('#now', 'Gameplay clip.mp4')}; return r && r.querySelector('.tr-by') && r.querySelector('.tr-by').textContent`);
  check('the master sees who sent it', /sent by Ally user/.test(sentBy || ''), sentBy);
  await uploading;
  const landed = await waitFor(`!${row('#now', 'Gameplay clip.mp4')} && ${row('#hist', 'Gameplay clip.mp4')} && ${row('#hist', 'Gameplay clip.mp4')}.querySelector('.tag').textContent + ' · ' + ${row('#hist', 'Gameplay clip.mp4')}.querySelector('.c').textContent`, 20000);
  check('once delivered it leaves Now and appears in History as Done, without a reload', /^Done/.test(landed || ''), landed);
  check('the tool’s agent saved it to the Hub Inbox', fs.existsSync(path.join(INBOX, 'Gameplay clip.mp4')), '');

  // 2. Send from the tool to the offline Ally; Cancel; Retry sends the file again by itself.
  await ev(`location.hash = '#/devices'; return 1`);
  await waitFor(`[...document.querySelectorAll('.hub-card')].some(c => /ROG Ally/.test(c.textContent) && c.querySelector('[data-send]'))`);
  await ev(`[...document.querySelectorAll('.hub-card')].find(c => /ROG Ally/.test(c.textContent)).querySelector('[data-send]').click();
    for (let i = 0; i < 40 && !document.querySelector('#sd-in-files'); i++) await new Promise(r => setTimeout(r, 100));
    const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(500000).fill(3)], 'Wallpapers.zip'));
    const inp = document.querySelector('#sd-in-files'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    document.querySelector('.dialog-actions [data-i="1"]').click(); return 1`);
  const wall = await until(async () => ((await call('hp', 'GET', '/api/transfers')).body || []).find(t => t.fileName === 'Wallpapers.zip' && t.status === 'queued'));
  await ev(`location.hash = '#/transfers'; return 1`);
  const waiting = await waitFor(`${row('#now', 'Wallpapers.zip')} && ${row('#now', 'Wallpapers.zip')}.querySelector('.c').textContent`);
  check('a file for an offline device waits in Now, saying where it is', /On the HP, waiting for ROG Ally/.test(waiting || ''), waiting);
  await ev(`${row('#now', 'Wallpapers.zip')}.querySelector('[data-cancel]').click(); return 1`);
  const cancelled = await waitFor(`!${row('#now', 'Wallpapers.zip')} && ${row('#hist', 'Wallpapers.zip')} && ${row('#hist', 'Wallpapers.zip')}.querySelector('.tag').textContent`);
  check('Cancel moves it to History as Cancelled', cancelled === 'Cancelled' && (await transfer(wall.id)).status === 'cancelled', cancelled);
  await ev(`${row('#hist', 'Wallpapers.zip')}.querySelector('[data-retry]').click(); return 1`);
  const retried = await until(async () => { const t = await transfer(wall.id); return t && t.status === 'queued' && t.attempts === 2 && t; }, 15000);
  const back = await waitFor(`${row('#now', 'Wallpapers.zip')} && /try 2/.test(${row('#now', 'Wallpapers.zip')}.textContent) && 'back in Now, try 2'`);
  check('Retry sends the file again from this PC by itself (the HP had deleted its copy)', retried && back, retried ? `queued, attempt ${retried.attempts}` : `status ${(await transfer(wall.id)).status}`);

  // 3. After a reload the page no longer has the file: Retry asks for it (the picker is intercepted here).
  await call('hp', 'DELETE', `/api/transfers/${wall.id}`, {});
  await ev(`location.reload(); return 1`);
  await waitFor(`location.hash === '#/transfers' && ${row('#hist', 'Wallpapers.zip')} && ${row('#hist', 'Wallpapers.zip')}.querySelector('[data-retry]')`);
  const again = path.join(tmp, 'Wallpapers.zip');
  fs.writeFileSync(again, Buffer.alloc(500000, 3));
  await send('Page.enable');
  await send('DOM.enable');
  await send('Page.setInterceptFileChooserDialog', { enabled: true });
  events.length = 0;
  await send('Runtime.evaluate', { expression: `${row('#hist', 'Wallpapers.zip')}.querySelector('[data-retry]').click()`, userGesture: true });
  const chooser = await until(() => events.find(e => e.method === 'Page.fileChooserOpened'), 8000);
  check('after a reload, Retry asks for the file again', chooser, chooser ? 'file picker opened' : 'no picker');
  if (chooser) await send('DOM.setFileInputFiles', { files: [again], backendNodeId: chooser.params.backendNodeId });
  const third = await until(async () => { const t = await transfer(wall.id); return t && t.status === 'queued' && t.attempts === 3 && t; }, 15000);
  check('the chosen file is sent and queued again', third, third ? `attempt ${third.attempts}` : `status ${(await transfer(wall.id)).status}`);
  await send('Page.setInterceptFileChooserDialog', { enabled: false });

  // 4. History: filters, search, device and paging.
  for (let i = 0; i < 52; i++) await allySend(acer.id, `Screenshot ${String(i).padStart(2, '0')}.png`, 1024);
  await until(async () => ((await call('hp', 'GET', '/api/transfers?limit=500')).body || []).filter(t => /^Screenshot/.test(t.fileName) && t.status === 'done').length === 52, 30000);
  await call('hp', 'DELETE', `/api/transfers/${wall.id}`, {}); // finished again, as Cancelled: 1 Done clip + 52 screenshots + this
  await ev(`location.reload(); return 1`);
  await waitFor(`location.hash === '#/transfers' && document.querySelectorAll('#hist .tr-row').length`);
  const firstPage = await waitFor(`document.querySelector('#t-more') && document.querySelectorAll('#hist .tr-row').length`);
  await ev(`document.querySelector('#t-more').click(); return 1`);
  const all = await waitFor(`!document.querySelector('#t-more') && document.querySelectorAll('#hist .tr-row').length`);
  check('History pages: 50 at a time, then Show older', firstPage === 50 && all === 54, `${firstPage} then ${all}`);
  await ev(`document.querySelector('[data-f="cancelled"]').click(); return 1`);
  const onlyCancelled = await waitFor(`document.querySelectorAll('#hist .tr-row').length === 1 && [...document.querySelectorAll('#hist .tag')].map(t => t.textContent).join(',')`);
  check('the Cancelled filter shows only cancelled transfers', onlyCancelled === 'Cancelled', onlyCancelled);
  await ev(`document.querySelector('[data-f=""]').click(); const s = document.querySelector('#search') || document.querySelector('input[type=search]'); s.value = 'Screenshot 4'; s.dispatchEvent(new Event('input', { bubbles: true })); return 1`);
  const searched = await waitFor(`document.querySelectorAll('#hist .tr-row').length === 10 && [...document.querySelectorAll('#hist .tr-name')].every(n => n.textContent.startsWith('Screenshot 4')) && 10`);
  check('search by file name', searched === 10, searched ? '10 matches for “Screenshot 4”' : await ev(`return document.querySelectorAll('#hist .tr-row').length`));
  await ev(`const s = document.querySelector('#search') || document.querySelector('input[type=search]'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true }));
    const d = document.querySelector('#t-device'); d.value = '${ally.id}'; d.dispatchEvent(new Event('change')); return 1`);
  await sleep(600);
  const byDevice = await waitFor(`document.querySelectorAll('#hist .tr-row').length && [...document.querySelectorAll('#hist .tr-route')].every(r => /ROG Ally/.test(r.textContent)) && document.querySelectorAll('#hist .tr-row').length + (document.querySelector('#t-more') ? '+' : '')`);
  check('the device filter shows transfers to or from that device', byDevice, byDevice);
  const polled = await ev(`return performance.getEntriesByType('resource').filter(e => /\\/api\\/transfers$/.test(e.name)).length`);
  await sleep(6000);
  const polled2 = await ev(`return performance.getEntriesByType('resource').filter(e => /\\/api\\/transfers$/.test(e.name)).length`);
  check('no polling while live', polled === polled2, `${polled} → ${polled2} list requests in 6 s`);
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
  await sleep(500);
  const narrow = await ev(`const over = [...document.querySelectorAll('.page *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).map(e => e.className).slice(0, 3);
    return document.documentElement.scrollWidth + 'px wide' + (over.length ? '; over: ' + over.join(', ') : '')`);
  check('at 360px nothing scrolls sideways', narrow === '360px wide', narrow);
} catch (e) {
  check('test ran to the end', false, e.stack || e.message);
} finally {
  quitTool();
  try { server.kill(); } catch {}
  await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
