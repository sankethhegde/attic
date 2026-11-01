// Ownership tests (Phase 1C, milestone 5): the Phase 1C acceptance checks and the Phase 1B ownership and
// custody checks, enforced by the server on real files. Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');

const PORT = 20000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let server, tmp, share;

function start() {
  server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(PORT), ATTIC_DISCOVERY_PORT: '0' }),
    stdio: ['ignore', 'pipe', 'inherit']
  });
  return new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('Shares:')) resolve(); });
    server.on('exit', code => reject(new Error('server exited ' + code)));
  });
}
function stop() {
  return new Promise(resolve => { server.removeAllListeners('exit'); server.on('exit', resolve); server.kill(); });
}

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
    return { status: res.status, body: json, text };
  };
}
const folder = p => '/api/shares/main/folder' + (p ? '?path=' + encodeURIComponent(p) : '');
const file = p => '/api/shares/main/file?path=' + encodeURIComponent(p);
const upload = (c, p, content) => c('PUT', file(p), Buffer.from(content), { 'X-Attic-Upload': '1', 'Content-Type': 'application/octet-stream' });
const names = r => r.body.items.map(i => i.name).sort();

const master = client(), phone = client(), tablet = client();
const signIn = (c, mode, username, password) => c('POST', '/api/session', { mode, username, password });
let ids = {};

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-own-'));
  share = path.join(tmp, 'share');
  fs.mkdirSync(path.join(share, 'Trip 2026'), { recursive: true });
  fs.mkdirSync(path.join(share, 'Uploads'));
  fs.mkdirSync(path.join(share, 'Notes'));
  fs.writeFileSync(path.join(share, 'Trip 2026', 'beach.jpg'), 'master photo');
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ host: '127.0.0.1', shares: [{ id: 'main', name: 'Main', rootPath: share }] }));
  await start();
  await master('POST', '/api/setup', { displayName: 'Master', username: 'master', password: 'master-pass' });
  await signIn(master, 'master', 'master', 'master-pass');
  for (const [u, n] of [['phone', 'Phone'], ['tablet', 'Tablet']]) {
    ids[u] = (await master('POST', '/api/accounts', { displayName: n, username: u, password: u + '-pass', deviceType: u })).body.id;
  }
  await signIn(phone, 'device', 'phone', 'phone-pass');
  await signIn(tablet, 'device', 'tablet', 'tablet-pass');
});
test.after(async () => {
  if (server && server.exitCode === null) await stop();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('uploads are stored on disk and owned by the uploader', async () => {
  const p = await upload(phone, 'Uploads/phone-photo.jpg', 'from the phone');
  assert.strictEqual(p.status, 201);
  assert.strictEqual(p.body.ownerId, ids.phone);
  assert.strictEqual(p.body.uploadedBy, ids.phone);
  assert.strictEqual(fs.readFileSync(path.join(share, 'Uploads', 'phone-photo.jpg'), 'utf8'), 'from the phone');
  assert.strictEqual((await upload(tablet, 'Notes/tablet-note.txt', 'from the tablet')).status, 201);
  assert.strictEqual((await upload(tablet, 'tablet-root.txt', 'tablet at the root')).status, 201);
});

test('a folder holding only someone else\'s files doesn\'t exist for you, so you can\'t upload into it', async () => {
  assert.strictEqual((await upload(tablet, 'Uploads/tablet-sneaky.txt', 'x')).status, 404);
  assert.ok(!fs.readdirSync(path.join(share, 'Uploads')).includes('tablet-sneaky.txt'));
});

test('the same name twice gets "(1)", never overwrites', async () => {
  const r = await upload(phone, 'Uploads/phone-photo.jpg', 'second copy');
  assert.strictEqual(r.body.name, 'phone-photo (1).jpg');
  assert.strictEqual(fs.readFileSync(path.join(share, 'Uploads', 'phone-photo.jpg'), 'utf8'), 'from the phone');
});

test('ACCEPTANCE: an uploader cannot open another uploader\'s file, even by calling the server directly', async () => {
  assert.deepStrictEqual(names(await phone('GET', folder('Uploads'))), ['phone-photo (1).jpg', 'phone-photo.jpg']);
  assert.deepStrictEqual(names(await tablet('GET', folder('Notes'))), ['tablet-note.txt']);
  for (const p of ['Notes/tablet-note.txt', 'NOTES/TABLET-NOTE.TXT', 'Notes\\tablet-note.txt', 'tablet-root.txt', 'Trip 2026/beach.jpg']) {
    const r = await phone('GET', file(p));
    assert.strictEqual(r.status, 404, p); // absent, not "forbidden"
  }
  // Folders that only lead to someone else's files don't exist for the phone.
  const root = names(await phone('GET', folder()));
  assert.ok(!root.includes('Trip 2026') && !root.includes('Notes') && !root.includes('tablet-root.txt'), root.join(', '));
  assert.strictEqual((await phone('GET', folder('Trip 2026'))).status, 404);
  assert.strictEqual((await phone('GET', folder('Notes'))).status, 404);
  // Nor can it upload into them.
  assert.strictEqual((await upload(phone, 'Trip 2026/sneaky.txt', 'x')).status, 404);
});

test('ACCEPTANCE: the master account sees every user\'s files, with owners', async () => {
  const owner = async (dir, name) => (await master('GET', folder(dir))).body.items.find(i => i.name === name).ownerId;
  assert.strictEqual(await owner('Uploads', 'phone-photo.jpg'), ids.phone);
  assert.strictEqual(await owner('Notes', 'tablet-note.txt'), ids.tablet);
  assert.strictEqual(await owner('', 'tablet-root.txt'), ids.tablet);
  assert.strictEqual(await owner('Trip 2026', 'beach.jpg'), 'acc_master'); // on the disk before Attic
  assert.strictEqual((await master('GET', file('Notes/tablet-note.txt'))).text, 'from the tablet');
});

test('ACCEPTANCE: uploaded files and their owners survive a server restart', async () => {
  await stop();
  await start();
  const r = await phone('GET', file('Uploads/phone-photo.jpg')); // the persistent session survives too
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.text, 'from the phone');
  assert.strictEqual((await phone('GET', file('Notes/tablet-note.txt'))).status, 404);
});

test('uploads are refused without the upload header, cross-site, or with a bad name', async () => {
  assert.strictEqual((await phone('PUT', file('Uploads/a.txt'), Buffer.from('x'), { 'Content-Type': 'application/octet-stream' })).status, 415);
  assert.strictEqual((await phone('PUT', file('Uploads/a.txt'), Buffer.from('x'), { 'X-Attic-Upload': '1', Origin: 'http://evil.example' })).status, 403);
  for (const p of ['Uploads/../escape.txt', 'Uploads/x.lnk', 'Uploads/con.txt', 'Uploads/trailing.']) {
    assert.ok([400, 404].includes((await upload(phone, p, 'x')).status), p);
  }
  assert.strictEqual((await fetch(BASE + file('Uploads/a.txt'), { method: 'PUT', headers: { 'X-Attic-Upload': '1' }, body: 'x' })).status, 401);
});

test('a cancelled upload leaves nothing behind', async () => {
  const cookie = await new Promise(resolve => {
    const r = http.request(BASE + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.headers['set-cookie'][0].split(';')[0]); });
    r.end(JSON.stringify({ mode: 'device', username: 'phone', password: 'phone-pass' }));
  });
  await new Promise(resolve => {
    const req = http.request(BASE + file('Uploads/half.bin'), { method: 'PUT', headers: { Cookie: cookie, 'X-Attic-Upload': '1', 'Content-Length': 1e6 } });
    req.on('error', () => resolve());
    req.write(Buffer.alloc(1000));
    setTimeout(() => { req.destroy(); setTimeout(resolve, 300); }, 200);
  });
  // The server notices the dropped connection and cleans up; give it a moment.
  for (let i = 0; i < 20 && fs.readdirSync(path.join(share, 'Uploads')).some(n => n.startsWith('~attic-')); i++) await new Promise(r => setTimeout(r, 100));
  const left = fs.readdirSync(path.join(share, 'Uploads'));
  assert.ok(!left.includes('half.bin'), 'partial file kept');
  assert.ok(!left.some(n => n.startsWith('~attic-')), 'temp file kept: ' + left.join(', '));
});

