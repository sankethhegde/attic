// game-watch.js — Phase 3, milestone 3-4 (T-09): is a game running on this PC?
//
// Low-resource mode (for the ROG Ally) slows the agent down while a game runs. Two signs count:
//   - Steam says a game is running (HKCU\Software\Valve\Steam, RunningAppID is not 0), and
//   - a full-screen app is in front: the foreground window covers its whole screen, or Windows reports
//     a Direct3D full-screen program (SHQueryUserNotificationState). Attic Hub's own window and the
//     desktop itself don't count, and neither does a maximized window (one with the taskbar hidden
//     covers the screen too).
// Asking Windows that takes a few native calls, so a tiny helper does it: C# compiled once, on first use,
// with the C# compiler every Windows 10 and 11 PC has (.NET Framework 4.8's csc.exe), into the tool's
// user-data folder. It checks every 2 s, prints one JSON line whenever the answer changes, and exits
// when the tool does (its stdin closes). It costs no CPU between checks, unlike PowerShell.
// Without the compiler, Automatic can't tell, and the mode is only Always on or Off.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const MODES = ['auto', 'on', 'off'];
const STEAM_KEY = 'Software\\Valve\\Steam';

const SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

static class GameWatch {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);

  static string Esc(string s) { return s == null ? "null" : "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }

  static int Main(string[] args) {
    int every = 2000; string steamKey = @"${STEAM_KEY}"; var ignore = new System.Collections.Generic.HashSet<uint>();
    for (int i = 0; i + 1 < args.Length; i += 2) {
      if (args[i] == "--every") every = Math.Max(250, int.Parse(args[i + 1]));
      else if (args[i] == "--steam-key") steamKey = args[i + 1];
      else if (args[i] == "--ignore-pid") ignore.Add(uint.Parse(args[i + 1]));
    }
    // The tool closes our stdin when it quits (or dies): stop with it.
    new Thread(() => { try { while (Console.In.ReadLine() != null) { } } catch { } Environment.Exit(0); }) { IsBackground = true }.Start();
    string last = null;
    while (true) {
      int steamApp = 0;
      try { using (var k = Registry.CurrentUser.OpenSubKey(steamKey)) { if (k != null) steamApp = Convert.ToInt32(k.GetValue("RunningAppID", 0)); } } catch { }
      string app = null; bool full = false;
      try {
        IntPtr h = GetForegroundWindow();
        if (h != IntPtr.Zero && IsWindowVisible(h) && !IsIconic(h)) {
          uint pid; GetWindowThreadProcessId(h, out pid);
          var cls = new StringBuilder(64); GetClassName(h, cls, 64);
          string c = cls.ToString();
          bool shell = c == "Progman" || c == "WorkerW" || c == "Shell_TrayWnd" || c == "Shell_SecondaryTrayWnd";
          if (!shell && !ignore.Contains(pid)) {
            RECT r; var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
            if (GetWindowRect(h, out r) && GetMonitorInfo(MonitorFromWindow(h, 2), ref mi))
              full = !IsZoomed(h) && r.L <= mi.rcMonitor.L && r.T <= mi.rcMonitor.T && r.R >= mi.rcMonitor.R && r.B >= mi.rcMonitor.B;
            if (full) { try { app = Process.GetProcessById((int)pid).ProcessName; } catch { app = "?"; } }
          }
        }
      } catch { }
      int quns = 0; try { SHQueryUserNotificationState(out quns); } catch { }
      bool d3d = quns == 3;
      string why = steamApp != 0 ? "steam" : full ? "fullscreen" : d3d ? "fullscreen" : null;
      string line = "{\"game\":" + (why != null ? "true" : "false") + ",\"why\":" + Esc(why) + ",\"app\":" + Esc(app)
        + ",\"steamApp\":" + steamApp + ",\"d3d\":" + (d3d ? "true" : "false") + "}";
      if (line != last) { Console.Out.WriteLine(line); Console.Out.Flush(); last = line; }
      Thread.Sleep(every);
    }
  }
}
`;

const HASH = crypto.createHash('sha256').update(SOURCE).digest('hex').slice(0, 10);

function compilerPath() {
  const win = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const p = path.join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// The helper's exe in `dir`, compiled if this version of it isn't there yet. → path, or null (no compiler).
async function ensureHelper(dir) {
  if (process.platform !== 'win32') return null;
  const exe = path.join(dir, `attic-gamewatch-${HASH}.exe`);
  if (fs.existsSync(exe)) return exe;
  const csc = compilerPath();
  if (!csc) return null;
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, `attic-gamewatch-${HASH}.cs`), tmp = exe + '.tmp.exe';
  fs.writeFileSync(src, SOURCE);
  await new Promise((resolve, reject) => execFile(csc, ['/nologo', '/optimize+', '/target:exe', `/out:${tmp}`, src],
    { windowsHide: true, timeout: 60e3 }, (err, out) => err ? reject(new Error('The game check didn’t compile: ' + (out || err.message).trim())) : resolve()));
  fs.renameSync(tmp, exe);
  fs.rmSync(src, { force: true });
  // Older versions of the helper aren't needed any more.
  for (const f of fs.readdirSync(dir)) if (/^attic-gamewatch-.*\.exe$/.test(f) && !f.includes(HASH)) fs.rmSync(path.join(dir, f), { force: true });
  return exe;
}

// What low-resource mode is right now. pref: 'auto' | 'on' | 'off'; game: the watcher's last answer (or null).
function decide(pref, game) {
  if (pref === 'on') return { active: true, reason: 'on' };
  if (pref === 'off' || !game || !game.game) return { active: false, reason: pref === 'off' ? 'off' : null };
  return { active: true, reason: game.why, app: game.app || null };
}

// Runs the helper and follows its answers. → { stop(), get state() } ; onChange({ game, why, app }).
// opts.exe: the helper (from ensureHelper); opts.args: extra arguments (tests: --steam-key, --every).
function watch({ exe, args = [], ignorePid = process.pid, onChange = () => {}, onExit = () => {} }) {
  const child = spawn(exe, ['--ignore-pid', String(ignorePid), ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let state = null, buf = '', stopped = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      try { state = JSON.parse(line); onChange(state); } catch (e) { /* not a line of ours */ }
    }
  });
  child.on('error', () => {});
  child.on('exit', code => { if (!stopped) onExit(code); });
  return {
    get state() { return state; },
    pid: child.pid,
    stop() { stopped = true; try { child.stdin.end(); } catch (e) { /* gone */ } setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, 1000).unref(); }
  };
}

module.exports = { MODES, STEAM_KEY, SOURCE, HASH, compilerPath, ensureHelper, decide, watch };
