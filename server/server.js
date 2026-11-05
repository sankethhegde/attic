// Attic server — Phase 1C. Milestone 1: serves ui/ and answers GET /api/shares with real drive figures.
// Milestone 3: accounts, passwords and sessions live here; every /api/ call except setup and sign-in
// needs a session. Still no folder listing and no paths from the client. Core Node only.
// Usage: node server/server.js
'use strict';
const http = require('http'), https = require('https'), fs = require('fs'), path = require('path'), os = require('os');
const { createAuth, AuthError } = require('./auth');
const { createSafePath } = require('./safe-path');
const { createFiles, parseRange, FileError, INLINE } = require('./files');
const { createOwnership } = require('./ownership');
const { startResponder, loadServerId, DEFAULT_PORT: DEFAULT_DISCOVERY_PORT } = require('./discovery');
const { createPairing, KINDS: DEVICE_KINDS } = require('./pairing');
const ws = require('./ws');
const { createHub } = require('./hub');
const { createSelfStats } = require('./self-stats');
const { createTransfers, publicTransfer } = require('./transfers');
const { openDb } = require('./db');
const { createEvents } = require('./events');
const { createUpdates, publicRelease } = require('./updates');
const { createTls } = require('./tls');
const { createUploads } = require('./uploads');

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
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' }; // the last three for 4-1's Home Screen app

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
    pairing: { required: p.required !== false, trustThisPC: p.trustThisPC !== false },
    // HTTPS (Phase 4, 4-1), for Safari on the iPhone: on unless "https": { "enabled": false }; port 0 also
    // turns it off. "names" adds host names the HP's certificate (and its CA, when first made) covers.
    https: (() => {
      const h = cfg.https || {};
      const envPort = process.env.ATTIC_HTTPS_PORT;
      const port = envPort !== undefined ? +envPort : h.port !== undefined ? +h.port : 8443;
      return { enabled: h.enabled !== false && port > 0, port, names: Array.isArray(h.names) ? h.names : [] };
    })() };
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
// HTTPS (4-1): the HP's own certificate authority and server certificate, in data/tls.
const tls = CONFIG.https.enabled ? createTls(DATA_DIR, { hostname: SERVER_NAME, extraNames: CONFIG.https.names, log: m => console.log('  ' + m) }) : null;
let httpsListening = null; // the HTTPS port once it's up
const tlsSummary = () => tls ? { caFingerprint: tls.caFingerprint, httpsPort: httpsListening } : null;
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
// Over HTTPS (4-1) cookies are also Secure, so a browser never sends them back over plain http.
function sessionCookie(token, maxAge, secure) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict` + (maxAge ? `; Max-Age=${Math.floor(maxAge)}` : '') + (secure ? '; Secure' : '');
}
const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
const deviceCookie = (token, secure) => `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DEVICE_COOKIE_AGE}` + (secure ? '; Secure' : '');
const isHttps = req => !!req.socket.encrypted;
const ownOrigin = req => `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
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
  if (origin && origin !== ownOrigin(req)) throw new AuthError(403, 'FORBIDDEN', 'Cross-site request refused.');
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

// ---------- the device list (2-2) with live state (2-3) ----------
// Everyone signed in sees which devices exist, whether they're online and how they're connected. Only
// the master sees their stats, IP address, and when, by whom and from where each was paired.
// Online: a device whose agent has ever reported is online while its agent is connected; one without an
// agent (the iPhone's browser) while its interface is open, or it made a request in the last 2 minutes.
const hub = createHub(DATA_DIR, { log: m => console.log('  ' + m) });
function describeDevice(d, { master, viewerDeviceId }) {
  const live = hub.live(d.id), l = live.latest;
  const isServer = d.id === SERVER_DEVICE.id;
  const online = isServer || (live.hasAgent ? live.agentOnline : live.connected || d.online);
  const out = { id: d.id, name: d.name, kind: d.kind, os: d.os, role: isServer ? 'server' : 'client', online,
    lastSeenAt: online ? new Date().toISOString() : d.lastSeenAt, thisPC: d.id === viewerDeviceId,
    browserOnly: !isServer && !live.hasAgent, connection: l ? l.connection : null, stats: null };
  if (!master) return out;
  Object.assign(out, { ip: l ? l.ip : null, stats: online && l ? l.stats : null, statsAt: l ? l.at : null });
  if (!online && l) out.lastStats = l.stats;
  if (!isServer) Object.assign(out, { pairedAt: d.pairedAt, pairedBy: d.pairedBy, lastAddress: d.lastAddress });
  return out;
}
const allDevices = () => [SERVER_DEVICE].concat(pairing.list());
const listDevices = (viewerDeviceId, master) => allDevices().map(d => describeDevice(d, { master, viewerDeviceId }));
hub.setDescriber((id, who) => { const d = allDevices().find(x => x.id === id); return d ? describeDevice(d, who) : null; });