test('revoke: the dialog\'s figures, files move to the custodian with custody, and the device is signed out', async () => {
  const sum = await master('GET', `/api/accounts/${ids.phone}/ownership`);
  assert.deepStrictEqual(sum.body.owned, { count: 2, bytes: 'from the phone'.length + 'second copy'.length });
  const r = await master('POST', `/api/accounts/${ids.phone}/revoke`, { custodianId: ids.tablet });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.moved.count, 2);
  assert.strictEqual(r.body.custodian.id, ids.tablet);
  assert.strictEqual((await phone('GET', folder())).status, 401);
  const held = (await tablet('GET', folder('Uploads'))).body.items.find(i => i.name === 'phone-photo.jpg');
  assert.strictEqual(held.ownerId, ids.tablet);
  assert.strictEqual(held.uploadedBy, ids.phone); // the custody badge
  // The revoked device can't be its own custodian, nor can another revoked account.
  assert.strictEqual((await master('POST', `/api/accounts/${ids.tablet}/revoke`, { custodianId: ids.phone })).status, 400);
});

test('restore returns exactly what the device uploaded; the custodian\'s own files stay', async () => {
  const r = await master('POST', `/api/accounts/${ids.phone}/restore`, {});
  assert.strictEqual(r.body.returned.count, 2);
  assert.strictEqual((await tablet('GET', folder('Uploads'))).status, 404); // nothing of the tablet's left there
  assert.deepStrictEqual(names(await tablet('GET', folder('Notes'))), ['tablet-note.txt']);
  await signIn(phone, 'device', 'phone', 'phone-pass');
  assert.strictEqual((await phone('GET', file('Uploads/phone-photo.jpg'))).status, 200);
});

