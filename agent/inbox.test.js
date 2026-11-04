// Tests for agent/inbox.js and agent/receiver.js. Run: node --test "agent/*.test.js"
// The receiver runs against a stand-in for the HP's transfer routes; desktop/scripts/send-test.mjs runs
// the real tool against the real server.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const inbox = require('./inbox.js');
const { createReceiver } = require('./receiver.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'attic-inbox-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('the default inbox is in Downloads', () => {
  assert.strictEqual(inbox.defaultFolder('C:\\Users\\A'), path.join('C:\\Users\\A', 'Downloads', 'Attic Hub Inbox'));
});

test('names are made safe for Windows', () => {
  assert.strictEqual(inbox.safeName('report.pdf'), 'report.pdf');
  assert.strictEqual(inbox.safeName('a<b>c:d"e|f?g*.txt'), 'a_b_c_d_e_f_g_.txt');
  assert.strictEqual(inbox.safeName('..\\..\\evil.exe'), '.._.._evil.exe');
  assert.strictEqual(inbox.safeName('notes.  '), 'notes');
  assert.strictEqual(inbox.safeName('CON.txt'), '_CON.txt');
  assert.strictEqual(inbox.safeName('ಹಬ್ಬದ ವಿಡಿಯೋ.mp4'), 'ಹಬ್ಬದ ವಿಡಿಯೋ.mp4');
  assert.strictEqual(inbox.safeName('..'), 'file');
  const long = inbox.safeName('x'.repeat(300) + '.jpeg');
  assert.ok(long.length <= 200 && long.endsWith('.jpeg'));
});

test('a finished download is placed under a unique name, never overwriting', async () => {
  const dir = tmp();
  for (const body of ['one', 'two']) {
    const part = await inbox.partialPath(dir, 'tr_' + body);
    fs.writeFileSync(part, body);
    await inbox.place(dir, 'hello.txt', part);
  }
  assert.strictEqual(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8'), 'one');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'hello (2).txt'), 'utf8'), 'two');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, inbox.PARTIAL)), []);
});

// A stand-in for the HP's delivery routes. `cutFirst`: the first download stops after that many bytes.
function fakeHP(files, { cutFirst = null } = {}) {
  const calls = [];
  let cut = cutFirst;
  const srv = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}${req.headers.range ? ' ' + req.headers.range : ''} ${req.headers['x-attic-device'] || ''}`);
    const m = /^\/api\/transfers\/([^/]+)\/(file|received|failed)$/.exec(req.url);
    const body = m && files[m[1]];
    if (!m || body == null) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"code":"NOT_FOUND"}'); }
    if (m[2] !== 'file') { req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    const from = req.headers.range ? Number(/bytes=(\d+)-/.exec(req.headers.range)[1]) : 0;
    const slice = Buffer.from(body).subarray(from);
    res.writeHead(from ? 206 : 200, { 'Content-Length': slice.length });
    if (cut != null) { const n = cut; cut = null; res.write(slice.subarray(0, n)); return setTimeout(() => res.destroy(), 20); }
    res.end(slice);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, calls, server: { address: '127.0.0.1', port: srv.address().port } })));
}
const waitFor = async (cond, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(10); } return false; };

test('the receiver downloads with the device token, places the file and confirms it', async () => {
  const dir = tmp();
  const hp = await fakeHP({ tr_a: 'hello world' });
  const events = [];
  const r = createReceiver({ server: hp.server, token: 'tok', dir, onEvent: e => events.push(e) });
  r.add([{ id: 'tr_a', fileName: 'greeting.txt', size: 11 }]);
  r.add([{ id: 'tr_a', fileName: 'greeting.txt', size: 11 }]); // the inbox list again: no second copy
  assert.ok(await waitFor(() => events.some(e => e.type === 'received')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'greeting.txt'), 'utf8'), 'hello world');
  assert.deepStrictEqual(hp.calls, ['GET /api/transfers/tr_a/file tok', 'POST /api/transfers/tr_a/received tok']);
  hp.srv.close();
});

test('a dropped download resumes from where it stopped', async () => {
  const dir = tmp();
  const body = 'abcdefghijklmnopqrstuvwxyz'.repeat(100);
  const hp = await fakeHP({ tr_b: body }, { cutFirst: 1000 });
  const events = [];
  const r = createReceiver({ server: hp.server, token: 'tok', dir, retries: [20, 20], onEvent: e => events.push(e) });
  r.add([{ id: 'tr_b', fileName: 'letters.txt', size: body.length }]);
  assert.ok(await waitFor(() => events.some(e => e.type === 'received')));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'letters.txt'), 'utf8'), body);
  assert.ok(hp.calls.some(c => c.includes('bytes=1000-')), hp.calls.join('\n'));
  hp.srv.close();
});

test('a transfer the HP no longer has is dropped, leaving nothing', async () => {
  const dir = tmp();
  const hp = await fakeHP({});
  const events = [];
  const r = createReceiver({ server: hp.server, token: 'tok', dir, onEvent: e => events.push(e) });
  r.add([{ id: 'tr_gone', fileName: 'x.txt', size: 5 }]);
  assert.ok(await waitFor(() => events.some(e => e.type === 'cancelled')));
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, inbox.PARTIAL)), []);
  assert.ok(!fs.readdirSync(dir).includes('x.txt'));
  hp.srv.close();
});

test('cancelling a queued transfer skips it', async () => {
  const dir = tmp();
  const hp = await fakeHP({ tr_1: 'first', tr_2: 'second' });
  const events = [];
  const r = createReceiver({ server: hp.server, token: 'tok', dir, onEvent: e => events.push(e) });
  r.add([{ id: 'tr_1', fileName: 'one.txt', size: 5 }, { id: 'tr_2', fileName: 'two.txt', size: 6 }]);
  r.cancel('tr_2');
  assert.ok(await waitFor(() => events.some(e => e.type === 'received')));
  await sleep(50);
  assert.ok(fs.existsSync(path.join(dir, 'one.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'two.txt')));
  assert.ok(!hp.calls.some(c => c.includes('tr_2')));
  hp.srv.close();
});
