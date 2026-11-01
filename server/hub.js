// hub.js — Phase 2, milestone 2-3 (D-03, D-04): the live side of the Devices view.
//
// Two kinds of WebSocket connection come in at /api/hub (see server.js for who may open which):
//   - an agent: the desktop tool's background part on a paired PC. It reports that PC's stats every
//     few seconds. It can't read anything back.
//   - a viewer: the interface, signed in on a paired device. The master gets every stats update as it
//     arrives; any other account gets only who is online.
// The hub keeps the latest stats per device (in memory, and in data/device-stats.json at most every
// 30 s, so a restart still knows them) and decides who is online. Core Node only.
'use strict';
const fs = require('fs'), path = require('path');

const PING_MS = 15e3;          // ping every connection this often…
const DEAD_MS = 35e3;          // …and drop one that hasn't answered for this long
const MIN_REPORT_MS = 900;     // an agent reporting faster than this has the extras ignored
const FLOOD = { count: 40, ms: 10e3 }; // more messages than this from one connection closes it
const SAVE_MS = 30e3;
const STATS_INTERVAL_MS = 3000; // what agents are asked to use
const CONNECTIONS = ['wifi', 'ethernet', 'other'];

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const MAX_BYTES = 1e15;

// An agent's report, checked and reduced to the fields the Devices view shows. Throws a message.
function cleanReport(msg) {
  const s = msg.stats;
  if (!s || typeof s !== 'object') throw 'Send { type: "stats", stats: { … } }.';
  if (!num(s.cpu, 0, 100)) throw 'cpu is a percentage, 0–100.';
  if (!num(s.ramTotal, 1, MAX_BYTES) || !num(s.ramUsed, 0, s.ramTotal)) throw 'ramTotal and ramUsed are bytes, used ≤ total.';
  if (!num(s.diskTotal, 1, MAX_BYTES) || !num(s.diskFree, 0, s.diskTotal)) throw 'diskTotal and diskFree are bytes, free ≤ total.';
  if (s.battery !== null && s.battery !== undefined && !num(s.battery, 0, 100)) throw 'battery is a percentage, 0–100, or null.';
  const ip = typeof msg.ip === 'string' && /^[0-9a-fA-F.:]{2,45}$/.test(msg.ip) ? msg.ip : null;
  return {
    stats: { cpu: Math.round(s.cpu), ramTotal: Math.round(s.ramTotal), ramUsed: Math.round(s.ramUsed),
      diskTotal: Math.round(s.diskTotal), diskFree: Math.round(s.diskFree),
      battery: s.battery === null || s.battery === undefined ? null : Math.round(s.battery), charging: s.charging === true },
    connection: CONNECTIONS.includes(msg.connection) ? msg.connection : null,
    ip
  };
}