test('keep permanently ends the uploader\'s claim', async () => {
  await master('POST', `/api/accounts/${ids.phone}/revoke`, {}); // to the master
  const id = (await master('GET', folder('Uploads'))).body.items.find(i => i.name === 'phone-photo.jpg').id;
  assert.strictEqual((await master('POST', '/api/files/keep', { ids: [id] })).body.cleared, 1);
  const r = await master('POST', `/api/accounts/${ids.phone}/restore`, {});
  assert.strictEqual(r.body.returned.count, 1); // the copy came back; the kept one didn't
  await signIn(phone, 'device', 'phone', 'phone-pass');
  assert.deepStrictEqual(names(await phone('GET', folder('Uploads'))), ['phone-photo (1).jpg']);
});

test('remove: files go to the custodian, every claim is cleared, and a reused username inherits nothing', async () => {
  const r = await master('POST', `/api/accounts/${ids.tablet}/remove`, { custodianId: ids.phone });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.moved.count, 2);
  const note = (await phone('GET', folder('Notes'))).body.items.find(i => i.name === 'tablet-note.txt');
  assert.strictEqual(note.ownerId, ids.phone);
  assert.strictEqual(note.uploadedBy, null);
  const again = (await master('POST', '/api/accounts', { displayName: 'New tablet', username: 'tablet', password: 'tablet-pass', deviceType: 'tablet' })).body;
  const sum = (await master('GET', `/api/accounts/${again.id}/ownership`)).body;
  assert.deepStrictEqual(sum.owned, { count: 0, bytes: 0 });
  assert.deepStrictEqual(sum.inCustody, { count: 0, bytes: 0 });
});

test('a device cannot read ownership or change it', async () => {
  assert.strictEqual((await phone('GET', `/api/accounts/${ids.phone}/ownership`)).status, 403);
  assert.strictEqual((await phone('POST', '/api/files/keep', { ids: [] })).status, 403);
});
