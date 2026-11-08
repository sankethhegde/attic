// Tests for Phase 5 (5-1, 5-3): People Portfolio's routes on the HP (people.js). Run: node --test "server/*.test.js"
// The "People Portfolio page" is a request with its Origin header and the key; the master sets things up
// through the usual signed-in session.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { startServer, stopServer, client } = require('./test-util');
const { exifThumbnail, normalizeOrigin, saveName, KEEP } = require('./people');

const PORT = 33000 + Math.floor(Math.random() * 1000);
const PAGE = 'http://localhost:5173';
let tmp, server, hp, key;

// A JPEG with an EXIF thumbnail (IFD1), the way cameras and phones write one.
function jpegWithThumb(thumb) {
  const tiff = Buffer.alloc(44 + thumb.length);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(0, 8); tiff.writeUInt32LE(14, 10);           // IFD0: no entries, next IFD at 14
  tiff.writeUInt16LE(2, 14);                                       // IFD1: two entries
  tiff.writeUInt16LE(0x0201, 16); tiff.writeUInt16LE(4, 18); tiff.writeUInt32LE(1, 20); tiff.writeUInt32LE(44, 24);
  tiff.writeUInt16LE(0x0202, 28); tiff.writeUInt16LE(4, 30); tiff.writeUInt32LE(1, 32); tiff.writeUInt32LE(thumb.length, 36);
  tiff.writeUInt32LE(0, 40);
  thumb.copy(tiff, 44);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, 0]), Buffer.from('Exif\0\0', 'latin1'), tiff]);
  app1.writeUInt16BE(app1.length - 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xda, 0, 2]), Buffer.alloc(5000, 0x55), Buffer.from([0xff, 0xd9])]);
}
const THUMB = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from('a tiny preview'), Buffer.from([0xff, 0xd9])]);

// The People Portfolio page: its address, and the key.
function page(method, url, { body, origin = PAGE, k = key, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, origin ? { Origin: origin } : {}, k ? { 'X-Attic-Key': k } : {}, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, headers);
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: url, headers: h }, async res => {
      const chunks = []; for await (const c of res) chunks.push(c);
      const buf = Buffer.concat(chunks); let json = null; try { json = JSON.parse(buf.toString()); } catch (e) { /* not JSON */ }
      resolve({ status: res.statusCode, json, buf, headers: res.headers });
    });
    r.on('error', reject); r.end(data);
  });
}
const exportFile = n => ({ app: 'people-portfolio', version: 1, exportedAt: new Date().toISOString(), labelGroups: [], labels: [], people: [{ id: 'p' + n, name: 'Person ' + n }] });

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-people-'));
  const share = path.join(tmp, 'share');
  fs.mkdirSync(path.join(share, 'Backups', 'People'), { recursive: true });
  fs.mkdirSync(path.join(share, 'Photos', 'Family'), { recursive: true });
  fs.writeFileSync(path.join(share, 'Photos', 'Family', 'IMG_0001.jpg'), jpegWithThumb(THUMB));
  fs.writeFileSync(path.join(share, 'Photos', 'Family', 'plain.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  fs.writeFileSync(path.join(share, 'Photos', 'Family', 'notes.txt'), 'not a photo');
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ host: '127.0.0.1', shares: [{ id: 'main', name: 'Main', rootPath: share }] }));
  server = await startServer({ ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(PORT) });
  hp = client(PORT, '127.0.0.1');
  await hp.call('POST', '/api/setup', { displayName: 'Sanketh', username: 'master', password: 'test1234' });
  await hp.call('POST', '/api/session', { mode: 'master', username: 'master', password: 'test1234' });
});
test.after(async () => { if (server) await stopServer(server); if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });

