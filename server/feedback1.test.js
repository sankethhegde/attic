// Feedback round 1 (server) tests: email addresses as usernames, forgot password by email, sign-up that
// the master approves, and sends relayed to the receiving device while they're still arriving.
// Email goes to a stand-in for Gmail: a little TLS SMTP server here, its certificate from the HP's own
// CA code (tls.js), trusted through ATTIC_MAIL_CA. The "Acer" is 127.0.0.2, the "ROG Ally" 127.0.0.3.
// Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const tlsMod = require('tls'), http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const { startServer, stopServer, client, wsOpen, patternBytes, shaOfPattern, sleep } = require('./test-util');
const { createTls } = require('./tls');

const PORT = 31000 + Math.floor(Math.random() * 1000);
const MASTER = { displayName: 'Sanketh', username: 'Sankethhegde4321@gmail.com', password: 'master-pass-1' };
const GMAIL = { user: 'attic.hub.home@gmail.com', appPassword: 'abcd efgh ijkl mnop' };
const MB = 1 << 20;
let tmp, server, env, hp, acer, ally, acerId, allyId, allyToken, smtp, inbox = [];

// ---------- a stand-in for Gmail's SMTP ----------
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
        if (inData) {
          if (line === '.') { inData = false; inbox.push(parse(data)); data = ''; say('250 OK queued'); } else data += line.replace(/^\./, '') + '\r\n';
          continue;
        }
        if (/^EHLO/i.test(line)) { sock.write('250-mail-test\r\n250 AUTH PLAIN\r\n'); continue; }
        if (/^AUTH PLAIN /i.test(line)) {
          const [, u, p] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\0');
          say(u === GMAIL.user && p === GMAIL.appPassword.replace(/\s/g, '') ? '235 Accepted' : '535 Bad credentials'); continue;
        }
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
function parse(raw) {
  const [head, body] = raw.split('\r\n\r\n');
  const h = {}; for (const l of head.split('\r\n')) { const i = l.indexOf(':'); h[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
  const subject = h.subject.startsWith('=?UTF-8?B?') ? Buffer.from(h.subject.slice(10, -2), 'base64').toString('utf8') : h.subject;
  return { to: h.to.replace(/[<>]/g, ''), from: h.from, subject, text: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') };
}
const linkIn = text => (/(https?:\/\/\S+#\/reset\?token=(\S+))/.exec(text) || []);

async function pair(c, name, kind) {
  const code = (await hp.call('POST', '/api/pairing/codes')).json.code;
  return (await c.call('POST', '/api/pairing/claim', { code, name, kind })).json.device.id;
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-fb1-'));
  fs.mkdirSync(path.join(tmp, 'share'));
  smtp = await startSmtp(path.join(tmp, 'smtp'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ host: '127.0.0.1', shares: [{ id: 'main', name: 'Main', rootPath: path.join(tmp, 'share') }] }));
  env = { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(PORT), ATTIC_MAIL_CA: smtp.caPath };
  server = await startServer(env);
  hp = client(PORT, '127.0.0.1');
  acer = client(PORT, '127.0.0.2');
  ally = client(PORT, '127.0.0.3');
});
test.after(async () => {
  if (server) await stopServer(server);
  if (smtp) smtp.server.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---------- email addresses as usernames ----------
test('an email address works as a username, matched without case, and becomes the account’s email', async () => {
  const r = await hp.call('POST', '/api/setup', MASTER);
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.email, MASTER.username);
  assert.strictEqual((await hp.call('POST', '/api/session', { mode: 'master', username: 'sankethhegde4321@GMAIL.com', password: MASTER.password })).status, 200);
  // A short username, with a separate email; signs in by either.
  const d = await hp.call('POST', '/api/accounts', { displayName: 'Ally', username: 'ally', email: 'Ally.Player@example.com', password: 'ally-pass-1', deviceType: 'laptop' });
  assert.strictEqual(d.status, 201);
  acerId = await pair(acer, 'Acer Aspire 5', 'laptop');
  for (const login of ['ally', 'ALLY', 'ally.player@example.com']) {
    const c = client(PORT, '127.0.0.2'); c.jar.attic_device = acer.jar.attic_device;
    assert.strictEqual((await c.call('POST', '/api/session', { mode: 'device', username: login, password: 'ally-pass-1' })).status, 200, login);
  }
  // One name space: no account's username or email may be another's.
  const taken = await hp.call('POST', '/api/accounts', { displayName: 'X', username: 'ally.player@example.com', password: 'x-pass-12' });
  assert.strictEqual(taken.json.code, 'TAKEN');
  assert.strictEqual((await hp.call('POST', '/api/accounts', { displayName: 'X', username: 'xx', password: 'x-pass-12' })).json.code, 'INVALID', 'too short');
  assert.strictEqual((await hp.call('POST', '/api/accounts', { displayName: 'X', username: 'a@b', password: 'x-pass-12' })).json.code, 'INVALID', 'not an email');
  assert.strictEqual((await hp.call('POST', '/api/accounts', { displayName: 'X', username: 'x'.repeat(250) + '@example.com', password: 'x-pass-12' })).json.code, 'INVALID', 'over 254');
  // The email can be changed by its owner (here, the master for anyone).
  const id = d.json.id;
  assert.strictEqual((await hp.call('PATCH', '/api/accounts/' + id, { email: 'ally@example.com' })).json.email, 'ally@example.com');
  assert.strictEqual((await hp.call('PATCH', '/api/accounts/' + id, { email: 'not-an-email' })).json.code, 'INVALID');
});

// ---------- forgot password ----------
test('without email set up, "forgot password" says to ask the master; the master can set anyone’s password', async () => {
  const r = (await acer.call('POST', '/api/password/forgot', { login: 'ally' })).json;
  assert.strictEqual(r.mail, false);
  assert.match(r.message, /Ask the master/);
  const ally1 = (await hp.call('GET', '/api/accounts')).json.find(a => a.username === 'ally');
  assert.strictEqual((await hp.call('POST', `/api/accounts/${ally1.id}/set-password`, { next: 'ally-pass-2' })).status, 200);
  const c = client(PORT, '127.0.0.2'); c.jar.attic_device = acer.jar.attic_device;
  assert.strictEqual((await c.call('POST', '/api/session', { mode: 'device', username: 'ally', password: 'ally-pass-1' })).json.code, 'BAD_CREDENTIALS');
  assert.strictEqual((await c.call('POST', '/api/session', { mode: 'device', username: 'ally', password: 'ally-pass-2' })).status, 200);
  assert.strictEqual((await hp.call('POST', '/api/accounts/acc_master/set-password', { next: 'whatever-1' })).json.code, 'INVALID', 'not your own this way');
  assert.strictEqual((await c.call('POST', `/api/accounts/${ally1.id}/set-password`, { next: 'whatever-1' })).json.code, 'FORBIDDEN', 'master only');
});

test('the master sets up Gmail: the app password is checked, kept, and never shown again', async () => {
  const bad = await hp.call('PUT', '/api/mail', { user: GMAIL.user, appPassword: 'wrong-password-x', host: 'localhost', port: smtp.port });
  assert.strictEqual(bad.json.code, 'MAIL_LOGIN');
  assert.strictEqual((await hp.call('GET', '/api/mail')).json.configured, false, 'not kept when Gmail refuses it');
  const ok = await hp.call('PUT', '/api/mail', { user: GMAIL.user, appPassword: GMAIL.appPassword, host: 'localhost', port: smtp.port });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  const info = (await hp.call('GET', '/api/mail')).json;
  assert.deepStrictEqual([info.configured, info.user], [true, GMAIL.user]);
  assert.ok(!JSON.stringify(info).includes('abcd'), 'no password in the answer');
  const c = client(PORT, '127.0.0.2'); c.jar.attic_device = acer.jar.attic_device;
  await c.call('POST', '/api/session', { mode: 'device', username: 'ally', password: 'ally-pass-2' });
  assert.strictEqual((await c.call('GET', '/api/mail')).json.code, 'FORBIDDEN');
  inbox = [];
  assert.strictEqual((await hp.call('POST', '/api/mail/test', {})).json.to, MASTER.username);
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].subject, 'Attic Hub email works');
  assert.match(inbox[0].from, /attic\.hub\.home@gmail\.com/);
  // It's kept out of Git: data/ is gitignored, and that's where it lives.
  assert.ok(fs.existsSync(path.join(tmp, 'data', 'mail.json')));
});

test('a reset link arrives by email, works once, for the address it was asked on, and signs the account out everywhere', async () => {
  inbox = [];
  const before = client(PORT, '127.0.0.2'); before.jar.attic_device = acer.jar.attic_device;
  await before.call('POST', '/api/session', { mode: 'device', username: 'ally', password: 'ally-pass-2' });
  const r = (await acer.call('POST', '/api/password/forgot', { login: 'ALLY@example.com' })).json;
  assert.strictEqual(r.ok, true);
  await sleep(300);
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].to, 'ally@example.com');
  const [, link, token] = linkIn(inbox[0].text);
  assert.ok(link.startsWith(`http://127.0.0.1:${PORT}/#/reset?token=`), link);
  assert.match(inbox[0].text, /30 minutes/);
  // Wrong token, then the right one, then the right one again.
  assert.strictEqual((await acer.call('POST', '/api/password/reset', { token: 'nope', next: 'ally-pass-3' })).json.code, 'BAD_TOKEN');
  const ok = await acer.call('POST', '/api/password/reset', { token: decodeURIComponent(token), next: 'ally-pass-3' });
  assert.strictEqual(ok.json.username, 'ally');
  assert.strictEqual((await acer.call('POST', '/api/password/reset', { token: decodeURIComponent(token), next: 'ally-pass-4' })).json.code, 'BAD_TOKEN', 'once only');
  assert.strictEqual((await before.call('GET', '/api/shares')).status, 401, 'signed out everywhere');
  const c = client(PORT, '127.0.0.2'); c.jar.attic_device = acer.jar.attic_device;
  assert.strictEqual((await c.call('POST', '/api/session', { mode: 'device', username: 'ally', password: 'ally-pass-3' })).status, 200);
  // A forged Host header can't point the link at another site.
  inbox = [];
  const forged = await new Promise(res => {
    const data = JSON.stringify({ login: 'ally' });
    const q = http.request({ host: '127.0.0.1', port: PORT, localAddress: '127.0.0.2', method: 'POST', path: '/api/password/forgot',
      headers: { Host: 'evil.example:80', Cookie: 'attic_device=' + acer.jar.attic_device, 'Content-Type': 'application/json', 'Content-Length': data.length } }, x => { x.resume(); x.on('end', res); });
    q.end(data);
  });
  await sleep(300);
  assert.ok(!linkIn(inbox[0].text)[0].includes('evil.example'), linkIn(inbox[0].text)[0]);
});

