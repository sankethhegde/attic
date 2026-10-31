// Seeded mock file index (~3,000 entries). Same seed, same data: a layout bug stays reproducible.
// Kept for testing in Phase 1B; never shipped to production.
(function (root) {
  'use strict';
  const U = root.Attic ? root.Attic.util : require('./util.js');

  const SEED = 20261021;
  const KB = 1e3, MB = 1e6, GB = 1e9, TB = 1e12;

  const SHARES = [
    { id: 'system', name: 'System', rootPath: 'C:\\Shared', deviceType: 'ssd', totalBytes: 256 * GB, available: true },
    { id: 'main', name: 'Main storage', rootPath: 'D:\\Shared', deviceType: 'hdd', totalBytes: 1 * TB, available: true },
    { id: 'backup', name: 'External backup', rootPath: 'E:\\Backup', deviceType: 'external', totalBytes: 2 * TB, available: true }
  ];

  const PLAN = {
    system: { files: 200, depth: 3, mix: { documents: .68, other: .14, archives: .08, photos: .06, audio: .04 },
      tops: ['Documents', 'Downloads', 'Desktop', 'Projects', 'Config'],
      subs: ['Invoices', 'Taxes', 'Receipts', 'Notes', 'Scans', 'Old', '2024', '2025', 'Drafts', 'Templates', 'Work', 'Personal'] },
    main: { files: 2000, depth: 5, mix: { photos: .62, videos: .2, documents: .08, audio: .05, archives: .03, other: .02 },
      tops: ['Photos', 'Videos', 'Music', 'Documents', 'Camera Uploads', 'Family', 'Projects'],
      subs: ['Trip to Coorg', 'Diwali 2024', 'Wedding', 'Goa 2023', 'Birthday', 'Kids', 'Screenshots', 'Raw', 'Edited', 'Exports', 'Holidays', 'Mysuru Dasara', 'Hampi', 'Weekend', '2023', '2024', '2025'] },
    backup: { files: 800, depth: 4, mix: { videos: .46, archives: .36, photos: .08, documents: .05, other: .05 },
      tops: ['Backups', 'Archive', 'Movies', 'Old laptop', 'Phone backup'],
      subs: ['2022', '2023', '2024', 'Monthly', 'Full', 'Incremental', 'Series', 'Documentaries', 'Misc', 'Recovered'] }
  };

  const HOME_FOR = {
    photos: ['Photos', 'Camera Uploads', 'Family', 'Phone backup', 'Desktop'],
    videos: ['Videos', 'Movies', 'Family', 'Camera Uploads', 'Phone backup'],
    audio: ['Music', 'Downloads', 'Old laptop'],
    documents: ['Documents', 'Desktop', 'Projects', 'Downloads', 'Old laptop'],
    archives: ['Backups', 'Archive', 'Downloads', 'Projects'],
    other: ['Downloads', 'Config', 'Projects', 'Old laptop', 'Backups']
  };

  const W = {
    adj: ['blue', 'quiet', 'final', 'old', 'new', 'family', 'summer', 'monsoon', 'morning', 'weekend', 'shared', 'scanned', 'draft', 'clean'],
    noun: ['budget', 'invoice', 'report', 'notes', 'letter', 'plan', 'receipt', 'statement', 'resume', 'checklist', 'agenda', 'manual', 'recipe', 'itinerary', 'certificate', 'form', 'minutes', 'proposal'],
    title: ['Kantara', 'The Long Road', 'Coastline', 'Night Market', 'Rainfall', 'Paper Boats', 'Ghats Drive', 'Old Bangalore', 'Second Light', 'Harbour', 'Monsoon Diaries', 'Fieldwork'],
    artist: ['Raghu Dixit', 'Vasu Dixit', 'Arijit Singh', 'Shreya Ghoshal', 'Hamsalekha', 'Anoushka Shankar', 'Thaikkudam Bridge'],
    song: ['Lokada Kalaji', 'Gudugudiya', 'Tum Hi Ho', 'Kesariya', 'Ninna Nodalantha', 'Monsoon', 'Navarasam', 'Home', 'Lights']
  };

  function make(r) {
    const pick = a => a[Math.floor(r() * a.length)];
    const int = (a, b) => a + Math.floor(r() * (b - a + 1));
    const logUniform = (lo, hi) => Math.round(Math.exp(Math.log(lo) + r() * (Math.log(hi) - Math.log(lo))));
    const weighted = obj => { let x = r(), acc = 0; for (const k in obj) { acc += obj[k]; if (x <= acc) return k; } return Object.keys(obj)[0]; };
    const pad = (n, w) => String(n).padStart(w, '0');
    return { pick, int, logUniform, weighted, pad };
  }

  function generate(opts) {
    opts = opts || {};
    const r = U.rng(opts.seed || SEED);
    const now = opts.now || Date.now();
    const { pick, int, logUniform, weighted, pad } = make(r);
    const entries = [];
    let nextId = 1;
    const id = () => 'f' + (nextId++).toString(36);
    const iso = t => new Date(t).toISOString();
    // Skewed toward recent: most activity is in the last few months.
    const pastDate = (maxDays) => now - Math.pow(r(), 1.8) * maxDays * 864e5 - r() * 3600e3;

    const folders = {}; // share -> [{path, top, depth}]
    const names = {};   // `${share}/${path}` -> Set of child names
    function addFolder(share, parent, name, t) {
      const key = share + '/' + parent;
      names[key] = names[key] || new Set();
      if (names[key].has(name)) return U.joinPath(parent, name);
      names[key].add(name);
      entries.push({ id: id(), kind: 'folder', share, path: parent, name, ext: '', category: null, size: 0, modifiedAt: iso(t || pastDate(900)) });
      const full = U.joinPath(parent, name);
      const depth = full.split('/').length;
      folders[share].push({ path: full, top: full.split('/')[0], depth });
      return full;
    }
    function uniqueName(share, parent, name) {
      const key = share + '/' + parent;
      names[key] = names[key] || new Set();
      let n = name, i = 2;
      while (names[key].has(n)) {
        const dot = name.lastIndexOf('.');
        n = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
        i++;
      }
      names[key].add(n);
      return n;
    }
    function addFile(share, parent, name, size, t) {
      const n = uniqueName(share, parent, name);
      const e = { id: id(), kind: 'file', share, path: parent, name: n, ext: U.extOf(n), category: U.classify(n), size, modifiedAt: iso(t) };
      entries.push(e);
      return e;
    }

    function fileName(cat, share) {
      const year = int(2019, 2026);
      const d = `${year}${pad(int(1, 12), 2)}${pad(int(1, 28), 2)}`;
      switch (cat) {
        case 'photos': {
          const style = r();
          if (style < .35) return `IMG_${pad(int(1, 9999), 4)}.${weighted({ jpg: .7, heic: .2, png: .1 })}`;
          if (style < .5) return `DSC_${pad(int(1, 9999), 4)}.JPG`;
          if (style < .7) return `PXL_${d}_${pad(int(0, 235959), 6)}.jpg`;
          if (style < .8) return `Screenshot ${year}-${pad(int(1, 12), 2)}-${pad(int(1, 28), 2)} at ${pad(int(0, 23), 2)}.${pad(int(0, 59), 2)}.png`;
          return `${pick(W.adj)} ${pick(['sky', 'street', 'temple', 'beach', 'portrait', 'garden', 'sunset', 'market'])} ${int(1, 40)}.${weighted({ jpg: .5, jpeg: .15, webp: .1, gif: .08, tiff: .07, bmp: .05, png: .05 })}`;
        }
        case 'videos': {
          const style = r();
          if (style < .4) return `VID_${d}_${pad(int(0, 2359), 4)}.mp4`;
          if (style < .7) return `${pick(W.title)} (${year}).${weighted({ mkv: .6, mp4: .3, avi: .1 })}`;
          return `${pick(['clip', 'reel', 'take', 'recording'])}_${int(1, 300)}.${weighted({ mov: .4, webm: .2, m4v: .2, wmv: .2 })}`;
        }
        case 'audio': return `${pick(W.artist)} - ${pick(W.song)}.${weighted({ mp3: .6, flac: .2, m4a: .1, wav: .05, aac: .05 })}`;
        case 'documents': {
          const e = weighted({ pdf: .35, docx: .2, xlsx: .15, txt: .08, md: .06, pptx: .06, doc: .04, xls: .03, ppt: .03 });
          return r() < .5 ? `${pick(W.noun)}-${pick(W.adj)}-${year}.${e}` : `${cap(pick(W.adj))} ${pick(W.noun)} ${year}.${e}`;
        }
        case 'archives': {
          const e = weighted({ zip: .45, '7z': .2, rar: .15, 'tar.gz': .12, tar: .08 });
          return share === 'backup' ? `backup_${d}.${e}` : `${pick(W.noun)}s-${year}.${e}`;
        }
        default: return `${pick(['installer', 'data', 'export', 'disk', 'sync', 'cache', 'layout', 'session'])}_${int(1, 999)}.${pick(['iso', 'exe', 'json', 'log', 'psd', 'apk', 'dmg', 'bin', 'csv', 'svg', 'ttf'])}`;
      }
    }
    function cap(s) { return s[0].toUpperCase() + s.slice(1); }

    // Realistic sizes so the breakdown has plausible proportions, not an even split.
    function sizeFor(cat, share, name) {
      switch (cat) {
        case 'photos': return logUniform(2 * MB, 8 * MB);
        case 'videos': return logUniform(200 * MB, 4 * GB);
        case 'audio': return logUniform(3 * MB, 12 * MB);
        case 'documents': return logUniform(50 * KB, 5 * MB);
        case 'archives': return share === 'backup' ? logUniform(1 * GB, 12 * GB) : logUniform(10 * MB, 2 * GB);
        default: return /\.(iso|dmg)$/.test(name) ? logUniform(700 * MB, 6 * GB) : logUniform(10 * KB, 50 * MB);
      }
    }

    for (const share of SHARES) {
      const p = PLAN[share.id];
      folders[share.id] = [];
      for (const top of p.tops) {
        const t = addFolder(share.id, '', top);
        (function grow(parent, depth) {
          if (depth >= p.depth) return;
          const n = depth === 1 ? int(2, 4) : int(0, 3);
          for (let i = 0; i < n; i++) grow(addFolder(share.id, parent, pick(p.subs)), depth + 1);
        })(t, 1);
      }
    }

    // ---- Deliberately awkward cases ----
    const S = 'main';
    const camera = 'Camera Uploads';
    // A folder holding 500 items.
    const burst = addFolder(S, camera, 'Burst 2024');
    for (let i = 1; i <= 500; i++) addFile(S, burst, `BURST_${pad(i, 4)}.jpg`, logUniform(2 * MB, 8 * MB), now - (200 + i * 0.01) * 864e5);
    // Recent photos for Today / Yesterday groups.
    for (let i = 0; i < 14; i++) addFile(S, camera, `PXL_today_${pad(i + 1, 2)}.jpg`, logUniform(2 * MB, 8 * MB), now - r() * 6 * 3600e3);
    for (let i = 0; i < 9; i++) addFile(S, camera, `PXL_yday_${pad(i + 1, 2)}.jpg`, logUniform(2 * MB, 8 * MB), now - 864e5 - r() * 4 * 3600e3);
    // Non-Latin names: Kannada and Hindi.
    const habba = addFolder(S, 'Photos', 'ಹಬ್ಬ 2024');
    addFile(S, habba, 'ಪ್ರವಾಸದ ಫೋಟೋಗಳು 01.jpg', 4.2 * MB, pastDate(300));
    addFile(S, habba, 'ದೀಪಾವಳಿ ಹಬ್ಬದ ಸಂಭ್ರಮ - ಕುಟುಂಬ.jpg', 5.8 * MB, pastDate(300));
    addFile(S, habba, 'परिवार की तस्वीर.jpg', 3.1 * MB, pastDate(300));
    addFile(S, 'Documents', 'ಮನೆ ಖರ್ಚು ೨೦೨೫.xlsx', 182 * KB, pastDate(60));
    addFile(S, 'Documents', 'बजट २०२५.pdf', 640 * KB, pastDate(60));
    addFile(S, 'Music', 'ಭಾವಗೀತೆ - ಹಾಡುಗಳು.mp3', 7.4 * MB, pastDate(500));
    addFile(S, 'Family', 'शादी का वीडियो.mp4', 2.7 * GB, pastDate(700));
    // Very long names, over 100 characters.
    addFile(S, 'Documents', 'Quarterly household budget and expense reconciliation including utilities, groceries, school fees and travel - final reviewed copy v7.xlsx', 410 * KB, pastDate(40));
    addFile(S, 'Photos', 'Sunrise over the Western Ghats from the Kudremukh trek viewpoint taken on the second morning before breakfast (edited).jpg', 6.6 * MB, pastDate(200));
    addFile(S, 'Documents', 'annual-report-final-v3.pdf', 2.4 * MB, pastDate(20));
    // Spaces, hyphens, underscores, dots, parentheses.
    addFile(S, 'Documents', 'my.notes.v2.final (copy).txt', 14 * KB, pastDate(90));
    addFile(S, 'Documents', 'report.2024.03.draft-v2_FINAL.docx', 96 * KB, pastDate(90));
    addFile(S, 'Photos', 'photo_edit - final (1).jpg', 3.9 * MB, pastDate(90));
    // Mixed-case extensions.
    addFile(S, 'Videos', 'Holiday clip.Mp4', 640 * MB, pastDate(120));
    addFile(S, 'Documents', 'SCAN0001.PDF', 1.1 * MB, pastDate(120));
    addFile(S, 'Photos', 'Beach Day.JPEG', 4.4 * MB, pastDate(120));
    // Zero-byte files and files with no extension.
    addFile('system', 'Desktop', 'New Text Document.txt', 0, pastDate(30));
    addFile('system', 'Config', 'placeholder.log', 0, pastDate(30));
    addFile('system', 'Projects', 'README', 3 * KB, pastDate(30));
    addFile('system', 'Projects', 'Makefile', 2 * KB, pastDate(30));
    addFile('system', 'Projects', 'LICENSE', 1 * KB, pastDate(30));
    addFile('backup', 'Old laptop', 'notes', 0, pastDate(800));
    // An empty folder, on two shares.
    addFolder(S, 'Documents', 'New folder');
    addFolder('backup', 'Old laptop', 'Empty folder');
    // Deeply nested path, to test breadcrumb collapsing.
    let deep = 'Projects';
    for (const seg of ['Clients', '2024', 'Q3', 'Acme Interiors', 'Deliverables', 'Final', 'Revisions', 'Archive']) deep = addFolder(S, deep, seg);
    addFile(S, deep, 'floor-plan-rev-12.pdf', 3.3 * MB, pastDate(100));
    addFile(S, deep, 'site-photo-north-wall.jpg', 5.2 * MB, pastDate(100));
    // One file over 40GB.
    const full = addFolder('backup', 'Backups', 'Full');
    addFile('backup', full, 'Full system image 2025-03-02.img', 45812345678, pastDate(230));

    // ---- Bulk fill to each share's planned count ----
    for (const share of SHARES) {
      const p = PLAN[share.id];
      const have = entries.filter(e => e.share === share.id && e.kind === 'file').length;
      const list = folders[share.id].filter(f => !/^(New folder|Empty folder|Burst 2024)$/.test(f.path.split('/').pop()) && !f.path.includes('Acme Interiors'));
      for (let i = have; i < p.files; i++) {
        const cat = weighted(p.mix);
        const homes = list.filter(f => HOME_FOR[cat].includes(f.top));
        const folder = (homes.length && r() < .85 ? pick(homes) : pick(list)).path;
        const name = fileName(cat, share.id);
        addFile(share.id, folder, name, sizeFor(U.classify(name), share.id, name), pastDate(1100));
      }
    }

    assignOwnership(entries, opts.accounts || [], (opts.seed || SEED) + 7);
    return { version: VERSION, seed: opts.seed || SEED, generatedAt: iso(now), shares: defaultShares(now), entries };
  }

  // Ownership spread: ~40% common (ownerId null), ~5% the master's own, the rest split unevenly across
  // active devices so per-owner figures differ visibly. The phone's camera roll belongs to the first phone.
  // A revoked device's files start out already in the master's custody (ownerId master, uploadedBy device),
  // because that state is awkward to reach by hand and needs to exist from the first run.
  function assignOwnership(entries, accounts, seed) {
    const r = U.rng(seed);
    const master = accounts.find(a => a.type === 'master');
    const active = accounts.filter(a => a.type === 'device' && a.status === 'active');
    const revoked = accounts.filter(a => a.type === 'device' && a.status !== 'active');
    const phone = active.find(a => a.deviceType === 'phone') || active[0];
    const weights = active.map((_, i) => 1 / (i + 1.4)); // uneven: 0.71, 0.42, 0.29…
    const wsum = weights.reduce((a, b) => a + b, 0);
    const pickDevice = () => { let x = r() * wsum; for (let i = 0; i < active.length; i++) { x -= weights[i]; if (x <= 0) return active[i]; } return active[active.length - 1]; };
    const set = (e, acc) => { e.ownerId = acc ? acc.id : null; e.uploadedBy = acc ? acc.id : null; };
    for (const e of entries) {
      if (e.kind !== 'file' || !master) { set(e, null); continue; }
      if (phone && e.share === 'main' && (e.path === 'Camera Uploads' || e.path.startsWith('Camera Uploads/Burst'))) { set(e, phone); continue; }
      const x = r();
      if (x < 0.48 || !active.length) set(e, null);
      else if (x < 0.53) set(e, master);
      else set(e, pickDevice());
    }
    if (master && revoked.length) {
      const backup = entries.filter(e => e.kind === 'file' && e.share === 'backup' && e.path.startsWith('Phone backup'));
      backup.slice(0, 24).forEach(e => { e.ownerId = master.id; e.uploadedBy = revoked[0].id; });
    }
    return entries;
  }

  function defaultShares(now) {
    const t = new Date(now || Date.now()).toISOString();
    return SHARES.map(s => Object.assign({ lastSeenAt: t }, s));
  }

  // ---------- Attic Hub mock devices and transfers (Phase 1B) ----------
  // The four home devices from the requirements: the HP is the server, the rest are clients.
  // Base stats only; the API adds live movement on every read so the Devices view has something to show.
  function generateHub(opts) {
    opts = opts || {};
    const now = opts.now || Date.now();
    const owner = (opts.accounts || []).find(a => a.type === 'master');
    const ownerId = owner ? owner.id : null;
    const iso = t => new Date(t).toISOString();
    const GB = 1e9, MB = 1e6;
    const devices = [
      { id: 'dev_hp', name: 'HP laptop', role: 'server', os: 'Windows 11', kind: 'laptop', connection: 'ethernet', ip: '192.168.1.10',
        online: true, lastSeenAt: iso(now), userId: ownerId,
        base: { cpu: 9, ramTotal: 16 * GB, ramUsed: 5.1 * GB, diskTotal: 256 * GB, diskFree: 141 * GB, battery: null } },
      { id: 'dev_acer', name: 'Acer Aspire 5', role: 'client', os: 'Windows 11 Home', kind: 'laptop', connection: 'wifi', ip: '192.168.1.23',
        online: true, lastSeenAt: iso(now), userId: ownerId, thisPC: true,
        base: { cpu: 22, ramTotal: 8 * GB, ramUsed: 5.6 * GB, diskTotal: 512 * GB, diskFree: 188 * GB, battery: 78, charging: false } },
      { id: 'dev_ally', name: 'ASUS ROG Ally', role: 'client', os: 'Windows 11', kind: 'handheld', connection: 'wifi', ip: '192.168.1.31',
        online: false, lastSeenAt: iso(now - 3.2 * 3600e3), userId: ownerId,
        base: { cpu: 31, ramTotal: 16 * GB, ramUsed: 9.4 * GB, diskTotal: 512 * GB, diskFree: 96 * GB, battery: 41, charging: false } },
      { id: 'dev_iphone', name: 'iPhone', role: 'client', os: 'iOS', kind: 'phone', connection: 'wifi', ip: '192.168.1.44',
        online: true, lastSeenAt: iso(now), userId: ownerId, browserOnly: true, base: null }
    ];
    const r = U.rng((opts.seed || SEED) + 31);
    const files = ['Trip to Coorg.zip', 'IMG_4471.HEIC', 'Quarterly budget 2026.xlsx', 'Gameplay clip 0417.mp4', 'Resume final.pdf',
      'Goa 2023 — family.mov', 'Save backup (Elden Ring).7z', 'Scans 2026-09.pdf', 'Wallpapers.zip', 'Diwali photos.zip',
      'ಹಬ್ಬದ ವಿಡಿಯೋ.mp4', 'setup-notes.txt', 'Recording 2026-10-12.m4a', 'Screenshot 2026-10-29 at 21.04.png'];
    const pairs = [['dev_acer', 'dev_hp'], ['dev_iphone', 'dev_acer'], ['dev_hp', 'dev_acer'], ['dev_acer', 'dev_iphone'], ['dev_iphone', 'dev_hp']];
    const transfers = [];
    let n = 1;
    const add = t => transfers.push(Object.assign({ id: 'tr_' + (n++), userId: ownerId, error: null }, t));
    const speedFor = (a, b) => [a, b].includes('dev_hp') && [a, b].every(d => d !== 'dev_iphone') ? 60 * MB + r() * 30 * MB : 14 * MB + r() * 18 * MB;
    // History, newest first in the view: done over the last ten days.
    for (let i = 0; i < 12; i++) {
      const [from, to] = pairs[i % pairs.length];
      const size = Math.round(Math.exp(Math.log(200e3) + r() * (Math.log(3.5 * GB) - Math.log(200e3))));
      const speed = speedFor(from, to);
      const start = now - (0.3 + i * 0.85 + r() * 0.5) * 864e5;
      add({ fileName: files[i % files.length], size, from, to, status: 'done', speed: Math.round(speed),
        startedAt: iso(start), finishedAt: iso(start + size / speed * 1000), bytesDone: size });
    }
    // Two failures to the Ally, a queued one waiting for it, and two in flight right now.
    add({ fileName: 'Gameplay clip 0417.mp4', size: 1.84 * GB, from: 'dev_ally', to: 'dev_hp', status: 'failed', speed: 22 * MB,
      startedAt: iso(now - 3.4 * 3600e3), finishedAt: iso(now - 3.2 * 3600e3), bytesDone: 0.61 * GB, error: 'Connection to ASUS ROG Ally was lost.' });
    add({ fileName: 'Save backup (Elden Ring).7z', size: 420 * MB, from: 'dev_ally', to: 'dev_acer', status: 'failed', speed: 18 * MB,
      startedAt: iso(now - 3.3 * 3600e3), finishedAt: iso(now - 3.2 * 3600e3), bytesDone: 212 * MB, error: 'Connection to ASUS ROG Ally was lost.' });
    add({ fileName: 'Wallpapers.zip', size: 310 * MB, from: 'dev_acer', to: 'dev_ally', status: 'queued', speed: null,
      startedAt: iso(now - 40 * 60e3), finishedAt: null, bytesDone: 0 });
    add({ fileName: 'Trip to Coorg.zip', size: 2.1 * GB, from: 'dev_acer', to: 'dev_hp', status: 'active', speed: 41 * MB,
      startedAt: iso(now - 9e3), finishedAt: null, bytesDone: 0 });
    add({ fileName: 'IMG_4471.HEIC', size: 3.4 * MB, from: 'dev_iphone', to: 'dev_acer', status: 'active', speed: 1.2 * MB,
      startedAt: iso(now - 1e3), finishedAt: null, bytesDone: 0 });
    transfers.forEach(t => { t.size = Math.round(t.size); t.bytesDone = Math.round(t.bytesDone); });
    return { version: 1, generatedAt: iso(now), devices, transfers };
  }

  const VERSION = 2; // 2 = entries carry ownerId and uploadedBy
  const api = { generate, assignOwnership, defaultShares, generateHub, SEED, VERSION };
  if (root.Attic) root.Attic.mock = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
