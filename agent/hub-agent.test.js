// Tests for agent/hub-agent.js and agent/stats.js. Run: node --test "agent/*.test.js"
// The hub itself is the HP's (server/hub.test.js); desktop/scripts/live-stats-test.mjs runs the real
// tool against the real server.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createAgent, hubUrl } = require('./hub-agent.js');
const { createCollector, cpuMeter, guessNetwork } = require('./stats.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A stand-in for the WebSocket class: records what's sent and lets the test play the HP.
function fakeWS() {
  const made = [];
  class WS {
    constructor(url, opts) { this.url = url; this.opts = opts; this.sent = []; this.readyState = 1; made.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; }
    hello(interval) { this.onmessage({ data: JSON.stringify({ type: 'hello', role: 'agent', deviceId: 'dev_1', interval }) }); }
    drop(code) { this.readyState = 3; this.onclose({ code }); }
  }
  return { WS, made };
}
const report = { stats: { cpu: 12, ramTotal: 8e9, ramUsed: 4e9, diskTotal: 5e11, diskFree: 2e11, battery: 80, charging: false }, connection: 'wifi', ip: '192.168.1.5' };

test('the agent sends its token, waits for hello, then reports on the interval it was given', async () => {
  const { WS, made } = fakeWS();
  const states = [];
  const a = createAgent({ url: hubUrl({ address: '192.168.1.12', port: 8080 }), token: 'tok', collect: async () => report, WebSocketImpl: WS, onState: s => states.push(s) });
  assert.strictEqual(made[0].url, 'ws://192.168.1.12:8080/api/hub?role=agent');
  assert.deepStrictEqual(made[0].opts.headers, { 'X-Attic-Device': 'tok' });
  await sleep(30);
  assert.strictEqual(made[0].sent.length, 0, 'nothing before hello');
  made[0].hello(1000);
  await sleep(20);
  assert.deepStrictEqual(made[0].sent[0], Object.assign({ type: 'stats' }, report));
  await sleep(1050);
  assert.strictEqual(made[0].sent.length, 2);
  assert.deepStrictEqual(states, ['connecting', 'reporting']);
  a.stop();
});

test('a dropped connection is retried with a growing wait, and hello resets it', async () => {
  const { WS, made } = fakeWS();
  const waits = [];
  const a = createAgent({ url: 'ws://x/api/hub?role=agent', token: 't', collect: async () => report, WebSocketImpl: WS,
    backoff: [10, 20, 40], onState: (s, d) => { if (s === 'retrying') waits.push(d); } });
  made[0].drop(1006);
  await sleep(15);
  made[1].drop(1006);
  await sleep(30);
  made[2].hello(1000);
  made[2].drop(1001);
  await sleep(15);
  assert.deepStrictEqual(waits, [10, 20, 10]);
  assert.strictEqual(made.length, 4);
  a.stop();
});

test('unpaired (4001) and replaced (4000) stop the agent for good', async () => {
  for (const [code, state] of [[4001, 'unpaired'], [4000, 'replaced']]) {
    const { WS, made } = fakeWS();
    const a = createAgent({ url: 'ws://x', token: 't', collect: async () => report, WebSocketImpl: WS, backoff: [5] });
    made[0].hello(1000);
    made[0].drop(code);
    await sleep(30);
    assert.strictEqual(a.state, state);
    assert.strictEqual(made.length, 1, 'no reconnect');
  }
});

test('stop closes the connection and ends the reports', async () => {
  const { WS, made } = fakeWS();
  const a = createAgent({ url: 'ws://x', token: 't', collect: async () => report, WebSocketImpl: WS });
  made[0].hello(1000);
  await sleep(20);
  a.stop();
  await sleep(1100);
  assert.strictEqual(made[0].sent.length, 1);
  assert.strictEqual(made[0].readyState, 3);
  assert.strictEqual(a.state, 'stopped');
});

test('the collector reports this PC in the hub’s shape', async () => {
  const fakeSi = { battery: async () => ({ hasBattery: true, percent: 77.6, isCharging: true }),
    networkInterfaces: async () => ({ type: 'wired', ip4: '192.168.1.40' }) };
  const r = await createCollector({ si: fakeSi })();
  const s = r.stats;
  assert.ok(s.cpu >= 0 && s.cpu <= 100);
  assert.ok(s.ramTotal > 0 && s.ramUsed >= 0 && s.ramUsed <= s.ramTotal);
  assert.ok(s.diskTotal > 0 && s.diskFree >= 0 && s.diskFree <= s.diskTotal);
  assert.deepStrictEqual([s.battery, s.charging, r.connection, r.ip], [78, true, 'ethernet', '192.168.1.40']);
  const noBattery = await createCollector({ si: { battery: async () => ({ hasBattery: false }), networkInterfaces: async () => ({ type: 'wireless', ip4: '10.0.0.2' }) } })();
  assert.deepStrictEqual([noBattery.stats.battery, noBattery.connection], [null, 'wifi']);
});

test('slow readings are refreshed in the background, not on every report', async () => {
  let calls = 0;
  const si = { battery: async () => { calls++; return { hasBattery: false }; }, networkInterfaces: async () => ({}) };
  const collect = createCollector({ si, slowMs: 50 });
  await collect(); await collect(); await collect();
  assert.strictEqual(calls, 1);
  await sleep(60);
  await collect();
  await sleep(5);
  assert.strictEqual(calls, 2);
});

test('cpuMeter and guessNetwork', () => {
  let n = 0;
  const cpus = () => [{ times: { user: 50 * n, nice: 0, sys: 0, idle: 50 * n, irq: 0 } }];
  const m = cpuMeter(cpus);
  n = 1;
  assert.strictEqual(m(), 50);
  assert.deepStrictEqual(guessNetwork({ 'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.1.5' }] }), { connection: 'wifi', ip: '192.168.1.5' });
  assert.deepStrictEqual(guessNetwork({ 'Ethernet 2': [{ family: 'IPv4', internal: false, address: '169.254.3.3' }] }), { connection: null, ip: null });
});
