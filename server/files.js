// files.js — Phase 1C, milestone 4: browse real folders and stream real files.
// Every path from the client goes through safePath() first. Symlinks and junctions are left out of
// listings, and a file is only opened once its real location on disk is confirmed inside the share,
// so a link planted in a share can't lead out of it.
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

class FileError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const NOT_FOUND = what => new FileError(404, 'NOT_FOUND', `This ${what} doesn’t exist any more.`);
const INDEX_TTL = 30e3;   // how long one walk of a share is reused
const INDEX_MAX = 200000; // files per share; past this a real database is due (the brief's SQLite step)
const TRASH = '~attic-trash';  // 0.14: where deleted files and folders wait, one per share, hidden from everyone
const TRASH_DAYS = 30;

// Media the browser may show in place (previews, the photo viewer, video playback), by extension, with
// the type it's served as. Nothing that can run script: no SVG, HTML or PDF. Everything else downloads.
const INLINE = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.avif': 'image/avif', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac'
};

// Ids are stable across listings: the share and the path, so a reload can reselect the same file.
const fileId = (shareId, rel) => 'r:' + Buffer.from(shareId + '\n' + rel, 'utf8').toString('base64url');
function parseId(id) {
  if (typeof id !== 'string' || !id.startsWith('r:')) return null;
  const [shareId, rel] = Buffer.from(id.slice(2), 'base64url').toString('utf8').split('\n');
  return rel === undefined ? null : { shareId, rel };
}

