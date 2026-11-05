// transfers.js — Phase 2, milestones 2-4 (D-05, D-07) and 2-5 (D-06, D-08): send a file to another device
// through the HP, watch it go, and keep the history.
//
// Every client talks only to the HP, so a file from the Acer to the ROG Ally goes in two legs:
//   1. upload: the sender streams it to the HP, which spools it to disk (data/transfers/<id>.bin).
//   2. delivery: the receiving device's agent downloads it into its Hub Inbox and confirms, and the
//      HP deletes its copy. A device that's offline gets it when it next connects (the offline queue).
// Records are rows in the database (db.js), kept as history after they finish, so a queued file
// survives an HP restart. An upload cut off by a restart fails; a delivery cut off goes back to the
// queue (and the download can resume by range).
//
// Statuses use the Transfers view's words: active (stage "upload" or "deliver"), queued (on the HP,
// waiting for the device), done, failed, cancelled. While a leg is moving, its bytes and speed are
// reported through onProgress about twice a second (2-5); they're written to the database only when
// the leg ends. Core Node only.
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const { AuthError } = require('./auth');
const { segmentOk } = require('./safe-path');

const MAX_SIZE = 20e9;                    // same as a Files upload
const KEEP_MS = 14 * 864e5;               // an undelivered file is kept this long
const HISTORY_MS = 365 * 864e5;           // finished transfers stay in history this long…
const HISTORY_MAX = 10000;                // …up to this many
const FREE_MARGIN = 1e9;                  // the spool's drive keeps this much free
const MAX_OPEN_PER_ACCOUNT = 50;          // unfinished transfers one account may have
const PROGRESS_MS = 500;                  // how often a moving transfer reports its progress
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

// ---------- rows <-> records ----------
const COLS = { id: 'id', fileName: 'file_name', size: 'size', from: 'from_id', fromName: 'from_name', to: 'to_id', toName: 'to_name',
  userId: 'user_id', userName: 'user_name', status: 'status', stage: 'stage', bytesDone: 'bytes_done', speed: 'speed', uploadSpeed: 'upload_speed',
  startedAt: 'started_at', uploadedAt: 'uploaded_at', deliveryStartedAt: 'delivery_started_at', finishedAt: 'finished_at', error: 'error', attempts: 'attempts' };
const fromRow = r => { if (!r) return null; const t = {}; for (const [k, c] of Object.entries(COLS)) t[k] = r[c] === undefined ? null : r[c]; return t; };

