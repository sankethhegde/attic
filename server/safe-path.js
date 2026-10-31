// safe-path.js — Phase 1C, milestone 2. Turns a share id and a client-supplied relative path into an
// absolute path inside that share, or null. Every endpoint that accepts a path goes through this.
//
// relPath arrives already URL-decoded once by the HTTP layer. It is never decoded again here: anything
// still percent-encoded is refused rather than guessed at.
//
// Two layers. First each segment must be a name Windows would store as typed — no dot-only names, no
// trailing dots or spaces (Windows silently strips them, so "...." and "a." alias other names), no drive
// letters or streams (":"), no reserved devices (CON, NUL…). Then resolve and check containment, which
// catches anything the first layer missed.
'use strict';
const path = require('path');

const ENCODED = /%[0-9a-f]{2}/i;
const BAD_CHARS = /[<>:"|?*\x00-\x1f]/;
const DOTS_ONLY = /^\.+$/;
const TRAILING_DOT_OR_SPACE = /[. ]$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

function segmentOk(seg) {
  return seg !== '' && !BAD_CHARS.test(seg) && !DOTS_ONLY.test(seg) && !TRAILING_DOT_OR_SPACE.test(seg) && !RESERVED.test(seg);
}

function createSafePath(shares) {
  const SHARES = {};
  for (const s of shares) SHARES[s.id] = path.resolve(s.rootPath);

  return function safePath(shareId, relPath) {
    const root = Object.prototype.hasOwnProperty.call(SHARES, shareId) ? SHARES[shareId] : null;
    if (!root || typeof relPath !== 'string') return null;
    if (relPath === '') return root;
    if (ENCODED.test(relPath)) return null;
    if (/^[/\\]/.test(relPath)) return null; // absolute or UNC: refused, not stripped
    const segs = relPath.split(/[/\\]/);
    if (!segs.every(segmentOk)) return null;
    const target = path.resolve(root, ...segs);
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    return target;
  };
}

module.exports = { createSafePath };
