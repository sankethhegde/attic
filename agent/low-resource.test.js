// Tests for low-resource mode (3-4, T-09): agent/game-watch.js, the agent's pace, and the preference.
// Run: node --test "agent/*.test.js". desktop/scripts/low-resource-test.mjs checks the real tool.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const gameWatch = require('./game-watch.js');
const { createAgent } = require('./hub-agent.js');
const { createCollector } = require('./stats.js');
const prefs = require('./prefs.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('decide: Automatic follows the game; Always on and Off ignore it', () => {
  const g = { game: true, why: 'steam', app: 'eldenring' };
  assert.deepStrictEqual(gameWatch.decide('auto', g), { active: true, reason: 'steam', app: 'eldenring' });
  assert.deepStrictEqual(gameWatch.decide('auto', { game: false }), { active: false, reason: null });
  assert.deepStrictEqual(gameWatch.decide('auto', null), { active: false, reason: null });
  assert.deepStrictEqual(gameWatch.decide('on', null), { active: true, reason: 'on' });
  assert.deepStrictEqual(gameWatch.decide('off', g), { active: false, reason: 'off' });
});

test('prefs: a client is on Automatic, the server Off; only the three choices are kept', () => {
  const s = prefs.store(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'attic-prefs-')), 'prefs.json'));
  assert.deepStrictEqual([s.load('client').lowResource, s.load('server').lowResource], ['auto', 'off']);
  s.save({ lowResource: 'on' }, 'client');
  s.save({ lowResource: 'fast' }, 'client');
  assert.strictEqual(s.load('client').lowResource, 'on');
});

// A stand-in for the WebSocket class, as in hub-agent.test.js.
function fakeWS() {
  const made = [];
  class WS {
    constructor(url, opts) { this.sent = []; this.readyState = 1; made.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.readyState = 3; }
    hello(interval) { this.onmessage({ data: JSON.stringify({ type: 'hello', interval }) }); }
  }
  return { WS, made };
}
const report = { stats: { cpu: 1, ramTotal: 8e9, ramUsed: 4e9, diskTotal: 5e11, diskFree: 2e11, battery: null, charging: false }, connection: 'wifi', ip: '192.168.1.5' };

test('the agent slows to the pace it is given, and nudge() reports at once at the new pace', async () => {
  const { WS, made } = fakeWS();
  let slow = false;
  const a = createAgent({ url: 'ws://x', token: 't', collect: async () => report, WebSocketImpl: WS, pace: ms => (slow ? 3000 : ms) });
  made[0].hello(1000);
  await sleep(1150);
  assert.strictEqual(made[0].sent.length, 2, 'every second while normal');
  slow = true;
  await sleep(1000);                       // the report already scheduled goes; the next waits 3 s
  const n = made[0].sent.length;
  await sleep(1500);
  assert.strictEqual(made[0].sent.length, n, 'nothing more within the slower pace');
  slow = false;
  a.nudge();
  await sleep(30);
  assert.strictEqual(made[0].sent.length, n + 1, 'nudge reports straight away');
  await sleep(1050);
  assert.strictEqual(made[0].sent.length, n + 2, 'and the normal pace is back');
  a.stop();
});

test('the collector reads its slow refresh time each report', async () => {
  let calls = 0, wait = 60e3;
  const si = { battery: async () => { calls++; return { hasBattery: false }; }, networkInterfaces: async () => null };
  const c = createCollector({ si, slowMs: () => wait });
  await c(); await c();
  assert.strictEqual(calls, 1, 'within the refresh time: reused');
  wait = 0;
  await sleep(5);
  await c();
  await sleep(5);
  assert.strictEqual(calls, 2, 'past it: refreshed');
});

// The real helper: compiled with Windows' own C# compiler, then told about a Steam game through a
// registry key of the test's own (never Steam's).
test('the game watcher sees a Steam game start and stop', { skip: process.platform !== 'win32' || !gameWatch.compilerPath() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-gw-'));
  const exe = await gameWatch.ensureHelper(dir);
  assert.ok(exe && fs.existsSync(exe), 'compiled');
  assert.strictEqual(await gameWatch.ensureHelper(dir), exe, 'compiled once, then reused');
  const sub = `Software\\AtticHubTest\\Steam${process.pid}`;
  const reg = args => execFileSync('reg.exe', args, { windowsHide: true, stdio: 'ignore' });
  reg(['add', `HKCU\\${sub}`, '/v', 'RunningAppID', '/t', 'REG_DWORD', '/d', '0', '/f']);
  const seen = [];
  const w = gameWatch.watch({ exe, args: ['--steam-key', sub, '--every', '250'], onChange: s => seen.push(s) });
  try {
    const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(50); } return false; };
    assert.ok(await until(() => seen.length > 0), 'first answer');
    assert.strictEqual(seen[seen.length - 1].steamApp, 0);
    reg(['add', `HKCU\\${sub}`, '/v', 'RunningAppID', '/t', 'REG_DWORD', '/d', '1245620', '/f']);
    assert.ok(await until(() => w.state && w.state.why === 'steam'), 'a Steam game is running');
    assert.strictEqual(w.state.steamApp, 1245620);
    assert.strictEqual(w.state.game, true);
    reg(['add', `HKCU\\${sub}`, '/v', 'RunningAppID', '/t', 'REG_DWORD', '/d', '0', '/f']);
    assert.ok(await until(() => w.state && w.state.steamApp === 0), 'and it stopped');
  } finally {
    w.stop();
    reg(['delete', 'HKCU\\Software\\AtticHubTest', '/f']);
  }
  // It quits with the tool: closing its stdin ends it.
  await sleep(500);
  let alive = true;
  try { process.kill(w.pid, 0); } catch (e) { alive = false; }
  assert.strictEqual(alive, false, 'the helper exited');
});
