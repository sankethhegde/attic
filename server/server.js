// Attic server — Phase 1C. Milestone 1: serves ui/ and answers GET /api/shares with real drive figures.
// Milestone 3: accounts, passwords and sessions live here; every /api/ call except setup and sign-in
// needs a session. Still no folder listing and no paths from the client. Core Node only.
// Usage: node server/server.js
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { createAuth, AuthError } = require('./auth');
const { createSafePath } = require('./safe-path');
const { createFiles, parseRange, FileError, INLINE } = require('./files');
const { createOwnership } = require('./ownership');
const { startResponder, loadServerId, DEFAULT_PORT: DEFAULT_DISCOVERY_PORT } = require('./discovery');
const { createPairing, KINDS: DEVICE_KINDS } = require('./pairing');

const UI_ROOT = path.resolve(__dirname, '..', 'ui');
// Overridable so the tests can run a server on a throwaway config and data folder.
const CONFIG_PATH = process.env.ATTIC_CONFIG || path.join(__dirname, 'config.json');
const DATA_DIR = process.env.ATTIC_DATA || path.join(__dirname, 'data');
const LAST_SEEN_PATH = path.join(DATA_DIR, 'last-seen.json');
const COOKIE = 'attic_session';
const DEVICE_COOKIE = 'attic_device';
const DEVICE_COOKIE_AGE = 400 * 86400; // the longest a browser keeps a cookie; renewed at every sign-in
const MAX_BODY = 16 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

function loadConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) {
    console.error(`Could not read ${CONFIG_PATH}: ${e.message}\nCopy server/config.example.json to server/config.json and edit the paths.`);
    process.exit(1);
  }
  if (!Array.isArray(cfg.shares)) { console.error('config.json needs a "shares" array.'); process.exit(1); }
  // Discovery (Phase 2, 2-1) is on unless config says "discovery": { "enabled": false }; port 0 also turns it off.
  const d = cfg.discovery || {};
  const envPort = process.env.ATTIC_DISCOVERY_PORT;
  const discoveryPort = envPort !== undefined ? +envPort : d.port !== undefined ? +d.port : DEFAULT_DISCOVERY_PORT;
  // Pairing (Phase 2, 2-2) is required unless config says "pairing": { "required": false }. The HP itself
  // (a browser on this PC, at localhost) counts as paired unless "trustThisPC" is false.
  const p = cfg.pairing || {};
  return { raw: cfg, port: +process.env.ATTIC_PORT || cfg.port || 8080, host: cfg.host || '0.0.0.0', shares: cfg.shares,
    discovery: { enabled: d.enabled !== false && discoveryPort > 0, port: discoveryPort },
    pairing: { required: p.required !== false, trustThisPC: p.trustThisPC !== false } };
}
const CONFIG = loadConfig();
const auth = createAuth(DATA_DIR);
// Shares can be edited from Settings (milestone 6), so the file layer is rebuilt whenever they change.
let files;
function useShares(list) { CONFIG.shares = list; files = createFiles(list, createSafePath(list)); }
useShares(CONFIG.shares);
const own = createOwnership(DATA_DIR);
const MAX_UPLOAD = 20e9;
// Who this server is: a stable id (kept in data/) and the PC's name. Discovery answers with them, and
// /api/hello repeats them so a client that found an address can check it reached the HP it meant.
const SERVER_ID = loadServerId(DATA_DIR);
const SERVER_NAME = os.hostname();
const pairing = createPairing(DATA_DIR);
// The HP in the device list. It never pairs: requests from this PC itself are the HP.
const SERVER_DEVICE = { id: 'server', name: SERVER_NAME, kind: DEVICE_KINDS.includes(CONFIG.raw.serverKind) ? CONFIG.raw.serverKind : 'desktop',
  os: os.version(), role: 'server' };

