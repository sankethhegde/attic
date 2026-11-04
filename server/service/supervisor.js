// supervisor.js — Phase 3, milestone 3-1 (T-03): keeps the HP server running with nobody signed in.
//
// The Windows task (service.js) starts this at boot. It runs server.js as a child process and:
//   - restarts it when it exits, waiting 1, 2, 5, 10, then 30 s between tries; a run that stayed up for a
//     minute resets the wait, so one crash a day restarts at once;
//   - restarts it when it stops answering GET /api/hello (three misses, 15 s apart): a hang, not a crash;
//   - writes everything the server prints, with times, to data/logs/attic-YYYY-MM-DD.log, keeping 14 days;
//   - records what it's doing in data/supervisor.json for `service.js status`;
//   - refuses to start twice.
// The server watches the supervisor's process id (ATTIC_SUPERVISOR_PID) and exits if it's gone, so
// stopping the task never leaves an orphaned server holding the port. Core Node only.
// Usage: node server/service/supervisor.js   (normally started by the task, not by hand)
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), http = require('http');

const SERVER = process.env.ATTIC_SERVER_SCRIPT || path.join(__dirname, '..', 'server.js'); // a test can swap in a fake
const DATA_DIR = process.env.ATTIC_DATA || path.join(__dirname, '..', 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const STATE = path.join(DATA_DIR, 'supervisor.json');
const BACKOFF_S = [1, 2, 5, 10, 30];
const HEALTHY_MS = 60e3;
const HEALTH_MS = +process.env.ATTIC_HEALTH_MS || 15e3;
const HEALTH_MISSES = 3;
const KEEP_LOG_DAYS = 14;

// ---------- logs ----------
fs.mkdirSync(LOG_DIR, { recursive: true });
let logDay = null, logFd = null;
function log(line) {
  const t = new Date();
  const day = t.toISOString().slice(0, 10);
  if (day !== logDay) {
    if (logFd !== null) fs.closeSync(logFd);
    logDay = day;
    logFd = fs.openSync(path.join(LOG_DIR, `attic-${day}.log`), 'a');
    pruneLogs();
  }
  fs.writeSync(logFd, `${t.toISOString()} ${line}\n`);
}
function pruneLogs() {
  const cutoff = Date.now() - KEEP_LOG_DAYS * 864e5;
  for (const f of fs.readdirSync(LOG_DIR)) {
    const m = /^attic-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
    if (m && Date.parse(m[1]) < cutoff) fs.rmSync(path.join(LOG_DIR, f), { force: true });
  }
}
// Lines from the child, prefixed by stream; a partial last line waits for the rest.
function lines(prefix) {
  let rest = '';
  return chunk => {
    const parts = (rest + chunk).split(/\r?\n/);
    rest = parts.pop();
    for (const p of parts) if (p) log(prefix + p);
  };
}

// ---------- one at a time ----------
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
let state = {};
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { /* first run */ }
if (state.supervisorPid && state.supervisorPid !== process.pid && alive(state.supervisorPid) && state.running) {
  console.error(`Another supervisor (process ${state.supervisorPid}) is already running.`);
  log(`Not starting: supervisor ${state.supervisorPid} is already running`);
  process.exit(3);
}
state = { supervisorPid: process.pid, startedAt: new Date().toISOString(), running: true, serverPid: null, serverStartedAt: null,
  restarts: 0, lastExit: null, nextStartAt: null };
function save(patch) {
  Object.assign(state, patch);
  try { fs.writeFileSync(STATE + '.tmp', JSON.stringify(state, null, 2)); fs.renameSync(STATE + '.tmp', STATE); }
  catch (e) { log('Could not save supervisor state: ' + e.message); }
}
save({});
log(`Supervisor started (process ${process.pid}), running ${SERVER}`);

// ---------- the server ----------
let child = null, attempt = 0, stopping = false, healthTimer = null, startTimer = null;
let port = null; // read from the server's first line, "Attic server listening on 0.0.0.0:8080"

function start() {
  startTimer = null;
  if (stopping) return;
  const env = Object.assign({}, process.env, { ATTIC_SUPERVISOR_PID: String(process.pid) });
  child = spawn(process.execPath, [SERVER], { cwd: path.dirname(SERVER), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const started = Date.now();
  save({ serverPid: child.pid, serverStartedAt: new Date(started).toISOString(), nextStartAt: null });
  log(`Server started (process ${child.pid})`);
  const out = lines('  '), err = lines('! ');
  child.stdout.on('data', d => {
    const s = String(d);
    const m = /listening on [^:\s]+:(\d+)/.exec(s);
    if (m) port = +m[1];
    out(s);
  });
  child.stderr.on('data', d => err(String(d)));
  child.on('error', e => log('Could not start the server: ' + e.message));
  child.on('exit', (code, signal) => {
    clearInterval(healthTimer);
    const ran = Date.now() - started;
    child = null;
    save({ serverPid: null, lastExit: { code, signal, at: new Date().toISOString(), ranMs: ran } });
    if (stopping) return;
    if (ran >= HEALTHY_MS) attempt = 0;
    const wait = BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)];
    attempt++;
    state.restarts++;
    save({ nextStartAt: new Date(Date.now() + wait * 1000).toISOString() });
    log(`Server stopped (${signal || 'exit code ' + code}) after ${Math.round(ran / 1000)} s; restarting in ${wait} s`);
    startTimer = setTimeout(start, wait * 1000);
  });

  // A server that's up but not answering is killed, and the exit above restarts it.
  let misses = 0;
  healthTimer = setInterval(() => {
    if (!port || !child) return;
    const req = http.get({ host: '127.0.0.1', port, path: '/api/hello', timeout: 5000 }, res => {
      res.resume();
      misses = res.statusCode === 200 ? 0 : misses + 1;
      check();
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => { misses++; check(); });
  }, HEALTH_MS);
  function check() {
    if (misses < HEALTH_MISSES || !child) return;
    log(`Server didn't answer ${misses} health checks in a row; restarting it`);
    misses = 0;
    child.kill();
  }
}

function stop(why) {
  if (stopping) return;
  stopping = true;
  log(`Supervisor stopping (${why})`);
  clearTimeout(startTimer);
  clearInterval(healthTimer);
  const done = () => { save({ running: false, serverPid: null }); log('Supervisor stopped'); process.exit(0); };
  if (!child) return done();
  child.once('exit', done);
  child.kill();
  setTimeout(done, 5000).unref();
}
process.on('SIGINT', () => stop('interrupted'));
process.on('SIGTERM', () => stop('asked to stop'));
process.on('SIGBREAK', () => stop('asked to stop'));
// `service.js stop` asks politely through a file first, so the server gets to finish cleanly.
const STOP_FILE = path.join(DATA_DIR, 'supervisor.stop');
try { fs.rmSync(STOP_FILE, { force: true }); } catch (e) { /* none */ }
setInterval(() => { if (fs.existsSync(STOP_FILE)) { fs.rmSync(STOP_FILE, { force: true }); stop('stop requested'); } }, 1000);

start();
