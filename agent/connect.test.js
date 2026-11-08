// Tests for agent/connect.js. Run: node --test "agent/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { normalizeAddress, hello, search } = require('./connect.js');

const A = 'a'.repeat(32), B = 'b'.repeat(32);

test('normalizeAddress accepts the usual ways of typing an address', () => {
  assert.deepStrictEqual(normalizeAddress('192.168.1.10'), { address: '192.168.1.10', port: 8080 });
  assert.deepStrictEqual(normalizeAddress(' 192.168.1.10:9000 '), { address: '192.168.1.10', port: 9000 });
  assert.deepStrictEqual(normalizeAddress('http://192.168.1.10:8080/'), { address: '192.168.1.10', port: 8080 });
  assert.deepStrictEqual(normalizeAddress('hp-laptop.local'), { address: 'hp-laptop.local', port: 8080 });
});

test('normalizeAddress refuses what it cannot use, with a reason', () => {
  for (const bad of ['', '192.168.1', '192.168.1.300', 'https://192.168.1.10', '192.168.1.10/files', 'hp laptop', '1.2.3.4:70000', 'ftp://x']) {
    assert.throws(() => normalizeAddress(bad), /./, bad);
  }
});

function fakeServer(handler) {
  return new Promise(resolve => {
    const srv = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('hello confirms an Attic server and rejects anything else', async () => {
  const good = await fakeServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ app: 'Attic', api: 1, serverId: A, name: 'HP' })); });
  const other = await fakeServer((req, res) => res.end('<html>router login</html>'));
  try {
    const s = await hello({ address: '127.0.0.1', port: good.address().port });
    assert.strictEqual(s.serverId, A);
    assert.strictEqual(s.name, 'HP');
    await assert.rejects(hello({ address: '127.0.0.1', port: other.address().port }), /isn’t an Attic server/);
    await assert.rejects(hello({ address: '127.0.0.1', port: 1 }, { timeoutMs: 800 }), /Nothing answered/);
  } finally { good.close(); other.close(); }
});

const helloFrom = table => async s => {
  const hit = table[`${s.address}:${s.port}`];
  if (!hit) throw new Error('Nothing answered');
  return Object.assign({ address: s.address, port: s.port }, hit);
};

test('the remembered server is used first, without broadcasting', async () => {
  let broadcasts = 0;
  const r = await search({ remembered: { serverId: A, address: '10.0.0.5', port: 8080 } },
    { find: async () => { broadcasts++; return []; }, sweep: async () => [], hello: helloFrom({ '10.0.0.5:8080': { serverId: A, name: 'HP' } }) });
  assert.strictEqual(r.state, 'connected');
  assert.strictEqual(r.via, 'remembered');
  assert.strictEqual(broadcasts, 0);
});

test('a remembered server that moved is followed to its new address', async () => {
  const r = await search({ remembered: { serverId: A, address: '10.0.0.5', port: 8080 } }, {
    find: async () => [{ serverId: B, address: '10.0.0.9', port: 8080 }, { serverId: A, address: '10.0.0.7', port: 8080 }],
    sweep: async () => [], hello: helloFrom({ '10.0.0.7:8080': { serverId: A, name: 'HP' }, '10.0.0.9:8080': { serverId: B, name: 'Other' } })
  });
  assert.strictEqual(r.state, 'connected');
  assert.strictEqual(r.via, 'moved');
  assert.strictEqual(r.server.address, '10.0.0.7');
});

test('a different server at the remembered address is not trusted', async () => {
  const r = await search({ remembered: { serverId: A, address: '10.0.0.5', port: 8080 } },
    { find: async () => [], sweep: async () => [], hello: helloFrom({ '10.0.0.5:8080': { serverId: B, name: 'Imposter' } }) });
  assert.strictEqual(r.state, 'not-found');
});

