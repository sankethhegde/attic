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
function checkName(s) {
  if (typeof s !== 'string' || !s.trim()) throw new AuthError(400, 'INVALID', 'Enter a display name.');
  if (s.trim().length > 64) throw new AuthError(400, 'INVALID', 'Display names are at most 64 characters.');
  return s.trim();
}

// ---------- the module ----------
function createAuth(dataDir) {
  const accounts = jsonStore(path.join(dataDir, 'accounts.json'), []);
  const sessions = jsonStore(path.join(dataDir, 'sessions.json'), {});
  const failures = new Map(); // client address -> [timestamps]

  const now = () => new Date().toISOString();
  const tokenKey = t => crypto.createHash('sha256').update(String(t)).digest('hex');
  const uid = p => p + crypto.randomBytes(9).toString('base64url');
  const findAccount = id => accounts.get().find(a => a.id === id);

  // The same public shape the mock returned: never the hash.
  function publicAccount(a) {
    if (!a) return null;
    const { passwordHash, ...rest } = a;
    return rest;
  }
  function publicSession(s) {
    return { accountId: s.accountId, type: s.type, deviceType: s.deviceType, createdAt: s.createdAt, persistent: s.persistent, expiresAt: s.expiresAt };
  }

  function pruneSessions(all) {
    const t = Date.now();
    let changed = false;
    for (const k of Object.keys(all)) if (Date.parse(all[k].expiresAt) < t) { delete all[k]; changed = true; }
    return changed;
  }
  function dropSessionsFor(accountId) {
    const all = Object.assign({}, sessions.get());
    for (const k of Object.keys(all)) if (all[k].accountId === accountId) delete all[k];
    sessions.save(all);
  }

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

    async createMaster({ displayName, username, password } = {}) {
      if (!this.needsSetup()) throw new AuthError(409, 'EXISTS', 'A master account already exists.');
      const name = checkName(displayName);
      const u = String(username || '').trim();
      if (!USERNAME.test(u)) throw new AuthError(400, 'INVALID', 'Usernames are 3–32 letters, numbers, dots, dashes or underscores.');
      checkPassword(password, 'Password');
      const master = { id: 'acc_master', type: 'master', displayName: name, username: u, passwordHash: await hashPassword(password),
        deviceType: 'desktop', createdAt: now(), lastSeenAt: null, status: 'active' };
      if (!this.needsSetup()) throw new AuthError(409, 'EXISTS', 'A master account already exists.'); // lost a race while hashing
      accounts.save([master]);
      return publicAccount(master);
    },

    // One generic message for unknown user, wrong password, or wrong account type. A revoked account is
    // named only after its password checks out, so revocation can't be probed without the password.
    async signIn({ mode, username, password, stay, deviceType } = {}, addr) {
      throttle(addr);
      const u = String(username || '').trim().toLowerCase();
      const type = mode === 'master' ? 'master' : 'device';
      const acc = accounts.get().find(a => a.username.toLowerCase() === u && a.type === type);
      const ok = await verifyPassword(String(password || ''), acc ? acc.passwordHash : await dummy());
      if (!acc || !ok) { recordFailure(addr); throw BAD_CREDENTIALS(); }
      if (acc.status !== 'active') throw new AuthError(403, 'REVOKED', 'This device’s access has been revoked. Ask the master account to restore it.');
      failures.delete(addr);

      const dt = DEVICE_TYPES.includes(deviceType) ? deviceType : null;
      accounts.save(accounts.get().map(a => a.id === acc.id ? Object.assign({}, a, { lastSeenAt: now() }, dt ? { lastDeviceType: dt } : {}) : a));
      const token = crypto.randomBytes(32).toString('base64url');
      const t = Date.now();
      const s = { accountId: acc.id, type: acc.type, deviceType: dt, createdAt: new Date(t).toISOString(), persistent: !!stay,
        expiresAt: new Date(t + (stay ? STAY_MS : BROWSER_SESSION_MS)).toISOString() };
      const all = Object.assign({}, sessions.get(), { [tokenKey(token)]: s });
      pruneSessions(all);
      sessions.save(all);
      return { token, maxAge: stay ? STAY_MS / 1000 : null, session: publicSession(s), account: publicAccount(findAccount(acc.id)) };
    },

    // The session behind a cookie token, or null. Expired sessions and inactive accounts end here.
    resolve(token) {
      if (!token) return null;
      const key = tokenKey(token);
      const s = sessions.get()[key];
      if (!s) return null;
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

    async createDevice({ displayName, username, password, deviceType } = {}) {
      const name = checkName(displayName);
      const u = String(username || '').trim();
      if (!USERNAME.test(u)) throw new AuthError(400, 'INVALID', 'Usernames are 3–32 letters, numbers, dots, dashes or underscores.');
      checkPassword(password, 'Password');
      const hash = await hashPassword(password);
      if (accounts.get().some(a => a.username.toLowerCase() === u.toLowerCase())) throw new AuthError(409, 'TAKEN', 'That username is already taken. Try another.');
      const acc = { id: uid('acc_'), type: 'device', displayName: name, username: u, passwordHash: hash,
        deviceType: DEVICE_TYPES.includes(deviceType) ? deviceType : 'phone', createdAt: now(), lastSeenAt: null, status: 'active' };
      accounts.save(accounts.get().concat(acc));
      return publicAccount(acc);
    },

    updateDisplayName(id, displayName) {
      const name = checkName(displayName);
      if (!findAccount(id)) throw new AuthError(404, 'NOT_FOUND', 'Account not found.');
      accounts.save(accounts.get().map(a => a.id === id ? Object.assign({}, a, { displayName: name }) : a));
      return publicAccount(findAccount(id));
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

    removeDevice(id) {
      const acc = findAccount(id);
      if (!acc || acc.type === 'master') throw new AuthError(403, 'FORBIDDEN', 'The master account can’t be deleted.');
      accounts.save(accounts.get().filter(a => a.id !== id));
      dropSessionsFor(id);
    }
  };
}

module.exports = { createAuth, AuthError };
