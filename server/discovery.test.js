// Discovery tests (Phase 2, milestone 2-1, D-01): the HP answers "where is the Attic server?" on the home
// network, and only there. Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const dgram = require('dgram');
const fs = require('fs'), os = require('os'), path = require('path');
const { findServers, localAddressFor, broadcastTargets, parseRequest } = require('./discovery');

const PORT = 22000 + Math.floor(Math.random() * 1000);
const UDP = 42000 + Math.floor(Math.random() * 1000);
let tmp, server;

function start(env) {
  const s = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: Object.assign({}, process.env, { ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'),
      ATTIC_PORT: String(PORT), ATTIC_DISCOVERY_PORT: String(UDP) }, env),
    stdio: ['ignore', 'pipe', 'inherit']
  });
  let out = '';
  return new Promise((resolve, reject) => {
    s.stdout.on('data', d => { out += d; if (out.includes('Shares:')) resolve({ s, out }); });
    s.on('exit', code => reject(new Error('server exited ' + code)));
  });
}
const stop = s => new Promise(r => { s.removeAllListeners('exit'); if (s.exitCode !== null) return r(); s.on('exit', r); s.kill(); });

// Sends raw packets to the responder and collects whatever comes back in `ms`.
function probe(packets, ms = 400) {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4'), got = [];
    sock.on('message', b => got.push(b.toString('utf8')));
    sock.bind(0, '127.0.0.1', () => {
      for (const p of packets) sock.send(Buffer.isBuffer(p) ? p : Buffer.from(p), UDP, '127.0.0.1');
      setTimeout(() => { sock.close(); resolve(got); }, ms);
    });
  });
}
const ask = nonce => JSON.stringify({ attic: 'discover', v: 1, nonce });

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-disc-'));
  fs.mkdirSync(path.join(tmp, 'share'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ host: '127.0.0.1', shares: [{ id: 'main', name: 'Main', rootPath: path.join(tmp, 'share') }] }));
  server = (await start()).s;
});
test.after(async () => {
  if (server) await stop(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---------- the home-network rule ----------
const HOME = { 'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.12', netmask: '255.255.255.0', internal: false }],
  Loopback: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
  VPN: [{ family: 'IPv4', address: '10.8.0.5', netmask: '0.0.0.0', internal: false }] };

test('answers a device on the same subnet with the HP\'s address on that subnet', () => {
  assert.strictEqual(localAddressFor('192.168.1.4', HOME), '192.168.1.12');
  assert.strictEqual(localAddressFor('192.168.1.254', HOME), '192.168.1.12');
  assert.strictEqual(localAddressFor('127.0.0.1', HOME), '127.0.0.1'); // this PC asking itself
});

test('ignores anything outside the home subnet, broadcast and network addresses, and junk', () => {
  for (const a of ['192.168.2.4', '8.8.8.8', '10.8.0.9', '192.168.1.255', '192.168.1.0', '::1', 'fe80::1', '999.1.1.1', '', 'localhost']) {
    assert.strictEqual(localAddressFor(a, HOME), null, a);
  }
});

test('broadcast targets cover the limited broadcast and each subnet\'s own', () => {
  const t = broadcastTargets(HOME);
  assert.ok(t.includes('255.255.255.255'));
  assert.ok(t.includes('192.168.1.255'));
  assert.ok(!t.some(x => x.startsWith('127.')), 'loopback is not a broadcast target');
});

test('only a well-formed version-1 request is accepted', () => {
  assert.deepStrictEqual(parseRequest(Buffer.from(ask('abcdEFGH1234'))), { nonce: 'abcdEFGH1234' });
  for (const bad of [JSON.stringify({ attic: 'discover', v: 2, nonce: 'abcdEFGH1234' }), JSON.stringify({ attic: 'hello', v: 1, nonce: 'abcdEFGH1234' }),
    ask('short'), ask('has spaces in it'), ask('x'.repeat(65)), 'not json', '', JSON.stringify({ attic: 'discover', v: 1, nonce: 'a'.repeat(20), pad: 'p'.repeat(600) })]) {
    assert.strictEqual(parseRequest(Buffer.from(bad)), null, bad.slice(0, 40));
  }
});

// ---------- the running server ----------
test('a client finds the server, with the address and port to use', async () => {
  const found = await findServers({ port: UDP, timeoutMs: 500, targets: ['127.0.0.1'] });
  assert.strictEqual(found.length, 1);
  const s = found[0];
  assert.match(s.serverId, /^[0-9a-f]{32}$/);
  assert.strictEqual(s.address, '127.0.0.1');
  assert.strictEqual(s.port, PORT);
  assert.strictEqual(s.name, os.hostname());
  // The address it gave really is the Attic server, and the same one.
  const hello = await (await fetch(`http://${s.address}:${s.port}/api/hello`)).json();
  assert.deepStrictEqual(hello, { app: 'Attic', api: 1, serverId: s.serverId, name: os.hostname() });
});

test('the reply echoes the nonce and says nothing about files or accounts', async () => {
  const [raw] = await probe([ask('nonce-check-123')]);
  const m = JSON.parse(raw);
  assert.strictEqual(m.nonce, 'nonce-check-123');
  assert.deepStrictEqual(Object.keys(m).sort(), ['address', 'attic', 'name', 'nonce', 'port', 'serverId', 'v']);
  assert.ok(raw.length < 256, 'a small reply: ' + raw.length + ' bytes');
});

test('malformed, oversized and wrong-version packets get silence', async () => {
  const got = await probe(['hello', '{}', JSON.stringify({ attic: 'discover', v: 2, nonce: 'abcdEFGH1234' }), ask('x'), Buffer.alloc(2000, 0x7b)]);
  assert.deepStrictEqual(got, []);
});

test('one sender asking too often is rate-limited', async () => {
  const got = await probe(Array.from({ length: 40 }, (_, i) => ask('flood-nonce-' + i)), 600);
  assert.ok(got.length > 0 && got.length <= 20, `${got.length} replies to 40 requests`);
});

test('the server id survives a restart', async () => {
  const before = (await (await fetch(`http://127.0.0.1:${PORT}/api/hello`)).json()).serverId;
  await stop(server);
  server = (await start()).s;
  const after = (await findServers({ port: UDP, timeoutMs: 500, targets: ['127.0.0.1'] }))[0];
  assert.strictEqual(after.serverId, before);
});

test('if the UDP port is taken the server still starts, without discovery', async () => {
  const other = await start({ ATTIC_PORT: String(PORT + 1) }); // same UDP port, already held by `server`
  try {
    assert.match(other.out, /Discovery off: UDP port \d+ is already in use/);
    assert.strictEqual((await fetch(`http://127.0.0.1:${PORT + 1}/api/hello`)).status, 200);
  } finally { await stop(other.s); }
});

test('discovery can be turned off', async () => {
  const other = await start({ ATTIC_PORT: String(PORT + 2), ATTIC_DISCOVERY_PORT: '0' });
  try { assert.match(other.out, /Discovery:\s+off/); } finally { await stop(other.s); }
});
