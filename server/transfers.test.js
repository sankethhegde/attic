// Transfer tests (Phase 2, milestone 2-4, D-05 and D-07): a file sent to another device goes through the
// HP, waits there while that device is offline, and arrives complete. The "Acer" is 127.0.0.2 and the
// "ROG Ally" 127.0.0.3; both are paired through the API. Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { startServer, stopServer, client, wsOpen, shaOfPattern, sleep } = require('./test-util');
const { createTransfers, KEEP_MS } = require('./transfers');

const PORT = 25000 + Math.floor(Math.random() * 1000);
const MASTER = { displayName: 'Sanketh', username: 'sanketh', password: 'master-pass-1' };
const GUEST = { displayName: 'Guest', username: 'guest', password: 'guest-pass-1', deviceType: 'laptop' };
const GB = 1e9;
let tmp, server, env, hp, acer, ally, guest, acerId, allyId, allyToken;

const start = async () => { server = await startServer(env); };
const spool = () => fs.readdirSync(path.join(tmp, 'data', 'transfers'));
const allyAgent = () => wsOpen(PORT, '127.0.0.3', { query: '?role=agent', headers: { 'X-Attic-Device': allyToken } });
const asAlly = { 'X-Attic-Device': '' }; // filled in once paired
async function pair(c, name, kind) {
  const code = (await hp.call('POST', '/api/pairing/codes')).json.code;
  return (await c.call('POST', '/api/pairing/claim', { code, name, kind })).json.device.id;
}
// Send a file from the Acer: create, then stream.
async function send(size, { to = allyId, fileName = 'file.bin', from = acer, opts } = {}) {
  const t = await from.call('POST', '/api/transfers', { to, fileName, size });
  assert.strictEqual(t.status, 201, JSON.stringify(t.json));
  const up = await from.upload(`/api/transfers/${t.json.id}/file`, size, opts);
  return { id: t.json.id, up };
}
// What the Ally's agent does: download, check, confirm.
async function collect(id) {
  const d = await ally.download(`/api/transfers/${id}/file`, asAlly);
  assert.strictEqual(d.status, 200);
  const r = await ally.call('POST', `/api/transfers/${id}/received`, {}, asAlly);
  assert.strictEqual(r.status, 200);
  return { d, t: r.json };
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-tr-'));
  fs.mkdirSync(path.join(tmp, 'share'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ host: '127.0.0.1', shares: [{ id: 'main', name: 'Main', rootPath: path.join(tmp, 'share') }] }));
  env = { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(PORT) };
  await start();
  hp = client(PORT, '127.0.0.1');
  await hp.call('POST', '/api/setup', MASTER);
  await hp.call('POST', '/api/session', Object.assign({ mode: 'master' }, MASTER));
  await hp.call('POST', '/api/accounts', GUEST);
  acer = client(PORT, '127.0.0.2');
  ally = client(PORT, '127.0.0.3');
  acerId = await pair(acer, 'Acer Aspire 5', 'laptop');
  allyId = await pair(ally, 'ASUS ROG Ally', 'handheld');
  allyToken = decodeURIComponent(ally.jar.attic_device);
  asAlly['X-Attic-Device'] = allyToken;
  await acer.call('POST', '/api/session', Object.assign({ mode: 'master' }, MASTER));
  guest = client(PORT, '127.0.0.2');
  guest.jar.attic_device = acer.jar.attic_device;
  await guest.call('POST', '/api/session', { mode: 'device', username: GUEST.username, password: GUEST.password });
});
test.after(async () => {
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---------- what can be sent where ----------
test('a transfer needs a paired sender, a paired client device and a name Windows can store', async () => {
  const stranger = client(PORT, '127.0.0.9');
  assert.strictEqual((await stranger.call('POST', '/api/transfers', { to: allyId, fileName: 'a.txt', size: 1 })).json.code, 'NOT_PAIRED');
  const bad = async body => (await acer.call('POST', '/api/transfers', Object.assign({ to: allyId, fileName: 'a.txt', size: 1 }, body))).json;
  assert.match((await bad({ to: 'server' })).message, /paired device/, 'not to the HP');
  assert.match((await bad({ to: 'dev_nope' })).message, /paired device/);
  assert.match((await bad({ to: acerId })).message, /this device/);
  for (const fileName of ['', 'CON.txt', 'a/b.txt', '..\\x', 'trailing.', 'what?.txt', 'link.lnk', 'x'.repeat(201)]) assert.strictEqual((await bad({ fileName })).code, 'INVALID', JSON.stringify(fileName));
  assert.strictEqual((await bad({ size: -1 })).code, 'INVALID');
  assert.strictEqual((await bad({ size: 21 * GB })).code, 'TOO_LARGE');
  // The receiving end needs the device itself: an account on the HP can't fetch someone's inbox.
  assert.strictEqual((await hp.call('GET', '/api/inbox')).json.code, 'INVALID');
  assert.strictEqual((await stranger.call('GET', '/api/inbox')).json.code, 'NOT_PAIRED');
});

test('the body must be exactly the size declared, or the transfer fails and nothing is kept', async () => {
  const t = (await acer.call('POST', '/api/transfers', { to: allyId, fileName: 'short.bin', size: 1000 })).json;
  assert.strictEqual((await acer.upload(`/api/transfers/${t.id}/file`, 999, { declared: 999 })).json.code, 'INVALID');
  // A cut-off upload: the connection drops part way.
  const t2 = (await acer.call('POST', '/api/transfers', { to: allyId, fileName: 'cut.bin', size: 8 << 20 })).json;
  await acer.upload(`/api/transfers/${t2.id}/file`, 8 << 20, { abortAfter: 2 << 20 });
  await sleep(300);
  const after = (await acer.call('GET', '/api/transfers')).json.find(x => x.id === t2.id);
  assert.strictEqual(after.status, 'failed');
  assert.ok(!spool().some(f => f.startsWith(t2.id)), 'no half file left on the HP');
  // Only the sender, on the device it said, can upload.
  const t3 = (await acer.call('POST', '/api/transfers', { to: allyId, fileName: 'mine.bin', size: 10 })).json;
  assert.strictEqual((await guest.upload(`/api/transfers/${t3.id}/file`, 10)).status, 404);
  await acer.call('DELETE', '/api/transfers/' + t3.id);
  await acer.call('DELETE', '/api/transfers/' + t.id);
});

// ---------- the acceptance checks ----------
test('a 2 GB file sent from the Acer arrives complete in the ROG Ally\'s inbox', { timeout: 180e3 }, async () => {
  const a = await allyAgent();
  await a.next('hello');
  assert.deepStrictEqual((await a.next('inbox')).transfers, []);
  const size = 2 * GB;
  const t0 = Date.now();
  const { id, up } = await send(size, { fileName: 'Trip to Coorg.zip' });
  assert.strictEqual(up.status, 200);
  assert.strictEqual(up.json.status, 'queued');
  // The Ally's agent, already online, is told at once.
  const note = await a.next(m => m.type === 'transfer' && m.transfer.id === id);
  assert.strictEqual(note.transfer.fileName, 'Trip to Coorg.zip');
  assert.strictEqual(note.transfer.size, size);
  const { d, t } = await collect(id);
  assert.strictEqual(d.bytes, size);
  assert.strictEqual(d.sha, up.sha, 'the same bytes, end to end');
  assert.match(d.headers['content-disposition'], /attachment; filename="Trip to Coorg.zip"/);
  assert.strictEqual(t.status, 'done');
  assert.strictEqual(t.bytesDone, size);
  assert.ok(t.speed > 0 && t.uploadSpeed > 0);
  // Windows lists a deleted file until the last handle on it (the download's) closes.
  for (let i = 0; i < 40 && spool().some(f => f.startsWith(id)); i++) await sleep(50);
  assert.ok(!spool().some(f => f.startsWith(id)), 'the HP deletes its copy once delivered');
  console.log(`    2 GB through the HP in ${((Date.now() - t0) / 1000).toFixed(1)} s (upload ${(t.uploadSpeed / 1e6).toFixed(0)} MB/s, delivery ${(t.speed / 1e6).toFixed(0)} MB/s)`);
  a.close();
});

test('a transfer to an offline device waits on the HP, through a restart, and is delivered when it comes online', async () => {
  const { id, up } = await send(3 << 20, { fileName: 'Wallpapers.zip' });
  assert.strictEqual(up.json.status, 'queued');
  await stopServer(server);
  await start();
  // The Ally comes online: its agent's first word from the HP lists what's waiting.
  const a = await allyAgent();
  await a.next('hello');
  const inbox = (await a.next('inbox')).transfers;
  assert.deepStrictEqual(inbox.map(x => x.id), [id]);
  assert.deepStrictEqual((await ally.call('GET', '/api/inbox', undefined, asAlly)).json.map(x => x.id), [id]);
  const { d, t } = await collect(id);
  assert.strictEqual(d.sha, up.sha);
  assert.strictEqual(t.status, 'done');
  assert.deepStrictEqual((await ally.call('GET', '/api/inbox', undefined, asAlly)).json, []);
  a.close();
});

// ---------- delivery details ----------
test('a delivery can resume part way, and only the receiving device can fetch it', async () => {
  const size = 5 << 20;
  const { id } = await send(size);
  assert.strictEqual((await acer.download(`/api/transfers/${id}/file`)).status, 404, 'not the sender');
  assert.strictEqual((await guest.download(`/api/transfers/${id}/file`)).status, 404);
  assert.strictEqual((await hp.download(`/api/transfers/${id}/file`)).status, 400, 'not the HP');
  const from = 3 << 20;
  const part = await ally.download(`/api/transfers/${id}/file`, Object.assign({ Range: `bytes=${from}-` }, asAlly));
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.bytes, size - from);
  assert.strictEqual(part.sha, shaOfPattern(size, from));
  const listed = (await hp.call('GET', '/api/transfers')).json.find(x => x.id === id);
  assert.strictEqual(listed.status, 'active');
  assert.strictEqual(listed.stage, 'deliver');
  assert.strictEqual((await ally.call('POST', `/api/transfers/${id}/received`, {}, asAlly)).json.status, 'done');
  assert.strictEqual((await ally.call('POST', `/api/transfers/${id}/received`, {}, asAlly)).status, 404, 'once');
});

test('the receiving device can report it couldn\'t save the file', async () => {
  const { id } = await send(1024);
  const r = await ally.call('POST', `/api/transfers/${id}/failed`, { error: 'Not enough space on C:' }, asAlly);
  assert.strictEqual(r.json.status, 'failed');
  assert.strictEqual(r.json.error, 'Not enough space on C:');
});

// ---------- who sees what ----------
test('the master sees every transfer; another account sees its own, and the ones to its device', async () => {
  const mine = (await send(10, { from: guest, fileName: 'guest-note.txt' })).id;
  const all = (await hp.call('GET', '/api/transfers')).json;
  assert.ok(all.length >= 5);
  assert.ok(all.every((x, i) => i === 0 || all[i - 1].startedAt >= x.startedAt), 'newest first');
  const theirs = (await guest.call('GET', '/api/transfers')).json;
  assert.deepStrictEqual(theirs.map(x => x.id), [mine]);
  // The master watching the hub hears each change.
  const v = await wsOpen(PORT, '127.0.0.1', { cookie: hp.cookieHeader() });
  await v.next('devices');
  const { id } = await send(100);
  assert.strictEqual((await v.next(m => m.type === 'transfer' && m.transfer.id === id && m.transfer.status === 'queued')).transfer.to, allyId);
  await collect(id);
  assert.strictEqual((await v.next(m => m.type === 'transfer' && m.transfer.id === id && m.transfer.status === 'done')).transfer.bytesDone, 100);
  v.close();
  await collect(mine);
});

// ---------- cancelling and unpairing ----------
test('the sender can cancel; the receiving agent is told and the HP\'s copy is gone', async () => {
  const a = await allyAgent(); await a.next('hello'); await a.next('inbox');
  const { id } = await send(2048);
  await a.next('transfer');
  assert.strictEqual((await guest.call('DELETE', '/api/transfers/' + id)).status, 404, 'not someone else');
  assert.strictEqual((await acer.call('DELETE', '/api/transfers/' + id)).json.status, 'cancelled');
  assert.deepStrictEqual(await a.next('transfer-cancelled'), { type: 'transfer-cancelled', id });
  await sleep(100);
  assert.ok(!spool().some(f => f.startsWith(id)));
  assert.strictEqual((await ally.download(`/api/transfers/${id}/file`, asAlly)).status, 404);
  assert.strictEqual((await acer.call('DELETE', '/api/transfers/' + id)).status, 409, 'already finished');
  a.close();
});

test('cancelling stops an upload that\'s still arriving', async () => {
  const size = 600 << 20;
  const t = (await acer.call('POST', '/api/transfers', { to: allyId, fileName: 'big.bin', size })).json;
  const sending = acer.upload(`/api/transfers/${t.id}/file`, size, { gen: (o, n) => Buffer.alloc(n, 7) });
  await sleep(150);
  assert.strictEqual((await hp.call('DELETE', '/api/transfers/' + t.id)).json.status, 'cancelled', 'the master can too');
  const r = await sending.catch(() => ({ status: 0 }));
  assert.ok(r.status === 409 || r.status === 0, 'upload refused: ' + r.status);
  await sleep(300);
  assert.ok(!spool().some(f => f.startsWith(t.id)));
});

test('unpairing a device cancels what was waiting for it', async () => {
  const { id } = await send(512);
  assert.strictEqual((await hp.call('DELETE', '/api/devices/' + allyId)).status, 200);
  const t = (await hp.call('GET', '/api/transfers')).json.find(x => x.id === id);
  assert.strictEqual(t.status, 'cancelled');
  assert.match(t.error, /unpaired/);
  await sleep(100);
  assert.ok(!spool().some(f => f.startsWith(id)));
});

// ---------- housekeeping (the module on its own) ----------
test('a file nobody collects within 14 days is deleted, and a restart fails an upload cut off by it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-tr-unit-'));
  try {
    const opts = { dataDir: dir, spoolDir: path.join(dir, 'spool') };
    const tr = createTransfers(opts);
    const isDevice = () => true;
    const a = await tr.create({ fileName: 'old.zip', size: 3, to: 'dev_b' }, { userId: 'u', from: 'dev_a', isDevice });
    const body = Object.assign(require('stream').Readable.from([Buffer.from('abc')]), { headers: { 'content-length': '3' }, complete: true });
    await tr.receiveUpload(a.id, body, { userId: 'u', from: 'dev_a' });
    const b = await tr.create({ fileName: 'midway.zip', size: 3, to: 'dev_b' }, { userId: 'u', from: 'dev_a', isDevice });
    tr.sweep(Date.now() + KEEP_MS + 1000);
    assert.strictEqual(tr.get(a.id).status, 'failed');
    assert.match(tr.get(a.id).error, /14 days/);
    await sleep(100);
    assert.ok(!fs.existsSync(path.join(dir, 'spool', a.id + '.bin')));
    // b was still waiting for its upload when the "server" stopped.
    const again = createTransfers(opts);
    assert.strictEqual(again.get(b.id).status, 'failed');
    assert.match(again.get(b.id).error, /restarted/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
