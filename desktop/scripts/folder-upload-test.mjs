// Upload folder (9 Nov 2026): Files → a folder → Upload folder sends a whole folder, with the folders
// inside it, into the open folder. Runs the real desktop tool against a throwaway server (port 8092):
//   1. a folder with a subfolder, a big file (over 16 MB, so it goes in resumable pieces), an empty file
//      (skipped, and said so) and desktop.ini (left out) lands with its layout on the HP's disk;
//   2. uploading it again fills the same folder and never overwrites ("notes (1).txt");
//   3. the button sits beside Upload and the toolbar still fits a narrow window.
// Usage (from desktop/): node scripts/folder-upload-test.mjs [exe]
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const repo = path.join(desktop, '..');
const exe = process.argv[2];
const CDP_PORT = 9357, HTTP_PORT = 8092;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-folderup-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// The folder on "this PC" to upload.
const src = path.join(tmp, 'pc', 'Trip 2026');
const BIG = 17 * 1024 * 1024 + 123;
for (const [f, body] of [['notes.txt', 'day one'], ['Goa/beach.jpg', 'not really a jpeg'], ['Goa/Night/stars.txt', 'deep'], ['empty.txt', ''], ['desktop.ini', '[.ShellClassInfo]']]) {
  fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true });
  fs.writeFileSync(path.join(src, f), body);
}
fs.writeFileSync(path.join(src, 'Goa', 'video.bin'), Buffer.alloc(BIG, 7));

const share = path.join(tmp, 'share');
fs.mkdirSync(path.join(share, 'Holidays'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: HTTP_PORT, host: '127.0.0.1', discovery: { enabled: false },
  shares: [{ id: 'main', name: 'Test share', rootPath: share, deviceType: 'hdd' }] }));
const server = spawn(process.execPath, [path.join(repo, 'server', 'server.js')], { stdio: 'ignore',
  env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(HTTP_PORT) }) });
