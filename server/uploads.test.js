// Large-upload tests (Phase 4, milestone 4-2): an iPhone's camera-roll video reaches the HP even when the
// connection drops part-way, the HP restarts, or the upload takes longer than five minutes. The "iPhone"
// is 127.0.0.2 and the "ROG Ally" 127.0.0.3. Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const { startServer, stopServer, client, patternBytes, shaOfPattern, sleep } = require('./test-util');
const { createUploads } = require('./uploads');

const PORT = 30000 + Math.floor(Math.random() * 1000);
const MASTER = { displayName: 'Sanketh', username: 'sanketh', password: 'master-pass-1' };
const PHONE = { displayName: 'iPhone', username: 'phone', password: 'phone-pass-1', deviceType: 'phone' };
const MB = 1 << 20;
let tmp, share, server, env, hp, phone, ally, allyId, allyToken;

const start = async () => { server = await startServer(env); };
// Sends bytes [from, to) of the test pattern as one piece at `from`.
const piece = (c, id, from, to, opts = {}) => c.upload(`/api/uploads/${id}?offset=${from}`, to - from, Object.assign({ gen: (o, n) => patternBytes(from + o, n) }, opts));
async function pair(c, name, kind) {
  const code = (await hp.call('POST', '/api/pairing/codes')).json.code;
  return (await c.call('POST', '/api/pairing/claim', { code, name, kind })).json.device.id;
}
const shaFile = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const leftovers = () => fs.readdirSync(share).filter(n => n.startsWith('~attic-'));

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-up-'));
  share = path.join(tmp, 'share');
  fs.mkdirSync(path.join(share, 'Camera Roll'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ host: '127.0.0.1', shares: [{ id: 'main', name: 'Main', rootPath: share }] }));
  env = { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(PORT) };
  await start();
  hp = client(PORT, '127.0.0.1');
  await hp.call('POST', '/api/setup', MASTER);
  await hp.call('POST', '/api/session', Object.assign({ mode: 'master' }, MASTER));
  await hp.call('POST', '/api/accounts', PHONE);
  phone = client(PORT, '127.0.0.2');
  ally = client(PORT, '127.0.0.3');
  await pair(phone, 'iPhone', 'phone');
  allyId = await pair(ally, 'ASUS ROG Ally', 'handheld');
  allyToken = decodeURIComponent(ally.jar.attic_device);
  await phone.call('POST', '/api/session', { mode: 'device', username: PHONE.username, password: PHONE.password });
});
test.after(async () => {
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---------- into Files ----------
test('a video uploaded in pieces survives a drop mid-piece and lands in its folder, the phone’s own', async () => {
  const size = 20 * MB + 12345;
  const s = await phone.call('POST', '/api/uploads', { shareId: 'main', folder: 'Camera Roll', name: 'IMG_0420.MOV', size });
  assert.strictEqual(s.status, 201, JSON.stringify(s.json));
  assert.strictEqual(s.json.offset, 0);
  assert.strictEqual(s.json.chunkSize, 8 * MB);
  const id = s.json.id;
  assert.strictEqual((await piece(phone, id, 0, 8 * MB)).json.offset, 8 * MB);
  // The Wi-Fi drops 3 MB into the second piece.
  await piece(phone, id, 8 * MB, 16 * MB, { abortAfter: 3 * MB });
  await sleep(300);
  const st = (await phone.call('GET', '/api/uploads/' + id)).json;
  assert.ok(st.offset > 8 * MB && st.offset <= 11 * MB, 'what arrived before the drop is kept: ' + st.offset);
  // Carry on from there.
  let at = st.offset, last;
  while (at < size) { const to = Math.min(size, at + 8 * MB); last = (await piece(phone, id, at, to)).json; at = last.offset; }
  assert.strictEqual(last.done, true);
  assert.strictEqual(last.result.name, 'IMG_0420.MOV');
  assert.strictEqual(shaFile(path.join(share, 'Camera Roll', 'IMG_0420.MOV')), shaOfPattern(size));
  assert.deepStrictEqual(fs.readdirSync(path.join(share, 'Camera Roll')).filter(n => n.startsWith('~')), [], 'nothing left behind');
  // It's the phone account's: it sees it, and so does the master.
  assert.ok((await phone.call('GET', '/api/shares/main/folder?path=Camera%20Roll')).json.items.some(e => e.name === 'IMG_0420.MOV'));
  assert.ok((await hp.call('GET', '/api/shares/main/folder?path=Camera%20Roll')).json.items.some(e => e.name === 'IMG_0420.MOV'));
  assert.strictEqual((await phone.call('GET', '/api/uploads/' + id)).status, 404, 'the session is gone once done');
  // The same name again never overwrites.
  const again = (await phone.call('POST', '/api/uploads', { shareId: 'main', folder: 'Camera Roll', name: 'IMG_0420.MOV', size: 10 })).json;
  assert.strictEqual((await piece(phone, again.id, 0, 10)).json.result.name, 'IMG_0420 (1).MOV');
});

test('the HP takes each piece only at its own offset, and only from the device and account that started', async () => {
  const s = (await phone.call('POST', '/api/uploads', { shareId: 'main', folder: '', name: 'rules.mov', size: 3 * MB })).json;
  const wrong = await piece(phone, s.id, MB, 2 * MB);
  assert.strictEqual(wrong.status, 409);
  assert.strictEqual(wrong.json.code, 'OFFSET');
  assert.strictEqual(wrong.json.offset, 0, 'and says where to send from');
  assert.strictEqual((await phone.upload(`/api/uploads/${s.id}?offset=0`, 4 * MB)).json.code, 'INVALID', 'past the end');
  assert.strictEqual((await hp.upload(`/api/uploads/${s.id}?offset=0`, MB)).status, 404, 'another account');
  const otherDevice = client(PORT, '127.0.0.3');
  otherDevice.jar.attic_device = ally.jar.attic_device;
  await otherDevice.call('POST', '/api/session', { mode: 'device', username: PHONE.username, password: PHONE.password });
  assert.strictEqual((await otherDevice.call('GET', '/api/uploads/' + s.id)).status, 404, 'the same account on another device');
  // Bad starts.
  assert.strictEqual((await phone.call('POST', '/api/uploads', { shareId: 'main', folder: '', name: 'x.mov', size: 21e9 })).json.code, 'TOO_LARGE');
  assert.strictEqual((await phone.call('POST', '/api/uploads', { shareId: 'main', folder: '', name: 'CON.mov', size: 1 })).json.code, 'INVALID');
  assert.strictEqual((await phone.call('POST', '/api/uploads', { shareId: 'main', folder: 'Nowhere', name: 'x.mov', size: 1 })).status, 404);
  // Giving up deletes what arrived.
  await piece(phone, s.id, 0, MB);
  assert.strictEqual((await phone.call('DELETE', '/api/uploads/' + s.id)).status, 200);
  assert.deepStrictEqual(leftovers(), []);
});

test('an upload carries on after the HP restarts', async () => {
  const size = 9 * MB;
  const s = (await phone.call('POST', '/api/uploads', { shareId: 'main', folder: '', name: 'restart.mov', size })).json;
  await piece(phone, s.id, 0, 5 * MB);
  await stopServer(server);
  await start();
  assert.strictEqual((await phone.call('GET', '/api/uploads/' + s.id)).json.offset, 5 * MB);
  const done = (await piece(phone, s.id, 5 * MB, size)).json;
  assert.strictEqual(done.done, true);
  assert.strictEqual(shaFile(path.join(share, 'restart.mov')), shaOfPattern(size));
});

test('an empty file needs no pieces', async () => {
  const r = (await phone.call('POST', '/api/uploads', { shareId: 'main', folder: '', name: 'empty.txt', size: 0 })).json;
  assert.strictEqual(r.done, true);
  assert.strictEqual(fs.statSync(path.join(share, 'empty.txt')).size, 0);
});

// ---------- sending to another device ----------
test('a video sent to another device goes up in pieces, through a drop and a restart, and arrives whole', async () => {
  const size = 12 * MB + 7;
  const t = (await phone.call('POST', '/api/transfers', { to: allyId, fileName: 'IMG_0421.MOV', size })).json;
  const s = (await phone.call('POST', '/api/uploads', { transferId: t.id })).json;
  assert.strictEqual(s.size, size);
  assert.strictEqual(s.name, 'IMG_0421.MOV');
  assert.strictEqual((await phone.upload(`/api/transfers/${t.id}/file`, size)).status, 409, 'not also as one request');
  await piece(phone, s.id, 0, 4 * MB);
  // The transfer shows its upload moving.
  const mid = (await phone.call('GET', '/api/transfers/' + t.id)).json;
  assert.strictEqual(mid.status, 'active');
  assert.strictEqual(mid.stage, 'upload');
  assert.strictEqual(mid.bytesDone, 4 * MB);
  await piece(phone, s.id, 4 * MB, 10 * MB, { abortAfter: 2 * MB });
  await sleep(300);
  await stopServer(server);
  await start();
  let at = (await phone.call('GET', '/api/uploads/' + s.id)).json.offset;
  assert.ok(at >= 4 * MB && at <= 6 * MB, 'kept across the drop and the restart: ' + at);
  assert.strictEqual((await phone.call('GET', '/api/transfers/' + t.id)).json.status, 'active', 'the transfer is still waiting for the rest');
  let last;
  while (at < size) { last = (await piece(phone, s.id, at, Math.min(size, at + 8 * MB))).json; at = last.offset; }
  assert.strictEqual(last.result.status, 'queued');
  const d = await ally.download(`/api/transfers/${t.id}/file`, { 'X-Attic-Device': allyToken });
  assert.strictEqual(d.sha, shaOfPattern(size));
});

test('cancelling the transfer stops its upload', async () => {
  const t = (await phone.call('POST', '/api/transfers', { to: allyId, fileName: 'never.mov', size: 4 * MB })).json;
  const s = (await phone.call('POST', '/api/uploads', { transferId: t.id })).json;
  await piece(phone, s.id, 0, MB);
  await phone.call('DELETE', '/api/transfers/' + t.id);
  await sleep(200);
  const r = await piece(phone, s.id, MB, 2 * MB);
  assert.ok(r.status === 409 || r.status === 404, 'refused: ' + r.status);
});

// ---------- time limits ----------
test('a slow upload may take as long as it needs; only a silent connection is closed', async () => {
  const port = PORT + 1;
  const s2 = await startServer(Object.assign({}, env, { ATTIC_PORT: String(port), ATTIC_IDLE_TIMEOUT_MS: '1500' }));
  try {
    const c = client(port, '127.0.0.2');
    c.jar.attic_device = phone.jar.attic_device;
    await c.call('POST', '/api/session', { mode: 'device', username: PHONE.username, password: PHONE.password });
    // 6 MB, a megabyte every 0.8 s: about 5 s in all, well past the 1.5 s idle limit, but never idle.
    const t0 = Date.now();
    const slow = await c.upload('/api/shares/main/file?path=slow.mov', 6 * MB, { chunkDelay: 800 });
    assert.strictEqual(slow.status, 201, 'took ' + (Date.now() - t0) + ' ms');
    assert.ok(Date.now() - t0 > 3000);
    // One megabyte, then silence: the HP closes the connection.
    const stalled = await new Promise(resolve => {
      const r = http.request({ host: '127.0.0.1', port, localAddress: '127.0.0.2', method: 'PUT', path: '/api/shares/main/file?path=stalled.mov',
        headers: { Cookie: c.cookieHeader(), 'X-Attic-Upload': '1', 'Content-Length': 4 * MB } }, res => { res.resume(); resolve('answered ' + res.statusCode); });
      r.on('error', e => resolve('closed: ' + e.code));
      r.write(Buffer.alloc(MB));
      setTimeout(() => resolve('still open after 5 s'), 5000);
    });
    assert.match(stalled, /closed|answered 4\d\d/, stalled);
    for (let i = 0; i < 30 && leftovers().length; i++) await sleep(100); // deleted just after the close
    assert.deepStrictEqual(leftovers(), [], 'and its half-file is gone');
  } finally { await stopServer(s2); }
});

// ---------- the module on its own ----------
test('an upload left alone for a day is dropped, with its bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-up-unit-'));
  try {
    const dropped = [];
    const u = createUploads({ dataDir: dir, finalize: async () => ({}), onDropped: (s, why) => dropped.push(why) });
    const temp = path.join(dir, 'x.part');
    const s = await u.create({ userId: 'u', deviceId: 'd', size: 10, name: 'x.mov', temp, target: { kind: 'share' } });
    u.sweep(Date.now() + 25 * 3600e3);
    assert.strictEqual(fs.existsSync(temp), false);
    assert.throws(() => u.status(s.id, { userId: 'u', deviceId: 'd' }), /no longer exists/);
    assert.match(dropped[0], /within a day/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