test('"forgot password" answers the same for accounts that don’t exist, and is rate-limited', async () => {
  inbox = [];
  const c = client(PORT, '127.0.0.4'); c.jar.attic_device = acer.jar.attic_device;
  const a = (await c.call('POST', '/api/password/forgot', { login: 'nobody@example.com' })).json;
  assert.strictEqual(a.message, 'If that account has an email address, a reset link is on its way. It works for 30 minutes.');
  await sleep(200);
  assert.strictEqual(inbox.length, 0);
  let last;
  for (let i = 0; i < 6; i++) last = await c.call('POST', '/api/password/forgot', { login: 'nobody' });
  assert.strictEqual(last.status, 429);
});

// ---------- sign-up ----------
test('anyone on a paired device can sign up; the account waits for the master, who is told', async () => {
  const master = await wsOpen(PORT, '127.0.0.1', { cookie: hp.cookieHeader() });
  await master.next('devices');
  const s = await acer.call('POST', '/api/signup', { displayName: 'Priya', username: 'priya@example.com', password: 'priya-pass-1', deviceType: 'phone' });
  assert.strictEqual(s.status, 201);
  assert.strictEqual(s.json.pending, true);
  assert.strictEqual(s.json.account.status, 'pending');
  const ev = (await master.next(m => m.type === 'event' && m.event.kind === 'account.signup')).event;
  assert.strictEqual(ev.title, 'New account waiting for approval');
  assert.strictEqual(ev.body, 'Priya (priya@example.com) signed up on Acer Aspire 5.');
  // It can't sign in yet; a wrong password still gets the generic answer.
  const c = client(PORT, '127.0.0.2'); c.jar.attic_device = acer.jar.attic_device;
  assert.strictEqual((await c.call('POST', '/api/session', { mode: 'device', username: 'priya@example.com', password: 'nope-nope-1' })).json.code, 'BAD_CREDENTIALS');
  assert.strictEqual((await c.call('POST', '/api/session', { mode: 'device', username: 'priya@example.com', password: 'priya-pass-1' })).json.code, 'PENDING');
  // The master approves; the device it signed up on is told; now it signs in.
  const agent = await wsOpen(PORT, '127.0.0.2', { query: '?role=agent', headers: { 'X-Attic-Device': decodeURIComponent(acer.jar.attic_device) } });
  await agent.next('hello');
  assert.strictEqual((await hp.call('POST', `/api/accounts/${s.json.account.id}/approve`)).json.status, 'active');
  assert.match((await agent.next(m => m.type === 'event' && m.event.kind === 'account.approved')).event.body, /Sign in as priya@example\.com/);
  assert.strictEqual((await c.call('POST', '/api/session', { mode: 'device', username: 'priya@example.com', password: 'priya-pass-1' })).status, 200);
  assert.strictEqual((await hp.call('POST', `/api/accounts/${s.json.account.id}/approve`)).status, 404, 'only a waiting one');
  // Declining removes the request.
  const s2 = (await acer.call('POST', '/api/signup', { displayName: 'Spam', username: 'spammer', password: 'spam-pass-1' })).json;
  assert.strictEqual((await hp.call('POST', `/api/accounts/${s2.account.id}/decline`)).status, 200);
  assert.ok(!(await hp.call('GET', '/api/accounts')).json.some(a => a.username === 'spammer'));
  master.close(); agent.close();
});