// The HP measures itself while a master is watching the Devices view.
// ---------- transfers (Phase 2, 2-4 and 2-5) ----------
// Files sent to another device wait on the HP (config "transferSpool", default data/transfers) until
// that device collects them. Records and history are in the database (data/attic.db). Every change,
// and the progress of a moving transfer about twice a second, is pushed to the viewers who may see it
// (the master, the sender, anyone on the receiving device); a new or cancelled one to the receiving agent.
const db = openDb(DATA_DIR);

// ---------- notification events (Phase 3, 3-2) ----------
// What a client turns into a Windows notification: a file received, a transfer delivered or failed, a
// device online or offline. Pushed to the agents and viewers each is for as {"type":"event"}, and kept
// so a client that was away can ask for what it missed (GET /api/events?after=).
const events = createEvents({ db, deliver: (ev, to) => {
  const msg = { type: 'event', event: ev };
  if (to.allDevices) hub.toAgents(to.notDevice, msg); else for (const d of to.devices) hub.toAgent(d, msg);
  hub.toViewers(v => to.forAccount(v.accountId) || to.forDevice(v.deviceId), msg);
} });
hub.setPresenceHook((id, online) => events.presence(pairing.list().find(d => d.id === id), online));
setInterval(() => events.prune(), 3600e3).unref();
events.prune();

const transfers = createTransfers({ db, dataDir: DATA_DIR, spoolDir: path.resolve(CONFIG.raw.transferSpool || path.join(DATA_DIR, 'transfers')),
  log: m => console.log('  ' + m), onChange: t => announceTransfer(t), onProgress: (t, p) => announceProgress(t, p) });
const mayWatch = t => v => v.master || v.accountId === t.userId || v.deviceId === t.to;
function announceTransfer(t) {
  const pub = publicTransfer(t);
  if (t.status === 'queued') hub.toAgent(t.to, { type: 'transfer', transfer: pub });
  if (t.status === 'cancelled') hub.toAgent(t.to, { type: 'transfer-cancelled', id: t.id });
  hub.toViewers(mayWatch(t), { type: 'transfer', transfer: pub });
  events.transfer(t);
}
function announceProgress(t, p) {
  hub.toViewers(mayWatch(t), { type: 'progress', id: t.id, stage: p.stage, bytesDone: p.bytesDone, size: t.size, speed: p.speed });
}
// A device coming online gets everything waiting for it: the offline queue (D-07).
// ---------- resumable uploads (Phase 4, 4-2) ----------
// For the iPhone's large videos: a file sent in pieces, carried on after a drop. Its last piece places it
// as the one-request upload would: in a share's folder (owned by the uploader), or a transfer's queue.
const uploads = createUploads({ dataDir: DATA_DIR, log: m => console.log('  ' + m),
  onProgress: (s, bytes) => { if (s.target.kind === 'transfer') transfers.progress(s.target.transferId, bytes); },
  onDropped: (s, why) => { if (s.target.kind === 'transfer') transfers.failChunked(s.target.transferId, `The upload stopped: ${why}`); },
  finalize: async s => {
    if (s.target.kind === 'transfer') return publicTransfer(await transfers.finishChunked(s.target.transferId, s.size));
    const t = s.target;
    const placed = await files.placeUpload({ shareId: t.shareId, folderRel: t.folderRel, dir: t.dir, name: s.name }, s.temp);
    own.setRecord(t.shareId, placed.rel, { ownerId: s.userId, uploadedBy: s.userId });
    files.forget(t.shareId);
    const view = own.view({ accountId: s.userId, type: (auth.listAccounts().find(a => a.id === s.userId) || {}).type || 'device' });
    return (await files.listFolder(t.shareId, t.folderRel, view)).items.find(e => e.name === placed.name) || { name: placed.name };
  } });
