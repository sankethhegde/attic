// Tests for agent/updater.js (3-5, T-10) against a stand-in HP. Run: node --test "agent/*.test.js"
// desktop/scripts/update-test.mjs runs the real tool against the real server, installer and all.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { createUpdater, cmp, isRelease, INSTALL_ARGS } = require('./updater.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(20); } return false; };

// The HP's side: /api/updates/latest and the installer, with Range, optionally cut off part-way.
function standIn(bytes, version = '0.10.0') {
  const release = { version, fileName: `Attic-Hub-Setup-${version}.exe`, size: bytes.length,
    sha512: crypto.createHash('sha512').update(bytes).digest('base64'), notes: 'Faster', url: `/api/updates/files/Attic-Hub-Setup-${version}.exe` };
  const seen = { ranges: [], tokens: [] };
  let cutAt = null, published = true, serve = bytes;
  const srv = http.createServer((req, res) => {
    seen.tokens.push(req.headers['x-attic-device']);
    if (req.url.startsWith('/api/updates/latest')) {
      if (!published) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"code":"NO_UPDATE"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(release));
    }
    if (req.url === release.url) {
      const m = /bytes=(\d+)-/.exec(req.headers.range || '');
      const from = m ? +m[1] : 0;
      seen.ranges.push(from);
      res.writeHead(m ? 206 : 200, { 'Content-Length': serve.length - from });
      if (cutAt !== null && cutAt > from) { res.write(serve.subarray(from, cutAt)); cutAt = null; return setTimeout(() => res.destroy(), 50); }
      return res.end(serve.subarray(from));
    }
    res.writeHead(404); res.end();
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({
    srv, release, seen, base: `http://127.0.0.1:${srv.address().port}/`,
    cut(n) { cutAt = n; }, unpublish() { published = false; }, tamper(b) { serve = b; }
  })));
}
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'attic-upd-'));
const installer = n => Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(n)]);

test('versions compare as numbers, and only a well-formed release counts', () => {
  assert.ok(cmp('0.10.0', '0.9.0') > 0);
  assert.strictEqual(cmp('1.2.3', '1.2.3'), 0);
  assert.ok(cmp('0.9.1', '0.10.0') < 0);
  assert.strictEqual(isRelease({ version: '0.10.0', fileName: 'Attic-Hub-Setup-0.10.0.exe', size: 5, sha512: 'x'.repeat(88) }), true);
  assert.strictEqual(isRelease({ version: '0.10.0', fileName: '..\\evil.exe', size: 5, sha512: 'x'.repeat(88) }), false);
  assert.strictEqual(isRelease(null), false);
});

test('nothing newer, or nothing published: up to date, and nothing is downloaded', async () => {
  const hp = await standIn(installer(1000), '0.9.0');
  const dir = tmpDir();
  const u = createUpdater({ current: '0.9.0', dir, server: () => ({ base: hp.base, headers: { 'X-Attic-Device': 'tok' } }) });
  assert.strictEqual((await u.check()).status, 'current');
  assert.strictEqual(hp.seen.tokens[0], 'tok', 'asks as its paired device');
  hp.unpublish();
  const s = await u.check();
  assert.deepStrictEqual([s.status, s.latest], ['current', null]);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  hp.srv.close();
});

test('a newer release downloads, is checked against its SHA-512, and is ready; older installers go', async () => {
  const bytes = installer(300e3);
  const hp = await standIn(bytes);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'Attic-Hub-Setup-0.8.0.exe'), 'old');
  const states = [];
  const u = createUpdater({ current: '0.9.0', dir, server: () => ({ base: hp.base, headers: {} }), onState: s => states.push(s.status) });
  await u.offer(hp.release); // as the hub announces it
  assert.ok(await until(() => u.state.status === 'ready'), u.state.status + ' ' + u.state.error);
  assert.ok(states.includes('downloading'));
  assert.ok(fs.readFileSync(path.join(dir, hp.release.fileName)).equals(bytes));
  assert.deepStrictEqual(fs.readdirSync(dir), [hp.release.fileName], 'the old installer is gone, and no .part is left');
  const inst = await u.installer();
  assert.deepStrictEqual([inst.file, inst.args, inst.version], [path.join(dir, hp.release.fileName), INSTALL_ARGS, '0.10.0']);
  assert.deepStrictEqual(INSTALL_ARGS, ['/S', '--updated', '--force-run'], 'silent, and Attic Hub starts again afterwards');
  // A second announcement of the same version changes nothing; a new run finds it already downloaded.
  await u.offer(hp.release);
  const again = createUpdater({ current: '0.9.0', dir, server: () => ({ base: hp.base, headers: {} }) });
  await again.offer(hp.release);
  assert.strictEqual(again.state.status, 'ready');
  assert.strictEqual(hp.seen.ranges.length, 1, 'downloaded once');
  hp.srv.close();
});

test('a download cut off part-way resumes from where it stopped', async () => {
  const bytes = installer(500e3);
  const hp = await standIn(bytes);
  const dir = tmpDir();
  const u = createUpdater({ current: '0.9.0', dir, server: () => ({ base: hp.base, headers: {} }) });
  hp.cut(200e3);
  await u.offer(hp.release);
  assert.ok(await until(() => u.state.status === 'error'), u.state.status);
  assert.ok(fs.statSync(path.join(dir, hp.release.fileName + '.part')).size >= 200e3);
  await u.retry();
  assert.ok(await until(() => u.state.status === 'ready'), u.state.error);
  assert.ok(hp.seen.ranges[1] >= 200e3, `asked for the rest from ${hp.seen.ranges[1]}`);
  assert.ok(fs.readFileSync(path.join(dir, hp.release.fileName)).equals(bytes));
  hp.srv.close();
});

test('an installer that doesn’t match the HP’s SHA-512 is deleted, not offered', async () => {
  const bytes = installer(100e3);
  const hp = await standIn(bytes);
  const bad = Buffer.from(bytes); bad[5000] ^= 0xff;
  hp.tamper(bad);
  const dir = tmpDir();
  const u = createUpdater({ current: '0.9.0', dir, server: () => ({ base: hp.base, headers: {} }) });
  await u.offer(hp.release);
  assert.ok(await until(() => u.state.status === 'error'));
  assert.match(u.state.error, /didn’t arrive intact/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.ok((await u.installer()).error);
  hp.srv.close();
});

test('while a game runs (low-resource mode) the download waits, then goes ahead', async () => {
  const hp = await standIn(installer(50e3));
  let gaming = true;
  const u = createUpdater({ current: '0.9.0', dir: tmpDir(), server: () => ({ base: hp.base, headers: {} }), canDownload: () => !gaming });
  await u.offer(hp.release);
  await sleep(100);
  assert.strictEqual(u.state.status, 'waiting');
  assert.strictEqual(hp.seen.ranges.length, 0, 'nothing fetched during the game');
  gaming = false;
  await u.retry();
  assert.ok(await until(() => u.state.status === 'ready'));
  hp.srv.close();
});