test('sign-up needs a paired device, a free name, and isn’t a flood', async () => {
  assert.strictEqual((await client(PORT, '127.0.0.9').call('POST', '/api/signup', { displayName: 'X', username: 'xyz', password: 'x-pass-12' })).json.code, 'NOT_PAIRED');
  assert.strictEqual((await acer.call('POST', '/api/signup', { displayName: 'X', username: 'ally', password: 'x-pass-12' })).json.code, 'TAKEN');
  assert.strictEqual((await acer.call('POST', '/api/signup', { displayName: 'X', username: 'priya@EXAMPLE.com', password: 'x-pass-12' })).json.code, 'TAKEN');
  // Five attempts an hour from one address (each costs a password hash); the Acer made four above.
  await acer.call('POST', '/api/signup', { displayName: 'Third', username: 'third', password: 'third-pass-1' });
  assert.strictEqual((await acer.call('POST', '/api/signup', { displayName: 'Fourth', username: 'fourth', password: 'fourth-pass' })).status, 429);
});

// ---------- relaying sends ----------
test('a send reaches the receiving device while it’s still arriving at the HP, not after', async () => {
  allyId = await pair(ally, 'ASUS ROG Ally', 'handheld');
  allyToken = decodeURIComponent(ally.jar.attic_device);
  await acer.call('POST', '/api/session', { mode: 'master', username: MASTER.username, password: MASTER.password });
  const agent = await wsOpen(PORT, '127.0.0.3', { query: '?role=agent', headers: { 'X-Attic-Device': allyToken } });
  await agent.next('hello'); await agent.next('inbox');
  const size = 8 * MB;
  const t = (await acer.call('POST', '/api/transfers', { to: allyId, fileName: 'Live.mov', size })).json;
  // The sender sends a megabyte every 0.4 s: about 3 s in all.
  const t0 = Date.now();
  let upDoneAt = 0;
  const up = acer.upload(`/api/transfers/${t.id}/file`, size, { chunkDelay: 400 }).then(r => { upDoneAt = Date.now(); return r; });
  // The agent hears about it as soon as the upload starts, and starts fetching.
  const note = (await agent.next(m => m.type === 'transfer' && m.transfer.id === t.id, 3000)).transfer;
  assert.deepStrictEqual([note.status, note.stage], ['active', 'upload']);
  let firstByteAt = 0;
  const down = new Promise((resolve, reject) => {
    const q = http.get({ host: '127.0.0.1', port: PORT, localAddress: '127.0.0.3', path: `/api/transfers/${t.id}/file`, headers: { 'X-Attic-Device': allyToken } }, res => {
      const h = require('crypto').createHash('sha256'); let n = 0;
      res.on('data', d => { if (!firstByteAt) firstByteAt = Date.now(); n += d.length; h.update(d); });
      res.on('end', () => resolve({ status: res.statusCode, n, sha: h.digest('hex'), endAt: Date.now() }));
      res.on('error', reject);
    });
    q.on('error', reject);
  });
  const [u, d] = await Promise.all([up, down]);
  assert.strictEqual(u.status, 200);
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.n, size);
  assert.strictEqual(d.sha, u.sha, 'the same bytes');
  assert.ok(firstByteAt < upDoneAt - 1500, `the download started ${upDoneAt - firstByteAt} ms before the upload ended`);
  assert.ok(d.endAt - upDoneAt < 1500, `and finished ${d.endAt - upDoneAt} ms after it`);
  assert.strictEqual(u.json.status, 'active', 'mid-delivery, not back in the queue');
  assert.strictEqual(u.json.stage, 'deliver');
  const done = await ally.call('POST', `/api/transfers/${t.id}/received`, {}, { 'X-Attic-Device': allyToken });
  assert.strictEqual(done.json.status, 'done');
  console.log(`    relay: 8 MB sent over ${((upDoneAt - t0) / 1000).toFixed(1)} s; first bytes at the receiver after ${((firstByteAt - t0) / 1000).toFixed(1)} s; done ${d.endAt - upDoneAt} ms after the upload`);
  agent.close();
});