test('pieces: page addresses, save names, the JPEG’s own thumbnail', () => {
  assert.strictEqual(normalizeOrigin('http://localhost:5173/'), 'http://localhost:5173');
  assert.strictEqual(normalizeOrigin('file:///x'), null);
  assert.strictEqual(normalizeOrigin('javascript:alert(1)'), null);
  const at = new Date(2026, 10, 8, 14, 30, 5);
  assert.strictEqual(saveName(at, new Set()), 'people-2026-11-08_143005.json');
  assert.strictEqual(saveName(at, new Set(['people-2026-11-08_143005.json'])), 'people-2026-11-08_143005-2.json');
  assert.ok(exifThumbnail(jpegWithThumb(THUMB)).equals(THUMB));
  assert.strictEqual(exifThumbnail(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2, 1, 2])), null);
  assert.strictEqual(exifThumbnail(Buffer.from('not a jpeg')), null);
});

test('5-1: the master sets the save folder and page addresses, and makes a key shown once', async () => {
  assert.strictEqual((await hp.call('GET', '/api/people/settings')).json.hasKey, false);
  const bad = await hp.call('PUT', '/api/people/settings', { folder: { shareId: 'main', path: 'No such folder' } });
  assert.strictEqual(bad.status, 404);
  const badOrigin = await hp.call('PUT', '/api/people/settings', { origins: ['not a url'] });
  assert.strictEqual(badOrigin.json.code, 'INVALID');
  const s = await hp.call('PUT', '/api/people/settings', { folder: { shareId: 'main', path: 'Backups/People' }, origins: [PAGE + '/', PAGE] });
  assert.deepStrictEqual([s.status, s.json.folder, s.json.origins], [200, { shareId: 'main', path: 'Backups/People' }, [PAGE]]);
  const k = await hp.call('POST', '/api/people/key');
  assert.strictEqual(k.status, 201);
  key = k.json.key;
  assert.ok(key.length >= 40);
  const after = (await hp.call('GET', '/api/people/settings')).json;
  assert.ok(after.hasKey && !JSON.stringify(after).includes(key), 'the key is never shown again');
  assert.ok(!fs.readFileSync(path.join(tmp, 'data', 'people.json'), 'utf8').includes(key), 'only its hash is kept');
  // Not the master: refused.
  const device = client(PORT, '127.0.0.2');
  assert.notStrictEqual((await device.call('GET', '/api/people/settings')).status, 200);
});

test('the gate: the key, the page’s address, and CORS for the listed page only', async () => {
  const ok = await page('GET', '/api/people/ping');
  assert.deepStrictEqual([ok.status, ok.json.ok, ok.headers['access-control-allow-origin']], [200, true, PAGE]);
  assert.strictEqual((await page('GET', '/api/people/ping', { k: null })).json.code, 'BAD_KEY', 'no key');
  assert.strictEqual((await page('GET', '/api/people/ping', { k: 'wrong' })).json.code, 'BAD_KEY', 'a wrong key');
  const other = await page('GET', '/api/people/ping', { origin: 'http://evil.example' });
  assert.deepStrictEqual([other.status, other.headers['access-control-allow-origin']], [403, undefined]);
  assert.strictEqual((await page('GET', '/api/people/ping', { origin: null })).status, 403, 'no Origin: not a listed page');
  // The browser's preflight: allowed for the page, with the private-network answer Chrome asks for.
  const pre = await page('OPTIONS', '/api/people/data', { k: null, headers: { 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'x-attic-key,content-type', 'Access-Control-Request-Private-Network': 'true' } });
  assert.strictEqual(pre.status, 204);
  assert.match(pre.headers['access-control-allow-headers'], /X-Attic-Key/);
  assert.strictEqual(pre.headers['access-control-allow-private-network'], 'true');
  assert.strictEqual((await page('OPTIONS', '/api/people/data', { origin: 'http://evil.example', k: null })).status, 403);
  // A new key stops the old one.
  const old = key;
  key = (await hp.call('POST', '/api/people/key')).json.key;
  assert.strictEqual((await page('GET', '/api/people/ping', { k: old })).json.code, 'BAD_KEY', 'the old key');
  assert.strictEqual((await page('GET', '/api/people/ping')).status, 200, 'the new key');
});