// ---------- last seen ----------
// An unplugged drive reports when it was last connected, so that has to survive a restart.
let lastSeen = {};
try { lastSeen = JSON.parse(fs.readFileSync(LAST_SEEN_PATH, 'utf8')); } catch (e) { /* first run */ }
function saveLastSeen() {
  try { fs.mkdirSync(path.dirname(LAST_SEEN_PATH), { recursive: true }); fs.writeFileSync(LAST_SEEN_PATH, JSON.stringify(lastSeen, null, 2)); }
  catch (e) { console.warn('Could not save last-seen times:', e.message); }
}

// ---------- shares ----------
// Same shape as aggregate() in ui/js/api.js, so the UI swap is one function. used/total/free are the
// drive's real figures in bytes. count and byCategory stay empty until the file index exists (milestone 4+).
async function readShare(s) {
  // drive: which disk the share is on, so two shares on one drive aren't counted twice in totals.
  const out = { id: s.id, name: s.name, deviceType: s.deviceType || 'hdd', rootPath: s.rootPath, drive: path.parse(path.resolve(s.rootPath)).root.toUpperCase(), available: false,
    lastSeenAt: lastSeen[s.id] || null, used: 0, total: 0, free: 0, count: 0, byCategory: {} };
  try {
    if (!(await fs.promises.stat(s.rootPath)).isDirectory()) return out;
    const st = await fs.promises.statfs(s.rootPath);
    out.total = st.blocks * st.bsize;
    out.free = st.bavail * st.bsize;
    out.used = out.total - st.bfree * st.bsize;
    out.available = true;
    out.lastSeenAt = lastSeen[s.id] = new Date().toISOString();
  } catch (e) { /* missing path or unplugged drive: reported as unavailable */ }
  return out;
}

async function listShares() {
  const list = await Promise.all(CONFIG.shares.map(readShare));
  saveLastSeen();
  return list;
}

// ---------- editing shares (Settings, master only) ----------
// The change is written to config.json (whole file, renamed into place) before it takes effect, so a
// restart comes back with exactly what Settings shows. Port and host are left as they were.
const SHARE_TYPES = ['ssd', 'hdd', 'external'];
function checkShare(body, id) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 64) throw new AuthError(400, 'INVALID', 'Enter a share name of up to 64 characters.');
  const raw = typeof body.rootPath === 'string' ? body.rootPath.trim() : '';
  if (!/^[a-zA-Z]:[\\/]/.test(raw)) throw new AuthError(400, 'INVALID', 'Give a full folder path on the server, such as D:\\Shared.');
  const rootPath = path.resolve(raw);
  // The brief's rule: a folder, never a drive root, so a path-checking bug can only expose that folder.
  if (path.dirname(rootPath) === rootPath) {
    throw new AuthError(400, 'INVALID', 'Choose a folder, not a whole drive. For example D:\\Shared rather than D:\\.');
  }
  const lower = rootPath.toLowerCase();
  for (const s of CONFIG.shares) {
    if (s.id === id) continue;
    const other = path.resolve(s.rootPath).toLowerCase();
    if (lower === other || lower.startsWith(other + path.sep) || other.startsWith(lower + path.sep)) {
      throw new AuthError(409, 'OVERLAP', `That folder overlaps ${s.name} (${s.rootPath}). Shares can't contain each other.`);
    }
  }
  return { name, rootPath, deviceType: SHARE_TYPES.includes(body.deviceType) ? body.deviceType : 'hdd' };
}
function saveShares(list) {
  const next = Object.assign({}, CONFIG.raw, { shares: list });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  CONFIG.raw = next;
  useShares(list);
}
function newShareId(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'share';
  let id = base;
  for (let n = 2; CONFIG.shares.some(s => s.id === id); n++) id = `${base}-${n}`;
  return id;
}

// ---------- http ----------
function sendJSON(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(JSON.stringify(body));
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
// HttpOnly: page scripts can't read it. SameSite=Strict: other sites can't send it. No Secure flag until
// HTTPS arrives; until then the cookie crosses the home network in the clear, like everything else.
function sessionCookie(token, maxAge) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict` + (maxAge ? `; Max-Age=${Math.floor(maxAge)}` : '');
}
const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
const deviceCookie = token => `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DEVICE_COOKIE_AGE}`;
const clearDeviceCookie = `${DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new AuthError(413, 'TOO_LARGE', 'Request too large.')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new AuthError(400, 'INVALID', 'Request body isn’t valid JSON.')); }
    });
    req.on('error', reject);
  });
}

