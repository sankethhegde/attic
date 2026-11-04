// receiver.js — Phase 2, milestone 2-4 (D-05, D-07): collects files sent to this PC into the Hub Inbox.
//
// The HP tells the agent what's waiting over the hub: { type: "inbox", transfers } on every connect (the
// offline queue) and { type: "transfer", transfer } the moment something new arrives. For each one, in
// turn: download GET /api/transfers/:id/file with the device token, resuming with Range from whatever a
// dropped connection left; check the size; move it into the inbox; confirm with POST …/received. A file
// this PC can't save (disk full, no permission) is reported with POST …/failed. A cancelled one
// ({ type: "transfer-cancelled" }) is dropped, part file and all. Core Node only.
'use strict';
const fs = require('fs');
const http = require('http');
const inbox = require('./inbox.js');

const HEADER = 'X-Attic-Device';
const RETRIES = [2000, 5000, 15000];        // a dropped download is resumed after these waits
const LOCAL = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EROFS', 'EDQUOT', 'ENAMETOOLONG']); // this PC can't save it

// opts: { server: { address, port }, token, dir, onEvent({ type: 'receiving' | 'received' | 'failed' | 'cancelled', transfer, path?, error? }) }
function createReceiver({ server, token, dir, onEvent = () => {}, retries = RETRIES }) {
  const base = `http://${server.address}:${server.port}`;
  const queue = [];               // transfers waiting their turn
  const known = new Set();        // ids queued, in progress or finished, so a repeat "inbox" adds nothing twice
  let current = null;             // { t, req, cancelled }
  let stopped = false, running = false;

  function call(method, pathname, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request(base + pathname, { method, headers: Object.assign({ [HEADER]: token },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }, res => {
        let s = '';
        res.on('data', c => { s += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* empty */ } resolve({ status: res.statusCode, body: j }); });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  // Appends the rest of the file to `part` (from byte `have`). Rejects with .status for an HTTP refusal.
  function download(t, part, have) {
    return new Promise((resolve, reject) => {
      const req = http.get(`${base}/api/transfers/${encodeURIComponent(t.id)}/file`,
        { headers: Object.assign({ [HEADER]: token }, have ? { Range: `bytes=${have}-` } : {}) }, res => {
          if (res.statusCode !== 200 && res.statusCode !== 206) {
            let s = '';
            res.on('data', c => { s += c; });
            res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { /* not JSON */ }
              const err = new Error((j && j.message) || `The HP answered ${res.statusCode}.`); err.status = res.statusCode; reject(err); });
            return;
          }
          // 200 means the HP is sending it all again (no resume): start the part file over.
          const out = fs.createWriteStream(part, { flags: res.statusCode === 206 ? 'a' : 'w' });
          res.pipe(out);
          res.on('error', e => out.destroy(e));
          res.on('aborted', () => out.destroy(new Error('The connection to the HP dropped.')));
          out.on('error', reject);
          out.on('finish', resolve);
        });
      req.on('error', reject);
      current.req = req;
    });
  }

  async function fetchOne(t) {
    const part = await inbox.partialPath(dir, t.id);
    let have = 0;
    try { have = (await fs.promises.stat(part)).size; } catch (e) { /* nothing yet */ }
    if (have > t.size) { await fs.promises.rm(part, { force: true }); have = 0; }
    if (have < t.size || t.size === 0) await download(t, part, have);
    const got = (await fs.promises.stat(part)).size;
    if (got !== t.size) throw Object.assign(new Error(`Received ${got} of ${t.size} bytes.`), { retry: true });
    const saved = await inbox.place(dir, t.fileName, part);
    // Confirm; a dropped confirmation is retried, and the file is already safe in the inbox.
    for (let i = 0; ; i++) {
      try { const r = await call('POST', `/api/transfers/${encodeURIComponent(t.id)}/received`, {}); if (r.status < 500) break; }
      catch (e) { /* the HP blinked */ }
      if (i >= retries.length || stopped) break;
      await new Promise(r => setTimeout(r, retries[i]));
    }
    return saved;
  }

  async function run() {
    if (running) return;
    running = true;
    while (!stopped && queue.length) {
      const t = queue.shift();
      current = { t, req: null, cancelled: false };
      onEvent({ type: 'receiving', transfer: t });
      for (let attempt = 0; ; attempt++) {
        try {
          const saved = await fetchOne(t);
          onEvent({ type: 'received', transfer: t, path: saved });
          break;
        } catch (e) {
          if (current.cancelled) { await dropPart(t); break; }
          if (stopped) break; // the part file stays, to resume next time
          if (e.status === 404 || e.status === 409 || e.status === 410) { await dropPart(t); onEvent({ type: 'cancelled', transfer: t }); break; } // cancelled, expired or not ours
          if (LOCAL.has(e.code)) {
            await dropPart(t);
            const error = e.code === 'ENOSPC' ? 'This PC’s disk is full.' : `This PC couldn’t save it (${e.code}).`;
            await call('POST', `/api/transfers/${encodeURIComponent(t.id)}/failed`, { error }).catch(() => {});
            onEvent({ type: 'failed', transfer: t, error });
            break;
          }
          // The connection dropped: resume from the part file after a wait. Past the last wait, leave it;
          // the HP lists it again when the agent next connects.
          if (attempt >= retries.length) { known.delete(t.id); onEvent({ type: 'failed', transfer: t, error: e.message, willRetry: true }); break; }
          await new Promise(r => setTimeout(r, retries[attempt]));
          if (current.cancelled) { await dropPart(t); break; }
          if (stopped) break;
        }
      }
      current = null;
    }
    running = false;
  }

  async function dropPart(t) { await fs.promises.rm(await inbox.partialPath(dir, t.id), { force: true }).catch(() => {}); }

  return {
    // Transfers the HP says are waiting for this PC. Ones already known are skipped.
    add(list) {
      for (const t of list || []) {
        if (!t || !t.id || known.has(t.id) || !Number.isSafeInteger(t.size)) continue;
        known.add(t.id);
        queue.push(t);
      }
      run();
    },
    cancel(id) {
      const i = queue.findIndex(t => t.id === id);
      if (i >= 0) { const [t] = queue.splice(i, 1); dropPart(t); onEvent({ type: 'cancelled', transfer: t }); }
      if (current && current.t.id === id) {
        current.cancelled = true;
        if (current.req) current.req.destroy(new Error('Cancelled'));
        onEvent({ type: 'cancelled', transfer: current.t });
      }
    },
    stop() {
      stopped = true;
      queue.length = 0;
      if (current && current.req) current.req.destroy(new Error('Stopped')); // the part file stays, to resume
    },
    get busy() { return running; }
  };
}

module.exports = { createReceiver };
