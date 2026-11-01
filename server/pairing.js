// pairing.js — Phase 2, milestone 2-2 (D-02, D-11): which devices may talk to this HP at all.
//
// Accounts say who is using Attic; paired devices say which machine the request comes from. Every
// request needs both. A new device pairs once:
//   1. The master issues a one-time code on the HP (Devices → Pair a device). Issuing it is the approval.
//   2. The new device sends the code with its name. The HP stores a device identity and gives the device
//      a long random token, kept in an HttpOnly cookie. The HP keeps only the token's SHA-256.
// Unpairing deletes the identity: the token stops working at once, and so do sessions signed in on it.
//
// Codes live in memory only, so a restart cancels any that are outstanding. They last 10 minutes, are
// used once, and wrong guesses are limited per address and in total (too many and every code is
// cancelled), so six digits are enough. Core Node only.
'use strict';
const crypto = require('crypto'), path = require('path');
const { AuthError, jsonStore } = require('./auth');

const CODE_TTL_MS = 10 * 60e3;
const MAX_CODES = 5;                               // outstanding at once
const FAIL_LIMIT = 5, FAIL_WINDOW_MS = 15 * 60e3;  // wrong codes per client address
const TOTAL_WRONG_LIMIT = 20;                      // wrong codes from anyone, before every code is cancelled
const TOUCH_MS = 60e3;                             // how often lastSeenAt is written for one device
const ONLINE_MS = 2 * 60e3;                        // seen this recently counts as online, until 2-3's live connection
const KINDS = ['laptop', 'desktop', 'handheld', 'phone', 'tablet', 'other'];

const NO_CODE = () => new AuthError(400, 'BAD_CODE', 'That code isn’t valid. Codes last 10 minutes and work once; ask for a new one on the HP.');

function cleanText(s, max) {
  return typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '';
}

function createPairing(dataDir) {
  const devices = jsonStore(path.join(dataDir, 'devices.json'), []);
  const codes = new Map();    // code -> { id, code, issuedBy, issuedAt, expiresAt }
  const failures = new Map(); // client address -> [timestamps]
  let totalWrong = 0;         // since the last code was issued

  const tokenKey = t => crypto.createHash('sha256').update(String(t)).digest('hex');
  const now = () => new Date().toISOString();
  const find = id => devices.get().find(d => d.id === id);

  function publicDevice(d) {
    if (!d) return null;
    const { tokenHash, ...rest } = d;
    return Object.assign(rest, { online: !!d.lastSeenAt && Date.now() - Date.parse(d.lastSeenAt) < ONLINE_MS });
  }

  function pruneCodes() {
    const t = Date.now();
    for (const [k, c] of codes) if (Date.parse(c.expiresAt) <= t) codes.delete(k);
  }
  function recentFailures(addr) {
    const cutoff = Date.now() - FAIL_WINDOW_MS;
    const list = (failures.get(addr) || []).filter(t => t > cutoff);
    if (list.length) failures.set(addr, list); else failures.delete(addr);
    return list;
  }

  return {
    // ---------- codes (master) ----------
    issueCode(issuedBy) {
      pruneCodes();
      if (codes.size >= MAX_CODES) throw new AuthError(429, 'TOO_MANY_CODES', `${MAX_CODES} codes are already waiting. Cancel one or let them expire.`);
      let code;
      do code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); while (codes.has(code));
      const t = Date.now();
      const c = { id: 'pc_' + crypto.randomBytes(6).toString('base64url'), code, issuedBy, issuedAt: new Date(t).toISOString(), expiresAt: new Date(t + CODE_TTL_MS).toISOString() };
      codes.set(code, c);
      totalWrong = 0;
      return Object.assign({}, c);
    },
    listCodes() { pruneCodes(); return [...codes.values()].map(c => Object.assign({}, c)); },
    cancelCode(id) {
      for (const [k, c] of codes) if (c.id === id) { codes.delete(k); return true; }
      return false;
    },

    // ---------- the new device's side ----------
    // "123 456", "123-456" and "123456" are the same code. Every wrong code counts, including expired ones.
    claim({ code, name, kind, os } = {}, addr) {
      const list = recentFailures(addr);
      if (list.length >= FAIL_LIMIT) {
        const mins = Math.max(1, Math.ceil((list[0] + FAIL_WINDOW_MS - Date.now()) / 60e3));
        throw new AuthError(429, 'TOO_MANY_ATTEMPTS', `Too many wrong codes. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
      }
      const deviceName = cleanText(name, 64);
      if (!deviceName) throw new AuthError(400, 'INVALID', 'Give this device a name, like “Acer laptop”.');
      pruneCodes();
      const c = codes.get(String(code || '').replace(/[\s-]/g, ''));
      if (!c) {
        failures.set(addr, list.concat(Date.now()));
        if (++totalWrong >= TOTAL_WRONG_LIMIT) { codes.clear(); totalWrong = 0; }
        throw NO_CODE();
      }
      codes.delete(c.code);
      failures.delete(addr);
      const token = crypto.randomBytes(32).toString('base64url');
      const d = { id: 'dev_' + crypto.randomBytes(9).toString('base64url'), name: deviceName,
        kind: KINDS.includes(kind) ? kind : 'other', os: cleanText(os, 64) || null,
        pairedAt: now(), pairedBy: c.issuedBy, lastSeenAt: now(), lastAddress: addr, tokenHash: tokenKey(token) };
      devices.save(devices.get().concat(d));
      return { token, device: publicDevice(d) };
    },

    // ---------- every request ----------
    // The paired device behind a token, or null.
    resolve(token) {
      if (!token || typeof token !== 'string' || token.length > 128) return null;
      const key = tokenKey(token);
      return publicDevice(devices.get().find(d => d.tokenHash === key));
    },
    // Records when and where a device was last seen, at most once a minute per device.
    touch(id, addr) {
      const d = find(id);
      if (!d || (d.lastAddress === addr && Date.now() - Date.parse(d.lastSeenAt) < TOUCH_MS)) return;
      devices.save(devices.get().map(x => x.id === id ? Object.assign({}, x, { lastSeenAt: now(), lastAddress: addr }) : x));
    },

    list: () => devices.get().map(publicDevice),

    unpair(id) {
      const d = find(id);
      if (!d) throw new AuthError(404, 'NOT_FOUND', 'That device is no longer paired.');
      devices.save(devices.get().filter(x => x.id !== id));
      return publicDevice(d);
    }
  };
}

module.exports = { createPairing, KINDS, CODE_TTL_MS };