// Requests that change something must be same-origin JSON. A form on another site can't send
// application/json without a CORS preflight, which this server never answers. An upload's body is the
// file itself, so it carries a custom header instead, which forces the same preflight.
function checkWrite(req, upload) {
  if (upload ? req.headers['x-attic-upload'] !== '1' : !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    throw new AuthError(415, 'INVALID', upload ? 'Upload refused.' : 'Send JSON.');
  }
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) throw new AuthError(403, 'FORBIDDEN', 'Cross-site request refused.');
}

const clientAddr = req => req.socket.remoteAddress || 'unknown';

// ---------- devices (Phase 2, 2-2) ----------
// Which machine a request comes from: the HP itself (a connection from this PC), a paired device (its
// token in the attic_device cookie, or the X-Attic-Device header for the desktop tool's background
// part), or nobody. Sets req.device and req.deviceToken; a paired device's last-seen time is recorded.
const THIS_PC = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function identifyDevice(req) {
  if (CONFIG.pairing.trustThisPC && THIS_PC.has(req.socket.remoteAddress)) return (req.device = SERVER_DEVICE);
  const token = readCookie(req, DEVICE_COOKIE) || req.headers['x-attic-device'] || null;
  req.deviceToken = token;
  req.device = pairing.resolve(token);
  if (req.device) pairing.touch(req.device.id, clientAddr(req));
  return req.device;
}
const NOT_PAIRED = () => new AuthError(403, 'NOT_PAIRED', 'This device isn’t paired with the HP yet. Ask for a pairing code on the HP.');
const deviceIdOf = req => req.device ? req.device.id : null;

// The device list. Everyone signed in sees which devices exist and whether they're online; only the
// master sees when and by whom each was paired, and its last address.
function listDevices(req, master) {
  const all = [Object.assign({}, SERVER_DEVICE, { online: true, lastSeenAt: new Date().toISOString() })]
    .concat(pairing.list().map(d => Object.assign({ role: 'client' }, d)));
  return all.map(d => {
    const out = { id: d.id, name: d.name, kind: d.kind, os: d.os, role: d.role, online: d.online, lastSeenAt: d.lastSeenAt, thisPC: d.id === deviceIdOf(req) };
    if (master && d.role === 'client') Object.assign(out, { pairedAt: d.pairedAt, pairedBy: d.pairedBy, lastAddress: d.lastAddress });
    return out;
  });
}

// ---------- api ----------
// Every route but setup and sign-in needs a session; the handler gets { session, account, token }.
const SIGNED_OUT = () => new AuthError(401, 'SIGNED_OUT', 'Your session has ended. Sign in again.');
const FORBIDDEN = () => new AuthError(403, 'FORBIDDEN', 'Only the master account can do that.');

function requireSession(req) {
  const token = readCookie(req, COOKIE);
  const who = auth.resolve(token, deviceIdOf(req));
  if (!who) throw SIGNED_OUT();
  return Object.assign(who, { token });
}
function requireMaster(req) {
  const who = requireSession(req);
  if (who.session.type !== 'master') throw FORBIDDEN();
  return who;
}

