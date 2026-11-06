// Shared interface pieces: logo, theme, dialogs, menus, toasts, loading states, virtual list.
(function (root) {
  'use strict';
  const U = root.Attic.util;
  const ui = {};

  // ---------- logo: a roof over a storage box ----------
  ui.mark = (cls) => `<svg class="brand-mark${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">
    <rect width="24" height="24" rx="6" fill="var(--accent)"/>
    <path d="M4.5 12 12 5.5l7.5 6.5" fill="none" stroke="var(--accent-ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="7.5" y="13.5" width="9" height="5" rx="1.2" fill="var(--accent-ink)"/></svg>`;
  ui.brand = () => `<div class="brand">${ui.mark()}<span class="brand-word">Attic</span></div>`;

  // ---------- which kind of device (Phase 4, 4-1) ----------
  // handheld: a phone or tablet's browser (not the desktop tool, even on the ROG Ally's touch screen).
  // It can't choose a folder or drag files, so those actions are hidden (class "desktop-only").
  // standalone: opened from the Home Screen, full screen, with no Safari address bar.
  const nav = root.navigator || {};
  ui.isIOS = /iPhone|iPad|iPod/.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  ui.handheld = !root.atticDesktop && (ui.isIOS || root.matchMedia('(hover: none) and (pointer: coarse)').matches);
  ui.standalone = nav.standalone === true || root.matchMedia('(display-mode: standalone)').matches;
  ui.canPickFolder = !ui.handheld;
  document.documentElement.classList.toggle('handheld', ui.handheld);
  document.documentElement.classList.toggle('ios', ui.isIOS);
  document.documentElement.classList.toggle('standalone', ui.standalone);

  // The one-time steps for a phone to trust the HP's own certificate (the HP's README, "HTTPS for the
  // iPhone"), as list items. tls: GET /api/tls.
  ui.secureSteps = (tls) => {
    const fp = tls && tls.caFingerprint ? ` Its fingerprint should be <span class="mono fp">${U.esc(tls.caFingerprint)}</span>.` : '';
    const profile = U.esc((tls && tls.profileUrl) || '/api/tls/profile.mobileconfig');
    return ui.isIOS || !ui.handheld ? `
      <li><a href="${profile}" class="ph-profile">Download the HP’s profile</a>, and allow it.</li>
      <li>In Settings → General → VPN &amp; Device Management, tap the Attic Hub profile, then Install.</li>
      <li>In Settings → General → About → Certificate Trust Settings, turn on the Attic Hub CA.${fp}</li>
      <li>Come back here and open the secure address.</li>` : `
      <li><a href="${U.esc((tls && tls.caUrl) || '/api/tls/ca.cer')}" class="ph-profile">Download the HP’s certificate</a>.</li>
      <li>In your phone’s security settings, install it as a CA certificate.${fp}</li>
      <li>Come back here and open the secure address.</li>`;
  };

  // ---------- theme ----------
  const mq = root.matchMedia('(prefers-color-scheme: dark)');
  let themePref = 'system';
  ui.applyTheme = (pref) => {
    themePref = pref || 'system';
    const dark = themePref === 'dark' || (themePref === 'system' && mq.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  };
  ui.isDark = () => document.documentElement.dataset.theme === 'dark';
  mq.addEventListener('change', () => { if (themePref === 'system') ui.applyTheme('system'); });

  // Low-resource mode (Phase 3, 3-4, T-09): the desktop tool says when a game is running (or the mode is
  // Always on). Then the whole interface goes still: no animations, transitions, blur or background
  // slideshow (the low-resource class in app.css), and everything that asks reducedMotion() holds still too.
  ui.lowResource = false;
  ui.reducedMotion = () => ui.lowResource || root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (root.atticDesktop && root.atticDesktop.lowResource) {
    const applyLow = s => {
      const on = !!(s && s.active);
      const flipped = on !== ui.lowResource;
      ui.lowResource = on;
      document.documentElement.classList.toggle('low-resource', on);
      if (flipped) root.dispatchEvent(new CustomEvent('attic:low-resource', { detail: s }));
      root.dispatchEvent(new CustomEvent('attic:low-state', { detail: s })); // for Settings' status line
    };
    root.atticDesktop.lowResource.onChange(applyLow);
    root.atticDesktop.lowResource.get().then(applyLow).catch(() => {});
  }
  // Updates (3-5): the "ready to install" notification was clicked: show Settings, at Updates.
  if (root.atticDesktop && root.atticDesktop.updates && root.atticDesktop.updates.onOpen) {
    root.atticDesktop.updates.onOpen(() => {
      ui.wantUpdates = true;
      if (location.hash === '#/settings') root.dispatchEvent(new HashChangeEvent('hashchange'));
      else location.hash = '#/settings';
    });
  }

  // ---------- toasts ----------
  ui.toast = (msg, kind) => {
    let box = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' error' : '');
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.innerHTML = U.icon(kind === 'error' ? 'alertCircle' : 'check') + `<span>${U.esc(msg)}</span>`;
    box.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, kind === 'error' ? 4200 : 2400);
  };

  // ---------- dialogs ----------
  ui.dialog = ({ title, lead, body, actions, wide, onOpen, label }) => {
    const prev = document.activeElement;
    const veil = document.createElement('div');
    veil.className = 'veil';
    veil.innerHTML = `<div class="dialog${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-label="${U.esc(label || title)}">
      <h2>${U.esc(title)}</h2>${lead ? `<p class="lead">${lead}</p>` : ''}<div class="dialog-body">${body || ''}</div>
      ${actions && actions.length ? `<div class="dialog-actions">${actions.map((a, i) => `<button class="btn btn-${a.kind || 'secondary'}" data-i="${i}" type="${a.submit ? 'submit' : 'button'}">${U.esc(a.label)}</button>`).join('')}</div>` : ''}</div>`;
    document.body.appendChild(veil);
    const dlg = veil.firstElementChild;
    const close = () => { veil.remove(); document.removeEventListener('keydown', onKey, true); if (prev && prev.focus) prev.focus(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Tab') {
        const f = [...dlg.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    veil.addEventListener('mousedown', e => { if (e.target === veil) close(); });
    (actions || []).forEach((a, i) => dlg.querySelector(`[data-i="${i}"]`).addEventListener('click', () => a.onClick ? a.onClick(close, dlg) : close()));
    if (onOpen) onOpen(dlg, close);
    const first = dlg.querySelector('input, select, textarea') || dlg.querySelector('.dialog-actions .btn:last-child') || dlg.querySelector('button');
    if (first) first.focus();
    return { el: dlg, close };
  };

  ui.confirm = ({ title, lead, body, confirm, danger }) => new Promise(resolve => {
    let done = false;
    const d = ui.dialog({
      title, lead, body,
      actions: [
        { label: 'Cancel', kind: 'secondary', onClick: c => { done = true; c(); resolve(false); } },
        { label: confirm || 'Confirm', kind: danger ? 'danger' : 'primary', onClick: c => { done = true; c(); resolve(true); } }
      ]
    });
    const obs = new MutationObserver(() => { if (!d.el.isConnected) { obs.disconnect(); if (!done) resolve(false); } });
    obs.observe(document.body, { childList: true });
  });

  // ---------- menus ----------
  ui.menu = (anchor, html, onReady) => {
    ui.closeMenus();
    const m = document.createElement('div');
    m.className = 'menu';
    m.setAttribute('role', 'menu');
    m.innerHTML = html;
    document.body.appendChild(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = (r.bottom + 6 + root.scrollY) + 'px';
    m.style.left = Math.max(8, Math.min(root.innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth)) + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    const close = () => { m.remove(); anchor.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', key, true); };
    const outside = e => { if (!m.contains(e.target) && !anchor.contains(e.target)) close(); };
    const key = e => {
      const items = [...m.querySelectorAll('.menu-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); close(); anchor.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    };
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', key, true);
    m._close = close;
    const first = m.querySelector('.menu-item');
    if (first) first.focus();
    if (onReady) onReady(m, close);
    return close;
  };
  ui.closeMenus = () => document.querySelectorAll('.menu').forEach(m => m._close ? m._close() : m.remove());

  // ---------- states ----------
  ui.empty = ({ icon, title, text, action }) =>
    `<div class="state"><div class="art">${U.icon(icon || 'folder')}</div><h3>${U.esc(title)}</h3><p>${U.esc(text)}</p>${action || ''}</div>`;
  ui.errorState = (err, retryId) =>
    `<div class="state error" role="alert"><div class="art">${U.icon('alertCircle')}</div><h3>Couldn’t load this</h3>
     <p>${U.esc(err && err.message ? err.message : 'Something went wrong.')} Your files are not affected.</p>
     <button class="btn btn-secondary" id="${retryId || 'retry'}">${U.icon('refresh')}Try again</button></div>`;
  ui.unavailableState = (name, retryId) =>
    `<div class="state unavailable"><div class="art">${U.icon('cloudOff')}</div><h3>${U.esc(name)} is unavailable</h3>
     <p>The drive isn’t connected right now. Nothing has been deleted — its files will be back when it’s plugged in.</p>
     <button class="btn btn-secondary" id="${retryId || 'retry'}">${U.icon('refresh')}Check again</button></div>`;
  ui.skeletonRows = (n) => Array.from({ length: n || 10 }, (_, i) =>
    `<div class="skel-row"><div class="skel"></div><div class="skel" style="width:${40 + (i * 37) % 45}%"></div><div class="skel" style="width:60%"></div><div class="skel" style="width:70%"></div><div class="skel" style="width:55%"></div></div>`).join('');
  ui.skeletonTiles = (n, ratio) => `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px">${Array.from({ length: n || 18 }, () => `<div class="skel" style="aspect-ratio:${ratio || 1}"></div>`).join('')}</div>`;

  // Skeleton appears only if data takes longer than 200ms: a flash of skeleton is worse than a brief pause.
  ui.load = async (container, promise, skeletonHTML) => {
    const t = setTimeout(() => { if (container.isConnected) container.innerHTML = skeletonHTML; }, 200);
    try { return await promise; } finally { clearTimeout(t); }
  };

  // A photo's real preview, served by the HP. Anything that isn't a photo has none, and shows its icon.
  ui.thumbFor = (e) => e && e.share && e.category === 'photos' ? root.Attic.api.mediaUrl(e) : null;
  ui.bgStyle = (e) => { const u = ui.thumbFor(e); return u ? `background-image:url('${u}')` : ''; };
  ui.formatDuration = (secs) => {
    if (!isFinite(secs)) return '';
    secs = Math.round(secs);
    const h = Math.floor(secs / 3600), m = Math.floor(secs % 3600 / 60), s = secs % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  };

  // Time left at the current speed (feedback 1: sending shows how long it will take).
  ui.timeLeft = (secs) => {
    if (!isFinite(secs) || secs < 0) return '';
    if (secs < 10) return 'a few seconds left';
    if (secs < 60) return 'less than a minute left';
    const m = Math.round(secs / 60);
    if (m < 60) return `about ${m} min left`;
    return `about ${Math.floor(m / 60)} h ${m % 60 ? (m % 60) + ' min ' : ''}left`;
  };
  // Speed over the last few seconds, so a moment's stall doesn't swing the estimate. meter(bytesDone) →
  // bytes a second (0 until there's enough to go on).
  ui.rateMeter = (windowMs = 5000) => {
    const pts = [];
    return (done) => {
      const now = Date.now();
      pts.push([now, done]);
      while (pts.length > 2 && now - pts[0][0] > windowMs) pts.shift();
      const [t0, d0] = pts[0], dt = (now - t0) / 1000;
      return dt >= 1 && done > d0 ? (done - d0) / dt : 0;
    };
  };

  // ---------- virtual list: renders only the rows in view ----------
  // rows: [{ key, h, ... }]; render(row) returns an element positioned by the list.
  ui.virtual = ({ scroller, host, rows, render, overscan }) => {
    overscan = overscan == null ? 400 : overscan;
    let offs = [], total = 0, nodes = new Map(), raf = 0;
    function layout(list) {
      rows = list; offs = new Array(rows.length); total = 0;
      for (let i = 0; i < rows.length; i++) { offs[i] = total; total += rows[i].h; }
      host.style.height = total + 'px';
      for (const [, n] of nodes) n.remove();
      nodes.clear();
      draw();
    }
    function hostTop() { return host.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop; }
    function find(y) { let lo = 0, hi = rows.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (offs[mid] <= y) lo = mid; else hi = mid - 1; } return lo; }
    function draw() {
      raf = 0;
      if (!rows.length) return;
      const top = scroller.scrollTop - hostTop();
      const a = find(Math.max(0, top - overscan)), b = find(Math.max(0, top + scroller.clientHeight + overscan));
      const want = new Set();
      for (let i = a; i <= b; i++) want.add(rows[i].key);
      for (const [k, n] of nodes) {
        if (!want.has(k) && !n.contains(document.activeElement)) { n.remove(); nodes.delete(k); }
      }
      for (let i = a; i <= b; i++) {
        const r = rows[i];
        if (nodes.has(r.key)) continue;
        const el = render(r, i);
        el.style.top = offs[i] + 'px';
        el.style.height = r.h + 'px';
        host.appendChild(el);
        nodes.set(r.key, el);
      }
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(draw); };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    root.addEventListener('resize', onScroll);
    layout(rows);
    return {
      update: layout,
      scrollToKey(key) {
        const i = rows.findIndex(r => r.key === key);
        if (i < 0) return;
        scroller.scrollTop = hostTop() + offs[i] - scroller.clientHeight / 3;
        draw();
      },
      node: key => nodes.get(key),
      destroy() { scroller.removeEventListener('scroll', onScroll); root.removeEventListener('resize', onScroll); if (raf) cancelAnimationFrame(raf); }
    };
  };

  ui.el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };

  root.Attic.ui = ui;
})(window);
