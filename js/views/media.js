// Photos, Videos and Other: filtered, flattened views over the one file index — "everything of this kind, newest first".
(function (root) {
  'use strict';
  const { util: U, api, ui, files } = root.Attic;

  const CONF = {
    photos: { title: 'Photos', noun: 'photo', icon: 'photo', empty: 'Photos from every share appear here, newest first, wherever they’re stored.' },
    videos: { title: 'Videos', noun: 'video', icon: 'video', empty: 'Videos from every share appear here. Playback arrives in Phase 4.' },
    other: { title: 'Other', noun: 'file', icon: 'doc', empty: 'Documents, archives, audio and anything else that isn’t a photo or video.' }
  };
  const OTHER_GROUPS = [['documents', 'Documents'], ['archives', 'Archives'], ['audio', 'Audio'], ['other', 'Unknown']];
  const PHOTO_SIZES = { s: 104, m: 156, l: 232 };

  function sorter(sort) {
    if (sort === 'name') return (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    if (sort === 'oldest') return (a, b) => a.modifiedAt.localeCompare(b.modifiedAt);
    return (a, b) => b.modifiedAt.localeCompare(a.modifiedAt);
  }
  // Today, Yesterday, then by month.
  function dateGroup(iso) {
    const d = new Date(iso), today = U.startOfDay(new Date());
    const days = Math.round((today - U.startOfDay(d)) / 864e5);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  function revealButton(e) { return `<button class="btn btn-secondary" data-reveal="${e.id}">${U.icon('reveal')}Reveal in Files</button>`; }
  function reveal(ctx, e) { ctx.go(files.folderHash(e.share, e.path, e.id)); }

  function detailDialog(ctx, e, shares) {
    const share = shares.find(s => s.id === e.share) || { name: e.share, rootPath: '' };
    const full = share.rootPath + '\\' + U.joinPath(e.path, e.name).replace(/\//g, '\\');
    const isVideo = e.category === 'videos';
    const d = ui.dialog({
      title: e.name, label: 'Details for ' + e.name,
      body: `${isVideo ? `<div class="vcard" style="border:0;margin-bottom:14px;cursor:default"><div class="poster" style="background-image:url('${ui.thumbFor(e.name)}');border-radius:12px"><span class="play">${U.icon('play')}</span><span class="dur">${ui.durationFor(e)}</span></div></div>
          <div class="banner banner-info">${U.icon('info')}<span>Playback arrives in Phase 4. For now this shows the file’s details.</span></div>` : ''}
        <dl class="kv">
          <dt>Location</dt><dd class="mono">${U.esc(full)}</dd>
          <dt>Size</dt><dd><span class="mono">${U.formatBytes(e.size)}</span></dd>
          ${isVideo ? `<dt>Duration</dt><dd class="mono">${ui.durationFor(e)}</dd>` : ''}
          <dt>Type</dt><dd>${U.esc(U.typeLabel(e))}</dd>
          <dt>Modified</dt><dd>${U.absDate(e.modifiedAt, true)}</dd>
        </dl>`,
      actions: [
        { label: 'Close', kind: 'secondary' },
        { label: 'Reveal in Files', kind: 'primary', onClick: c => { c(); reveal(ctx, e); } }
      ]
    });
    return d;
  }

  function lightbox(ctx, list, index, onClose) {
    let i = index;
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.setAttribute('aria-label', 'Photo viewer');
    document.body.appendChild(lb);
    function draw() {
      const e = list[i];
      lb.innerHTML = `<div class="lb-top"><div class="info"><div class="nm">${U.nameHTML(e.name)}</div><div class="c">${U.absDate(e.modifiedAt, true)} · <span class="mono">${U.formatBytes(e.size)}</span> · ${i + 1} of ${list.length}</div></div>
        ${revealButton(e)}<button class="icon-btn" id="lb-close" aria-label="Close viewer">${U.icon('x')}</button></div>
        <div class="lb-stage"><button class="lb-nav" id="lb-prev" aria-label="Previous photo" ${i === 0 ? 'disabled' : ''}>${U.icon('chevronLeft')}</button>
        <div class="lb-img" role="img" aria-label="${U.esc(e.name)}" style="background-image:url('${ui.thumbFor(e.name)}')"></div>
        <button class="lb-nav" id="lb-next" aria-label="Next photo" ${i === list.length - 1 ? 'disabled' : ''}>${U.icon('chevronRight')}</button></div>`;
      lb.querySelector('.btn').className = 'btn btn-secondary btn-sm';
      lb.querySelector('[data-reveal]').onclick = () => { close(); reveal(ctx, e); };
      lb.querySelector('#lb-close').onclick = close;
      lb.querySelector('#lb-prev').onclick = () => step(-1);
      lb.querySelector('#lb-next').onclick = () => step(1);
    }
    function step(d) { const n = i + d; if (n >= 0 && n < list.length) { i = n; draw(); lb.querySelector(d > 0 ? '#lb-next' : '#lb-prev').focus(); } }
    function key(e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    function close() { document.removeEventListener('keydown', key, true); lb.remove(); onClose(list[i]); }
    document.addEventListener('keydown', key, true);
    draw();
    lb.querySelector('#lb-close').focus();
  }

  async function render(ctx) {
    const tab = ctx.route.segs[0];
    const conf = CONF[tab];
    const { main, shell, state } = ctx;
    const ts = state.tabs[tab];
    shell.setLocation(`<span class="title">${conf.title}</span><span class="muted" style="margin-left:6px">from all shares</span>`);

    let shares = [];
    main.innerHTML = `<div class="page"><div class="page-head"><h1>${conf.title}</h1><span class="muted" id="mcount"></span><span class="grow"></span>
      <div class="toolbar">
        <label class="sr-only" for="mshare">Share</label><select class="plain-select" id="mshare"><option value="">All shares</option></select>
        <label class="sr-only" for="msort">Sort</label><select class="plain-select" id="msort">
          <option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="name">Name A–Z</option></select>
        ${tab === 'other' ? `<div class="seg" role="group" aria-label="View">
          <button data-oview="list" aria-pressed="${state.settings.otherView !== 'grid'}">${U.icon('list')}<span>List</span></button>
          <button data-oview="grid" aria-pressed="${state.settings.otherView === 'grid'}">${U.icon('grid')}<span>Grid</span></button></div>` : ''}
        ${tab === 'photos' ? `<div class="seg" role="group" aria-label="Thumbnail size">${[['s', 'S'], ['m', 'M'], ['l', 'L']].map(([v, l]) => `<button data-size="${v}" aria-pressed="${state.settings.photoSize === v}" aria-label="${{ s: 'Small', m: 'Medium', l: 'Large' }[v]} thumbnails">${l}</button>`).join('')}</div>` : ''}
      </div></div><div id="body"></div></div>`;
    const body = main.querySelector('#body');
    const shareSel = main.querySelector('#mshare'), sortSel = main.querySelector('#msort');
    sortSel.value = ts.sort;
    let all = [], vl = null, view = [];

    async function load() {
      try {
        [all, shares] = await ui.load(body, Promise.all([api.listByTab(tab, {}), api.listShares()]),
          tab === 'other' ? ui.skeletonRows(12) : ui.skeletonTiles(tab === 'photos' ? 24 : 9, tab === 'photos' ? 1 : 16 / 11));
      } catch (e) { body.innerHTML = ui.errorState(e); body.querySelector('#retry').onclick = load; return; }
      shareSel.innerHTML = '<option value="">All shares</option>' + shares.filter(s => s.available).map(s => `<option value="${s.id}">${U.esc(s.name)}</option>`).join('');
      if (shares.some(s => !s.available)) shareSel.title = 'Unavailable shares are hidden until they reconnect';
      shareSel.value = shares.some(s => s.id === ts.share && s.available) ? ts.share : '';
      draw();
    }

    function draw() {
      if (vl) { vl.destroy(); vl = null; }
      const q = (ts.query || '').toLowerCase();
      view = all.filter(e => (!ts.share || e.share === ts.share) && (!q || e.name.toLowerCase().includes(q))).sort(sorter(ts.sort));
      main.querySelector('#mcount').textContent = `${U.formatCount(view.length)} ${conf.noun}${view.length === 1 ? '' : 's'}`;
      const off = shares.filter(s => !s.available);
      const note = off.length ? `<div class="banner banner-warning">${U.icon('cloudOff')}<span>${off.map(s => U.esc(s.name)).join(', ')} ${off.length === 1 ? 'is' : 'are'} unavailable, so ${off.length === 1 ? 'its' : 'their'} ${conf.noun}s aren’t shown.</span></div>` : '';
      if (!all.length) { body.innerHTML = note + ui.empty({ icon: conf.icon, title: `No ${conf.noun}s yet`, text: conf.empty }); return; }
      if (!view.length) {
        body.innerHTML = note + ui.empty({ icon: 'search', title: 'No matches', text: q ? `No ${conf.noun}s have “${ts.query}” in their name${ts.share ? ' on this share' : ''}.` : `This share has no ${conf.noun}s.`,
          action: '<button class="btn btn-secondary" id="reset">Show everything</button>' });
        body.querySelector('#reset').onclick = () => { ts.query = ''; ts.share = ''; shareSel.value = ''; setSearch(); draw(); };
        return;
      }
      body.innerHTML = note + '<div class="vlist" role="list"></div>';
      const host = body.querySelector('.vlist');
      const w = host.clientWidth;
      const mobile = matchMedia('(max-width: 720px)').matches;
      let rows = [];

      if (tab === 'photos') {
        const gap = 6, target = PHOTO_SIZES[state.settings.photoSize] * (mobile ? 0.7 : 1);
        const cols = Math.max(3, Math.floor((w + gap) / (target + gap)));
        const tile = (w - gap * (cols - 1)) / cols;
        const groups = [];
        for (const e of view) {
          const g = ts.sort === 'name' ? 'All photos' : dateGroup(e.modifiedAt);
          if (!groups.length || groups[groups.length - 1].label !== g) groups.push({ label: g, items: [] });
          groups[groups.length - 1].items.push(e);
        }
        groups.forEach((g, gi) => {
          rows.push({ key: 'h' + gi, h: gi ? 52 : 36, head: g });
          for (let i = 0; i < g.items.length; i += cols) rows.push({ key: 'g' + gi + 'r' + i, h: tile + gap, items: g.items.slice(i, i + cols), cols });
        });
      } else if (tab === 'videos') {
        const gap = 14, cols = Math.max(1, Math.floor((w + gap) / (250 + gap)));
        const tileW = (w - gap * (cols - 1)) / cols;
        const h = Math.round(tileW * 9 / 16 + 62) + gap;
        for (let i = 0; i < view.length; i += cols) rows.push({ key: 'r' + i, h, items: view.slice(i, i + cols), cols, gap });
      } else {
        const grid = state.settings.otherView === 'grid';
        const gap = 12, cols = Math.max(2, Math.floor((w + gap) / (190 + gap)));
        OTHER_GROUPS.forEach(([cat, label]) => {
          const items = view.filter(e => e.category === cat);
          if (!items.length) return;
          rows.push({ key: 'h' + cat, h: rows.length ? 56 : 36, head: { label, items } });
          if (grid) for (let i = 0; i < items.length; i += cols) rows.push({ key: cat + 'r' + i, h: 162 + gap, items: items.slice(i, i + cols), cols, gap });
          else items.forEach(e => rows.push({ key: e.id, h: mobile ? 60 : 48, e }));
        });
      }

      vl = ui.virtual({
        scroller: main, host, rows,
        render: (r) => {
          if (r.head) return ui.el(`<div class="${tab === 'other' ? 'group-head' : 'date-head'}"><span>${U.esc(r.head.label)}</span><span class="n">${U.formatCount(r.head.items.length)}</span></div>`);
          if (tab === 'photos') {
            const d = ui.el(`<div class="pgrid-row" style="grid-template-columns:repeat(${r.cols},minmax(0,1fr));gap:6px"></div>`);
            d.innerHTML = r.items.map(e => `<button class="ptile" data-id="${e.id}" style="background-image:url('${ui.thumbFor(e.name)}')" aria-label="${U.esc(e.name)}, ${U.absDate(e.modifiedAt)}"></button>`).join('');
            return d;
          }
          if (tab === 'videos') {
            const d = ui.el(`<div class="pgrid-row" style="grid-template-columns:repeat(${r.cols},minmax(0,1fr));gap:${r.gap}px;padding-bottom:${r.gap}px"></div>`);
            d.innerHTML = r.items.map(e => `<button class="vcard" data-id="${e.id}"><span class="poster" style="background-image:url('${ui.thumbFor(e.name)}')"><span class="play">${U.icon('play')}</span><span class="dur">${ui.durationFor(e)}</span></span>
              <span class="meta"><span class="nm">${U.nameHTML(e.name)}</span><span class="c" style="display:block">${U.relDate(e.modifiedAt)} · <span class="mono">${U.formatBytes(e.size)}</span></span></span></button>`).join('');
            return d;
          }
          if (r.items) {
            const d = ui.el(`<div class="pgrid-row" style="grid-template-columns:repeat(${r.cols},minmax(0,1fr));gap:${r.gap}px;padding-bottom:${r.gap}px"></div>`);
            d.innerHTML = r.items.map(e => {
              const share = shares.find(s => s.id === e.share);
              return `<button class="otile" data-id="${e.id}" aria-label="${U.esc(e.name)}, ${U.formatBytes(e.size)}">
                <span class="otile-icon">${U.fileIcon(e)}<span class="otile-ext">${U.esc(e.ext ? '.' + e.ext : 'no ext')}</span></span>
                <span class="nm">${U.nameHTML(e.name)}</span>
                <span class="c"><span class="mono">${U.formatBytes(e.size)}</span> · ${U.relDate(e.modifiedAt)}</span>
                <span class="c">${U.esc(share ? share.name : e.share)}</span></button>`;
            }).join('');
            return d;
          }
          const e = r.e, share = shares.find(s => s.id === e.share);
          const b = ui.el(`<button class="row" data-id="${e.id}" role="listitem"><span class="icon">${U.fileIcon(e)}</span>
            <span class="nm">${U.nameHTML(e.name)}<span class="sub">${U.formatBytes(e.size)} · ${U.relDate(e.modifiedAt)}</span></span>
            <span class="c mono" style="text-align:right">${U.formatBytes(e.size)}</span>
            <span class="c" title="${U.esc((share ? share.name : '') + ' / ' + e.path)}">${U.esc(share ? share.name : e.share)}</span>
            <span class="c" title="${U.esc(U.absDate(e.modifiedAt, true))}">${U.relDate(e.modifiedAt)}</span></button>`);
          return b;
        }
      });
      host.onclick = (ev) => {
        const t = ev.target.closest('[data-id]');
        if (!t) return;
        const idx = view.findIndex(x => x.id === t.dataset.id);
        if (tab === 'photos') lightbox(ctx, view, idx, (last) => { vl.scrollToKey(rows.find(r => r.items && r.items.includes(last)).key); const n = host.querySelector(`[data-id="${last.id}"]`); if (n) n.focus(); });
        else detailDialog(ctx, view[idx], shares);
      };
    }

    const setSearch = () => shell.setSearch({ placeholder: `Search ${conf.title.toLowerCase()}`, value: ts.query, onInput: v => { ts.query = v; draw(); } });
    setSearch();
    shareSel.onchange = () => { ts.share = shareSel.value; main.scrollTop = 0; draw(); };
    sortSel.onchange = () => { ts.sort = sortSel.value; main.scrollTop = 0; draw(); };
    main.querySelectorAll('[data-oview]').forEach(b => b.onclick = () => {
      state.settings.otherView = b.dataset.oview;
      main.querySelectorAll('[data-oview]').forEach(x => x.setAttribute('aria-pressed', x === b));
      main.scrollTop = 0;
      draw();
      api.updateSettings({ otherView: b.dataset.oview }).catch(() => {});
    });
    main.querySelectorAll('[data-size]').forEach(b => b.onclick = async () => {
      state.settings.photoSize = b.dataset.size;
      main.querySelectorAll('[data-size]').forEach(x => x.setAttribute('aria-pressed', x === b));
      draw();
      api.updateSettings({ photoSize: b.dataset.size }).catch(() => {});
    });
    ctx.onResize = U.debounce(() => { const st = main.scrollTop; draw(); main.scrollTop = st; }, 150);
    ctx.cleanup = () => { if (vl) vl.destroy(); };
    await load();
  }

  root.Attic.media = { render };
})(window);
