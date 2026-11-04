// service.js — Phase 3, milestone 3-1 (T-03): run the HP server as a background service that starts
// with Windows, before anyone signs in, and comes back after a crash.
//
// It registers a Windows Task Scheduler task, "Attic Hub Server", that runs supervisor.js:
//   - at startup, before anyone signs in;
//   - as this Windows account, but without storing its password ("S4U"), so it can reach this PC's
//     drives (and files it writes stay yours) but not network shares, which Attic doesn't use;
//   - on battery too, with no time limit, never twice at once;
//   - restarted by Windows, every minute, if the supervisor itself ever dies. The supervisor restarts
//     the server.
// Core Node and the PowerShell that ships with Windows; nothing to download. A real Windows service
// needs a separate wrapper program, which this avoids, and a startup task gives the same three things.
//
// Usage (install and uninstall need an Administrator PowerShell; the rest don't):
//   node server/service/service.js install     register the task and start it
//   node server/service/service.js uninstall   stop it and remove the task
//   node server/service/service.js start | stop | restart
//   node server/service/service.js status [--json]
//   node server/service/service.js logs [--lines 50]
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const TASK = 'Attic Hub Server';
const SERVER_DIR = path.join(__dirname, '..');
const SUPERVISOR = path.join(__dirname, 'supervisor.js');
const DATA_DIR = process.env.ATTIC_DATA || path.join(SERVER_DIR, 'data');
const CONFIG = process.env.ATTIC_CONFIG || path.join(SERVER_DIR, 'config.json');
const STATE = path.join(DATA_DIR, 'supervisor.json');
const STOP_FILE = path.join(DATA_DIR, 'supervisor.stop');

// PowerShell single-quoted string: only ' needs doubling.
const psq = s => `'${String(s).replace(/'/g, "''")}'`;

