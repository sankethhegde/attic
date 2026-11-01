// connect.js — Phase 2, milestone 2-1 (D-01), the client's half: find the HP without typing an address.
//
// Runs in the desktop tool's main process. Order of attempts:
//   1. The server used last time, at its last address (fast path; confirmed by serverId).
//   2. A discovery broadcast (findServers() from server/discovery.js), retried once.
//      If the remembered server answers from a new address, follow it there.
//   3. Nothing found, or several servers: the screen asks, and a typed address is always accepted.
// Every candidate is confirmed with GET /api/hello before it's used: right app, and the serverId the
// broadcast reply claimed. Core Node only.
'use strict';
const fs = require('fs');
const path = require('path');
const { findServers, DEFAULT_PORT } = require('../server/discovery.js');

const DEFAULT_HTTP_PORT = 8080;
const SERVER_ID = /^[0-9a-f]{32}$/;

// "192.168.1.10", "192.168.1.10:8080", "http://hp-laptop:8080/", "hp-laptop.local" → { address, port }.
// Throws an Error whose message can be shown as it is.
function normalizeAddress(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Type the server’s address, like 192.168.1.10.');
  if (/^https:\/\//i.test(s)) throw new Error('Attic serves plain http on the home network for now. Leave out “https://”.');
  s = s.replace(/^http:\/\//i, '');
  const m = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/.exec(s);
  if (!m) throw new Error('That isn’t an address. Use something like 192.168.1.10 or 192.168.1.10:8080.');
  const host = m[1], port = m[2] ? Number(m[2]) : DEFAULT_HTTP_PORT;
  if (/^\d+(\.\d+)*$/.test(host) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) throw new Error('An IP address has four numbers, like 192.168.1.10.');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split('.').some(o => Number(o) > 255)) throw new Error('Each part of an IP address is 0–255.');
  if (port < 1 || port > 65535) throw new Error('The port must be between 1 and 65535.');
  return { address: host, port };
}

const urlFor = s => `http://${s.address}:${s.port}/`;

// Ask a candidate who it is. Resolves to the confirmed server, or rejects with a readable reason.
async function hello({ address, port }, { timeoutMs = 2500, fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try { res = await fetchImpl(`http://${address}:${port}/api/hello`, { signal: ctl.signal, cache: 'no-store' }); }
  catch (e) { throw new Error(`Nothing answered at ${address}:${port}.`); }
  finally { clearTimeout(timer); }
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || !body || body.app !== 'Attic' || !SERVER_ID.test(body.serverId || '')) {
    throw new Error(`${address}:${port} answered, but it isn’t an Attic server.`);
  }
  return { serverId: body.serverId, name: String(body.name || 'Attic server').slice(0, 64), address, port };
}

// The search itself. `deps` lets tests replace the network: { find, hello }.
async function search({ remembered, discoveryPort = DEFAULT_PORT, timeoutMs = 1500, rounds = 2, onProgress = () => {} } = {}, deps = {}) {
  const find = deps.find || (opts => findServers(opts));
  const ask = deps.hello || (s => hello(s));

  if (remembered && remembered.address) {
    onProgress({ step: 'remembered', server: remembered });
    try {
      const s = await ask(remembered);
      if (!remembered.serverId || s.serverId === remembered.serverId) return { state: 'connected', server: s, via: 'remembered' };
    } catch (e) { /* moved or off — fall through to discovery */ }
  }

  let answers = [], error = null;
  for (let i = 0; i < rounds && !answers.length; i++) {
    onProgress({ step: 'broadcast', round: i + 1 });
    try { answers = await find({ port: discoveryPort, timeoutMs }); }
    catch (e) { error = e.message; }
  }

  // Confirm each answer over HTTP; drop anything that doesn't match what it claimed.
  const confirmed = [];
  for (const a of answers) {
    try {
      const s = await ask({ address: a.address, port: a.port });
      if (s.serverId === a.serverId) confirmed.push(s);
    } catch (e) { /* answered UDP but not HTTP: firewall on TCP, or not Attic */ }
  }

  if (remembered && remembered.serverId) {
    const same = confirmed.find(s => s.serverId === remembered.serverId);
    if (same) return { state: 'connected', server: same, via: 'moved' };
  }
  if (confirmed.length === 1) return { state: 'connected', server: confirmed[0], via: 'discovery' };
  if (confirmed.length > 1) return { state: 'choose', servers: confirmed };
  return { state: 'not-found', heard: answers.length, error };
}

// Remembered server, kept in the desktop tool's user-data folder (never in the repository).
function store(file) {
  return {
    load() {
      try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'));
        return s && s.address && s.port ? s : null;
      } catch (e) { return null; }
    },
    save(server) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const rec = { serverId: server.serverId, name: server.name, address: server.address, port: server.port, lastConnectedAt: new Date().toISOString() };
      fs.writeFileSync(file, JSON.stringify(rec, null, 2));
      return rec;
    },
    forget() { try { fs.unlinkSync(file); } catch (e) { /* nothing to forget */ } }
  };
}

module.exports = { normalizeAddress, hello, search, store, urlFor, DEFAULT_HTTP_PORT };
