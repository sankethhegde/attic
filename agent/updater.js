// updater.js — Phase 3, milestone 3-5 (T-10): update the desktop tool from the HP, no internet needed.
//
// The HP holds the newest installer (server/updates.js, its README's "Updates"). It tells each agent the
// latest release when it connects and when a new one is published ({ type: "update", latest }), and
// answers GET /api/updates/latest?current=<version>. This file:
//   1. compares the release with this tool's version (as numbers: 0.10.0 is after 0.9.0);
//   2. downloads a newer installer into the tool's own folder (updates\), resumable with Range from a
//      .part file, then checks its size and SHA-512 against what the HP announced, and keeps nothing
//      that doesn't match;
//   3. says it's ready; the tool then offers "Restart to update". Installing runs the installer
//      silently (/S) and starts Attic Hub again when it's done (--force-run), the way electron-builder's
//      own updater does.
// The download waits while `canDownload()` says no (low-resource mode, 3-4, while a game runs).
// Core Node only, plus fetch.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const NAME = /^Attic-Hub-Setup-\d{1,4}\.\d{1,4}\.\d{1,4}\.exe$/;
const INSTALL_ARGS = ['/S', '--updated', '--force-run'];

function cmp(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}
const isRelease = r => !!r && typeof r === 'object' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(r.version || '') && NAME.test(r.fileName || '')
  && Number.isSafeInteger(r.size) && r.size > 0 && typeof r.sha512 === 'string' && r.sha512.length > 40;

function sha512Of(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('base64'))).on('error', reject);
  });
}

// opts:
//   current: this tool's version
//   dir: where installers are downloaded (the tool's user-data updates\ folder)
//   server(): { base: 'http://<HP>:8080/', headers: {…} } or null when not connected
//   canDownload(): false to hold the download for now (checked again by retry())
//   onState(state): every change
// state: { status, current, latest, done, error }
//   status: 'idle' | 'checking' | 'current' (nothing newer, or nothing published) | 'available' |
//           'downloading' | 'waiting' (held by canDownload) | 'ready' | 'error'
function createUpdater({ current, dir, server, canDownload = () => true, onState = () => {} }) {
  let state = { status: 'idle', current, latest: null, done: 0, error: null, checkedAt: null };
  let job = null; // the download in progress: { version, req }
  const set = patch => { state = Object.assign({}, state, patch); onState(state); return state; };
  const target = r => path.join(dir, r.fileName);

  // A release from the HP (its hub message, or a check). Newer → download it; otherwise nothing to do.
  async function offer(latest) {
    if (!isRelease(latest) || cmp(latest.version, current) <= 0) {
      if (job) cancel();
      return set({ status: 'current', latest: isRelease(latest) ? latest : null, error: null, done: 0, checkedAt: new Date().toISOString() });
    }
    if (state.latest && state.latest.version === latest.version && ['downloading', 'ready'].includes(state.status)) return state;
    if (job && job.version !== latest.version) cancel();
    set({ latest, error: null, checkedAt: new Date().toISOString() });
    // Already downloaded (an earlier run)? Check it rather than fetching it again.
    if (fs.existsSync(target(latest)) && await verify(latest)) return set({ status: 'ready', done: latest.size });
    download(); // in the background: the answer (and Check now) doesn't wait for it
    return state;
  }

  async function check() {
    const s = server();
    if (!s) return set({ status: 'error', error: 'Attic Hub isn’t connected to the HP.' });
    set({ status: state.status === 'ready' ? 'ready' : 'checking', error: null });
    try {
      const r = await fetch(new URL(`api/updates/latest?current=${encodeURIComponent(current)}`, s.base), { headers: s.headers, signal: AbortSignal.timeout(8000) });
      if (r.status === 404) return offer(null);
      if (!r.ok) throw new Error(`The HP answered ${r.status}.`);
      return offer(await r.json());
    } catch (err) { return set({ status: 'error', error: err.name === 'TimeoutError' ? 'The HP didn’t answer.' : err.message }); }
  }

  async function verify(r) {
    try {
      const f = target(r);
      if (fs.statSync(f).size !== r.size) return false;
      return (await sha512Of(f)) === r.sha512;
    } catch (e) { return false; }
  }

  async function download() {
    const r = state.latest, s = server();
    if (!r) return state;
    if (job && job.version === r.version) return state;
    if (!canDownload()) return set({ status: 'waiting' });
    if (!s) return set({ status: 'available' });
    fs.mkdirSync(dir, { recursive: true });
    const part = target(r) + '.part';
    let have = 0;
    try { have = fs.statSync(part).size; } catch (e) { /* new */ }
    if (have > r.size) { fs.rmSync(part, { force: true }); have = 0; }
    set({ status: 'downloading', done: have, error: null });
    const me = job = { version: r.version, req: null };
    try {
      if (have < r.size) {
        await new Promise((resolve, reject) => {
          const headers = Object.assign({}, s.headers, have ? { Range: `bytes=${have}-` } : {});
          const req = me.req = http.get(new URL(r.url || `api/updates/files/${encodeURIComponent(r.fileName)}`, s.base), { headers }, res => {
            if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return reject(new Error(`The HP answered ${res.statusCode}.`)); }
            if (res.statusCode === 200) have = 0; // the whole file again
            const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
            let last = 0;
            res.on('data', d => { have += d.length; if (Date.now() - last > 250) { last = Date.now(); set({ done: have }); } });
            res.pipe(out);
            out.on('finish', resolve);
            out.on('error', reject);
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('The download was cut off.')));
          });
          req.on('error', reject);
        });
      }
      if (job !== me) return state;
      fs.renameSync(part, target(r));
      if (!(await verify(r))) {
        fs.rmSync(target(r), { force: true });
        throw new Error('The installer didn’t arrive intact (its SHA-512 doesn’t match the HP’s), so it was deleted. Check again to download it afresh.');
      }
      // Older installers aren't needed any more.
      for (const f of fs.readdirSync(dir)) if (/^Attic-Hub-Setup-.*\.exe(\.part)?$/.test(f) && f !== r.fileName) fs.rmSync(path.join(dir, f), { force: true });
      return set({ status: 'ready', done: r.size });
    } catch (err) {
      if (job !== me) return state;
      return set({ status: 'error', error: err.message });
    } finally { if (job === me) job = null; }
  }

  function cancel() {
    if (job && job.req) { try { job.req.destroy(); } catch (e) { /* gone */ } }
    job = null;
  }

  return {
    get state() { return state; },
    offer, check, download, cancel,
    // A held download goes ahead once it may (low-resource mode ended), or after a failure.
    retry() { if (state.latest && ['waiting', 'error', 'available'].includes(state.status)) return download(); return Promise.resolve(state); },
    // The installer to run, checked once more, or an error message.
    async installer() {
      if (state.status !== 'ready' || !state.latest) return { error: 'No update is ready to install.' };
      if (!(await verify(state.latest))) { set({ status: 'error', error: 'The downloaded installer has changed on disk. Check again.' }); return { error: state.error }; }
      return { file: target(state.latest), args: INSTALL_ARGS.slice(), version: state.latest.version };
    }
  };
}

module.exports = { createUpdater, cmp, isRelease, INSTALL_ARGS };
