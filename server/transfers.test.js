// Transfer tests (Phase 2, milestone 2-4, D-05 and D-07): a file sent to another device goes through the
// HP, waits there while that device is offline, and arrives complete. The "Acer" is 127.0.0.2 and the
// "ROG Ally" 127.0.0.3; both are paired through the API. Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { startServer, stopServer, client, wsOpen, shaOfPattern, sleep } = require('./test-util');
const { createTransfers, KEEP_MS } = require('./transfers');
const { openDb } = require('./db');

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
  // Pair the Ally again (a new identity) for the tests after this one.
  allyId = await pair(ally, 'ASUS ROG Ally', 'handheld');
  allyToken = decodeURIComponent(ally.jar.attic_device);
  asAlly['X-Attic-Device'] = allyToken;
});

// ---------- housekeeping (the module on its own) ----------
test('a file nobody collects within 14 days is deleted, and a restart fails an upload cut off by it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-tr-unit-'));
  const db = openDb(dir);
  try {
    const opts = { db, dataDir: dir, spoolDir: path.join(dir, 'spool') };
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
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

// ---------- 2-5: progress, retry, history ----------
test('a moving transfer reports its bytes and speed about twice a second, both legs (D-06)', async () => {
  const v = await wsOpen(PORT, '127.0.0.1', { cookie: hp.cookieHeader() });
  await v.next('devices');
  // A slow sender: 6 MB over about 3 s.
  const size = 6 << 20;
  const t = (await acer.call('POST', '/api/transfers', { to: allyId, fileName: 'slow.bin', size })).json;
  let sent = 0;
  const up = acer.upload(`/api/transfers/${t.id}/file`, size, { gen: (o, n) => { sent += n; return Buffer.alloc(n, 1); }, chunkDelay: 400 });
  const seen = [];
  const watch = (async () => { for (;;) { const m = await v.next(m => m.type === 'progress' && m.id === t.id, 6000).catch(() => null); if (!m) return; seen.push(m); if (m.stage === 'deliver' && m.bytesDone === size) return; } })();
  assert.strictEqual((await up).status, 200);
  const mid = (await hp.call('GET', '/api/transfers/' + t.id)).json;
  assert.strictEqual(mid.status, 'queued');
  await collect(t.id);
  await watch;
  const ups = seen.filter(m => m.stage === 'upload'), dels = seen.filter(m => m.stage === 'deliver');
  assert.ok(ups.length >= 1 && dels.length >= 1, `${ups.length} upload and ${dels.length} delivery events`);
  for (const m of seen) { assert.strictEqual(m.size, size); assert.ok(m.bytesDone > 0 && m.bytesDone <= size); }
  assert.strictEqual(dels[dels.length - 1].bytesDone, size, 'the last delivery event is the whole file');
  assert.ok(seen.some(m => m.speed > 0), 'a speed once there is something to measure');
  v.close();
});

test('the list shows live bytes while a transfer moves', async () => {
  const size = 64 << 20;
  const t = (await acer.call('POST', '/api/transfers', { to: allyId, fileName: 'watch.bin', size })).json;
  let release;
  const gate = new Promise(r => { release = r; });
  // Send 16 MB, then hold the rest until the test has looked.
  const up = acer.upload(`/api/transfers/${t.id}/file`, size, { gen: (o, n) => Buffer.alloc(n, 2), pauseAt: 16 << 20, gate });
  for (let i = 0; i < 40; i++) {
    const cur = (await hp.call('GET', '/api/transfers/' + t.id)).json;
    if (cur.bytesDone >= 8 << 20) { assert.strictEqual(cur.status, 'active'); assert.strictEqual(cur.stage, 'upload'); break; }
    if (i === 39) assert.fail('no live bytes in the list: ' + cur.bytesDone);
    await sleep(100);
  }
  release();
  assert.strictEqual((await up).status, 200);
  await collect(t.id);
});

test('Retry puts a failed delivery back in the queue, and asks for the file again when the HP no longer has it', async () => {
  // A failed delivery: the HP still has the file, so it's queued again and the agent is told.
  const a = await allyAgent(); await a.next('hello'); await a.next('inbox');
  const { id, up } = await send(4096, { fileName: 'retry-me.bin' });
  await a.next(m => m.type === 'transfer' && m.transfer.id === id);
  await ally.call('POST', `/api/transfers/${id}/failed`, { error: 'Disk full' }, asAlly);
  assert.strictEqual((await guest.call('POST', `/api/transfers/${id}/retry`)).status, 404, 'not someone else');
  const r = (await acer.call('POST', `/api/transfers/${id}/retry`)).json;
  assert.strictEqual(r.status, 'queued');
  assert.strictEqual(r.attempts, 2);
  assert.strictEqual(r.error, null);
  assert.strictEqual((await a.next(m => m.type === 'transfer' && m.transfer.id === id)).transfer.status, 'queued');
  const { d } = await collect(id);
  assert.strictEqual(d.sha, up.sha);
  assert.strictEqual((await acer.call('POST', `/api/transfers/${id}/retry`)).json.code, 'INVALID', 'not a finished one');
  // A cancelled one: the HP deleted its copy, so the sender uploads again.
  const c = await send(2048, { fileName: 'again.bin' });
  await acer.call('DELETE', '/api/transfers/' + c.id);
  const r2 = (await hp.call('POST', `/api/transfers/${c.id}/retry`)).json;
  assert.strictEqual(r2.status, 'active');
  assert.strictEqual(r2.stage, 'upload');
  const up2 = await acer.upload(`/api/transfers/${c.id}/file`, 2048);
  assert.strictEqual(up2.json.status, 'queued');
  assert.strictEqual(up2.json.attempts, 2);
  await collect(c.id);
  a.close();
});

test('history pages through finished transfers with sender, receiver, size and times (D-08)', async () => {
  const first = (await hp.call('GET', '/api/transfers/history?limit=3')).json;
  assert.strictEqual(first.items.length, 3);
  assert.ok(first.next);
  for (const t of first.items) {
    assert.ok(['done', 'failed', 'cancelled'].includes(t.status));
    for (const k of ['fileName', 'size', 'from', 'to', 'userId', 'startedAt', 'finishedAt']) assert.ok(t[k] !== undefined && t[k] !== null, k);
  }
  const done = first.items.find(t => t.status === 'done' && t.to === allyId);
  if (done) { assert.strictEqual(done.fromName, 'Acer Aspire 5'); assert.strictEqual(done.toName, 'ASUS ROG Ally'); assert.strictEqual(done.userName, 'Sanketh'); }
  // Every page follows on from the last, with no repeats.
  const seen = new Set(first.items.map(t => t.id));
  let next = first.next, pages = 1;
  while (next) {
    const p = (await hp.call('GET', `/api/transfers/history?limit=3&before=${encodeURIComponent(next)}`)).json;
    for (const t of p.items) { assert.ok(!seen.has(t.id), 'repeat ' + t.id); seen.add(t.id); }
    next = p.next; pages++;
  }
  assert.ok(pages >= 2);
  const all = (await hp.call('GET', '/api/transfers/history?limit=200')).json.items;
  assert.strictEqual(all.length, seen.size);
  assert.ok(all.every((t, i) => i === 0 || all[i - 1].startedAt >= t.startedAt), 'newest first');
  // Filters.
  assert.ok((await hp.call('GET', '/api/transfers/history?status=done')).json.items.every(t => t.status === 'done'));
  assert.deepStrictEqual((await hp.call('GET', '/api/transfers/history?q=Coorg')).json.items.map(t => t.fileName), ['Trip to Coorg.zip']);
  assert.deepStrictEqual((await hp.call('GET', '/api/transfers/history?q=' + encodeURIComponent('%'))).json.items, [], '% is a letter, not a wildcard');
  assert.ok((await hp.call('GET', `/api/transfers/history?device=${allyId}`)).json.items.every(t => t.from === allyId || t.to === allyId));
  // Another account: only its own.
  const g = (await guest.call('GET', '/api/transfers/history?limit=200')).json.items;
  assert.ok(g.length >= 1 && g.every(t => t.userName === 'Guest' || t.to === acerId));
  // Unknown or someone else's single transfer: not found.
  assert.strictEqual((await guest.call('GET', '/api/transfers/' + first.items.find(t => t.userName !== 'Guest').id)).status, 404);
});

test('the names stay in history after a device is unpaired, and history survives a restart', async () => {
  const before = (await hp.call('GET', '/api/transfers/history?q=Coorg')).json.items[0];
  await stopServer(server);
  await start();
  await hp.call('POST', '/api/session', Object.assign({ mode: 'master' }, MASTER));
  const after = (await hp.call('GET', '/api/transfers/history?q=Coorg')).json.items[0];
  assert.deepStrictEqual(after, before);
  assert.strictEqual(after.toName, 'ASUS ROG Ally');
});

test('2-4\'s transfers.json is brought into the database once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-tr-mig-'));
  const db = openDb(dir);
  try {
    const old = { id: 'tr_old1', fileName: 'Old.zip', size: 10, from: 'dev_a', to: 'dev_b', userId: 'u', status: 'done', stage: null, bytesDone: 10,
      speed: 5, startedAt: '2026-11-03T10:00:00.000Z', uploadedAt: '2026-11-03T10:00:01.000Z', finishedAt: '2026-11-03T10:00:03.000Z', error: null };
    fs.writeFileSync(path.join(dir, 'transfers.json'), JSON.stringify([old]));
    const tr = createTransfers({ db, dataDir: dir, spoolDir: path.join(dir, 'spool') });
    const got = tr.get('tr_old1');
    assert.strictEqual(got.fileName, 'Old.zip');
    assert.strictEqual(got.attempts, 1);
    assert.ok(!fs.existsSync(path.join(dir, 'transfers.json')) && fs.existsSync(path.join(dir, 'transfers.json.imported')));
    createTransfers({ db, dataDir: dir, spoolDir: path.join(dir, 'spool') }); // a second start: nothing to bring over
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM transfers').get().n, 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