function createTransfers({ db, dataDir, spoolDir, log = () => {}, onChange = () => {}, onProgress = () => {} }) {
  fs.mkdirSync(spoolDir, { recursive: true });
  const fileOf = id => path.join(spoolDir, id + '.bin');
  const partOf = id => path.join(spoolDir, id + '.part');
  const chunkedOf = id => path.join(spoolDir, id + '.chunked'); // a resumable upload's bytes (4-2)
  const now = () => new Date().toISOString();
  const removeFile = id => { for (const p of [fileOf(id), partOf(id), chunkedOf(id)]) fs.promises.unlink(p).catch(() => {}); };

  const q = {
    get: db.prepare('SELECT * FROM transfers WHERE id = ?'),
    insert: db.prepare(`INSERT INTO transfers (${Object.values(COLS).join(', ')}) VALUES (${Object.values(COLS).map(() => '?').join(', ')})`),
    openFor: db.prepare("SELECT * FROM transfers WHERE to_id = ? AND (status = 'queued' OR (status = 'active' AND stage = 'deliver')) ORDER BY started_at"),
    openCount: db.prepare("SELECT COUNT(*) AS n FROM transfers WHERE user_id = ? AND status IN ('active', 'queued')"),
    uploading: db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM transfers WHERE status = 'active' AND stage = 'upload'"),
    openAll: db.prepare("SELECT * FROM transfers WHERE status IN ('active', 'queued')")
  };
  const find = id => fromRow(q.get.get(id));
  function update(id, patch) {
    const keys = Object.keys(patch);
    db.prepare(`UPDATE transfers SET ${keys.map(k => COLS[k] + ' = ?').join(', ')} WHERE id = ?`).run(...keys.map(k => patch[k]), id);
    const t = find(id);
    onChange(t);
    return t;
  }

  // ---------- from 2-4's JSON file, once ----------
  const legacy = path.join(dataDir, 'transfers.json');
  if (fs.existsSync(legacy)) {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(legacy, 'utf8')); } catch (e) { /* unreadable: nothing to bring over */ }
    db.exec('BEGIN');
    try {
      for (const t of list) if (!q.get.get(t.id)) q.insert.run(...Object.keys(COLS).map(k => t[k] === undefined ? (k === 'attempts' ? 1 : k === 'bytesDone' ? 0 : null) : t[k]));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    fs.renameSync(legacy, legacy + '.imported');
    log(`Moved ${list.length} transfer${list.length === 1 ? '' : 's'} from transfers.json into the database`);
  }

  // ---------- after a restart ----------
  // A one-request upload that was in flight is lost; a resumable one (4-2) carries on where it was. A
  // delivery in flight goes back to waiting. Spool files with no open transfer (a crash between steps)
  // are deleted; a failed delivery's copy is kept for Retry.
  const resumable = new Set(db.prepare("SELECT id FROM transfers WHERE status = 'active' AND stage = 'upload'").all().map(r => r.id).filter(id => fs.existsSync(chunkedOf(id))));
  for (const id of db.prepare("SELECT id FROM transfers WHERE status = 'active' AND stage = 'upload'").all().map(r => r.id)) {
    if (!resumable.has(id)) db.prepare("UPDATE transfers SET status = 'failed', finished_at = ?, error = 'The HP restarted during the upload. Retry to send it again.' WHERE id = ?").run(now(), id);
  }
  db.prepare("UPDATE transfers SET status = 'queued', stage = 'waiting' WHERE status = 'active' AND stage = 'deliver'").run();
  {
    const keep = new Set(db.prepare("SELECT id FROM transfers WHERE status = 'queued' OR (status = 'failed' AND uploaded_at IS NOT NULL)").all().map(r => r.id + '.bin')
      .concat([...resumable].map(id => id + '.chunked')));
    for (const f of fs.readdirSync(spoolDir)) if (!keep.has(f)) fs.promises.unlink(path.join(spoolDir, f)).catch(() => {});
  }

  // ---------- live progress (2-5) ----------
  // id -> { stage, bytes, speed, at, lastBytes, lastAt }. Speed is bytes per second, smoothed.
  const live = new Map();
  function tick(id, stage, bytes, force) {
    const t0 = Date.now();
    let p = live.get(id);
    if (!p || p.stage !== stage) { p = { stage, bytes, speed: null, at: 0, lastBytes: bytes, lastAt: t0 }; live.set(id, p); }
    p.bytes = bytes;
    if (!force && t0 - p.at < PROGRESS_MS) return;
    const dt = (t0 - p.lastAt) / 1000;
    if (dt > 0.05) {
      const rate = Math.max(0, (bytes - p.lastBytes) / dt);
      p.speed = Math.round(p.speed === null ? rate : p.speed * 0.5 + rate * 0.5);
      p.lastBytes = bytes; p.lastAt = t0;
    }
    p.at = t0;
    const t = find(id);
    if (t) onProgress(t, { stage, bytesDone: bytes, speed: p.speed });
  }
  const withLive = t => {
    const p = t && t.status === 'active' && live.get(t.id);
    return p && p.stage === t.stage ? Object.assign({}, t, { bytesDone: p.bytes, speed: p.speed }) : t;
  };

  const inFlight = new Map(); // id -> stop(error), for uploads arriving now

  return {
    MAX_SIZE,
    get: id => withLive(find(id)),

    // ---------- the sender ----------
    // isDevice(id) gives the receiving device ({ name }) if it's a paired client, else null.
    async create({ fileName, size, to } = {}, { userId, userName, from, fromName, isDevice }) {
      const name = checkFileName(fileName);
      if (!Number.isSafeInteger(size) || size < 0) throw new AuthError(400, 'INVALID', 'Give the file’s size in bytes.');
      if (size > MAX_SIZE) throw new AuthError(413, 'TOO_LARGE', 'Too large. The limit is 20 GB per file.');
      const dest = typeof to === 'string' ? isDevice(to) : null;
      if (!dest) throw new AuthError(400, 'INVALID', 'Choose a paired device to send to.');
      if (to === from) throw new AuthError(400, 'INVALID', 'That’s this device. Choose another one.');
      if (q.openCount.get(userId).n >= MAX_OPEN_PER_ACCOUNT) {
        throw new AuthError(429, 'TOO_MANY', `You already have ${MAX_OPEN_PER_ACCOUNT} transfers waiting. Let some finish or cancel them.`);
      }
      await checkRoom(size);
      const t = { id: 'tr_' + crypto.randomBytes(9).toString('base64url'), fileName: name, size, from: from || null, fromName: fromName || null,
        to, toName: dest.name || null, userId, userName: userName || null, status: 'active', stage: 'upload', bytesDone: 0, speed: null, uploadSpeed: null,
        startedAt: now(), uploadedAt: null, deliveryStartedAt: null, finishedAt: null, error: null, attempts: 1 };
      q.insert.run(...Object.keys(COLS).map(k => t[k]));
      onChange(t);
      return t;
    },

    // Streams the request body to the spool. The body must be exactly the size declared at create.
    async receiveUpload(id, stream, { userId, from }) {
      const t = find(id);
      if (!t || t.userId !== userId || t.from !== (from || null)) throw NOT_FOUND();
      if (t.status !== 'active' || t.stage !== 'upload' || inFlight.has(id)) throw new AuthError(409, 'INVALID', 'This transfer isn’t waiting for its file.');
      if (fs.existsSync(chunkedOf(id))) throw new AuthError(409, 'INVALID', 'This transfer’s file is arriving as a resumable upload. Carry that on, or cancel it first.');
      const declared = Number(stream.headers && stream.headers['content-length']);
      if (declared !== t.size) throw new AuthError(400, 'INVALID', `Send exactly ${t.size} bytes.`);
      let bytes = 0, out;
      const started = Date.now();
      try {
        await new Promise((resolve, reject) => {
          let failure = null;
          const fail = e => { if (!failure) { failure = e; stream.unpipe(out); out.destroy(); } };
          inFlight.set(id, fail);
          out = fs.createWriteStream(partOf(id), { flags: 'wx' });
          stream.on('data', c => {
            bytes += c.length;
            if (bytes > t.size) fail(new AuthError(400, 'INVALID', 'More data than the size given.'));
            else tick(id, 'upload', bytes);
          });
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
        live.delete(id);
        const cur = find(id);
        if (cur && cur.status === 'active') update(id, { status: 'failed', bytesDone: bytes, finishedAt: now(), error: e instanceof AuthError ? e.message : 'The HP couldn’t store the file.' });
        throw e instanceof AuthError ? e : new AuthError(500, 'SERVER', 'The HP couldn’t store the file.');
      } finally { inFlight.delete(id); }
      live.delete(id);
      const cur = find(id);
      if (!cur || cur.status !== 'active') { removeFile(id); throw new AuthError(409, 'CANCELLED', 'The transfer was cancelled.'); }
      const ms = Math.max(1, Date.now() - started);
      log(`Transfer ${id}: ${cur.fileName} (${cur.size} bytes) is on the HP, for ${cur.toName || cur.to}`);
      return update(id, { status: 'queued', stage: 'waiting', bytesDone: 0, uploadedAt: now(), uploadSpeed: Math.round(cur.size / ms * 1000) });
    },

    // ---------- resumable uploads (4-2, uploads.js) ----------
    // Where a resumable upload for this transfer puts its bytes; only the sender, on the device it sent
    // from, while the transfer waits for its file.
    beginChunked(id, { userId, from }) {
      const t = find(id);
      if (!t || t.userId !== userId || t.from !== (from || null)) throw NOT_FOUND();
      if (t.status !== 'active' || t.stage !== 'upload' || inFlight.has(id)) throw new AuthError(409, 'INVALID', 'This transfer isn’t waiting for its file.');
      if (fs.existsSync(chunkedOf(id))) throw new AuthError(409, 'BUSY', 'This transfer already has a resumable upload. Ask it where it got to (GET /api/uploads).');
      return { path: chunkedOf(id), size: t.size, name: t.fileName };
    },
    progress(id, bytes) { tick(id, 'upload', bytes); },
    // The last piece arrived: the file is on the HP, as after a one-request upload.
    async finishChunked(id, bytes) {
      const cur = find(id);
      if (!cur || cur.status !== 'active' || cur.stage !== 'upload') { removeFile(id); throw new AuthError(409, 'CANCELLED', 'The transfer was cancelled.'); }
      if (bytes !== cur.size) throw new AuthError(400, 'INVALID', 'The file isn’t complete.');
      await fs.promises.rename(chunkedOf(id), fileOf(id));
      live.delete(id);
      const ms = Math.max(1, Date.now() - Date.parse(cur.startedAt));
      log(`Transfer ${id}: ${cur.fileName} (${cur.size} bytes) is on the HP, for ${cur.toName || cur.to}`);
      return update(id, { status: 'queued', stage: 'waiting', bytesDone: 0, uploadedAt: now(), uploadSpeed: Math.round(cur.size / ms * 1000) });
    },
    // A resumable upload was abandoned (dropped after a day idle): the transfer fails, for Retry.
    failChunked(id, reason) {
      const t = find(id);
      fs.promises.unlink(chunkedOf(id)).catch(() => {});
      live.delete(id);
      if (t && t.status === 'active' && t.stage === 'upload') update(id, { status: 'failed', finishedAt: now(), error: reason });
    },

    // The sender or the master. The HP's copy is deleted; a receiving agent is told by onChange.
    cancel(id, { userId, master }) {
      const t = find(id);
      if (!t || (!master && t.userId !== userId)) throw NOT_FOUND();
      if (!OPEN.includes(t.status)) throw new AuthError(409, 'INVALID', 'Only an unfinished transfer can be cancelled.');
      const p = live.get(id);
      const out = update(id, { status: 'cancelled', finishedAt: now(), error: null, bytesDone: p ? p.bytes : t.bytesDone });
      live.delete(id);
      // An upload still arriving stops now; its half-written file goes with it.
      if (inFlight.has(id)) inFlight.get(id)(new AuthError(409, 'CANCELLED', 'The transfer was cancelled.'));
      removeFile(id);
      return out;
    },

    // Retry (2-5), the sender or the master, for a failed or cancelled transfer. If the HP still holds
    // the file (a delivery failed), it goes back in the queue. Otherwise it waits for the sender to
    // upload it again (PUT …/file), on the device it was sent from.
    async retry(id, { userId, master }) {
      const t = find(id);
      if (!t || (!master && t.userId !== userId)) throw NOT_FOUND();
      if (t.status !== 'failed' && t.status !== 'cancelled') throw new AuthError(409, 'INVALID', 'Only a failed or cancelled transfer can be retried.');
      if (q.openCount.get(t.userId).n >= MAX_OPEN_PER_ACCOUNT) throw new AuthError(429, 'TOO_MANY', `${MAX_OPEN_PER_ACCOUNT} transfers are already waiting.`);
      const base = { bytesDone: 0, speed: null, finishedAt: null, error: null, deliveryStartedAt: null, attempts: (t.attempts || 1) + 1 };
      if (t.status === 'failed' && t.uploadedAt && fs.existsSync(fileOf(id))) return update(id, Object.assign(base, { status: 'queued', stage: 'waiting' }));
      await checkRoom(t.size);
      return update(id, Object.assign(base, { status: 'active', stage: 'upload', uploadedAt: null, uploadSpeed: null, startedAt: now() }));
    },

    // ---------- the receiving device ----------
    pendingFor: deviceId => q.openFor.all(deviceId).map(fromRow).map(withLive),

    // The file, for the device it's addressed to. The first request starts the delivery leg; a later
    // one (a resumed download) carries on with it. track(start) counts what each request sends.
    async openForDelivery(id, deviceId) {
      const t = find(id);
      if (!t || t.to !== deviceId || !PENDING(t)) throw NOT_FOUND();
      let handle;
      try { handle = await fs.promises.open(fileOf(id), 'r'); }
      catch (e) { update(id, { status: 'failed', finishedAt: now(), error: 'The HP lost its copy of the file. Retry sends it again from the start.' }); throw NOT_FOUND(); }
      const st = await handle.stat();
      if (t.status === 'queued') update(id, { status: 'active', stage: 'deliver', deliveryStartedAt: now() });
      const track = start => {
        let sent = start;
        return n => { sent += n; tick(id, 'deliver', sent, sent >= t.size); };
      };
      return { handle, size: st.size, name: t.fileName, mtime: new Date(t.uploadedAt || t.startedAt), track };
    },

    // The agent saved it whole: done, and the HP's copy goes.
    received(id, deviceId) {
      const t = find(id);
      if (!t || t.to !== deviceId || !PENDING(t)) throw NOT_FOUND();
      removeFile(id);
      live.delete(id);
      const ms = Math.max(1, Date.now() - Date.parse(t.deliveryStartedAt || t.uploadedAt || t.startedAt));
      log(`Transfer ${id}: delivered to ${t.toName || deviceId}`);
      return update(id, { status: 'done', stage: null, bytesDone: t.size, finishedAt: now(), speed: Math.round(t.size / ms * 1000) });
    },

    // The agent couldn't save it (its disk is full, say). The HP keeps its copy, for Retry, until it expires.
    failed(id, deviceId, reason) {
      const t = find(id);
      if (!t || t.to !== deviceId || !PENDING(t)) throw NOT_FOUND();
      const msg = typeof reason === 'string' && reason.trim() ? reason.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200) : 'The receiving device couldn’t save the file.';
      const p = live.get(id);
      live.delete(id);
      return update(id, { status: 'failed', finishedAt: now(), error: msg, bytesDone: p ? p.bytes : 0 });
    },

    // ---------- lists and history ----------
    // Who may see a transfer: the master every one; anyone else the ones they sent and the ones to the
    // device they're on. The list is the Transfers view's: newest first, at most `limit`.
    list(who, { limit = 200 } = {}) {
      const { where, args } = visible(who);
      return db.prepare(`SELECT * FROM transfers WHERE ${where} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...args, clampLimit(limit, 500)).map(fromRow).map(withLive);
    },

    // History (D-08): finished transfers with sender, receiver, size and times, newest first, a page at
    // a time. `before` is the `next` of the previous page. Filters: device (either end), q (part of
    // the file name), status (done, failed or cancelled).
    history(who, { limit = 50, before, device, q: text, status } = {}) {
      const { where, args } = visible(who);
      const conds = [where, "status IN ('done', 'failed', 'cancelled')"];
      if (['done', 'failed', 'cancelled'].includes(status)) { conds.push('status = ?'); args.push(status); }
      if (typeof device === 'string' && device) { conds.push('(from_id = ? OR to_id = ?)'); args.push(device, device); }
      if (typeof text === 'string' && text.trim()) { conds.push("file_name LIKE ? ESCAPE '\\'"); args.push('%' + text.trim().slice(0, 100).replace(/[\\%_]/g, c => '\\' + c) + '%'); }
      if (typeof before === 'string' && before) {
        const [at, id] = before.split('|');
        conds.push('(started_at < ? OR (started_at = ? AND id < ?))'); args.push(at, at, id || '');
      }
      const n = clampLimit(limit, 200);
      const rows = db.prepare(`SELECT * FROM transfers WHERE ${conds.join(' AND ')} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...args, n + 1).map(fromRow);
      const items = rows.slice(0, n);
      return { items, next: rows.length > n ? `${items[n - 1].startedAt}|${items[n - 1].id}` : null };
    },

    // A device was unpaired: what was waiting for it can never be delivered.
    dropDevice(deviceId) {
      for (const t of q.openAll.all().map(fromRow).filter(x => x.to === deviceId)) {
        removeFile(t.id);
        live.delete(t.id);
        update(t.id, { status: 'cancelled', finishedAt: now(), error: 'The receiving device was unpaired.' });
      }
    },

    // Files nobody collected within 14 days, and failed deliveries' copies past that age, are deleted.
    // History older than a year, or past the newest 10,000, is dropped.
    sweep(t0 = Date.now()) {
      for (const t of q.openAll.all().map(fromRow).concat(db.prepare("SELECT * FROM transfers WHERE status = 'failed' AND uploaded_at IS NOT NULL").all().map(fromRow))) {
        if (t0 - Date.parse(t.uploadedAt || t.startedAt) < KEEP_MS) continue;
        if (PENDING(t)) { removeFile(t.id); update(t.id, { status: 'failed', finishedAt: now(), error: 'Not collected within 14 days; the HP deleted its copy.' }); }
        else if (t.status === 'failed') { removeFile(t.id); db.prepare('UPDATE transfers SET uploaded_at = NULL WHERE id = ?').run(t.id); }
      }
      const cutoff = new Date(t0 - HISTORY_MS).toISOString();
      db.prepare("DELETE FROM transfers WHERE status IN ('done', 'failed', 'cancelled') AND finished_at < ?").run(cutoff);
      db.prepare(`DELETE FROM transfers WHERE status IN ('done', 'failed', 'cancelled') AND id NOT IN
        (SELECT id FROM transfers WHERE status IN ('done', 'failed', 'cancelled') ORDER BY started_at DESC LIMIT ${HISTORY_MAX})`).run();
    }
  };

  function visible({ master, userId, deviceId }) {
    if (master) return { where: '1 = 1', args: [] };
    return deviceId ? { where: '(user_id = ? OR to_id = ?)', args: [userId, deviceId] } : { where: 'user_id = ?', args: [userId] };
  }
  async function checkRoom(size) {
    // Room on the HP for the file while it waits, keeping a margin free.
    const st = await fs.promises.statfs(spoolDir);
    if (size + q.uploading.get().n + FREE_MARGIN > st.bavail * st.bsize) throw new AuthError(507, 'DISK_FULL', 'The HP doesn’t have room to hold that file right now.');
  }
}
const clampLimit = (n, max) => Math.max(1, Math.min(max, Number.isFinite(+n) ? Math.floor(+n) : max));

// What clients see. Everything in the mock's shape, plus stage, the names, uploadSpeed and attempts.
const publicTransfer = t => t && {
  id: t.id, fileName: t.fileName, size: t.size, from: t.from, fromName: t.fromName, to: t.to, toName: t.toName, userId: t.userId, userName: t.userName,
  status: t.status, stage: t.stage || null, bytesDone: t.bytesDone, speed: t.speed, uploadSpeed: t.uploadSpeed || null,
  startedAt: t.startedAt, uploadedAt: t.uploadedAt, finishedAt: t.finishedAt, error: t.error, attempts: t.attempts || 1
};

module.exports = { createTransfers, publicTransfer, checkFileName, KEEP_MS, HISTORY_MS };
