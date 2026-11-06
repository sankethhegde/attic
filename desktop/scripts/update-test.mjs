// Phase 3, 3-5 end-to-end test: updates from the HP (T-10), in the real desktop tool against a throwaway
// server (port 8078). The "installer" is a stand-in compiled for the test: a real Windows program that
// only writes down how it was started, so nothing gets installed. It's published from Settings as the
// master; the HP announces it; the tool downloads and checks it, holds a download during a game, and
// "Restart to update" runs it silently and quits.
// Usage (from desktop/): node scripts/update-test.mjs [path-to-exe]
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
const HTTP_PORT = 8078, CDP_PORT = 9353;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-3-5-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
if (!lan) { console.log('FAIL  this PC needs a network address (Wi-Fi or Ethernet) for this test'); process.exit(1); }
const LAN = lan.address;

// The stand-in installer: records its arguments in ATTIC_FAKE_INSTALL_LOG (the tool passes its own
// environment on), and exits.
const INSTALL_LOG = path.join(tmp, 'installer-ran.txt');
const csc = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const fakeSrc = path.join(tmp, 'fake.cs');
fs.writeFileSync(fakeSrc, `class P { static void Main(string[] a) {
  System.IO.File.WriteAllText(System.Environment.GetEnvironmentVariable("ATTIC_FAKE_INSTALL_LOG"), string.Join(" ", a) + "\\n" + System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName); } }`);
const fakeFor = v => { const out = path.join(tmp, 'build', `Attic-Hub-Setup-${v}.exe`); fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(csc, ['/nologo', '/target:winexe', `/out:${out}`, fakeSrc], { windowsHide: true }); return out; };
const sha512 = f => crypto.createHash('sha512').update(fs.readFileSync(f)).digest('base64');

fs.mkdirSync(path.join(tmp, 'share'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: HTTP_PORT, host: '0.0.0.0', discovery: { enabled: false },
  pairing: { required: true, trustThisPC: true }, shares: [{ id: 'main', name: 'Test share', rootPath: path.join(tmp, 'share'), deviceType: 'hdd' }] }));
const server = spawn(process.execPath, [path.join(repo, 'server', 'server.js')], {
  env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(HTTP_PORT) }), stdio: 'ignore'
});