setInterval(() => uploads.sweep(), 3600e3).unref();

// ---------- updates (Phase 3, 3-5) ----------
// The newest desktop-tool installer and its version (config "updatesDir", default data/updates). A new
// one is announced to everyone, as a hub message and as a notification event.
const updates = createUpdates({ dir: path.resolve(CONFIG.raw.updatesDir || path.join(DATA_DIR, 'updates')), log: m => console.log('  ' + m),
  onPublished: r => {
    const msg = { type: 'update', latest: publicRelease(r) };
    hub.toAgents(null, msg);
    hub.toViewers(() => true, msg);
    events.emit('update.available', { title: `Attic Hub ${r.version} is available`, body: 'A newer version of the Attic Hub desktop tool is ready to install from the HP.', toDevices: '*', toAccounts: '*' });
  } });
setInterval(() => updates.poll(), +process.env.ATTIC_UPDATES_POLL_MS || 30e3).unref(); // picks up `node server/publish-update.js`
// Anyone the HP knows may read about updates: a paired device (an agent, by its token) or a session.
function requireUpdateReader(req) {
  if (req.device) return;
  if (!auth.resolve(readCookie(req, COOKIE), deviceIdOf(req))) throw SIGNED_OUT();
}

// A connecting agent is also told the newest event number, so it can fetch any notifications it missed
// while away, and the newest installer's version, so it can offer an update.
hub.setAgentHook((deviceId, send) => {
  send({ type: 'inbox', transfers: transfers.pendingFor(deviceId).map(publicTransfer) });
  send({ type: 'events', last: events.lastSeq() });
  send({ type: 'update', latest: publicRelease(updates.latest()) });
});
setInterval(() => transfers.sweep(), 3600e3).unref();
transfers.sweep();
// The receiving end is a device, not an account: its agent calls with the device token alone.
function requireReceiver(req) {
  if (!req.device) throw NOT_PAIRED();
  if (req.device === SERVER_DEVICE) throw new AuthError(400, 'INVALID', 'The HP doesn’t receive transfers. To put a file on the HP, upload it in Files.');
  return req.device.id;
}