function createFiles(shares, safePath) {
  const byId = new Map(shares.map(s => [s.id, s]));

  function shareOrThrow(shareId) {
    const s = byId.get(shareId);
    if (!s) throw new FileError(404, 'NOT_FOUND', 'That share no longer exists.');
    return s;
  }
  async function realRoot(share) {
    try { return await fs.promises.realpath(share.rootPath); }
    catch (e) { throw new FileError(409, 'UNAVAILABLE', `${share.name} is unavailable. Check the drive is connected.`); }
  }
  async function confirmInside(root, target) {
    const real = await fs.promises.realpath(target);
    if (real !== root && !real.startsWith(root + path.sep)) throw new FileError(403, 'FORBIDDEN', 'That path leads outside the share.');
    return real;
  }
  const joinRel = (a, b) => a ? a + '/' + b : b;
  const isTemp = n => /^~attic-[0-9a-f]+\.part$/.test(n);
  // 0.14: deleted items wait in a hidden folder at the top of their share for TRASH_DAYS, then go for good.
  const isTrash = n => n === TRASH;
  const isHidden = n => isTemp(n) || isTrash(n);
  function splitName(n) { const i = n.lastIndexOf('.'); return i > 0 ? { base: n.slice(0, i), ext: n.slice(i) } : { base: n, ext: '' }; }
  async function isEmptyDir(p) {
    try { return (await fs.promises.readdir(p)).filter(n => !isHidden(n)).length === 0; } catch (e) { return false; }
  }
  function readError(e, what) {
    if (e instanceof FileError) return e;
    return e.code === 'EPERM' || e.code === 'EACCES' ? new FileError(403, 'FORBIDDEN', `Windows won’t let Attic open this ${what}.`) : NOT_FOUND(what);
  }
  // ---------- the index ----------
  const indexCache = new Map(); // shareId -> { at, files: [{ rel, size, modifiedAt }] }
  // Depth-first, one folder at a time, so a big share never has thousands of directory handles open.
  // An unplugged share, or a folder Windows won't open, simply contributes nothing.
  async function walkShare(share) {
    let root;
    try { root = await fs.promises.realpath(share.rootPath); } catch (e) { return []; }
    const files = [], stack = [''];
    while (stack.length && files.length < INDEX_MAX) {
      const rel = stack.pop();
      let dirents;
      try { dirents = await fs.promises.readdir(rel ? path.join(root, ...rel.split('/')) : root, { withFileTypes: true }); } catch (e) { continue; }
      for (const d of dirents) {
        if (d.isSymbolicLink() || isHidden(d.name)) continue;
        const childRel = joinRel(rel, d.name);
        if (!safePath(share.id, childRel)) continue;
        if (d.isDirectory()) { stack.push(childRel); continue; }
        if (!d.isFile()) continue;
        try {
          const st = await fs.promises.stat(path.join(root, ...childRel.split('/')));
          files.push({ rel: childRel, size: st.size, modifiedAt: st.mtime.toISOString() });
        } catch (e) { /* vanished or locked */ }
      }
    }
    return files;
  }

  // The path as the disk spells it, relative to the share. Ownership is keyed and checked on this, never
  // on the client's spelling: Windows treats "Report.pdf" and "report.pdf" as one file.
  const canonical = (root, real) => path.relative(root, real).split(path.sep).join('/');

  // A folder the caller may see, checked inside the share on disk, or "not found".
  async function folderPath(share, shareId, rel, view) {
    const target = safePath(shareId, rel);
    if (!target) throw NOT_FOUND('folder');
    const root = await realRoot(share);
    let real;
    try {
      real = await confirmInside(root, target);
      if (!(await fs.promises.stat(real)).isDirectory()) throw NOT_FOUND('folder');
    } catch (e) { throw readError(e, 'folder'); }
    const canon = canonical(root, real);
    if (canon.split('/').some(isHidden)) throw NOT_FOUND('folder');   // the trash and uploads in flight
    if (!(await view.folderVisible(shareId, canon, () => isEmptyDir(real)))) throw NOT_FOUND('folder');
    return { dir: real, rel: canon };
  }

  return {
    FileError, parseId,

    // The folder as the caller may see it (view: ownership.view(session)), in the mock's shape minus
    // what the browser derives (ext, category). A folder the caller can't see is "not found", the same
    // answer as one that doesn't exist.
    async listFolder(shareId, rel, view) {
      const share = shareOrThrow(shareId);
      const { dir: target, rel: canon } = await folderPath(share, shareId, rel, view);
      rel = canon;
      let dirents;
      try { dirents = await fs.promises.readdir(target, { withFileTypes: true }); }
      catch (e) { throw readError(e, 'folder'); }
      const items = [];
      await Promise.all(dirents.map(async d => {
        if (d.isSymbolicLink() || !(d.isFile() || d.isDirectory()) || isHidden(d.name)) return; // links, junctions, devices, uploads in flight, the trash
        const childRel = joinRel(rel, d.name);
        if (!safePath(shareId, childRel)) return; // a name the API could never address again
        const childPath = path.join(target, d.name);
        if (d.isFile() ? !view.fileVisible(shareId, childRel) : !(await view.folderVisible(shareId, childRel, () => isEmptyDir(childPath)))) return;
        let st;
        try { st = await fs.promises.stat(childPath); } catch (e) { return; } // vanished or locked
        const rec = d.isFile() ? view.recordOf(shareId, childRel) : { ownerId: null, uploadedBy: null };
        items.push({ id: fileId(shareId, childRel), kind: d.isDirectory() ? 'folder' : 'file', share: shareId, path: rel, name: d.name,
          size: d.isDirectory() ? 0 : st.size, modifiedAt: st.mtime.toISOString(), ownerId: rec.ownerId, uploadedBy: rec.uploadedBy });
      }));
      return { share: { id: share.id, name: share.name }, path: rel, items };
    },

    // An upload, streamed to a temporary file in the destination folder and linked into place under a
    // name nobody has taken: an existing file is never overwritten, and a half-sent file never shows.
    // An upload's destination, checked: the folder as the disk spells it, and a temporary file in it for
    // the bytes (hidden from listings). Shared by the one-request upload below and the resumable one (4-2).
    async prepareUpload(shareId, folderRel, name, view) {
      const share = shareOrThrow(shareId);
      if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\')) throw new FileError(400, 'INVALID', 'Give the file a name.');
      if (/\.(lnk|tmp|crdownload|part)$/i.test(name) || isHidden(name)) throw new FileError(400, 'INVALID', 'This file type can’t be uploaded.');
      if (!safePath(shareId, joinRel(folderRel, name))) throw new FileError(400, 'INVALID', 'Windows can’t store a file with that name.');
      const { dir, rel } = await folderPath(share, shareId, folderRel, view);
      return { shareId, shareName: share.name, folderRel: rel, dir, name, temp: path.join(dir, `~attic-${crypto.randomBytes(8).toString('hex')}.part`) };
    },
    // Links a finished temporary file into place under a name nobody has taken ("photo (1).jpg"), so an
    // existing file is never overwritten. The temporary file stays for the caller to delete.
    async placeUpload(prep, temp = prep.temp) {
      const { ext, base } = splitName(prep.name);
      for (let n = 0; ; n++) {
        const finalName = n ? `${base} (${n})${ext}` : prep.name;
        const finalRel = joinRel(prep.folderRel, finalName);
        if (!safePath(prep.shareId, finalRel)) throw new FileError(400, 'INVALID', 'Windows can’t store a file with that name.');
        try { await fs.promises.link(temp, path.join(prep.dir, finalName)); return { rel: finalRel, name: finalName }; }
        catch (e) { if (e.code !== 'EEXIST' || n > 999) throw e; }
      }
    },

    // A folder inside another, for uploading a whole folder (9 Nov 2026). A folder of that name the caller
    // can see is used as it is, so a second upload of the same folder fills it up (files are never
    // overwritten: "photo (1).jpg"). One the caller can't see (another account's) is left alone and the
    // new one gets a free name, "Trip (1)". Resolves with the folder's path in the share.
    async makeFolder(shareId, parentRel, name, view) {
      const share = shareOrThrow(shareId);
      name = typeof name === 'string' ? name.trim() : '';
      if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || isHidden(name)) throw new FileError(400, 'INVALID', 'Give the folder a name.');
      if (!safePath(shareId, joinRel(parentRel, name))) throw new FileError(400, 'INVALID', 'Windows can’t store a folder with that name.');
      const parent = await folderPath(share, shareId, parentRel, view);
      for (let n = 0; n <= 999; n++) {
        const cand = n ? `${name} (${n})` : name;
        const rel = joinRel(parent.rel, cand);
        if (!safePath(shareId, rel)) throw new FileError(400, 'INVALID', 'Windows can’t store a folder with that name.');
        const dir = path.join(parent.dir, cand);
        try { await fs.promises.mkdir(dir); }
        catch (e) {
          if (e.code === 'ENOSPC') throw new FileError(507, 'DISK_FULL', `${share.name} is full.`);
          if (e.code !== 'EEXIST') throw readError(e, 'folder');
          const st = await fs.promises.lstat(dir).catch(() => null);
          if (!st || !st.isDirectory()) continue; // a file (or a link) by that name: try the next name
        }
        try { return { rel: (await folderPath(share, shareId, rel, view)).rel }; }
        catch (e) { if (!(e instanceof FileError) || e.status !== 404) throw e; } // there, but not the caller's
      }
      throw new FileError(409, 'CONFLICT', 'Couldn’t find a free name for that folder.');
    },

    async saveUpload(shareId, folderRel, name, stream, view, limit) {
      const prep = await this.prepareUpload(shareId, folderRel, name, view);
      const share = { name: prep.shareName };
      const temp = prep.temp;
      let bytes = 0, out;
      try {
        // Settles only once the temp file is closed: Windows can neither link nor delete an open file.
        await new Promise((resolve, reject) => {
          let failure = null;
          const fail = e => { if (!failure) { failure = e; stream.unpipe(out); out.destroy(); } };
          out = fs.createWriteStream(temp, { flags: 'wx' });
          stream.on('data', c => { bytes += c.length; if (bytes > limit) fail(new FileError(413, 'TOO_LARGE', 'Too large. The limit is 20 GB per file.')); });
          // A browser that cancels or drops just closes the connection: the request ends incomplete.
          stream.on('close', () => { if (stream.complete === false) fail(new FileError(400, 'CANCELLED', 'Upload cancelled.')); });
          stream.on('error', () => fail(new FileError(400, 'CANCELLED', 'Upload cancelled.')));
          out.on('error', fail);
          out.on('close', () => failure ? reject(failure) : resolve());
          stream.pipe(out);
        });
        return Object.assign(await this.placeUpload(prep), { size: bytes });
      } catch (e) {
        if (e instanceof FileError) throw e;
        if (e.code === 'ENOSPC') throw new FileError(507, 'DISK_FULL', `${share.name} is full.`);
        throw readError(e, 'folder');
      } finally {
        fs.promises.unlink(temp).catch(() => {});
      }
    },

    // Every file in every available share, as the caller may see it: the index behind Photos, Videos,
    // Other and the Dashboard (milestone 6). One walk per share, kept for INDEX_TTL and dropped early by
    // forget() after an upload, so a large share isn't re-walked on every tab switch. Same rules as a
    // listing: no links or junctions, no uploads in flight, no names the API couldn't address again.
    async index(view) {
      const out = [];
      let generatedAt = Date.now();
      for (const share of shares) {
        let entry = indexCache.get(share.id);
        if (!entry || Date.now() - entry.at > INDEX_TTL) {
          entry = { at: Date.now(), files: await walkShare(share) };
          indexCache.set(share.id, entry);
        }
        generatedAt = Math.min(generatedAt, entry.at);
        for (const f of entry.files) {
          if (!view.fileVisible(share.id, f.rel)) continue;
          const i = f.rel.lastIndexOf('/');
          const rec = view.recordOf(share.id, f.rel);
          out.push({ id: fileId(share.id, f.rel), kind: 'file', share: share.id, path: i < 0 ? '' : f.rel.slice(0, i), name: f.rel.slice(i + 1),
            size: f.size, modifiedAt: f.modifiedAt, ownerId: rec.ownerId, uploadedBy: rec.uploadedBy });
        }
      }
      return { generatedAt: new Date(generatedAt).toISOString(), entries: out };
    },
    forget(shareId) { if (shareId) indexCache.delete(shareId); else indexCache.clear(); },

    // ---------- 0.14: move, rename and delete (PixHaven's "Move to/from Attic", and moving inside Attic) ----------
    // Only what the caller may change: canChange(share, rel) is asked for the file, or for every file inside a
    // folder (a device may change what it owns; the master anything). Nothing is ever overwritten.

    // A file or folder (not the share itself) the caller can see, as the disk spells it.
    async _item(shareId, rel, view) {
      const share = shareOrThrow(shareId);
      const target = safePath(shareId, rel);
      if (!target || target === safePath(shareId, '')) throw NOT_FOUND('item');
      const root = await realRoot(share);
      let real, st;
      try { real = await confirmInside(root, target); st = await fs.promises.lstat(real); }
      catch (e) { throw readError(e, 'item'); }
      const canon = canonical(root, real);
      if (canon.split('/').some(isHidden)) throw NOT_FOUND('item');
      const isDir = st.isDirectory();
      if (isDir ? !(await view.folderVisible(shareId, canon, () => isEmptyDir(real))) : !view.fileVisible(shareId, canon)) throw NOT_FOUND(isDir ? 'folder' : 'file');
      return { share, root, real, rel: canon, isDir };
    },
    // Every file inside a folder (relative to the share), for the ownership checks and records.
    async _filesUnder(root, real) {
      const out = [], stack = [real];
      while (stack.length) {
        const dir = stack.pop();
        for (const d of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (d.isSymbolicLink() || isTemp(d.name)) continue;
          const p = path.join(dir, d.name);
          if (d.isDirectory()) stack.push(p); else if (d.isFile()) out.push(canonical(root, p));
        }
      }
      return out;
    },
    _mayChange(it, files, canChange) {
      const list = it.isDir ? files : [it.rel];
      if (list.some(r => !canChange(it.share.id, r))) {
        throw new FileError(403, 'NOT_YOURS', it.isDir ? 'Some files in this folder belong to someone else, so it can’t be changed from here.' : 'This file belongs to someone else, so it can’t be changed from here.');
      }
    },
    // Renames src into destDir under a free name ("clip (1).mp4"); across drives, copies then removes.
    async _placeAt(srcReal, destDir, name, isDir) {
      const { base, ext } = isDir ? { base: name, ext: '' } : splitName(name);
      for (let n = 0; n <= 999; n++) {
        const cand = n ? `${base} (${n})${ext}` : name;
        const to = path.join(destDir, cand);
        if (await fs.promises.lstat(to).then(() => true, () => false)) continue;   // taken: never overwrite
        try { await fs.promises.rename(srcReal, to); return cand; }
        catch (e) {
          if (e.code === 'EXDEV') {
            await fs.promises.cp(srcReal, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
            await fs.promises.rm(srcReal, { recursive: true, force: true });
            return cand;
          }
          if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') throw new FileError(423, 'LOCKED', 'Windows won’t let Attic move this. A file in it may be open in another program.');
          if (e.code === 'ENOSPC') throw new FileError(507, 'DISK_FULL', 'The drive is full.');
          throw e;
        }
      }
      throw new FileError(409, 'CONFLICT', 'Couldn’t find a free name.');
    },

    // Moves (and/or renames) a file or folder into a folder the caller can see, in this share or another one.
    // Answers where it ended up and every file's old and new place, so ownership records can follow.
    async moveItem(shareId, rel, toShareId, toFolderRel, newName, view, canChange) {
      const it = await this._item(shareId, rel, view);
      const files = it.isDir ? await this._filesUnder(it.root, it.real) : [];
      this._mayChange(it, files, canChange);
      const name = typeof newName === 'string' && newName.trim() ? newName.trim() : path.basename(it.real);
      if (/[\\/]/.test(name) || name === '.' || name === '..' || isHidden(name)) throw new FileError(400, 'INVALID', 'Give it a name.');
      const toShare = shareOrThrow(toShareId || shareId);
      const dest = await folderPath(toShare, toShare.id, toFolderRel || '', view);
      if (!safePath(toShare.id, joinRel(dest.rel, name))) throw new FileError(400, 'INVALID', 'Windows can’t store that name.');
      if (it.isDir && (dest.dir === it.real || dest.dir.startsWith(it.real + path.sep))) throw new FileError(400, 'INVALID', 'A folder can’t go inside itself.');
      if (path.dirname(it.real) === dest.dir && name === path.basename(it.real)) return { share: toShare.id, path: it.rel, moved: [] };
      const placed = await this._placeAt(it.real, dest.dir, name, it.isDir);
      const toRel = joinRel(dest.rel, placed);
      const moved = it.isDir ? files.map(f => ({ from: f, to: toRel + f.slice(it.rel.length) })) : [{ from: it.rel, to: toRel }];
      this.forget(shareId); this.forget(toShare.id);
      return { share: toShare.id, path: toRel, isDir: it.isDir, moved };
    },

    // "Delete": the item goes to the share's hidden trash, under today's date and its old place, and is
    // removed for good after TRASH_DAYS (purgeTrash). Answers the files that went, for their records.
    async trashItem(shareId, rel, view, canChange) {
      const it = await this._item(shareId, rel, view);
      const files = it.isDir ? await this._filesUnder(it.root, it.real) : [it.rel];
      this._mayChange(it, files, canChange);
      const day = new Date().toISOString().slice(0, 10);
      const parentRel = it.rel.includes('/') ? it.rel.slice(0, it.rel.lastIndexOf('/')) : '';
      const destDir = path.join(it.root, TRASH, day, ...(parentRel ? parentRel.split('/') : []));
      await fs.promises.mkdir(destDir, { recursive: true });
      await this._placeAt(it.real, destDir, path.basename(it.real), it.isDir);
      this.forget(shareId);
      return { trashed: files };
    },

    // Empties trash older than TRASH_DAYS in every share. Answers how many dated folders went.
    async purgeTrash(now = Date.now(), days = TRASH_DAYS) {
      let gone = 0;
      for (const share of shares) {
        let root;
        try { root = await fs.promises.realpath(share.rootPath); } catch (e) { continue; }
        const trash = path.join(root, TRASH);
        for (const d of await fs.promises.readdir(trash, { withFileTypes: true }).catch(() => [])) {
          const at = Date.parse(d.name);
          if (!d.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(d.name) || !(at < now - days * 864e5)) continue;
          await fs.promises.rm(path.join(trash, d.name), { recursive: true, force: true }).then(() => gone++, () => {});
        }
      }
      return gone;
    },

    // Size of each file that still exists, for revoke and restore figures. Missing ones are skipped.
    async sizes(keys) {
      let count = 0, bytes = 0;
      await Promise.all(keys.map(async k => {
        const p = byId.has(k.share) && safePath(k.share, k.rel);
        if (!p) return;
        try { const st = await fs.promises.stat(p); if (st.isFile()) { count++; bytes += st.size; } } catch (e) { /* gone from disk */ }
      }));
      return { count, bytes };
    },

    // An open, verified file the caller may see, and its size. The caller streams it and closes it.
    // Another account's file is "not found", the same answer as a file that doesn't exist.
    async openFile(shareId, rel, view) {
      const share = shareOrThrow(shareId);
      const target = safePath(shareId, rel);
      if (!target || target === safePath(shareId, '')) throw NOT_FOUND('file');
      const root = await realRoot(share);
      try {
        const real = await confirmInside(root, target);
        const canon = canonical(root, real);
        if (canon.split('/').some(isHidden) || !view.fileVisible(shareId, canon)) throw NOT_FOUND('file');
        const handle = await fs.promises.open(real, 'r');
        const st = await handle.stat();
        if (!st.isFile()) { await handle.close(); throw NOT_FOUND('file'); }
        return { handle, size: st.size, mtime: st.mtime, name: path.basename(real) };
      } catch (e) {
        if (e instanceof FileError) throw e;
        if (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY') throw new FileError(423, 'LOCKED', 'Windows won’t let Attic read this file. It may be open in another program.');
        throw NOT_FOUND('file');
      }
    }
  };
}

// One "bytes=a-b" range, or null for the whole file; throws on a range that can't be satisfied.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // multi-range or junk: send the whole file
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; } // last N bytes
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start > end || start >= size) throw new FileError(416, 'RANGE', 'Requested range not satisfiable.');
  return { start, end };
}

module.exports = { createFiles, parseRange, fileId, FileError, INLINE };
