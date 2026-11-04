// Phase 3, 3-3 end-to-end test: choosing the Hub Inbox folder, "Send to Attic Hub" from File Explorer
// (the --send launches it makes), dropping files on the window, and Retry for a file sent by path, in the
// real desktop tool against a throwaway server (port 8076) with a stand-in "ROG Ally". With an exe it also
// adds and removes the real right-click entry; it always ends with it removed.
// Usage (from desktop/): node scripts/shortcuts-test.mjs [path-to-exe]
import { spawn, execFileSync } from 'node:child_process';
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
const HTTP_PORT = 8076, CDP_PORT = 9351;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-3-3-'));
const INBOX = path.join(tmp, 'inbox');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
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
        const buf = Buffer.concat(c); let json = null; try { json = JSON.parse(buf.toString()); } catch {}
        resolve({ status: res.statusCode, body: json, buf });
      });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const allySend = async (to, name, bytes) => { const t = (await call('ally', 'POST', '/api/transfers', { to, fileName: name, size: bytes.length })).body; await call('ally', 'PUT', `/api/transfers/${t.id}/file`, bytes, true); return t; };
const allyFetch = tid => new Promise((resolve, reject) => http.get({ host: LAN, localAddress: LAN, port: HTTP_PORT, path: `/api/transfers/${tid}/file`, headers: { 'X-Attic-Device': jars.ally.attic_device } },
  res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c))); }).on('error', reject));
const transfers = async () => (await call('hp', 'GET', '/api/transfers?limit=500')).body || [];

const profile = path.join(tmp, 'profile');
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'mode.json'), JSON.stringify({ mode: 'client' }));
// Off to begin with, so a failed run never leaves a start-up or Explorer entry behind for a test build.
fs.writeFileSync(path.join(profile, 'prefs.json'), JSON.stringify({ startWithWindows: false, explorerMenu: false, trayHintShown: true }));
const electron = path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = Object.assign({}, process.env, { ATTIC_INBOX: INBOX, ATTIC_TEST_HOOKS: '1' });
// A launch like File Explorer's: the same program, same profile, with --send <path>.
const launchArgs = extra => exe ? [`--user-data-dir=${profile}`, ...extra] : ['.', `--user-data-dir=${profile}`, ...extra];
const explorerLaunch = p => new Promise(r => { const c = spawn(exe || electron, launchArgs(['--send', p]), { cwd: desktop, stdio: 'ignore', env }); c.on('exit', r); });