const jar = {};
function call(method, url, body, raw) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : raw ? body : Buffer.from(JSON.stringify(body));
    const headers = Object.assign({ Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') },
      data ? (raw ? { 'Content-Type': 'application/octet-stream', 'X-Attic-Upload': '1' } : { 'Content-Type': 'application/json' }) : {}, data ? { 'Content-Length': data.length } : {});
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
fs.writeFileSync(path.join(profile, 'prefs.json'), JSON.stringify({ startWithWindows: false, explorerMenu: false, trayHintShown: true, lowResource: 'off' }));
const electron = path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe');
// ATTIC_DEV_INSTALL lets a development copy run "the installer" too, for this test only.
const env = Object.assign({}, process.env, { ATTIC_INBOX: path.join(tmp, 'inbox'), ATTIC_TEST_HOOKS: '1', ATTIC_DEV_INSTALL: '1', ATTIC_FAKE_INSTALL_LOG: INSTALL_LOG });

let tool = null, ws = null, id = 0;
const pending = {};
async function launchTool(extra = [], moreEnv = {}, dataDir = profile) {
  tool = spawn(exe || electron, (exe ? [] : ['.']).concat([`--user-data-dir=${dataDir}`, `--remote-debugging-port=${CDP_PORT}`], extra), { cwd: desktop, stdio: 'ignore', env: Object.assign({}, env, moreEnv) });
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
const status = () => ev(`const s = document.querySelector('#upd-status'); return s ? s.dataset.status + ' | ' + s.textContent : null`);
const waitStatus = (re, ms = 20000) => until(async () => { const s = await status(); return re.test(s || '') ? s : null; }, ms);
async function signIn() {
  await waitFor(`location.hash === '#/login'`, 20000);
  await ev(`const f = document.querySelector('.login-card'); document.querySelector('#lg-master').click();
    f.querySelector('#lg-user').value = 'master'; f.querySelector('#lg-pass').value = 'test1234'; f.requestSubmit(); return 1`);
  await waitFor(`location.hash === '#/dashboard'`);
  await ev(`location.hash = '#/settings'; return 1`);
  await waitFor(`document.querySelector('#upd-status')`);
}

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/hello`).then(r => r.ok, () => false); if (!up) await sleep(250); }
  const hello = (await call('GET', '/api/hello')).body;
  await call('POST', '/api/setup', { displayName: 'Test', username: 'master', password: 'test1234' });
  await call('POST', '/api/session', { mode: 'master', username: 'master', password: 'test1234' });
  fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify({ serverId: hello.serverId, name: hello.name, address: LAN, port: HTTP_PORT }));
  const v1 = fakeFor('9.9.9'), v2 = fakeFor('9.9.10');

  await launchTool();
  await waitFor(`location.hash === '#/pair' && document.querySelector('#pr-name') && document.querySelector('#pr-name').value`, 20000);
  await ev(`const c = document.querySelector('#pr-code'); c.value = '${(await call('POST', '/api/pairing/codes', {})).body.code}'; c.dispatchEvent(new Event('input')); document.querySelector('.login-card').requestSubmit(); return 1`);
  await signIn();

  // 1. Nothing published yet.
  await until(async () => (await ev(`return (await atticDesktop.server.current()).agent`)) === 'reporting');
  await ev(`document.querySelector('#upd-check').click(); return 1`);
  const s1 = await waitStatus(/^current/);
  check('Settings → About → Updates: Check now says it’s up to date when nothing is published', /^current \| Up to date\./.test(s1 || ''), s1);

  // 2. The master publishes an installer from Settings (the real upload to the HP).
  await send('DOM.enable');
  const doc = await send('DOM.getDocument', { depth: -1 });
  const node = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#upd-file' });
  await send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [v1] });
  await waitFor(`document.querySelector('#upd-notes')`);
  await ev(`document.querySelector('#upd-notes').value = 'Faster sending'; [...document.querySelectorAll('.dialog-actions .btn')].find(b => b.textContent === 'Publish').click(); return 1`);
  const kept = await waitFor(`!document.querySelector('#upd-kept-row').hidden && document.querySelector('#upd-kept').textContent`);
  const onHp = (await call('GET', '/api/updates')).body;
  check('Settings → Publish an update puts the installer on the HP, with its notes', onHp.length === 1 && onHp[0].version === '9.9.9' && onHp[0].notes === 'Faster sending' && /9\.9\.9/.test(kept || ''), kept);

  // 3. The HP announces it; the tool downloads it, checks it, and offers it.
  const s3 = await waitStatus(/^ready/);
  const got = path.join(profile, 'updates', 'Attic-Hub-Setup-9.9.9.exe');
  check('the HP’s announcement starts the download; it’s checked and ready, with what’s new', /9\.9\.9 is ready\. It installs itself the next time Attic Hub starts or quits\. What’s new: Faster sending/.test(s3 || '') && fs.existsSync(got) && sha512(got) === sha512(v1), s3);
  const note = (await T('notes')).find(n => /^Attic Hub 9\.9\.9 is ready$/.test(n.title));
  check('a notification says it’s ready, once', note && note.title === 'Attic Hub 9.9.9 is ready' && /installs itself/.test(note.body), note ? `${note.title}: ${note.body}` : 'none');
  const tray = await T('tray');
  check('the tray offers “Restart to update to 9.9.9”', tray.some(i => i.label === 'Restart to update to 9.9.9'), '');
  check('Settings shows Restart to update', await ev(`const b = document.querySelector('#upd-install'); return !b.hidden && b.textContent`) === 'Restart to update to 9.9.9', '');

  // 4. A newer one while a game runs: it waits for the game to end, then replaces the old download.
  await T('game', { game: true, why: 'steam' });
  await ev(`await atticDesktop.prefs.set({ lowResource: 'auto' }); return 1`);
  await T('game', { game: true, why: 'steam' });
  const pub2 = await call('PUT', `/api/updates/files/Attic-Hub-Setup-9.9.10.exe?notes=${encodeURIComponent('Even faster')}`, fs.readFileSync(v2), true);
  const s4 = await waitStatus(/^waiting/);
  check('a release published during a game waits for it to end (low-resource mode)', pub2.status === 201 && s4 && !fs.existsSync(path.join(profile, 'updates', 'Attic-Hub-Setup-9.9.10.exe')), s4);
  await T('game', null);
  await ev(`await atticDesktop.prefs.set({ lowResource: 'off' }); return 1`);
  const s5 = await waitStatus(/^ready.*9\.9\.10/);
  check('the game ends: it downloads, and the older download is removed', s5 && fs.readdirSync(path.join(profile, 'updates')).join() === 'Attic-Hub-Setup-9.9.10.exe', s5);

  // 5. The HP itself asks its own server without pairing (Server mode's check).
  const own = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/updates/latest?current=0.9.0`).then(r => r.json());
  check('the HP can ask its own server (127.0.0.1), as Server mode does', own.version === '9.9.10' && own.newer === true, JSON.stringify({ v: own.version, newer: own.newer }));

  // 6. Restart to update: the installer runs silently, with Attic Hub to start again afterwards; the tool quits.
  await ev(`document.querySelector('#upd-install').click(); return 1`);
  await waitFor(`[...document.querySelectorAll('.dialog-actions .btn')].find(b => b.textContent === 'Restart and update')`);
  await ev(`[...document.querySelectorAll('.dialog-actions .btn')].find(b => b.textContent === 'Restart and update').click(); return 1`);
  const ran = await until(() => fs.existsSync(INSTALL_LOG) && fs.readFileSync(INSTALL_LOG, 'utf8'), 15000);
  const quit = await until(() => tool.exitCode !== null, 10000);
  check('Restart to update runs the downloaded installer silently, to start Attic Hub again', ran && ran.startsWith('/S --updated --force-run') && ran.includes('Attic-Hub-Setup-9.9.10.exe'), ran && ran.replace(/\s+/g, ' '));
  check('… and Attic Hub quits for it', quit, `exit ${tool.exitCode}`);

  // 7. Started again (as the installer's --force-run does): no repeat of the notification.
  await launchTool();
  await signIn();
  await waitStatus(/^ready/);
  const repeats = (await T('notes')).filter(n => /is ready$/.test(n.title)).length;
  check('started again, it doesn’t notify about the same version twice', repeats === 0, `${repeats} repeats`);
  // Quitting with an update downloaded installs it (0.12.1, like PixHaven), without starting Attic Hub again.
  fs.rmSync(INSTALL_LOG, { force: true });
  await T('trayClick', 'Quit Attic Hub');
  await until(() => tool.exitCode !== null, 8000);
  const onQuit = await until(() => fs.existsSync(INSTALL_LOG) && fs.readFileSync(INSTALL_LOG, 'utf8'), 10000);
  check('quitting Attic Hub with an update downloaded installs it, silently, without starting it again', onQuit && /^\/S --updated\n/.test(onQuit) && !/force-run/.test(onQuit) && onQuit.includes('9.9.10'), onQuit && onQuit.replace(/\s+/g, ' '));

  // 8. GitHub (0.12.1): a published release on a stand-in GitHub, found at a start with Windows (hidden),
  // downloaded through GitHub's redirect, and installed unseen, coming back hidden.
  const v3 = fakeFor('9.10.0'), v3bytes = fs.readFileSync(v3), v3sha = sha512(v3);
  const gh = http.createServer((req, res) => {
    const port = gh.address().port;
    if (req.url === '/repos/sankethhegde/attic/releases/latest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tag_name: 'v9.10.0', body: 'From GitHub', published_at: new Date().toISOString(), assets: [
        { name: 'Attic-Hub-Setup-9.10.0.exe', size: v3bytes.length, browser_download_url: `http://127.0.0.1:${port}/dl/Attic-Hub-Setup-9.10.0.exe` },
        { name: 'latest.yml', size: 200, browser_download_url: `http://127.0.0.1:${port}/dl/latest.yml` }] }));
    }
    if (req.url === '/dl/latest.yml') { res.writeHead(200); return res.end(`version: 9.10.0\npath: Attic-Hub-Setup-9.10.0.exe\nsha512: ${v3sha}\n`); }
    if (req.url === '/dl/Attic-Hub-Setup-9.10.0.exe') { res.writeHead(302, { Location: `http://localhost:${port}/cdn/x.exe` }); return res.end(); }
    if (req.url === '/cdn/x.exe') { res.writeHead(200, { 'Content-Length': v3bytes.length }); return res.end(v3bytes); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => gh.listen(0, '127.0.0.1', r));
  fs.rmSync(INSTALL_LOG, { force: true });
  // A PC not yet connected to any HP, so GitHub is the only source.
  const fresh = path.join(tmp, 'fresh-profile');
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(fresh, 'mode.json'), JSON.stringify({ mode: 'client' }));
  fs.writeFileSync(path.join(fresh, 'prefs.json'), JSON.stringify({ startWithWindows: false, explorerMenu: false, trayHintShown: true, lowResource: 'off' }));
  await launchTool(['--hidden'], { ATTIC_GITHUB_API: `http://127.0.0.1:${gh.address().port}`, ATTIC_UPDATE_FIRST_MS: '1500' }, fresh);
  const hiddenRun = await until(() => fs.existsSync(INSTALL_LOG) && fs.readFileSync(INSTALL_LOG, 'utf8'), 30000);
  const exited = await until(() => tool.exitCode !== null, 10000);
  const backHidden = fs.existsSync(path.join(fresh, 'relaunch-hidden'));
  check('GitHub: a published release is found at a start with Windows, downloaded and installed unseen; Attic Hub comes back hidden',
    hiddenRun && hiddenRun.startsWith('/S --updated --force-run') && hiddenRun.includes('Attic-Hub-Setup-9.10.0.exe') && exited && backHidden,
    `${hiddenRun && hiddenRun.replace(/\s+/g, ' ')} · quit ${!!exited} · comes back hidden ${backHidden}`);
  gh.close();
} catch (e) {
  check('the test ran to the end', false, e.stack);
} finally {
  try { ws.close(); } catch {} try { tool.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
