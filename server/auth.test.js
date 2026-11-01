// Login and session tests (Phase 1C, milestone 3). Starts a real server on a throwaway config and data
// folder, then drives it over HTTP. Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const MASTER = { displayName: 'Test Master', username: 'master', password: 'correct-horse' };
const DEVICE = { displayName: 'Test phone', username: 'testphone', password: 'device-pass', deviceType: 'phone' };

let server, tmp;

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-test-'));
  fs.mkdirSync(path.join(tmp, 'share'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ host: '127.0.0.1',
    shares: [{ id: 'main', name: 'Main', rootPath: path.join(tmp, 'share') }, { id: 'gone', name: 'Gone', rootPath: path.join(tmp, 'missing') }] }));
  server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(PORT), ATTIC_DISCOVERY_PORT: '0' }),
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('Shares:')) resolve(); });
    server.on('exit', code => reject(new Error('server exited ' + code)));
  });
});
test.after(async () => {
  if (server && server.exitCode === null) await new Promise(r => { server.on('exit', r); server.kill(); });
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// A tiny client that keeps one cookie, like a browser tab.
function client() {
  let cookie = null;
  return async function call(method, url, body, headers) {
    const h = Object.assign({}, headers);
    if (cookie) h.Cookie = cookie;
    if (body !== undefined) h['Content-Type'] = h['Content-Type'] || 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? null : v; }
    return { status: res.status, body: await res.json().catch(() => null), setCookie: set };
  };
}

test('fresh server needs setup and refuses everything else', async () => {
  const c = client();
  assert.deepStrictEqual((await c('GET', '/api/setup')).body, { needsSetup: true });
  assert.strictEqual((await c('GET', '/api/shares')).status, 401);
  assert.strictEqual((await c('GET', '/api/accounts')).status, 401);
});

test('setup creates the master once, with the password stored only as a hash', async () => {
  const c = client();
  const r = await c('POST', '/api/setup', MASTER);
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.username, 'master');
  assert.ok(!('passwordHash' in r.body));
  assert.strictEqual((await c('POST', '/api/setup', MASTER)).status, 409);
  assert.deepStrictEqual((await c('GET', '/api/setup')).body, { needsSetup: false });
  const stored = fs.readFileSync(path.join(tmp, 'data', 'accounts.json'), 'utf8');
  assert.ok(!stored.includes(MASTER.password), 'plaintext password on disk');
  assert.match(stored, /"passwordHash": "scrypt\$/);
});

test('wrong password and unknown user get the same generic answer', async () => {
  const c = client();
  const a = await c('POST', '/api/session', { mode: 'master', username: 'master', password: 'nope-nope' });
  const b = await c('POST', '/api/session', { mode: 'master', username: 'nobody', password: 'nope-nope' });
  const d = await c('POST', '/api/session', { mode: 'device', username: 'master', password: MASTER.password }); // right password, wrong door
  for (const r of [a, b, d]) {
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.message, 'Incorrect username or password');
  }
});

test('master signs in with an HttpOnly, SameSite=Strict cookie and sees real share figures', async () => {
  const c = client();
  const r = await c('POST', '/api/session', { mode: 'master', username: 'MASTER', password: MASTER.password, stay: true });
  assert.strictEqual(r.status, 200);
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /SameSite=Strict/);
  assert.match(r.setCookie, /Max-Age=2592000/); // 30 days
  assert.strictEqual(r.body.session.type, 'master');
  assert.ok(!('token' in r.body));
  assert.strictEqual((await c('GET', '/api/session')).body.account.username, 'master');
  const shares = (await c('GET', '/api/shares')).body;
  assert.ok(shares.find(s => s.id === 'main').total > 0);
  assert.strictEqual(shares.find(s => s.id === 'gone').available, false);
});

test('without "Stay signed in" the cookie ends with the browser', async () => {
  const r = await client()('POST', '/api/session', { mode: 'master', username: 'master', password: MASTER.password });
  assert.ok(!/Max-Age/.test(r.setCookie));
});

test('a forged or stale cookie is refused', async () => {
  const r = await fetch(BASE + '/api/shares', { headers: { Cookie: 'attic_session=forged-token' } });
  assert.strictEqual(r.status, 401);
});

