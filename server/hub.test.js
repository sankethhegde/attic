// Live hub tests (Phase 2, milestone 2-3, D-03 and D-04): agents report stats over a WebSocket, the master
// sees them within seconds, everyone else sees only who is online. 127.0.0.1 is the HP; 127.0.0.2 and up
// are other machines (as in pairing.test.js). Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs'), os = require('os'), path = require('path');
const { encode, createParser, OP } = require('./ws');

const PORT = 24000 + Math.floor(Math.random() * 1000);
const MASTER = { displayName: 'Sanketh', username: 'sanketh', password: 'master-pass-1' };
const GUEST = { displayName: 'Guest', username: 'guest', password: 'guest-pass-1', deviceType: 'laptop' };
const STATS = { cpu: 22, ramTotal: 8e9, ramUsed: 5.6e9, diskTotal: 512e9, diskFree: 188e9, battery: 78, charging: false };
let tmp, server;

function start() {
  const s = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'),
      ATTIC_PORT: String(PORT), ATTIC_DISCOVERY_PORT: '0' }),
    stdio: ['ignore', 'pipe', 'inherit']
  });
  let out = '';
  return new Promise((resolve, reject) => {
    s.stdout.on('data', d => { out += d; if (out.includes('Shares:')) resolve(s); });
    s.on('exit', code => reject(new Error('server exited ' + code)));
  });
}
const stop = s => new Promise(r => { s.removeAllListeners('exit'); if (s.exitCode !== null) return r(); s.on('exit', r); s.kill(); });

// ---------- HTTP, one machine per source address with its own cookies ----------
function client(from) {
  const jar = {};
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    jar, from, cookieHeader,
    async call(method, url, body) {
      if (body === undefined && method !== 'GET') body = {};
      const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const h = {};
      if (data) Object.assign(h, { 'Content-Type': 'application/json', 'Content-Length': data.length });
      if (cookieHeader()) h.Cookie = cookieHeader();
      const res = await new Promise((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port: PORT, localAddress: from, method, path: url, headers: h }, resolve);
        r.on('error', reject); r.end(data);
      });
      let text = '';
      for await (const c of res) text += c;
      for (const sc of res.headers['set-cookie'] || []) {
        const [pair] = sc.split(';'), i = pair.indexOf('=');
        if (/Max-Age=0/.test(sc)) delete jar[pair.slice(0, i)]; else jar[pair.slice(0, i)] = pair.slice(i + 1);
      }
      return { status: res.statusCode, json: text ? JSON.parse(text) : null };
    }
  };
}