// Streams an open file, whole or one byte range, with backpressure: memory stays flat for any size.
// The handle closes when the stream ends, fails, or the client goes away. With inline, a photo, video
// or audio file is served as its own type for previews and playback; anything else still downloads.
function sendFile(req, res, f, inline) {
  let range;
  try { range = parseRange(req.headers.range, f.size); }
  catch (e) {
    f.handle.close();
    res.writeHead(416, { 'Content-Range': `bytes */${f.size}` });
    return res.end();
  }
  const start = range ? range.start : 0, end = range ? range.end : f.size - 1;
  const ascii = f.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const media = inline && INLINE[path.extname(f.name).toLowerCase()];
  const headers = {
    'Content-Type': media || 'application/octet-stream',
    'Content-Length': f.size === 0 ? 0 : end - start + 1,
    'Content-Disposition': `${media ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'Accept-Ranges': 'bytes',
    'Last-Modified': f.mtime.toUTCString(),
    // Previews may be cached by this browser for a while; plain downloads are never kept.
    'Cache-Control': media ? 'private, max-age=300' : 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    // Even opened on its own, a served file can't run anything.
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox"
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${f.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD' || f.size === 0) { f.handle.close(); return res.end(); }
  const stream = f.handle.createReadStream({ start, end, autoClose: true });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// ---------- ownership changes ----------
// Accounts (auth) and ownership (own) are two files. Ownership is written first and rolled back if the
// account change is refused, so a revoke, restore or remove is all of it or none of it.
function custodianFor(custodianId, leavingId) {
  const list = auth.listAccounts();
  const c = list.find(a => a.id === custodianId) || list.find(a => a.type === 'master');
  if (!c || c.id === leavingId || c.status !== 'active') throw new AuthError(400, 'INVALID', 'Choose the master or another active account to hold these files.');
  return c;
}
function deviceOrThrow(id) {
  const a = auth.listAccounts().find(x => x.id === id && x.type === 'device');
  if (!a) throw new AuthError(404, 'NOT_FOUND', 'That device no longer exists.');
  return a;
}
async function inOneStep(changeOwnership, changeAccount) {
  const before = own.snapshot();
  const moved = changeOwnership();
  try { return { moved, account: changeAccount() }; }
  catch (e) { own.rollback(before); throw e; }
}

async function handleApi(req, res, url, query) {
  const m = req.method;
  const upload = /^\/api\/shares\/[A-Za-z0-9_-]{1,64}\/file$/.test(url) && m === 'PUT';
  if (m !== 'GET' && m !== 'HEAD') checkWrite(req, upload);
  const body = !upload && (m === 'POST' || m === 'PATCH' || m === 'PUT') ? await readBody(req) : {};

  // Public: which Attic server this is. Nothing about accounts, shares or files.
  if (url === '/api/hello' && m === 'GET') return sendJSON(res, 200, { app: 'Attic', api: 1, serverId: SERVER_ID, name: SERVER_NAME });

  // ---------- pairing (Phase 2, 2-2) ----------
  // Public: is this device paired? A token the HP no longer knows (the device was unpaired) is cleared.
  const device = identifyDevice(req);
  if (url === '/api/pairing' && m === 'GET') {
    const out = { required: CONFIG.pairing.required, paired: !!device, thisPC: device === SERVER_DEVICE,
      device: device ? { id: device.id, name: device.name, kind: device.kind } : null };
    return sendJSON(res, 200, out, !device && req.deviceToken ? { 'Set-Cookie': clearDeviceCookie } : undefined);
  }
  // Public: a new device trades a one-time code for its identity. The token goes only into the cookie.
  if (url === '/api/pairing/claim' && m === 'POST') {
    if (device) throw new AuthError(409, 'ALREADY_PAIRED', device === SERVER_DEVICE ? 'This is the HP itself; it doesn’t need pairing.' : 'This device is already paired.');
    const r = pairing.claim(body, clientAddr(req));
    console.log(`  Paired: ${r.device.name} (${r.device.id}) from ${r.device.lastAddress}`);
    return sendJSON(res, 201, { device: { id: r.device.id, name: r.device.name, kind: r.device.kind } }, { 'Set-Cookie': deviceCookie(r.token) });
  }
  // Everything else needs a paired device first, setup and sign-in included.
  if (CONFIG.pairing.required && !device) throw NOT_PAIRED();

  if (url === '/api/setup') {
    if (m === 'GET') return sendJSON(res, 200, { needsSetup: auth.needsSetup() });
    if (m === 'POST') return sendJSON(res, 201, await auth.createMaster(body));
  }

  if (url === '/api/session') {
    if (m === 'GET') {
      const who = auth.resolve(readCookie(req, COOKIE), deviceIdOf(req));
      return sendJSON(res, 200, who, who ? undefined : { 'Set-Cookie': clearCookie });
    }
    if (m === 'POST') {
      const r = await auth.signIn(body, clientAddr(req), deviceIdOf(req));
      // Signing in also renews the device cookie, so a device in regular use never loses its pairing.
      const cookies = [sessionCookie(r.token, r.maxAge)];
      if (device && device !== SERVER_DEVICE && readCookie(req, DEVICE_COOKIE)) cookies.push(deviceCookie(readCookie(req, DEVICE_COOKIE)));
      return sendJSON(res, 200, { session: r.session, account: r.account }, { 'Set-Cookie': cookies });
    }
    if (m === 'DELETE') {
      auth.signOut(readCookie(req, COOKIE));
      return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
    }
  }

  // A device sees its share list without drive capacity or free space: those would reveal how much
  // other accounts store. Same rule as the mock.
  if (url === '/api/shares' && m === 'GET') {
    const who = requireSession(req);
    const list = await listShares();
    if (who.session.type === 'master') return sendJSON(res, 200, list);
    return sendJSON(res, 200, list.map(s => Object.assign({}, s, { used: 0, total: null, free: null, scope: 'visible' })));
  }

  // ---------- files (milestones 4 and 5) ----------
  // Every read and write is scoped by own.view(session): a device sees its own files and the common
  // space, the master sees everything. Another account's file is "not found", never "forbidden".
  const sh = /^\/api\/shares\/([A-Za-z0-9_-]{1,64})\/(folder|file)$/.exec(url);
  if (sh) {
    const [, shareId, what] = sh;
    const rel = query.get('path') || '';
    const who = requireSession(req);
    const view = own.view(who.session);
    if (what === 'folder' && m === 'GET') return sendJSON(res, 200, await files.listFolder(shareId, rel, view));
    if (what === 'file' && (m === 'GET' || m === 'HEAD')) return sendFile(req, res, await files.openFile(shareId, rel, view), query.get('inline') === '1');
    // Upload: ?path= is the destination folder plus the file's name. The uploader owns what it uploads.
    if (what === 'file' && m === 'PUT') {
      const declared = Number(req.headers['content-length']);
      if (declared > MAX_UPLOAD) throw new FileError(413, 'TOO_LARGE', 'Too large. The limit is 20 GB per file.');
      const i = rel.lastIndexOf('/');
      const saved = await files.saveUpload(shareId, i < 0 ? '' : rel.slice(0, i), rel.slice(i + 1), req, view, MAX_UPLOAD);
      own.setRecord(shareId, saved.rel, { ownerId: who.session.accountId, uploadedBy: who.session.accountId });
      files.forget(shareId);
      const folder = saved.rel.includes('/') ? saved.rel.slice(0, saved.rel.lastIndexOf('/')) : '';
      const entry = (await files.listFolder(shareId, folder, own.view(who.session))).items.find(e => e.name === saved.name);
      return sendJSON(res, 201, entry);
    }
  }

  // Every file the caller may see, across all shares: Photos, Videos, Other, the Dashboard and search.
  if (url === '/api/files' && m === 'GET') {
    const who = requireSession(req);
    if (query.get('fresh') === '1') files.forget();
    return sendJSON(res, 200, await files.index(own.view(who.session)));
  }

  // Shares: add, edit and remove (master). Ownership is keyed by share id, and editing keeps the id, so
  // pointing a share at a moved folder keeps who owns what. A removed share's records stay on disk unused.
  if (url === '/api/shares' && m === 'POST') {
    requireMaster(req);
    const s = checkShare(body);
    saveShares(CONFIG.shares.concat(Object.assign({ id: newShareId(s.name) }, s)));
    return sendJSON(res, 201, (await listShares()).find(x => x.rootPath === s.rootPath));
  }
  const shareEdit = /^\/api\/shares\/([A-Za-z0-9_-]{1,64})$/.exec(url);
  if (shareEdit && (m === 'PUT' || m === 'DELETE')) {
    requireMaster(req);
    const id = shareEdit[1];
    if (!CONFIG.shares.some(s => s.id === id)) throw new AuthError(404, 'NOT_FOUND', 'That share no longer exists.');
    if (m === 'DELETE') { saveShares(CONFIG.shares.filter(s => s.id !== id)); return sendJSON(res, 200, { ok: true }); }
    const s = checkShare(body, id);
    saveShares(CONFIG.shares.map(x => x.id === id ? Object.assign({}, x, s) : x));
    return sendJSON(res, 200, (await listShares()).find(x => x.id === id));
  }

  // Keep permanently: the holder keeps these files; the uploader's claim ends.
  if (url === '/api/files/keep' && m === 'POST') {
    requireMaster(req);
    const keys = (Array.isArray(body.ids) ? body.ids : []).map(files.parseId).filter(Boolean).map(k => ({ share: k.shareId, rel: k.rel }));
    return sendJSON(res, 200, { cleared: own.keep(keys).length });
  }

  // ---------- devices and pairing codes (Phase 2, 2-2) ----------
  if (url === '/api/devices' && m === 'GET') {
    const who = requireSession(req);
    return sendJSON(res, 200, listDevices(req, who.session.type === 'master'));
  }
  // Unpair (master): the device's token stops working at once, and everyone signed in on it is signed out.
  const devEdit = /^\/api\/devices\/([A-Za-z0-9_-]{1,64})$/.exec(url);
  if (devEdit && m === 'DELETE') {
    requireMaster(req);
    if (devEdit[1] === SERVER_DEVICE.id) throw new AuthError(400, 'INVALID', 'The HP is the server; it can’t be unpaired.');
    const d = pairing.unpair(devEdit[1]);
    auth.dropDeviceSessions(d.id);
    console.log(`  Unpaired: ${d.name} (${d.id})`);
    return sendJSON(res, 200, { ok: true, device: { id: d.id, name: d.name } });
  }
  // One-time codes (master). Issuing one is the master's approval for one new device.
  if (url === '/api/pairing/codes') {
    if (m === 'GET') { requireMaster(req); return sendJSON(res, 200, pairing.listCodes()); }
    if (m === 'POST') { const who = requireMaster(req); return sendJSON(res, 201, pairing.issueCode(who.session.accountId)); }
  }
  const codeEdit = /^\/api\/pairing\/codes\/([A-Za-z0-9_-]{1,64})$/.exec(url);
  if (codeEdit && m === 'DELETE') {
    requireMaster(req);
    if (!pairing.cancelCode(codeEdit[1])) throw new AuthError(404, 'NOT_FOUND', 'That code has already been used or has expired.');
    return sendJSON(res, 200, { ok: true });
  }

  if (url === '/api/accounts') {
    if (m === 'GET') { requireMaster(req); return sendJSON(res, 200, auth.listAccounts()); }
    if (m === 'POST') { requireMaster(req); return sendJSON(res, 201, await auth.createDevice(body)); }
  }

  const acc = /^\/api\/accounts\/([A-Za-z0-9_-]{1,64})(\/password|\/ownership|\/revoke|\/restore|\/remove)?$/.exec(url);
  if (acc) {
    const [, id, sub] = acc;
    if (!sub && m === 'PATCH') {
      const who = requireSession(req);
      if (who.session.accountId !== id && who.session.type !== 'master') throw FORBIDDEN();
      return sendJSON(res, 200, auth.updateDisplayName(id, body.displayName));
    }
    if (sub === '/password' && m === 'POST') {
      const who = requireSession(req);
      if (who.session.accountId !== id) throw new AuthError(403, 'FORBIDDEN', 'You can only change your own password.');
      await auth.changePassword(id, body.current, body.next, who.token);
      return sendJSON(res, 200, { ok: true });
    }
    // Master only from here: what an account owns, and moving it on revoke, restore and remove.
    if (sub === '/ownership' && m === 'GET') {
      requireMaster(req);
      const k = own.summaryKeys(id);
      return sendJSON(res, 200, { accountId: id, owned: await files.sizes(k.owned), inCustody: await files.sizes(k.inCustody) });
    }
    if (sub === '/revoke' && m === 'POST') {
      requireMaster(req);
      deviceOrThrow(id);
      const c = custodianFor(body.custodianId, id);
      const r = await inOneStep(() => own.revoke(id, c.id), () => auth.setDeviceStatus(id, 'revoked'));
      return sendJSON(res, 200, { account: r.account, moved: await files.sizes(r.moved), custodian: c });
    }
    if (sub === '/restore' && m === 'POST') {
      requireMaster(req);
      deviceOrThrow(id);
      const r = await inOneStep(() => own.restore(id), () => auth.setDeviceStatus(id, 'active'));
      return sendJSON(res, 200, { account: r.account, returned: await files.sizes(r.moved) });
    }
    if (sub === '/remove' && m === 'POST') {
      requireMaster(req);
      deviceOrThrow(id);
      const c = custodianFor(body.custodianId, id);
      const r = await inOneStep(() => own.remove(id, c.id), () => auth.removeDevice(id));
      return sendJSON(res, 200, { moved: await files.sizes(r.moved), custodian: c });
    }
  }

  sendJSON(res, 404, { code: 'NOT_FOUND', message: 'No such endpoint.' });
}

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
  let p = path.resolve(UI_ROOT, '.' + rel);
  if (p !== UI_ROOT && !p.startsWith(UI_ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(p, (err, st) => {
    if (!err && st.isDirectory()) p = path.join(p, 'index.html');
    fs.readFile(p, (err2, data) => {
      if (err2) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
}

const server = http.createServer(async (req, res) => {
  let parsed;
  try { parsed = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  const url = parsed.pathname;
  if (url.startsWith('/api/')) {
    try { return await handleApi(req, res, url, parsed.searchParams); }
    catch (e) {
      if (e instanceof AuthError) return sendJSON(res, e.status, { code: e.code, message: e.message }, e.status === 401 ? { 'Set-Cookie': clearCookie } : undefined);
      if (e instanceof FileError) return sendJSON(res, e.status, { code: e.code, message: e.message });
      console.error(e);
      return sendJSON(res, 500, { code: 'SERVER', message: 'Something went wrong on the server.' });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res);
});

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${CONFIG.port} is already in use.` : e.message);
  process.exit(1);
});

