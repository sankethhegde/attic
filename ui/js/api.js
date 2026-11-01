// api.js — the ONLY module that touches storage. No screen reads localStorage or calls fetch.
// Every function returns a promise and every one can fail.
//
// Phase 1C: accounts, passwords, sessions, shares, files and ownership are the HP server's. Phase 2, 2-2:
// pairing and the device list are too. Transfers (and the sample devices they name) are still a browser
// mock until 2-4 and 2-5.
(function (root) {
  'use strict';
  const U = root.Attic.util;
  const idb = root.Attic.idb;

  const K = { settings: 'fs.settings', hub: 'fs.mockHub' };
  // Left behind by the browser mock of Phase 1A–1C: the generated file index (a few MB) and its shares.
  try { ['fs.mockIndex', 'fs.shares', 'fs.accounts', 'fs.session'].forEach(k => localStorage.removeItem(k)); } catch (e) { /* storage blocked */ }
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

  // ---------- server ----------
  // The session lives in an HttpOnly cookie this code never sees. `me` is what the server last said about
  // it; `known` is the account list the mock reads for owners and devices (all accounts for the master,
  // just your own for a device).
  let me = null, known = [];

  async function http(method, url, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts).catch(() => null);
    if (!res) throw new ApiError('UNREACHABLE', 'Could not reach the server.');
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && url !== '/api/session') { me = null; known = []; }
      // Unpaired on the HP (Phase 2, 2-2): the app goes back to the pairing screen.
      if (res.status === 403 && data && data.code === 'NOT_PAIRED') {
        me = null; known = [];
        root.dispatchEvent(new CustomEvent('attic:not-paired'));
      }
      throw new ApiError((data && data.code) || 'SERVER', (data && data.message) || 'Something went wrong on the server.');
    }
    return data;
  }

  async function adopt(who) {
    me = who || null;
    known = !me ? [] : me.session.type === 'master' ? await http('GET', '/api/accounts') : [me.account];
    return me;
  }
  async function refreshAccounts() {
    if (me && me.session.type === 'master') known = await http('GET', '/api/accounts');
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

  // ---------- the file index (the HP's: milestone 6) ----------
  // Every file the signed-in account may see, across all shares. The server does the scoping — a device
  // only ever receives its own files and the common space — so there is no unscoped list here to misuse.
  // Kept for a few seconds so moving between tabs doesn't re-fetch; dropped after anything that changes
  // files or owners.
  let index = null; // { at, data: { generatedAt, entries } }
  async function fileIndex(fresh) {
    if (!fresh && index && Date.now() - index.at < 10e3) return index.data;
    const data = await http('GET', '/api/files' + (fresh ? '?fresh=1' : ''));
    data.entries.forEach(e => Object.assign(e, { ext: U.extOf(e.name), category: U.classify(e.name) }));
    index = { at: Date.now(), data };
    return data;
  }
  const forgetIndex = () => { index = null; };

  function sessionOrThrow() {
    if (!me) throw new ApiError('SIGNED_OUT', 'Your session has ended. Sign in again.');
    return me.session;
  }
  function requireMaster(session) {
    if (!session || session.type !== 'master') throw new ApiError('FORBIDDEN', 'Only the master account can do that.');
  }

  // ---------- accounts, as the server last reported them ----------
  function accounts() { return known; }
  const copy = a => a && Object.assign({}, a);

  // ---------- aggregation ----------
  // Drive figures (used, free, total) are the drives' own, from the server. File figures (count, files,
  // byCategory) are the files in the shares. A drive holds more than its share folder, so used is at
  // least files; the difference is totals.outside, other data on those drives.
  function aggregate(entries, shareList) {
    const per = {};
    for (const s of shareList) per[s.id] = { files: 0, count: 0, byCategory: {} };
    for (const e of entries) {
      if (e.kind !== 'file' || !per[e.share]) continue;
      const p = per[e.share];
      p.files += e.size; p.count++;
      const c = p.byCategory[e.category] || (p.byCategory[e.category] = { size: 0, count: 0 });
      c.size += e.size; c.count++;
    }
    const totals = { used: 0, total: 0, files: 0, count: 0, drives: 0, byCategory: {} };
    const drivesSeen = new Set(); // two shares on one drive share its capacity: count it once
    const shareRows = shareList.map(s => {
      const p = per[s.id];
      if (s.available && !drivesSeen.has(s.drive)) { drivesSeen.add(s.drive); totals.used += s.used || 0; totals.total += s.total || 0; totals.drives++; }
      totals.files += p.files; totals.count += p.count;
      for (const c in p.byCategory) {
        const t = totals.byCategory[c] || (totals.byCategory[c] = { size: 0, count: 0 });
        t.size += p.byCategory[c].size; t.count += p.byCategory[c].count;
      }
      return { id: s.id, name: s.name, deviceType: s.deviceType, rootPath: s.rootPath, available: s.available, lastSeenAt: s.lastSeenAt,
        used: s.used, total: s.total, free: s.free, files: p.files, count: p.count, byCategory: p.byCategory };
    });
    totals.outside = Math.max(0, totals.used - totals.files);
    // Categories under 2% of the files fold into Other: segments that thin can't be clicked.
    const segments = [], collapsed = [];
    let other = Object.assign({ size: 0, count: 0 }, totals.byCategory.other);
    for (const c of U.CATEGORY_ORDER) {
      if (c === 'other') continue;
      const v = totals.byCategory[c];
      if (!v) continue;
      if (v.size / totals.files < 0.02) { collapsed.push(Object.assign({ category: c }, v)); other.size += v.size; other.count += v.count; }
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

  // ---------- hub mock storage ----------
  function hubData() {
    let hub = read(K.hub, null);
    if (!hub) { hub = root.Attic.mock.generateHub({ accounts: accounts() }); saveHub(hub); }
    return hub;
  }
  function saveHub(hub) { write(K.hub, hub); }

  // Smooth, believable movement: a few slow sine waves per device, so each poll differs a little.
  function liveStats(d, t) {
    const s = U.hash(d.id) % 1000, w = (p, a) => Math.sin(t / p + s) * a;
    const b = d.base;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    return {
      cpu: Math.round(clamp(b.cpu + w(7000, 9) + w(2300, 5), 1, 99)),
      ramTotal: b.ramTotal,
      ramUsed: Math.round(clamp(b.ramUsed + w(11000, b.ramTotal * 0.04), 0, b.ramTotal)),
      diskTotal: b.diskTotal,
      diskFree: b.diskFree,
      battery: b.battery,
      charging: !!b.charging
    };
  }

  // Active transfers progress from their start time and speed; finished ones are written back once.
  function advanceTransfers(hub) {
    const t = Date.now();
    let changed = false;
    for (const x of hub.transfers) {
      if (x.status !== 'active') continue;
      x.bytesDone = Math.min(x.size, Math.round((t - Date.parse(x.startedAt)) / 1000 * x.speed));
      if (x.bytesDone >= x.size) { x.status = 'done'; x.finishedAt = new Date(Date.parse(x.startedAt) + x.size / x.speed * 1000).toISOString(); changed = true; }
    }
    if (changed) saveHub(hub);
    return hub;
  }

  function matchQuery(name, q) { return !q || name.toLowerCase().includes(q.toLowerCase()); }

  // =====================================================================
  const api = {
    ApiError,
    MAX_CUSTOM_BG,
    MAX_BG_BYTES,

    // ---------- pairing (the HP's: Phase 2, 2-2) ----------
    // Whether this device may use the HP: { required, paired, thisPC, device }. Answered before sign-in.
    async getPairing() {
      return http('GET', '/api/pairing');
    },

    // Trade the code the master was shown for this device's identity. The HP keeps the token in an
    // HttpOnly cookie, so nothing here ever sees it.
    async claimPairing({ code, name, kind, os }) {
      return (await http('POST', '/api/pairing/claim', { code: String(code || ''), name: String(name || '').trim(), kind, os: os || null })).device;
    },

    // ---------- first run ----------
    async needsSetup() {
      return (await http('GET', '/api/setup')).needsSetup;
    },

    // The server creates the master. The mock hub (devices and transfers, until Phase 2) is regenerated
    // on first read, owned by the new master.
    async createMaster({ displayName, username, password }) {
      const master = await http('POST', '/api/setup', { displayName, username, password });
      try { localStorage.removeItem(K.hub); } catch (e) { /* ignore */ }
      forgetIndex();
      return master;
    },

    // ---------- session (checked by the server) ----------
    async signIn({ mode, username, password, stay, deviceType }) {
      const res = await http('POST', '/api/session', { mode, username, password, stay: !!stay, deviceType: deviceType || null });
      await adopt(res);
      return res;
    },

    async getSession() {
      return adopt(await http('GET', '/api/session'));
    },

    async signOut() {
      try { await http('DELETE', '/api/session', {}); }
      finally { me = null; known = []; forgetIndex(); }
    },

    // ---------- accounts ----------
    // Master only. Each device carries its totals, so the revoke dialog's figures are never the first time they appear.
    async listDevices() {
      const session = sessionOrThrow();
      requireMaster(session);
      await refreshAccounts();
      const totals = ownerTotals((await fileIndex()).entries);
      return accounts().filter(a => a.type === 'device').map(a => Object.assign(copy(a), { owned: totals.get(a.id) || { count: 0, bytes: 0 } }))
        .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1) || (b.lastSeenAt || '').localeCompare(a.lastSeenAt || ''));
    },

    // Master only: every account that can own files, for owner columns, filters and custodian pickers.
    async listOwners() {
      const session = sessionOrThrow();
      requireMaster(session);
      await refreshAccounts();
      return accounts().map(a => ({ id: a.id, displayName: a.displayName, username: a.username, type: a.type, deviceType: a.deviceType, status: a.status }));
    },

    // File count and bytes an account owns now, and what it uploaded that someone else holds in custody.
    async ownershipSummary(accountId) {
      requireMaster(sessionOrThrow());
      return http('GET', `/api/accounts/${encodeURIComponent(accountId)}/ownership`);
    },

    // Revoke: every file the account owns goes to the custodian; uploadedBy is untouched so restore can
    // return it. The server moves the files and signs the device out together, or does neither.
    async revokeDevice(id, custodianId) {
      requireMaster(sessionOrThrow());
      await refreshAccounts();
      const custodian = checkCustodian(accounts(), custodianId, id);
      const r = await http('POST', `/api/accounts/${encodeURIComponent(id)}/revoke`, { custodianId: custodian.id });
      forgetIndex();
      await refreshAccounts();
      return { account: r.account, moved: r.moved, custodian: copy(custodian) };
    },

    // Restore: files this account uploaded that someone else still holds come back. Cleared uploadedBy means
    // nothing returns — zero is a correct answer, not a failure.
    async restoreDevice(id) {
      requireMaster(sessionOrThrow());
      const r = await http('POST', `/api/accounts/${encodeURIComponent(id)}/restore`, {});
      forgetIndex();
      await refreshAccounts();
      return { account: r.account, returned: r.returned };
    },

    // Kept for callers that only flip status; revoking always needs a custodian.
    async setDeviceStatus(id, status, custodianId) {
      if (status === 'revoked') return (await api.revokeDevice(id, custodianId)).account;
      return (await api.restoreDevice(id)).account;
    },

    // Master only: end the uploader's claim on these files. The only change to uploadedBy besides removal.
    async reassignPermanently(fileIds) {
      requireMaster(sessionOrThrow());
      const r = await http('POST', '/api/files/keep', { ids: fileIds });
      forgetIndex();
      return { cleared: r.cleared };
    },

    async createDevice({ displayName, username, password, deviceType }) {
      const acc = await http('POST', '/api/accounts', { displayName, username, password, deviceType });
      await refreshAccounts();
      return acc;
    },

    // Remove: permanent. Owned files go to the custodian, and every uploadedBy pointing at this account is
    // cleared — nothing can be returned to an account that no longer exists.
    async removeDevice(id, custodianId) {
      requireMaster(sessionOrThrow());
      await refreshAccounts();
      const acc = accounts().find(a => a.id === id);
      if (!acc || acc.type === 'master') throw new ApiError('FORBIDDEN', 'The master account can’t be deleted.');
      const custodian = checkCustodian(accounts(), custodianId, id);
      const r = await http('POST', `/api/accounts/${encodeURIComponent(id)}/remove`, { custodianId: custodian.id });
      forgetIndex();
      await refreshAccounts();
      return { moved: r.moved, custodian: copy(custodian) };
    },

    async updateDisplayName(id, displayName) {
      const acc = await http('PATCH', `/api/accounts/${encodeURIComponent(id)}`, { displayName });
      if (me && me.account.id === id) me.account = acc;
      known = known.map(a => a.id === id ? acc : a);
      return acc;
    },

    // Ends this account's other sessions; this one stays signed in.
    async changePassword(id, current, next) {
      await http('POST', `/api/accounts/${encodeURIComponent(id)}/password`, { current, next });
    },

    // ---------- shares (the HP's drives, and its config) ----------
    // Drive figures come from the server; the file count is the caller's own files from the index. A
    // device gets no capacity or free space, and "used" is the size of the files it can see.
    async listShares() {
      const [list, ix] = await Promise.all([http('GET', '/api/shares'), fileIndex().catch(() => null)]);
      if (ix) {
        const per = {};
        for (const e of ix.entries) { const p = per[e.share] || (per[e.share] = { count: 0, bytes: 0 }); p.count++; p.bytes += e.size; }
        list.forEach(s => { const p = per[s.id] || { count: 0, bytes: 0 }; s.count = p.count; if (s.total == null) s.used = p.bytes; });
      }
      return list;
    },

    // Master only. Written to the server's config.json, so it survives a restart.
    async saveShare(share) {
      const body = { name: share.name, rootPath: share.rootPath, deviceType: share.deviceType };
      const saved = share.id ? await http('PUT', `/api/shares/${encodeURIComponent(share.id)}`, body) : await http('POST', '/api/shares', body);
      forgetIndex();
      return saved;
    },

    // Stops serving the folder. Nothing on disk is touched.
    async removeShare(id) {
      await http('DELETE', `/api/shares/${encodeURIComponent(id)}`, {});
      forgetIndex();
    },

    // ---------- files (real, from the HP: milestone 4) ----------
    // The server sends what the disk knows; type and category are worked out here, exactly as the
    // mock did, so every screen sees the same shape. Until milestone 5 every real file is the master's.
    async listFolder(shareId, path) {
      const q = path ? '?path=' + encodeURIComponent(path) : '';
      const data = await http('GET', `/api/shares/${encodeURIComponent(shareId)}/folder${q}`);
      data.items = data.items.map(e => Object.assign(e, e.kind === 'file' ? { ext: U.extOf(e.name), category: U.classify(e.name) } : { ext: '', category: null }));
      return data;
    },

    // A real id carries its share and path, so one folder listing finds it.
    async getFile(id) {
      let shareId, rel;
      try {
        const bin = atob(String(id).replace(/^r:/, '').replace(/-/g, '+').replace(/_/g, '/'));
        [shareId, rel] = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))).split('\n');
      } catch (e) { /* not a real id */ }
      if (!String(id).startsWith('r:') || rel === undefined) throw new ApiError('NOT_FOUND', 'File not found.');
      const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      const e = (await api.listFolder(shareId, parent)).items.find(x => x.id === id);
      if (!e) throw new ApiError('NOT_FOUND', 'File not found.');
      return e;
    },

    // Where the browser downloads a file from. A plain link: the browser streams it to disk itself,
    // resumes with Range requests, and the session cookie goes along.
    // ' ( ) are escaped too: these URLs also go inside CSS url('…') for previews.
    downloadUrl(e) {
      const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
      return `/api/shares/${enc(e.share)}/file?path=${enc(U.joinPath(e.path, e.name))}`;
    },

    // Where the browser shows a photo, video or audio file in place: a preview, the photo viewer, a
    // player. The server serves only those types this way; anything else still downloads.
    mediaUrl(e) {
      return api.downloadUrl(e) + '&inline=1';
    },

    // Photos, Videos and Other are filtered views over the same index — not separate storage. An
    // unplugged share has nothing in the index, so its files simply aren't there.
    async listByTab(tab, { share, query } = {}) {
      return (await fileIndex()).entries.filter(e => U.tabOf(e.category) === tab && (!share || e.share === share) && matchQuery(e.name, query));
    },

    // Master only. Adds the breakdown by owner alongside the breakdown by type. Refresh walks the drives again.
    async getStorage({ fresh } = {}) {
      requireMaster(sessionOrThrow());
      const [{ entries }, shareList] = await Promise.all([fileIndex(fresh), http('GET', '/api/shares')]);
      const agg = aggregate(entries, shareList);
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
      requireMaster(sessionOrThrow());
      const [{ entries }, list] = await Promise.all([fileIndex(), http('GET', '/api/shares')]);
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
        category, includes: [...cats], total, count: files.length, used: agg.totals.files, files,
        byShare: list.map(s => Object.assign({ id: s.id, name: s.name, available: s.available }, byShare[s.id] || { size: 0, count: 0 })).filter(s => s.count),
        byExt: Object.entries(byExt).map(([ext, v]) => Object.assign({ ext }, v)).sort((a, b) => b.size - a.size)
      };
    },

    // ---------- hub: devices (the HP's paired devices: 2-2) ----------
    // Everyone signed in sees which devices exist and whether they're online; the master also sees when
    // each was paired and its last address. Live stats arrive with the agent in 2-3, so `stats` is null.
    async listHubDevices() {
      const list = await http('GET', '/api/devices');
      return list.map(d => ({ id: d.id, name: d.name, role: d.role, os: d.os || '', kind: d.kind, online: !!d.online,
        lastSeenAt: d.lastSeenAt, thisPC: !!d.thisPC, browserOnly: d.kind === 'phone' || d.kind === 'tablet', stats: null,
        pairedAt: d.pairedAt || null, lastAddress: d.lastAddress || null }));
    },

    // Unpair (master): the device's token stops working and everyone signed in on it is signed out.
    async unpairHubDevice(id) {
      return http('DELETE', '/api/devices/' + encodeURIComponent(id), {});
    },

    // One-time pairing codes (master). Issuing a code is the approval for one new device.
    async listPairCodes() { return http('GET', '/api/pairing/codes'); },
    async createPairCode() { return http('POST', '/api/pairing/codes', {}); },
    async cancelPairCode(id) { return http('DELETE', '/api/pairing/codes/' + encodeURIComponent(id), {}); },

    // ---------- hub: transfers (mock until 2-4 and 2-5) ----------
    // The sample devices the mock transfers name, so the Transfers view can label them.
    async listTransferDevices() {
      await delay(true);
      const session = sessionOrThrow();
      const hub = hubData();
      const t = Date.now();
      return hub.devices.map(d => {
        const out = { id: d.id, name: d.name, role: d.role, os: d.os, kind: d.kind, connection: d.connection, ip: d.ip,
          online: d.online, lastSeenAt: d.online ? new Date(t).toISOString() : d.lastSeenAt, thisPC: !!d.thisPC, browserOnly: !!d.browserOnly, stats: null };
        if (session.type === 'master' && d.base && d.online) out.stats = liveStats(d, t);
        return out;
      });
    },

    // The master sees every transfer; anyone else only their own.
    async listTransfers() {
      await delay(true);
      const session = sessionOrThrow();
      const hub = advanceTransfers(hubData());
      return hub.transfers.filter(x => session.type === 'master' || x.userId === session.accountId)
        .map(x => Object.assign({}, x)).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },

    async retryTransfer(id) {
      await delay(true);
      const session = sessionOrThrow();
      const hub = hubData();
      const x = hub.transfers.find(t => t.id === id && (session.type === 'master' || t.userId === session.accountId));
      if (!x) throw new ApiError('NOT_FOUND', 'That transfer no longer exists.');
      if (x.status !== 'failed' && x.status !== 'cancelled') throw new ApiError('INVALID', 'Only failed or cancelled transfers can be retried.');
      const to = hub.devices.find(d => d.id === x.to), from = hub.devices.find(d => d.id === x.from);
      const waiting = !(to && to.online && from && from.online);
      Object.assign(x, { status: waiting ? 'queued' : 'active', startedAt: new Date().toISOString(), finishedAt: null, bytesDone: 0, error: null,
        speed: waiting ? null : x.speed || 20e6 });
      saveHub(hub);
      return Object.assign({}, x);
    },

    async cancelTransfer(id) {
      await delay(true);
      const session = sessionOrThrow();
      const hub = advanceTransfers(hubData());
      const x = hub.transfers.find(t => t.id === id && (session.type === 'master' || t.userId === session.accountId));
      if (!x) throw new ApiError('NOT_FOUND', 'That transfer no longer exists.');
      if (x.status !== 'active' && x.status !== 'queued') throw new ApiError('INVALID', 'Only active or queued transfers can be cancelled.');
      Object.assign(x, { status: 'cancelled', finishedAt: new Date().toISOString() });
      saveHub(hub);
      return Object.assign({}, x);
    },

    // ---------- upload (real, to the HP: milestone 5) ----------
    validateUpload(file) {
      if (file.size === 0) return 'Empty file. Nothing to upload.';
      if (file.size > 20e9) return 'Too large. The limit is 20 GB per file.';
      if (/\.(lnk|tmp|crdownload|part)$/i.test(file.name)) return 'This file type can’t be uploaded.';
      return null;
    },

    // Sends the file itself as the request body, so the browser streams it from disk. XMLHttpRequest
    // rather than fetch: only it reports upload progress. The uploader owns the file; a name that's
    // taken comes back as "name (1).ext". Resolves with the stored entry.
    upload(shareId, folder, file, onProgress) {
      const xhr = new XMLHttpRequest();
      return {
        cancel() { xhr.abort(); },
        promise: new Promise((resolve, reject) => {
          xhr.open('PUT', `/api/shares/${encodeURIComponent(shareId)}/file?path=${encodeURIComponent(U.joinPath(folder || '', file.name))}`);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.setRequestHeader('X-Attic-Upload', '1');
          xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
          xhr.onload = () => {
            let data = null;
            try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
            if (xhr.status === 201) { onProgress(1); forgetIndex(); return resolve(data); }
            if (xhr.status === 401) { me = null; known = []; }
            reject(new ApiError((data && data.code) || 'SERVER', (data && data.message) || 'The upload failed.'));
          };
          xhr.onerror = () => reject(new ApiError('UNREACHABLE', 'Could not reach the server.'));
          xhr.onabort = () => reject(new ApiError('CANCELLED', 'Cancelled'));
          xhr.send(file);
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
    // This browser's preferences, with the server's shares listed for reference. Shares live in the
    // server's config, so importing never changes them: that's done in Settings, one share at a time.
    async exportSettings() {
      const shares = (await http('GET', '/api/shares')).map(s => ({ id: s.id, name: s.name, rootPath: s.rootPath, deviceType: s.deviceType }));
      return { app: 'Attic', kind: 'settings', version: 2, exportedAt: now(), settings: settings(), shares };
    },

    async importSettings(data) {
      await delay(false);
      if (!data || data.app !== 'Attic' || data.kind !== 'settings') throw new ApiError('INVALID', 'That file isn’t an Attic settings export.');
      if (data.settings) write(K.settings, Object.assign(clone(DEFAULT_SETTINGS), data.settings));
    },

    // This browser's data only. Accounts, shares and files live on the server and are untouched; you're signed out.
    async clearAllData() {
      await api.signOut().catch(() => {});
      for (const store of [localStorage, sessionStorage]) {
        Object.keys(store).filter(k => k.startsWith('fs.')).forEach(k => store.removeItem(k));
      }
      await idb.destroy();
      forgetIndex();
    },

    // How many files the index holds for this account, and when the drives were last walked.
    async indexInfo() {
      const ix = await fileIndex();
      return { entries: ix.entries.length, generatedAt: ix.generatedAt };
    }
  };

  root.Attic.api = api;
})(window);
