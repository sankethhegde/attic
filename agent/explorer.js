// explorer.js — Phase 3, milestone 3-3 (T-06): "Send to Attic Hub" in File Explorer's right-click menu.
//
// A per-user entry (HKEY_CURRENT_USER\Software\Classes), so it needs no Administrator rights: for every
// file (*) and every folder (Directory). Choosing it runs `Attic Hub.exe --send "<path>"`; the running tool
// gathers the paths (several files picked together arrive as several launches) and opens its Send dialog.
// On Windows 11 it's under "Show more options", like every classic menu entry. The installer's uninstall
// removes it too (desktop/build/installer.nsh). Uses Windows' own reg.exe. Core Node only.
'use strict';
const { execFile } = require('child_process');

const KEY = 'AtticHub';
const ROOTS = ['HKCU\\Software\\Classes\\*\\shell', 'HKCU\\Software\\Classes\\Directory\\shell'];
const LABEL = 'Send to Attic Hub';

// The registry values to write, as [key, valueName (null: the default value), data].
function entries(exe) {
  const out = [];
  for (const root of ROOTS) {
    out.push([`${root}\\${KEY}`, null, LABEL]);
    out.push([`${root}\\${KEY}`, 'Icon', `"${exe}",0`]);
    out.push([`${root}\\${KEY}\\command`, null, `"${exe}" --send "%1"`]);
  }
  return out;
}

const reg = args => new Promise((resolve, reject) => execFile('reg.exe', args, { windowsHide: true }, (err, out, errOut) => err ? reject(Object.assign(err, { stderr: errOut })) : resolve(String(out))));

async function register(exe) {
  for (const [key, name, data] of entries(exe)) await reg(['add', key, ...(name ? ['/v', name] : ['/ve']), '/d', data, '/f']);
}
async function unregister() {
  for (const root of ROOTS) await reg(['delete', `${root}\\${KEY}`, '/f']).catch(() => { /* not there */ });
}
// → 'ours' (points at this exe), 'other' (another copy of the tool), or 'none'.
async function status(exe) {
  try {
    const out = await reg(['query', `${ROOTS[0]}\\${KEY}\\command`, '/ve']);
    return out.toLowerCase().includes(`"${exe.toLowerCase()}" --send`) ? 'ours' : 'other';
  } catch (e) { return 'none'; }
}

// The paths in a launch's command line: the full paths after --send. File Explorer always passes full
// paths; anything else there (Chromium may move the app's own "." after --send) is ignored.
function sendPaths(argv) {
  const i = argv.indexOf('--send');
  return i < 0 ? [] : argv.slice(i + 1).filter(a => a && !a.startsWith('--') && require('path').win32.isAbsolute(a) && /^([A-Za-z]:\\|\\\\)/.test(a));
}

module.exports = { entries, register, unregister, status, sendPaths, LABEL, KEY };
