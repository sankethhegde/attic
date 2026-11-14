// 0.14: move, rename and delete (to the trash) — what PixHaven's "Move to/from Attic" and its Attic tab use.
// Starts a real server on two throwaway shares. Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const { createFiles } = require('./files');
const { createSafePath } = require('./safe-path');

const PORT = 21000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let server, tmp, main, other, master, phone, tablet;

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-move-'));
  main = path.join(tmp, 'main'); other = path.join(tmp, 'other');
  fs.mkdirSync(path.join(main, 'Videos', 'Trips'), { recursive: true });
  fs.mkdirSync(path.join(main, 'Inbox'), { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(main, 'Videos', 'masters-clip.mp4'), 'master file');
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ host: '127.0.0.1', shares: [
    { id: 'main', name: 'Main', rootPath: main }, { id: 'other', name: 'Other', rootPath: other }] }));
  server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(PORT), ATTIC_DISCOVERY_PORT: '0' }),
    stdio: ['ignore', 'pipe', 'inherit']
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (String(d).includes('Shares:')) resolve(); });
    server.on('exit', code => reject(new Error('server exited ' + code)));
  });
  master = client(); phone = client(); tablet = client();
  await master('POST', '/api/setup', { displayName: 'M', username: 'master', password: 'master-pass' });
  await master('POST', '/api/session', { mode: 'master', username: 'master', password: 'master-pass' });
  for (const [c, n] of [[phone, 'phone'], [tablet, 'tablet']]) {
    await master('POST', '/api/accounts', { displayName: n, username: n, password: n + '-pass', deviceType: 'phone' });
    await c('POST', '/api/session', { mode: 'device', username: n, password: n + '-pass' });
  }
});
test.after(async () => {
  if (server && server.exitCode === null) await new Promise(r => { server.on('exit', r); server.kill(); });
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function client() {
  let cookie = null;
  return async function call(method, url, body, headers) {
    const h = Object.assign({}, headers);
    if (cookie) h.Cookie = cookie;
    let data = body;
    if (body !== undefined && !Buffer.isBuffer(body)) { h['Content-Type'] = 'application/json'; data = JSON.stringify(body); }
    const res = await fetch(BASE + url, { method, headers: h, body: data });
    const set = res.headers.get('set-cookie');
    if (set) { const v = set.split(';')[0]; cookie = v.endsWith('=') ? null : v; }
    return res;
  };
}
const json = async res => ({ status: res.status, body: await res.json() });
const upload = (c, share, p, content) => c('PUT', `/api/shares/${share}/file?path=${encodeURIComponent(p)}`, Buffer.from(content), { 'X-Attic-Upload': '1', 'Content-Type': 'application/octet-stream' });
const list = async (c, share, p) => (await json(await c('GET', `/api/shares/${share}/folder?path=${encodeURIComponent(p)}`))).body;
const names = async (c, share, p) => ((await list(c, share, p)).items || []).map(i => i.name).sort();
const move = (c, share, body) => c('POST', `/api/shares/${share}/move`, body).then(json);
const trash = (c, share, p) => c('POST', `/api/shares/${share}/trash`, { path: p }).then(json);

test('a device moves and renames its own file; it stays theirs', async () => {
  assert.strictEqual((await upload(phone, 'main', 'Inbox/beach.mp4', 'phone video')).status, 201);
  const r = await move(phone, 'main', { path: 'Inbox/beach.mp4', toFolder: 'Videos/Trips' });
  assert.deepStrictEqual(r, { status: 200, body: { share: 'main', path: 'Videos/Trips/beach.mp4' } });
  assert.ok(fs.existsSync(path.join(main, 'Videos', 'Trips', 'beach.mp4')) && !fs.existsSync(path.join(main, 'Inbox', 'beach.mp4')));
  const item = (await list(phone, 'main', 'Videos/Trips')).items.find(i => i.name === 'beach.mp4');
  assert.ok(item && item.ownerId === item.uploadedBy && item.ownerId !== 'acc_master', 'the phone still owns it');
  const ren = await move(phone, 'main', { path: 'Videos/Trips/beach.mp4', toFolder: 'Videos/Trips', name: 'Goa beach.mp4' });
  assert.strictEqual(ren.body.path, 'Videos/Trips/Goa beach.mp4');
  assert.deepStrictEqual(await names(phone, 'main', 'Videos/Trips'), ['Goa beach.mp4']);
});

test('nothing is overwritten: the moved file takes a free name', async () => {
  await upload(phone, 'main', 'Inbox/Goa beach.mp4', 'another one');
  const r = await move(phone, 'main', { path: 'Inbox/Goa beach.mp4', toFolder: 'Videos/Trips' });
  assert.strictEqual(r.body.path, 'Videos/Trips/Goa beach (1).mp4');
  assert.strictEqual(fs.readFileSync(path.join(main, 'Videos', 'Trips', 'Goa beach.mp4'), 'utf8'), 'phone video');
});

test('a device cannot move or delete what is not theirs', async () => {
  const notMine = await move(phone, 'main', { path: 'Videos/masters-clip.mp4', toFolder: 'Inbox' });
  assert.strictEqual(notMine.status, 404, 'the master\'s file is not even visible to a device');
  await upload(tablet, 'main', 'Inbox/tablet.mp4', 'tablet video');
  assert.strictEqual((await move(phone, 'main', { path: 'Inbox/tablet.mp4', toFolder: 'Videos' })).status, 404);
  assert.strictEqual((await trash(phone, 'main', 'Inbox/tablet.mp4')).status, 404);
  assert.ok(fs.existsSync(path.join(main, 'Inbox', 'tablet.mp4')), 'untouched');
});

test('the master moves a folder to another share; owners follow', async () => {
  const r = await move(master, 'main', { path: 'Videos/Trips', toShare: 'other', toFolder: '' });
  assert.deepStrictEqual(r.body, { share: 'other', path: 'Trips' });
  assert.deepStrictEqual(await names(phone, 'other', 'Trips'), ['Goa beach (1).mp4', 'Goa beach.mp4'], 'the phone still sees its files at the new place');
  assert.ok(!fs.existsSync(path.join(main, 'Videos', 'Trips')));
  assert.strictEqual((await move(master, 'other', { path: 'Trips', toFolder: 'Trips' })).status, 400, 'not into itself');
});

test('delete goes to the hidden trash for 30 days: out of every listing, the index and direct reads', async () => {
  const r = await trash(phone, 'other', 'Trips/Goa beach (1).mp4');
  assert.deepStrictEqual(r, { status: 200, body: { ok: true, files: 1 } });
  const day = new Date().toISOString().slice(0, 10);
  const kept = path.join(other, '~attic-trash', day, 'Trips', 'Goa beach (1).mp4');
  assert.strictEqual(fs.readFileSync(kept, 'utf8'), 'another one', 'kept in the trash');
  assert.deepStrictEqual(await names(master, 'other', ''), ['Trips'], 'the trash is hidden even from the master');
  assert.ok(!(await json(await master('GET', '/api/files?fresh=1'))).body.entries.some(e => e.path.includes('~attic-trash')));
  assert.strictEqual((await master('GET', `/api/shares/other/file?path=${encodeURIComponent(`~attic-trash/${day}/Trips/Goa beach (1).mp4`)}`)).status, 404);
  assert.strictEqual((await master('GET', `/api/shares/other/folder?path=~attic-trash`)).status, 404);
  assert.strictEqual((await move(master, 'other', { path: `~attic-trash/${day}`, toFolder: '' })).status, 404);
  // a folder the phone owns every file of
  assert.deepStrictEqual((await trash(phone, 'other', 'Trips')).body, { ok: true, files: 1 });
  assert.ok(fs.existsSync(path.join(other, '~attic-trash', day, 'Trips (1)', 'Goa beach.mp4')) || fs.existsSync(path.join(other, '~attic-trash', day, 'Trips', 'Goa beach.mp4')));
});

test('a folder holding someone else\'s file cannot be deleted by a device', async () => {
  fs.mkdirSync(path.join(main, 'Mixed'));
  assert.strictEqual((await upload(phone, 'main', 'Mixed/mine.mp4', 'mine')).status, 201);
  fs.writeFileSync(path.join(main, 'Mixed', 'masters.mp4'), 'put there by the master');   // no record: the master's
  const t = await trash(phone, 'main', 'Mixed');
  assert.strictEqual(t.status, 403, 'the master\'s file is inside');
  assert.strictEqual(t.body.code, 'NOT_YOURS');
  assert.ok(fs.existsSync(path.join(main, 'Mixed', 'mine.mp4')) && fs.existsSync(path.join(main, 'Mixed', 'masters.mp4')));
  assert.strictEqual((await move(phone, 'main', { path: 'Mixed', toFolder: 'Videos' })).status, 403, 'nor moved');
});

test('trash older than 30 days is emptied; newer is kept', async () => {
  const root = path.join(tmp, 'purge');
  for (const d of ['2026-01-01', '2026-11-10']) fs.mkdirSync(path.join(root, '~attic-trash', d, 'x'), { recursive: true });
  const shares = [{ id: 'p', name: 'P', rootPath: root }];
  const files = createFiles(shares, createSafePath(shares));
  assert.strictEqual(await files.purgeTrash(Date.parse('2026-11-14T12:00:00Z')), 1);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, '~attic-trash')), ['2026-11-10']);
});
