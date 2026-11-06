// auth.js — Phase 1C, milestone 3: accounts, passwords and sessions, held by the server.
// Passwords are stored only as scrypt hashes. A session is a random token in an HttpOnly cookie; the
// server keeps only the token's SHA-256, so a copy of data/ can't be replayed as a sign-in.
// Core Node only. Accounts and sessions are JSON files under server/data/ (gitignored), each written
// whole to a temp file and renamed over the old one, so a crash mid-write never leaves half a file.
'use strict';
const crypto = require('crypto'), fs = require('fs'), path = require('path');

const DAY = 864e5;
const STAY_MS = 30 * DAY;          // "Stay signed in"
const BROWSER_SESSION_MS = 1 * DAY; // otherwise: the cookie dies with the browser, and the server forgets it after a day
const USERNAME = /^[a-zA-Z0-9._-]{3,32}$/;
// Feedback round 1: an email address works as a username too (and as an account's email, for resets).
const EMAIL = /^[^\s@<>()\[\],;:"\\]{1,64}@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,63}$/;
const isEmail = s => typeof s === 'string' && s.length <= 254 && EMAIL.test(s);
const RESET_MS = 30 * 60e3; // a reset link lasts 30 minutes
const MIN_PASSWORD = 6, MAX_PASSWORD = 256;
const DEVICE_TYPES = ['phone', 'tablet', 'laptop', 'desktop', 'other'];
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const FAIL_LIMIT = 5, FAIL_WINDOW_MS = 15 * 60e3; // per client address

class AuthError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const BAD_CREDENTIALS = () => new AuthError(401, 'BAD_CREDENTIALS', 'Incorrect username or password');

// ---------- storage ----------
function jsonStore(file, fallback) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { data = fallback; }
  return {
    get: () => data,
    save(next) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, file);
      data = next;
    }
  };
}

// ---------- passwords ----------
function scrypt(password, salt, opts) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, 64, opts, (err, key) => err ? reject(err) : resolve(key)));
}
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}
async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// Unknown usernames still pay for one hash, so response time doesn't reveal which usernames exist.
let dummyHash = null;
const dummy = async () => dummyHash || (dummyHash = await hashPassword(crypto.randomBytes(16).toString('hex')));

function checkPassword(pw, field) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw new AuthError(400, 'INVALID', `${field} must be at least ${MIN_PASSWORD} characters.`);
  if (pw.length > MAX_PASSWORD) throw new AuthError(400, 'INVALID', `${field} is too long.`);
}
function checkUsername(username) {
  const u = String(username || '').trim();
  if (!USERNAME.test(u) && !isEmail(u)) throw new AuthError(400, 'INVALID', 'Use an email address, or 3–32 letters, numbers, dots, dashes or underscores.');
  return u;
}
// An account's email, optional: '' or null clears it.
function checkEmail(email) {
  if (email === undefined) return undefined;
  const e = String(email || '').trim();
  if (!e) return null;
  if (!isEmail(e)) throw new AuthError(400, 'INVALID', 'That isn’t an email address.');
  return e;
}
function checkName(s) {
  if (typeof s !== 'string' || !s.trim()) throw new AuthError(400, 'INVALID', 'Enter a display name.');
  if (s.trim().length > 64) throw new AuthError(400, 'INVALID', 'Display names are at most 64 characters.');
  return s.trim();
}

