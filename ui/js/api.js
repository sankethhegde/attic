// api.js — the ONLY module that touches storage. No screen reads localStorage or calls fetch.
// Every function returns a promise and every one can fail.
//
// Accounts, passwords, sessions, shares, files and ownership are the HP server's (Phase 1C), and so are
// pairing, devices, live stats and transfers (Phase 2). The browser keeps only its own preferences and
// login backgrounds.
(function (root) {
  'use strict';
  const U = root.Attic.util;
  const idb = root.Attic.idb;

  const K = { settings: 'fs.settings' };
  // Left behind by the browser mocks of Phase 1A–2: the generated file index (a few MB), its shares, and
  // the sample devices and transfers.
  try { ['fs.mockIndex', 'fs.shares', 'fs.accounts', 'fs.session', 'fs.mockHub'].forEach(k => localStorage.removeItem(k)); } catch (e) { /* storage blocked */ }
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

  // ---------- sending files to devices (2-4, 2-5) ----------
  // What this page sent, by transfer id, so Retry can send it again without asking: { file } for a file
  // from this device, { entry } for one on the HP. Uploads in flight, by id, so Cancel can stop them.
  const sentFiles = new Map(), uploads = new Map();

  // Streams `body` as transfer `id`'s file. XMLHttpRequest rather than fetch: only it reports upload
  // progress. → { promise (the transfer, now queued), cancel }
  function putTransferFile(id, body, onProgress) {
    const xhr = new XMLHttpRequest();
    return {
      cancel() { xhr.abort(); },
      promise: new Promise((resolve, reject) => {
        xhr.open('PUT', `/api/transfers/${encodeURIComponent(id)}/file`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('X-Attic-Upload', '1');
        xhr.upload.onprogress = e => onProgress(e.loaded);
        xhr.onload = () => {
          let data = null;
          try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
          if (xhr.status === 200) return resolve(data);
          reject(new ApiError((data && data.code) || 'SERVER', (data && data.message) || 'Sending failed.'));
        };
        xhr.onerror = () => reject(new ApiError('UNREACHABLE', 'Could not reach the server.'));
        xhr.onabort = () => reject(new ApiError('CANCELLED', 'Cancelled'));
        xhr.send(body);
      })
    };
  }

  // A file on the HP, read back to be sent to a device (the HP has no copy-in-place for transfers).
  async function fetchFromHP(entry, name) {
    const res = await fetch(api.downloadUrl(entry), { credentials: 'same-origin' }).catch(() => null);
    if (!res || !res.ok) throw new ApiError('UNREACHABLE', `Couldn’t read ${name} from the HP.`);
    return res.blob();
  }

  function matchQuery(name, q) { return !q || name.toLowerCase().includes(q.toLowerCase()); }

  // A device as the HP describes it (GET /api/devices and the live hub), in the shape the views read.
  function hubDevice(d) {
    return { id: d.id, name: d.name, role: d.role, os: d.os || '', kind: d.kind, online: !!d.online, lastSeenAt: d.lastSeenAt,
      thisPC: !!d.thisPC, browserOnly: !!d.browserOnly, connection: d.connection || null, ip: d.ip || null,
      stats: d.stats || null, statsAt: d.statsAt || null, lastStats: d.lastStats || null,
      pairedAt: d.pairedAt || null, lastAddress: d.lastAddress || null };
  }

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
    // The HP's HTTPS (Phase 4, 4-1): { caFingerprint, httpsPort, names, validUntil, caUrl, profileUrl },
    // public, so a phone can fetch it before it trusts the secure address. null if the HP has no HTTPS.
    async getTls() {
      try { return await http('GET', '/api/tls'); } catch (e) { return null; }
    },
    // The same interface at the HP's secure address, or null (already there, or no HTTPS).
    secureUrl(tls) {
      if (!tls || !tls.httpsPort || location.protocol === 'https:') return null;
      return `https://${location.hostname}:${tls.httpsPort}/`;
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

    // The server creates the master.
    async createMaster({ displayName, username, password }) {
      const master = await http('POST', '/api/setup', { displayName, username, password });
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

    // ---------- hub: devices (the HP's paired devices: 2-2, live: 2-3) ----------
    // Everyone signed in sees which devices exist, whether they're online and how they're connected. Only
    // the master gets stats (null for anyone else), the IP, and when each was paired.
    async listHubDevices() {
      return (await http('GET', '/api/devices')).map(hubDevice);
    },

    // The live Devices view: one WebSocket to the HP. `onList` gets the whole list first, then `onChange`
    // one device at a time and `onRemoved` an id on unpair. `onStatus` hears 'live' or 'reconnecting'. A
    // dropped connection is retried; one the HP closes because the session or pairing ended sends the app
    // back to sign-in or pairing. The Transfers view (2-5) listens on the same connection: `onTransfer`
    // gets a transfer whenever it changes, `onProgress` { id, stage, bytesDone, size, speed } about twice a
    // second while one moves. Returns { close }.
    openHub({ onList = () => {}, onChange = () => {}, onRemoved = () => {}, onTransfer = () => {}, onProgress = () => {}, onStatus = () => {} }) {
      let ws = null, closed = false, tries = 0, timer = 0;
      const connect = () => {
        if (closed) return;
        ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/hub`);
        ws.onmessage = ev => {
          let m;
          try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.type === 'devices') { tries = 0; onStatus('live'); onList(m.devices.map(hubDevice)); }
          else if (m.type === 'device') onChange(hubDevice(m.device));
          else if (m.type === 'removed') onRemoved(m.id);
          else if (m.type === 'transfer' && m.transfer) onTransfer(m.transfer);
          else if (m.type === 'progress') onProgress(m);
        };
        ws.onclose = async ev => {
          if (closed) return;
          onStatus('reconnecting');
          if (ev.code === 4001 || ev.code === 1006) {
            // Ended by the HP, or refused at the door: find out whether it's the session or the pairing.
            try {
              const p = await http('GET', '/api/pairing');
              if (p.required && !p.paired) return root.dispatchEvent(new CustomEvent('attic:not-paired'));
              if (!(await http('GET', '/api/session'))) { closed = true; return location.reload(); }
            } catch (e) { /* the HP is unreachable; keep retrying */ }
          }
          timer = setTimeout(connect, [1000, 2000, 5000, 10000][Math.min(tries++, 3)]);
        };
      };
      connect();
      return { close() { closed = true; clearTimeout(timer); if (ws) ws.close(1000); } };
    },

    // Unpair (master): the device's token stops working and everyone signed in on it is signed out.
    async unpairHubDevice(id) {
      return http('DELETE', '/api/devices/' + encodeURIComponent(id), {});
    },

    // One-time pairing codes (master). Issuing a code is the approval for one new device.
    async listPairCodes() { return http('GET', '/api/pairing/codes'); },
    async createPairCode() { return http('POST', '/api/pairing/codes', {}); },
    async cancelPairCode(id) { return http('DELETE', '/api/pairing/codes/' + encodeURIComponent(id), {}); },

    // ---------- transfers (the HP's: 2-5 progress, Retry and history) ----------
    // The newest 200, open ones included: the master sees all, anyone else what they sent and what's for
    // their device. While a leg moves, `bytesDone` and `speed` are live; the hub sends the same as
    // { type: "progress" } (see openHub).
    async listTransfers() { return http('GET', '/api/transfers'); },

    // Finished transfers, newest first, a page at a time: { items, next }. Pass `next` back as `before`.
    async transferHistory({ before, status, device, q, limit = 50 } = {}) {
      const p = new URLSearchParams({ limit: String(limit) });
      if (before) p.set('before', before);
      if (status) p.set('status', status);
      if (device) p.set('device', device);
      if (q) p.set('q', q);
      return http('GET', '/api/transfers/history?' + p);
    },

    // Retry (the sender or the master) a failed or cancelled transfer. If the HP still has the file it's
    // queued again. If not, it waits for the file (`active` / `upload`): resendTransfer sends it from this
    // device, using the file this page sent earlier when it still has it, or one the person chooses.
    async retryTransfer(id) { return http('POST', `/api/transfers/${encodeURIComponent(id)}/retry`, {}); },

    // Cancel (the sender or the master): an upload in flight here stops too.
    async cancelTransfer(id) {
      const job = uploads.get(id);
      if (job) job.cancel();
      return http('DELETE', '/api/transfers/' + encodeURIComponent(id), {});
    },

    hasFileFor: id => sentFiles.has(id),
    // A file sent from File Explorer (3-3) is sent by the desktop tool, which can send it again by its path.
    async hasPathFor(id) { const d = root.atticDesktop && root.atticDesktop.send; return !!(d && await d.hasPath(id)); },

    // ---------- updates (Phase 3, 3-5, T-10; master) ----------
    // The installers the HP keeps, newest first.
    async listUpdates() { return http('GET', '/api/updates'); },
    // Publishes an installer built on this PC (Attic-Hub-Setup-<version>.exe) to the HP, which then offers
    // it to every device. → { promise (the release), cancel }
    publishUpdate(file, { notes = '', onProgress = () => {} } = {}) {
      const xhr = new XMLHttpRequest();
      return {
        cancel() { xhr.abort(); },
        promise: new Promise((resolve, reject) => {
          xhr.open('PUT', `/api/updates/files/${encodeURIComponent(file.name)}${notes ? '?notes=' + encodeURIComponent(notes) : ''}`);
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          xhr.setRequestHeader('X-Attic-Upload', '1');
          xhr.upload.onprogress = e => onProgress(e.loaded, file.size);
          xhr.onload = () => {
            let data = null;
            try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
            if (xhr.status === 201) return resolve(data);
            reject(new ApiError((data && data.code) || 'SERVER', (data && data.message) || 'Publishing failed.'));
          };
          xhr.onerror = () => reject(new ApiError('UNREACHABLE', 'Could not reach the server.'));
          xhr.onabort = () => reject(new ApiError('CANCELLED', 'Cancelled'));
          xhr.send(file);
        })
      };
    },
    isUploading: id => uploads.has(id),
    // `file`: a File the person chose (it must be the same size), else the one this page sent before, or
    // (3-3) the one the desktop tool sent by its path.
    resendTransfer(t, file, onProgress = () => {}) {
      const src = file ? { file } : sentFiles.get(t.id);
      if (!src && root.atticDesktop && root.atticDesktop.send) {
        return { cancel() {}, promise: (async () => {
          const r = await root.atticDesktop.send.resend(t);
          if (!r || r.error) throw new ApiError('INVALID', (r && r.error) || 'Choose the file to send again.');
          return r;
        })() };
      }
      if (!src) throw new ApiError('INVALID', 'Choose the file to send again.');
      if (file && file.size !== t.size) throw new ApiError('INVALID', `That file is ${U.formatBytes(file.size)}; ${t.fileName} was ${U.formatBytes(t.size)}. Choose the same file.`);
      let job = null, cancelled = false;
      const promise = (async () => {
        const body = src.file || await fetchFromHP(src.entry, t.fileName);
        if (cancelled) throw new ApiError('CANCELLED', 'Cancelled');
        sentFiles.set(t.id, src);
        job = putTransferFile(t.id, body, loaded => onProgress(loaded, t.size));
        uploads.set(t.id, job);
        try { return await job.promise; } finally { uploads.delete(t.id); }
      })();
      return { promise, cancel() { cancelled = true; if (job) job.cancel(); } };
    },

    // Files picked in File Explorer (3-3): known by their paths on this PC, which only the desktop tool can
    // read, so it sends them. `files`: [{ path, name, size }]. Same shape back as sendToDevice.
    sendLocalFiles({ files, to, onProgress = () => {} }) {
      const d = root.atticDesktop && root.atticDesktop.send;
      if (!d) throw new ApiError('INVALID', 'Only the Attic Hub desktop tool can send files from File Explorer.');
      d.onProgress(p => onProgress({ phase: 'upload', name: p.name, loaded: p.loaded, total: p.total }));
      return {
        cancel() { d.cancel(); },
        promise: d.upload(files.map(f => ({ path: f.path, name: f.name, size: f.size })), to.id).then(r => {
          if (r && r.error) throw new ApiError(r.code || 'SERVER', r.error);
          return r.transfers;
        })
      };
    },

    // ---------- send to a device (the HP's: 2-4) ----------
    // Each file goes in two steps: say what's coming (POST /api/transfers), then stream exactly that many
    // bytes (PUT …/file). The HP holds it until the receiving device's agent collects it, at once if it's
    // online, otherwise when it next connects. `files`: [{ name, size, source }] where `source` is a File
    // from this device, or `entry`, a file already on the HP, which the browser fetches first (the HP has
    // no copy-in-place for transfers). `onProgress({ phase: 'fetch' | 'upload', name, loaded, total })`.
    // Returns { cancel, promise }; the promise resolves with the transfers, now queued on the HP.
    sendToDevice({ files, to, onProgress = () => {} }) {
      let job = null, current = null, cancelled = false;
      const total = files.reduce((a, f) => a + f.size, 0);
      const promise = (async () => {
        if (!to) throw new ApiError('INVALID', 'Choose a device to send to.');
        if (!files.length) throw new ApiError('INVALID', 'Choose at least one file.');
        const out = [];
        let done = 0;
        for (const f of files) {
          if (cancelled) throw new ApiError('CANCELLED', 'Cancelled');
          let body = f.source;
          if (!body) {
            onProgress({ phase: 'fetch', name: f.name, loaded: done, total });
            body = await fetchFromHP(f.entry, f.name);
          }
          current = await http('POST', '/api/transfers', { to: to.id, fileName: f.name, size: body.size });
          // Kept for this session, so Retry can send it again without asking (a file on the HP is re-read).
          sentFiles.set(current.id, f.source ? { file: f.source } : { entry: f.entry });
          job = putTransferFile(current.id, body, loaded => onProgress({ phase: 'upload', name: f.name, loaded: done + loaded, total }));
          uploads.set(current.id, job);
          try { out.push(await job.promise); } finally { uploads.delete(current.id); }
          current = null;
          done += f.size;
          onProgress({ phase: 'upload', name: f.name, loaded: done, total });
        }
        return out;
      })();
      return {
        promise,
        cancel() {
          cancelled = true;
          if (job) job.cancel();
          if (current) http('DELETE', '/api/transfers/' + encodeURIComponent(current.id), {}).catch(() => {});
        }
      };
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
