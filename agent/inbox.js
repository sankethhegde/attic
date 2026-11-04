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

module.exports = { defaultFolder, safeName, uniquePath, partialPath, place, DEFAULT_NAME, PARTIAL };
