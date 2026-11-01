// Shared helpers: classification, formatting, hashing, icons. Loaded first; also usable from Node.
(function (root) {
  'use strict';

  const EXT = {
    photos: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp', 'tiff'],
    videos: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv'],
    audio: ['mp3', 'wav', 'flac', 'm4a', 'aac'],
    documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md'],
    archives: ['zip', 'rar', '7z', 'tar', 'gz']
  };
  const BY_EXT = {};
  for (const cat in EXT) for (const e of EXT[cat]) BY_EXT[e] = cat;

  const CATEGORY_LABEL = { photos: 'Photos', videos: 'Videos', audio: 'Audio', documents: 'Documents', archives: 'Archives', other: 'Other', free: 'Free' };
  const CATEGORY_ORDER = ['photos', 'videos', 'audio', 'documents', 'archives', 'other'];

  // Always lowercase before matching: ".JPG" and ".Mp4" must classify like their lowercase twins.
  function extOf(name) {
    const i = name.lastIndexOf('.');
    if (i <= 0 || i === name.length - 1) return '';
    return name.slice(i + 1).toLowerCase();
  }
  function classify(name) { return BY_EXT[extOf(name)] || 'other'; }
  function tabOf(category) { return category === 'photos' || category === 'videos' ? category : 'other'; }

  function typeLabel(entry) {
    if (entry.kind === 'folder') return 'Folder';
    const e = extOf(entry.name);
    return e ? e.toUpperCase() + ' ' + ({ photos: 'image', videos: 'video', audio: 'audio', documents: 'document', archives: 'archive' }[entry.category] || 'file') : 'File';
  }

  // Sizes are integer bytes everywhere; this is the one place they become text. Decimal units, like drive labels.
  function formatBytes(n) {
    if (n == null) return '';
    if (n < 1000) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let v = n, u = -1;
    do { v /= 1000; u++; } while (v >= 1000 && u < units.length - 1);
    return (v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')) + ' ' + units[u];
  }
  function formatCount(n) { return n.toLocaleString(); }
  function pct(part, whole) { return whole ? part / whole * 100 : 0; }
  function formatPct(p) { return (p < 10 && p > 0 ? p.toFixed(1) : Math.round(p)) + '%'; }

  // Timestamps are ISO UTC strings; converted to local only here. null means never (a share the server
  // has not yet seen connected).
  function absDate(iso, withTime) {
    if (iso == null) return 'never';
    const d = new Date(iso);
    const opts = { day: 'numeric', month: 'short', year: 'numeric' };
    if (withTime) { opts.hour = 'numeric'; opts.minute = '2-digit'; }
    return d.toLocaleString(undefined, opts);
  }
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function relDate(iso) {
    if (iso == null) return 'never';
    const d = new Date(iso), now = new Date();
    const diff = now - d;
    if (diff < 60e3) return 'Just now';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' min ago';
    const days = Math.round((startOfDay(now) - startOfDay(d)) / 864e5);
    if (days === 0) return Math.floor(diff / 3600e3) + ' hr ago';
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    return absDate(iso);
  }
  function timeOnly(iso) { return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Middle truncation keeps the extension: the head gets the ellipsis via CSS, the tail never shrinks.
  function graphemes(s) {
    if (typeof Intl !== 'undefined' && Intl.Segmenter) return Array.from(new Intl.Segmenter().segment(s), x => x.segment);
    return Array.from(s);
  }
  function splitName(name) {
    const g = graphemes(name);
    const e = extOf(name);
    const keep = Math.min(g.length - 1, (e ? e.length + 1 : 0) + 6);
    if (g.length <= 12 || keep <= 0) return [name, ''];
    return [g.slice(0, g.length - keep).join(''), g.slice(g.length - keep).join('')];
  }
  function nameHTML(name) {
    const [a, b] = splitName(name);
    return `<span class="trunc" title="${esc(name)}"><span class="trunc-a">${esc(a)}</span>${b ? `<span class="trunc-b">${esc(b)}</span>` : ''}</span>`;
  }

  function joinPath(a, b) { return a ? a + '/' + b : b; }
  function debounce(fn, ms) { let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); }; }

  // Line icons on a 24 grid, 2px round strokes.
  const P = {
    folder: '<path d="M4 6.5A1.5 1.5 0 0 1 5.5 5H9l2 2.5h7.5A1.5 1.5 0 0 1 20 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/>',
    file: '<path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z"/><path d="M14 3.5v4h4"/>',
    photo: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4.5 17 4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5"/>',
    video: '<rect x="3.5" y="6" width="12.5" height="12" rx="2"/><path d="m16 10.5 4.5-2.5v8l-4.5-2.5"/>',
    music: '<circle cx="7.5" cy="17" r="2.5"/><circle cx="17" cy="15" r="2.5"/><path d="M10 17V6l9.5-2v11"/>',
    doc: '<path d="M14 3.5H7.5A1.5 1.5 0 0 0 6 5v14a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 18 19V7.5z"/><path d="M14 3.5v4h4M9 12h6M9 15.5h6"/>',
    archive: '<rect x="4" y="4" width="16" height="5" rx="1.5"/><path d="M5.5 9v9.5A1.5 1.5 0 0 0 7 20h10a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/>',
    search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M5.6 18.4l1.1-1.1M17.3 6.7l1.1-1.1"/>',
    moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>',
    user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M10 5.7a9 9 0 0 1 2-.2c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.4 3.2M6.6 6.6C3.9 8.3 2.5 12 2.5 12s3.5 6.5 9.5 6.5a9 9 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18"/>',
    chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
    chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
    chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    upload: '<path d="M12 15.5V4M7 8.5 12 3.5l5 5M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15"/>',
    download: '<path d="M12 4v11.5M7 10.5l5 5 5-5M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5A1.5 1.5 0 0 0 9 21h6a1.5 1.5 0 0 0 1.5-1.5l1-12.5"/>',
    image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4.5 17 4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1h-.2a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h0a1.6 1.6 0 0 0 1-1.5v-.2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v0a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    logout: '<path d="M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14M10 12h10.5M17 8.5l3.5 3.5-3.5 3.5"/>',
    grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h0M4.5 12h0M4.5 18h0"/>',
    refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>',
    shield: '<path d="M12 3.5 19 6v5.5c0 4.5-3 7.6-7 9-4-1.4-7-4.5-7-9V6z"/><path d="m9 12 2 2 4-4"/>',
    phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 17.5h2"/>',
    tablet: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 17.5h2"/>',
    laptop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M3 19h18"/>',
    desktop: '<rect x="3.5" y="4" width="17" height="11.5" rx="1.5"/><path d="M9 20h6M12 15.5V20"/>',
    device: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="12" cy="12" r="2.5"/>',
    ssd: '<rect x="3.5" y="6.5" width="17" height="11" rx="2"/><path d="M7 10h4M7 14h2"/><circle cx="16.5" cy="12" r="1"/>',
    hdd: '<rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="12" cy="11" r="4"/><circle cx="12" cy="11" r=".6"/><path d="M8 17.5h0"/>',
    usb: '<rect x="6" y="9" width="12" height="11.5" rx="2"/><path d="M8.5 9V4h7v5M10.5 6.5h0M13.5 6.5h0"/>',
    alert: '<path d="M12 4 21 19.5H3z"/><path d="M12 10v4M12 17h0"/>',
    alertCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 15.8h0"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8h0"/>',
    reveal: '<path d="M4 6.5A1.5 1.5 0 0 1 5.5 5H9l2 2.5h7.5A1.5 1.5 0 0 1 20 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><path d="M10 13h5M13 11l2 2-2 2"/>',
    cloudOff: '<path d="M3 3l18 18M8.5 6.3A6 6 0 0 1 17 10a4 4 0 0 1 3 6.5M17 19H7a4.5 4.5 0 0 1-1.5-8.7"/>',
    ban: '<circle cx="12" cy="12" r="8.5"/><path d="m6 6 12 12"/>',
    undo: '<path d="M9 14 4.5 9.5 9 5M4.5 9.5H15a5 5 0 0 1 0 10h-2"/>',
    dots: '<path d="M5.5 12h0M12 12h0M18.5 12h0"/>',
    database: '<ellipse cx="12" cy="6" rx="7.5" ry="2.5"/><path d="M4.5 6v12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V6M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5"/>',
    monitor: '<rect x="3.5" y="4" width="17" height="11.5" rx="1.5"/><path d="M9 20h6M12 15.5V20"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    transfer: '<path d="M4 8h14M14.5 4.5 18 8l-3.5 3.5M20 16H6M9.5 12.5 6 16l3.5 3.5"/>',
    wifi: '<path d="M3 9.5a13 13 0 0 1 18 0M6 13a8.5 8.5 0 0 1 12 0M9 16.5a4 4 0 0 1 6 0M12 20h0"/>',
    ethernet: '<rect x="5" y="5" width="14" height="11" rx="1.5"/><path d="M9 16v3.5h6V16M9 9v2.5M12 9v2.5M15 9v2.5"/>',
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
    memory: '<rect x="3.5" y="7" width="17" height="10" rx="1.5"/><path d="M7 11v2M10.5 11v2M14 11v2M17.5 11v2M6 17v2.5M18 17v2.5"/>',
    battery: '<rect x="3" y="7.5" width="16" height="9" rx="2"/><path d="M21 10.5v3"/>',
    plug: '<path d="M9 3.5v4M15 3.5v4M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0zM12 16.5v4"/>'
  };
  function icon(name, cls) {
    return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${P[name] || P.file}</svg>`;
  }
  function fileIcon(entry) {
    if (entry.kind === 'folder') return icon('folder', 'ic-folder');
    return icon({ photos: 'photo', videos: 'video', audio: 'music', documents: 'doc', archives: 'archive' }[entry.category] || 'file', 'ic-' + entry.category);
  }
  function deviceIcon(type) { return icon({ phone: 'phone', tablet: 'tablet', laptop: 'laptop', desktop: 'desktop' }[type] || 'device'); }
  function shareIcon(type) { return icon({ ssd: 'ssd', hdd: 'hdd', external: 'usb' }[type] || 'hdd'); }

  const util = {
    EXT, CATEGORY_LABEL, CATEGORY_ORDER, extOf, classify, tabOf, typeLabel,
    formatBytes, formatCount, pct, formatPct, absDate, relDate, timeOnly, startOfDay,
    esc, hash, rng, splitName, nameHTML, joinPath, debounce, icon, fileIcon, deviceIcon, shareIcon
  };
  root.Attic = root.Attic || {};
  root.Attic.util = util;
  if (typeof module !== 'undefined') module.exports = util;
})(typeof window !== 'undefined' ? window : globalThis);
