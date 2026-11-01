// Milestone 6 tests: the file index behind Photos, Videos, Other and the Dashboard; previews served in
// place; and editing shares from Settings. Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const PORT = 21000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let server, tmp, share, second, outside, master, phone, ids = {};

function start() {
  server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'inherit']
  });
  return new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('Shares:')) resolve(); });
    server.on('exit', code => reject(new Error('server exited ' + code)));
  });
}
function stop() { return new Promise(r => { server.removeAllListeners('exit'); server.on('exit', r); server.kill(); }); }

function client() {
  let cookie = null;
  return async function call(method, url, body, headers) {
    const h = Object.assign({}, headers);
    if (cookie) h.Cookie = cookie;
    if (body !== undefined && !Buffer.isBuffer(body)) h['Content-Type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? null : v; }
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* a file */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
}
const fileUrl = (s, p, inline) => `/api/shares/${s}/file?path=${encodeURIComponent(p)}${inline ? '&inline=1' : ''}`;
const names = r => r.body.entries.map(e => (e.path ? e.path + '/' : '') + e.name).sort();

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-index-'));
  share = path.join(tmp, 'main'); second = path.join(tmp, 'second'); outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(share, 'Photos', 'Goa'), { recursive: true });
  fs.mkdirSync(path.join(share, 'Phone'), { recursive: true });
  fs.mkdirSync(second); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(share, 'Photos', 'Goa', 'beach.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
  fs.writeFileSync(path.join(share, 'notes.txt'), 'notes');
  fs.writeFileSync(path.join(share, 'page.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(share, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(share, '~attic-0123abcd.part'), 'an upload in flight');
  fs.writeFileSync(path.join(second, 'clip.mp4'), 'not really a video');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
  fs.symlinkSync(outside, path.join(share, 'escape'), 'junction');
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 1, host: '127.0.0.1', shares: [
    { id: 'main', name: 'Main', rootPath: share, deviceType: 'hdd' },
    { id: 'second', name: 'Second', rootPath: second, deviceType: 'ssd' },
    { id: 'gone', name: 'Unplugged', rootPath: path.join(tmp, 'missing'), deviceType: 'external' }] }, null, 2));
  await start();
  master = client(); phone = client();
  await master('POST', '/api/setup', { displayName: 'M', username: 'master', password: 'master-pass' });
  await master('POST', '/api/session', { mode: 'master', username: 'master', password: 'master-pass' });
  ids.phone = (await master('POST', '/api/accounts', { displayName: 'P', username: 'phone', password: 'phone-pass', deviceType: 'phone' })).body.id;
  await phone('POST', '/api/session', { mode: 'device', username: 'phone', password: 'phone-pass', stay: true });
});
test.after(async () => {
  if (server && server.exitCode === null) await stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('the index lists every file in every available share, nested, for the master', async () => {
  const r = await master('GET', '/api/files');
  assert.strictEqual(r.status, 200);
  assert.ok(!Number.isNaN(Date.parse(r.body.generatedAt)));
  assert.deepStrictEqual(names(r), ['Photos/Goa/beach.jpg', 'clip.mp4', 'logo.svg', 'notes.txt', 'page.html']);
  const beach = r.body.entries.find(e => e.name === 'beach.jpg');
  assert.strictEqual(beach.share, 'main');
  assert.strictEqual(beach.path, 'Photos/Goa');
  assert.strictEqual(beach.size, 4);
  assert.strictEqual(beach.ownerId, 'acc_master');
  assert.ok(beach.id.startsWith('r:'));
});

test('each share says which drive it is on, so shared drives are counted once', async () => {
  const list = (await master('GET', '/api/shares')).body;
  const main = list.find(s => s.id === 'main'), second = list.find(s => s.id === 'second');
  assert.match(main.drive, /^[A-Z]:\\$/);
  assert.strictEqual(main.drive, second.drive); // both test shares live in the same temp folder
});

test('the index leaves out junctions, uploads in flight, and unplugged shares', async () => {
  const all = names(await master('GET', '/api/files')).join(' ');
  assert.ok(!all.includes('secret.txt'), 'followed a junction');
  assert.ok(!all.includes('~attic-'), 'listed a temp upload');
});

test('a device\'s index holds only its own files; an upload shows up at once', async () => {
  assert.deepStrictEqual((await phone('GET', '/api/files')).body.entries, []);
  const up = await phone('PUT', fileUrl('main', 'Phone/selfie.jpg'), Buffer.from('me'), { 'X-Attic-Upload': '1' });
  assert.strictEqual(up.status, 201);
  assert.deepStrictEqual(names(await phone('GET', '/api/files')), ['Phone/selfie.jpg']);
  assert.ok(names(await master('GET', '/api/files')).includes('Phone/selfie.jpg'));
});

test('fresh=1 reads the drives again, so files added outside Attic appear', async () => {
  await master('GET', '/api/files'); // cached
  fs.writeFileSync(path.join(second, 'added-in-explorer.mp3'), 'x');
  assert.ok(names(await master('GET', '/api/files?fresh=1')).includes('added-in-explorer.mp3'));
});

test('signed out gets no index', async () => {
  assert.strictEqual((await fetch(BASE + '/api/files')).status, 401);
});

test('previews: photos and video play in place; HTML and SVG never do', async () => {
  const jpg = await master('GET', fileUrl('main', 'Photos/Goa/beach.jpg', true));
  assert.strictEqual(jpg.headers.get('content-type'), 'image/jpeg');
  assert.match(jpg.headers.get('content-disposition'), /^inline;/);
  assert.match(jpg.headers.get('content-security-policy'), /sandbox/);
  const mp4 = await master('GET', fileUrl('second', 'clip.mp4', true));
  assert.strictEqual(mp4.headers.get('content-type'), 'video/mp4');
  for (const p of ['page.html', 'logo.svg', 'notes.txt']) {
    const r = await master('GET', fileUrl('main', p, true));
    assert.strictEqual(r.headers.get('content-type'), 'application/octet-stream', p);
    assert.match(r.headers.get('content-disposition'), /^attachment;/, p);
  }
  // Without inline=1 even a photo downloads.
  assert.match((await master('GET', fileUrl('main', 'Photos/Goa/beach.jpg'))).headers.get('content-disposition'), /^attachment;/);
});

test('a device can preview its own photo but not anyone else\'s', async () => {
  assert.strictEqual((await phone('GET', fileUrl('main', 'Phone/selfie.jpg', true))).status, 200);
  assert.strictEqual((await phone('GET', fileUrl('main', 'Photos/Goa/beach.jpg', true))).status, 404);
});

test('shares: drive roots, relative paths and overlapping folders are refused', async () => {
  for (const [rootPath, status] of [['D:\\', 400], ['C:', 400], ['Shared', 400], ['\\\\nas\\photos', 400],
    [share, 409], [path.join(share, 'Photos'), 409], [tmp, 409]]) {
    const r = await master('POST', '/api/shares', { name: 'X', rootPath, deviceType: 'hdd' });
    assert.strictEqual(r.status, status, rootPath);
  }
  assert.strictEqual((await master('POST', '/api/shares', { name: '', rootPath: path.join(tmp, 'n'), deviceType: 'hdd' })).status, 400);
});

test('shares: only the master edits them', async () => {
  assert.strictEqual((await phone('POST', '/api/shares', { name: 'Mine', rootPath: path.join(tmp, 'mine') })).status, 403);
  assert.strictEqual((await phone('PUT', '/api/shares/main', { name: 'Mine', rootPath: share })).status, 403);
  assert.strictEqual((await phone('DELETE', '/api/shares/main', {})).status, 403);
});

test('shares: add, rename and remove, saved to config.json and kept across a restart', async () => {
  const music = path.join(tmp, 'music');
  fs.mkdirSync(music);
  fs.writeFileSync(path.join(music, 'song.mp3'), 'la');
  const added = await master('POST', '/api/shares', { name: 'Music library', rootPath: music, deviceType: 'external' });
  assert.strictEqual(added.status, 201);
  assert.strictEqual(added.body.id, 'music-library');
  assert.strictEqual(added.body.available, true);
  assert.ok(names(await master('GET', '/api/files')).includes('song.mp3'));

  const renamed = await master('PUT', '/api/shares/music-library', { name: 'Music', rootPath: music, deviceType: 'external' });
  assert.strictEqual(renamed.body.id, 'music-library'); // the id stays, so ownership records still match
  assert.strictEqual(renamed.body.name, 'Music');

  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  assert.strictEqual(cfg.port, 1, 'port and host must survive the rewrite');
  assert.strictEqual(cfg.shares.find(s => s.id === 'music-library').name, 'Music');

  await stop(); await start();
  assert.ok((await master('GET', '/api/shares')).body.some(s => s.id === 'music-library' && s.name === 'Music'));

  assert.strictEqual((await master('DELETE', '/api/shares/second', {})).status, 200);
  assert.ok(!(await master('GET', '/api/shares')).body.some(s => s.id === 'second'));
  assert.ok(!names(await master('GET', '/api/files')).includes('clip.mp4'));
  assert.ok(fs.existsSync(path.join(second, 'clip.mp4')), 'removing a share must not touch the disk');
  assert.strictEqual((await master('GET', fileUrl('second', 'clip.mp4'))).status, 404);
});
