// The persistent signed-in frame: header, tab bar and content area.
(function (root) {
  'use strict';
  const A = root.Attic;
  const { util: U, ui } = A;

  const TABS = [
    { id: 'dashboard', label: 'Dashboard', icon: 'database', master: true },
    { id: 'files', label: 'Files', icon: 'folder' },
    { id: 'photos', label: 'Photos', icon: 'photo' },
    { id: 'videos', label: 'Videos', icon: 'video' },
    { id: 'other', label: 'Other', icon: 'doc' },
    { id: 'devices', label: 'Devices', icon: 'device' },
    { id: 'transfers', label: 'Transfers', icon: 'transfer' }
  ];

  function initials(name) {
    const parts = (name || '?').trim().split(/\s+/);
    return U.esc(((parts[0] || '')[0] || '?') + ((parts[1] || '')[0] || '')).toUpperCase();
  }

  function create(app, ctx) {
    const { account, session } = ctx.state;
    const master = session.type === 'master';
    // Device accounts never see Dashboard: absent from the DOM, not hidden.
    const tabs = TABS.filter(t => !t.master || master);
    app.innerHTML = `<div class="shell">
      <header class="header">
        <a class="home" href="#/" aria-label="Attic home">${ui.mark()}<span class="brand-word">Attic</span></a>
        <nav class="loc" id="loc" aria-label="Location"></nav>
        <span class="spacer"></span>
        <div class="search" id="search-wrap"><label class="sr-only" for="search">Search</label>${U.icon('search')}<input id="search" type="search" placeholder="Search" autocomplete="off"></div>
        <button class="icon-btn search-toggle" id="search-toggle" aria-label="Search" aria-expanded="false">${U.icon('search')}</button>
        <button class="icon-btn theme-btn" id="theme-btn" aria-label="Switch theme"></button>
        ${master ? `<span class="master-pill" title="Signed in as master: full access">${U.icon('shield')}<span class="txt">Master</span></span>` : ''}
        <button class="acct-btn" id="acct" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu for ${U.esc(account.displayName)}">
          <span class="avatar${master ? ' master' : ''}">${initials(account.displayName)}</span></button>
      </header>
      <div class="mobile-search" id="msearch"><div class="search"><label class="sr-only" for="search-m">Search</label>${U.icon('search')}<input id="search-m" type="search" placeholder="Search" autocomplete="off"></div></div>
      <nav class="tabs" aria-label="Sections">
        ${tabs.map(t => `<a class="tab" href="#/${t.id}" data-tab="${t.id}">${U.icon(t.icon)}<span>${t.label}</span></a>`).join('')}
      </nav>
      <main class="main" id="main" tabindex="-1"></main>
    </div>`;

    const el = {
      main: app.querySelector('#main'), loc: app.querySelector('#loc'),
      search: app.querySelector('#search'), searchM: app.querySelector('#search-m'),
      searchWrap: app.querySelector('#search-wrap'), msearch: app.querySelector('#msearch'),
      searchToggle: app.querySelector('#search-toggle'), theme: app.querySelector('#theme-btn')
    };
    let onSearch = null;

    const syncTheme = () => {
      const dark = ui.isDark();
      el.theme.innerHTML = U.icon(dark ? 'sun' : 'moon');
      el.theme.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
      el.theme.title = el.theme.getAttribute('aria-label');
    };
    syncTheme();
    const toggleTheme = async () => {
      const next = ui.isDark() ? 'light' : 'dark';
      ui.applyTheme(next);
      syncTheme();
      ctx.state.settings = await root.Attic.api.updateSettings({ theme: next }).catch(() => ctx.state.settings);
    };
    el.theme.onclick = toggleTheme;

    const fire = U.debounce(v => onSearch && onSearch(v), 150);
    [el.search, el.searchM].forEach(inp => inp.addEventListener('input', () => {
      const other = inp === el.search ? el.searchM : el.search;
      other.value = inp.value;
      fire(inp.value);
    }));
    el.searchToggle.onclick = () => {
      const open = !el.msearch.classList.contains('open');
      el.msearch.classList.toggle('open', open);
      el.searchToggle.setAttribute('aria-expanded', open);
      if (open) el.searchM.focus();
    };

    app.querySelector('#acct').onclick = (e) => {
      const btn = e.currentTarget;
      if (btn.getAttribute('aria-expanded') === 'true') return ui.closeMenus();
      ui.menu(btn, `
        <div class="menu-head"><div class="name">${U.esc(account.displayName)}</div>
          <div class="meta">${master ? 'Master account' : 'Device account'} · @${U.esc(account.username)}</div>
          ${session.deviceType ? `<div class="meta" style="display:flex;align-items:center;gap:6px;margin-top:6px">${A.device.art(session.deviceType, 22)}Signed in on a ${A.device.LABEL[session.deviceType].toLowerCase()}</div>` : ''}</div>
        <a class="menu-item" role="menuitem" href="#/settings">${U.icon('settings')}Settings</a>
        <button class="menu-item" role="menuitem" data-act="theme">${U.icon(ui.isDark() ? 'sun' : 'moon')}${ui.isDark() ? 'Light theme' : 'Dark theme'}</button>
        <div class="menu-sep"></div>
        <button class="menu-item" role="menuitem" data-act="out">${U.icon('logout')}Sign out</button>`,
      (m, close) => {
        m.querySelector('a').onclick = () => close();
        m.querySelector('[data-act=theme]').onclick = () => { close(); toggleTheme(); };
        m.querySelector('[data-act=out]').onclick = () => { close(); ctx.signOut(); };
      });
    };

    return {
      main: el.main,
      setTab(id) {
        app.querySelectorAll('.tab').forEach(t => {
          if (t.dataset.tab === id) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
          if (t.dataset.tab === 'files') t.setAttribute('href', ctx.state.tabs.files.lastHash || '#/files');
        });
      },
      setLocation(html) { el.loc.innerHTML = html; },
      // Search is scoped to the active tab; hidden where there is nothing to search.
      setSearch(opts) {
        onSearch = opts ? opts.onInput : null;
        const show = !!opts;
        el.searchWrap.style.visibility = show ? '' : 'hidden';
        el.searchToggle.style.visibility = show ? '' : 'hidden';
        if (!show) el.msearch.classList.remove('open');
        [el.search, el.searchM].forEach(i => { i.value = opts ? opts.value || '' : ''; i.placeholder = opts ? opts.placeholder : ''; });
      },
      syncTheme
    };
  }

  root.Attic.shell = { create, TABS };
})(window);
