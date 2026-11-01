// Pairing tests (Phase 2, milestone 2-2, D-02 and D-11): only devices the master approved can use the HP.
// Requests from 127.0.0.1 are the HP itself; other loopback addresses (127.0.0.2 and up) stand in for
// other machines on the network. Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');

const PORT = 23000 + Math.floor(Math.random() * 1000);
const MASTER = { displayName: 'Sanketh', username: 'sanketh', password: 'master-pass-1' };
let tmp, server;

function start(env, configExtra) {
  if (configExtra) writeConfig(configExtra);
  const s = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'),
      ATTIC_PORT: String(PORT), ATTIC_DISCOVERY_PORT: '0' }, env),
    stdio: ['ignore', 'pipe', 'inherit']
  });
  let out = '';
  return new Promise((resolve, reject) => {
    s.stdout.on('data', d => { out += d; if (out.includes('Shares:')) resolve({ s, out }); });
    s.on('exit', code => reject(new Error('server exited ' + code)));
  });
}
const stop = s => new Promise(r => { s.removeAllListeners('exit'); if (s.exitCode !== null) return r(); s.on('exit', r); s.kill(); });
function writeConfig(extra) {
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(Object.assign({ host: '127.0.0.1',
    shares: [{ id: 'main', name: 'Main', rootPath: path.join(tmp, 'share') }] }, extra)));
}

// A client is one machine (a source address) with its own cookie jar.
function client(from, port = PORT) {
  const jar = {};
  const c = {
    jar,
    async call(method, url, { body, headers = {}, cookies = true } = {}) {
      // Like the interface: every write is JSON, a DELETE included.
      if (body === undefined && method !== 'GET' && method !== 'HEAD') body = {};
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const h = Object.assign({}, headers);
      if (data) Object.assign(h, { 'Content-Type': 'application/json', 'Content-Length': data.length });
      const cookie = Object.entries(cookies === true ? jar : cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookie) h.Cookie = cookie;
      const res = await new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port, localAddress: from, method, path: url, headers: h }, resolve);
        r.on('error', reject);
        r.end(data);
      });
      let text = '';
      for await (const chunk of res) text += chunk;
      const setCookies = res.headers['set-cookie'] || [];
      // A probe with hand-picked cookies leaves the jar alone.
      if (cookies === true) for (const sc of setCookies) {
        const [pair] = sc.split(';'), i = pair.indexOf('=');
        const k = pair.slice(0, i), v = pair.slice(i + 1);
        if (/Max-Age=0/.test(sc)) delete jar[k]; else jar[k] = v;
      }
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
      return { status: res.statusCode, json, text, setCookies };
    },
    signIn(creds, mode = 'master') { return c.call('POST', '/api/session', { body: Object.assign({ mode, stay: false }, creds) }); }
  };
  return c;
}

