// Tests for agent/inbox.js. Run: node --test "agent/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const inbox = require('./inbox.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'attic-inbox-'));
const chunks = (...parts) => Readable.from(parts.map(p => Buffer.from(p)));

test('the default inbox is in Downloads', () => {
  assert.strictEqual(inbox.defaultFolder('C:\\Users\\A'), path.join('C:\\Users\\A', 'Downloads', 'Attic Hub Inbox'));
});

test('names are made safe for Windows', () => {
  assert.strictEqual(inbox.safeName('report.pdf'), 'report.pdf');
  assert.strictEqual(inbox.safeName('a<b>c:d"e|f?g*.txt'), 'a_b_c_d_e_f_g_.txt');
  assert.strictEqual(inbox.safeName('notes.  '), 'notes');
  assert.strictEqual(inbox.safeName('CON.txt'), '_CON.txt');
  assert.strictEqual(inbox.safeName('ಹಬ್ಬದ ವಿಡಿಯೋ.mp4'), 'ಹಬ್ಬದ ವಿಡಿಯೋ.mp4');
  assert.strictEqual(inbox.safeName(''), 'file');
  const long = inbox.safeName('x'.repeat(300) + '.jpeg');
  assert.ok(long.length <= 200 && long.endsWith('.jpeg'));
});

test('a folder path can never leave the inbox', () => {
  assert.deepStrictEqual(inbox.safeRelPath('Trip/day 1/IMG.jpg'), ['Trip', 'day 1', 'IMG.jpg']);
  assert.deepStrictEqual(inbox.safeRelPath('../../Windows/system32/x.dll'), ['Windows', 'system32', 'x.dll']);
  assert.deepStrictEqual(inbox.safeRelPath('C:\\evil\\..\\x.txt'), ['C_', 'evil', 'x.txt']);
  assert.deepStrictEqual(inbox.safeRelPath(''), ['file']);
});

test('receiving writes the file, and never overwrites', async () => {
  const dir = tmp();
  const a = await inbox.receive(dir, 'hello.txt', chunks('hel', 'lo'), { size: 5 });
  const b = await inbox.receive(dir, 'hello.txt', chunks('again'));
  assert.strictEqual(fs.readFileSync(a, 'utf8'), 'hello');
  assert.strictEqual(path.basename(b), 'hello (2).txt');
  assert.strictEqual(fs.readFileSync(b, 'utf8'), 'again');
});

test('a folder transfer keeps its folders, inside the inbox', async () => {
  const dir = tmp();
  const p = await inbox.receive(dir, '../Trip/day 1/a.txt', chunks('x'));
  assert.strictEqual(p, path.join(dir, 'Trip', 'day 1', 'a.txt'));
});

test('a short or broken transfer leaves nothing behind', async () => {
  const dir = tmp();
  await assert.rejects(inbox.receive(dir, 'big.bin', chunks('only part'), { size: 100 }), /Received 9 of 100/);
  const broken = new Readable({ read() { this.push(Buffer.from('abc')); this.destroy(new Error('connection lost')); } });
  await assert.rejects(inbox.receive(dir, 'big.bin', broken), /connection lost/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});
