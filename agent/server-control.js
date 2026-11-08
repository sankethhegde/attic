// server-control.js — Phase 3, milestone 3-1 (T-02, T-03): the desktop tool's controls for Server mode.
//
// The HP's half (server/service/) registers the server as a Windows startup task, "Attic Hub Server",
// that runs the supervisor, which runs the server. This drives it from the tool instead of a terminal:
//   - status: is the task installed (and pointing at this tool), is the supervisor running, does the
//     server answer;
//   - install / remove: the task script from service.js's installScript(), run through a Windows
//     permission prompt, since registering a startup task needs Administrator rights;
//   - start / stop / restart, and the latest log lines;
//   - "start now": the supervisor as a child of the tool, without installing anything, until the tool
//     closes or it's stopped.
// PowerShell runs asynchronously, so the window never freezes while Windows answers. Core Node only.
'use strict';
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const psq = s => `'${String(s).replace(/'/g, "''")}'`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function runPs(script, { timeout = 60e3 } = {}) {
  return new Promise((resolve, reject) => {
    const p = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
      { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 4 << 20 }, (err, out, errOut) => {
        if (err) { err.stderr = errOut; return reject(err); }
        resolve(String(out).trim());
      });
    p.stdin.end(script);
  });
}

function hello(port, ms = 2000) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/hello', timeout: ms }, res => {
      let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// paths: { dir, config, data } (mode.js serverPaths). exe and supervisor: what the task runs, and