let hp, acer, ally, codeFor;

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-pair-'));
  fs.mkdirSync(path.join(tmp, 'share'));
  writeConfig({});
  server = (await start()).s;
  hp = client('127.0.0.1');
  acer = client('127.0.0.2');
  ally = client('127.0.0.3');
  codeFor = async () => (await hp.call('POST', '/api/pairing/codes', { body: {} })).json;
});
test.after(async () => {
  if (server) await stop(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---------- an unpaired device ----------
test('an unpaired device can load the interface and ask about pairing, and nothing else', async () => {
  assert.strictEqual((await acer.call('GET', '/')).status, 200);
  assert.strictEqual((await acer.call('GET', '/api/hello')).status, 200);
  assert.deepStrictEqual((await acer.call('GET', '/api/pairing')).json, { required: true, paired: false, thisPC: false, device: null });
  for (const [m, url, body] of [['GET', '/api/setup'], ['POST', '/api/setup', MASTER], ['GET', '/api/session'], ['POST', '/api/session', Object.assign({ mode: 'master' }, MASTER)],
    ['GET', '/api/shares'], ['GET', '/api/files'], ['GET', '/api/shares/main/folder'], ['GET', '/api/devices'], ['GET', '/api/accounts'], ['POST', '/api/pairing/codes', {}]]) {
    const r = await acer.call(m, url, { body });
    assert.strictEqual(r.status, 403, `${m} ${url}`);
    assert.strictEqual(r.json.code, 'NOT_PAIRED', `${m} ${url}`);
  }
});

test('the HP itself needs no pairing: setup and sign-in work there', async () => {
  assert.deepStrictEqual((await hp.call('GET', '/api/pairing')).json.thisPC, true);
  assert.strictEqual((await hp.call('POST', '/api/setup', { body: MASTER })).status, 201);
  const r = await hp.signIn(MASTER);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.session.deviceId, 'server');
  assert.strictEqual((await hp.call('POST', '/api/pairing/claim', { body: { code: '000000', name: 'HP' } })).json.code, 'ALREADY_PAIRED');
});

// ---------- pairing ----------
test('the master issues a six-digit code that lasts 10 minutes', async () => {
  const c = await codeFor();
  assert.match(c.code, /^\d{6}$/);
  const ttl = Date.parse(c.expiresAt) - Date.parse(c.issuedAt);
  assert.strictEqual(ttl, 10 * 60e3);
  assert.ok((await hp.call('GET', '/api/pairing/codes')).json.some(x => x.id === c.id));
  assert.strictEqual((await hp.call('DELETE', '/api/pairing/codes/' + c.id)).status, 200);
  assert.ok(!(await hp.call('GET', '/api/pairing/codes')).json.some(x => x.id === c.id), 'cancelled');
  assert.strictEqual((await acer.call('POST', '/api/pairing/claim', { body: { code: c.code, name: 'Acer' } })).json.code, 'BAD_CODE', 'a cancelled code is dead');
});

test('a device pairs with the code once; the token goes only into an HttpOnly cookie', async () => {
  const c = await codeFor();
  assert.strictEqual((await acer.call('POST', '/api/pairing/claim', { body: { code: '999999' === c.code ? '000000' : '999999', name: 'Acer' } })).json.code, 'BAD_CODE');
  assert.strictEqual((await acer.call('POST', '/api/pairing/claim', { body: { code: c.code } })).json.code, 'INVALID', 'a name is required');
  const spaced = c.code.slice(0, 3) + ' ' + c.code.slice(3);
  const r = await acer.call('POST', '/api/pairing/claim', { body: { code: spaced, name: 'Acer Aspire 5', kind: 'laptop', os: 'Windows 11 Home' } });
  assert.strictEqual(r.status, 201);
  assert.match(r.json.device.id, /^dev_/);
  assert.ok(!/token/i.test(r.text), 'no token in the body');
  const sc = r.setCookies.find(x => x.startsWith('attic_device='));
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Max-Age=\d{7,}/);
  // Used once: the same code can't pair a second device.
  assert.strictEqual((await ally.call('POST', '/api/pairing/claim', { body: { code: c.code, name: 'Ally' } })).json.code, 'BAD_CODE');
  assert.deepStrictEqual((await acer.call('GET', '/api/pairing')).json, { required: true, paired: true, thisPC: false, device: { id: r.json.device.id, name: 'Acer Aspire 5', kind: 'laptop' } });
  assert.strictEqual((await acer.call('POST', '/api/pairing/claim', { body: { code: c.code, name: 'Again' } })).json.code, 'ALREADY_PAIRED');
});

test('once paired, the device can sign in and use the HP; the device list marks it', async () => {
  assert.strictEqual((await acer.call('GET', '/api/setup')).status, 200);
  const r = await acer.signIn(MASTER);
  assert.strictEqual(r.status, 200);
  assert.ok(r.setCookies.some(x => x.startsWith('attic_device=')), 'signing in renews the device cookie');
  assert.strictEqual((await acer.call('GET', '/api/shares')).status, 200);
  const list = (await acer.call('GET', '/api/devices')).json;
  const me = list.find(d => d.thisPC);
  assert.strictEqual(me.name, 'Acer Aspire 5');
  assert.strictEqual(me.role, 'client');
  assert.strictEqual(me.online, true);
  assert.strictEqual(me.lastAddress, '127.0.0.2', 'the master sees where it was last seen');
  const hpEntry = list.find(d => d.role === 'server');
  assert.strictEqual(hpEntry.name, os.hostname());
  assert.strictEqual(hpEntry.online, true);
});

test('another account sees the devices but not when, by whom or from where they were paired', async () => {
  assert.strictEqual((await hp.call('POST', '/api/accounts', { body: { displayName: 'Guest', username: 'guest', password: 'guest-pass-1', deviceType: 'laptop' } })).status, 201);
  const guest = client('127.0.0.2');
  Object.assign(guest.jar, { attic_device: acer.jar.attic_device });
  assert.strictEqual((await guest.signIn({ username: 'guest', password: 'guest-pass-1' }, 'device')).status, 200);
  const list = (await guest.call('GET', '/api/devices')).json;
  assert.ok(list.length >= 2);
  for (const d of list) for (const k of ['pairedAt', 'pairedBy', 'lastAddress']) assert.ok(!(k in d), k);
  assert.strictEqual((await guest.call('POST', '/api/pairing/codes', { body: {} })).json.code, 'FORBIDDEN');
  assert.strictEqual((await guest.call('GET', '/api/pairing/codes')).json.code, 'FORBIDDEN');
  assert.strictEqual((await guest.call('DELETE', '/api/devices/' + list.find(d => d.thisPC).id)).json.code, 'FORBIDDEN');
});

test('the desktop tool may send its device token as a header instead of a cookie', async () => {
  const tool = client('127.0.0.2');
  const r = await tool.call('GET', '/api/pairing', { cookies: {}, headers: { 'X-Attic-Device': decodeURIComponent(acer.jar.attic_device) } });
  assert.strictEqual(r.json.paired, true);
  assert.strictEqual((await tool.call('GET', '/api/pairing', { cookies: {}, headers: { 'X-Attic-Device': 'made-up-token' } })).json.paired, false);
});

// ---------- every request carries both identities ----------
test('a session works only on the device it was signed in on', async () => {
  const session = acer.jar.attic_session;
  // The same session cookie, sent from the HP or with no device: refused.
  assert.strictEqual((await hp.call('GET', '/api/shares', { cookies: { attic_session: session } })).status, 401);
  assert.strictEqual((await ally.call('GET', '/api/shares', { cookies: { attic_session: session } })).json.code, 'NOT_PAIRED');
  // Pair the Ally, then try the Acer's session with the Ally's device: still refused.
  const c = await codeFor();
  assert.strictEqual((await ally.call('POST', '/api/pairing/claim', { body: { code: c.code, name: 'ROG Ally', kind: 'handheld' } })).status, 201);
  assert.strictEqual((await ally.call('GET', '/api/shares', { cookies: { attic_session: session, attic_device: ally.jar.attic_device } })).status, 401);
  // The Acer itself, with both, is fine.
  assert.strictEqual((await acer.call('GET', '/api/shares')).status, 200);
});

// ---------- guessing ----------
test('wrong codes are limited per address', async () => {
  const guesser = client('127.0.0.4');
  const c = await codeFor();
  const wrong = String((Number(c.code) + 1) % 1e6).padStart(6, '0');
  for (let i = 0; i < 5; i++) assert.strictEqual((await guesser.call('POST', '/api/pairing/claim', { body: { code: wrong, name: 'X' } })).json.code, 'BAD_CODE');
  const r = await guesser.call('POST', '/api/pairing/claim', { body: { code: c.code, name: 'X' } });
  assert.strictEqual(r.status, 429, 'even the right code is refused once locked out');
  assert.strictEqual((await hp.call('DELETE', '/api/pairing/codes/' + c.id)).status, 200, 'and the code was not used');
});

test('too many wrong codes from anywhere cancel every outstanding code', async () => {
  const c = await codeFor();
  const wrong = String((Number(c.code) + 1) % 1e6).padStart(6, '0');
  for (let a = 5; a < 9; a++) {
    const g = client('127.0.0.' + a);
    for (let i = 0; i < 5; i++) await g.call('POST', '/api/pairing/claim', { body: { code: wrong, name: 'X' } });
  }
  assert.deepStrictEqual((await hp.call('GET', '/api/pairing/codes')).json, []);
  assert.strictEqual((await client('127.0.0.9').call('POST', '/api/pairing/claim', { body: { code: c.code, name: 'X' } })).json.code, 'BAD_CODE');
});

test('at most five codes wait at once', async () => {
  for (const c of (await hp.call('GET', '/api/pairing/codes')).json) await hp.call('DELETE', '/api/pairing/codes/' + c.id);
  for (let i = 0; i < 5; i++) assert.strictEqual((await hp.call('POST', '/api/pairing/codes', { body: {} })).status, 201);
  assert.strictEqual((await hp.call('POST', '/api/pairing/codes', { body: {} })).json.code, 'TOO_MANY_CODES');
  for (const c of (await hp.call('GET', '/api/pairing/codes')).json) await hp.call('DELETE', '/api/pairing/codes/' + c.id);
});

// ---------- restart ----------
test('pairings survive a restart; outstanding codes don\'t', async () => {
  const c = await codeFor();
  await stop(server);
  server = (await start()).s;
  assert.strictEqual((await acer.call('GET', '/api/pairing')).json.paired, true);
  assert.strictEqual((await acer.call('GET', '/api/shares')).status, 200, 'still signed in, too');
  assert.match((await start({ ATTIC_PORT: String(PORT + 3) }).then(async o => { await stop(o.s); return o.out; })), /Pairing:\s+required \(2 paired devices; this PC is trusted\)/);
  await hp.signIn(MASTER);
  assert.deepStrictEqual((await hp.call('GET', '/api/pairing/codes')).json, []);
  assert.strictEqual((await client('127.0.0.10').call('POST', '/api/pairing/claim', { body: { code: c.code, name: 'X' } })).json.code, 'BAD_CODE');
});

// ---------- unpairing ----------
test('unpairing locks the device out at once and signs out everyone on it', async () => {
  const id = (await acer.call('GET', '/api/pairing')).json.device.id;
  assert.strictEqual((await hp.call('DELETE', '/api/devices/server')).json.code, 'INVALID', 'the HP can\'t be unpaired');
  const r = await hp.call('DELETE', '/api/devices/' + id);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await acer.call('GET', '/api/shares')).json.code, 'NOT_PAIRED');
  assert.ok(!(await hp.call('GET', '/api/devices')).json.some(d => d.id === id));
  // Its stale token is cleared from the browser, and its sessions are gone from the HP for good.
  const p = await acer.call('GET', '/api/pairing');
  assert.strictEqual(p.json.paired, false);
  assert.ok(p.setCookies.some(x => /^attic_device=;.*Max-Age=0/.test(x)));
  const sessions = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'sessions.json'), 'utf8'));
  assert.ok(!Object.values(sessions).some(s => s.deviceId === id));
  assert.strictEqual((await hp.call('DELETE', '/api/devices/' + id)).json.code, 'NOT_FOUND');
  // It can pair again with a new code.
  const c = await codeFor();
  assert.strictEqual((await acer.call('POST', '/api/pairing/claim', { body: { code: c.code, name: 'Acer again' } })).status, 201);
  assert.notStrictEqual((await acer.call('GET', '/api/pairing')).json.device.id, id, 'a new identity');
});

// ---------- settings ----------
test('with "trustThisPC": false even this PC has to pair', async () => {
  const o = await start({ ATTIC_PORT: String(PORT + 1), ATTIC_DATA: path.join(tmp, 'data-strict') }, { pairing: { trustThisPC: false } });
  try {
    assert.strictEqual((await client('127.0.0.1', PORT + 1).call('GET', '/api/setup')).json.code, 'NOT_PAIRED');
  } finally { await stop(o.s); writeConfig({}); }
});

test('with "required": false pairing is off, and the server says so', async () => {
  const o = await start({ ATTIC_PORT: String(PORT + 2), ATTIC_DATA: path.join(tmp, 'data-open') }, { pairing: { required: false } });
  try {
    assert.match(o.out, /Pairing:\s+OFF/);
    const c = client('127.0.0.11', PORT + 2);
    assert.deepStrictEqual((await c.call('GET', '/api/pairing')).json, { required: false, paired: false, thisPC: false, device: null });
    assert.strictEqual((await c.call('GET', '/api/setup')).status, 200);
  } finally { await stop(o.s); writeConfig({}); }
});
