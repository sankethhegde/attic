// Feedback round 1 end-to-end test: email usernames, forgot password by email, sign up approved by the
// master, the master setting a password and the HP's Gmail, through the real screens. A throwaway server
// (port 8081) and a plain browser window (no desktop bridge) emulating an iPhone, on this PC's network
// address so it pairs like a new phone. Email goes to a stand-in for Gmail (a local TLS SMTP server,
// trusted through ATTIC_MAIL_CA), as in the HP's own server/feedback1.test.js.
// Usage (from desktop/): node scripts/accounts-test.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import tlsMod from 'node:tls';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, '..');
const repo = path.join(desktop, '..');
const { createTls } = require(path.join(repo, 'server', 'tls.js'));
const HTTP_PORT = 8081, CDP_PORT = 9355;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-acct-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'));
if (!lan) { console.log('FAIL  this PC needs a network address (Wi-Fi or Ethernet) for this test'); process.exit(1); }
const LAN = lan.address, BASE = `http://${LAN}:${HTTP_PORT}/`;

// ---------- a stand-in for Gmail ----------
const GMAIL = { user: 'attic.hp@gmail.com', appPassword: 'abcd efgh ijkl mnop' };
const inbox = [];
function startSmtp(dir) {
  const t = createTls(dir, { hostname: 'mail-test' });
  const s = tlsMod.createServer({ key: t.key, cert: t.cert }, sock => {
    sock.setEncoding('utf8');
    let buf = '', inData = false, data = '';
    const say = l => sock.write(l + '\r\n');
    say('220 mail-test ESMTP');
    sock.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) { if (line === '.') { inData = false; inbox.push(parseMail(data)); data = ''; say('250 OK queued'); } else data += line.replace(/^\./, '') + '\r\n'; continue; }
        if (/^EHLO/i.test(line)) { sock.write('250-mail-test\r\n250 AUTH PLAIN\r\n'); continue; }
        if (/^AUTH PLAIN /i.test(line)) { const [, u, p] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\0'); say(u === GMAIL.user && p === GMAIL.appPassword.replace(/\s/g, '') ? '235 Accepted' : '535 Bad credentials'); continue; }
        if (/^(MAIL FROM|RCPT TO)/i.test(line)) { say('250 OK'); continue; }
        if (/^DATA/i.test(line)) { inData = true; say('354 Go ahead'); continue; }
        if (/^QUIT/i.test(line)) { say('221 Bye'); sock.end(); continue; }
        say('502 Unknown');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ server: s, port: s.address().port, caPath: path.join(dir, 'tls', 'ca.pem') })));
}
function parseMail(raw) {
  const [head, body] = raw.split('\r\n\r\n');
  const h = {}; for (const l of head.split('\r\n')) { const i = l.indexOf(':'); h[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
  const subject = h.subject.startsWith('=?UTF-8?B?') ? Buffer.from(h.subject.slice(10, -2), 'base64').toString('utf8') : h.subject;
  return { to: h.to.replace(/[<>]/g, ''), subject, text: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') };
}

const jar = {};
function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: HTTP_PORT, path: url, method, headers: Object.assign({ Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => { for (const ck of res.headers['set-cookie'] || []) { const [kv] = ck.split(';'); const [k, v] = kv.split('='); if (v) jar[k] = v; else delete jar[k]; }
        let json = null; try { json = JSON.parse(Buffer.concat(c).toString()); } catch {} resolve({ status: res.statusCode, body: json }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let server, smtp, phone, ws, id = 0;
const pending = {};
const send = (method, params = {}) => Promise.race([new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); }), sleep(20000).then(() => ({}))]);
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (!r || !r.result) return 'TIMEOUT';
  return r.result.exceptionDetails ? 'ERR ' + (r.result.exceptionDetails.exception?.description || '') : r.result.result.value;
};
async function waitFor(cond, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await ev(`try { return (${cond}) || null; } catch (e) { return null; }`).catch(() => null); if (v && v !== 'TIMEOUT' && !String(v).startsWith('ERR')) return v; await sleep(200); }
  return null;
}
const fill = (sel, v) => ev(`const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1`);
const submit = () => ev(`document.querySelector('.login-card').requestSubmit(); return 1`);
const text = sel => ev(`const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.replace(/\\s+/g, ' ').trim() : null`);
async function signIn(user, pass, master) {
  await ev(`location.hash = '#/login'; return 1`);
  await waitFor(`document.querySelector('#lg-user')`);
  if (master) await ev(`document.querySelector('#lg-master').click(); return 1`);
  await fill('#lg-user', user); await fill('#lg-pass', pass); await submit();
}
const signOut = () => ev(`await Attic.api.signOut(); location.hash = '#/login'; location.reload(); return 1`);

try {
  smtp = await startSmtp(path.join(tmp, 'smtp'));
  fs.mkdirSync(path.join(tmp, 'share'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: HTTP_PORT, host: '0.0.0.0', discovery: { enabled: false }, https: { enabled: false },
    pairing: { required: true, trustThisPC: true }, shares: [{ id: 'main', name: 'Main drive', rootPath: path.join(tmp, 'share'), deviceType: 'hdd' }] }));
  server = spawn(process.execPath, [path.join(repo, 'server', 'server.js')], { stdio: 'ignore',
    env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(HTTP_PORT), ATTIC_MAIL_CA: smtp.caPath }) });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { up = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/hello`).then(r => r.ok, () => false); if (!up) await sleep(250); }
  // The master, with the username the feedback asked for, and the HP's Gmail (pointed at the stand-in).
  const setup = await call('POST', '/api/setup', { displayName: 'Sanketh', username: 'Sankethhegde4321@gmail.com', password: 'test1234' });
  await call('POST', '/api/session', { mode: 'master', username: 'Sankethhegde4321@gmail.com', password: 'test1234' });
  const mailOn = await call('PUT', '/api/mail', { user: GMAIL.user, appPassword: GMAIL.appPassword, host: 'localhost', port: smtp.port });
  check('the HP takes Sankethhegde4321@gmail.com as the master’s username, and its Gmail (the stand-in)', setup.status < 300 && mailOn.body && mailOn.body.configured, `setup ${setup.status}; mail ${JSON.stringify(mailOn.body)}`);

  // The phone.
  const electron = path.join(desktop, 'node_modules', 'electron', 'dist', 'electron.exe');
  const main = path.join(tmp, 'phone.js');
  fs.writeFileSync(main, `const { app, BrowserWindow } = require('electron'); app.whenReady().then(() => { const w = new BrowserWindow({ width: 430, height: 900, webPreferences: { sandbox: true } }); w.loadURL('about:blank'); });`);
  phone = spawn(electron, [main, `--user-data-dir=${path.join(tmp, 'phone-profile')}`, `--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 80 && !target; i++) { await sleep(250); try { target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === 'page'); } catch {} }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; } };
  await send('Network.enable');
  await send('Network.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', platform: 'iPhone' });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.enable');
  await send('Page.navigate', { url: BASE });
  await waitFor(`location.hash === '#/pair' && document.querySelector('#pr-code')`, 20000);
  await fill('#pr-code', (await call('POST', '/api/pairing/codes', {})).body.code); await submit();
  await waitFor(`location.hash === '#/login' && document.querySelector('#lg-forgot')`);

  // 1. The sign-in screen offers both; the master's mode has no sign-up.
  const links = await ev(`return { forgot: !!document.querySelector('#lg-forgot'), signup: !document.querySelector('#lg-signup').hidden }`);
  await ev(`document.querySelector('#lg-master').click(); return 1`);
  const masterSignup = await ev(`return document.querySelector('#lg-signup').hidden`);
  await ev(`document.querySelector('#lg-back').click(); return 1`);
  check('sign-in offers Forgot password and Create an account (not in master mode)', links.forgot && links.signup && masterSignup === true, JSON.stringify(links));

  // 2. Sign up with an email username; it waits for the master.
  await ev(`document.querySelector('#lg-signup').click(); return 1`);
  await waitFor(`location.hash === '#/signup' && document.querySelector('#sg-name')`);
  await fill('#sg-name', 'Priya'); await fill('#sg-user', 'Priya.K@example.com');
  const emailHidden = await ev(`return document.querySelector('[data-field="sg-email"]').hidden`);
  await fill('#sg-pass', 'garden42'); await fill('#sg-pass2', 'garden42'); await submit();
  const waiting = await waitFor(`/Waiting for approval/.test(document.querySelector('.login-card').textContent) && document.querySelector('.login-card .banner').textContent.replace(/\\s+/g, ' ').trim()`);
  check('Create an account: an email address as the username (its own email, so no second field), then “waiting for approval”', waiting && emailHidden === true && /Priya\.K@example\.com/i.test(waiting), waiting);
  await signIn('priya.k@example.com', 'garden42');
  const pendingMsg = await waitFor(`document.querySelector('#lg-error') && document.querySelector('#lg-error').textContent.trim()`);
  check('signing in before approval says it’s waiting for the master', /approv/i.test(pendingMsg || ''), pendingMsg);

  // 3. The master approves it on the Dashboard; sets their own email in Settings.
  await signIn('SANKETHHEGDE4321@gmail.com', 'test1234', true);
  const dash = await waitFor(`location.hash === '#/dashboard' && document.querySelector('[data-approve]') && document.querySelector('#devices .banner').textContent.trim()`, 20000);
  await ev(`document.querySelector('[data-approve]').click(); return 1`);
  const approved = await waitFor(`!document.querySelector('[data-approve]') && document.querySelector('[data-setpass]') && 'approved'`);
  check('the master signs in with the email username (any case); the Dashboard shows the sign-up, and Approve works', dash && approved, dash);
  await ev(`location.hash = '#/settings'; return 1`);
  await waitFor(`document.querySelector('#email') && document.querySelector('#mail-state') && /On:/.test(document.querySelector('#mail-state').textContent)`);
  const mailState = await text('#mail-state');
  await fill('#email', 'sanketh.backup@example.com');
  await ev(`const i = document.querySelector('#email'); i.focus(); i.blur(); return 1`);
  await sleep(800);
  const me = (await call('GET', '/api/session')).body;
  await ev(`document.querySelector('#mail-test').click(); return 1`);
  const test = await (async () => { for (let i = 0; i < 40; i++) { const m = inbox.find(x => /email works/i.test(x.subject)); if (m) return m; await sleep(250); } return null; })();
  check('Settings: your email is saved; reset emails show as on, and Send a test arrives', me && me.account.email === 'sanketh.backup@example.com' && /attic\.hp@gmail\.com/.test(mailState || '') && test && test.to === 'sanketh.backup@example.com',
    `email ${me && me.account.email}; “${mailState}”; test to ${test && test.to}`);

  // 3b. Phase 5: Settings → People Portfolio. The master sets the save folder and the page's address, makes
  // a key (shown once), and the "People Portfolio page" then uses it from its own address.
  fs.mkdirSync(path.join(tmp, 'share', 'Backups', 'People'), { recursive: true });
  await ev(`location.hash = '#/settings'; return 1`);
  await waitFor(`document.querySelector('#pp-card[data-loaded]')`, 15000);
  await ev(`document.querySelector('#pp-share').value = 'main'; return 1`);
  await fill('#pp-path', 'Backups/People');
  await ev(`document.querySelector('#pp-save-folder').click(); return 1`);
  await sleep(600);
  await fill('#pp-origins', 'http://localhost:5173');
  await ev(`document.querySelector('#pp-save-origins').click(); return 1`);
  await sleep(600);
  await ev(`document.querySelector('#pp-key').click(); return 1`);
  const ppKey = await waitFor(`document.querySelector('#pp-key-value') && document.querySelector('#pp-key-value').value`);
  await ev(`const v = document.querySelector('.veil'); if (v) v.remove(); return 1`);
  const ppState = await waitFor(`/A key is set/.test(document.querySelector('#pp-key-state').textContent) && document.querySelector('#pp-key-state').textContent`);
  const pageCall = (method, url, body, origin = 'http://localhost:5173') => new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const q = http.request({ host: '127.0.0.1', port: HTTP_PORT, path: url, method, headers: Object.assign({ Origin: origin, 'X-Attic-Key': ppKey }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
      res => { let t = ''; res.setEncoding('utf8'); res.on('data', d => { t += d; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j }); }); });
    q.on('error', reject); q.end(data);
  });
  const ping = await pageCall('GET', '/api/people/ping');
  const saved = await pageCall('PUT', '/api/people/data', { app: 'people-portfolio', version: 1, exportedAt: new Date().toISOString(), labelGroups: [], labels: [], people: [{ id: 'a', name: 'Asha' }] });
  const loaded = await pageCall('GET', '/api/people/data');
  const elsewhere = await pageCall('GET', '/api/people/ping', null, 'http://some-other-site.example');
  check('Settings → People Portfolio: folder, address and a key shown once; with it the page saves and loads, and another site is refused',
    ppKey && /A key is set/.test(ppState || '') && ping.json && ping.json.ok && saved.status === 201 && loaded.json && loaded.json.people[0].name === 'Asha' && elsewhere.status === 403
      && fs.readdirSync(path.join(tmp, 'share', 'Backups', 'People')).length === 1,
    `ping ${ping.status}, save ${saved.status} ${saved.json && saved.json.name}, load ${loaded.status}, other site ${elsewhere.status}`);

  // 4. The master sets Priya's password.
  await ev(`location.hash = '#/dashboard'; return 1`);
  await waitFor(`document.querySelector('[data-setpass]')`, 15000);
  await ev(`document.querySelector('[data-setpass]').click(); return 1`);
  await waitFor(`document.querySelector('#sp-pass')`);
  await fill('#sp-pass', 'river77');
  await ev(`[...document.querySelectorAll('.dialog-actions .btn')].find(b => b.textContent === 'Set password').click(); return 1`);
  await sleep(1200);
  const asPriya = await new Promise(resolve => { const d = Buffer.from(JSON.stringify({ mode: 'device', username: 'priya.k@example.com', password: 'river77' }));
    const q = http.request({ host: '127.0.0.1', port: HTTP_PORT, path: '/api/session', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': d.length } }, res => { res.resume(); resolve(res.statusCode); }); q.end(d); });
  check('the master’s Set password works (Priya signs in with it)', asPriya === 200, `sign-in ${asPriya}`);

  // 5. Forgot password: the link arrives, the reset page sets a new one, sign-in follows.
  await signOut();
  await waitFor(`location.hash === '#/login' && document.querySelector('#lg-forgot')`, 20000);
  await ev(`document.querySelector('#lg-forgot').click(); return 1`);
  await waitFor(`location.hash === '#/forgot' && document.querySelector('#fg-login')`);
  await fill('#fg-login', 'Priya.K@example.com'); await submit();
  const sent = await waitFor(`/Check your email/.test(document.querySelector('.login-card').textContent) && document.querySelector('.login-card .banner').textContent.trim()`);
  const mail = await (async () => { for (let i = 0; i < 40; i++) { const m = inbox.find(x => x.to.toLowerCase() === 'priya.k@example.com'); if (m) return m; await sleep(250); } return null; })();
  const link = mail && (/(https?:\/\/\S+#\/reset\?token=\S+)/.exec(mail.text) || [])[1];
  check('Forgot password: “check your email”, and the reset link arrives at the account’s address', sent && link, `${sent} | ${link ? link.replace(/token=.*/, 'token=…') : 'no link'}`);
  await send('Page.navigate', { url: link });
  await waitFor(`location.hash.startsWith('#/reset') && document.querySelector('#rs-pass')`, 15000);
  await fill('#rs-pass', 'meadow99'); await fill('#rs-pass2', 'meadow99'); await submit();
  const back = await waitFor(`location.hash === '#/login' && JSON.stringify({ user: document.querySelector('#lg-user').value, note: (document.querySelector('.login-card .banner') || {}).textContent })`);
  const b = back ? JSON.parse(back) : {};
  await fill('#lg-pass', 'meadow99'); await submit();
  const inAs = await waitFor(`location.hash === '#/files' && 'in'`, 15000);
  check('the link’s page sets a new password; sign-in follows with the username filled in, and works', b.user && /changed/i.test(b.note || '') && inAs === 'in', `${back} → ${inAs}`);
  await send('Page.navigate', { url: link });
  await waitFor(`document.querySelector('#rs-pass')`, 15000);
  await fill('#rs-pass', 'another11'); await fill('#rs-pass2', 'another11'); await submit();
  const reused = await waitFor(`document.querySelector('#rs-error') && document.querySelector('#rs-error').textContent.trim()`);
  const reusedLink = await ev(`return !!document.querySelector('#rs-error a[href="#/forgot"]')`);
  check('the same link can’t be used twice (and links to a new one)', reused && reusedLink === true, reused);
} catch (e) {
  check('the test ran to the end', false, e.stack);
} finally {
  try { ws.close(); } catch {} try { phone.kill(); } catch {} try { server.kill(); } catch {} try { smtp.server.close(); } catch {}
  await sleep(500);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
