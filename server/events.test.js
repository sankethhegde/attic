// Notification event tests (Phase 3, milestone 3-2, T-05): the HP tells each client what to notify about
// (file received, transfer delivered or failed, device online or offline), only the clients it concerns,
// live and again on request after being away. The "Acer" is 127.0.0.2, the "ROG Ally" 127.0.0.3.
// Going offline is announced after 0.6 s here instead of 30 s. Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { startServer, stopServer, client, wsOpen, sleep } = require('./test-util');
const { openDb } = require('./db');
const { createEvents } = require('./events');

const PORT = 27000 + Math.floor(Math.random() * 1000);
const MASTER = { displayName: 'Sanketh', username: 'sanketh', password: 'master-pass-1' };
const GUEST = { displayName: 'Guest', username: 'guest', password: 'guest-pass-1', deviceType: 'laptop' };
let tmp, server, env, hp, acer, ally, guest, acerId, allyId, acerToken, allyToken;

const start = async () => { server = await startServer(env); };
const agent = (from, token) => wsOpen(PORT, from, { query: '?role=agent', headers: { 'X-Attic-Device': token } });
const acerAgent = () => agent('127.0.0.2', acerToken);
const allyAgent = () => agent('127.0.0.3', allyToken);
const asAlly = () => ({ 'X-Attic-Device': allyToken });
const isEvent = (kind, test = () => true) => m => m.type === 'event' && m.event.kind === kind && test(m.event);
async function ready(a) { await a.next('hello'); await a.next('inbox'); return (await a.next('events')).last; }
async function pair(c, name, kind) {
  const code = (await hp.call('POST', '/api/pairing/codes')).json.code;
  return (await c.call('POST', '/api/pairing/claim', { code, name, kind })).json.device.id;
}
// Acer → Ally, collected by the Ally, so it ends "done".
async function deliver(fileName, size = 64) {
  const t = (await acer.call('POST', '/api/transfers', { to: allyId, fileName, size })).json;
  await acer.upload(`/api/transfers/${t.id}/file`, size);
  await ally.download(`/api/transfers/${t.id}/file`, asAlly());
  await ally.call('POST', `/api/transfers/${t.id}/received`, {}, asAlly());
  return t.id;
}
// Asserts nothing matching arrives within `ms`.
const nothing = (ws, test, ms = 400) => assert.rejects(ws.next(test, ms), /no matching message/);

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-ev-'));
  fs.mkdirSync(path.join(tmp, 'share'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ host: '127.0.0.1', shares: [{ id: 'main', name: 'Main', rootPath: path.join(tmp, 'share') }] }));
  env = { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(PORT), ATTIC_OFFLINE_AFTER_MS: '600' };
  await start();
  hp = client(PORT, '127.0.0.1');
  await hp.call('POST', '/api/setup', MASTER);
  await hp.call('POST', '/api/session', Object.assign({ mode: 'master' }, MASTER));
  await hp.call('POST', '/api/accounts', GUEST);
  acer = client(PORT, '127.0.0.2'); ally = client(PORT, '127.0.0.3');
  acerId = await pair(acer, 'Acer Aspire 5', 'laptop');
  allyId = await pair(ally, 'ASUS ROG Ally', 'handheld');
  acerToken = decodeURIComponent(acer.jar.attic_device);
  allyToken = decodeURIComponent(ally.jar.attic_device);
  await acer.call('POST', '/api/session', Object.assign({ mode: 'master' }, MASTER));
  // The guest signs in on the Ally.
  guest = client(PORT, '127.0.0.3');
  guest.jar.attic_device = ally.jar.attic_device;
  await guest.call('POST', '/api/session', { mode: 'device', username: GUEST.username, password: GUEST.password });
});
test.after(async () => {
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---------- transfers ----------
test('a delivered file: "File received" to the receiving device, "File delivered" to the sender, nothing to anyone else', async () => {
  const a = await acerAgent(), b = await allyAgent();
  await ready(a); await ready(b);
  const master = await wsOpen(PORT, '127.0.0.1', { cookie: hp.cookieHeader() }); await master.next('devices'); // the master, on the HP
  const g = await wsOpen(PORT, '127.0.0.3', { cookie: guest.cookieHeader() }); await g.next('devices');      // the guest, on the Ally
  const id = await deliver('Trip to Coorg.zip');
  const got = (await b.next(isEvent('transfer.received'))).event;
  assert.strictEqual(got.title, 'File received');
  assert.strictEqual(got.body, 'Trip to Coorg.zip from Acer Aspire 5 is in your Hub Inbox.');
  assert.strictEqual(got.transferId, id);
  assert.ok(got.seq > 0 && got.at);
  const done = (await a.next(isEvent('transfer.done'))).event;
  assert.strictEqual(done.body, 'Trip to Coorg.zip reached ASUS ROG Ally.');
  // The sender's account hears it on any device it's signed in on (here the HP, where the master is too).
  assert.strictEqual((await master.next(isEvent('transfer.done'))).event.seq, done.seq);
  // The interface open on the Ally hears the Ally's news.
  assert.strictEqual((await g.next(isEvent('transfer.received'))).event.seq, got.seq);
  // …and nobody hears what isn't theirs.
  await nothing(a, isEvent('transfer.received'));
  await nothing(b, isEvent('transfer.done'));
  await nothing(g, isEvent('transfer.done'));
  for (const w of [a, b, master, g]) w.close();
  await sleep(100);
});

test('a failed delivery: "Transfer failed" to the sender, with the reason', async () => {
  const a = await acerAgent(); await ready(a);
  const t = (await acer.call('POST', '/api/transfers', { to: allyId, fileName: 'Save backup.7z', size: 32 })).json;
  await acer.upload(`/api/transfers/${t.id}/file`, 32);
  await ally.call('POST', `/api/transfers/${t.id}/failed`, { error: 'Not enough space on C:' }, asAlly());
  const ev = (await a.next(isEvent('transfer.failed'))).event;
  assert.strictEqual(ev.title, 'Transfer failed');
  assert.strictEqual(ev.body, 'Save backup.7z to ASUS ROG Ally didn’t arrive: Not enough space on C:.');
  // A cancel is the sender's own doing: no notification.
  const c = (await acer.call('POST', '/api/transfers', { to: allyId, fileName: 'never.bin', size: 8 })).json;
  await acer.call('DELETE', '/api/transfers/' + c.id);
  await nothing(a, m => m.type === 'event' && m.event.transferId === c.id);
  a.close();
  await sleep(100);
});

// ---------- devices ----------
test('a device that goes away is announced offline to the others after the grace period, and online when it\'s back', async () => {
  const a = await acerAgent(), b = await allyAgent();
  await ready(a); await ready(b);
  b.close();
  const off = (await a.next(isEvent('device.offline'), 3000)).event;
  assert.strictEqual(off.title, 'ASUS ROG Ally is offline');
  assert.strictEqual(off.deviceId, allyId);
  const b2 = await allyAgent(); await ready(b2);
  assert.strictEqual((await a.next(isEvent('device.online'), 3000)).event.title, 'ASUS ROG Ally is online');
  await nothing(b2, isEvent('device.online'), 300); // not told about itself
  a.close(); b2.close();
  await sleep(100);
});

test('a quick reconnect, or a second "online", says nothing', async () => {
  const a = await acerAgent(), b = await allyAgent();
  await ready(a); await ready(b);
  b.close();
  await sleep(150);
  const b2 = await allyAgent(); await ready(b2);
  await nothing(a, m => m.type === 'event' && m.event.kind.startsWith('device.'), 1200);
  a.close(); b2.close();
  await sleep(100);
});

// ---------- catching up ----------
test('a client that was away gets what it missed, and only what was for it', async () => {
  const start = (await ally.call('GET', '/api/events', undefined, asAlly())).json;
  assert.deepStrictEqual(start.events, []);
  assert.ok(start.last >= 1, 'just the newest number, to start from');
  // The Ally is away; a file arrives for it and the Acer's transfer fails.
  const id = await deliver('While away.zip');
  const all = (await ally.call('GET', '/api/events?after=0', undefined, asAlly())).json;
  assert.ok(all.events.every((e, i) => i === 0 || all.events[i - 1].seq < e.seq), 'oldest first');
  assert.ok(all.events.some(e => e.kind === 'transfer.received' && e.transferId === id));
  assert.ok(!all.events.some(e => e.kind === 'transfer.done' || e.kind === 'transfer.failed'), 'the Acer’s news isn’t the Ally’s');
  assert.ok(!all.events.some(e => e.kind.startsWith('device.') && e.deviceId === allyId), 'nor its own coming and going');
  const after = (await ally.call('GET', `/api/events?after=${start.last}`, undefined, asAlly())).json.events;
  assert.deepStrictEqual(after.map(e => e.kind), ['transfer.received']);
  // A page at a time.
  const p1 = (await ally.call('GET', '/api/events?after=0&limit=1', undefined, asAlly())).json;
  assert.strictEqual(p1.events.length, 1);
  assert.strictEqual(p1.more, true);
  // The sender's account, signed in (on the Acer), sees its "delivered".
  assert.ok((await acer.call('GET', '/api/events?after=0')).json.events.some(e => e.kind === 'transfer.done' && e.transferId === id));
  // An unpaired machine gets nothing.
  assert.strictEqual((await client(PORT, '127.0.0.9').call('GET', '/api/events?after=0')).json.code, 'NOT_PAIRED');
});

test('after an HP restart the events are still there, and the agents reconnecting cause no notifications', async () => {
  const before = (await acer.call('GET', '/api/events?after=0')).json.events;
  await stopServer(server);
  await start();
  const a = await acerAgent(), b = await allyAgent();
  const last = await ready(a); await ready(b);
  assert.ok(last >= before[before.length - 1].seq);
  assert.deepStrictEqual((await acer.call('GET', '/api/events?after=0')).json.events.map(e => e.seq), before.map(e => e.seq));
  await nothing(a, m => m.type === 'event', 1200);
  a.close(); b.close();
});

// ---------- the module on its own ----------
test('events older than 7 days are dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-ev-unit-'));
  const db = openDb(dir);
  try {
    const ev = createEvents({ db });
    ev.emit('device.online', { title: 'x', body: 'y', toDevices: '*', toAccounts: '*' });
    ev.prune(Date.now() + 8 * 864e5);
    assert.deepStrictEqual(ev.since({ deviceId: 'd' }, 0).events, []);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
