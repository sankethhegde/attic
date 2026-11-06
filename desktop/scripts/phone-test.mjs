// Phase 4, 4-1 end-to-end test: the interface as the iPhone gets it. A throwaway server with HTTPS (port
// 8079 / 8449) and real files; a plain browser window (no desktop bridge, like Safari) emulating an
// iPhone: Safari's user agent, touch, 390 px wide (and 320 px, the narrowest still around), reaching the
// HP over HTTPS at its network address, so it pairs like a new phone. The certificate is accepted only if
// the HP's own CA issued it. Every view and the main dialogs are measured: nothing wider than the
// screen, tap targets big enough, no input small enough to make Safari zoom. Also the Home Screen app's
// manifest and icons, and the desktop-only actions being gone.
// Usage (from desktop/): node scripts/phone-test.mjs   (SHOTS=<folder> saves a screenshot of each view)
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const repo = path.join(desktop, '..');
const HTTP_PORT = 8079, HTTPS_PORT = 8449, CDP_PORT = 9354;
const SHOTS = process.env.SHOTS || null;
const AUDIT = process.env.AUDIT === '1'; // print every measurement, not only the checks
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-4-1-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
if (!lan) { console.log('FAIL  this PC needs a network address (Wi-Fi or Ethernet) for this test'); process.exit(1); }
const LAN = lan.address;
const BASE = `https://${LAN}:${HTTPS_PORT}/`;

// Files to look at: photos, a video, documents, and a name long enough to test wrapping.
const share = path.join(tmp, 'share');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPpfDwAE/wH+yZ8VswAAAABJRU5ErkJggg==', 'base64');
for (const [p, b] of [['Photos/2026/Beach day.png', png], ['Photos/2026/Sunset over the long harbour wall near the old lighthouse.png', png],
  ['Photos/Family.png', png], ['Videos/Birthday party.mp4', fs.readFileSync(path.join(here, 'fixtures', 'clip.mp4'))], ['Videos/Holiday/Beach.mp4', fs.readFileSync(path.join(here, 'fixtures', 'clip.mp4'))], ['Documents/Tax return 2025 final final (signed copy for the accountant).pdf', Buffer.alloc(9000, 2)],
  ['Documents/Notes.txt', Buffer.from('hello')], ['Backups/Ally save files/Elden Ring/ER0000.sl2', Buffer.alloc(3000, 3)]]) {
  fs.mkdirSync(path.dirname(path.join(share, p)), { recursive: true });
  fs.writeFileSync(path.join(share, p), b);
}
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: HTTP_PORT, host: '0.0.0.0', discovery: { enabled: false },
  https: { port: HTTPS_PORT }, pairing: { required: true, trustThisPC: true },
  shares: [{ id: 'main', name: 'Main drive', rootPath: share, deviceType: 'hdd' }] }));
const server = spawn(process.execPath, [path.join(repo, 'server', 'server.js')], {
  env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(HTTP_PORT) }), stdio: 'ignore'
});

