// discovery.js — Phase 2, milestone 2-1 (D-01): clients find the HP without anyone typing an address.
//
// The HP listens on a UDP port. A client broadcasts one small JSON packet; the HP answers that client
// alone with where to reach it. Core Node only (dgram).
//
//   request  {"attic":"discover","v":1,"nonce":"<8–64 of A-Z a-z 0-9 _ ->"}             ≤ 512 bytes
//   reply    {"attic":"here","v":1,"nonce":<same>,"serverId","name","address","port"}  to the sender only
//
// Home network only, as the requirements say: a packet is answered only when its sender is on the same
// subnet as one of the HP's own network interfaces (or is this PC). Anything else — malformed, oversized,
// the wrong version, a sender asking too often — gets silence, never an error, so the port tells a
// stranger nothing. The reply names the server and where to find it; nothing about files or accounts.
'use strict';
const dgram = require('dgram'), os = require('os'), crypto = require('crypto'), fs = require('fs'), path = require('path');

const DEFAULT_PORT = 41980;
const MAX_PACKET = 512;
const NONCE = /^[A-Za-z0-9_-]{8,64}$/;
const RATE = { replies: 20, windowMs: 10e3 }; // per sender address

// ---------- the home-network check ----------
const toInt = ip => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const isIPv4 = ip => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip.split('.').every(o => Number(o) <= 255);

// The HP's own IPv4 address on the sender's subnet, or null if the sender isn't on any of them.
// Loopback (this PC asking itself) is answered with 127.0.0.1. `interfaces` is os.networkInterfaces().
function localAddressFor(sender, interfaces) {
  if (!isIPv4(sender)) return null;
  if (sender.startsWith('127.')) return '127.0.0.1';
  const s = toInt(sender);
  for (const list of Object.values(interfaces || {})) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || !isIPv4(a.address) || !isIPv4(a.netmask)) continue;
      const ip = toInt(a.address), mask = toInt(a.netmask);
      if (mask === 0) continue; // a /0 "subnet" would be the whole internet
      const net = ip & mask, bcast = (net | ~mask) >>> 0;
      if (((s & mask) >>> 0) === (net >>> 0) && s !== bcast && s !== (net >>> 0)) return a.address;
    }
  }
  return null;
}

// Every directed-broadcast address for this PC's networks, plus the limited broadcast. Windows sends
// 255.255.255.255 out of one interface only, so a client sends to each subnet's own broadcast too.
function broadcastTargets(interfaces) {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(interfaces || {})) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || !isIPv4(a.address) || !isIPv4(a.netmask)) continue;
      const ip = toInt(a.address), mask = toInt(a.netmask);
      if (mask === 0) continue;
      const b = (ip & mask | ~mask) >>> 0;
      out.add([b >>> 24, b >>> 16 & 255, b >>> 8 & 255, b & 255].join('.'));
    }
  }
  return [...out];
}

function parseRequest(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0 || buf.length > MAX_PACKET) return null;
  let m;
  try { m = JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
  if (!m || typeof m !== 'object' || m.attic !== 'discover' || m.v !== 1 || typeof m.nonce !== 'string' || !NONCE.test(m.nonce)) return null;
  return { nonce: m.nonce };
}

// A random id for this server, kept in data/ so it survives restarts and IP changes. Clients use it to
// recognise "the same HP" and, from 2-2 on, the one they paired with.
function loadServerId(dataDir) {
  const file = path.join(dataDir, 'server-id.json');
  try {
    const id = JSON.parse(fs.readFileSync(file, 'utf8')).serverId;
    if (/^[0-9a-f]{32}$/.test(id)) return id;
  } catch (e) { /* first run */ }
  const id = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ serverId: id }, null, 2));
  return id;
}

// ---------- the responder (on the HP) ----------
// Resolves once listening; never rejects. If the port can't be opened the server carries on without
// discovery (clients can still type the address) and `error` says why.
function startResponder({ port = DEFAULT_PORT, httpPort, name = os.hostname(), serverId, interfaces = () => os.networkInterfaces(), log = () => {} }) {
  // No reuseAddr: on Windows it would let another program bind the same port and take these packets.
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  const recent = new Map(); // sender address -> [reply timestamps]
  const status = { listening: false, port, error: null, answered: 0, ignored: 0 };

  function allowed(addr) {
    const now = Date.now(), cutoff = now - RATE.windowMs;
    const list = (recent.get(addr) || []).filter(t => t > cutoff);
    if (list.length >= RATE.replies) { recent.set(addr, list); return false; }
    list.push(now);
    recent.set(addr, list);
    if (recent.size > 1024) for (const [k, v] of recent) if (!v.some(t => t > cutoff)) recent.delete(k);
    return true;
  }

  sock.on('message', (buf, rinfo) => {
    const req = parseRequest(buf);
    const address = req && rinfo.port > 0 && localAddressFor(rinfo.address, interfaces());
    if (!req || !address || !allowed(rinfo.address)) { status.ignored++; return; }
    const reply = Buffer.from(JSON.stringify({ attic: 'here', v: 1, nonce: req.nonce, serverId, name, address, port: httpPort }));
    sock.send(reply, rinfo.port, rinfo.address, err => { if (!err) status.answered++; });
  });

  return new Promise(resolve => {
    sock.once('error', e => {
      status.error = e.code === 'EADDRINUSE' ? `UDP port ${port} is already in use` : e.message;
      log(`Discovery off: ${status.error}. Clients can still connect by typing the address.`);
      try { sock.close(); } catch (x) { /* already closed */ }
      resolve({ status, close: () => {} });
    });
    sock.bind(port, '0.0.0.0', () => {
      sock.removeAllListeners('error');
      sock.on('error', e => log('Discovery error: ' + e.message));
      status.listening = true;
      status.port = sock.address().port;
      resolve({ status, close: () => new Promise(r => sock.close(r)) });
    });
  });
}

// ---------- finding servers (for clients, and for testing from any PC) ----------
// Broadcasts a request and collects every answer for `timeoutMs`. Answers are checked against the
// nonce, so a stray or replayed packet is ignored. Returns [{ serverId, name, address, port, from }].
function findServers({ port = DEFAULT_PORT, timeoutMs = 1500, targets } = {}) {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomBytes(12).toString('base64url');
    const found = new Map();
    const sock = dgram.createSocket('udp4');
    sock.on('error', reject);
    sock.on('message', (buf, rinfo) => {
      let m;
      try { m = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
      if (!m || m.attic !== 'here' || m.v !== 1 || m.nonce !== nonce || !/^[0-9a-f]{32}$/.test(m.serverId)) return;
      if (!isIPv4(m.address) || !Number.isInteger(m.port) || m.port < 1 || m.port > 65535) return;
      if (!found.has(m.serverId)) found.set(m.serverId, { serverId: m.serverId, name: String(m.name || '').slice(0, 64), address: m.address, port: m.port, from: rinfo.address });
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const msg = Buffer.from(JSON.stringify({ attic: 'discover', v: 1, nonce }));
      for (const t of targets || broadcastTargets(os.networkInterfaces())) sock.send(msg, port, t, () => {});
      setTimeout(() => { sock.close(); resolve([...found.values()]); }, timeoutMs);
    });
  });
}

module.exports = { DEFAULT_PORT, startResponder, findServers, localAddressFor, broadcastTargets, parseRequest, loadServerId };
