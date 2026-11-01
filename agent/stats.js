// stats.js — Phase 2, milestone 2-3 (D-04): this PC's live stats, in the shape the Devices view reads.
//
// CPU, RAM and the system drive come from core Node every report: they're cheap to read. Battery and
// network (Wi-Fi or Ethernet) come from the systeminformation package, which on Windows starts PowerShell
// and takes about a second, so they're refreshed every 30 s in the background and the last values reused.
// `si` is passed in by the desktop tool (it lives in desktop/node_modules); without it, battery is null
// and the network type is guessed from the adapter's name.
'use strict';
const fs = require('fs');
const os = require('os');

const SLOW_MS = 30e3;

// CPU use since the last call, from the per-core time counters.
function cpuMeter(cpus = () => os.cpus()) {
  const snap = () => cpus().reduce((a, c) => {
    const t = c.times;
    a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return a;
  }, { idle: 0, total: 0 });
  let last = snap();
  return () => {
    const now = snap();
    const total = now.total - last.total, idle = now.idle - last.idle;
    last = now;
    return total > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - idle / total)))) : 0;
  };
}

// The first connected IPv4 adapter, by name, when systeminformation isn't there to ask.
function guessNetwork(interfaces = os.networkInterfaces()) {
  for (const [name, list] of Object.entries(interfaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      return { connection: /wi-?fi|wlan|wireless/i.test(name) ? 'wifi' : /ethernet|^eth|^en/i.test(name) ? 'ethernet' : 'other', ip: a.address };
    }
  }
  return { connection: null, ip: null };
}

async function readSlow(si) {
  const out = { battery: null, charging: false, connection: null, ip: null };
  if (!si) return Object.assign(out, guessNetwork());
  const [b, n] = await Promise.all([si.battery().catch(() => null), si.networkInterfaces('default').catch(() => null)]);
  if (b && b.hasBattery && Number.isFinite(b.percent)) Object.assign(out, { battery: Math.max(0, Math.min(100, Math.round(b.percent))), charging: !!b.isCharging });
  if (n && n.ip4) Object.assign(out, { connection: n.type === 'wireless' ? 'wifi' : n.type === 'wired' ? 'ethernet' : 'other', ip: n.ip4 });
  else Object.assign(out, guessNetwork());
  return out;
}

// → async () => { stats: { cpu, ramTotal, ramUsed, diskTotal, diskFree, battery, charging }, connection, ip }
function createCollector({ si = null, disk = process.env.SystemDrive ? process.env.SystemDrive + '\\' : '/', slowMs = SLOW_MS } = {}) {
  const cpu = cpuMeter();
  let slow = null, slowAt = 0, refreshing = null;
  const refresh = () => refreshing || (refreshing = readSlow(si).then(v => { slow = v; slowAt = Date.now(); }).finally(() => { refreshing = null; }));

  return async () => {
    if (!slow) await refresh();                     // the first report waits, so it's complete
    else if (Date.now() - slowAt > slowMs) refresh(); // later ones use the last values meanwhile
    let diskTotal = 0, diskFree = 0;
    try { const st = await fs.promises.statfs(disk); diskTotal = st.blocks * st.bsize; diskFree = st.bavail * st.bsize; }
    catch (e) { /* unreadable: reported as zero */ }
    const ramTotal = os.totalmem();
    return {
      stats: { cpu: cpu(), ramTotal, ramUsed: ramTotal - os.freemem(), diskTotal, diskFree, battery: slow.battery, charging: slow.charging },
      connection: slow.connection,
      ip: slow.ip
    };
  };
}

module.exports = { createCollector, cpuMeter, guessNetwork };
