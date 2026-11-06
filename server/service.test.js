// Service tests (Phase 3, milestone 3-1, T-03): the supervisor keeps the server running, and the Windows
// task is registered the way the acceptance check needs (runs at boot with no one signed in). Nothing
// here installs a real task; that needs an Administrator PowerShell (see server/README.md).
// Run: node --test "server/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { installScript, taskInfo, isAdmin } = require('./service/service');

const SUPERVISOR = path.join(__dirname, 'service', 'supervisor.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const hello = port => new Promise(resolve => {
  const req = http.get({ host: '127.0.0.1', port, path: '/api/hello', timeout: 1000 }, res => { res.resume(); resolve(res.statusCode === 200); });
  req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false));
});
async function until(test, ms = 15000, step = 100) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) if (await test()) return true;
  return false;
}

// A throwaway server folder: config, data, and the supervisor pointed at it.
function setup(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-svc-'));
  fs.mkdirSync(path.join(dir, 'share'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: '127.0.0.1', shares: [{ id: 'main', name: 'Main', rootPath: path.join(dir, 'share') }] }));
  const port = 26000 + Math.floor(Math.random() * 1000);
  const env = Object.assign({}, process.env, { ATTIC_CONFIG: path.join(dir, 'config.json'), ATTIC_DATA: path.join(dir, 'data'), ATTIC_PORT: String(port), ATTIC_DISCOVERY_PORT: '0' }, extraEnv);
  const state = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'data', 'supervisor.json'), 'utf8')); } catch (e) { return {}; } };
  const logText = () => { const d = path.join(dir, 'data', 'logs'); return fs.existsSync(d) ? fs.readdirSync(d).map(f => fs.readFileSync(path.join(d, f), 'utf8')).join('') : ''; };
  const run = () => spawn(process.execPath, [SUPERVISOR], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const cleanup = async procs => {
    for (const p of procs) if (p && p.exitCode === null) p.kill();
    const s = state();
    if (s.serverPid && alive(s.serverPid)) try { process.kill(s.serverPid); } catch (e) { /* gone */ }
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { dir, port, env, state, logText, run, cleanup };
}
// A fake server script for the supervisor to run, so a test can make it hang or crash on purpose.
function fake(dir, body) {
  const f = path.join(dir, 'fake-server.js');
  fs.writeFileSync(f, body);
  return f;
}

// ---------- the task ----------
test('the Windows task starts at boot with no one signed in, on battery, with no time limit, and is restarted if it dies', () => {
  const s = installScript({ node: 'C:\\Program Files\\nodejs\\node.exe', supervisor: "C:\\Users\\O'Brien\\attic\\server\\service\\supervisor.js",
    workDir: "C:\\Users\\O'Brien\\attic\\server", user: 'DESKTOP-UL55ECB\\HP' });
  assert.match(s, /New-ScheduledTaskTrigger -AtStartup/, 'at boot, not at sign-in');
  assert.match(s, /-UserId 'DESKTOP-UL55ECB\\HP' -LogonType S4U -RunLevel Limited/, 'as the account, no password stored, not elevated');
  for (const f of ['-AllowStartIfOnBatteries', '-DontStopIfGoingOnBatteries', '-DontStopOnIdleEnd', '-StartWhenAvailable',
    '-ExecutionTimeLimit (New-TimeSpan -Seconds 0)', '-RestartCount 999', '-RestartInterval (New-TimeSpan -Minutes 1)', '-MultipleInstances IgnoreNew']) {
    assert.ok(s.includes(f), f);
  }
  assert.ok(s.includes(`-Execute 'C:\\Program Files\\nodejs\\node.exe'`));
  assert.ok(s.includes(`-Argument '"C:\\Users\\O''Brien\\attic\\server\\service\\supervisor.js"'`), "an apostrophe in a path is escaped for PowerShell");
  assert.ok(s.includes(`-WorkingDirectory 'C:\\Users\\O''Brien\\attic\\server'`));
  assert.match(s, /Register-ScheduledTask -TaskName 'Attic Hub Server'/);
});

test('status reads Windows without changing anything', { skip: process.platform !== 'win32' }, () => {
  assert.strictEqual(taskInfo('Attic Hub Server test ' + Date.now()), null, 'a task that doesn’t exist');
  assert.strictEqual(typeof isAdmin(), 'boolean');
});

// ---------- the supervisor ----------
test('the supervisor runs the server, restarts it after a crash, and logs it all', async () => {
  const t = setup();
  const sup = t.run();
  try {
    assert.ok(await until(() => hello(t.port)), 'the server comes up');
    const first = t.state();
    assert.strictEqual(first.supervisorPid, sup.pid);
    assert.ok(first.running && first.serverPid);
    // Crash: kill the server process outright.
    process.kill(first.serverPid);
    assert.ok(await until(() => { const s = t.state(); return s.serverPid && s.serverPid !== first.serverPid; }), 'a new server process');
    assert.ok(await until(() => hello(t.port)), 'and it answers again');
    const s = t.state();
    assert.strictEqual(s.restarts, 1);
    assert.ok(s.lastExit && s.lastExit.at);
    const log = t.logText();
    assert.match(log, /Supervisor started/);
    assert.match(log, / {2}Attic server listening on 127\.0\.0\.1:\d+/, 'the server’s own output, with times');
    assert.match(log, /Server stopped .*restarting in 1 s/);
    // Only one supervisor at a time.
    const second = t.run();
    const code = await new Promise(r => second.on('exit', r));
    assert.strictEqual(code, 3);
  } finally { await t.cleanup([sup]); }
});

test('asked to stop, the supervisor stops the server and itself', async () => {
  const t = setup();
  const sup = t.run();
  try {
    assert.ok(await until(() => hello(t.port)));
    const serverPid = t.state().serverPid;
    fs.writeFileSync(path.join(t.dir, 'data', 'supervisor.stop'), 'now');
    const code = await new Promise(r => sup.on('exit', r));
    assert.strictEqual(code, 0);
    assert.ok(await until(() => !alive(serverPid), 5000), 'the server is gone');
    assert.strictEqual(t.state().running, false);
    assert.match(t.logText(), /Supervisor stopped/);
  } finally { await t.cleanup([sup]); }
});

test('if the supervisor is killed, the server doesn’t linger holding the port', async () => {
  const t = setup();
  const sup = t.run();
  try {
    assert.ok(await until(() => hello(t.port)));
    const serverPid = t.state().serverPid;
    sup.kill(); // what Stop-ScheduledTask does: ends the process, no goodbye
    assert.ok(await until(() => !alive(serverPid), 8000), 'the server exits on its own');
    assert.strictEqual(await hello(t.port), false);
  } finally { await t.cleanup([sup]); }
});

test('a server that stops answering is restarted', async () => {
  const t = setup({ ATTIC_HEALTH_MS: '300' });
  const f = fake(t.dir, `
    const http = require('http');
    const port = +process.env.ATTIC_PORT;
    // Answers until a file appears, then hangs every request.
    http.createServer((q, r) => { if (require('fs').existsSync(${JSON.stringify(path.join(t.dir, 'hang'))})) return; r.end('{}'); })
      .listen(port, '127.0.0.1', () => console.log('Attic server listening on 127.0.0.1:' + port));
  `);
  t.env.ATTIC_SERVER_SCRIPT = f;
  const sup = t.run();
  try {
    assert.ok(await until(() => t.state().serverPid));
    const firstPid = t.state().serverPid;
    await sleep(500);
    fs.writeFileSync(path.join(t.dir, 'hang'), '');
    assert.ok(await until(() => { const s = t.state(); return s.serverPid && s.serverPid !== firstPid; }, 20000), 'restarted after the misses');
    assert.match(t.logText(), /didn't answer 3 health checks/);
    fs.rmSync(path.join(t.dir, 'hang'));
  } finally { await t.cleanup([sup]); }
});

test('a server that keeps crashing is retried with a growing wait, not in a tight loop', async () => {
  const t = setup();
  t.env.ATTIC_SERVER_SCRIPT = fake(t.dir, `console.error('Boom'); process.exit(1);`);
  const sup = t.run();
  try {
    assert.ok(await until(() => t.state().restarts >= 3, 12000));
    const log = t.logText();
    assert.match(log, /restarting in 1 s[\s\S]*restarting in 2 s[\s\S]*restarting in 5 s/);
    assert.match(log, /! Boom/, 'what the server printed to stderr is logged, marked');
    assert.ok(t.state().restarts <= 4, 'about 1 + 2 + 5 s: no more than a few tries');
  } finally { await t.cleanup([sup]); }
});
