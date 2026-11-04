// mode.js — Phase 3, milestone 3-1 (T-02): is this PC the Attic server, or a client?
//
// One installer serves every PC; the first launch asks which it is, and the answer is kept in the tool's
// user-data folder (mode.json). In Server mode it also records where the server's settings and data live:
//   - a new server: config.json and data/ in the tool's own folder (<user data>\server), with the
//     storage folders chosen at setup;
//   - an existing server folder, such as the HP's checkout of the repository (server\config.json and
//     server\data), so its accounts, devices and history carry over.
// The server code itself is the copy bundled with the tool. Core Node only.
'use strict';
const fs = require('fs');
const path = require('path');

const MODES = ['client', 'server'];
const DEVICE_TYPES = ['ssd', 'hdd', 'external', 'usb', 'network'];

function store(file) {
  return {
    load() {
      try {
        const m = JSON.parse(fs.readFileSync(file, 'utf8'));
        return m && MODES.includes(m.mode) ? m : null;
      } catch (e) { return null; }
    },
    save(m) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const rec = Object.assign({}, m, { savedAt: new Date().toISOString() });
      fs.writeFileSync(file + '.tmp', JSON.stringify(rec, null, 2));
      fs.renameSync(file + '.tmp', file);
      return rec;
    },
    forget() { try { fs.unlinkSync(file); } catch (e) { /* nothing saved */ } }
  };
}

// Where a server's files are: { config, data } for its folder (new, or one chosen at setup).
const serverPaths = dir => ({ dir, config: path.join(dir, 'config.json'), data: path.join(dir, 'data') });

// Checks a folder holds a usable Attic server (config.json with shares). Throws a readable Error.
// Accepts the repository's root as well as its server\ folder.
function checkExisting(folder) {
  let dir = String(folder || '').trim();
  if (!dir) throw new Error('Choose the folder that holds the server’s config.json.');
  if (!fs.existsSync(path.join(dir, 'config.json')) && fs.existsSync(path.join(dir, 'server', 'config.json'))) dir = path.join(dir, 'server');
  const p = serverPaths(dir);
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(p.config, 'utf8')); }
  catch (e) { throw new Error(fs.existsSync(p.config) ? `${p.config} isn’t valid JSON.` : `There’s no config.json in ${dir}. Choose the server folder, like ...\\attic\\server.`); }
  if (!cfg || !Array.isArray(cfg.shares) || !cfg.shares.length) throw new Error(`${p.config} has no shares.`);
  const hasData = fs.existsSync(path.join(p.data, 'accounts.json')) || fs.existsSync(path.join(p.data, 'attic.db'));
  return Object.assign(p, { port: cfg.port || 8080, shares: cfg.shares.length, hasData });
}

// A new server's config.json: one share per chosen folder, the rest as config.example.json has it.
function newConfig({ shares, port = 8080, serverKind = 'laptop' }) {
  if (!Array.isArray(shares) || !shares.length) throw new Error('Choose at least one folder for Attic to store files in.');
  const ids = new Set();
  const out = shares.map((s, i) => {
    const rootPath = String(s.rootPath || '').trim();
    if (!/^[A-Za-z]:\\/.test(rootPath) && !rootPath.startsWith('/')) throw new Error(`“${rootPath || 'Folder ' + (i + 1)}” isn’t a full folder path, like D:\\Shared.`);
    const name = String(s.name || '').trim().slice(0, 40) || path.basename(rootPath) || 'Storage';
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'share';
    for (let n = 2; ids.has(id); n++) id = id.replace(/-\d+$/, '') + '-' + n;
    ids.add(id);
    return { id, name, rootPath, deviceType: DEVICE_TYPES.includes(s.deviceType) ? s.deviceType : 'hdd' };
  });
  port = Number(port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('The port must be a number from 1024 to 65535.');
  return { port, host: '0.0.0.0', discovery: { enabled: true, port: 41980 }, pairing: { required: true, trustThisPC: true },
    serverKind, shares: out };
}

// Writes a new server's folder: config.json (never over an existing one) and the storage folders.
function createServer(dir, opts) {
  const cfg = newConfig(opts);
  const p = serverPaths(dir);
  if (fs.existsSync(p.config)) throw new Error(`${p.config} already exists. Use it as an existing server instead.`);
  for (const s of cfg.shares) fs.mkdirSync(s.rootPath, { recursive: true });
  fs.mkdirSync(p.data, { recursive: true });
  fs.writeFileSync(p.config, JSON.stringify(cfg, null, 2));
  return Object.assign(p, { port: cfg.port, shares: cfg.shares.length, hasData: false });
}

module.exports = { store, serverPaths, checkExisting, newConfig, createServer, MODES };