function runPs(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    { input: script, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

const isAdmin = () => runPs('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)') === 'True';

// The task, as PowerShell. Kept a pure function so the tests can read exactly what gets registered.
function installScript({ task = TASK, node = process.execPath, supervisor = SUPERVISOR, workDir = SERVER_DIR, user = `${process.env.USERDOMAIN || os.hostname()}\\${os.userInfo().username}` } = {}) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute ${psq(node)} -Argument ${psq(`"${supervisor}"`)} -WorkingDirectory ${psq(workDir)}`,
    '$trigger = New-ScheduledTaskTrigger -AtStartup',
    `$principal = New-ScheduledTaskPrincipal -UserId ${psq(user)} -LogonType S4U -RunLevel Limited`,
    '$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -DontStopOnIdleEnd -StartWhenAvailable ' +
      '-ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew',
    `Register-ScheduledTask -TaskName ${psq(task)} -Description ${psq('Attic Hub: the HP server, started with Windows before anyone signs in, restarted after a crash.')} ` +
      '-Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null'
  ].join('\n');
}

// The task as Windows sees it, or null when it isn't installed.
function taskInfo(task = TASK) {
  const out = runPs([
    `$t = Get-ScheduledTask -TaskName ${psq(task)} -ErrorAction SilentlyContinue`,
    "if (-not $t) { 'null'; exit }",
    `$i = Get-ScheduledTaskInfo -TaskName ${psq(task)}`,
    "[pscustomobject]@{ state = [string]$t.State; user = $t.Principal.UserId; logon = [string]$t.Principal.LogonType; " +
      "lastRun = if ($i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('o') } else { $null }; lastResult = $i.LastTaskResult; " +
      "action = $t.Actions[0].Execute + ' ' + $t.Actions[0].Arguments } | ConvertTo-Json -Compress"
  ].join('\n'));
  return JSON.parse(out || 'null');
}

function supervisorState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { return null; }
}
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function configuredPort() {
  if (process.env.ATTIC_PORT) return +process.env.ATTIC_PORT;
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')).port || 8080; } catch (e) { return 8080; }
}
function hello(port, ms = 3000) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/hello', timeout: ms }, res => {
      let b = ''; res.on('data', d => b += d); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function status(task = TASK) {
  const t = taskInfo(task);
  const s = supervisorState();
  const supervising = !!(s && s.running && alive(s.supervisorPid));
  const port = configuredPort();
  const answer = await hello(port);
  return {
    installed: !!t, task: t,
    supervisor: supervising ? { pid: s.supervisorPid, since: s.startedAt, serverPid: s.serverPid, serverSince: s.serverStartedAt, restarts: s.restarts, lastExit: s.lastExit } : null,
    server: answer ? { port, serverId: answer.serverId, name: answer.name, byService: supervising && !!s.serverPid } : null
  };
}

// ---------- commands ----------
const say = (...a) => console.log(...a);
function needAdmin(what) {
  if (isAdmin()) return true;
  say(`${what} needs an Administrator PowerShell. Start → type PowerShell → right-click "Windows PowerShell" → Run as administrator, then:`);
  say(`  cd "${path.resolve(SERVER_DIR, '..')}"`);
  say(`  node server/service/service.js ${process.argv[2]}`);
  process.exitCode = 2;
  return false;
}

async function waitFor(test, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) if (await test()) return true;
  return false;
}

async function cmdStart() {
  runPs(`Start-ScheduledTask -TaskName ${psq(TASK)}`);
  const port = configuredPort();
  if (await waitFor(async () => !!(await hello(port, 1000)), 20e3)) say(`Started. The server answers on http://localhost:${port}`);
  else { say(`The task started, but the server isn't answering on port ${port} yet. See: node server/service/service.js logs`); process.exitCode = 1; }
}

// Politely first (the supervisor watches for a stop file and stops the server), then the task itself.
async function cmdStop() {
  const s = supervisorState();
  if (s && s.running && alive(s.supervisorPid)) {
    fs.writeFileSync(STOP_FILE, new Date().toISOString());
    if (!(await waitFor(() => !alive(s.supervisorPid), 10e3))) say('The supervisor didn’t stop in 10 s; ending the task.');
  }
  try { runPs(`Stop-ScheduledTask -TaskName ${psq(TASK)} -ErrorAction SilentlyContinue`); } catch (e) { /* not installed or not running */ }
  say('Stopped.');
}

async function main() {
  const cmd = process.argv[2];
  const flag = name => process.argv.includes(name);
  if (process.platform !== 'win32') { say('The service is for Windows. Run node server/server.js instead.'); process.exitCode = 1; return; }

  if (cmd === 'install') {
    if (!needAdmin('Installing the service')) return;
    if (!fs.existsSync(CONFIG)) { say(`There's no ${CONFIG} yet. Copy server/config.example.json to it and edit the paths first.`); process.exitCode = 1; return; }
    const port = configuredPort();
    const running = await hello(port, 1500);
    const s = supervisorState();
    if (running && !(s && s.running && alive(s.supervisorPid))) {
      say(`An Attic server is already running on port ${port}, started by hand. Stop it first (Ctrl+C in its window), then install again.`);
      process.exitCode = 1; return;
    }
    runPs(installScript());
    say(`Installed the task "${TASK}". It starts with Windows, before anyone signs in, as ${process.env.USERDOMAIN}\\${os.userInfo().username}.`);
    if (!flag('--no-start')) await cmdStart();
    return;
  }
  if (cmd === 'uninstall') {
    if (!needAdmin('Removing the service')) return;
    if (!taskInfo()) { say('The service isn’t installed.'); return; }
    await cmdStop();
    runPs(`Unregister-ScheduledTask -TaskName ${psq(TASK)} -Confirm:$false`);
    say(`Removed the task "${TASK}". The server no longer starts with Windows; your data and settings are untouched.`);
    return;
  }
  if (cmd === 'start') { if (!taskInfo()) { say('The service isn’t installed. Run: node server/service/service.js install'); process.exitCode = 1; return; } return cmdStart(); }
  if (cmd === 'stop') return cmdStop();
  if (cmd === 'restart') { await cmdStop(); return cmdStart(); }
  if (cmd === 'status') {
    const st = await status();
    if (flag('--json')) { say(JSON.stringify(st, null, 2)); return; }
    say(st.installed ? `Service:     installed ("${TASK}", ${st.task.state.toLowerCase()}, runs as ${st.task.user}${st.task.logon === 'S4U' ? ', no password stored' : ''})` : 'Service:     not installed');
    if (st.installed && st.task.lastRun) say(`Last start:  ${new Date(st.task.lastRun).toLocaleString()}`);
    say(st.supervisor ? `Supervisor:  running (process ${st.supervisor.pid}) since ${new Date(st.supervisor.since).toLocaleString()}; ${st.supervisor.restarts} restart${st.supervisor.restarts === 1 ? '' : 's'}` : 'Supervisor:  not running');
    say(st.server ? `Server:      answering on port ${st.server.port} as ${st.server.name}${st.server.byService ? '' : ' (started by hand, not by the service)'}` : 'Server:      not answering');
    return;
  }
  if (cmd === 'logs') {
    const i = process.argv.indexOf('--lines');
    const n = i > 0 ? Math.max(1, +process.argv[i + 1] || 50) : 50;
    const dir = path.join(DATA_DIR, 'logs');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^attic-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort() : [];
    if (!files.length) { say('No logs yet. They appear once the service has run.'); return; }
    const all = [];
    for (let k = files.length - 1; k >= 0 && all.length < n; k--) all.unshift(...fs.readFileSync(path.join(dir, files[k]), 'utf8').split(/\r?\n/).filter(Boolean));
    say(all.slice(-n).join('\n'));
    return;
  }
  say('Usage: node server/service/service.js install | uninstall | start | stop | restart | status [--json] | logs [--lines 50]');
  process.exitCode = cmd ? 1 : 0;
}

if (require.main === module) main().catch(e => { console.error(e.stderr ? String(e.stderr).trim() : e.message); process.exitCode = 1; });

module.exports = { installScript, taskInfo, status, isAdmin, TASK };
