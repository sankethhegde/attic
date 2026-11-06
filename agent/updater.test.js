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

// ---------- GitHub releases (0.12.1): the newest published release first, the HP as the fallback ----------
// A stand-in for GitHub: the API, latest.yml, and the installer, whose download redirects to another host
// (as GitHub's does), so the device token meant for the HP must not follow it.
function standInGitHub(bytes, version, { published = true } = {}) {
  const fileName = `Attic-Hub-Setup-${version}.exe`, sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  const seen = { tokens: [], ranges: [] };
  const srv = http.createServer((req, res) => {
    const port = srv.address().port;
    if (req.url === '/repos/sankethhegde/attic/releases/latest') {
      if (!published) { res.writeHead(404); return res.end('{"message":"Not Found"}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ tag_name: 'v' + version, body: 'From GitHub', published_at: '2026-11-06T10:00:00Z', assets: [
        { name: fileName, size: bytes.length, browser_download_url: `http://127.0.0.1:${port}/download/${fileName}` },
        { name: 'latest.yml', size: 100, browser_download_url: `http://127.0.0.1:${port}/download/latest.yml` }] }));
    }
    if (req.url === '/download/latest.yml') { res.writeHead(200); return res.end(`version: ${version}\nfiles:\n  - url: ${fileName}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${fileName}\nsha512: ${sha512}\n`); }
    if (req.url === `/download/${fileName}`) { res.writeHead(302, { Location: `http://localhost:${port}/cdn/${fileName}` }); return res.end(); }
    if (req.url === `/cdn/${fileName}`) {
      seen.tokens.push(req.headers['x-attic-device'] || null);
      const m = /bytes=(\d+)-/.exec(req.headers.range || ''), from = m ? +m[1] : 0;
      seen.ranges.push(from);
      res.writeHead(m ? 206 : 200, { 'Content-Length': bytes.length - from });
      return res.end(bytes.subarray(from));
    }
    res.writeHead(404); res.end();
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, seen, api: `http://127.0.0.1:${srv.address().port}` })));
}

test('GitHub’s newest published release comes first: found, downloaded through the redirect, checked, ready', async () => {
  const bytes = installer(200e3);
  const gh = await standInGitHub(bytes, '0.12.1');
  const hp = await standIn(installer(1000), '0.11.0'); // the HP is behind
  const dir = tmpDir();
  const u = createUpdater({ current: '0.12.0', dir, server: () => ({ base: hp.base, headers: { 'X-Attic-Device': 'tok' } }),
    github: { api: gh.api, owner: 'sankethhegde', repo: 'attic' } });
  await u.check();
  assert.ok(await until(() => u.state.status === 'ready'), u.state.status + ' ' + u.state.error);
  assert.strictEqual(u.state.latest.version, '0.12.1');
  assert.strictEqual(u.state.latest.notes, 'From GitHub');
  assert.ok(fs.readFileSync(path.join(dir, 'Attic-Hub-Setup-0.12.1.exe')).equals(bytes));
  assert.deepStrictEqual(gh.seen.tokens, [null], 'the HP’s device token isn’t sent to GitHub');
  // The HP announcing its older release over the hub doesn't undo it.
  await u.offer(hp.release);
  assert.strictEqual(u.state.status, 'ready');
  assert.strictEqual(u.state.latest.version, '0.12.1');
  gh.srv.close(); hp.srv.close();
});

test('nothing published on GitHub, or no internet: the HP is asked instead', async () => {
  const gh = await standInGitHub(installer(10), '0.12.1', { published: false });
  const hp = await standIn(installer(50e3), '0.12.2');
  const u = createUpdater({ current: '0.12.0', dir: tmpDir(), server: () => ({ base: hp.base, headers: {} }), github: { api: gh.api, owner: 'sankethhegde', repo: 'attic' } });
  await u.check();
  assert.ok(await until(() => u.state.status === 'ready'), u.state.status + ' ' + u.state.error);
  assert.strictEqual(u.state.latest.version, '0.12.2');
  gh.srv.close();
  const offline = createUpdater({ current: '0.12.0', dir: tmpDir(), server: () => ({ base: hp.base, headers: {} }), github: { api: 'http://127.0.0.1:9', owner: 'sankethhegde', repo: 'attic' } });
  await offline.check();
  assert.ok(await until(() => offline.state.status === 'ready'), offline.state.status + ' ' + offline.state.error);
  // Neither reachable: an error that says so.
  const none = createUpdater({ current: '0.12.0', dir: tmpDir(), server: () => null, github: { api: 'http://127.0.0.1:9', owner: 'sankethhegde', repo: 'attic' } });
  const s = await none.check();
  assert.strictEqual(s.status, 'error');
  hp.srv.close();
});