test('a relayed resumable send arrives whole, and a cut-off upload cuts the relay off too', async () => {
  // Resumable: pieces, with the receiver following.
  const size = 6 * MB + 5;
  const t = (await acer.call('POST', '/api/transfers', { to: allyId, fileName: 'Pieces.mov', size })).json;
  const s = (await acer.call('POST', '/api/uploads', { transferId: t.id })).json;
  await acer.upload(`/api/uploads/${s.id}?offset=0`, 2 * MB, { gen: (o, n) => patternBytes(o, n) });
  const down = ally.download(`/api/transfers/${t.id}/file`, { 'X-Attic-Device': allyToken });
  await sleep(300);
  await acer.upload(`/api/uploads/${s.id}?offset=${2 * MB}`, 4 * MB + 5, { gen: (o, n) => patternBytes(2 * MB + o, n) });
  const d = await down;
  assert.strictEqual(d.sha, shaOfPattern(size));
  assert.strictEqual((await ally.call('POST', `/api/transfers/${t.id}/received`, {}, { 'X-Attic-Device': allyToken })).json.status, 'done');
  // Cut off: the sender's connection drops; the receiver's download stops, and the transfer is gone for it.
  const t2 = (await acer.call('POST', '/api/transfers', { to: allyId, fileName: 'Cut.mov', size: 8 * MB })).json;
  acer.upload(`/api/transfers/${t2.id}/file`, 8 * MB, { abortAfter: 2 * MB }).catch(() => {});
  await sleep(150);
  const cut = await ally.download(`/api/transfers/${t2.id}/file`, { 'X-Attic-Device': allyToken }).catch(e => ({ error: e }));
  assert.ok(cut.error || cut.bytes < 8 * MB, 'the relay doesn’t pretend to finish');
  await sleep(300);
  assert.strictEqual((await ally.download(`/api/transfers/${t2.id}/file`, { 'X-Attic-Device': allyToken })).status, 404);
});