let tool = null, ws = null, id = 0;
const pending = {};
async function launchTool() {
  tool = spawn(exe || electron, launchArgs([`--remote-debugging-port=${CDP_PORT}`]), { cwd: desktop, stdio: 'ignore', env });
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
const pickAllyAndSend = () => ev(`[...document.querySelectorAll('.send-dev')].find(b => /ROG Ally/.test(b.textContent)).click(); document.querySelector('.dialog-actions [data-i="1"]').click(); return 1`);

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

  await launchTool();
  await waitFor(`location.hash === '#/pair' && document.querySelector('#pr-name') && document.querySelector('#pr-name').value`, 20000);
  await ev(`const c = document.querySelector('#pr-code'); c.value = '${(await call('hp', 'POST', '/api/pairing/codes', {})).body.code}'; c.dispatchEvent(new Event('input')); document.querySelector('.login-card').requestSubmit(); return 1`);
  await waitFor(`location.hash === '#/login'`);
  await ev(`const f = document.querySelector('.login-card'); document.querySelector('#lg-master').click();
    f.querySelector('#lg-user').value = 'master'; f.querySelector('#lg-pass').value = 'test1234'; f.requestSubmit(); return 1`);
  await waitFor(`location.hash === '#/dashboard'`);
  const acer = (await call('hp', 'GET', '/api/devices')).body.find(d => d.role === 'client' && d.name !== 'ROG Ally');

  // 1. Choose another Hub Inbox folder (T-07); the next file lands there; back to the default.
  const chosen = path.join(tmp, 'Chosen inbox');
  await ev(`location.hash = '#/settings'; return 1`);
  await waitFor(`document.querySelector('#h-pc[data-loaded]')`);
  const r1 = await ev(`return await atticDesktop.inbox.choose(${JSON.stringify(chosen)})`);
  await ev(`location.reload(); return 1`);
  const shown = await waitFor(`document.querySelector('#h-pc[data-loaded]') && document.querySelector('#inbox-path').textContent && JSON.stringify({ path: document.querySelector('#inbox-path').textContent, reset: !document.querySelector('#inbox-reset').hidden })`);
  check('Settings → Hub Inbox: Change folder sets it, and offers going back to the default', r1 && r1.path === chosen && shown && JSON.parse(shown).path === chosen && JSON.parse(shown).reset, shown);
  await allySend(acer.id, 'Into chosen.txt', Buffer.from('chosen'));
  const landed = await until(() => fs.existsSync(path.join(chosen, 'Into chosen.txt')));
  check('the next file sent to this PC lands in the chosen folder', landed && !fs.existsSync(path.join(INBOX, 'Into chosen.txt')), landed ? chosen : 'not there');
  const bad = await ev(`return await atticDesktop.inbox.choose('relative\\\\folder')`);
  check('a folder that isn’t a full path is refused, with the reason', bad && /full folder path/.test(bad.error || ''), bad && bad.error);
  await ev(`document.querySelector('#inbox-reset').click(); return 1`);
  await sleep(500);
  await allySend(acer.id, 'Back home.txt', Buffer.from('home'));
  check('Use the default puts files back in the default folder', await until(() => fs.existsSync(path.join(INBOX, 'Back home.txt'))), INBOX);

  // 2. "Send to Attic Hub" from File Explorer: two launches (a file, a folder) make one Send dialog.
  const one = path.join(tmp, 'Holiday plan.pdf'), oneBytes = crypto.randomBytes(200 * 1024);
  fs.writeFileSync(one, oneBytes);
  const folder = path.join(tmp, 'Screenshots');
  fs.mkdirSync(path.join(folder, 'old'), { recursive: true });
  fs.writeFileSync(path.join(folder, 's1.png'), Buffer.alloc(3000, 1));
  fs.writeFileSync(path.join(folder, 'old', 's2.png'), Buffer.alloc(5000, 2));
  await ev(`location.hash = '#/devices'; return 1`);
  await Promise.all([explorerLaunch(one), explorerLaunch(folder)]);
  const what = await waitFor(`document.querySelector('#sd-what') && document.querySelectorAll('#sd-what li').length === 2 && document.querySelector('#sd-what').textContent.replace(/\\s+/g, ' ').trim()`, 10000);
  const noPick = await ev(`return !document.querySelector('#sd-files')`);
  check('two right-click launches (a file and a folder) open one Send dialog with both', what && /Holiday plan\.pdf/.test(what) && /Screenshots/.test(what) && /2 files/.test(what) && noPick === true, what);
  await pickAllyAndSend();
  const sent = await until(async () => { const l = await transfers(); const s = l.filter(t => ['Holiday plan.pdf', 's1.png', 's2.png'].includes(t.fileName) && t.status === 'queued'); return s.length === 3 && s; }, 20000);
  check('the tool sends them by path: three files queued for the Ally', sent, sent ? sent.map(t => `${t.fileName} ${t.size}`).join(', ') : JSON.stringify((await transfers()).map(t => t.fileName + ':' + t.status)));
  const plan = sent && sent.find(t => t.fileName === 'Holiday plan.pdf');
  const got = plan && await allyFetch(plan.id);
  check('what arrives is the file on disk, byte for byte', got && sha(got) === sha(oneBytes), got ? `${got.length} bytes` : 'nothing');
  if (plan) await call('ally', 'POST', `/api/transfers/${plan.id}/received`, {});

  // 3. Retry for a file sent by path: after a reload the page has no copy, but the tool sends it again.
  const s1 = sent && sent.find(t => t.fileName === 's1.png');
  await call('hp', 'DELETE', `/api/transfers/${s1.id}`, {});
  await ev(`location.hash = '#/transfers'; location.reload(); return 1`);
  await waitFor(`location.hash === '#/transfers' && [...document.querySelectorAll('#hist .tr-row')].some(r => /s1\\.png/.test(r.textContent) && r.querySelector('[data-retry]'))`);
  await ev(`[...document.querySelectorAll('#hist .tr-row')].find(r => /s1\\.png/.test(r.textContent)).querySelector('[data-retry]').click(); return 1`);
  const again = await until(async () => { const t = (await transfers()).find(x => x.id === s1.id); return t && t.status === 'queued' && t.attempts === 2 && t; }, 15000);
  check('Retry sends a file from File Explorer again by its path, without asking', again, again ? `attempt ${again.attempts}` : 'not re-sent');

  // 4. Dropping files on the window opens the Send dialog (T-08); the Dashboard's Upload keeps its drops.
  await ev(`location.hash = '#/devices'; return 1`);
  await waitFor(`document.querySelector('.hub-card')`);
  const dropped = await ev(`
    const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(1500)], 'Dropped note.txt'));
    const fire = (type, target) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    fire('dragenter', document.body); fire('dragover', document.body);
    const veil = !!document.querySelector('.drop-veil');
    fire('drop', document.body);
    for (let i = 0; i < 30 && !document.querySelector('#sd-what li'); i++) await new Promise(r => setTimeout(r, 100));
    return JSON.stringify({ veil, what: document.querySelector('#sd-what') && document.querySelector('#sd-what').textContent.replace(/\\s+/g, ' ').trim() });`);
  const dj = JSON.parse(dropped);
  check('dropping a file anywhere shows “Drop to send”, then the Send dialog with it', dj.veil && /Dropped note\.txt/.test(dj.what || ''), dropped);
  await pickAllyAndSend();
  const viaDrop = await until(async () => (await transfers()).find(t => t.fileName === 'Dropped note.txt' && t.status === 'queued'), 15000);
  check('… and sends it', viaDrop, viaDrop ? `${viaDrop.size} bytes queued` : 'not sent');
  await ev(`location.hash = '#/dashboard'; return 1`);
  const zone = await waitFor(`document.querySelector('.drop') ? 'zone' : null`, 8000);
  const upload = zone && await ev(`
    const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(10)], 'To the HP.txt'));
    const z = document.querySelector('.drop');
    for (const t of ['dragenter', 'dragover', 'drop']) z.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 800));
    return JSON.stringify({ dialog: !!document.querySelector('.dialog #sd-what'), veil: !!document.querySelector('.drop-veil') });`);
  check('a drop on the Dashboard’s Upload area still uploads to the HP, not the Send dialog', zone && upload && !JSON.parse(upload).dialog && !JSON.parse(upload).veil, upload || 'no Upload area here');

  // 5. The right-click entry itself (the installed app): on, then off again.
  await ev(`location.hash = '#/settings'; return 1`);
  const box = await waitFor(`document.querySelector('#h-pc[data-loaded]') && JSON.stringify({ checked: document.querySelector('#pc-explorer').checked, disabled: document.querySelector('#pc-explorer').disabled })`);
  if (exe) {
    await ev(`const b = document.querySelector('#pc-explorer'); b.checked = true; b.dispatchEvent(new Event('change')); return 1`);
    await sleep(1500);
    const on = await ev(`return await atticDesktop.test.explorerMenu()`);
    let cmd = '';
    try { cmd = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Classes\\*\\shell\\AtticHub\\command', '/ve'], { encoding: 'utf8' }); } catch {}
    await ev(`const b = document.querySelector('#pc-explorer'); b.checked = false; b.dispatchEvent(new Event('change')); return 1`);
    await sleep(1500);
    const off = await ev(`return await atticDesktop.test.explorerMenu()`);
    check('the switch adds “Send to Attic Hub” to File Explorer for this program, and removes it', on === 'ours' && /--send "%1"/.test(cmd) && off === 'none', `on → ${on}, off → ${off}; ${(cmd.match(/REG_SZ\s+(.*)/) || [])[1] || ''}`);
  } else check('a development copy greys the switch out (it would point Explorer at electron.exe)', box && JSON.parse(box).disabled === true, box);
} catch (e) {
  check('test ran to the end', false, e.stack || e.message);
} finally {
  try { if (exe && tool && tool.exitCode === null) await ev(`await atticDesktop.prefs.set({ explorerMenu: false, startWithWindows: false }); return 1`); } catch {}
  try { ws.close(); } catch {} try { tool.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