// ---------- the module ----------
function createAuth(dataDir) {
  const accounts = jsonStore(path.join(dataDir, 'accounts.json'), []);
  const sessions = jsonStore(path.join(dataDir, 'sessions.json'), {});
  const resets = jsonStore(path.join(dataDir, 'resets.json'), {}); // SHA-256 of a reset token -> { accountId, expiresAt }
  const failures = new Map(); // client address -> [timestamps]

  const now = () => new Date().toISOString();
  const tokenKey = t => crypto.createHash('sha256').update(String(t)).digest('hex');
  const uid = p => p + crypto.randomBytes(9).toString('base64url');
  const findAccount = id => accounts.get().find(a => a.id === id);
  // An account by its username or its email, either without regard to case.
  const lower = s => String(s || '').trim().toLowerCase();
  const byLogin = (login, type) => { const l = lower(login); return l ? accounts.get().find(a => (!type || a.type === type) && (lower(a.username) === l || (a.email && lower(a.email) === l))) : null; };
  // Usernames and emails are one name space: no account's username or email may be another's.
  function assertFree(name, exceptId) {
    const l = lower(name);
    if (l && accounts.get().some(a => a.id !== exceptId && (lower(a.username) === l || (a.email && lower(a.email) === l)))) {
      throw new AuthError(409, 'TAKEN', isEmail(name) ? 'That email address is already used by an account.' : 'That username is already taken. Try another.');
    }
  }
  // A username that is an email address is the account's email too, unless another is given.
  const emailFor = (username, email) => email !== undefined && email !== null ? email : (isEmail(username) ? username : null);

  // The same public shape the mock returned: never the hash.
  function publicAccount(a) {
    if (!a) return null;
    const { passwordHash, ...rest } = a;
    return rest;
  }
  function publicSession(s) {
    return { accountId: s.accountId, type: s.type, deviceType: s.deviceType, deviceId: s.deviceId || null, createdAt: s.createdAt, persistent: s.persistent, expiresAt: s.expiresAt };
  }

  function pruneSessions(all) {
    const t = Date.now();
    let changed = false;
    for (const k of Object.keys(all)) if (Date.parse(all[k].expiresAt) < t) { delete all[k]; changed = true; }
    return changed;
  }
  function dropSessionsWhere(test) {
    const all = Object.assign({}, sessions.get());
    for (const k of Object.keys(all)) if (test(all[k])) delete all[k];
    sessions.save(all);
  }
  const dropSessionsFor = accountId => dropSessionsWhere(s => s.accountId === accountId);

  // ---------- throttling ----------
  function recentFailures(addr) {
    const cutoff = Date.now() - FAIL_WINDOW_MS;
    const list = (failures.get(addr) || []).filter(t => t > cutoff);
    if (list.length) failures.set(addr, list); else failures.delete(addr);
    return list;
  }
  function throttle(addr) {
    const list = recentFailures(addr);
    if (list.length >= FAIL_LIMIT) {
      const mins = Math.max(1, Math.ceil((list[0] + FAIL_WINDOW_MS - Date.now()) / 60e3));
      throw new AuthError(429, 'TOO_MANY_ATTEMPTS', `Too many sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
  }
  const recordFailure = addr => failures.set(addr, recentFailures(addr).concat(Date.now()));

  return {
    AuthError,

    needsSetup: () => !accounts.get().some(a => a.type === 'master'),

    async createMaster({ displayName, username, password, email } = {}) {
      if (!this.needsSetup()) throw new AuthError(409, 'EXISTS', 'A master account already exists.');
      const name = checkName(displayName);
      const u = checkUsername(username);
      const e = emailFor(u, checkEmail(email));
      checkPassword(password, 'Password');
      const master = { id: 'acc_master', type: 'master', displayName: name, username: u, email: e, passwordHash: await hashPassword(password),
        deviceType: 'desktop', createdAt: now(), lastSeenAt: null, status: 'active' };
      if (!this.needsSetup()) throw new AuthError(409, 'EXISTS', 'A master account already exists.'); // lost a race while hashing
      accounts.save([master]);
      return publicAccount(master);
    },

    // One generic message for unknown user, wrong password, or wrong account type. A revoked or still
    // pending account is named only after its password checks out, so neither can be probed without it.
    // The username or the account's email both work (feedback round 1).
    // deviceId: the paired device signing in (Phase 2, 2-2). The session works only from that device.
    async signIn({ mode, username, password, stay, deviceType } = {}, addr, deviceId = null) {
      throttle(addr);
      const type = mode === 'master' ? 'master' : 'device';
      const acc = byLogin(username, type);
      const ok = await verifyPassword(String(password || ''), acc ? acc.passwordHash : await dummy());
      if (!acc || !ok) { recordFailure(addr); throw BAD_CREDENTIALS(); }
      if (acc.status === 'pending') throw new AuthError(403, 'PENDING', 'Your account is waiting for the master’s approval. Try again once it’s approved.');
      if (acc.status !== 'active') throw new AuthError(403, 'REVOKED', 'This device’s access has been revoked. Ask the master account to restore it.');
      failures.delete(addr);

      const dt = DEVICE_TYPES.includes(deviceType) ? deviceType : null;
      accounts.save(accounts.get().map(a => a.id === acc.id ? Object.assign({}, a, { lastSeenAt: now() }, dt ? { lastDeviceType: dt } : {}) : a));
      const token = crypto.randomBytes(32).toString('base64url');
      const t = Date.now();
      const s = { accountId: acc.id, type: acc.type, deviceType: dt, deviceId, createdAt: new Date(t).toISOString(), persistent: !!stay,
        expiresAt: new Date(t + (stay ? STAY_MS : BROWSER_SESSION_MS)).toISOString() };
      const all = Object.assign({}, sessions.get(), { [tokenKey(token)]: s });
      pruneSessions(all);
      sessions.save(all);
      return { token, maxAge: stay ? STAY_MS / 1000 : null, session: publicSession(s), account: publicAccount(findAccount(acc.id)) };
    },

    // The session behind a cookie token, or null. Expired sessions and inactive accounts end here.
    // A session belongs to the device it was signed in on: a copied cookie fails anywhere else.
    resolve(token, deviceId = null) {
      if (!token) return null;
      const key = tokenKey(token);
      const s = sessions.get()[key];
      if (!s || (s.deviceId || null) !== deviceId) return null;
      const acc = findAccount(s.accountId);
      if (Date.parse(s.expiresAt) < Date.now() || !acc || acc.status !== 'active') {
        const all = Object.assign({}, sessions.get()); delete all[key]; sessions.save(all);
        return null;
      }
      return { session: publicSession(s), account: publicAccount(acc) };
    },

    signOut(token) {
      if (!token) return;
      const all = Object.assign({}, sessions.get());
      delete all[tokenKey(token)];
      sessions.save(all);
    },

    // ---------- accounts ----------
    listAccounts: () => accounts.get().map(publicAccount),

    // The master adds an account (active at once); or someone signs up (feedback round 1): `pending`
    // until the master approves it. signedUpOn: the paired device it was made on.
    async createDevice({ displayName, username, password, deviceType, email } = {}, { pending = false, signedUpOn = null } = {}) {
      const name = checkName(displayName);
      const u = checkUsername(username);
      const e = emailFor(u, checkEmail(email));
      checkPassword(password, 'Password');
      const hash = await hashPassword(password);
      assertFree(u);
      if (e && lower(e) !== lower(u)) assertFree(e);
      const acc = { id: uid('acc_'), type: 'device', displayName: name, username: u, email: e, passwordHash: hash,
        deviceType: DEVICE_TYPES.includes(deviceType) ? deviceType : 'phone', createdAt: now(), lastSeenAt: null, status: pending ? 'pending' : 'active',
        ...(pending ? { signedUpOn } : {}) };
      accounts.save(accounts.get().concat(acc));
      return publicAccount(acc);
    },

    // The master approves a sign-up, or declines it (the account is removed).
    approve(id) {
      const acc = findAccount(id);
      if (!acc || acc.status !== 'pending') throw new AuthError(404, 'NOT_FOUND', 'No sign-up is waiting for that account.');
      accounts.save(accounts.get().map(a => a.id === id ? Object.assign({}, a, { status: 'active', approvedAt: now() }) : a));
      return publicAccount(findAccount(id));
    },
    decline(id) {
      const acc = findAccount(id);
      if (!acc || acc.status !== 'pending') throw new AuthError(404, 'NOT_FOUND', 'No sign-up is waiting for that account.');
      accounts.save(accounts.get().filter(a => a.id !== id));
      return publicAccount(acc);
    },
    pendingCount: () => accounts.get().filter(a => a.status === 'pending').length,

    updateDisplayName(id, displayName) { return this.updateProfile(id, { displayName }); },
    // Display name and/or email (feedback round 1). Either may be left out.
    updateProfile(id, { displayName, email } = {}) {
      const acc = findAccount(id);
      if (!acc) throw new AuthError(404, 'NOT_FOUND', 'Account not found.');
      const patch = {};
      if (displayName !== undefined) patch.displayName = checkName(displayName);
      const e = checkEmail(email);
      if (e !== undefined) { if (e) assertFree(e, id); patch.email = e; }
      accounts.save(accounts.get().map(a => a.id === id ? Object.assign({}, a, patch) : a));
      return publicAccount(findAccount(id));
    },

    // ---------- forgotten passwords (feedback round 1) ----------
    byLogin: login => publicAccount(byLogin(login)),
    // A one-time reset token for an account: random, kept only as its SHA-256, 30 minutes, and any
    // earlier one for the same account stops working.
    createReset(accountId) {
      const token = crypto.randomBytes(32).toString('base64url');
      const t = Date.now();
      const all = {};
      for (const [k, r] of Object.entries(resets.get())) if (r.accountId !== accountId && Date.parse(r.expiresAt) > t) all[k] = r;
      all[tokenKey(token)] = { accountId, expiresAt: new Date(t + RESET_MS).toISOString() };
      resets.save(all);
      return { token, expiresAt: all[tokenKey(token)].expiresAt };
    },
    // Uses a reset token: sets the new password and signs the account out everywhere. Once only.
    async useReset(token, next, addr) {
      throttle(addr);
      checkPassword(next, 'New password');
      const key = tokenKey(String(token || ''));
      const r = resets.get()[key];
      if (!r || Date.parse(r.expiresAt) < Date.now() || !findAccount(r.accountId)) {
        recordFailure(addr);
        throw new AuthError(400, 'BAD_TOKEN', 'That reset link has expired or was already used. Ask for a new one.');
      }
      const all = Object.assign({}, resets.get()); delete all[key]; resets.save(all);
      await this.setPassword(r.accountId, next);
      return publicAccount(findAccount(r.accountId));
    },
    // A new password without the old one (a reset, or the master resetting someone's): every session
    // of the account ends.
    async setPassword(id, next) {
      checkPassword(next, 'New password');
      if (!findAccount(id)) throw new AuthError(404, 'NOT_FOUND', 'Account not found.');
      const hash = await hashPassword(next);
      accounts.save(accounts.get().map(a => a.id === id ? Object.assign({}, a, { passwordHash: hash }) : a));
      dropSessionsFor(id);
    },

    // Changing a password ends every other session of that account; the caller's own stays.
    async changePassword(id, current, next, keepToken) {
      checkPassword(next, 'New password');
      const acc = findAccount(id);
      if (!acc || !(await verifyPassword(String(current || ''), acc.passwordHash))) throw new AuthError(400, 'BAD_CREDENTIALS', 'Your current password is incorrect.');
      const hash = await hashPassword(next);
      accounts.save(accounts.get().map(a => a.id === id ? Object.assign({}, a, { passwordHash: hash }) : a));
      const keep = keepToken ? tokenKey(keepToken) : null;
      const all = Object.assign({}, sessions.get());
      for (const k of Object.keys(all)) if (all[k].accountId === id && k !== keep) delete all[k];
      sessions.save(all);
    },

    // Revoking signs the device out everywhere at once.
    setDeviceStatus(id, status) {
      if (status !== 'active' && status !== 'revoked') throw new AuthError(400, 'INVALID', 'Unknown status.');
      const acc = findAccount(id);
      if (!acc || acc.type !== 'device') throw new AuthError(404, 'NOT_FOUND', 'That device no longer exists.');
      accounts.save(accounts.get().map(a => a.id === id ? Object.assign({}, a, { status }) : a));
      if (status === 'revoked') dropSessionsFor(id);
      return publicAccount(findAccount(id));
    },

    // Unpairing a device (Phase 2, 2-2) signs out everyone who signed in on it.
    dropDeviceSessions(deviceId) { dropSessionsWhere(s => s.deviceId === deviceId); },

    removeDevice(id) {
      const acc = findAccount(id);
      if (!acc || acc.type === 'master') throw new AuthError(403, 'FORBIDDEN', 'The master account can’t be deleted.');
      accounts.save(accounts.get().filter(a => a.id !== id));
      dropSessionsFor(id);
    }
  };
}

module.exports = { createAuth, AuthError, jsonStore, isEmail };