test('Save, Load and the list: dated files, never overwritten, the newest 30 kept', async () => {
  assert.strictEqual((await page('GET', '/api/people/data')).status, 404, 'nothing saved yet');
  assert.strictEqual((await page('PUT', '/api/people/data', { body: { app: 'something-else' } })).json.code, 'INVALID');
  assert.strictEqual((await page('PUT', '/api/people/data', { body: 'not json' })).json.code, 'INVALID');
  const first = await page('PUT', '/api/people/data', { body: exportFile(0) });
  assert.strictEqual(first.status, 201);
  assert.match(first.json.name, /^people-\d{4}-\d{2}-\d{2}_\d{6}\.json$/);
  const dir = path.join(tmp, 'share', 'Backups', 'People');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, first.json.name), 'utf8')).people[0].name, 'Person 0', 'stored as given');
  for (let n = 1; n <= KEEP; n++) assert.strictEqual((await page('PUT', '/api/people/data', { body: exportFile(n) })).status, 201);
  const saves = (await page('GET', '/api/people/saves')).json;
  assert.strictEqual(saves.length, KEEP, 'the 31st save removed the oldest');
  assert.ok(!saves.some(x => x.name === first.json.name), 'the oldest is the one gone');
  assert.strictEqual(fs.readdirSync(dir).length, KEEP);
  const newest = await page('GET', '/api/people/data');
  assert.strictEqual(newest.json.people[0].name, 'Person ' + KEEP, 'Load brings the newest');
  assert.strictEqual(newest.headers['x-attic-save'], saves[0].name);
  const named = await page('GET', '/api/people/data?name=' + encodeURIComponent(saves[KEEP - 1].name));
  assert.strictEqual(named.json.people[0].name, 'Person 1');
  assert.strictEqual((await page('GET', '/api/people/data?name=..%2F..%2Fconfig.json')).json.code, 'INVALID');
});

test('5-3: shared folders, a folder’s subfolders and photos, a photo, and its small preview', async () => {
  const shares = (await page('GET', '/api/people/folders')).json.shares;
  assert.deepStrictEqual(shares, [{ id: 'main', name: 'Main' }]);
  const top = (await page('GET', '/api/people/folders?share=main&path=Photos')).json;
  assert.deepStrictEqual(top.folders, [{ name: 'Family', path: 'Photos/Family' }]);
  const fam = (await page('GET', '/api/people/folders?share=main&path=Photos%2FFamily')).json;
  assert.deepStrictEqual(fam.photos.map(p => p.ref), ['main/Photos/Family/IMG_0001.jpg', 'main/Photos/Family/plain.png'], 'photos only');
  const full = await page('GET', '/api/people/photo?share=main&path=Photos%2FFamily%2FIMG_0001.jpg');
  assert.deepStrictEqual([full.status, full.headers['content-type'], full.headers['x-content-type-options'], full.headers['access-control-allow-origin']], [200, 'image/jpeg', 'nosniff', PAGE]);
  assert.ok(full.buf.length > 5000);
  const small = await page('GET', '/api/people/photo?share=main&path=Photos%2FFamily%2FIMG_0001.jpg&size=160');
  assert.ok(small.buf.equals(THUMB), 'the JPEG’s own preview');
  assert.strictEqual(small.headers['x-attic-preview'], 'exif');
  const png = await page('GET', '/api/people/photo?share=main&path=Photos%2FFamily%2Fplain.png&size=160');
  assert.strictEqual(png.status, 200, 'no preview inside: the photo itself');
  assert.strictEqual((await page('GET', '/api/people/photo?share=main&path=Photos%2FFamily%2Fnotes.txt')).json.code, 'INVALID', 'not a photo');
  assert.notStrictEqual((await page('GET', '/api/people/photo?share=main&path=..%2F..%2Fconfig.json')).status, 200, 'outside the share');
  assert.strictEqual((await page('GET', '/api/people/photo?share=main&path=Photos%2FFamily%2FIMG_0001.jpg', { k: 'wrong' })).json.code, 'BAD_KEY');
});
