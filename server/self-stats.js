// self-stats.js — Phase 2, milestone 2-3: the HP's own stats for the Devices view, from core Node.
// Client PCs report theirs through the agent (systeminformation); the HP is the server and has no agent,
// so it measures itself the same shape. Battery isn't readable from core Node, so it's null here.
'use strict';
const fs = require('fs'), os = require('os');

// CPU use since the last call, from the per-core time counters.
function cpuMeter() {
  const snap = () => os.cpus().reduce((a, c) => {
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

// The address other devices reach the HP on, and whether that interface is Wi-Fi or Ethernet (by the
// name Windows gives it). Link-local 169.254.* addresses belong to unconnected adapters and are skipped.
function network(interfaces = os.networkInterfaces()) {
  for (const [name, list] of Object.entries(interfaces)) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const connection = /wi-?fi|wlan|wireless/i.test(name) ? 'wifi' : /ethernet|^eth|^en/i.test(name) ? 'ethernet' : 'other';
      return { connection, ip: a.address };
    }
  }
  return { connection: null, ip: null };
}

function createSelfStats({ disk = process.env.SystemDrive ? process.env.SystemDrive + '\\' : '/' } = {}) {
  const cpu = cpuMeter();
  return async () => {
    let diskTotal = 0, diskFree = 0;
    try { const st = await fs.promises.statfs(disk); diskTotal = st.blocks * st.bsize; diskFree = st.bavail * st.bsize; }
    catch (e) { /* unreadable: reported as zero */ }
    const ramTotal = os.totalmem();
    return Object.assign({
      stats: { cpu: cpu(), ramTotal, ramUsed: ramTotal - os.freemem(), diskTotal, diskFree, battery: null, charging: false }
    }, network());
  };
}

module.exports = { createSelfStats, network };