server.listen(CONFIG.port, CONFIG.host, async () => {
  console.log(`Attic server listening on ${CONFIG.host}:${CONFIG.port}`);
  console.log(`  This PC:      http://localhost:${CONFIG.port}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`  Home network: http://${a.address}:${CONFIG.port}`);
  }
  if (CONFIG.discovery.enabled) {
    const d = await startResponder({ port: CONFIG.discovery.port, httpPort: CONFIG.port, name: SERVER_NAME, serverId: SERVER_ID, log: m => console.log('  ' + m) });
    if (d.status.listening) console.log(`  Discovery:    answering on UDP ${d.status.port} (home network only)`);
  } else console.log('  Discovery:    off');
  const paired = pairing.list().length;
  console.log(CONFIG.pairing.required ? `  Pairing:      required (${paired} paired device${paired === 1 ? '' : 's'}${CONFIG.pairing.trustThisPC ? '; this PC is trusted' : ''})`
    : '  Pairing:      OFF — any device on the network can sign in');
  console.log('Shares:');
  for (const s of await listShares()) {
    console.log(`  ${s.id.padEnd(8)} ${s.rootPath.padEnd(22)} ${s.available ? `${(s.free / 1e9).toFixed(1)} GB free of ${(s.total / 1e9).toFixed(1)} GB` : 'UNAVAILABLE'}`);
  }
});