const jars = { hp: {}, ally: {} };
function call(who, method, url, body) {
  return new Promise((resolve, reject) => {
    const ally = who === 'ally';
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = Object.assign({ Cookie: Object.entries(jars[who]).map(([k, v]) => `${k}=${v}`).join('; ') }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {});
    const req = http.request({ host: ally ? LAN : '127.0.0.1', localAddress: ally ? LAN : undefined, port: HTTP_PORT, path: url, method, headers }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => {
        for (const ck of res.headers['set-cookie'] || []) { const [kv] = ck.split(';'); const [k, v] = kv.split('='); if (v) jars[who][k] = v; else delete jars[who][k]; }
        const buf = Buffer.concat(c); let json = null; try { json = JSON.parse(buf.toString()); } catch {}
        resolve({ status: res.statusCode, body: json, buf, headers: res.headers });
      });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

// The "phone": Electron's Chromium with no preload, accepting only certificates the HP's CA issued.
const electron = path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe');
const browserMain = path.join(tmp, 'phone.js');
fs.writeFileSync(browserMain, `const { app, BrowserWindow } = require('electron');
app.on('certificate-error', (e, wc, url, err, cert, cb) => { const ok = /^Attic Hub CA/.test(cert.issuerName); if (ok) e.preventDefault(); cb(ok); });
app.whenReady().then(() => { const w = new BrowserWindow({ width: 430, height: 900, x: 40, y: 20, webPreferences: { sandbox: true, contextIsolation: true } }); w.loadURL('about:blank'); });`);
let phone = null, ws = null, id = 0;
const pending = {};
let loginField = null;
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
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
async function emulate(width, height) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
}

// Everything on screen that's wider than the screen (and isn't inside something that scrolls or clips
// it), tap targets under 40 px, and text inputs under 16 px (Safari zooms the page into those).
const MEASURE = `
  const W = innerWidth, out = { W, scrollW: document.scrollingElement.scrollWidth, over: [], small: [], zoom: [] };
  const name = el => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const visible = el => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity !== 0; };
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || !visible(el) || el.closest('.sr-only,[hidden],[aria-hidden="true"]')) continue;
    if (r.right > W + 1 || r.left < -1) {
      let p = el.parentElement, clipped = false;
      while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (/auto|scroll|hidden|clip/.test(o)) { const pr = p.getBoundingClientRect(); if (pr.right <= W + 1 && pr.left >= -1) { clipped = true; break; } } p = p.parentElement; }
      if (!clipped && getComputedStyle(el).position !== 'fixed') out.over.push(name(el) + ' ' + Math.round(r.left) + '→' + Math.round(r.right));
    }
    // Links inside a sentence, and the storage bar's segments (also listed under Storage by type), are exempt.
    if (el.matches('button, a[href], [role="button"], [role="tab"], select, input:not([type="hidden"]), summary, label.check') && !el.closest('p, small, li, .segbar') && r.top < innerHeight * 3
      && !el.closest('.veil, .dialog-veil, .panel') === !document.querySelector('.veil .dialog, .dialog-veil .dialog, .panel')) {
      const t = el.matches('input[type="checkbox"], input[type="radio"]') ? (el.closest('label') || el).getBoundingClientRect() : r;
      if ((t.height < 40 || t.width < 40) && !el.closest('.inline-ok')) out.small.push(name(el) + ' ' + Math.round(t.width) + 'x' + Math.round(t.height) + (el.textContent.trim() ? ' "' + el.textContent.trim().slice(0, 24) + '"' : ''));
    }
    if (el.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]), textarea, select') && parseFloat(getComputedStyle(el).fontSize) < 16) out.zoom.push(name(el) + ' ' + getComputedStyle(el).fontSize);
  }
  // Areas that scroll sideways (the page inside them is wider than they are), except those meant to.
  for (const el of document.querySelectorAll('body, body *')) {
    const cs = getComputedStyle(el);
    if (!/auto|scroll/.test(cs.overflowX) || el.closest('.crumbs, .h-scroll, [hidden]') || !visible(el)) continue;
    if (el.scrollWidth > el.clientWidth + 1) {
      const edge = el.getBoundingClientRect().left + el.clientWidth;
      const culprit = [...el.querySelectorAll('*')].filter(c => c.getBoundingClientRect().right > edge + 1 && visible(c)).map(name).pop();
      out.over.push('scrolls sideways: ' + name(el) + ' ' + el.scrollWidth + '/' + el.clientWidth + (culprit ? ' (widest: ' + culprit + ')' : ''));
    }
  }
  out.over = [...new Set(out.over)].slice(0, 12); out.small = [...new Set(out.small)].slice(0, 30); out.zoom = [...new Set(out.zoom)];
  return out;`;
const measured = {};
async function look(label) {
  await sleep(600);
  const m = await ev(MEASURE);
  measured[label] = m;
  if (AUDIT) console.log(`\n[${label}] width ${m.W}, page ${m.scrollW}\n  wider than the screen: ${m.over.join(' | ') || '—'}\n  small tap targets: ${m.small.join(' | ') || '—'}\n  zooming inputs: ${m.zoom.join(' | ') || '—'}`);
  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (s.result) fs.writeFileSync(path.join(SHOTS, label.replace(/[^\w-]+/g, '_') + '.png'), Buffer.from(s.result.data, 'base64'));
  }
  return m;
}
const go = async hash => { await ev(`location.hash = ${JSON.stringify(hash)}; return 1`); await sleep(300); await waitFor(`!document.querySelector('.skel')`, 8000); };
const closeDialog = () => ev(`const v = document.querySelector('.veil, .dialog-veil'); if (v) v.remove(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return 1`);

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/hello`).then(r => r.ok, () => false); if (!up) await sleep(250); }
  await call('hp', 'POST', '/api/setup', { displayName: 'Sanketh', username: 'master', password: 'test1234' });
  await call('hp', 'POST', '/api/session', { mode: 'master', username: 'master', password: 'test1234' });
  // A ROG Ally with live stats, for the Devices view.
  await call('ally', 'POST', '/api/pairing/claim', { code: (await call('hp', 'POST', '/api/pairing/codes', {})).body.code, name: 'ROG Ally', kind: 'handheld', os: 'Windows 11' });
  const ally = new WebSocket(`ws://${LAN}:${HTTP_PORT}/api/hub?role=agent`, { headers: { 'X-Attic-Device': jars.ally.attic_device } });
  ally.onmessage = m => { const d = JSON.parse(m.data); if (d.type === 'hello') ally.send(JSON.stringify({ type: 'stats', connection: 'wifi', ip: '192.168.1.40',
    stats: { cpu: 37, ramTotal: 16e9, ramUsed: 9e9, diskTotal: 1e12, diskFree: 4e11, battery: 64, charging: true } })); };

  phone = spawn(electron, [browserMain, `--user-data-dir=${path.join(tmp, 'phone-profile')}`, `--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 80 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === 'page'); } catch {} }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } };
  await send('Network.enable');
  await send('Network.setUserAgentOverride', { userAgent: IPHONE_UA, platform: 'iPhone' });
  await emulate(390, 844);
  await send('Page.enable');
  const pairAndSignIn = async () => {
    await waitFor(`location.hash === '#/pair' && document.querySelector('#pr-code')`, 20000);
    await ev(`const c = document.querySelector('#pr-code'); c.value = '${(await call('hp', 'POST', '/api/pairing/codes', {})).body.code}'; c.dispatchEvent(new Event('input')); document.querySelector('.login-card').requestSubmit(); return 1`);
    await waitFor(`location.hash === '#/login'`);
  };
  const signIn = async () => {
    await waitFor(`location.hash === '#/login' && document.querySelector('#lg-user')`);
    if (!loginField) loginField = await ev(`const i = document.querySelector('#lg-user'); return { label: document.querySelector('label[for=lg-user]').textContent, cap: i.getAttribute('autocapitalize') }`);
    await ev(`const f = document.querySelector('.login-card'); document.querySelector('#lg-master').click();
      f.querySelector('#lg-user').value = 'master'; f.querySelector('#lg-pass').value = 'test1234'; f.requestSubmit(); return 1`);
    return waitFor(`location.hash === '#/dashboard' && location.protocol`);
  };

  // 1. A new iPhone opens the HP's plain address: the pairing screen offers the way to the secure one.
  const tlsInfo = await (await fetch(`http://127.0.0.1:${HTTP_PORT}/api/tls`)).json();
  await send('Page.navigate', { url: `http://${LAN}:${HTTP_PORT}/` });
  await waitFor(`location.hash === '#/pair' && document.querySelector('#pr-code')`, 20000);
  const env0 = await ev(`return { handheld: Attic.ui.handheld, ios: Attic.ui.isIOS, coarse: matchMedia('(pointer: coarse)').matches, cls: document.documentElement.className }`);
  check('the page knows it’s on an iPhone (touch, no desktop tool)', env0.handheld && env0.ios && env0.coarse, JSON.stringify(env0));
  const hint = await waitFor(`(() => { const d = document.querySelector('.secure-hint'); return d && !d.hidden && JSON.stringify({ go: d.querySelector('#go-secure').href,
    profile: d.querySelector('.ph-profile').getAttribute('href'), steps: d.querySelectorAll('li').length, fp: d.textContent.includes(${JSON.stringify(tlsInfo.caFingerprint)}) }); })()`);
  const h = hint ? JSON.parse(hint) : {};
  check('over http, the pairing screen offers the secure address, with the steps to trust the HP', h.go === BASE && /profile\.mobileconfig$/.test(h.profile || '') && h.steps === 4 && h.fp, hint);
  await look('pair-http-390');
  // Pairs and signs in over http, then moves as Settings says.
  await pairAndSignIn();
  await signIn();
  await go('#/settings');
  const phoneCard = await waitFor(`(() => { const s = document.querySelector('#ph-secure'); const go = document.querySelector('#ph-go'); return s && go && JSON.stringify({ text: s.textContent, go: go.href, steps: document.querySelectorAll('#ph-steps li').length }); })()`);
  const pc = phoneCard ? JSON.parse(phoneCard) : {};
  check('Settings → This iPhone: not encrypted yet, the four steps, and Open the secure address', /^Off/.test(pc.text || '') && pc.go === BASE && pc.steps === 4, phoneCard);
  await look('settings-http-390');
  const profile = await fetch(`http://${LAN}:${HTTP_PORT}/api/tls/profile.mobileconfig`);
  check('the profile it links to downloads from the HP', profile.ok && /mobileconfig|x-apple-aspen-config/.test(profile.headers.get('content-type') || ''), profile.headers.get('content-type'));

  // 2. The secure address (the profile installed: here, only the HP's own CA's certificates are accepted).
  await send('Page.navigate', { url: BASE });
  const after = await waitFor(`['#/pair', '#/login', '#/dashboard'].includes(location.hash) && location.hash`, 20000);
  if (after === '#/pair') { await look('pair-390'); await pairAndSignIn(); }
  if (after !== '#/dashboard') await look('login-390');
  const signedIn = after === '#/dashboard' ? 'https:' : await signIn();
  check('over HTTPS (the HP’s own CA), the phone is paired and signed in', signedIn === 'https:', `${BASE}: arrived at ${after}`);
  await go('#/settings');
  const secureNow = await waitFor(`(() => { const s = document.querySelector('#ph-secure'); return s && /^On/.test(s.textContent) && s.textContent; })()`);
  check('Settings → This iPhone says it’s encrypted, with the CA’s fingerprint', secureNow && secureNow.includes(tlsInfo.caFingerprint), secureNow && secureNow.slice(0, 80));

  // 3. The Home Screen app: manifest, icons, and Safari's tags.
  const app = await ev(`const m = await fetch('manifest.webmanifest'); const j = await m.json();
    const sizes = await Promise.all(j.icons.map(i => new Promise(r => { const im = new Image(); im.onload = () => r(i.sizes === im.naturalWidth + 'x' + im.naturalHeight); im.onerror = () => r(false); im.src = i.src; })));
    const touch = document.querySelector('link[rel="apple-touch-icon"]');
    const tImg = await new Promise(r => { const im = new Image(); im.onload = () => r(im.naturalWidth); im.onerror = () => r(0); im.src = touch.href; });
    const meta = n => (document.querySelector('meta[name="' + n + '"]') || {}).content;
    return { type: m.headers.get('content-type'), name: j.name, short: j.short_name, display: j.display, start: j.start_url, icons: sizes.every(Boolean), maskable: j.icons.some(i => i.purpose === 'maskable'),
      touch: tImg, capable: meta('apple-mobile-web-app-capable'), title: meta('apple-mobile-web-app-title'), bar: meta('apple-mobile-web-app-status-bar-style'), viewport: meta('viewport') }`);
  check('the Home Screen app: manifest (standalone), icons at their sizes, and Safari’s tags', app.display === 'standalone' && app.name === 'Attic Hub' && app.icons && app.maskable && app.touch === 180
    && app.capable === 'yes' && app.title === 'Attic' && app.bar === 'black-translucent' && /viewport-fit=cover/.test(app.viewport) && /manifest\+json|webmanifest/.test(app.type || ''), JSON.stringify(app));

  // 2. Every view at 390 px and 320 px.
  const views = ['#/dashboard', '#/files', '#/files/main/Photos/2026', '#/files/main/Documents', '#/photos', '#/videos', '#/other', '#/devices', '#/transfers', '#/settings'];
  for (const w of [390, 320]) {
    await emulate(w, w === 390 ? 844 : 568);
    for (const v of views) { await go(v); await look(`${v.replace('#/', '')}-${w}`); }
    // Dialogs: Send, Pair a device, a file's details.
    await go('#/devices');
    await ev(`const b = [...document.querySelectorAll('button')].find(x => /Send a file/.test(x.textContent)); if (b) b.click(); return !!b`);
    await waitFor(`document.querySelector('.dialog')`, 5000); await look(`send-dialog-${w}`); await closeDialog();
    await ev(`const b = [...document.querySelectorAll('button')].find(x => /Pair a device/.test(x.textContent)); if (b) b.click(); return !!b`);
    await waitFor(`document.querySelector('.dialog')`, 5000); await look(`pair-dialog-${w}`); await closeDialog();
    await go('#/files/main/Documents');
    await waitFor(`document.querySelector('button.row')`, 5000);
    await ev(`[...document.querySelectorAll('button.row')].find(r => /Tax return/.test(r.textContent)).click(); return 1`);
    await waitFor(`document.querySelector('.panel')`, 5000); await look(`details-${w}`);
    await ev(`const c = document.querySelector('#panel-close'); if (c) c.click(); return 1`);
    // Tab labels: whole, not cut off.
    const cut = await ev(`return [...document.querySelectorAll('.tab span')].filter(s => s.offsetParent && s.scrollWidth > s.clientWidth + 1).map(s => s.textContent)`);
    check(`at ${w} px, every tab’s label fits (Dashboard is “Home” on a narrow phone)`, Array.isArray(cut) && !cut.length,
      (await ev(`return [...document.querySelectorAll('.tab span')].filter(s => s.offsetParent).map(s => s.textContent).join(' · ')`)) + (cut.length ? ' — cut: ' + cut.join(', ') : ''));
  }
  // 4. Desktop-only actions are gone; toasts sit above the tab bar.
  await emulate(390, 844);
  await go('#/devices');
  await ev(`[...document.querySelectorAll('button')].find(x => /Send a file/.test(x.textContent)).click(); return 1`);
  await waitFor(`document.querySelector('#sd-files')`, 5000);
  const sendBtns = await ev(`return { files: !!document.querySelector('#sd-files').offsetParent, folder: !!(document.querySelector('#sd-folder') || {}).offsetParent }`);
  await closeDialog();
  await go('#/dashboard');
  const dash = await waitFor(`document.querySelector('#browse') && JSON.stringify({ browse: document.querySelector('#browse').textContent, drag: !![...document.querySelectorAll('#drop p')].find(p => p.offsetParent) })`);
  await go('#/settings');
  const publish = await waitFor(`document.querySelector('#upd-publish') ? String(!!document.querySelector('#upd-publish').offsetParent) : null`);
  const d = dash ? JSON.parse(dash) : {};
  check('a phone isn’t offered what it can’t do: no Choose a folder, no Drag files here, no Publish an update', sendBtns.files && !sendBtns.folder && !d.drag && d.browse === 'Choose photos or files' && publish === 'false',
    `${JSON.stringify(sendBtns)} ${dash} publish visible ${publish}`);
  const toast = await ev(`Attic.ui.toast('A toast'); await new Promise(r => setTimeout(r, 400)); const t = document.querySelector('.toast').getBoundingClientRect(), b = document.querySelector('.tabs').getBoundingClientRect(); return { toast: Math.round(t.bottom), tabs: Math.round(b.top) }`);
  check('toasts sit above the tab bar', toast.toast <= toast.tabs, JSON.stringify(toast));

  // 5. 4-2: a big "video" from the camera roll, uploaded and sent in pieces over a slow Wi-Fi that drops.
  const video = path.join(tmp, 'IMG_0420.MOV'), clip = path.join(tmp, 'IMG_0421.MOV');
  fs.writeFileSync(video, crypto.randomBytes(40 * 1024 * 1024));
  fs.writeFileSync(clip, crypto.randomBytes(24 * 1024 * 1024));
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');
  const slow = () => send('Network.emulateNetworkConditions', { offline: false, latency: 5, downloadThroughput: 20e6, uploadThroughput: 6e6 });
  const drop = async ms => { await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await sleep(ms); await slow(); };
  const setFiles = async (selector, files) => {
    await send('DOM.enable');
    const doc = await send('DOM.getDocument', { depth: -1 });
    const n = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector });
    return send('DOM.setFileInputFiles', { nodeId: n.result.nodeId, files });
  };
  // Smaller pieces than the 32 MB the app uses, so a 24–40 MB file goes in several and the drop lands
  // between them (the emulated slow network reports a single piece's progress all at once).
  await ev(`Attic.api.resumable.chunk = 4 * 1024 * 1024; return 1`);
  await go('#/files/main/Videos');
  await waitFor(`document.querySelector('#fupload')`);
  await slow();
  await setFiles('#fpick', [video]);
  await waitFor(`/\\d+%/.test(document.querySelector('#fupload').textContent) && parseInt(document.querySelector('#fupload').textContent) >= 15`, 20000);
  const dropAt = await ev(`return document.querySelector('#fupload').textContent`);
  const dropping = drop(4000);
  const waiting = await waitFor(`document.querySelector('#fupload').textContent === 'Waiting…' && 'Waiting…'`, 6000);
  await dropping;
  const landed = path.join(share, 'Videos', 'IMG_0420.MOV');
  const upOk = await (async () => { for (let i = 0; i < 120; i++) { if (fs.existsSync(landed) && fs.statSync(landed).size === 40 * 1024 * 1024) return true; await sleep(500); } return false; })();
  check('a 40 MB video from the camera roll goes up in pieces; the Wi-Fi dropping part-way only pauses it', upOk && waiting && sha(fs.readFileSync(landed)) === sha(fs.readFileSync(video)),
    `dropped at ${dropAt}, showed “${waiting}”, landed whole: ${upOk}`);
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const leftovers = fs.readdirSync(path.join(share, 'Videos')).filter(f => f.startsWith('~attic-'));
  check('nothing half-sent is left in the folder', !leftovers.length, leftovers.join(', '));

  // Sending from the phone to the ROG Ally, also through a drop.
  await go('#/devices');
  await ev(`[...document.querySelectorAll('.card, .dev-card, li, article')].find(c => /ROG Ally/.test(c.textContent) && [...c.querySelectorAll('button')].some(b => /Send a file/.test(b.textContent)))
    .querySelectorAll('button').forEach(b => { if (/Send a file/.test(b.textContent)) b.click(); }); return 1`);
  await waitFor(`document.querySelector('#sd-in-files')`, 5000);
  const pickLabel = await ev(`return document.querySelector('#sd-files').textContent.trim()`);
  await setFiles('#sd-in-files', [clip]);
  await waitFor(`document.querySelector('.send-items li')`);
  await ev(`const d = [...document.querySelectorAll('.send-dev')].find(b => /ROG Ally/.test(b.textContent)); if (!d.classList.contains('on')) d.click(); return 1`);
  await slow();
  await ev(`document.querySelector('.dialog-actions [data-i="1"]').click(); return 1`);
  const etaP = waitFor(`(() => { const t = document.querySelector('#sd-progress'); return t && / left/.test(t.textContent) && t.textContent.replace(/\\s+/g, ' ').trim(); })()`, 20000);
  await waitFor(`(() => { const m = document.querySelector('#sd-progress .meter'); return m && +m.getAttribute('aria-valuenow') >= 15; })()`, 20000);
  const sDrop = drop(4000);
  const sWait = await waitFor(`(() => { const t = document.querySelector('#sd-progress'); return t && /Waiting for the connection/.test(t.textContent) && t.textContent.trim().slice(0, 60); })()`, 6000);
  await sDrop;
  const queued = await (async () => { for (let i = 0; i < 120; i++) { const t = ((await call('hp', 'GET', '/api/transfers?limit=50')).body || []).find(x => x.fileName === 'IMG_0421.MOV' && x.status === 'queued'); if (t) return t; await sleep(500); } return null; })();
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  let got = null;
  if (queued) got = await new Promise((resolve, reject) => http.get({ host: LAN, localAddress: LAN, port: HTTP_PORT, path: `/api/transfers/${queued.id}/file`, headers: { 'X-Attic-Device': jars.ally.attic_device } },
    res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve(Buffer.concat(c))); }).on('error', reject));
  check('sending a video to the ROG Ally from the phone: picked as photos or files, paused by the drop, then delivered whole',
    pickLabel === 'Choose photos or files' && sWait && got && sha(got) === sha(fs.readFileSync(clip)), `“${pickLabel}”; “${sWait}”; ${got ? got.length + ' bytes, intact ' + (sha(got) === sha(fs.readFileSync(clip))) : 'not queued'}`);
  const eta = await etaP;
  check('sending shows how long it will take', eta && /(about \d+ (min|h)|less than a minute|a few seconds) left/.test(eta), eta);

  // 6. Feedback 1 (6 Nov 2026).
  await emulate(390, 844);
  const tap = async sel => {
    // A click that counts as the person's own tap (userGesture), so a video may start playing from it,
    // as it would from a real tap. (Synthetic mouse events stall under touch emulation.)
    const r = await Promise.race([send('Runtime.evaluate', { expression: `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.scrollIntoView({ block: 'center' }); e.click(); return true; })()`,
      userGesture: true, returnByValue: true }), sleep(10000).then(() => null)]);
    return !!(r && r.result && r.result.result && r.result.result.value);
  };
  // Files: This PC, then the drive, then its shared folder; Back goes up a level.
  await go('#/files');
  const drives = await waitFor(`document.querySelector('.drive-card') && [...document.querySelectorAll('.drive-card .nm')].map(n => n.textContent).join(' | ')`);
  await look('files-drives-390');
  await tap('.drive-card');
  const inDrive = await waitFor(`location.hash.startsWith('#/files?drive=') && document.querySelector('.share-row-btn') && document.querySelector('.share-row-btn').textContent.replace(/\\s+/g, ' ').trim()`);
  await look('files-drive-390');
  await tap('.share-row-btn');
  await waitFor(`location.hash === '#/files/main' && document.querySelector('#fback')`);
  const backTop = await waitFor(`document.querySelector('#fback-label') && document.querySelector('#fback-label').textContent !== 'Back' && document.querySelector('#fback-label').textContent`);
  await go('#/files/main/Photos/2026');
  await waitFor(`document.querySelector('#fback-label') && document.querySelector('#fback-label').textContent === 'Photos'`);
  await tap('#fback');
  const upHash = await waitFor(`location.hash === '#/files/main/Photos' && location.hash`);
  check('Files is like File Explorer: This PC → the drive → its shared folders; Back goes up one level', /\(C:\)/.test(drives || '') && /Main drive/.test(inDrive || '') && backTop === 'C:' && upHash,
    `drives “${drives}”; on C: “${inDrive}”; Back at the top says “${backTop}”; from 2026 Back went to ${upHash}`);
  // Photos: All or By folder.
  await go('#/photos');
  await tap('[data-group="folder"]');
  const tiles = await waitFor(`document.querySelectorAll('.ftile').length >= 2 && [...document.querySelectorAll('.ftile .nm')].map(n => n.textContent).join(', ')`);
  await look('photos-folders-390');
  await ev(`[...document.querySelectorAll('.ftile')].find(t => /2026/.test(t.textContent)).click(); return 1`);
  const inside = await waitFor(`document.querySelector('#mback') && document.querySelectorAll('.ptile').length`);
  await tap('#mback');
  const backToTiles = await waitFor(`document.querySelectorAll('.ftile').length >= 2`);
  await tap('[data-group="all"]');
  const allAgain = await waitFor(`!document.querySelector('.ftile') && document.querySelectorAll('.ptile').length`);
  check('Photos: All or By folder; a folder opens its photos, with a way back', tiles && inside === 2 && backToTiles && allAgain === 3, `folders: ${tiles}; in 2026: ${inside}; all: ${allAgain}`);
  // Videos: real thumbnails, one tap to play.
  await go('#/videos');
  const thumbs = await waitFor(`(() => { const v = [...document.querySelectorAll('.vcard')].filter(c => /Beach|Birthday/.test(c.textContent)).map(c => c.querySelector('.vthumb')); return v.length === 2 && v.every(x => x.readyState >= 2 && x.videoWidth > 0) && v.length; })()`, 15000);
  await look('videos-390');
  await ev(`[...document.querySelectorAll('.vcard')].find(c => /Beach/.test(c.textContent)).id = 'beach-card'; return 1`);
  await tap('#beach-card');
  const playing = await waitFor(`(() => { const v = document.querySelector('.dialog video'); return v && !v.paused && v.currentTime > 0 && 'playing'; })()`, 8000);
  await closeDialog();
  await ev(`document.querySelectorAll('video').forEach(v => v.pause()); return 1`);
  check('Videos: each shows a frame from the video, and one tap plays it', thumbs === 2 && playing === 'playing', `thumbnails decoded: ${thumbs}; after one tap: ${playing}`);
  await tap('[data-group="folder"]');
  const vFolders = await waitFor(`document.querySelectorAll('.ftile').length === 2 && [...document.querySelectorAll('.ftile .nm')].map(n => n.textContent).join(', ')`);
  check('Videos: By folder too', vFolders, vFolders);
  await tap('[data-group="all"]');
  // Files: Play beside Download for a video.
  await go('#/files/main/Videos');
  await waitFor(`document.querySelector('button.row')`);
  await ev(`[...document.querySelectorAll('button.row')].find(r => /Birthday/.test(r.textContent)).click(); return 1`);
  await waitFor(`document.querySelector('.panel #play')`, 5000);
  const panelBtns = await ev(`return [...document.querySelectorAll('.panel-actions .btn')].map(b => b.textContent.trim()).join(' · ')`);
  await tap('.panel #play');
  const fplay = await waitFor(`(() => { const v = document.querySelector('.dialog video'); return v && !v.paused && 'playing'; })()`, 8000);
  await closeDialog();
  await ev(`document.querySelectorAll('video').forEach(v => v.pause()); const c = document.querySelector('#panel-close'); if (c) c.click(); return 1`);
  check('Files: a video has Play beside Download, and it plays', /Play/.test(panelBtns) && /Download/.test(panelBtns) && fplay === 'playing', `${panelBtns}; ${fplay}`);
  // Dashboard: the shares and the storage bar open what they show.
  await go('#/dashboard');
  const dashInfo = await waitFor(`document.querySelector('a.share-row-link') && JSON.stringify({ share: document.querySelector('a.share-row-link').getAttribute('href'), seg: document.querySelectorAll('.segbar .s.go').length, files: (document.querySelector('a.dash-link') || {}).textContent })`);
  await tap('a.share-row-link');
  const dashTo = await waitFor(`location.hash === '#/files/main' && location.hash`);
  check('Dashboard: a share row opens it in Files; the storage bar and file count are links too', dashInfo && dashTo && JSON.parse(dashInfo).seg > 0, `${dashInfo} → ${dashTo}`);
  // Usernames: email addresses allowed, and the phone doesn't capitalise them.
  check('the username field takes an email address and the phone doesn’t capitalise it', loginField && loginField.label === 'Username or email' && loginField.cap === 'none', JSON.stringify(loginField));

  const all = Object.entries(measured);
  const wide = all.filter(([, m]) => m.scrollW > m.W + 1 || m.over.length);
  check('no view or dialog is wider than the screen, at 390 px or 320 px', !wide.length, wide.map(([k, m]) => `${k}: ${m.scrollW}/${m.W} ${m.over.slice(0, 2).join(' ')}`).join(' ; ') || `${all.length} screens`);
  const small = all.filter(([, m]) => m.small.length);
  check('every tap target is at least 40 px', !small.length, small.map(([k, m]) => `${k}: ${m.small.slice(0, 3).join(', ')}`).slice(0, 6).join(' ; ') || '');
  const zoom = all.filter(([, m]) => m.zoom.length);
  check('no input makes Safari zoom (all 16 px or more)', !zoom.length, zoom.map(([k, m]) => `${k}: ${m.zoom.join(', ')}`).slice(0, 4).join(' ; ') || '');
} catch (e) {
  check('the test ran to the end', false, e.stack);
} finally {
  try { ws.close(); } catch {} try { phone.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