// nodeEnv: the environment that makes `exe` run a script as Node (ELECTRON_RUN_AS_NODE for the tool).
function createControl({ paths, service, exe, supervisor, workDir, nodeEnv = {}, canInstall = true }) {
  const TASK = service.TASK;
  const stateFile = path.join(paths.data, 'supervisor.json');
  const stopFile = path.join(paths.data, 'supervisor.stop');
  const env = Object.assign({}, process.env, nodeEnv, { ATTIC_DATA: paths.data, ATTIC_CONFIG: paths.config });
  let child = null; // "start now"

  const port = () => { try { return +process.env.ATTIC_PORT || JSON.parse(fs.readFileSync(paths.config, 'utf8')).port || 8080; } catch (e) { return 8080; } };
  const supState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return null; } };

  async function taskInfo() {
    try { return await new Promise((resolve, reject) => { try { resolve(service.taskInfo(TASK)); } catch (e) { reject(e); } }); }
    catch (e) { return null; }
  }

  // Registering or removing a startup task needs Administrator rights: the script runs in an elevated
  // PowerShell, through Windows' permission prompt. Errors come back through a file, since an elevated
  // process can't share this one's output.
  async function runElevated(script) {
    const base = path.join(os.tmpdir(), `attic-hub-${process.pid}-${Date.now()}`);
    const errFile = base + '.err';
    fs.writeFileSync(base + '.ps1', '﻿' + [
      "$ErrorActionPreference = 'Stop'",
      'try {', script, '} catch {', `  $_.Exception.Message | Out-File -Encoding utf8 ${psq(errFile)}`, '  exit 1', '}'
    ].join('\n'));
    try {
      await runPs(`$p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psq(base + '.ps1')}; exit $p.ExitCode`, { timeout: 5 * 60e3 });
    } catch (e) {
      const why = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf8').replace(/^﻿/, '').trim() : '';
      if (/cancel/i.test(String(e.stderr || e.message)) && !why) throw new Error('Windows asked for permission, and it wasn’t given. Nothing was changed.');
      throw new Error(why || 'Windows couldn’t make the change. ' + String(e.stderr || e.message).split('\n')[0]);
    } finally {
      for (const f of [base + '.ps1', errFile]) try { fs.rmSync(f, { force: true }); } catch (e) { /* gone */ }
    }
  }

  async function waitFor(test, ms) {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(400)) if (await test()) return true;
    return false;
  }

  const api = {
    async status() {
      const [t, answer] = await Promise.all([taskInfo(), hello(port())]);
      const s = supState();
      const supervising = !!(s && s.running && alive(s.supervisorPid));
      const action = t ? String(t.action || '') : '';
      return {
        port: port(),
        canInstall,
        task: t ? { state: String(t.state || '').toLowerCase(), user: t.user, lastRun: t.lastRun, lastResult: t.lastResult,
          ours: action.toLowerCase().includes(String(supervisor).toLowerCase()) && action.toLowerCase().includes(path.basename(exe).toLowerCase()) } : null,
        supervisor: supervising ? { pid: s.supervisorPid, since: s.startedAt, restarts: s.restarts || 0, lastExit: s.lastExit || null,
          startedNow: !!(child && child.pid === s.supervisorPid) } : null,
        server: answer ? { name: answer.name, serverId: answer.serverId, byHand: !supervising } : null
      };
    },

    async install() {
      if (!canInstall) throw new Error('Install the service from the installed Attic Hub, not a development copy.');
      const st = await api.status();
      if (st.server && st.server.byHand) throw new Error(`Another Attic server is already running on port ${st.port}, started by hand. Stop it first (Ctrl+C in its window), then install.`);
      if (child) await api.stop();
      await runElevated(service.installScript({ node: exe, supervisor, workDir }));
      return api.start();
    },

    async remove() {
      await api.stop();
      if (!(await taskInfo())) return;
      // The firewall rules the install added (Wi-Fi fix) go with it.
      await runElevated(`Unregister-ScheduledTask -TaskName ${psq(TASK)} -Confirm:$false` + (service.firewallRemoveScript ? '\n' + service.firewallRemoveScript() : ''));
    },

    async start() {
      if (!(await taskInfo())) throw new Error('The service isn’t installed.');
      await runPs(`Start-ScheduledTask -TaskName ${psq(TASK)}`);
      if (!(await waitFor(async () => !!(await hello(port(), 1000)), 25e3))) throw new Error(`The service started, but the server isn’t answering on port ${port()} yet. See the log below.`);
    },

    // Politely first (the supervisor stops the server when it sees the stop file), then the task itself.
    async stop() {
      const s = supState();
      if (s && s.running && alive(s.supervisorPid)) {
        fs.mkdirSync(paths.data, { recursive: true });
        fs.writeFileSync(stopFile, new Date().toISOString());
        await waitFor(() => !alive(s.supervisorPid), 10e3);
      }
      if (child) { try { child.kill(); } catch (e) { /* gone */ } child = null; }
      try { await runPs(`Stop-ScheduledTask -TaskName ${psq(TASK)} -ErrorAction SilentlyContinue`); } catch (e) { /* not installed */ }
    },

    async restart() {
      await api.stop();
      if (await taskInfo()) return api.start();
      return api.startNow();
    },

    // The supervisor as a child of the tool: no install, no permission prompt; it stops with the tool.
    async startNow() {
      const st = await api.status();
      if (st.server) throw new Error(st.server.byHand ? `An Attic server is already running on port ${st.port}, started by hand.` : 'The server is already running.');
      child = spawn(exe, [supervisor], { cwd: workDir, env, stdio: 'ignore', windowsHide: true });
      child.on('exit', () => { child = null; });
      if (!(await waitFor(async () => !!(await hello(port(), 1000)), 25e3))) throw new Error(`The server didn’t start on port ${port()}. See the log below.`);
    },
    get startedNow() { return !!child; },
    stopChild() { if (child) { try { child.kill(); } catch (e) { /* gone */ } child = null; } },

    logs(lines = 40) {
      const dir = path.join(paths.data, 'logs');
      const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^attic-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort() : [];
      const out = [];
      for (let k = files.length - 1; k >= 0 && out.length < lines; k--) out.unshift(...fs.readFileSync(path.join(dir, files[k]), 'utf8').split(/\r?\n/).filter(Boolean));
      return out.slice(-lines);
    },
    url: () => `http://localhost:${port()}/`
  };
  return api;
}

module.exports = { createControl, hello };
