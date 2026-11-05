// uploads.js — Phase 4, milestone 4-2: resumable uploads, for the iPhone's camera-roll videos.
//
// One request for a multi-GB video rarely survives a phone: the screen locks, Safari goes to the
// background, the Wi-Fi drops, and the upload starts again from nothing. An upload session takes the
// file in pieces instead:
//   1. POST /api/uploads says what's coming and where to (a folder in a share, or a transfer to send);
//   2. PUT /api/uploads/<id>?offset=<n> sends the next piece (up to 64 MB; 8 MB is a good size);
//   3. after a drop, GET /api/uploads/<id> says how much arrived, and the phone carries on from there.
// The last piece places the file, exactly as the one-request upload would: into its folder under a name
// nobody has taken, or into the transfer's queue for the receiving device.
// The bytes go straight to where they'll end up (a hidden ~attic-….part file in the destination folder,
// or the transfer spool), so finishing a 10 GB video is a link or a rename, not a copy. Sessions are kept
// in data/uploads.json, so an HP restart loses nothing; one left untouched for a day is dropped.
// Core Node only.
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const { AuthError, jsonStore } = require('./auth');

const MAX_CHUNK = 64 * 1024 * 1024;
const SUGGESTED_CHUNK = 8 * 1024 * 1024;
const IDLE_MS = 24 * 3600e3;

const NOT_FOUND = () => new AuthError(404, 'NOT_FOUND', 'That upload no longer exists. Start it again.');

