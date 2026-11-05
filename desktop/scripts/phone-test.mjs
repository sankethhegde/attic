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
  ['Photos/Family.png', png], ['Videos/Birthday party.mp4', Buffer.alloc(40000, 1)], ['Documents/Tax return 2025 final final (signed copy for the accountant).pdf', Buffer.alloc(9000, 2)],
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
