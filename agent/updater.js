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
// Since 0.12.1, like PixHaven: the newest PUBLISHED release on GitHub (github.com/sankethhegde/attic/releases)
// comes first. A version tag makes GitHub build the installer into a draft release; pressing Publish there
// is all it takes, and every PC finds it. The HP's copy stays the fallback for a PC without internet.
// Core Node only, plus fetch.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const NAME = /^Attic-Hub-Setup-\d{1,4}\.\d{1,4}\.\d{1,4}\.exe$/;
const INSTALL_ARGS = ['/S', '--updated', '--force-run'];

function cmp(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}
const isRelease = r => !!r && typeof r === 'object' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(r.version || '') && NAME.test(r.fileName || '')
  && Number.isSafeInteger(r.size) && r.size > 0 && typeof r.sha512 === 'string' && r.sha512.length > 40;

// GET a URL, following up to 5 redirects; headers meant for the first host (the HP's device token) are
// dropped when a redirect leads elsewhere. → { req (of the first request), promise of the response }
function get(url, headers = {}, onReq = () => {}) {
  return new Promise((resolve, reject) => {
    const go = (u, h, left) => {
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(u, { headers: h }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && left > 0) {
          res.resume();
          const next = new URL(res.headers.location, u);
          const keep = next.host === u.host ? h : Object.fromEntries(Object.entries(h).filter(([k]) => /^(range|user-agent|accept)$/i.test(k)));
          return go(next, keep, left - 1);
        }
        resolve(res);
      });
      onReq(req);
      req.on('error', reject);
    };
    go(new URL(url), headers, 5);
  });
}

// The newest published release on GitHub, in the shape the HP gives: its installer and the SHA-512 from the
// latest.yml electron-builder publishes beside it. null when nothing is published (or no installer in it).
const UA = { 'User-Agent': 'Attic-Hub-updater', Accept: 'application/vnd.github+json' };
async function githubLatest({ api = 'https://api.github.com', owner, repo }) {
  const r = await fetch(`${api}/repos/${owner}/${repo}/releases/latest`, { headers: UA, signal: AbortSignal.timeout(10000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub answered ${r.status}.`);
  const rel = await r.json();
  const exe = (rel.assets || []).find(a => NAME.test(a.name)), yml = (rel.assets || []).find(a => a.name === 'latest.yml');
  if (!exe || !yml) return null;
  const res = await get(yml.browser_download_url, { 'User-Agent': UA['User-Agent'] });
  const text = await new Promise((resolve, reject) => { let t = ''; res.setEncoding('utf8'); res.on('data', d => { t += d; }); res.on('end', () => resolve(t)); res.on('error', reject); });
  if (res.statusCode !== 200) throw new Error(`GitHub answered ${res.statusCode} for latest.yml.`);
  const sha512 = (/^sha512:\s*(\S+)/m.exec(text) || [])[1];
  const version = String(rel.tag_name || '').replace(/^v/, '');
  return { version, fileName: exe.name, size: exe.size, sha512, url: exe.browser_download_url, notes: (rel.body || '').trim().slice(0, 500),
    releaseDate: rel.published_at, source: 'github' };
}

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
//   github: { owner, repo, api? } to check GitHub's releases first (null: the HP only)
function createUpdater({ current, dir, server, github = null, canDownload = () => true, onState = () => {} }) {
  let state = { status: 'idle', current, latest: null, done: 0, error: null, checkedAt: null };
  let job = null; // the download in progress: { version, req }
  const set = patch => { state = Object.assign({}, state, patch); onState(state); return state; };
  const target = r => path.join(dir, r.fileName);

  // A release from the HP (its hub message, or a check). Newer → download it; otherwise nothing to do.
  async function offer(latest) {
    if (!isRelease(latest) || cmp(latest.version, current) <= 0) {
      // Nothing newer here, but something newer already found (the HP may lag GitHub): keep that.
      if (state.latest && cmp(state.latest.version, current) > 0 && ['downloading', 'waiting', 'ready', 'available'].includes(state.status)) return state;
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
    set({ status: state.status === 'ready' ? 'ready' : 'checking', error: null });
    // GitHub first; the HP when GitHub has nothing published or can't be reached (no internet).
    let ghError = null;
    if (github) {
      try { const rel = await githubLatest(github); if (rel) return offer(rel); }
      catch (err) { ghError = err.name === 'TimeoutError' ? 'GitHub didn’t answer.' : err.message; }
    }
    if (!s) return ghError ? set({ status: 'error', error: ghError + ' And Attic Hub isn’t connected to the HP.' })
      : github ? offer(null) : set({ status: 'error', error: 'Attic Hub isn’t connected to the HP.' });
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
    const fromGitHub = r.source === 'github';
    if (!s && !fromGitHub) return set({ status: 'available' });
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
          const headers = Object.assign({}, fromGitHub ? { 'User-Agent': 'Attic-Hub-updater' } : s.headers, have ? { Range: `bytes=${have}-` } : {});
          const url = fromGitHub ? r.url : new URL(r.url || `api/updates/files/${encodeURIComponent(r.fileName)}`, s.base).href;
          get(url, headers, q => { me.req = q; }).then(res => {
            if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return reject(new Error(`${fromGitHub ? 'GitHub' : 'The HP'} answered ${res.statusCode}.`)); }
            if (res.statusCode === 200) have = 0; // the whole file again
            const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
            let last = 0;
            res.on('data', d => { have += d.length; if (Date.now() - last > 250) { last = Date.now(); set({ done: have }); } });
            res.pipe(out);
            out.on('finish', resolve);
            out.on('error', reject);
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('The download was cut off.')));
          }, reject);
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