test('writes must be same-origin JSON', async () => {
  const form = await fetch(BASE + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=master' });
  assert.strictEqual(form.status, 415);
  const cross = await fetch(BASE + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
  assert.strictEqual(cross.status, 403);
});

test('device accounts: master creates, device signs in, sees no capacity, cannot manage', async () => {
  const m = client();
  await m('POST', '/api/session', { mode: 'master', username: 'master', password: MASTER.password });
  const created = await m('POST', '/api/accounts', DEVICE);
  assert.strictEqual(created.status, 201);
  assert.strictEqual((await m('POST', '/api/accounts', DEVICE)).status, 409); // username taken
  assert.strictEqual((await m('POST', '/api/accounts', Object.assign({}, DEVICE, { username: 'x', password: 'short' }))).status, 400);

  const d = client();
  assert.strictEqual((await d('POST', '/api/session', { mode: 'device', username: DEVICE.username, password: DEVICE.password })).status, 200);
  const shares = (await d('GET', '/api/shares')).body;
  assert.strictEqual(shares.find(s => s.id === 'main').total, null);
  assert.strictEqual(shares.find(s => s.id === 'main').free, null);
  assert.strictEqual((await d('GET', '/api/accounts')).status, 403);
  assert.strictEqual((await d('POST', '/api/accounts', { displayName: 'x', username: 'xxx', password: 'yyyyyy' })).status, 403);
  assert.strictEqual((await d('POST', `/api/accounts/${created.body.id}/revoke`, {})).status, 403);
});

test('revoking a device ends its sessions at once; restoring lets it sign in again', async () => {
  const m = client();
  await m('POST', '/api/session', { mode: 'master', username: 'master', password: MASTER.password });
  const id = (await m('GET', '/api/accounts')).body.find(a => a.username === DEVICE.username).id;
  const d = client();
  await d('POST', '/api/session', { mode: 'device', username: DEVICE.username, password: DEVICE.password });
  assert.strictEqual((await d('GET', '/api/shares')).status, 200);

  assert.strictEqual((await m('POST', `/api/accounts/${id}/revoke`, {})).body.account.status, 'revoked');
  assert.strictEqual((await d('GET', '/api/shares')).status, 401);
  const again = await client()('POST', '/api/session', { mode: 'device', username: DEVICE.username, password: DEVICE.password });
  assert.strictEqual(again.body.code, 'REVOKED');
  // A revoked account with the wrong password is still just "incorrect": revocation isn't probeable.
  const probe = await client()('POST', '/api/session', { mode: 'device', username: DEVICE.username, password: 'wrong-pass' });
  assert.strictEqual(probe.body.message, 'Incorrect username or password');

  await m('POST', `/api/accounts/${id}/restore`, {});
  assert.strictEqual((await client()('POST', '/api/session', { mode: 'device', username: DEVICE.username, password: DEVICE.password })).status, 200);
});

test('changing a password keeps this session and ends the others', async () => {
  const a = client(), b = client();
  await a('POST', '/api/session', { mode: 'device', username: DEVICE.username, password: DEVICE.password });
  const me = (await b('POST', '/api/session', { mode: 'device', username: DEVICE.username, password: DEVICE.password })).body.account;
  assert.strictEqual((await a('POST', `/api/accounts/${me.id}/password`, { current: 'wrong', next: 'new-device-pass' })).status, 400);
  assert.strictEqual((await a('POST', `/api/accounts/${me.id}/password`, { current: DEVICE.password, next: 'new-device-pass' })).status, 200);
  assert.strictEqual((await a('GET', '/api/shares')).status, 200);
  assert.strictEqual((await b('GET', '/api/shares')).status, 401);
  assert.strictEqual((await client()('POST', '/api/session', { mode: 'device', username: DEVICE.username, password: 'new-device-pass' })).status, 200);
  DEVICE.password = 'new-device-pass';
});

test('signing out ends the session on the server, not just in the browser', async () => {
  const c = client();
  await c('POST', '/api/session', { mode: 'master', username: 'master', password: MASTER.password });
  const raw = fs.readFileSync(path.join(tmp, 'data', 'sessions.json'), 'utf8');
  assert.ok(!raw.includes('attic_session'));
  const before = Object.keys(JSON.parse(raw)).length;
  await c('DELETE', '/api/session', {});
  assert.strictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'sessions.json'), 'utf8'))).length, before - 1);
  assert.strictEqual((await c('GET', '/api/shares')).status, 401);
});

test('the master account cannot be deleted', async () => {
  const m = client();
  await m('POST', '/api/session', { mode: 'master', username: 'master', password: MASTER.password });
  assert.strictEqual((await m('POST', '/api/accounts/acc_master/remove', {})).status, 404); // not a device
});

// Last: it locks this address out for 15 minutes.
test('five wrong passwords lock the address out, even for the right password', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) assert.strictEqual((await c('POST', '/api/session', { mode: 'master', username: 'master', password: 'guess-' + i })).status, 401);
  const r = await c('POST', '/api/session', { mode: 'master', username: 'master', password: MASTER.password });
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.body.code, 'TOO_MANY_ATTEMPTS');
});
