// people.js — Phase 5 (5-1, 5-3), the HP's half: People Portfolio saves its details to Attic and picks
// photos from it. People Portfolio stays its own web page; Attic is where its data is saved, and where
// photos can be fetched from. Requirements: "Phase 5 — People Portfolio and Attic".
//
// The master sets it up once in Settings → People Portfolio (master session, same-origin, like any other
// setting): the save folder (inside a shared folder), the People Portfolio page's addresses, and a key.
// The page then calls the key routes from its own address, with the key in the X-Attic-Key header:
//   GET  /api/people/ping             { ok, server }                       the status check
//   PUT  /api/people/data             the export file → { name, savedAt }  a new dated file; newest 30 kept
//   GET  /api/people/data?name=       the newest save, or the named one
//   GET  /api/people/saves            [{ name, savedAt, size }], newest first
//   GET  /api/people/folders?share=&path=   shared folders; then a folder's subfolders and photos
//   GET  /api/people/photo?share=&path=&size=   the photo; with size, a small preview
// Rules: only the master's key works (stored as its SHA-256; a new key stops the old one), only pages at
// the listed addresses (the Origin header; CORS answered for them alone), only from the home network
// (a private or loopback address), and nothing is written except the save files. Photos are read where
// they are, through the share checks, as the master; nothing is copied. Core Node only.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_SAVE = 25 * 1024 * 1024;      // a People Portfolio export is details only: a few MB at most
const KEEP = 30;
const SAVE_NAME = /^people-\d{4}-\d{2}-\d{2}_\d{6}(-\d{1,3})?\.json$/;
const PHOTO = /\.(jpe?g|png|gif|webp|bmp|heic|heif|avif)$/i;
const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fe80:|fc|fd)/i;
const HEADERS = 'X-Attic-Key, Content-Type';

