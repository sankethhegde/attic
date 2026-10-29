// api.js — the ONLY module that touches storage. No screen reads localStorage or calls fetch.
// Phase 1A: reads browser storage with a 100–300ms delay. Phase 1B: these bodies become HTTP calls.
// Every function returns a promise and every one can fail.
//
// MOCK AUTHENTICATION — NOT SECURE. Everything here is readable and editable from dev tools.
// Phase 1B deletes the auth code below and rewrites it server-side. Do not port it.
(function (root) {
  'use strict';
  const U = root.Attic.util;
  const idb = root.Attic.idb;

  const K = { accounts: 'fs.accounts', session: 'fs.session', settings: 'fs.settings', shares: 'fs.shares', index: 'fs.mockIndex' };
  const DAY = 864e5;
  const MAX_CUSTOM_BG = 10, MAX_BG_BYTES = 5e6;
  const BG_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  const BUNDLED_BG = [
    { id: 'b:dawn-ridge', name: 'Dawn ridge', url: 'assets/bg/dawn-ridge.svg', bundled: true },
    { id: 'b:night-hills', name: 'Night hills', url: 'assets/bg/night-hills.svg', bundled: true },
    { id: 'b:lake-dusk', name: 'Lake at dusk', url: 'assets/bg/lake-dusk.svg', bundled: true },
    { id: 'b:pine-mist', name: 'Pine mist', url: 'assets/bg/pine-mist.svg', bundled: true },
    { id: 'b:desert-dunes', name: 'Desert dunes', url: 'assets/bg/desert-dunes.svg', bundled: true }
  ];

  const DEFAULT_SETTINGS = {
    theme: 'system',
    background: { mode: 'shuffle', interval: 30, selected: null },
    filesView: 'list',
    devicesView: 'list',
    otherView: 'list',
    photoSize: 'm',
    thisDevice: null, // null = detect automatically; otherwise phone | tablet | laptop | desktop
    dev: { failRate: 0 }
  };

  class ApiError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  // ---------- storage primitives (private) ----------
  function read(key, fallback, store) {
    try { const v = (store || localStorage).getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function write(key, value, store) {
    try { (store || localStorage).setItem(key, JSON.stringify(value)); }
    catch (e) { throw new ApiError('STORAGE_FULL', 'Browser storage is full. Clear some data in Settings and try again.'); }
  }
  const now = () => new Date().toISOString();
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const clone = o => JSON.parse(JSON.stringify(o));

  function settings() {
    const s = read(K.settings, {});
    return Object.assign(clone(DEFAULT_SETTINGS), s, {
      background: Object.assign({}, DEFAULT_SETTINGS.background, s.background),
      dev: Object.assign({}, DEFAULT_SETTINGS.dev, s.dev)
    });
  }

  // Simulated latency, plus an on-demand failure rate so error paths get exercised.
  function delay(canFail) {
    const ms = 100 + Math.random() * 200;
    const rate = settings().dev.failRate || 0;
    return new Promise((resolve, reject) => setTimeout(() => {
      if (canFail && Math.random() < rate) reject(new ApiError('SIMULATED', 'Couldn’t reach the server. Try again.'));
      else resolve();
    }, ms));
  }

  // ---------- mock index and ownership ----------
  // The raw index is private. Every endpoint reads files through visibleIndex(session) — never rawIndex —
  // so a forgotten owner filter is impossible rather than merely unlikely.
  let cache = null; // { data, version } — version bumps on every commit so scoped views rebuild
  let indexVersion = 0;
  function rawIndex() {
    if (cache) return cache.data;
    let data = read(K.index, null);
    if (!data || data.version !== root.Attic.mock.VERSION) {
      const g = root.Attic.mock.generate({ accounts: accounts() });
      data = { version: g.version, seed: g.seed, generatedAt: g.generatedAt, entries: g.entries };
      write(K.index, data);
    }
    cache = { data };
    indexVersion++;
    return data;
  }

  // The only way any endpoint reads files. Masters see everything; a device sees its own files and the
  // common space (ownerId null). Folders show only when they lead to something visible, or are empty for everyone.
  function visibleIndex(session) {
    if (!session) return [];
    const raw = rawIndex();
    const key = session.type + ':' + session.accountId + '@' + indexVersion;
    if (cache.scoped && cache.scoped.key === key) return cache.scoped.entries;
    let entries;
    if (session.type === 'master') entries = raw.entries;
    else {
      const files = raw.entries.filter(e => e.kind === 'file' && (e.ownerId === session.accountId || e.ownerId === null));
      const leadsToVisible = new Set(), hasFiles = new Set();
      const ancestors = (e, set) => { const parts = e.path ? e.path.split('/') : []; for (let i = 1; i <= parts.length; i++) set.add(e.share + '/' + parts.slice(0, i).join('/')); };
      for (const e of raw.entries) if (e.kind === 'file') ancestors(e, hasFiles);
      for (const e of files) ancestors(e, leadsToVisible);
      entries = raw.entries.filter(e => {
        if (e.kind === 'file') return e.ownerId === session.accountId || e.ownerId === null;
        const full = e.share + '/' + U.joinPath(e.path, e.name);
        return leadsToVisible.has(full) || !hasFiles.has(full);
      });
    }
    cache.scoped = { key, entries };
    return entries;
  }

  // Lookup maps over a scoped list (built from visibleIndex output, never from the raw index).
  function view(session) {
    const entries = visibleIndex(session);
    if (cache.view && cache.view.entries === entries) return cache.view;
    const byId = new Map(), children = new Map(), folders = new Set();
    for (const e of entries) {
      byId.set(e.id, e);
      const k = e.share + '/' + e.path;
      if (!children.has(k)) children.set(k, []);
      children.get(k).push(e);
      if (e.kind === 'folder') folders.add(e.share + '/' + U.joinPath(e.path, e.name));
    }
    cache.view = { entries, byId, children, folders, generatedAt: cache.data.generatedAt };
    return cache.view;
  }

  // Ownership changes are all-or-nothing: build the new list, write it once, and only then swap it in.
  // A write that fails leaves the stored index and the cache exactly as they were.
  function commit(session, entries) {
    requireMaster(session);
    const data = Object.assign({}, cache.data, { entries });
    write(K.index, data);
    cache = { data };
    indexVersion++;
  }

  // Accounts and ownership change together or not at all.
  function commitWithAccounts(session, nextAccounts, nextEntries) {
    const before = accounts();
    saveAccounts(nextAccounts);
    try { commit(session, nextEntries); }
    catch (e) { saveAccounts(before); throw e; }
  }

  function sessionOrThrow() {
    const s = currentSession();
    if (!s) throw new ApiError('SIGNED_OUT', 'Your session has ended. Sign in again.');
    return s;
  }
  function requireMaster(session) {
    if (!session || session.type !== 'master') throw new ApiError('FORBIDDEN', 'Only the master account can do that.');
  }

  function shares() {
    let s = read(K.shares, null);
    if (!s) { s = root.Attic.mock.defaultShares(); write(K.shares, s); }
    return s;
  }
  function shareOrThrow(id) {
    const s = shares().find(x => x.id === id);
    if (!s) throw new ApiError('NOT_FOUND', 'That share no longer exists.');
    if (!s.available) throw new ApiError('UNAVAILABLE', `${s.name} is unavailable. Check the drive is connected.`);
    return s;
  }

  // ---------- session helpers ----------
  function accounts() { return read(K.accounts, []); }
  function saveAccounts(a) { write(K.accounts, a); }
  function publicAccount(a) {
    if (!a) return null;
    const { password_PLAINTEXT_MOCK_ONLY, ...rest } = a;
    return rest;
  }
  function currentSession() {
    const s = read(K.session, null) || read(K.session, null, sessionStorage);
    if (!s) return null;
    if (s.expiresAt && Date.parse(s.expiresAt) < Date.now()) { clearSession(); return null; }
    const acc = accounts().find(a => a.id === s.accountId);
    if (!acc || acc.status !== 'active') { clearSession(); return null; }
    return s;
  }
  function clearSession() {
    try { localStorage.removeItem(K.session); sessionStorage.removeItem(K.session); } catch (e) { /* ignore */ }
  }

  // ---------- aggregation (kept unchanged for real data in Phase 1B) ----------
  function aggregate(entries, shareList) {
    const per = {};
    for (const s of shareList) per[s.id] = { used: 0, count: 0, byCategory: {} };
    for (const e of entries) {
      if (e.kind !== 'file' || !per[e.share]) continue;
      const p = per[e.share];
      p.used += e.size; p.count++;
      const c = p.byCategory[e.category] || (p.byCategory[e.category] = { size: 0, count: 0 });
      c.size += e.size; c.count++;
    }
    const totals = { used: 0, total: 0, count: 0, byCategory: {} };
    const shareRows = shareList.map(s => {
      const p = per[s.id];
      totals.used += p.used; totals.total += s.totalBytes; totals.count += p.count;
      for (const c in p.byCategory) {
        const t = totals.byCategory[c] || (totals.byCategory[c] = { size: 0, count: 0 });
        t.size += p.byCategory[c].size; t.count += p.byCategory[c].count;
      }
      return { id: s.id, name: s.name, deviceType: s.deviceType, rootPath: s.rootPath, available: s.available, lastSeenAt: s.lastSeenAt,
        used: p.used, total: s.totalBytes, free: Math.max(0, s.totalBytes - p.used), count: p.count, byCategory: p.byCategory };
    });
    // Categories under 2% of used space fold into Other: segments that thin can't be clicked.
    const segments = [], collapsed = [];
    let other = Object.assign({ size: 0, count: 0 }, totals.byCategory.other);
    for (const c of U.CATEGORY_ORDER) {
      if (c === 'other') continue;
      const v = totals.byCategory[c];
      if (!v) continue;
      if (v.size / totals.used < 0.02) { collapsed.push(Object.assign({ category: c }, v)); other.size += v.size; other.count += v.count; }
      else segments.push(Object.assign({ category: c }, v));
    }
    if (other.size || other.count) segments.push(Object.assign({ category: 'other', collapsed }, other));
    return { totals, shares: shareRows, segments, collapsed };
  }

  function ownerTotals(entries) {
    const m = new Map();
    for (const e of entries) {
      if (e.kind !== 'file') continue;
      const t = m.get(e.ownerId) || { count: 0, bytes: 0 };
      t.count++; t.bytes += e.size;
      m.set(e.ownerId, t);
    }
    return m;
  }
  // A custodian is the master or another active account — never the account being revoked or removed.
  function checkCustodian(list, custodianId, leavingId) {
    const c = list.find(a => a.id === custodianId) || list.find(a => a.type === 'master');
    if (!c || c.id === leavingId || c.status !== 'active') throw new ApiError('INVALID', 'Choose the master or another active account to hold these files.');
    return c;
  }

  function matchQuery(name, q) { return !q || name.toLowerCase().includes(q.toLowerCase()); }

  // =====================================================================
  const api = {
    ApiError,
    MAX_CUSTOM_BG,
    MAX_BG_BYTES,

    // ---------- first run ----------
    async needsSetup() {
      await delay(false);
      return !accounts().some(a => a.type === 'master');
    },

    async createMaster({ displayName, username, password }) {
      await delay(false);
      if (accounts().some(a => a.type === 'master')) throw new ApiError('EXISTS', 'A master account already exists.');
      const t = now();
      const master = { id: 'acc_master', type: 'master', displayName, username: username.trim(), password_PLAINTEXT_MOCK_ONLY: password,
        deviceType: 'desktop', createdAt: t, lastSeenAt: null, status: 'active' };
      // Seed a few device accounts so the device list has something to show. Placeholder passwords only.
      const ago = d => new Date(Date.now() - d * DAY).toISOString();
      const devices = [
        { displayName: 'Pixel 8', username: 'phone', deviceType: 'phone', createdAt: ago(40), lastSeenAt: ago(0.1), status: 'active' },
        { displayName: 'Work laptop', username: 'worklaptop', deviceType: 'laptop', createdAt: ago(38), lastSeenAt: ago(2), status: 'active' },
        { displayName: 'Galaxy Tab', username: 'tablet', deviceType: 'tablet', createdAt: ago(25), lastSeenAt: ago(9), status: 'active' },
        { displayName: 'Old phone', username: 'oldphone', deviceType: 'phone', createdAt: ago(300), lastSeenAt: ago(120), status: 'revoked' }
      ].map(d => Object.assign({ id: uid('acc_'), type: 'device', password_PLAINTEXT_MOCK_ONLY: 'test1234' }, d));
      saveAccounts([master, ...devices]);
      // The index is generated lazily on first read, with these accounts as owners.
      try { localStorage.removeItem(K.index); } catch (e) { /* ignore */ }
      cache = null;
      return publicAccount(master);
    },

    // ---------- session (MOCK — authenticates nobody) ----------
    async signIn({ mode, username, password, stay, deviceType }) {
      await delay(false);
      const u = (username || '').trim().toLowerCase();
      const list = accounts();
      const acc = list.find(a => a.username.toLowerCase() === u && a.type === (mode === 'master' ? 'master' : 'device'));
      // One generic message: never reveal which half was wrong.
      if (!acc || acc.password_PLAINTEXT_MOCK_ONLY !== password) throw new ApiError('BAD_CREDENTIALS', 'Incorrect username or password');
      if (acc.status !== 'active') throw new ApiError('REVOKED', 'This device’s access has been revoked. Ask the master account to restore it.');
      acc.lastSeenAt = now();
      if (deviceType) acc.lastDeviceType = deviceType;
      saveAccounts(list);
      const t = Date.now();
      const session = { accountId: acc.id, type: acc.type, deviceType: deviceType || null, createdAt: new Date(t).toISOString(), persistent: !!stay,
        expiresAt: stay ? new Date(t + 30 * DAY).toISOString() : null };
      clearSession();
      write(K.session, session, stay ? localStorage : sessionStorage);
      return { session, account: publicAccount(acc) };
    },

    // MOCK ONLY: lists accounts on the login screen so testers can find them. Delete in Phase 1B —
    // a real server never tells an unauthenticated visitor which usernames exist.
    async listTestAccounts() {
      await delay(false);
      return accounts().map(a => ({ type: a.type, username: a.username, displayName: a.displayName, deviceType: a.deviceType, status: a.status,
        placeholderPassword: a.type === 'device' && a.password_PLAINTEXT_MOCK_ONLY === 'test1234' }));
    },

    async getSession() {
      await delay(false);
      const s = currentSession();
      if (!s) return null;
      return { session: s, account: publicAccount(accounts().find(a => a.id === s.accountId)) };
    },

    async signOut() {
      await delay(false);
      clearSession();
    },

    // ---------- accounts ----------
    // Master only. Each device carries its totals, so the revoke dialog's figures are never the first time they appear.
    async listDevices() {
      await delay(true);
      const session = sessionOrThrow();
      requireMaster(session);
      const totals = ownerTotals(visibleIndex(session));
      return accounts().filter(a => a.type === 'device').map(a => Object.assign(publicAccount(a), { owned: totals.get(a.id) || { count: 0, bytes: 0 } }))
        .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) || (b.lastSeenAt || '').localeCompare(a.lastSeenAt || ''));
    },

    // Master only: every account that can own files, for owner columns, filters and custodian pickers.
    async listOwners() {
      await delay(true);
      const session = sessionOrThrow();
      requireMaster(session);
      return accounts().map(a => ({ id: a.id, displayName: a.displayName, username: a.username, type: a.type, deviceType: a.deviceType, status: a.status }));
    },

    // File count and bytes an account owns now, and what it uploaded that someone else holds in custody.
    async ownershipSummary(accountId) {
      await delay(true);
      const session = sessionOrThrow();
      requireMaster(session);
      const owned = { count: 0, bytes: 0 }, inCustody = { count: 0, bytes: 0 };
      for (const e of visibleIndex(session)) {
        if (e.kind !== 'file') continue;
        if (e.ownerId === accountId) { owned.count++; owned.bytes += e.size; }
        if (e.uploadedBy === accountId && e.ownerId !== accountId) { inCustody.count++; inCustody.bytes += e.size; }
      }
      return { accountId, owned, inCustody };
    },

    // Revoke: every file the account owns goes to the custodian; uploadedBy is untouched so restore can return it.
    async revokeDevice(id, custodianId) {
      await delay(true);
      const session = sessionOrThrow();
      requireMaster(session);
      const list = accounts();
      const acc = list.find(a => a.id === id && a.type === 'device');
      if (!acc) throw new ApiError('NOT_FOUND', 'That device no longer exists.');
      const custodian = checkCustodian(list, custodianId, id);
      let moved = 0, bytes = 0;
      const next = visibleIndex(session).map(e => {
        if (e.kind !== 'file' || e.ownerId !== id) return e;
        moved++; bytes += e.size;
        return Object.assign({}, e, { ownerId: custodian.id });
      });
      acc.status = 'revoked';
      commitWithAccounts(session, list, next);
      return { account: publicAccount(acc), moved: { count: moved, bytes }, custodian: publicAccount(custodian) };
    },

    // Restore: files this account uploaded that someone else still holds come back. Cleared uploadedBy means
    // nothing returns — zero is a correct answer, not a failure.
    async restoreDevice(id) {
      await delay(true);
      const session = sessionOrThrow();
      requireMaster(session);
      const list = accounts();
      const acc = list.find(a => a.id === id && a.type === 'device');
      if (!acc) throw new ApiError('NOT_FOUND', 'That device no longer exists.');
      let returned = 0, bytes = 0;
      const next = visibleIndex(session).map(e => {
        if (e.kind !== 'file' || e.uploadedBy !== id || e.ownerId === id) return e;
        returned++; bytes += e.size;
        return Object.assign({}, e, { ownerId: id });
      });
      acc.status = 'active';
      commitWithAccounts(session, list, next);
      return { account: publicAccount(acc), returned: { count: returned, bytes } };
    },

    // Kept for callers that only flip status; revoking always needs a custodian.
    async setDeviceStatus(id, status, custodianId) {
      if (status === 'revoked') return (await api.revokeDevice(id, custodianId)).account;
      return (await api.restoreDevice(id)).account;
    },

    // Master only: end the uploader's claim on these files. The only change to uploadedBy besides removal.
    async reassignPermanently(fileIds) {
      await delay(true);
      const session = sessionOrThrow();
      requireMaster(session);
      const ids = new Set(fileIds);
      let cleared = 0;
      const next = visibleIndex(session).map(e => {
        if (!ids.has(e.id) || e.uploadedBy == null || e.uploadedBy === e.ownerId) return e;
        cleared++;
        return Object.assign({}, e, { uploadedBy: null });
      });
      commit(session, next);
      return { cleared };
    },

    async createDevice({ displayName, username, password, deviceType }) {
      await delay(true);
      const list = accounts();
      const u = username.trim();
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(u)) throw new ApiError('INVALID', 'Usernames are 3–32 letters, numbers, dots, dashes or underscores.');
      if (list.some(a => a.username.toLowerCase() === u.toLowerCase())) throw new ApiError('TAKEN', 'That username is already taken. Try another.');
      const acc = { id: uid('acc_'), type: 'device', displayName: displayName.trim(), username: u, password_PLAINTEXT_MOCK_ONLY: password,
        deviceType, createdAt: now(), lastSeenAt: null, status: 'active' };
      list.push(acc);
      saveAccounts(list);
      return publicAccount(acc);
    },

    // Remove: permanent. Owned files go to the custodian, and every uploadedBy pointing at this account is
    // cleared — nothing can be returned to an account that no longer exists.
    async removeDevice(id, custodianId) {
      await delay(true);
      const session = sessionOrThrow();
      requireMaster(session);
      const list = accounts();
      const acc = list.find(a => a.id === id);
      if (!acc || acc.type === 'master') throw new ApiError('FORBIDDEN', 'The master account can’t be deleted.');
      const custodian = checkCustodian(list, custodianId, id);
      let moved = 0, bytes = 0;
      const next = visibleIndex(session).map(e => {
        if (e.kind !== 'file' || (e.ownerId !== id && e.uploadedBy !== id)) return e;
        const out = Object.assign({}, e);
        if (e.ownerId === id) { out.ownerId = custodian.id; moved++; bytes += e.size; }
        if (e.uploadedBy === id) out.uploadedBy = null;
        return out;
      });
      commitWithAccounts(session, list.filter(a => a.id !== id), next);
      return { moved: { count: moved, bytes }, custodian: publicAccount(custodian) };
    },

    async updateDisplayName(id, displayName) {
      await delay(true);
      const list = accounts();
      const acc = list.find(a => a.id === id);
      if (!acc) throw new ApiError('NOT_FOUND', 'Account not found.');
      acc.displayName = displayName.trim();
      saveAccounts(list);
      return publicAccount(acc);
    },

    async changePassword(id, current, next) {
      await delay(true);
      const list = accounts();
      const acc = list.find(a => a.id === id);
      if (!acc || acc.password_PLAINTEXT_MOCK_ONLY !== current) throw new ApiError('BAD_CREDENTIALS', 'Your current password is incorrect.');
      acc.password_PLAINTEXT_MOCK_ONLY = next;
      saveAccounts(list);
    },

    // ---------- shares ----------
    // Figures come from the caller's visible files. A device gets no drive capacity or free space:
    // those would reveal how much other accounts store.
    async listShares() {
      await delay(true);
      const session = sessionOrThrow();
      const agg = aggregate(visibleIndex(session), shares());
      if (session.type === 'master') return agg.shares;
      return agg.shares.map(s => Object.assign({}, s, { total: null, free: null, scope: 'visible' }));
    },

    async saveShare(share) {
      await delay(true);
      const list = shares();
      if (!share.name.trim()) throw new ApiError('INVALID', 'Enter a share name.');
      if (share.id) {
        const s = list.find(x => x.id === share.id);
        if (!s) throw new ApiError('NOT_FOUND', 'That share no longer exists.');
        Object.assign(s, { name: share.name.trim(), rootPath: share.rootPath.trim(), deviceType: share.deviceType });
      } else {
        list.push({ id: uid('sh_'), name: share.name.trim(), rootPath: share.rootPath.trim(), deviceType: share.deviceType || 'hdd',
          totalBytes: 500e9, available: true, lastSeenAt: now() });
      }
      write(K.shares, list);
    },

    async removeShare(id) {
      await delay(true);
      write(K.shares, shares().filter(s => s.id !== id));
    },

    async setShareAvailable(id, available) {
      await delay(false);
      const list = shares();
      const s = list.find(x => x.id === id);
      if (!s) throw new ApiError('NOT_FOUND', 'That share no longer exists.');
      if (s.available && !available) s.lastSeenAt = now();
      s.available = available;
      if (available) s.lastSeenAt = now();
      write(K.shares, list);
    },

    // ---------- files ----------
    async listFolder(shareId, path) {
      await delay(true);
      const share = shareOrThrow(shareId);
      const ix = view(sessionOrThrow());
      if (path && !ix.folders.has(shareId + '/' + path)) throw new ApiError('NOT_FOUND', 'This folder doesn’t exist any more.');
      return { share: { id: share.id, name: share.name }, path, items: (ix.children.get(shareId + '/' + path) || []).slice() };
    },

    async getFile(id) {
      await delay(true);
      const e = view(sessionOrThrow()).byId.get(id);
      if (!e) throw new ApiError('NOT_FOUND', 'File not found.');
      return Object.assign({}, e);
    },

    // Photos, Videos and Other are filtered views over the same index — not separate storage.
    async listByTab(tab, { share, query } = {}) {
      await delay(true);
      const avail = new Set(shares().filter(s => s.available).map(s => s.id));
      return visibleIndex(sessionOrThrow()).filter(e => e.kind === 'file' && avail.has(e.share) && U.tabOf(e.category) === tab &&
        (!share || e.share === share) && matchQuery(e.name, query));
    },

    // Master only. Adds the breakdown by owner alongside the breakdown by type.
    async getStorage() {
      await delay(true);
      const session = sessionOrThrow();
      requireMaster(session);
      const entries = visibleIndex(session);
      const agg = aggregate(entries, shares());
      const names = new Map(accounts().map(a => [a.id, a]));
      agg.byOwner = [...ownerTotals(entries)].map(([id, t]) => {
        const a = id && names.get(id);
        return { ownerId: id, name: id === null ? 'Common' : a ? a.displayName : 'Removed account', type: id === null ? 'common' : a ? a.type : 'unknown',
          status: a ? a.status : null, count: t.count, bytes: t.bytes };
      }).sort((a, b) => b.bytes - a.bytes);
      agg.custody = entries.filter(e => e.kind === 'file' && e.uploadedBy && e.ownerId !== e.uploadedBy).length;
      agg.checkedAt = now();
      return agg;
    },

    async getCategoryDetail(category) {
      await delay(true);
      const session = sessionOrThrow();
      requireMaster(session);
      const list = shares();
      const entries = visibleIndex(session);
      const agg = aggregate(entries, list);
      const seg = agg.segments.find(s => s.category === category);
      const cats = new Set([category]);
      if (category === 'other' && seg) seg.collapsed.forEach(c => cats.add(c.category));
      const files = entries.filter(e => e.kind === 'file' && cats.has(e.category)).sort((a, b) => b.size - a.size);
      const byShare = {}, byExt = {};
      let total = 0;
      for (const f of files) {
        total += f.size;
        (byShare[f.share] = byShare[f.share] || { size: 0, count: 0 }); byShare[f.share].size += f.size; byShare[f.share].count++;
        const x = f.ext || '(none)';
        (byExt[x] = byExt[x] || { size: 0, count: 0 }); byExt[x].size += f.size; byExt[x].count++;
      }
      return {
        category, includes: [...cats], total, count: files.length, used: agg.totals.used, files,
        byShare: list.map(s => Object.assign({ id: s.id, name: s.name, available: s.available }, byShare[s.id] || { size: 0, count: 0 })).filter(s => s.count),
        byExt: Object.entries(byExt).map(([ext, v]) => Object.assign({ ext }, v)).sort((a, b) => b.size - a.size)
      };
    },

    // ---------- upload (simulated: nothing is stored) ----------
    validateUpload(file) {
      if (file.size === 0) return 'Empty file. Nothing to upload.';
      if (file.size > 20e9) return 'Too large. The limit is 20 GB per file.';
      if (/\.(lnk|tmp|crdownload|part)$/i.test(file.name)) return 'This file type can’t be uploaded.';
      return null;
    },

    simulateUpload(file, onProgress) {
      let done = 0, cancelled = false;
      const total = file.size;
      const speed = 25e6 + Math.random() * 60e6; // bytes per second, pretend
      return {
        cancel() { cancelled = true; },
        promise: new Promise((resolve, reject) => {
          const tick = () => {
            if (cancelled) return reject(new ApiError('CANCELLED', 'Cancelled'));
            done = Math.min(total, done + speed * 0.2 + total * 0.04);
            onProgress(done / total);
            if (done >= total) resolve({ name: file.name, size: file.size, stored: false });
            else setTimeout(tick, 200);
          };
          setTimeout(tick, 200);
        })
      };
    },

    // ---------- settings ----------
    async getSettings() {
      await delay(false);
      return settings();
    },

    async updateSettings(patch) {
      await delay(false);
      const s = settings();
      for (const k in patch) {
        if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k])) s[k] = Object.assign({}, s[k], patch[k]);
        else s[k] = patch[k];
      }
      write(K.settings, s);
      return s;
    },

    // ---------- backgrounds ----------
    async listBackgrounds() {
      await delay(false);
      let custom = [];
      try {
        custom = (await idb.all()).sort((a, b) => a.addedAt.localeCompare(b.addedAt))
          .map(r => ({ id: r.id, name: r.name, size: r.size, bundled: false, blob: r.blob }));
      } catch (e) { /* storage cleared or unavailable: bundled only */ }
      return BUNDLED_BG.concat(custom);
    },

    async addBackground(file) {
      await delay(false);
      if (!BG_TYPES.includes(file.type)) throw new ApiError('TYPE', `${file.name} isn’t a JPG, PNG or WebP image.`);
      if (file.size > MAX_BG_BYTES) throw new ApiError('TOO_LARGE', `${file.name} is ${U.formatBytes(file.size)}. Images must be 5 MB or smaller.`);
      const existing = await idb.all().catch(() => []);
      if (existing.length >= MAX_CUSTOM_BG) throw new ApiError('LIMIT', `You can keep up to ${MAX_CUSTOM_BG} custom images. Remove one to add another.`);
      const rec = { id: uid('c:'), name: file.name, size: file.size, type: file.type, blob: file, addedAt: now() };
      try { await idb.put(rec); }
      catch (e) { throw new ApiError('STORAGE_FULL', 'The browser refused to store this image. It may be out of storage space.'); }
      return { id: rec.id, name: rec.name, size: rec.size, bundled: false, blob: rec.blob };
    },

    async removeBackground(id) {
      await delay(false);
      if (id.startsWith('b:')) throw new ApiError('FORBIDDEN', 'Bundled images can’t be removed.');
      await idb.remove(id);
      const s = settings();
      if (s.background.selected === id) { s.background.selected = null; write(K.settings, s); }
    },

    // ---------- advanced ----------
    async exportSettings() {
      await delay(false);
      return { app: 'Attic', kind: 'settings', version: 1, exportedAt: now(), settings: settings(), shares: shares() };
    },

    async importSettings(data) {
      await delay(false);
      if (!data || data.app !== 'Attic' || data.kind !== 'settings') throw new ApiError('INVALID', 'That file isn’t an Attic settings export.');
      if (data.settings) write(K.settings, Object.assign(clone(DEFAULT_SETTINGS), data.settings));
      if (Array.isArray(data.shares)) write(K.shares, data.shares);
    },

    async clearAllData() {
      await delay(false);
      for (const store of [localStorage, sessionStorage]) {
        Object.keys(store).filter(k => k.startsWith('fs.')).forEach(k => store.removeItem(k));
      }
      await idb.destroy();
      cache = null;
    },

    async indexInfo() {
      await delay(false);
      const ix = view(sessionOrThrow());
      return { entries: ix.entries.length, generatedAt: ix.generatedAt };
    }
  };

  root.Attic.api = api;
})(window);
