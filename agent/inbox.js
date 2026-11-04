// inbox.js — Phase 2, milestone 2-4 (D-05): where files sent to this PC land, the Hub Inbox.
//
// The file-system half of receiving, ready before the HP's transfer endpoints: the folder, names that are
// safe on Windows whatever the sender called them, never overwriting, and never leaving a half-written
// file under its real name. How the bytes arrive (the HP's side of 2-4) plugs into receive() as a stream.
// Choosing another folder is milestone 3-3 (T-07). Core Node only.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');

const DEFAULT_NAME = 'Attic Hub Inbox';
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME = 200;

function defaultFolder(home = os.homedir()) {
  return path.join(home, 'Downloads', DEFAULT_NAME);
}

// One file or folder name, safe on Windows: no separators or reserved characters, no trailing dots or
// spaces, not a device name like CON, and not too long (the extension is kept when it's shortened).
function safeName(name) {
  let s = String(name || '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '').trim();
  if (!s) s = 'file'; // also "." and "..", emptied by the trailing-dot rule
  if (RESERVED.test(s.split('.')[0])) s = '_' + s;
  if (s.length > MAX_NAME) {
    const ext = path.extname(s).slice(0, 20);
    s = s.slice(0, MAX_NAME - ext.length).replace(/[. ]+$/, '') + ext;
  }
  return s;
}

// "Trip/day 1/IMG.jpg" from a folder transfer → safe parts. "..", "." and empty parts are dropped, so a
// sender can never write outside the inbox.
function safeRelPath(rel) {
  const parts = String(rel || '').split(/[\\/]+/).filter(p => p && p !== '.' && p !== '..').map(safeName);
  return parts.length ? parts : ['file'];
}

// "report.pdf" taken → "report (2).pdf", then "(3)" and so on.
function uniquePath(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let n = 2; fs.existsSync(p) || fs.existsSync(p + '.part'); n++) p = path.join(dir, `${base} (${n})${ext}`);
  return p;
}

// Writes `source` (a readable stream or async iterable of chunks) to the inbox as `relPath`. The bytes go
// to "<name>.part" first and are renamed only once complete (and the right size, when `size` is given),
// so a half-received file never looks finished. Resolves to the saved file's path.
async function receive(dir, relPath, source, { size = null } = {}) {
  const parts = safeRelPath(relPath);
  const folder = path.join(dir, ...parts.slice(0, -1));
  await fs.promises.mkdir(folder, { recursive: true });
  const final = uniquePath(folder, parts[parts.length - 1]);
  const part = final + '.part';
  let written = 0;
  try {
    await pipeline(source, async function* count(chunks) { for await (const c of chunks) { written += c.length; yield c; } }, fs.createWriteStream(part, { flags: 'wx' }));
    if (size != null && written !== size) throw new Error(`Received ${written} of ${size} bytes.`);
    await fs.promises.rename(part, final);
    return final;
  } catch (e) {
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw e;
  }
}

module.exports = { defaultFolder, safeName, safeRelPath, uniquePath, receive, DEFAULT_NAME };