function createUploads({ dataDir, log = () => {}, finalize, onProgress = () => {}, onDropped = () => {} }) {
  const store = jsonStore(path.join(dataDir, 'uploads.json'), []);
  const busy = new Set(); // sessions with a piece arriving now
  const find = id => store.get().find(s => s.id === id);
  const put = s => store.save(store.get().filter(x => x.id !== s.id).concat(s));
  const drop = id => store.save(store.get().filter(x => x.id !== id));
  const pub = s => ({ id: s.id, name: s.name, size: s.size, offset: s.offset, target: { kind: s.target.kind, shareId: s.target.shareId, folder: s.target.folderRel, transferId: s.target.transferId },
    chunkSize: SUGGESTED_CHUNK, maxChunk: MAX_CHUNK, createdAt: s.createdAt, updatedAt: s.updatedAt });

  // After a restart: each session's offset is what's actually on disk; one whose file is gone is dropped.
  for (const s of store.get()) {
    let size = -1;
    try { size = fs.statSync(s.temp).size; } catch (e) { /* gone */ }
    if (size < 0 || size > s.size) { drop(s.id); onDropped(s, 'Its file on the HP is gone.'); }
    else if (size !== s.offset) put(Object.assign({}, s, { offset: size }));
  }

  function mine(id, who) {
    const s = find(id);
    if (!s || s.userId !== who.userId || s.deviceId !== (who.deviceId || null)) throw NOT_FOUND();
    return s;
  }

  async function complete(s) {
    drop(s.id);
    try { return await finalize(s); }
    finally { fs.rmSync(s.temp, { force: true }); }
  }

  return {
    MAX_CHUNK, SUGGESTED_CHUNK,

    // target: { kind: 'share', shareId, folderRel, dir } or { kind: 'transfer', transferId }. temp: where
    // the bytes go. The file is made now, empty, so two sessions can never share one.
    async create({ userId, deviceId, size, name, temp, target }) {
      if (!Number.isSafeInteger(size) || size < 0) throw new AuthError(400, 'INVALID', 'Give the file’s size in bytes.');
      const now = new Date().toISOString();
      const s = { id: 'up_' + crypto.randomBytes(9).toString('base64url'), userId, deviceId: deviceId || null, size, offset: 0, name, temp, target, createdAt: now, updatedAt: now };
      fs.writeFileSync(temp, Buffer.alloc(0), { flag: 'wx' });
      put(s);
      log(`Upload ${s.id} started: ${name} (${size} bytes)`);
      if (size === 0) return Object.assign(pub(s), { done: true, result: await complete(s) });
      return Object.assign(pub(s), { done: false });
    },

    status(id, who) { return pub(mine(id, who)); },

    // The next piece, at exactly the offset the HP has. Bytes that arrive before a drop are kept, so a
    // piece cut off half-way only needs its second half sent again.
    async append(id, who, offset, stream) {
      const s = mine(id, who);
      if (busy.has(id)) throw new AuthError(409, 'BUSY', 'A piece of this upload is already arriving.');
      const at = Number(offset);
      if (!Number.isSafeInteger(at) || at !== s.offset) throw Object.assign(new AuthError(409, 'OFFSET', `The HP has ${s.offset} bytes of this file. Send from there.`), { offset: s.offset });
      const declared = Number(stream.headers && stream.headers['content-length']);
      if (!Number.isSafeInteger(declared) || declared <= 0) throw new AuthError(411, 'INVALID', 'Send each piece with its Content-Length.');
      if (declared > MAX_CHUNK) throw new AuthError(413, 'TOO_LARGE', `A piece can be at most ${MAX_CHUNK / 1048576} MB.`);
      if (at + declared > s.size) throw new AuthError(400, 'INVALID', `That would go past the file’s ${s.size} bytes.`);
      busy.add(id);
      let got = 0, failure = null;
      try {
        await new Promise(resolve => {
          const out = fs.createWriteStream(s.temp, { flags: 'r+', start: at });
          const fail = e => { if (!failure) { failure = e; stream.unpipe(out); out.end(); } };
          stream.on('data', c => { got += c.length; if (got > declared) fail(new AuthError(400, 'INVALID', 'More data than the Content-Length.')); else onProgress(s, at + got); });
          stream.on('close', () => { if (stream.complete === false) fail(new AuthError(400, 'CANCELLED', 'The piece was cut off. Ask where the upload got to, and carry on from there.')); });
          stream.on('error', () => fail(new AuthError(400, 'CANCELLED', 'The piece was cut off.')));
          out.on('error', e => { failure = failure || (e.code === 'ENOENT' ? new AuthError(409, 'GONE', 'The destination is gone (the transfer was cancelled, or the folder removed).')
            : e.code === 'ENOSPC' ? new AuthError(507, 'DISK_FULL', 'The drive is full.') : e); resolve(); });
          out.on('close', resolve);
          stream.pipe(out);
        });
      } finally { busy.delete(id); }
      // What's on disk now is what counts: all of a whole piece, or as much of a cut one as arrived.
      let onDisk = at;
      try { onDisk = Math.min(fs.statSync(s.temp).size, s.size); } catch (e) { /* gone */ }
      if (failure && failure.code === 'GONE') { drop(id); fs.rmSync(s.temp, { force: true }); onDropped(s, failure.message); throw failure; }
      const cur = Object.assign({}, s, { offset: Math.min(onDisk, at + Math.min(got, declared)), updatedAt: new Date().toISOString() });
      put(cur);
      if (failure) throw Object.assign(failure, { offset: cur.offset });
      if (cur.offset === cur.size) return Object.assign(pub(cur), { done: true, result: await complete(cur) });
      return Object.assign(pub(cur), { done: false });
    },

    cancel(id, who) {
      const s = mine(id, who);
      if (busy.has(id)) throw new AuthError(409, 'BUSY', 'A piece is arriving; try again when it’s done.');
      drop(id);
      fs.rmSync(s.temp, { force: true });
      onDropped(s, 'Cancelled.');
      return { ok: true };
    },

    // Sessions nobody has touched for a day are dropped, with their bytes.
    sweep(t0 = Date.now()) {
      for (const s of store.get()) {
        if (busy.has(s.id) || t0 - Date.parse(s.updatedAt) < IDLE_MS) continue;
        drop(s.id);
        fs.rmSync(s.temp, { force: true });
        onDropped(s, 'The upload stopped and wasn’t carried on within a day.');
      }
    },
    list: () => store.get().map(pub)
  };
}

module.exports = { createUploads, MAX_CHUNK, SUGGESTED_CHUNK };