for (let i = 0; i < 60; i++) { if (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/hello`).then(r => r.ok, () => false)) break; await sleep(250); }

const profile = path.join(tmp, 'profile');
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'mode.json'), JSON.stringify({ mode: 'client' }));
fs.writeFileSync(path.join(profile, 'prefs.json'), JSON.stringify({ startWithWindows: false, explorerMenu: false, trayHintShown: true, lowResource: 'off' }));
fs.writeFileSync(path.join(profile, 'server.json'), JSON.stringify({ address: '127.0.0.1', port: HTTP_PORT }));
const args = [`--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`];
const env = Object.assign({}, process.env, { ATTIC_GITHUB_API: 'off' });
const proc = exe ? spawn(exe, args, { stdio: 'ignore', env })
  : spawn(path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.', ...args], { cwd: desktop, stdio: 'ignore', env });

let ws, id = 0;
const pending = {}, errors = [];
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => {
  const r = await Promise.race([send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }), sleep(20000).then(() => null)]);
  return r && r.result && !r.result.exceptionDetails ? r.result.result.value : null;
};
async function waitFor(expr, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await ev(`return ${expr}`); if (v) return v; await sleep(250); } return null; }
async function pickFolder(dir) {
  const doc = await send('DOM.getDocument', {});
  const n = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fpickdir' });
  return send('DOM.setFileInputFiles', { nodeId: n.result.nodeId, files: [dir] });
}
const toasts = () => ev(`return [...document.querySelectorAll('#toasts .toast')].map(t => t.textContent).join(' | ')`);
const tree = dir => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile()).map(d => path.relative(dir, path.join(d.parentPath || d.path, d.name)).replace(/\\/g, '/')).sort();

try {
  let target;
  for (let i = 0; i < 80 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === 'page'); } catch {} }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; }
    if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  };
  await send('Runtime.enable');
  await waitFor(`location.protocol === 'http:' && !!window.Attic`, 20000);
  await ev(`for (let i = 0; i < 100 && !document.querySelector('h1'); i++) await new Promise(r => setTimeout(r, 100));
    await Attic.api.createMaster({ displayName: 'Test', username: 'master', password: 'test1234' });
    await Attic.api.signIn({ mode: 'master', username: 'master', password: 'test1234', stay: true }); return 1`);
  await send('Page.reload'); await sleep(2500);
  await waitFor(`!!window.Attic && !!document.querySelector('.page')`, 15000);
  await ev(`location.hash = '#/files/main/Holidays'; return 1`);
  const btns = await waitFor(`document.querySelector('#fupdir') && [...document.querySelectorAll('.toolbar .btn')].map(b => b.textContent.trim()).join(', ')`);
  check('Files shows Upload folder beside Upload', btns && /Upload, Upload folder/.test(btns), btns);
  const dirInput = await ev(`const i = document.querySelector('#fpickdir'); return i && i.webkitdirectory`);
  check('it opens a folder picker (not a file picker)', dirInput === true);

  // The buttons are wired once the folder's list has loaded.
  await waitFor(`!!document.querySelector('#body .files-layout, #body .state')`, 15000);
  await sleep(300);

  // 1. The first upload.
  // Everything the button and the messages say, as it happens (a local upload is quick).
  await ev(`window.__seen = { labels: [], toasts: [] };
    const b = document.querySelector('#fupdir');
    new MutationObserver(() => window.__seen.labels.push(b.textContent)).observe(b, { subtree: true, childList: true, characterData: true });
    new MutationObserver(() => document.querySelectorAll('#toasts .toast').forEach(t => { if (!window.__seen.toasts.includes(t.textContent)) window.__seen.toasts.push(t.textContent); }))
      .observe(document.body, { subtree: true, childList: true }); return 1`);
  await pickFolder(src);
  const t1 = await waitFor(`(t => /uploaded/.test(t) && t)(window.__seen.toasts.join(' | '))`, 60000);
  const label = await ev(`return [...new Set(window.__seen.labels)].join(' → ')`);
  const landed = tree(path.join(share, 'Holidays'));
  const want = ['Trip 2026/Goa/Night/stars.txt', 'Trip 2026/Goa/beach.jpg', 'Trip 2026/Goa/video.bin', 'Trip 2026/notes.txt'];
  check('the button shows progress while it works, then goes back', label && /Folders…/.test(label) && /\d+%/.test(label) && /Upload folder$/.test(label), label);
  check('the whole folder lands inside the open folder, with its folders, and nothing else', JSON.stringify(landed) === JSON.stringify(want), landed.join(', '));
  check('the big file (resumable pieces) arrives whole', fs.statSync(path.join(share, 'Holidays', 'Trip 2026', 'Goa', 'video.bin')).size === BIG);
  check('it says how it went, including the skipped empty file', t1 && /“Trip 2026” uploaded: 4 files · 1 skipped/.test(t1), t1);
  const listed = await waitFor(`[...document.querySelectorAll('#listcol .name, #listcol .nm, #listcol [data-id]')].some(e => /Trip 2026/.test(e.textContent)) && 'listed'`, 8000);
  check('the new folder appears in the list straight away', listed);
  const entry = await ev(`const r = await fetch('/api/shares/main/folder?path=' + encodeURIComponent('Holidays/Trip 2026/Goa')); return (await r.json()).items.map(i => i.name + ':' + (i.ownerId ? 'owned' : 'common')).join(', ')`);
  check('the files are the uploader’s, the same as Upload', entry && !/common/.test(entry.replace(/Night:common/, '')), entry);

  // 2. Again: same folder, nothing overwritten.
  await ev(`document.querySelectorAll('#toasts .toast').forEach(t => t.remove()); return 1`);
  await pickFolder(src);
  const t2 = await waitFor(`(t => /uploaded/.test(t) && t)([...document.querySelectorAll('#toasts .toast')].map(t => t.textContent).join(' | '))`, 60000);
  const again = tree(path.join(share, 'Holidays'));
  check('uploading it again fills the same folder and never overwrites', t2 && /“Trip 2026”/.test(t2) && again.includes('Trip 2026/notes (1).txt') && again.includes('Trip 2026/Goa/Night/stars (1).txt') && !fs.existsSync(path.join(share, 'Holidays', 'Trip 2026 (1)'))
    && fs.readFileSync(path.join(share, 'Holidays', 'Trip 2026', 'notes.txt'), 'utf8') === 'day one', `${t2} · ${again.length} files`);

  // 3. A narrow window: the toolbar still fits.
  await send('Emulation.setDeviceMetricsOverride', { width: 700, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const fit = await ev(`const p = document.querySelector('#fpage'); const b = document.querySelector('#fupdir').getBoundingClientRect(); return { over: p.scrollWidth - p.clientWidth, right: Math.round(b.right), w: innerWidth }`);
  check('at 700 px wide the toolbar still fits', fit && fit.over <= 0 && fit.right <= fit.w, JSON.stringify(fit));
  await send('Emulation.clearDeviceMetricsOverride');
  check('no errors in the window', !errors.length, errors.join(' | '));
} catch (e) {
  check('the test ran to the end', false, e.stack);
} finally {
  try { ws && ws.close(); } catch {}
  proc.kill(); server.kill();
  await sleep(800);
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