test('one answer connects; several ask; none says so', async () => {
  const one = await search({}, { find: async () => [{ serverId: A, address: '10.0.0.7', port: 8080 }], sweep: async () => [], hello: helloFrom({ '10.0.0.7:8080': { serverId: A, name: 'HP' } }) });
  assert.deepStrictEqual([one.state, one.via], ['connected', 'discovery']);
  const two = await search({}, {
    find: async () => [{ serverId: A, address: '10.0.0.7', port: 8080 }, { serverId: B, address: '10.0.0.9', port: 8080 }],
    sweep: async () => [], hello: helloFrom({ '10.0.0.7:8080': { serverId: A, name: 'HP' }, '10.0.0.9:8080': { serverId: B, name: 'Spare' } })
  });
  assert.strictEqual(two.state, 'choose');
  assert.strictEqual(two.servers.length, 2);
  let rounds = 0;
  const none = await search({ rounds: 2 }, { find: async () => { rounds++; return []; }, sweep: async () => [], hello: helloFrom({}) });
  assert.strictEqual(none.state, 'not-found');
  assert.strictEqual(rounds, 2);
});

test('an answer whose HTTP serverId differs from its broadcast reply is dropped', async () => {
  const r = await search({}, { find: async () => [{ serverId: A, address: '10.0.0.7', port: 8080 }], sweep: async () => [], hello: helloFrom({ '10.0.0.7:8080': { serverId: B, name: 'Swapped' } }) });
  assert.strictEqual(r.state, 'not-found');
  assert.strictEqual(r.heard, 1);
});

test('a broadcast that fails (no network) is reported, not thrown', async () => {
  const r = await search({ rounds: 1 }, { find: async () => { throw new Error('send ENETUNREACH'); }, sweep: async () => [], hello: helloFrom({}) });
  assert.strictEqual(r.state, 'not-found');
  assert.match(r.error, /ENETUNREACH/);
});

// ---------- the Wi-Fi fix (8 Nov 2026) ----------
const { sweep, sweepTargets } = require('./connect.js');

test('the HP is found by its PC name when its address changed (DHCP gave it a new one)', async () => {
  const r = await search({ remembered: { serverId: A, name: 'DESKTOP-UL55ECB', address: '192.168.1.12', port: 8080 } },
    { find: async () => [], sweep: async () => [], hello: helloFrom({ 'DESKTOP-UL55ECB:8080': { serverId: A, name: 'DESKTOP-UL55ECB' } }) });
  assert.deepStrictEqual([r.state, r.via, r.server.address], ['connected', 'name', 'DESKTOP-UL55ECB']);
});

test('the broadcast hears nothing (dropped over Wi-Fi): a knock on the network finds the HP', async () => {
  let swept = 0;
  const r = await search({ remembered: { serverId: A, address: '192.168.1.12', port: 8080 } },
    { find: async () => [], sweep: async port => { swept++; assert.strictEqual(port, 8080); return [{ serverId: A, name: 'HP', address: '192.168.1.3', port: 8080 }]; }, hello: helloFrom({}) });
  assert.deepStrictEqual([r.state, r.via, r.server.address, swept], ['connected', 'moved', '192.168.1.3', 1]);
});

test('the sweep: every address of this PC’s /24; only what answers as Attic counts', async () => {
  const t = sweepTargets({ wifi: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }], lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
    pub: [{ family: 'IPv4', internal: false, address: '8.8.8.8' }] });
  assert.strictEqual(t.length, 254);
  assert.ok(t.includes('192.168.1.5') && t.includes('192.168.1.3') && t.includes('192.168.1.254') && !t.some(ip => ip.startsWith('8.') || ip.startsWith('127.')));
  // A real knock: one local port answers (an Attic stand-in), another answers but isn't Attic.
  const http = require('http');
  const attic = http.createServer((q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ app: 'Attic', serverId: A, name: 'HP' })); });
  await new Promise(r => attic.listen(0, '127.0.0.1', r));
  const port = attic.address().port;
  const found = await sweep({ port, targets: ['127.0.0.1', '127.0.0.2', '127.0.0.3'], timeoutMs: 500 });
  attic.close();
  assert.deepStrictEqual(found.map(s => [s.address, s.serverId]), [['127.0.0.1', A]]);
});
