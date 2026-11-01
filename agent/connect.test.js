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
    { find: async () => { broadcasts++; return []; }, hello: helloFrom({ '10.0.0.5:8080': { serverId: A, name: 'HP' } }) });
  assert.strictEqual(r.state, 'connected');
  assert.strictEqual(r.via, 'remembered');
  assert.strictEqual(broadcasts, 0);
});

test('a remembered server that moved is followed to its new address', async () => {
  const r = await search({ remembered: { serverId: A, address: '10.0.0.5', port: 8080 } }, {
    find: async () => [{ serverId: B, address: '10.0.0.9', port: 8080 }, { serverId: A, address: '10.0.0.7', port: 8080 }],
    hello: helloFrom({ '10.0.0.7:8080': { serverId: A, name: 'HP' }, '10.0.0.9:8080': { serverId: B, name: 'Other' } })
  });
  assert.strictEqual(r.state, 'connected');
  assert.strictEqual(r.via, 'moved');
  assert.strictEqual(r.server.address, '10.0.0.7');
});

test('a different server at the remembered address is not trusted', async () => {
  const r = await search({ remembered: { serverId: A, address: '10.0.0.5', port: 8080 } },
    { find: async () => [], hello: helloFrom({ '10.0.0.5:8080': { serverId: B, name: 'Imposter' } }) });
  assert.strictEqual(r.state, 'not-found');
});

test('one answer connects; several ask; none says so', async () => {
  const one = await search({}, { find: async () => [{ serverId: A, address: '10.0.0.7', port: 8080 }], hello: helloFrom({ '10.0.0.7:8080': { serverId: A, name: 'HP' } }) });
  assert.deepStrictEqual([one.state, one.via], ['connected', 'discovery']);
  const two = await search({}, {
    find: async () => [{ serverId: A, address: '10.0.0.7', port: 8080 }, { serverId: B, address: '10.0.0.9', port: 8080 }],
    hello: helloFrom({ '10.0.0.7:8080': { serverId: A, name: 'HP' }, '10.0.0.9:8080': { serverId: B, name: 'Spare' } })
  });
  assert.strictEqual(two.state, 'choose');
  assert.strictEqual(two.servers.length, 2);
  let rounds = 0;
  const none = await search({ rounds: 2 }, { find: async () => { rounds++; return []; }, hello: helloFrom({}) });
  assert.strictEqual(none.state, 'not-found');
  assert.strictEqual(rounds, 2);
});

test('an answer whose HTTP serverId differs from its broadcast reply is dropped', async () => {
  const r = await search({}, { find: async () => [{ serverId: A, address: '10.0.0.7', port: 8080 }], hello: helloFrom({ '10.0.0.7:8080': { serverId: B, name: 'Swapped' } }) });
  assert.strictEqual(r.state, 'not-found');
  assert.strictEqual(r.heard, 1);
});

test('a broadcast that fails (no network) is reported, not thrown', async () => {
  const r = await search({ rounds: 1 }, { find: async () => { throw new Error('send ENETUNREACH'); }, hello: helloFrom({}) });
  assert.strictEqual(r.state, 'not-found');
  assert.match(r.error, /ENETUNREACH/);
});
