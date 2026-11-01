// Browse and download tests (Phase 1C, milestone 4), including the brief's "a 2 GB file downloads".
// Starts a real server on a throwaway share. Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const PORT = 19000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const GB2 = 2 * 1024 ** 3;
let server, tmp, share, outside, master, device;

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-files-'));
  share = path.join(tmp, 'share');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(share, 'Trip 2026', 'Goa'), { recursive: true });
  fs.mkdirSync(path.join(share, 'Empty folder'));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(share, 'Trip 2026', 'Goa', 'beach.jpg'), 'not really a jpeg');
  fs.writeFileSync(path.join(share, 'notes.txt'), '0123456789abcdef');
  fs.writeFileSync(path.join(share, 'ಬೆಂಗಳೂರು ಟಿಪ್ಪಣಿ.txt'), 'kannada');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside the share');
  fs.symlinkSync(outside, path.join(share, 'escape'), 'junction'); // no admin needed for a junction
  // 2 GB of zeros. Extending the length allocates without writing, so this takes a moment, not minutes.
  const fd = fs.openSync(path.join(share, 'big.bin'), 'w');
  fs.ftruncateSync(fd, GB2);
  fs.closeSync(fd);

  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ host: '127.0.0.1', shares: [
    { id: 'main', name: 'Main', rootPath: share },
    { id: 'gone', name: 'Unplugged', rootPath: path.join(tmp, 'missing') }] }));
  server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(PORT), ATTIC_DISCOVERY_PORT: '0' }),
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('Shares:')) resolve(); });
    server.on('exit', code => reject(new Error('server exited ' + code)));
  });

  // In the same hook: separate top-level hooks may start before this one finishes.
  master = client(); device = client();
  await master('POST', '/api/setup', { displayName: 'M', username: 'master', password: 'master-pass' });
  await master('POST', '/api/session', { mode: 'master', username: 'master', password: 'master-pass' });
  await master('POST', '/api/accounts', { displayName: 'P', username: 'phone', password: 'phone-pass', deviceType: 'phone' });
  await device('POST', '/api/session', { mode: 'device', username: 'phone', password: 'phone-pass' });
});
// Waits for the server to exit, so Windows has released its files, then retries the delete: a 2 GB file
// left in the temp folder by a failed run is worth avoiding.
test.after(async () => {
  if (server && server.exitCode === null) await new Promise(r => { server.on('exit', r); server.kill(); });
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function client() {
  let cookie = null;
  return async function call(method, url, body, headers) {
    const h = Object.assign({}, headers);
    if (cookie) h.Cookie = cookie;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? null : v; }
    return res;
  };
}
const json = async res => ({ status: res.status, body: await res.json() });
const folder = p => '/api/shares/main/folder' + (p === undefined ? '' : '?path=' + encodeURIComponent(p));
const file = p => '/api/shares/main/file?path=' + encodeURIComponent(p);


test('master lists the real root: folders and files, never the junction', async () => {
  const { status, body } = await json(await master('GET', folder()));
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.share, { id: 'main', name: 'Main' });
  const names = body.items.map(i => i.name).sort();
  assert.deepStrictEqual(names, ['Empty folder', 'Trip 2026', 'big.bin', 'notes.txt', 'ಬೆಂಗಳೂರು ಟಿಪ್ಪಣಿ.txt'].sort());
  const notes = body.items.find(i => i.name === 'notes.txt');
  assert.strictEqual(notes.kind, 'file');
  assert.strictEqual(notes.size, 16);
  assert.strictEqual(notes.share, 'main');
  assert.strictEqual(notes.path, '');
  assert.strictEqual(notes.ownerId, 'acc_master');
  assert.ok(!Number.isNaN(Date.parse(notes.modifiedAt)));
  assert.strictEqual(body.items.find(i => i.name === 'Trip 2026').kind, 'folder');
});

test('nested folders list with their path, and ids stay stable', async () => {
  const a = (await json(await master('GET', folder('Trip 2026/Goa')))).body;
  const b = (await json(await master('GET', folder('Trip 2026/Goa')))).body;
  assert.deepStrictEqual(a.items.map(i => i.name), ['beach.jpg']);
  assert.strictEqual(a.items[0].path, 'Trip 2026/Goa');
  assert.strictEqual(a.items[0].id, b.items[0].id);
});

test('traversal, junctions and missing folders are refused', async () => {
  for (const p of ['..', '../outside', '..\\outside', 'C:\\Windows', 'Trip 2026/../../outside', 'nope']) {
    assert.strictEqual((await master('GET', folder(p))).status, 404, p);
  }
  // The junction resolves on disk to a folder outside the share: refused by the real-path check.
  const j = await json(await master('GET', folder('escape')));
  assert.strictEqual(j.status, 403);
  assert.strictEqual(j.body.code, 'FORBIDDEN');
  for (const p of ['escape/secret.txt', '../outside/secret.txt', 'Trip 2026']) {
    const r = await master('GET', file(p));
    assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
  }
});

test('an unplugged share says so', async () => {
  const r = await json(await master('GET', '/api/shares/gone/folder'));
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.body.code, 'UNAVAILABLE');
});

test('signed out gets nothing; a device sees no master files, only empty folders', async () => {
  assert.strictEqual((await fetch(BASE + folder())).status, 401);
  assert.strictEqual((await fetch(BASE + file('notes.txt'))).status, 401);
  const root = await json(await device('GET', folder()));
  assert.strictEqual(root.status, 200);
  assert.deepStrictEqual(root.body.items.map(i => i.name), ['Empty folder']); // empty for everyone, so shown
  assert.strictEqual((await device('GET', folder('Trip 2026'))).status, 404);
  assert.strictEqual((await device('GET', file('notes.txt'))).status, 404);
});

test('a file downloads as an attachment, with its real name', async () => {
  const r = await master('GET', file('ಬೆಂಗಳೂರು ಟಿಪ್ಪಣಿ.txt'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await r.text(), 'kannada');
  assert.match(r.headers.get('content-disposition'), /^attachment;/);
  assert.match(r.headers.get('content-disposition'), new RegExp("filename\\*=UTF-8''" + encodeURIComponent('ಬೆಂಗಳೂರು ಟಿಪ್ಪಣಿ.txt').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
});

test('byte ranges: partial content, suffix ranges, and a range past the end', async () => {
  let r = await master('GET', file('notes.txt'), undefined, { Range: 'bytes=4-7' });
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.headers.get('content-range'), 'bytes 4-7/16');
  assert.strictEqual(await r.text(), '4567');
  r = await master('GET', file('notes.txt'), undefined, { Range: 'bytes=-3' });
  assert.strictEqual(await r.text(), 'def');
  r = await master('GET', file('notes.txt'), undefined, { Range: 'bytes=99-' });
  assert.strictEqual(r.status, 416);
});

test('a 2 GB file downloads completely, and resumes from the middle', { timeout: 300000 }, async () => {
  const t = Date.now();
  const r = await master('GET', file('big.bin'));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(Number(r.headers.get('content-length')), GB2);
  let total = 0;
  for await (const chunk of r.body) total += chunk.length;
  assert.strictEqual(total, GB2);
  console.log(`  2 GB streamed in ${((Date.now() - t) / 1000).toFixed(1)} s`);

  const tail = await master('GET', file('big.bin'), undefined, { Range: `bytes=${GB2 - 10}-` });
  assert.strictEqual(tail.status, 206);
  assert.strictEqual(tail.headers.get('content-range'), `bytes ${GB2 - 10}-${GB2 - 1}/${GB2}`);
  assert.strictEqual((await tail.arrayBuffer()).byteLength, 10);
});
