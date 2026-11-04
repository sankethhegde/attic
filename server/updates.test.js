// Update tests (Phase 3, milestone 3-5, T-10): the HP serves the newest desktop-tool installer and its
// version to every paired client, and tells them when there's a new one. The installers here are small
// fakes: "MZ" and random bytes. The "Acer" is 127.0.0.2, the "ROG Ally" 127.0.0.3.
// Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { execFile } = require('child_process');
const http = require('http');
const fs = require('fs'), os = require('os'), path = require('path');
const { startServer, stopServer, client, wsOpen, sleep } = require('./test-util');
const { compareVersions } = require('./updates');

const PORT = 28000 + Math.floor(Math.random() * 1000);
const MASTER = { displayName: 'Sanketh', username: 'sanketh', password: 'master-pass-1' };
const GUEST = { displayName: 'Guest', username: 'guest', password: 'guest-pass-1', deviceType: 'laptop' };
let tmp, server, env, hp, acer, guest, allyToken;

const fakeInstaller = (size = 3 << 20) => Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(size - 2)]);
const sha = (alg, b, enc = 'hex') => crypto.createHash(alg).update(b).digest(enc);
const allyAgent = () => wsOpen(PORT, '127.0.0.3', { query: '?role=agent', headers: { 'X-Attic-Device': allyToken } });
const asAlly = () => ({ 'X-Attic-Device': allyToken });
// The master, on the Acer where the build happens, uploads an installer.
function upload(name, body, { who = acer, query = '' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, localAddress: '127.0.0.2', method: 'PUT', path: `/api/updates/files/${name}${query}`,
      headers: { Cookie: who.cookieHeader(), 'X-Attic-Upload': '1', 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } }, async res => {
      let t = ''; for await (const c of res) t += c; resolve({ status: res.statusCode, json: JSON.parse(t) });
    });
    r.on('error', reject); r.end(body);
  });
}
async function pair(c, name) {
  const code = (await hp.call('POST', '/api/pairing/codes')).json.code;
  return (await c.call('POST', '/api/pairing/claim', { code, name, kind: 'laptop' })).json.device.id;
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-upd-'));
  fs.mkdirSync(path.join(tmp, 'share'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ host: '127.0.0.1', shares: [{ id: 'main', name: 'Main', rootPath: path.join(tmp, 'share') }] }));
  env = { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(PORT), ATTIC_UPDATES_POLL_MS: '300' };
  server = await startServer(env);
  hp = client(PORT, '127.0.0.1');
  await hp.call('POST', '/api/setup', MASTER);
  await hp.call('POST', '/api/session', Object.assign({ mode: 'master' }, MASTER));
  await hp.call('POST', '/api/accounts', GUEST);
  acer = client(PORT, '127.0.0.2');
  const ally = client(PORT, '127.0.0.3');
  await pair(acer, 'Acer Aspire 5');
  await pair(ally, 'ASUS ROG Ally');
  allyToken = decodeURIComponent(ally.jar.attic_device);
  await acer.call('POST', '/api/session', Object.assign({ mode: 'master' }, MASTER));
  guest = client(PORT, '127.0.0.2');
  guest.jar.attic_device = acer.jar.attic_device;
  await guest.call('POST', '/api/session', { mode: 'device', username: GUEST.username, password: GUEST.password });
});
test.after(async () => {
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('before anything is published there is no update, and strangers learn nothing either way', async () => {
  assert.strictEqual((await hp.call('GET', '/api/updates/latest')).json.code, 'NO_UPDATE');
  assert.strictEqual((await hp.call('GET', '/api/updates/files/latest.yml')).json.code, 'NO_UPDATE');
  const a = await allyAgent(); await a.next('hello');
  assert.deepStrictEqual(await a.next('update'), { type: 'update', latest: null });
  a.close();
  const stranger = client(PORT, '127.0.0.9');
  assert.strictEqual((await stranger.call('GET', '/api/updates/latest')).json.code, 'NOT_PAIRED');
});

let v070;
test('the master uploads an installer; every client is told at once, and as a notification', async () => {
  const a = await allyAgent(); await a.next('hello'); await a.next('update');
  v070 = fakeInstaller();
  const r = await upload('Attic-Hub-Setup-0.7.0.exe', v070, { query: '?notes=' + encodeURIComponent('Tray icon and notifications') });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.version, '0.7.0');
  assert.strictEqual(r.json.size, v070.length);
  assert.strictEqual(r.json.sha256, sha('sha256', v070));
  assert.strictEqual(r.json.sha512, sha('sha512', v070, 'base64'));
  assert.strictEqual(r.json.notes, 'Tray icon and notifications');
  assert.strictEqual(r.json.url, '/api/updates/files/Attic-Hub-Setup-0.7.0.exe');
  assert.strictEqual((await a.next('update')).latest.version, '0.7.0');
  const ev = (await a.next(m => m.type === 'event' && m.event.kind === 'update.available')).event;
  assert.strictEqual(ev.title, 'Attic Hub 0.7.0 is available');
  a.close();
});

test('a client asks with its version and learns whether the HP has a newer one', async () => {
  // An agent asks with its device token alone; an interface with its session.
  const older = (await hp.call('GET', '/api/updates/latest?current=0.6.0', undefined, asAlly())).json;
  assert.strictEqual(older.newer, true);
  assert.strictEqual(older.current, '0.6.0');
  assert.strictEqual((await guest.call('GET', '/api/updates/latest?current=0.7.0')).json.newer, false);
  assert.ok(!('newer' in (await guest.call('GET', '/api/updates/latest')).json));
  // A connecting agent is told the latest straight away.
  const a = await allyAgent(); await a.next('hello');
  assert.strictEqual((await a.next('update')).latest.version, '0.7.0');
  a.close();
});

test('the installer downloads complete, resumable, and matching its hashes; latest.yml is what electron-updater reads', async () => {
  const ally = client(PORT, '127.0.0.3');
  const d = await ally.download('/api/updates/files/Attic-Hub-Setup-0.7.0.exe', asAlly());
  assert.strictEqual(d.status, 200);
  assert.strictEqual(d.sha, sha('sha256', v070));
  assert.match(d.headers['content-disposition'], /attachment; filename="Attic-Hub-Setup-0.7.0.exe"/);
  const part = await ally.download('/api/updates/files/Attic-Hub-Setup-0.7.0.exe', Object.assign({ Range: 'bytes=1048576-' }, asAlly()));
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.sha, sha('sha256', v070.subarray(1048576)));
  const yml = await new Promise(resolve => http.get({ host: '127.0.0.1', port: PORT, localAddress: '127.0.0.3', path: '/api/updates/files/latest.yml', headers: asAlly() },
    async res => { let t = ''; for await (const c of res) t += c; resolve({ type: res.headers['content-type'], text: t }); }));
  assert.match(yml.type, /yaml/);
  const lines = yml.text.split('\n');
  for (const l of ['version: 0.7.0', 'files:', '  - url: Attic-Hub-Setup-0.7.0.exe', `    sha512: ${sha('sha512', v070, 'base64')}`, `    size: ${v070.length}`, 'path: Attic-Hub-Setup-0.7.0.exe']) assert.ok(lines.includes(l), l);
  assert.ok(lines.some(l => /^releaseDate: '\d{4}-\d\d-\d\dT/.test(l)));
  assert.ok(lines.includes("releaseNotes: 'Tray icon and notifications'"));
  // Only installers in the manifest are served.
  assert.strictEqual((await ally.download('/api/updates/files/manifest.json', asAlly())).status, 404);
  assert.strictEqual((await ally.download('/api/updates/files/..%5Cconfig.json', asAlly())).status, 404);
});

test('only the master publishes, only a real installer, named as the build names it, and never backwards', async () => {
  const ok = fakeInstaller(4096);
  assert.strictEqual((await upload('Attic-Hub-Setup-0.7.5.exe', ok, { who: guest })).json.code, 'FORBIDDEN');
  for (const name of ['setup.exe', 'Attic-Hub-Setup-0.7.exe', 'Attic-Hub-Setup-0.7.5.zip', 'Attic-Hub-Setup-0.7.5.exe.exe', '..%5CAttic-Hub-Setup-0.7.5.exe']) {
    assert.strictEqual((await upload(name, ok)).json.code, 'INVALID', name);
  }
  assert.strictEqual((await upload('Attic-Hub-Setup-0.7.5.exe', Buffer.from('#!/bin/sh\necho not windows'))).json.code, 'INVALID', 'not a Windows program');
  assert.strictEqual((await upload('Attic-Hub-Setup-0.7.0.exe', ok)).json.code, 'EXISTS');
  assert.strictEqual((await upload('Attic-Hub-Setup-0.6.9.exe', ok)).json.code, 'OLDER');
  // Asked for, the same version can be replaced (a fixed build).
  const fixed = fakeInstaller(8192);
  const r = await upload('Attic-Hub-Setup-0.7.0.exe', fixed, { query: '?replace=1' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual((await hp.call('GET', '/api/updates/latest')).json.sha256, sha('sha256', fixed));
  // The refused uploads left nothing behind.
  const left = fs.readdirSync(path.join(tmp, 'data', 'updates')).sort();
  assert.deepStrictEqual(left, ['Attic-Hub-Setup-0.7.0.exe', 'manifest.json']);
});

test('the HP keeps the newest 3 releases', async () => {
  for (const v of ['0.7.1', '0.8.0', '0.10.0']) assert.strictEqual((await upload(`Attic-Hub-Setup-${v}.exe`, fakeInstaller(2048))).status, 201);
  const list = (await hp.call('GET', '/api/updates')).json.map(r => r.version);
  assert.deepStrictEqual(list, ['0.10.0', '0.8.0', '0.7.1'], 'newest first, by number: 0.10 is after 0.8');
  assert.strictEqual((await hp.call('GET', '/api/updates/latest')).json.version, '0.10.0');
  assert.ok(!fs.existsSync(path.join(tmp, 'data', 'updates', 'Attic-Hub-Setup-0.7.0.exe')), 'the oldest is deleted');
  assert.strictEqual((await guest.call('GET', '/api/updates')).json.code, 'FORBIDDEN', 'the release list is the master’s');
});

test('publishing on the HP from the command line is picked up by the running server', async () => {
  const a = await allyAgent(); await a.next('hello'); await a.next('update');
  const file = path.join(tmp, 'Attic-Hub-Setup-1.0.0.exe');
  fs.writeFileSync(file, fakeInstaller(10000));
  const out = await new Promise((resolve, reject) => execFile(process.execPath, [path.join(__dirname, 'publish-update.js'), file, '--notes', 'First full release'],
    { env: Object.assign({}, process.env, env) }, (e, so, se) => e ? reject(new Error(se || e.message)) : resolve(so)));
  assert.match(out, /Published Attic Hub 1\.0\.0/);
  assert.strictEqual((await a.next('update', 3000)).latest.version, '1.0.0');
  assert.strictEqual((await a.next(m => m.type === 'event' && m.event.kind === 'update.available')).event.title, 'Attic Hub 1.0.0 is available');
  a.close();
  // It's still the latest after the HP restarts.
  await stopServer(server);
  server = await startServer(env);
  assert.strictEqual((await acer.call('GET', '/api/updates/latest')).json.notes, 'First full release');
});

test('version numbers compare as numbers', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareVersions('1.0.0', '0.99.99') > 0);
  assert.strictEqual(compareVersions('0.7.0', '0.7.0'), 0);
  assert.ok(compareVersions('0.6.0', '0.7.0') < 0);
});
