// transfers.js — Phase 2, milestone 2-4 (D-05, D-07): send a file to another device through the HP.
//
// Every client talks only to the HP, so a file from the Acer to the ROG Ally goes in two legs:
//   1. upload: the sender streams it to the HP, which spools it to disk (data/transfers/<id>.bin).
//   2. delivery: the receiving device's agent downloads it into its Hub Inbox and confirms, and the
//      HP deletes its copy. A device that's offline gets it when it next connects (the offline queue).
// Records live in data/transfers.json, so a queued file survives an HP restart. An upload cut off by a
// restart fails; a delivery cut off goes back to the queue (and the download can resume by range).
//
// Statuses use the Transfers view's words: active (stage "upload" or "deliver"), queued (on the HP,
// waiting for the device), done, failed, cancelled. Live progress and Retry are milestone 2-5.
// Core Node only.
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const { AuthError, jsonStore } = require('./auth');
const { segmentOk } = require('./safe-path');

const MAX_SIZE = 20e9;                    // same as a Files upload
const KEEP_MS = 14 * 864e5;               // an undelivered file is kept this long
const FREE_MARGIN = 1e9;                  // the spool's drive keeps this much free
const MAX_OPEN_PER_ACCOUNT = 50;          // unfinished transfers one account may have
const OPEN = ['active', 'queued'];
const PENDING = t => t.status === 'queued' || (t.status === 'active' && t.stage === 'deliver');

const NOT_FOUND = () => new AuthError(404, 'NOT_FOUND', 'That transfer no longer exists.');

// A name the receiving PC can store as typed: one segment, no path, no Windows tricks, 1–200 characters.
function checkFileName(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n || n.length > 200 || /[/\\]/.test(n) || !segmentOk(n)) {
    throw new AuthError(400, 'INVALID', 'That file name can’t be stored on Windows. Rename the file and send it again.');
  }
  if (/\.(lnk|url|scf)$/i.test(n)) throw new AuthError(400, 'INVALID', 'Shortcut files can’t be sent.');
  return n;
}

