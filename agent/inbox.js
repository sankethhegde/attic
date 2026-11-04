// inbox.js — Phase 2, milestone 2-4 (D-05): where files sent to this PC land, the Hub Inbox.
//
// The file-system half of receiving (receiver.js does the downloading): the folder, names that are safe
// on Windows whatever the sender called them, and never overwriting. A download in progress lives in
// the inbox's hidden ".attic-partial" folder, named by its transfer, so it can resume after a dropped
// connection or a restart; only a complete file is moved into the inbox under its real name.
// Choosing another folder is milestone 3-3 (T-07). Core Node only.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_NAME = 'Attic Hub Inbox';
const PARTIAL = '.attic-partial';
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_NAME = 200;

function defaultFolder(home = os.homedir()) {
  return path.join(home, 'Downloads', DEFAULT_NAME);
}

// One file name, safe on Windows: no separators or reserved characters, no trailing dots or spaces, not
// a device name like CON, and not too long (the extension is kept when it's shortened).
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

// "report.pdf" taken → "report (2).pdf", then "(3)" and so on.
function uniquePath(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(dir, `${base} (${n})${ext}`);
  return p;
}

// Where transfer `id` downloads to until it's complete. Its folder is made if needed.
async function partialPath(dir, id) {
  const folder = path.join(dir, PARTIAL);
  await fs.promises.mkdir(folder, { recursive: true });
  return path.join(folder, safeName(id) + '.part');
}

// Moves a complete download into the inbox as `name` (made safe, and unique). Resolves to its path.
async function place(dir, name, part) {
  await fs.promises.mkdir(dir, { recursive: true });
  const final = uniquePath(dir, safeName(name));
  await fs.promises.rename(part, final);
  return final;
}

// A folder chosen as the Hub Inbox (3-3) must be a full path this PC can write to: made if it doesn't
// exist, then tried with a scratch file. Throws an Error whose message can be shown as it is.
async function checkFolder(dir) {
  dir = String(dir || '').trim();
  if (!path.isAbsolute(dir)) throw new Error('Choose a full folder path, like D:\\Inbox.');
  const probe = path.join(dir, `.attic-check-${process.pid}`);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(probe, 'ok');
    await fs.promises.rm(probe, { force: true });
  } catch (e) {
    throw new Error(`Attic Hub can’t save files in ${dir} (${e.code || e.message}). Choose another folder.`);
  }
  return dir;
}

module.exports = { defaultFolder, safeName, uniquePath, partialPath, place, checkFolder, DEFAULT_NAME, PARTIAL };