function createHub(dataDir, { log = () => {} } = {}) {
  const file = path.join(dataDir, 'device-stats.json');
  let latest = {}; // deviceId -> { stats, connection, ip, at }
  try { latest = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { /* first run */ }
  let dirty = false;
  function save() {
    if (!dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(latest, null, 2));
      fs.renameSync(file + '.tmp', file);
    } catch (e) { log('Could not save device stats: ' + e.message); }
  }
  const saver = setInterval(save, SAVE_MS); saver.unref();

  const conns = new Set(); // { conn, role, deviceId, master, check, lastReport, recent }
  let describe = () => null; // (deviceId, { master, viewerDeviceId }) -> the device as the Devices view shows it

  const agentOnline = id => [...conns].some(c => c.role === 'agent' && c.deviceId === id);
  const anyOnline = id => [...conns].some(c => c.deviceId === id);
  const viewers = () => [...conns].filter(c => c.role === 'viewer');

  // Tell viewers a device changed. The master hears every change; others only when it comes or goes.
  function changed(deviceId, presence, except) {
    for (const v of viewers()) {
      if (v === except || (!v.master && !presence)) continue;
      const d = describe(deviceId, { master: v.master, viewerDeviceId: v.deviceId });
      if (d) v.conn.send({ type: 'device', device: d });
    }
  }

  function add(conn, entry) {
    const c = Object.assign({ conn, lastReport: 0, recent: [] }, entry);
    const wasOnline = anyOnline(c.deviceId);
    conns.add(c);
    conn.on('close', () => {
      conns.delete(c);
      if (c.role === 'agent' && latest[c.deviceId]) save();
      if (!anyOnline(c.deviceId) || (c.role === 'agent' && !agentOnline(c.deviceId))) changed(c.deviceId, true);
    });
    conn.on('message', msg => {
      const t = Date.now();
      c.recent = c.recent.filter(x => x > t - FLOOD.ms).concat(t);
      if (c.recent.length > FLOOD.count) return conn.close(1008, 'Too many messages');
      if (c.role === 'agent' && msg.type === 'stats') return report(c, msg, t);
      if (msg.type === 'ping') return conn.send({ type: 'pong' });
      conn.send({ type: 'error', code: 'UNKNOWN', message: 'Unknown message type.' });
    });
    // The new connection itself already has the whole list (a viewer) or needs none (an agent).
    if (!wasOnline || c.role === 'agent') changed(c.deviceId, true, c);
    return c;
  }

  function report(c, msg, t) {
    if (t - c.lastReport < MIN_REPORT_MS) return;
    let r;
    try { r = cleanReport(msg); }
    catch (e) { return c.conn.send({ type: 'error', code: 'INVALID', message: String(e) }); }
    c.lastReport = t;
    latest[c.deviceId] = Object.assign(r, { at: new Date(t).toISOString() });
    dirty = true;
    changed(c.deviceId, false);
  }

  // Heartbeat: drop silent connections, and anything whose sign-in or pairing has ended.
  const beat = setInterval(() => {
    const t = Date.now();
    for (const c of [...conns]) {
      if (t - c.conn.lastPong > DEAD_MS) c.conn.close(1001, 'No answer');
      else if (!c.check()) c.conn.close(4001, 'Signed out or unpaired');
      else c.conn.ping();
    }
  }, PING_MS);
  beat.unref();

  return {
    STATS_INTERVAL_MS,
    setDescriber(fn) { describe = fn; },

    addAgent(conn, deviceId, check) {
      // One agent per device: a new one (the tool restarted) replaces the old.
      for (const c of [...conns]) if (c.role === 'agent' && c.deviceId === deviceId) c.conn.close(4000, 'Replaced by a newer connection');
      add(conn, { role: 'agent', deviceId, master: false, check });
      conn.send({ type: 'hello', role: 'agent', deviceId, interval: STATS_INTERVAL_MS });
    },
    // The list first, so every later message is a change to it.
    addViewer(conn, { deviceId, master, check, devices }) {
      conn.send({ type: 'devices', devices });
      add(conn, { role: 'viewer', deviceId, master, check });
    },

    // The HP's own stats come from the server itself, not from an agent.
    reportSelf(deviceId, r) {
      latest[deviceId] = Object.assign({}, r, { at: new Date().toISOString() });
      dirty = true;
      changed(deviceId, false);
    },
    mastersWatching: () => viewers().some(v => v.master),

    // What the hub adds to a device: is it online, and its latest stats.
    live(deviceId) {
      const l = latest[deviceId] || null;
      return { hasAgent: !!l, agentOnline: agentOnline(deviceId), connected: anyOnline(deviceId), latest: l };
    },

    // A device was paired, renamed or unpaired: viewers hear about it, and an unpaired one is cut off.
    deviceAdded(deviceId) { changed(deviceId, true); },
    deviceRemoved(deviceId) {
      for (const c of [...conns]) if (c.deviceId === deviceId) c.conn.close(4001, 'Unpaired');
      if (latest[deviceId]) { delete latest[deviceId]; dirty = true; save(); }
      for (const v of viewers()) v.conn.send({ type: 'removed', id: deviceId });
    },
    // Closes viewers whose check now fails (a sign-out or a revoke), without waiting for the heartbeat.
    recheck() { for (const c of [...conns]) if (!c.check()) c.conn.close(4001, 'Signed out or unpaired'); },

    count: () => ({ agents: [...conns].filter(c => c.role === 'agent').length, viewers: viewers().length }),
    close() { clearInterval(beat); clearInterval(saver); save(); for (const c of [...conns]) c.conn.close(1001, 'Server stopping'); }
  };
}

module.exports = { createHub, cleanReport };