function createTransfers({ dataDir, spoolDir, log = () => {}, onChange = () => {} }) {
  const store = jsonStore(path.join(dataDir, 'transfers.json'), []);
  fs.mkdirSync(spoolDir, { recursive: true });
  const fileOf = id => path.join(spoolDir, id + '.bin');
  const partOf = id => path.join(spoolDir, id + '.part');
  const now = () => new Date().toISOString();
  const find = id => store.get().find(t => t.id === id);
  const inFlight = new Map(); // id -> stop(error), for uploads arriving now

  function update(id, patch) {
    store.save(store.get().map(t => t.id === id ? Object.assign({}, t, patch) : t));
    const t = find(id);
    onChange(t);
    return t;
  }
  const removeFile = id => { for (const p of [fileOf(id), partOf(id)]) fs.promises.unlink(p).catch(() => {}); };

  // ---------- after a restart ----------
  // An upload that was in flight is lost; a delivery in flight goes back to waiting. Spool files with no
  // open transfer (a crash between steps) are deleted.
  {
    let changed = false;
    const list = store.get().map(t => {
      if (t.status === 'active' && t.stage === 'upload') { changed = true; return Object.assign({}, t, { status: 'failed', finishedAt: now(), error: 'The HP restarted during the upload. Send it again.' }); }
      if (t.status === 'active' && t.stage === 'deliver') { changed = true; return Object.assign({}, t, { status: 'queued', stage: 'waiting' }); }
      return t;
    });
    if (changed) store.save(list);
    const keep = new Set(list.filter(t => PENDING(t) || t.status === 'failed' && t.uploadedAt).map(t => t.id + '.bin'));
    for (const f of fs.readdirSync(spoolDir)) if (!keep.has(f)) fs.promises.unlink(path.join(spoolDir, f)).catch(() => {});
  }

  return {
    MAX_SIZE,
    get: id => find(id) || null,

    // ---------- the sender ----------
    async create({ fileName, size, to } = {}, { userId, from, isDevice }) {
      const name = checkFileName(fileName);
      if (!Number.isSafeInteger(size) || size < 0) throw new AuthError(400, 'INVALID', 'Give the file’s size in bytes.');
      if (size > MAX_SIZE) throw new AuthError(413, 'TOO_LARGE', 'Too large. The limit is 20 GB per file.');
      if (typeof to !== 'string' || !isDevice(to)) throw new AuthError(400, 'INVALID', 'Choose a paired device to send to.');
      if (to === from) throw new AuthError(400, 'INVALID', 'That’s this device. Choose another one.');
      if (store.get().filter(t => t.userId === userId && OPEN.includes(t.status)).length >= MAX_OPEN_PER_ACCOUNT) {
        throw new AuthError(429, 'TOO_MANY', `You already have ${MAX_OPEN_PER_ACCOUNT} transfers waiting. Let some finish or cancel them.`);
      }
      // Room on the HP for the file while it waits, keeping a margin free.
      const st = await fs.promises.statfs(spoolDir);
      const waiting = store.get().filter(t => t.status === 'active' && t.stage === 'upload').reduce((a, t) => a + t.size, 0);
      if (size + waiting + FREE_MARGIN > st.bavail * st.bsize) throw new AuthError(507, 'DISK_FULL', 'The HP doesn’t have room to hold that file right now.');
      const t = { id: 'tr_' + crypto.randomBytes(9).toString('base64url'), fileName: name, size, from: from || null, to, userId,
        status: 'active', stage: 'upload', bytesDone: 0, speed: null, startedAt: now(), uploadedAt: null, deliveryStartedAt: null, finishedAt: null, error: null };
      store.save(store.get().concat(t));
      onChange(t);
      return t;
    },

    // Streams the request body to the spool. The body must be exactly the size declared at create.
    async receiveUpload(id, stream, { userId, from }) {
      const t = find(id);
      if (!t || t.userId !== userId || t.from !== (from || null)) throw NOT_FOUND();
      if (t.status !== 'active' || t.stage !== 'upload' || inFlight.has(id)) throw new AuthError(409, 'INVALID', 'This transfer isn’t waiting for its file.');
      const declared = Number(stream.headers && stream.headers['content-length']);
      if (declared !== t.size) throw new AuthError(400, 'INVALID', `Send exactly ${t.size} bytes.`);
      let bytes = 0, out;
      try {
        await new Promise((resolve, reject) => {
          let failure = null;
          const fail = e => { if (!failure) { failure = e; stream.unpipe(out); out.destroy(); } };
          inFlight.set(id, fail);
          out = fs.createWriteStream(partOf(id), { flags: 'wx' });
          stream.on('data', c => { bytes += c.length; if (bytes > t.size) fail(new AuthError(400, 'INVALID', 'More data than the size given.')); });
          stream.on('close', () => { if (stream.complete === false) fail(new AuthError(400, 'CANCELLED', 'The upload was cut off.')); });
          stream.on('error', () => fail(new AuthError(400, 'CANCELLED', 'The upload was cut off.')));
          out.on('error', e => fail(e.code === 'ENOSPC' ? new AuthError(507, 'DISK_FULL', 'The HP ran out of room.') : e));
          out.on('close', () => failure ? reject(failure) : resolve());
          stream.pipe(out);
        });
        if (bytes !== t.size) throw new AuthError(400, 'CANCELLED', 'The upload was cut off.');
        await fs.promises.rename(partOf(id), fileOf(id));
      } catch (e) {
        removeFile(id);
        if (find(id) && find(id).status === 'active') update(id, { status: 'failed', finishedAt: now(), error: e instanceof AuthError ? e.message : 'The HP couldn’t store the file.' });
        throw e instanceof AuthError ? e : new AuthError(500, 'SERVER', 'The HP couldn’t store the file.');
      } finally { inFlight.delete(id); }
      const cur = find(id);
      if (!cur || cur.status !== 'active') { removeFile(id); throw new AuthError(409, 'CANCELLED', 'The transfer was cancelled.'); }
      const ms = Math.max(1, Date.now() - Date.parse(cur.startedAt));
      log(`Transfer ${id}: ${cur.fileName} (${cur.size} bytes) is on the HP, for ${cur.to}`);
      return update(id, { status: 'queued', stage: 'waiting', uploadedAt: now(), uploadSpeed: Math.round(cur.size / ms * 1000) });
    },

    // The sender or the master. The HP's copy is deleted; a receiving agent is told by onChange.
    cancel(id, { userId, master }) {
      const t = find(id);
      if (!t || (!master && t.userId !== userId)) throw NOT_FOUND();
      if (!OPEN.includes(t.status)) throw new AuthError(409, 'INVALID', 'Only an unfinished transfer can be cancelled.');
      const out = update(id, { status: 'cancelled', finishedAt: now(), error: null });
      // An upload still arriving stops now; its half-written file goes with it.
      if (inFlight.has(id)) inFlight.get(id)(new AuthError(409, 'CANCELLED', 'The transfer was cancelled.'));
      removeFile(id);
      return out;
    },

    // ---------- the receiving device ----------
    pendingFor: deviceId => store.get().filter(t => t.to === deviceId && PENDING(t)),

    // The file, for the device it's addressed to. The first request starts the delivery leg; a later
    // one (a resumed download) carries on with it.
    async openForDelivery(id, deviceId) {
      const t = find(id);
      if (!t || t.to !== deviceId || !PENDING(t)) throw NOT_FOUND();
      let handle;
      try { handle = await fs.promises.open(fileOf(id), 'r'); }
      catch (e) { update(id, { status: 'failed', finishedAt: now(), error: 'The HP lost its copy of the file.' }); throw NOT_FOUND(); }
      const st = await handle.stat();
      if (t.status === 'queued') update(id, { status: 'active', stage: 'deliver', deliveryStartedAt: now() });
      return { handle, size: st.size, name: t.fileName, mtime: new Date(t.uploadedAt || t.startedAt) };
    },

    // The agent saved it whole: done, and the HP's copy goes.
    received(id, deviceId) {
      const t = find(id);
      if (!t || t.to !== deviceId || !PENDING(t)) throw NOT_FOUND();
      removeFile(id);
      const ms = Math.max(1, Date.now() - Date.parse(t.deliveryStartedAt || t.uploadedAt || t.startedAt));
      log(`Transfer ${id}: delivered to ${deviceId}`);
      return update(id, { status: 'done', stage: null, bytesDone: t.size, finishedAt: now(), speed: Math.round(t.size / ms * 1000) });
    },

    // The agent couldn't save it (its disk is full, say). The HP keeps its copy until it expires.
    failed(id, deviceId, reason) {
      const t = find(id);
      if (!t || t.to !== deviceId || !PENDING(t)) throw NOT_FOUND();
      const msg = typeof reason === 'string' && reason.trim() ? reason.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) : 'The receiving device couldn’t save the file.';
      return update(id, { status: 'failed', finishedAt: now(), error: msg });
    },

    // ---------- lists and housekeeping ----------
    // The master sees every transfer; anyone else the ones they sent and the ones to the device they're on.
    list({ master, userId, deviceId }) {
      return store.get().filter(t => master || t.userId === userId || (deviceId && t.to === deviceId))
        .slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },

    // A device was unpaired: what was waiting for it can never be delivered.
    dropDevice(deviceId) {
      for (const t of store.get().filter(x => x.to === deviceId && OPEN.includes(x.status))) {
        removeFile(t.id);
        update(t.id, { status: 'cancelled', finishedAt: now(), error: 'The receiving device was unpaired.' });
      }
    },

    // Files nobody collected within 14 days, and failed deliveries' copies past that age, are deleted.
    sweep(t0 = Date.now()) {
      for (const t of store.get()) {
        const age = t0 - Date.parse(t.uploadedAt || t.startedAt);
        if (age < KEEP_MS) continue;
        if (PENDING(t)) { removeFile(t.id); update(t.id, { status: 'failed', finishedAt: now(), error: 'Not collected within 14 days; the HP deleted its copy.' }); }
        else if (t.status === 'failed') removeFile(t.id);
      }
    }
  };
}

// What clients see. `stage` and the speeds are extra to the mock's shape; nothing else is.
const publicTransfer = t => t && {
  id: t.id, fileName: t.fileName, size: t.size, from: t.from, to: t.to, userId: t.userId, status: t.status, stage: t.stage || null,
  bytesDone: t.bytesDone, speed: t.speed, uploadSpeed: t.uploadSpeed || null, startedAt: t.startedAt, uploadedAt: t.uploadedAt,
  finishedAt: t.finishedAt, error: t.error
};

module.exports = { createTransfers, publicTransfer, checkFileName, KEEP_MS };
