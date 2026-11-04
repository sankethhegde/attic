// Tests for agent/notify.js and agent/prefs.js. Run: node --test "agent/*.test.js"
// desktop/scripts/tray-test.mjs checks the real tray, start-up and notifications in the tool.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createNotifier, fmtBytes } = require('./notify.js');
const prefs = require('./prefs.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function harness(enabled = true) {
  const shown = [], revealed = [], opened = [];
  const n = createNotifier({ windowMs: 30, enabled: () => enabled,
    show: (title, body, onClick) => shown.push({ title, body, onClick }), reveal: p => revealed.push(p), openInbox: () => opened.push(1) });
  return { n, shown, revealed, opened };
}

test('one file: its name, size and sender; clicking shows it in File Explorer', async () => {
  const { n, shown, revealed } = harness();
  n.received({ path: 'C:\\Inbox\\Trip.zip', size: 2.5 * 1024 * 1024, fromName: 'ROG Ally' });
  await sleep(60);
  assert.strictEqual(shown.length, 1);
  assert.strictEqual(shown[0].title, 'File received from ROG Ally');
  assert.strictEqual(shown[0].body, 'Trip.zip · 2.5 MB · in your Hub Inbox');
  shown[0].onClick();
  assert.deepStrictEqual(revealed, ['C:\\Inbox\\Trip.zip']);
});

test('files arriving together become one notification that opens the inbox', async () => {
  const { n, shown, opened } = harness();
  for (const name of ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']) n.received({ path: 'C:\\Inbox\\' + name, size: 1024, fromName: 'Acer' });
  await sleep(60);
  assert.strictEqual(shown.length, 1);
  assert.strictEqual(shown[0].title, '4 files received from Acer');
  assert.strictEqual(shown[0].body, 'a.jpg, b.jpg and 2 more · 4.0 KB');
  shown[0].onClick();
  assert.strictEqual(opened.length, 1);
});

test('nothing is shown when received-file notifications are turned off', async () => {
  const { n, shown } = harness(false);
  n.received({ path: 'x.txt', size: 1 });
  await sleep(60);
  assert.strictEqual(shown.length, 0);
});

test('fmtBytes', () => {
  assert.deepStrictEqual([fmtBytes(5), fmtBytes(2048), fmtBytes(3 * 1024 ** 3)], ['5 bytes', '2.0 KB', '3.0 GB']);
});

function feedHarness({ missed = [], enabledGroups = ['transfers', 'devices'], last = null } = {}) {
  const shown = [], asked = [];
  let seen = last;
  const f = require('./notify.js').createEventFeed({
    fetchEvents: async after => { asked.push(after); const ev = missed.filter(e => e.seq > after); return { events: ev, last: ev.length ? ev[ev.length - 1].seq : after, more: false }; },
    getLast: () => seen, setLast: s => { seen = s; }, show: (title, body) => shown.push(title), enabled: g => enabledGroups.includes(g)
  });
  return { f, shown, asked, seen: () => seen };
}
const ev = (seq, kind, title) => ({ seq, kind, title, body: title + ' body', at: new Date().toISOString() });

test('HP events: shown live, once each; a received file is only marked as seen', async () => {
  const { f, shown, seen } = feedHarness({ last: 10 });
  f.handle({ type: 'event', event: ev(11, 'transfer.done', 'File delivered') });
  f.handle({ type: 'event', event: ev(11, 'transfer.done', 'File delivered') }); // the same one again
  f.handle({ type: 'event', event: ev(12, 'transfer.received', 'File received') });
  f.handle({ type: 'event', event: ev(13, 'device.offline', 'ASUS ROG Ally is offline') });
  assert.deepStrictEqual(shown, ['File delivered', 'ASUS ROG Ally is offline']);
  assert.strictEqual(seen(), 13);
});

test('HP events: the first connect shows nothing old; later connects catch up on what was missed', async () => {
  const fresh = feedHarness();
  await fresh.f.handle({ type: 'events', last: 40 });
  assert.deepStrictEqual([fresh.shown, fresh.asked, fresh.seen()], [[], [], 40]);
  const back = feedHarness({ last: 40, missed: [ev(41, 'transfer.failed', 'Transfer failed'), ev(42, 'device.online', 'ASUS ROG Ally is online')] });
  await back.f.handle({ type: 'events', last: 42 });
  assert.deepStrictEqual([back.shown, back.asked, back.seen()], [['Transfer failed', 'ASUS ROG Ally is online'], [40], 42]);
});

test('HP events: a long backlog becomes one summary, and switched-off kinds are skipped', async () => {
  const many = [41, 42, 43, 44, 45].map(s => ev(s, 'transfer.done', 'File delivered ' + s));
  const a = feedHarness({ last: 40, missed: many });
  await a.f.handle({ type: 'events', last: 45 });
  assert.deepStrictEqual(a.shown, ['5 updates while Attic Hub was closed']);
  const b = feedHarness({ last: 50, enabledGroups: ['transfers'] });
  b.f.handle({ type: 'event', event: ev(51, 'device.offline', 'Acer is offline') });
  assert.deepStrictEqual([b.shown, b.seen()], [[], 51]);
});

test('prefs: a client starts with Windows by default, the server doesn’t; changes are kept', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'attic-prefs-')), 'prefs.json');
  const s = prefs.store(file);
  assert.strictEqual(s.load('client').startWithWindows, true);
  assert.strictEqual(s.load('server').startWithWindows, false);
  s.save({ startWithWindows: false, notify: { received: false }, junk: 1 }, 'client');
  const p = prefs.store(file).load('client');
  assert.deepStrictEqual([p.startWithWindows, p.notify.received, p.junk], [false, false, undefined]);
});
