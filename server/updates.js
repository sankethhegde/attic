// updates.js — Phase 3, milestone 3-5 (T-10): the HP holds the newest desktop-tool installer, and tells
// every client its version, so each can offer to update itself.
//
// Releases live in data/updates/ (or "updatesDir" in config.json): the installers, named as the desktop
// build names them (Attic-Hub-Setup-<version>.exe), and manifest.json listing them newest first, with
// size, SHA-512 and SHA-256, date and notes. The newest 3 are kept.
// A release gets there one of two ways: the master uploads it (PUT /api/updates/files/<name>, from the PC
// that built it), or someone on the HP runs `node server/publish-update.js <installer>`. Either way the
// file must be a Windows program (it starts "MZ"), its version comes from its name, and it must be newer
// than the latest unless replacing is asked for. The running server re-reads the manifest when it
// changes on disk, so a command-line publish is picked up without a restart.
// latest.yml is served too, in the shape electron-updater's "generic" provider reads. Core Node only.
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const { AuthError } = require('./auth');

const NAME = /^Attic-Hub-Setup-(\d{1,4})\.(\d{1,4})\.(\d{1,4})\.exe$/;
const MAX_SIZE = 1e9;
const KEEP = 3;

const parse = name => { const m = NAME.exec(name || ''); return m ? [+m[1], +m[2], +m[3]] : null; };
const versionOf = name => { const v = parse(name); return v ? v.join('.') : null; };
const cmp = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const isVersion = v => typeof v === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(v);

function createUpdates({ dir, log = () => {}, onPublished = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  let manifest = { releases: [] }, mtime = 0;
  function load() {
    try {
      const st = fs.statSync(manifestPath);
      if (st.mtimeMs === mtime) return false;
      mtime = st.mtimeMs;
      const before = manifest.releases[0] && manifest.releases[0].version;
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(manifest.releases)) manifest.releases = [];
      return (manifest.releases[0] && manifest.releases[0].version) !== before;
    } catch (e) { return false; }
  }
  load();
  function save(next) {
    fs.writeFileSync(manifestPath + '.tmp', JSON.stringify(next, null, 2));
    fs.renameSync(manifestPath + '.tmp', manifestPath);
    manifest = next;
    mtime = fs.statSync(manifestPath).mtimeMs;
  }

  // Stores one installer from a readable stream. Hashes as it goes; nothing is visible until it's whole.
  async function publish(stream, { fileName, notes = '', publishedBy = null, replace = false, size = null } = {}) {
    load();
    const version = versionOf(fileName);
    if (!version) throw new AuthError(400, 'INVALID', 'Name the installer as the build does: Attic-Hub-Setup-<version>.exe, like Attic-Hub-Setup-0.7.0.exe.');
    if (size !== null && size > MAX_SIZE) throw new AuthError(413, 'TOO_LARGE', 'An installer over 1 GB isn’t an Attic Hub installer.');
    const latest = manifest.releases[0];
    if (latest && !replace) {
      const c = cmp(version, latest.version);
      if (c === 0) throw new AuthError(409, 'EXISTS', `${version} is already the latest. Add replace to publish it again.`);
      if (c < 0) throw new AuthError(409, 'OLDER', `${version} is older than the latest, ${latest.version}.`);
    }
    const temp = path.join(dir, `~upload-${crypto.randomBytes(6).toString('hex')}.part`);
    const h512 = crypto.createHash('sha512'), h256 = crypto.createHash('sha256');
    let bytes = 0, head = Buffer.alloc(0);
    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(temp, { flags: 'wx' });
        let failure = null;
        const fail = e => { if (!failure) { failure = e; stream.unpipe(out); out.destroy(); } };
        stream.on('data', c => {
          bytes += c.length;
          if (head.length < 2) head = Buffer.concat([head, c.subarray(0, 2)]);
          if (bytes > MAX_SIZE) return fail(new AuthError(413, 'TOO_LARGE', 'An installer over 1 GB isn’t an Attic Hub installer.'));
          h512.update(c); h256.update(c);
        });
        stream.on('close', () => { if (stream.complete === false) fail(new AuthError(400, 'CANCELLED', 'The upload was cut off.')); });
        stream.on('error', () => fail(new AuthError(400, 'CANCELLED', 'The upload was cut off.')));
        out.on('error', fail);
        out.on('close', () => failure ? reject(failure) : resolve());
        stream.pipe(out);
      });
      if (size !== null && bytes !== size) throw new AuthError(400, 'CANCELLED', 'The upload was cut off.');
      if (bytes < 2 || head[0] !== 0x4d || head[1] !== 0x5a) throw new AuthError(400, 'INVALID', 'That isn’t a Windows program. Upload the Attic-Hub-Setup .exe the build made.');
      fs.renameSync(temp, path.join(dir, fileName));
    } finally { fs.rmSync(temp, { force: true }); }
    const release = { version, fileName, size: bytes, sha512: h512.digest('base64'), sha256: h256.digest('hex'),
      releaseDate: new Date().toISOString(), notes: String(notes || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 2000), publishedBy };
    const releases = [release].concat(manifest.releases.filter(r => r.version !== version)).sort((a, b) => cmp(b.version, a.version));
    for (const old of releases.slice(KEEP)) fs.rmSync(path.join(dir, old.fileName), { force: true });
    save({ releases: releases.slice(0, KEEP) });
    log(`Update published: Attic Hub ${version} (${bytes} bytes)`);
    if (releases[0].version === version) onPublished(release);
    return release;
  }

  return {
    publish,
    latest() { load(); return manifest.releases[0] || null; },
    list() { load(); return manifest.releases.slice(); },
    // For the running server: if someone published from the command line, say so once.
    poll() { if (load() && manifest.releases[0]) onPublished(manifest.releases[0]); },
    // The file, for a release in the manifest only.
    async open(fileName) {
      load();
      const r = manifest.releases.find(x => x.fileName === fileName);
      if (!r) throw new AuthError(404, 'NOT_FOUND', 'No such installer on the HP.');
      const handle = await fs.promises.open(path.join(dir, fileName), 'r').catch(() => { throw new AuthError(404, 'NOT_FOUND', 'No such installer on the HP.'); });
      const st = await handle.stat();
      return { handle, size: st.size, name: fileName, mtime: new Date(r.releaseDate) };
    },
    // electron-updater's generic provider reads this, next to the files.
    yml() {
      const r = this.latest();
      if (!r) return null;
      const q = s => `'${String(s).replace(/'/g, "''")}'`;
      return [`version: ${r.version}`, 'files:', `  - url: ${r.fileName}`, `    sha512: ${r.sha512}`, `    size: ${r.size}`,
        `path: ${r.fileName}`, `sha512: ${r.sha512}`, `releaseDate: ${q(r.releaseDate)}`].concat(r.notes ? [`releaseNotes: ${q(r.notes)}`] : []).join('\n') + '\n';
    }
  };
}

// What clients see about a release.
const publicRelease = (r, current) => r && Object.assign({ version: r.version, fileName: r.fileName, size: r.size, sha512: r.sha512, sha256: r.sha256,
  releaseDate: r.releaseDate, notes: r.notes || '', url: '/api/updates/files/' + encodeURIComponent(r.fileName) },
  isVersion(current) ? { current, newer: cmp(r.version, current) > 0 } : {});

module.exports = { createUpdates, publicRelease, versionOf, compareVersions: cmp, isVersion };