// The server's own error type, so its handler answers these as it answers any other refusal.
const { AuthError: PeopleError } = require('./auth');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// A page's address, as the browser sends it in Origin: http(s)://host[:port], nothing else.
function normalizeOrigin(o) {
  let u;
  try { u = new URL(String(o || '').trim()); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
  return u.origin;
}

// The newest date-stamped name not yet taken: people-2026-11-08_143005.json, then -2, -3.
function saveName(now, taken) {
  const p = n => String(n).padStart(2, '0');
  const base = `people-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  for (let i = 1; ; i++) { const n = i === 1 ? `${base}.json` : `${base}-${i}.json`; if (!taken.has(n)) return n; }
}

// The small preview most cameras and phones put inside a JPEG (EXIF IFD1, about 160 px), found without an
// image library: APP1 "Exif", the TIFF header, IFD0 → IFD1 → JPEGInterchangeFormat (0x0201) and its length
// (0x0202). null when there's none, and the caller sends the whole photo.
function exifThumbnail(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1], len = buf.readUInt16BE(i + 2);
    if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
      const t = i + 10;
      if (t + 8 > buf.length) return null;
      const le = buf.toString('latin1', t, t + 2) === 'II';
      const u16 = o => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)), u32 = o => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
      try {
        const ifd0 = t + u32(t + 4);
        const n0 = u16(ifd0);
        const ifd1Off = u32(ifd0 + 2 + n0 * 12);
        if (!ifd1Off) return null;
        const ifd1 = t + ifd1Off, n1 = u16(ifd1);
        let off = 0, size = 0;
        for (let k = 0; k < n1; k++) {
          const e = ifd1 + 2 + k * 12, tag = u16(e);
          if (tag === 0x0201) off = u32(e + 8);
          if (tag === 0x0202) size = u32(e + 8);
        }
        if (!off || !size || t + off + size > buf.length) return null;
        const thumb = buf.subarray(t + off, t + off + size);
        return thumb[0] === 0xff && thumb[1] === 0xd8 ? Buffer.from(thumb) : null;
      } catch (e) { return null; }
    }
    if (marker === 0xda || marker === 0xd9) break; // image data: no EXIF before it
    i += 2 + len;
  }
  return null;
}

// dataDir: where people.json (settings, key hash) lives. files/safePath/masterView: the server's own.
function createPeople({ dataDir, files: getFiles, safePath: getSafePath, masterView, serverName, log = () => {} }) {
  const file = path.join(dataDir, 'people.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { folder: null, origins: [], keyHash: null, keyCreatedAt: null }; } };
  const store = s => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(s, null, 2)); fs.renameSync(file + '.tmp', file); };
  const fails = new Map(); // address → { n, at }: wrong keys

  function publicSettings() {
    const s = load();
    return { folder: s.folder, origins: s.origins || [], hasKey: !!s.keyHash, keyCreatedAt: s.keyCreatedAt };
  }
  async function setSettings({ folder, origins }) {
    const s = load();
    if (folder !== undefined) {
      if (folder === null) s.folder = null;
      else {
        const shareId = String(folder.shareId || ''), rel = String(folder.path || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        await getFiles().listFolder(shareId, rel, masterView()); // must exist, inside the share
        s.folder = { shareId, path: rel };
      }
    }
    if (origins !== undefined) {
      if (!Array.isArray(origins) || origins.length > 10) throw new PeopleError(400, 'INVALID', 'Give up to 10 page addresses.');
      const out = [];
      for (const o of origins) {
        const n = normalizeOrigin(o);
        if (!n) throw new PeopleError(400, 'INVALID', `“${String(o).slice(0, 80)}” isn’t a page address. Use one like http://localhost:5173.`);
        if (!out.includes(n)) out.push(n);
      }
      s.origins = out;
    }
    store(s);
    return publicSettings();
  }
  function newKey() {
    const key = crypto.randomBytes(32).toString('base64url');
    const s = load();
    s.keyHash = sha256(key); s.keyCreatedAt = new Date().toISOString();
    store(s);
    log('People Portfolio: a new key was made; the old one no longer works.');
    return { key, keyCreatedAt: s.keyCreatedAt };
  }

  // CORS for the listed pages only. Chrome also asks before a page reaches a private-network address.
  function corsHeaders(req) {
    const origin = normalizeOrigin(req.headers.origin);
    const s = load();
    if (!origin || !(s.origins || []).includes(origin)) return null;
    const h = { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'Content-Length' };
    return h;
  }
  function gate(req) {
    const addr = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!PRIVATE.test(addr)) throw new PeopleError(403, 'FORBIDDEN', 'People Portfolio reaches Attic on the home network only.');
    const s = load();
    const origin = normalizeOrigin(req.headers.origin);
    if (!origin || !(s.origins || []).includes(origin)) throw new PeopleError(403, 'FORBIDDEN', 'This page’s address isn’t allowed. Add it in Attic: Settings → People Portfolio.');
    const f = fails.get(addr);
    if (f && f.n >= 20 && Date.now() - f.at < 15 * 60e3) throw new PeopleError(429, 'TOO_MANY', 'Too many wrong keys. Try again in a few minutes.');
    const key = String(req.headers['x-attic-key'] || '');
    const ok = !!s.keyHash && key.length > 0 && crypto.timingSafeEqual(Buffer.from(sha256(key), 'hex'), Buffer.from(s.keyHash, 'hex'));
    if (!ok) {
      const g = fails.get(addr) || { n: 0, at: Date.now() };
      if (Date.now() - g.at > 15 * 60e3) { g.n = 0; g.at = Date.now(); }
      g.n++; fails.set(addr, g);
      throw new PeopleError(401, 'BAD_KEY', s.keyHash ? 'That key doesn’t work. Make a new one in Attic and paste it again.' : 'Attic has no key yet. Make one in Attic: Settings → People Portfolio.');
    }
    fails.delete(addr);
    return s;
  }

  // The save folder on disk, checked against its share.
  async function saveDir(s) {
    if (!s.folder) throw new PeopleError(409, 'NO_FOLDER', 'Choose a save folder in Attic: Settings → People Portfolio.');
    await getFiles().listFolder(s.folder.shareId, s.folder.path, masterView());
    const dir = getSafePath()(s.folder.shareId, s.folder.path);
    if (!dir) throw new PeopleError(409, 'NO_FOLDER', 'The save folder isn’t valid any more. Choose it again in Attic.');
    return dir;
  }
  async function saves(dir) {
    const names = (await fs.promises.readdir(dir)).filter(n => SAVE_NAME.test(n));
    const out = [];
    for (const name of names) { try { const st = await fs.promises.stat(path.join(dir, name)); if (st.isFile()) out.push({ name, savedAt: st.mtime.toISOString(), size: st.size }); } catch (e) { /* gone */ } }
    // The name is the date (and -2, -3… within one second): newest first.
    const key = n => { const m = /^people-(\d{4}-\d{2}-\d{2}_\d{6})(?:-(\d+))?\.json$/.exec(n); return [m[1], Number(m[2] || 1)]; };
    return out.sort((a, b) => { const [ta, na] = key(a.name), [tb, nb] = key(b.name); return tb.localeCompare(ta) || nb - na; });
  }
  function readSave(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > MAX_SAVE) { reject(new PeopleError(413, 'TOO_LARGE', 'That’s larger than a People Portfolio export can be (25 MB).')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        let j;
        try { j = JSON.parse(buf.toString('utf8')); } catch (e) { return reject(new PeopleError(400, 'INVALID', 'That isn’t a People Portfolio export (not JSON).')); }
        if (!j || j.app !== 'people-portfolio') return reject(new PeopleError(400, 'INVALID', 'That isn’t a People Portfolio export (app isn’t “people-portfolio”).'));
        resolve(buf);
      });
      req.on('error', reject);
    });
  }

  // The routes. send(res, status, body, headers) answers JSON; sendFile(req, res, f, inline) a file.
  async function handle(req, res, url, query, { send, sendFile }) {
    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') {
      if (!cors) { res.writeHead(403); return res.end(); }
      const h = Object.assign({}, cors, { 'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS', 'Access-Control-Allow-Headers': HEADERS, 'Access-Control-Max-Age': '600' });
      if (req.headers['access-control-request-private-network'] === 'true') h['Access-Control-Allow-Private-Network'] = 'true';
      res.writeHead(204, h);
      return res.end();
    }
    const reply = (status, body) => send(res, status, body, cors || undefined);
    try {
      const s = gate(req);
      const m = req.method;
      if (url === '/api/people/ping' && m === 'GET') return reply(200, { ok: true, server: serverName });
      if (url === '/api/people/saves' && m === 'GET') return reply(200, await saves(await saveDir(s)));
      if (url === '/api/people/data' && m === 'PUT') {
        const buf = await readSave(req);
        const dir = await saveDir(s);
        const list = await saves(dir);
        const name = saveName(new Date(), new Set(list.map(x => x.name)));
        await fs.promises.writeFile(path.join(dir, name), buf, { flag: 'wx' }); // never overwrites
        for (const old of (await saves(dir)).slice(KEEP)) await fs.promises.rm(path.join(dir, old.name), { force: true });
        log(`People Portfolio saved ${name} (${buf.length} bytes).`);
        return reply(201, { name, savedAt: new Date().toISOString() });
      }
      if (url === '/api/people/data' && m === 'GET') {
        const dir = await saveDir(s);
        const want = query.get('name');
        if (want && !SAVE_NAME.test(want)) throw new PeopleError(400, 'INVALID', 'Not a save’s name.');
        const name = want || ((await saves(dir))[0] || {}).name;
        if (!name) throw new PeopleError(404, 'NOT_FOUND', 'Nothing has been saved to Attic yet.');
        let buf;
        try { buf = await fs.promises.readFile(path.join(dir, name)); } catch (e) { throw new PeopleError(404, 'NOT_FOUND', 'That save no longer exists.'); }
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Attic-Save': name }, cors));
        return res.end(buf);
      }
      if (url === '/api/people/folders' && m === 'GET') {
        const share = query.get('share');
        if (!share) return reply(200, { shares: getFiles().shares().map(x => ({ id: x.id, name: x.name })) });
        const rel = String(query.get('path') || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const r = await getFiles().listFolder(share, rel, masterView());
        return reply(200, {
          share: r.share, path: r.path,
          folders: r.items.filter(i => i.kind === 'folder').map(i => ({ name: i.name, path: r.path ? r.path + '/' + i.name : i.name })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
          photos: r.items.filter(i => i.kind === 'file' && PHOTO.test(i.name)).map(i => ({ name: i.name, ref: `${share}/${r.path ? r.path + '/' + i.name : i.name}`, size: i.size, modifiedAt: i.modifiedAt }))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        });
      }
      if (url === '/api/people/photo' && (m === 'GET' || m === 'HEAD')) {
        const share = String(query.get('share') || ''), rel = String(query.get('path') || '').replace(/\\/g, '/').replace(/^\/+/, '');
        if (!PHOTO.test(rel)) throw new PeopleError(400, 'INVALID', 'Only photos are served here.');
        const f = await getFiles().openFile(share, rel, masterView());
        // A small preview for grids: the JPEG's own thumbnail when it has one (no image library on the HP).
        if (query.get('size') && /\.jpe?g$/i.test(rel)) {
          const head = Buffer.alloc(Math.min(f.size, 256 * 1024));
          await f.handle.read(head, 0, head.length, 0);
          const thumb = exifThumbnail(head);
          if (thumb) {
            await f.handle.close();
            res.writeHead(200, Object.assign({ 'Content-Type': 'image/jpeg', 'Content-Length': thumb.length, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'X-Attic-Preview': 'exif' }, cors));
            return res.end(m === 'HEAD' ? undefined : thumb);
          }
        }
        if (cors) for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
        return sendFile(req, res, f, true);
      }
      throw new PeopleError(404, 'NOT_FOUND', 'No such endpoint.');
    } catch (e) {
      if (e.status && e.code) return reply(e.status, { code: e.code, message: e.message });
      throw e;
    }
  }

  return { publicSettings, setSettings, newKey, handle, gate };
}

module.exports = { createPeople, exifThumbnail, normalizeOrigin, saveName, PeopleError, SAVE_NAME, KEEP };