const selfStats = createSelfStats();
setInterval(async () => { if (hub.mastersWatching()) hub.reportSelf(SERVER_DEVICE.id, await selfStats()); }, hub.STATS_INTERVAL_MS).unref();

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
  // A transfer's delivery (2-5) counts what goes out, for its progress.
  if (f.track) { const count = f.track(start); stream.on('data', c => count(c.length)); }
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
  const upload = (/^\/api\/(shares|transfers)\/[A-Za-z0-9_-]{1,64}\/file$/.test(url) || /^\/api\/updates\/files\/[^/]+$/.test(url) || /^\/api\/uploads\/[A-Za-z0-9_-]{1,64}$/.test(url)) && m === 'PUT';
  if (m !== 'GET' && m !== 'HEAD') checkWrite(req, upload);
  const body = !upload && (m === 'POST' || m === 'PATCH' || m === 'PUT') ? await readBody(req) : {};

  // Public: which Attic server this is. Nothing about accounts, shares or files.
  if (url === '/api/hello' && m === 'GET') return sendJSON(res, 200, { app: 'Attic', api: 1, serverId: SERVER_ID, name: SERVER_NAME });

  // ---------- HTTPS trust (Phase 4, 4-1) ----------
  // Public, over plain http too, because a phone needs them before it trusts the HTTPS address: the CA's
  // fingerprint and where HTTPS is, the CA itself, and an iOS profile holding it. Only the CA's
  // certificate (public by nature) leaves the HP; its key never does.
  if (url.startsWith('/api/tls') && m === 'GET') {
    if (!tls) throw new AuthError(404, 'HTTPS_OFF', 'HTTPS is turned off on this HP.');
    if (url === '/api/tls') return sendJSON(res, 200, Object.assign(tlsSummary(), tls.info(), { caUrl: '/api/tls/ca.cer', profileUrl: '/api/tls/profile.mobileconfig' }));
    if (url === '/api/tls/ca.cer') {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="attic-hub-ca.cer"', 'Cache-Control': 'no-store' });
      return res.end(tls.caDer());
    }
    if (url === '/api/tls/profile.mobileconfig') {
      res.writeHead(200, { 'Content-Type': 'application/x-apple-aspen-config', 'Content-Disposition': 'attachment; filename="Attic Hub.mobileconfig"', 'Cache-Control': 'no-store' });
      return res.end(tls.profile());
    }
  }

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
    hub.deviceAdded(r.device.id);
    // The HP's certificate authority goes with the identity ("trusted at pairing"): a client can pin it.
    return sendJSON(res, 201, { device: { id: r.device.id, name: r.device.name, kind: r.device.kind }, tls: tlsSummary() },
      { 'Set-Cookie': deviceCookie(r.token, isHttps(req)) });
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
      const cookies = [sessionCookie(r.token, r.maxAge, isHttps(req))];
      if (device && device !== SERVER_DEVICE && readCookie(req, DEVICE_COOKIE)) cookies.push(deviceCookie(readCookie(req, DEVICE_COOKIE), isHttps(req)));
      return sendJSON(res, 200, { session: r.session, account: r.account }, { 'Set-Cookie': cookies });
    }
    if (m === 'DELETE') {
      auth.signOut(readCookie(req, COOKIE));
      hub.recheck();
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
    return sendJSON(res, 200, listDevices(deviceIdOf(req), who.session.type === 'master'));
  }
  // Unpair (master): the device's token stops working at once, and everyone signed in on it is signed out.
  const devEdit = /^\/api\/devices\/([A-Za-z0-9_-]{1,64})$/.exec(url);
  if (devEdit && m === 'DELETE') {
    requireMaster(req);
    if (devEdit[1] === SERVER_DEVICE.id) throw new AuthError(400, 'INVALID', 'The HP is the server; it can’t be unpaired.');
    const d = pairing.unpair(devEdit[1]);
    auth.dropDeviceSessions(d.id);
    hub.deviceRemoved(d.id);
    transfers.dropDevice(d.id);
    events.forget(d.id);
    hub.recheck();
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

  // ---------- transfers (Phase 2, 2-4) ----------
  if (url === '/api/transfers') {
    const who = requireSession(req);
    const master = who.session.type === 'master';
    if (m === 'GET') return sendJSON(res, 200, transfers.list({ master, userId: who.session.accountId, deviceId: deviceIdOf(req) }).map(publicTransfer));
    // Step 1: say what is coming and to which device. Step 2 is the PUT below.
    if (m === 'POST') {
      const t = await transfers.create(body, { userId: who.session.accountId, userName: who.account.displayName,
        from: deviceIdOf(req), fromName: req.device ? req.device.name : null,
        isDevice: id => id === SERVER_DEVICE.id ? null : pairing.list().find(d => d.id === id) || null });
      return sendJSON(res, 201, publicTransfer(t));
    }
  }
  // History (2-5, D-08): finished transfers a page at a time. ?limit=&before=<next>&device=&q=&status=
  if (url === '/api/transfers/history' && m === 'GET') {
    const who = requireSession(req);
    const r = transfers.history({ master: who.session.type === 'master', userId: who.session.accountId, deviceId: deviceIdOf(req) },
      { limit: query.get('limit') || 50, before: query.get('before'), device: query.get('device'), q: query.get('q'), status: query.get('status') });
    return sendJSON(res, 200, { items: r.items.map(publicTransfer), next: r.next });
  }
  // Notification events (3-2) for this device and, when signed in, this account. ?after=<seq> gives what
  // came after that one, oldest first (&limit=, default 100); without it, just the newest number, for a
  // client starting out. An agent asks with its device token alone.
  if (url === '/api/events' && m === 'GET') {
    const who = auth.resolve(readCookie(req, COOKIE), deviceIdOf(req));
    const audience = { deviceId: deviceIdOf(req), accountId: who ? who.session.accountId : null };
    if (!audience.deviceId && !audience.accountId) throw SIGNED_OUT();
    if (!query.has('after')) return sendJSON(res, 200, { events: [], last: events.lastSeq(), more: false });
    return sendJSON(res, 200, events.since(audience, query.get('after'), query.get('limit') || 100));
  }

  // ---------- resumable uploads (4-2) ----------
  // Start: { shareId, folder, name, size } for Files, or { transferId } for a send (its file, after
  // POST /api/transfers). Then PUT …/<id>?offset= with each piece (X-Attic-Upload: 1), GET …/<id> to
  // ask where it got to, DELETE …/<id> to give up. Only the account, on the device that started it.
  if (url === '/api/uploads' && m === 'POST') {
    const who = requireSession(req);
    const owner = { userId: who.session.accountId, deviceId: deviceIdOf(req) };
    if (body.transferId !== undefined) {
      const t = transfers.beginChunked(String(body.transferId), { userId: owner.userId, from: owner.deviceId });
      return sendJSON(res, 201, await uploads.create(Object.assign({}, owner, { size: t.size, name: t.name, temp: t.path, target: { kind: 'transfer', transferId: String(body.transferId) } })));
    }
    const size = body.size;
    if (!Number.isSafeInteger(size) || size < 0) throw new AuthError(400, 'INVALID', 'Give the file’s size in bytes.');
    if (size > MAX_UPLOAD) throw new FileError(413, 'TOO_LARGE', 'Too large. The limit is 20 GB per file.');
    const prep = await files.prepareUpload(String(body.shareId || ''), typeof body.folder === 'string' ? body.folder : '', body.name, own.view(who.session));
    // Room for it now, on the share's drive (the bytes go straight there).
    const st = await fs.promises.statfs(prep.dir);
    if (size > st.bavail * st.bsize) throw new FileError(507, 'DISK_FULL', `${prep.shareName} doesn’t have room for that file.`);
    return sendJSON(res, 201, await uploads.create(Object.assign({}, owner, { size, name: prep.name, temp: prep.temp,
      target: { kind: 'share', shareId: prep.shareId, folderRel: prep.folderRel, dir: prep.dir } })));
  }
  const upl = /^\/api\/uploads\/([A-Za-z0-9_-]{1,64})$/.exec(url);
  if (upl) {
    const who = requireSession(req);
    const owner = { userId: who.session.accountId, deviceId: deviceIdOf(req) };
    if (m === 'GET') return sendJSON(res, 200, uploads.status(upl[1], owner));
    if (m === 'DELETE') return sendJSON(res, 200, uploads.cancel(upl[1], owner));
    if (m === 'PUT') {
      // A wrong offset, or a piece cut off, answers with the offset the HP has, to carry on from.
      try { return sendJSON(res, 200, await uploads.append(upl[1], owner, query.get('offset'), req)); }
      catch (e) { if (e instanceof AuthError && e.offset !== undefined) return sendJSON(res, e.status, { code: e.code, message: e.message, offset: e.offset }); throw e; }
    }
  }

  // ---------- updates (3-5) ----------
  // The newest installer; ?current=<the caller's version> adds whether it's newer. 404 NO_UPDATE if none.
  if (url === '/api/updates/latest' && m === 'GET') {
    requireUpdateReader(req);
    const r = updates.latest();
    if (!r) throw new AuthError(404, 'NO_UPDATE', 'The HP has no installer to offer yet.');
    return sendJSON(res, 200, publicRelease(r, query.get('current')));
  }
  if (url === '/api/updates' && m === 'GET') { requireMaster(req); return sendJSON(res, 200, updates.list().map(r => publicRelease(r))); }
  const upd = /^\/api\/updates\/files\/([^/]+)$/.exec(url);
  if (upd) {
    let name;
    try { name = decodeURIComponent(upd[1]); } catch (e) { throw new AuthError(400, 'INVALID', 'Bad file name.'); }
    // For electron-updater's generic provider, pointed at /api/updates/files.
    if (name === 'latest.yml' && m === 'GET') {
      requireUpdateReader(req);
      const yml = updates.yml();
      if (!yml) throw new AuthError(404, 'NO_UPDATE', 'The HP has no installer to offer yet.');
      res.writeHead(200, { 'Content-Type': 'text/yaml; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(yml);
    }
    if (m === 'GET' || m === 'HEAD') { requireUpdateReader(req); return sendFile(req, res, await updates.open(name), false); }
    // Publish (master): the installer as the body, with X-Attic-Upload: 1. ?notes=&replace=1
    if (m === 'PUT') {
      const who = requireMaster(req);
      const declared = Number(req.headers['content-length']);
      const r = await updates.publish(req, { fileName: name, notes: query.get('notes') || '', replace: query.get('replace') === '1',
        size: Number.isFinite(declared) ? declared : null, publishedBy: who.session.accountId });
      return sendJSON(res, 201, publicRelease(r));
    }
  }

  // What is waiting for this device (its agent, or its interface).
  if (url === '/api/inbox' && m === 'GET') return sendJSON(res, 200, transfers.pendingFor(requireReceiver(req)).map(publicTransfer));
  const tr = /^\/api\/transfers\/([A-Za-z0-9_-]{1,64})(\/file|\/received|\/failed|\/retry)?$/.exec(url);
  if (tr) {
    const [, id, sub] = tr;
    // The sender streams the file to the HP: exactly the size it declared, with X-Attic-Upload: 1.
    if (sub === '/file' && m === 'PUT') {
      const who = requireSession(req);
      return sendJSON(res, 200, publicTransfer(await transfers.receiveUpload(id, req, { userId: who.session.accountId, from: deviceIdOf(req) })));
    }
    // The receiving device downloads it (resumable by range), then confirms or reports a failure.
    if (sub === '/file' && (m === 'GET' || m === 'HEAD')) return sendFile(req, res, await transfers.openForDelivery(id, requireReceiver(req)), false);
    if (sub === '/received' && m === 'POST') return sendJSON(res, 200, publicTransfer(transfers.received(id, requireReceiver(req))));
    if (sub === '/failed' && m === 'POST') return sendJSON(res, 200, publicTransfer(transfers.failed(id, requireReceiver(req), body.error)));
    // Retry (2-5): the sender or the master. Back in the queue if the HP still has the file; otherwise
    // the answer is active / upload, and the sender PUTs the file again.
    if (sub === '/retry' && m === 'POST') {
      const who = requireSession(req);
      return sendJSON(res, 200, publicTransfer(await transfers.retry(id, { userId: who.session.accountId, master: who.session.type === 'master' })));
    }
    // One transfer, as the list shows it.
    if (!sub && m === 'GET') {
      const who = requireSession(req);
      const t = transfers.get(id);
      const mine = t && (who.session.type === 'master' || t.userId === who.session.accountId || (deviceIdOf(req) && t.to === deviceIdOf(req)));
      if (!mine) throw new AuthError(404, 'NOT_FOUND', 'That transfer no longer exists.');
      return sendJSON(res, 200, publicTransfer(t));
    }
    // Cancel: the sender or the master.
    if (!sub && m === 'DELETE') {
      const who = requireSession(req);
      return sendJSON(res, 200, publicTransfer(transfers.cancel(id, { userId: who.session.accountId, master: who.session.type === 'master' })));
    }
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
      hub.recheck();
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
      hub.recheck();
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
      hub.recheck();
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

// One handler for both servers: plain http (the desktop tools, port 8080) and HTTPS (Safari, 4-1).
async function handleRequest(req, res) {
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
}
const server = http.createServer(handleRequest);
// Large uploads (4-2): Node ends any request still running after 5 minutes by default, which cuts off a
// phone's multi-GB video over Wi-Fi near the end. There's no limit on a request's total time; instead a
// connection that's gone quiet (nothing sent or received for 5 minutes) is closed.
const IDLE_MS = +process.env.ATTIC_IDLE_TIMEOUT_MS || 5 * 60e3;
function tune(s) { s.requestTimeout = 0; s.timeout = IDLE_MS; return s; }
tune(server);

// ---------- the live hub (Phase 2, 2-3) ----------
// GET /api/hub as a WebSocket. ?role=agent: a paired PC's background part, identified by its device
// token alone, reporting its own stats. Otherwise a viewer: the interface, with a session on a paired
// device, like any other API call. Browsers send an Origin header, and it must be this server, so a
// page on another site can't open a hub connection with this browser's cookies.
function handleUpgrade(req, socket) {
  socket.on('error', () => socket.destroy());
  let parsed;
  try { parsed = new URL(req.url, 'http://x'); } catch (e) { return ws.refuse(socket, 400, { code: 'INVALID', message: 'Bad request.' }); }
  if (parsed.pathname !== '/api/hub') return ws.refuse(socket, 404, { code: 'NOT_FOUND', message: 'No such endpoint.' });
  const origin = req.headers.origin;
  if (origin && origin !== ownOrigin(req)) return ws.refuse(socket, 403, { code: 'FORBIDDEN', message: 'Cross-site request refused.' });
  const device = identifyDevice(req);
  const deviceId = deviceIdOf(req), deviceToken = req.deviceToken;
  const stillPaired = () => !device || device === SERVER_DEVICE || !!pairing.resolve(deviceToken);

  if (parsed.searchParams.get('role') === 'agent') {
    if (!device) return ws.refuse(socket, 403, NOT_PAIRED_BODY);
    if (device === SERVER_DEVICE) return ws.refuse(socket, 400, { code: 'INVALID', message: 'The HP reports its own stats; it doesn’t need an agent.' });
    const conn = ws.accept(req, socket);
    if (!conn) return ws.refuse(socket, 400, { code: 'INVALID', message: 'Expected a WebSocket handshake.' });
    return hub.addAgent(conn, deviceId, stillPaired);
  }

  if (CONFIG.pairing.required && !device) return ws.refuse(socket, 403, NOT_PAIRED_BODY);
  const sessionToken = readCookie(req, COOKIE);
  const who = auth.resolve(sessionToken, deviceId);
  if (!who) return ws.refuse(socket, 401, { code: 'SIGNED_OUT', message: 'Your session has ended. Sign in again.' });
  const conn = ws.accept(req, socket);
  if (!conn) return ws.refuse(socket, 400, { code: 'INVALID', message: 'Expected a WebSocket handshake.' });
  const master = who.session.type === 'master';
  hub.addViewer(conn, { deviceId, accountId: who.session.accountId, master, devices: listDevices(deviceId, master),
    check: () => stillPaired() && !!auth.resolve(sessionToken, deviceId) });
}
server.on('upgrade', handleUpgrade);
const NOT_PAIRED_BODY = { code: 'NOT_PAIRED', message: 'This device isn’t paired with the HP yet. Ask for a pairing code on the HP.' };

// Run by the supervisor (Phase 3, 3-1): if it goes (the Windows task was stopped), so does the server,
// rather than holding the port with nobody to restart it.
if (process.env.ATTIC_SUPERVISOR_PID) {
  const sup = +process.env.ATTIC_SUPERVISOR_PID;
  setInterval(() => {
    try { process.kill(sup, 0); }
    catch (e) { if (e.code !== 'EPERM') { console.log('Supervisor gone; stopping.'); process.exit(0); } }
  }, 2000).unref();
}

// HTTPS: the same handlers. If the port is taken the server carries on over http, and says so. The
// certificate is checked every 10 minutes and re-issued in place (no restart) when the HP's addresses
// change or it nears its end.
function startHttps() {
  return new Promise(resolve => {
    const s = tune(https.createServer({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }, handleRequest));
    s.on('upgrade', handleUpgrade);
    s.on('tlsClientError', () => {}); // a phone that doesn't trust the CA yet: nothing to log
    s.once('error', e => { if (e.code === 'EADDRINUSE' || e.code === 'EACCES') resolve(null); else { console.error(e.message); resolve(null); } });
    s.listen(CONFIG.https.port, CONFIG.host, () => {
      httpsListening = s.address().port;
      setInterval(() => { if (tls.refresh()) s.setSecureContext({ key: tls.key, cert: tls.cert, minVersion: 'TLSv1.2' }); }, 10 * 60e3).unref();
      resolve(httpsListening);
    });
  });
}

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
  if (tls) {
    const port = await startHttps();
    console.log(port ? `  HTTPS:        https://<address above>:${port} (for Safari; trust profile at /api/tls/profile.mobileconfig)` : `  HTTPS:        off: port ${CONFIG.https.port} is already in use`);
  } else console.log('  HTTPS:        off');
  const paired = pairing.list().length;
  console.log(CONFIG.pairing.required ? `  Pairing:      required (${paired} paired device${paired === 1 ? '' : 's'}${CONFIG.pairing.trustThisPC ? '; this PC is trusted' : ''})`
    : '  Pairing:      OFF — any device on the network can sign in');
  console.log('Shares:');
  for (const s of await listShares()) {
    console.log(`  ${s.id.padEnd(8)} ${s.rootPath.padEnd(22)} ${s.available ? `${(s.free / 1e9).toFixed(1)} GB free of ${(s.total / 1e9).toFixed(1)} GB` : 'UNAVAILABLE'}`);
  }
});
