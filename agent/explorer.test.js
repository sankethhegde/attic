// Tests for agent/explorer.js, inbox.checkFolder and the 3-3 preferences. Run: node --test "agent/*.test.js"
// desktop/scripts/shortcuts-test.mjs checks the real tool, and with the packaged exe the real registry entry.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const explorer = require('./explorer.js');
const inbox = require('./inbox.js');
const prefs = require('./prefs.js');

test('the right-click entry: for files and folders, per user, running this exe with --send', () => {
  const exe = 'C:\\Program Files\\Attic Hub\\Attic Hub.exe';
  const e = explorer.entries(exe);
  assert.deepStrictEqual(e.filter(x => x[0].endsWith('\\command')).map(x => x[0]),
    ['HKCU\\Software\\Classes\\*\\shell\\AtticHub\\command', 'HKCU\\Software\\Classes\\Directory\\shell\\AtticHub\\command']);
  assert.ok(e.every(([key]) => key.startsWith('HKCU\\')), 'no machine-wide keys');
  assert.strictEqual(e.find(x => x[0].endsWith('\\command'))[2], `"${exe}" --send "%1"`);
  assert.strictEqual(e.find(x => x[1] === null && !x[0].endsWith('command'))[2], 'Send to Attic Hub');
});

test('paths are read from a --send launch, and nothing else', () => {
  assert.deepStrictEqual(explorer.sendPaths(['Attic Hub.exe', '--send', 'C:\\a b\\x.jpg']), ['C:\\a b\\x.jpg']);
  assert.deepStrictEqual(explorer.sendPaths(['electron.exe', '.', '--send', 'C:\\x.jpg', '--remote-debugging-port=1']), ['C:\\x.jpg']);
  // Chromium can move the app's own "." after --send: only full paths count.
  assert.deepStrictEqual(explorer.sendPaths(['electron.exe', '--send', '.', 'C:\\x.jpg', 'relative\\y.jpg', '\\\\nas\\share\\z.jpg']), ['C:\\x.jpg', '\\\\nas\\share\\z.jpg']);
  assert.deepStrictEqual(explorer.sendPaths(['Attic Hub.exe', '--hidden']), []);
});

test('a chosen inbox folder must be a full path this PC can write to', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'attic-inbox-')), 'New inbox');
  assert.strictEqual(await inbox.checkFolder(dir), dir);
  assert.ok(fs.existsSync(dir) && fs.readdirSync(dir).length === 0, 'made, and left empty');
  await assert.rejects(inbox.checkFolder('Inbox'), /full folder path/);
});

test('prefs: the inbox folder and the Explorer entry are kept; the server has no Explorer entry by default', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'attic-prefs-')), 'prefs.json');
  const s = prefs.store(file);
  assert.deepStrictEqual([s.load('client').inboxDir, s.load('client').explorerMenu, s.load('server').explorerMenu], [null, true, false]);
  s.save({ inboxDir: 'D:\\Inbox', explorerMenu: false }, 'client');
  assert.deepStrictEqual([s.load('client').inboxDir, s.load('client').explorerMenu], ['D:\\Inbox', false]);
  s.save({ inboxDir: null }, 'client');
  assert.strictEqual(s.load('client').inboxDir, null);
});