// ---------- a WebSocket client, raw, so tests can also send what a real client never would ----------
function wsOpen(from, { query = '', cookie = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') }, headers);
    if (cookie) h.Cookie = cookie;
    const req = http.request({ host: '127.0.0.1', port: PORT, localAddress: from, path: '/api/hub' + query, headers: h });
    req.on('response', async res => { let t = ''; for await (const c of res) t += c; resolve({ refused: res.statusCode, body: JSON.parse(t) }); });
    req.on('upgrade', (res, socket, head) => {
      const messages = [], waiters = [];
      let closeCode = null; const closeWaiters = [];
      const parse = createParser(f => {
        if (f.opcode === OP.TEXT) {
          const m = JSON.parse(f.payload.toString('utf8'));
          const i = waiters.findIndex(w => w.test(m));
          if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else messages.push(m);
        } else if (f.opcode === OP.PING) socket.write(encode(OP.PONG, f.payload, true));
        else if (f.opcode === OP.CLOSE) { closeCode = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005; closeWaiters.forEach(r => r(closeCode)); }
      });
      // Bytes that arrived with the handshake (the server's first message, often) come as `head`.
      if (head && head.length) setImmediate(() => parse(head));
      socket.on('data', d => parse(d));
      socket.on('error', () => {});
      socket.on('close', () => { if (closeCode === null) { closeCode = 1006; closeWaiters.forEach(r => r(closeCode)); } });
      resolve({
        socket, messages,
        send: obj => socket.write(encode(OP.TEXT, JSON.stringify(obj), true)),
        raw: buf => socket.write(buf),
        // The next message matching `test` (already received or still to come), or a timeout error.
        next(test, ms = 2000) {
          const fn = typeof test === 'function' ? test : m => m.type === test;
          const i = messages.findIndex(fn);
          if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
          return new Promise((res2, rej) => {
            const w = { test: fn, resolve: v => { clearTimeout(timer); res2(v); } };
            const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error('no matching message in ' + ms + ' ms')); }, ms);
            waiters.push(w);
          });
        },
        closed: (ms = 3000) => closeCode !== null ? Promise.resolve(closeCode)
          : new Promise((res2, rej) => { closeWaiters.push(res2); setTimeout(() => rej(new Error('still open')), ms); }),
        close: () => { try { socket.write(encode(OP.CLOSE, Buffer.from([3, 232]), true)); } catch (e) { /* gone */ } socket.end(); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let hp, acer, guest, acerId, acerToken;

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-hub-'));
  fs.mkdirSync(path.join(tmp, 'share'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ host: '127.0.0.1', shares: [{ id: 'main', name: 'Main', rootPath: path.join(tmp, 'share') }] }));
  server = await start();
  hp = client('127.0.0.1');
  await hp.call('POST', '/api/setup', MASTER);
  await hp.call('POST', '/api/session', Object.assign({ mode: 'master' }, MASTER));
  await hp.call('POST', '/api/accounts', GUEST);
  // Pair the Acer through the API; the master signs in there too.
  acer = client('127.0.0.2');
  const code = (await hp.call('POST', '/api/pairing/codes')).json.code;
  acerId = (await acer.call('POST', '/api/pairing/claim', { code, name: 'Acer Aspire 5', kind: 'laptop', os: 'Windows 11 Home' })).json.device.id;
  acerToken = decodeURIComponent(acer.jar.attic_device);
  // The guest uses the Acer as well, with its own session.
  guest = client('127.0.0.2');
  guest.jar.attic_device = acer.jar.attic_device;
  await guest.call('POST', '/api/session', { mode: 'device', username: GUEST.username, password: GUEST.password });
});
test.after(async () => {
  if (server) await stop(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const agent = () => wsOpen('127.0.0.2', { query: '?role=agent', headers: { 'X-Attic-Device': acerToken } });
const masterViewer = () => wsOpen('127.0.0.1', { cookie: hp.cookieHeader() });

// ---------- who may connect ----------
test('the hub refuses unpaired devices, other sites and anyone signed out', async () => {
  const stranger = '127.0.0.3';
  assert.strictEqual((await wsOpen(stranger)).body.code, 'NOT_PAIRED');
  assert.strictEqual((await wsOpen(stranger, { query: '?role=agent' })).body.code, 'NOT_PAIRED');
  assert.strictEqual((await wsOpen(stranger, { query: '?role=agent', headers: { 'X-Attic-Device': 'made-up' } })).body.code, 'NOT_PAIRED');
  const crossSite = await wsOpen('127.0.0.1', { cookie: hp.cookieHeader(), headers: { Origin: 'http://evil.example' } });
  assert.strictEqual(crossSite.refused, 403);
  assert.strictEqual((await wsOpen('127.0.0.2', { cookie: 'attic_device=' + acer.jar.attic_device })).body.code, 'SIGNED_OUT', 'paired but not signed in');
  assert.strictEqual((await wsOpen('127.0.0.1', { query: '?role=agent' })).body.code, 'INVALID', 'the HP has no agent');
});

// ---------- the master's view ----------
test('the master gets the device list at once, then the HP\'s own stats every few seconds', async () => {
  const v = await masterViewer();
  const first = await v.next(() => true);
  assert.strictEqual(first.type, 'devices', 'the whole list comes first');
  const ids = first.devices.map(d => d.id);
  assert.ok(ids.includes('server') && ids.includes(acerId));
  assert.strictEqual(first.devices.find(d => d.id === acerId).browserOnly, true, 'no agent has reported yet');
  const hpStats = await v.next(m => m.type === 'device' && m.device.id === 'server' && m.device.stats, 5000);
  const s = hpStats.device.stats;
  assert.ok(s.cpu >= 0 && s.cpu <= 100);
  assert.strictEqual(s.ramTotal, os.totalmem());
  assert.ok(s.diskTotal > 0 && s.diskFree <= s.diskTotal);
  assert.strictEqual(s.battery, null);
  v.close();
});

test('an agent\'s stats reach the master within 5 seconds (D-04)', async () => {
  const v = await masterViewer();
  await v.next('devices');
  const a = await agent();
  assert.deepStrictEqual(await a.next('hello'), { type: 'hello', role: 'agent', deviceId: acerId, interval: 3000 });
  assert.strictEqual((await v.next(m => m.type === 'device' && m.device.id === acerId)).device.online, true, 'online as soon as the agent connects');
  const sent = Date.now();
  a.send({ type: 'stats', stats: STATS, connection: 'wifi', ip: '192.168.1.23' });
  const got = await v.next(m => m.type === 'device' && m.device.id === acerId && m.device.stats, 5000);
  assert.ok(Date.now() - sent < 5000, `${Date.now() - sent} ms`);
  assert.deepStrictEqual(got.device.stats, STATS);
  assert.strictEqual(got.device.connection, 'wifi');
  assert.strictEqual(got.device.ip, '192.168.1.23');
  assert.strictEqual(got.device.browserOnly, false);
  // A change shows up the same way.
  await sleep(950);
  a.send({ type: 'stats', stats: Object.assign({}, STATS, { cpu: 87 }), connection: 'wifi', ip: '192.168.1.23' });
  assert.strictEqual((await v.next(m => m.type === 'device' && m.device.id === acerId && m.device.stats && m.device.stats.cpu === 87, 5000)).device.stats.cpu, 87);
  // The REST list agrees.
  const listed = (await hp.call('GET', '/api/devices')).json.find(d => d.id === acerId);
  assert.strictEqual(listed.online, true);
  assert.strictEqual(listed.stats.cpu, 87);
  a.close(); v.close();
  await sleep(200);
});

test('bad reports get an error and change nothing; reports faster than about 1 a second are ignored', async () => {
  const a = await agent();
  await a.next('hello');
  await sleep(1000);
  for (const bad of [{ cpu: 140 }, { cpu: 'high' }, Object.assign({}, STATS, { ramUsed: 9e9 }), Object.assign({}, STATS, { battery: -3 })]) {
    a.send({ type: 'stats', stats: Object.assign({}, STATS, bad) });
    assert.strictEqual((await a.next('error')).code, 'INVALID');
  }
  a.send({ type: 'whatever' });
  assert.strictEqual((await a.next('error')).code, 'UNKNOWN');
  a.send({ type: 'stats', stats: Object.assign({}, STATS, { cpu: 10 }) });
  a.send({ type: 'stats', stats: Object.assign({}, STATS, { cpu: 99 }) }); // too soon: dropped
  await sleep(300);
  assert.strictEqual((await hp.call('GET', '/api/devices')).json.find(d => d.id === acerId).stats.cpu, 10);
  a.close();
  await sleep(200);
});

// ---------- everyone else's view ----------
test('another account sees who is online, but no stats, IP or pairing details', async () => {
  const a = await agent();
  await a.next('hello');
  await sleep(1000);
  a.send({ type: 'stats', stats: STATS, connection: 'ethernet', ip: '192.168.1.23' });
  const g = await wsOpen('127.0.0.2', { cookie: guest.cookieHeader() });
  const first = (await g.next('devices')).devices.find(d => d.id === acerId);
  assert.strictEqual(first.online, true);
  assert.strictEqual(first.stats, null);
  assert.strictEqual(first.thisPC, true);
  for (const k of ['ip', 'statsAt', 'lastStats', 'pairedAt', 'pairedBy', 'lastAddress']) assert.ok(!(k in first), k);
  // A stats change isn't sent to it at all…
  await sleep(950);
  a.send({ type: 'stats', stats: Object.assign({}, STATS, { cpu: 55 }) });
  await assert.rejects(g.next(m => m.type === 'device', 600));
  // …but the device going offline is.
  a.close();
  const off = await g.next(m => m.type === 'device' && m.device.id === acerId, 3000);
  assert.strictEqual(off.device.online, false);
  assert.strictEqual(off.device.stats, null);
  g.close();
});

test('an agent that goes away shows offline at once, keeping its last stats for the master', async () => {
  const v = await masterViewer();
  await v.next('devices');
  const a = await agent();
  await a.next('hello');
  a.send({ type: 'stats', stats: STATS, connection: 'wifi' });
  await v.next(m => m.type === 'device' && m.device.id === acerId && m.device.stats);
  a.socket.destroy(); // pulled the plug: no close frame
  const off = await v.next(m => m.type === 'device' && m.device.id === acerId && m.device.online === false, 3000);
  assert.strictEqual(off.device.stats, null);
  assert.ok(off.device.lastStats && off.device.lastStats.ramTotal === STATS.ramTotal);
  v.close();
  // Kept on disk too, so a restart still knows them.
  await sleep(200);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'device-stats.json'), 'utf8'));
  assert.strictEqual(saved[acerId].stats.ramTotal, STATS.ramTotal);
});

test('a second agent for the same device replaces the first', async () => {
  const a1 = await agent(); await a1.next('hello');
  const a2 = await agent(); await a2.next('hello');
  assert.strictEqual(await a1.closed(), 4000);
  a2.close();
  await sleep(200);
});

// ---------- the protocol's edges ----------
test('frames the hub doesn\'t take close the connection with the right code', async () => {
  const cases = [
    [encode(OP.TEXT, '{"type":"ping"}', false), 1002],           // unmasked client frame
    [encode(OP.BINARY, Buffer.from([1, 2, 3]), true), 1003],      // binary
    [encode(OP.TEXT, 'not json', true), 1007],                    // not JSON
    [encode(OP.TEXT, 'x'.repeat(70 * 1024), true), 1009]          // over 64 KB
  ];
  for (const [frame, code] of cases) {
    const v = await masterViewer();
    await v.next('devices');
    v.raw(frame);
    assert.strictEqual(await v.closed(), code);
  }
  const v = await masterViewer();
  await v.next('devices');
  v.send({ type: 'ping' });
  assert.deepStrictEqual(await v.next('pong'), { type: 'pong' });
  v.close();
});

test('too many messages from one connection close it', async () => {
  const a = await agent(); await a.next('hello');
  for (let i = 0; i < 45; i++) a.send({ type: 'ping' });
  assert.strictEqual(await a.closed(), 1008);
});

// ---------- signing out and unpairing ----------
test('signing out closes that session\'s live connection', async () => {
  const other = client('127.0.0.2');
  other.jar.attic_device = acer.jar.attic_device;
  await other.call('POST', '/api/session', { mode: 'device', username: GUEST.username, password: GUEST.password });
  const g = await wsOpen('127.0.0.2', { cookie: other.cookieHeader() });
  await g.next('devices');
  await other.call('DELETE', '/api/session');
  assert.strictEqual(await g.closed(), 4001);
});

test('unpairing cuts the device\'s agent and viewers off and tells the master', async () => {
  const v = await masterViewer(); await v.next('devices');
  const a = await agent(); await a.next('hello');
  const g = await wsOpen('127.0.0.2', { cookie: guest.cookieHeader() }); await g.next('devices');
  assert.strictEqual((await hp.call('DELETE', '/api/devices/' + acerId)).status, 200);
  assert.strictEqual(await a.closed(), 4001);
  assert.strictEqual(await g.closed(), 4001);
  assert.deepStrictEqual(await v.next('removed'), { type: 'removed', id: acerId });
  assert.strictEqual((await agent()).body.code, 'NOT_PAIRED');
  v.close();
});
