// Files tab: share picker, folder browser (virtualised), breadcrumbs and the file detail panel.
(function (root) {
  'use strict';
  const { util: U, api, ui } = root.Attic;

  const folderHash = (share, path, select) =>
    '#/files/' + encodeURIComponent(share) + (path ? '/' + path.split('/').map(encodeURIComponent).join('/') : '') + (select ? '?select=' + encodeURIComponent(select) : '');

  function meterClass(p) { return p >= 90 ? ' crit' : p >= 80 ? ' warn' : ''; }

  // ---------- breadcrumbs: collapse the middle, keep share root and current folder ----------
  function crumbsHTML(share, path) {
    const segs = path ? path.split('/') : [];
    const items = [{ label: share.name, path: '' }].concat(segs.map((s, i) => ({ label: s, path: segs.slice(0, i + 1).join('/') })));
    const sep = `<span class="crumb-sep">${U.icon('chevronRight')}</span>`;
    const btn = (it, cur) => `<button class="crumb${cur ? ' current' : ''}" ${cur ? 'aria-current="page"' : `data-path="${U.esc(it.path)}"`} title="${U.esc(it.label)}">${U.esc(it.label)}</button>`;
    let shown = items, hidden = [];
    if (items.length > 3) { hidden = items.slice(1, -1); shown = [items[0], null, items[items.length - 1]]; }
    return `<div class="crumbs">${shown.map((it, i) => (i ? sep : '') + (it ? btn(it, i === shown.length - 1) : `<button class="crumb" data-more aria-label="Show ${hidden.length} hidden folders" aria-haspopup="menu" aria-expanded="false">…</button>`)).join('')}</div>`;
  }
  function wireCrumbs(container, share, path, go) {
    const segs = path ? path.split('/') : [];
    container.querySelectorAll('.crumb[data-path]').forEach(b => b.onclick = () => go(folderHash(share.id, b.dataset.path)));
    container.querySelectorAll('.crumb[data-more]').forEach(b => b.onclick = () => {
      const hidden = segs.slice(0, -1).map((s, i) => ({ label: s, path: segs.slice(0, i + 1).join('/') }));
      ui.menu(b, hidden.map((h, i) => `<button class="menu-item" role="menuitem" data-path="${U.esc(h.path)}" style="padding-left:${12 + i * 10}px">${U.icon('folder')}${U.esc(h.label)}</button>`).join(''),
        (m, close) => m.querySelectorAll('[data-path]').forEach(x => x.onclick = () => { close(); go(folderHash(share.id, x.dataset.path)); }));
    });
  }

  // ---------- sorting: folders always first ----------
  function sortItems(items, sort) {
    const dir = sort.dir;
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      size: (a, b) => a.size - b.size,
      type: (a, b) => U.typeLabel(a).localeCompare(U.typeLabel(b)),
      modified: (a, b) => a.modifiedAt.localeCompare(b.modifiedAt)
    }[sort.key];
    return items.slice().sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      return (cmp(a, b) || a.name.localeCompare(b.name)) * dir;
    });
  }

  // ---------- detail panel (side panel on desktop, bottom sheet on phones) ----------
  // Ownership helpers (master only: device accounts never see other owners).
  function ownerLabel(id, owners) {
    if (id === null || id === undefined) return 'Common';
    const o = owners && owners.get(id);
    return o ? o.displayName + (o.status === 'revoked' ? ' (revoked)' : '') : 'Removed account';
  }
  const inCustody = e => e.kind === 'file' && !!e.uploadedBy && e.ownerId !== e.uploadedBy;
  function custodyBadge(e, owners) {
    return inCustody(e) ? `<span class="tag tag-custody" title="Held for ${U.esc(ownerLabel(e.uploadedBy, owners))}">${U.icon('undo')}<span class="tc">Custody</span></span>` : '';
  }

  function panelHTML(e, share, owners) {
    const isPhoto = e.category === 'photos';
    const full = share.rootPath + '\\' + U.joinPath(e.path, e.name).replace(/\//g, '\\');
    return `<aside class="panel" aria-label="File details">
      <div class="panel-head"><h2>${U.esc(e.name)}</h2><button class="icon-btn" id="panel-close" aria-label="Close details">${U.icon('x')}</button></div>
      <div class="preview" style="${ui.bgStyle(e)}">${isPhoto ? '' : U.fileIcon(e)}</div>
      <dl class="kv">
        <dt>Location</dt><dd class="mono">${U.esc(full)}</dd>
        <dt>Size</dt><dd><span class="mono">${U.formatBytes(e.size)}</span> <span class="muted">(${U.formatCount(e.size)} bytes)</span></dd>
        <dt>Type</dt><dd>${U.esc(U.typeLabel(e))}</dd>
        <dt>Modified</dt><dd>${U.absDate(e.modifiedAt, true)}</dd>
        <dt>Share</dt><dd>${U.esc(share.name)}</dd>
        ${owners ? `<dt>Owner</dt><dd>${U.esc(ownerLabel(e.ownerId, owners))}</dd>
        <dt>Uploaded by</dt><dd>${e.uploadedBy ? U.esc(ownerLabel(e.uploadedBy, owners)) : '<span class="muted">Not recorded</span>'}</dd>` : ''}
      </dl>
      ${owners && inCustody(e) ? `<div class="banner banner-info" style="margin-bottom:12px">${U.icon('undo')}<span>Held in custody for <b>${U.esc(ownerLabel(e.uploadedBy, owners))}</b>. It goes back if that account is restored.</span></div>
        <button class="btn btn-secondary btn-block" id="keep-perm" style="margin-bottom:10px">${U.icon('lock')}Keep permanently</button>` : ''}
      <div class="panel-actions">
        <a class="btn btn-secondary" href="${U.esc(api.downloadUrl(e))}" download="${U.esc(e.name)}">${U.icon('download')}Download</a>
        <span class="tip" data-tip="Deleting arrives in Phase 2" tabindex="0"><button class="btn btn-secondary" disabled>${U.icon('trash')}Delete</button></span>
      </div></aside>`;
  }

  // ---------- share picker ----------
  async function renderShares(ctx) {
    const { main, shell } = ctx;
    shell.setLocation('<span class="title">Files</span>');
    shell.setSearch(null);
    main.innerHTML = `<div class="page"><div class="page-head"><h1>Shares</h1></div><div id="body"></div></div>`;
    const body = main.querySelector('#body');
    let list;
    try { list = await ui.load(body, api.listShares(), `<div class="share-grid">${'<div class="card skel" style="height:150px"></div>'.repeat(3)}</div>`); }
    catch (e) { body.innerHTML = ui.errorState(e); body.querySelector('#retry').onclick = () => renderShares(ctx); return; }
    if (!list.length) {
      body.innerHTML = ui.empty({ icon: 'database', title: 'No shares yet', text: 'Shares are the drives Attic serves. The master account adds them in Settings.',
        action: ctx.state.session.type === 'master' ? '<a class="btn btn-primary" href="#/settings">Open Settings</a>' : '' });
      return;
    }
    body.innerHTML = `<div class="share-grid">${list.map(s => {
      if (s.total == null) {
        return `<button class="card share-card${s.available ? '' : ' unavailable'}" data-id="${s.id}" aria-label="${U.esc(s.name)}${s.available ? '' : ', unavailable'}">
          <div class="top"><div class="icon-tile">${U.shareIcon(s.deviceType)}</div>
            <div style="min-width:0;flex:1"><div class="nm">${U.esc(s.name)}</div><div class="path mono">${U.esc(s.rootPath)}</div></div>
            ${s.available ? '' : `<span class="tag">${U.icon('cloudOff')}Unavailable</span>`}</div>
          <div class="meter-row"><span><b class="mono" style="color:var(--ink)">${U.formatBytes(s.used)}</b> in files you can see</span></div>
          <div class="meter-row"><span>${U.formatCount(s.count)} files, yours and shared</span><span>${s.available ? '' : 'Last seen ' + U.relDate(s.lastSeenAt)}</span></div>
        </button>`;
      }
      const p = U.pct(s.used, s.total);
      return `<button class="card share-card${s.available ? '' : ' unavailable'}" data-id="${s.id}" aria-label="${U.esc(s.name)}${s.available ? '' : ', unavailable'}">
        <div class="top"><div class="icon-tile">${U.shareIcon(s.deviceType)}</div>
          <div style="min-width:0;flex:1"><div class="nm">${U.esc(s.name)}</div><div class="path mono">${U.esc(s.rootPath)}</div></div>
          ${s.available ? '' : `<span class="tag">${U.icon('cloudOff')}Unavailable</span>`}</div>
        <div class="meter${s.available ? meterClass(p) : ''}"><span style="width:${p.toFixed(1)}%"></span></div>
        <div class="meter-row"><span><b class="mono" style="color:var(--ink)">${U.formatBytes(s.used)}</b> used</span><span><span class="mono">${U.formatBytes(s.free)}</span> free</span></div>
        <div class="meter-row"><span>${U.formatCount(s.count)} files</span><span>${s.available ? U.formatPct(p) + ' full' : 'Last seen ' + U.relDate(s.lastSeenAt)}</span></div>
      </button>`;
    }).join('')}</div>`;
    body.querySelectorAll('.share-card').forEach(c => c.onclick = () => ctx.go(folderHash(c.dataset.id, '')));
  }

  // ---------- folder ----------
  async function renderFolder(ctx, shareId, path, selectId) {
    const { main, shell, state } = ctx;
    const ts = state.tabs.files;
    const master = state.session.type === 'master';
    ts.owner = ts.owner || '';
    main.innerHTML = `<div class="page" id="fpage"><div class="page-head">
        <div class="only-sm crumbs-sm" id="crumbs-sm" style="width:100%"></div>
        <h1 id="ftitle"></h1><span class="muted" id="fcount"></span><span class="grow"></span>
        <div class="toolbar">
          <button class="btn btn-secondary btn-sm" id="fupload">${U.icon('upload')}<span>Upload</span></button><input type="file" id="fpick" multiple hidden>
          ${master ? '<label class="sr-only" for="fowner">Owner</label><select class="plain-select" id="fowner"><option value="">All owners</option></select>' : ''}
          <div class="seg" role="group" aria-label="View">
            <button data-view="list" aria-pressed="${ts.view === 'list'}">${U.icon('list')}<span>List</span></button>
            <button data-view="grid" aria-pressed="${ts.view === 'grid'}">${U.icon('grid')}<span>Grid</span></button>
          </div></div></div>
      <div id="body">${ui.skeletonRows(0)}</div></div>`;
    const body = main.querySelector('#body');
    shell.setSearch({ placeholder: 'Search this folder', value: ts.query, onInput: v => { ts.query = v; draw(); } });

    let data;
    try { data = await ui.load(body, api.listFolder(shareId, path), ui.skeletonRows(12)); }
    catch (e) {
      shell.setLocation('<span class="title">Files</span>');
      shell.setSearch(null);
      main.querySelector('.toolbar').remove();
      main.querySelector('#ftitle').textContent = 'Files';
      if (e.code === 'UNAVAILABLE') {
        const s = (await api.listShares().catch(() => [])).find(x => x.id === shareId);
        body.innerHTML = ui.unavailableState(s ? s.name : 'This share');
      } else body.innerHTML = ui.errorState(e);
      body.querySelector('#retry').onclick = () => renderFolder(ctx, shareId, path, selectId);
      return;
    }
    const shares = await api.listShares().catch(() => []);
    // Owner names for the master's column, filter and badges.
    let owners = null;
    if (master) {
      owners = new Map((await api.listOwners().catch(() => [])).map(o => [o.id, o]));
      const sel = main.querySelector('#fowner');
      sel.innerHTML = '<option value="">All owners</option><option value="__common">Common</option><option value="__custody">In custody</option>' +
        [...owners.values()].map(o => `<option value="${o.id}">${U.esc(o.displayName)}${o.status === 'revoked' ? ' (revoked)' : ''}</option>`).join('');
      sel.value = [...sel.options].some(o => o.value === ts.owner) ? ts.owner : '';
      sel.onchange = () => { ts.owner = sel.value; main.scrollTop = 0; draw(); };
    }
    const ownerMatch = e => {
      if (!master || !ts.owner || e.kind === 'folder') return true;
      if (ts.owner === '__common') return e.ownerId === null;
      if (ts.owner === '__custody') return inCustody(e);
      return e.ownerId === ts.owner;
    };
    const share = shares.find(s => s.id === shareId) || { id: shareId, name: data.share.name, rootPath: '' };
    const crumbs = crumbsHTML(share, path);
    shell.setLocation(crumbs);
    wireCrumbs(document.getElementById('loc'), share, path, ctx.go);
    const csm = main.querySelector('#crumbs-sm');
    csm.innerHTML = crumbs;
    wireCrumbs(csm, share, path, ctx.go);
    main.querySelector('#ftitle').textContent = path ? path.split('/').pop() : share.name;

    // Upload into this folder. The uploader owns what it uploads; progress shows on the button.
    const upBtn = main.querySelector('#fupload'), pick = main.querySelector('#fpick');
    upBtn.onclick = () => pick.click();
    pick.onchange = async () => {
      const list = [...pick.files];
      pick.value = '';
      const bad = list.map(f => [f, api.validateUpload(f)]).filter(([, err]) => err);
      bad.forEach(([f, err]) => ui.toast(`${f.name}: ${err}`, 'error'));
      const good = list.filter(f => !api.validateUpload(f));
      if (!good.length) return;
      const total = good.reduce((n, f) => n + f.size, 0), done = new Map();
      const label = upBtn.querySelector('span');
      upBtn.disabled = true;
      const results = await Promise.allSettled(good.map(f => api.upload(shareId, path, f, p => {
        done.set(f, p * f.size);
        label.textContent = Math.floor([...done.values()].reduce((a, b) => a + b, 0) / total * 100) + '%';
      }).promise));
      upBtn.disabled = false;
      label.textContent = 'Upload';
      const ok = results.filter(r => r.status === 'fulfilled').length;
      results.forEach((r, i) => { if (r.status === 'rejected') ui.toast(`${good[i].name}: ${r.reason.message}`, 'error'); });
      if (ok) ui.toast(ok === 1 ? `${results.find(r => r.status === 'fulfilled').value.name} uploaded` : `${ok} files uploaded`);
      try { data.items = (await api.listFolder(shareId, path)).items; const st = main.scrollTop; draw(); main.scrollTop = st; }
      catch (e) { /* the list stays as it was */ }
    };

    let selected = data.items.find(i => i.id === selectId) || null;
    let vl = null, items = [], gridCols = 1;

    function draw() {
      const q = (ts.query || '').toLowerCase();
      items = sortItems(data.items.filter(i => (!q || i.name.toLowerCase().includes(q)) && ownerMatch(i)), ts.sort);
      const nF = items.filter(i => i.kind === 'folder').length;
      main.querySelector('#fcount').textContent = (q || (master && ts.owner)) ? `${items.length} of ${data.items.length} items` : `${nF ? nF + (nF === 1 ? ' folder, ' : ' folders, ') : ''}${items.length - nF} ${items.length - nF === 1 ? 'file' : 'files'}`;
      if (vl) { vl.destroy(); vl = null; }
      if (!data.items.length) {
        body.innerHTML = ui.empty({ icon: 'folder', title: 'This folder is empty', text: 'It loaded fine — there’s just nothing in it yet. Uploads arrive in Phase 2.' });
        return;
      }
      if (!items.length) {
        body.innerHTML = ui.empty({ icon: 'search', title: 'No matches', text: q ? `Nothing in this folder has “${ts.query}” in its name.` : 'No files in this folder belong to that owner.', action: '<button class="btn btn-secondary" id="clear-q">Show everything</button>' });
        body.querySelector('#clear-q').onclick = () => {
          ts.query = ''; ts.owner = '';
          const sel = main.querySelector('#fowner'); if (sel) sel.value = '';
          shell.setSearch({ placeholder: 'Search this folder', value: '', onInput: v => { ts.query = v; draw(); } }); draw();
        };
        return;
      }
      body.innerHTML = `<div class="files-layout${selected ? ' with-panel' : ''}"><div id="listcol" class="${master ? 'with-owner' : ''}" style="min-width:0"></div><div id="panelcol"></div></div>`;
      const listcol = body.querySelector('#listcol');
      if (ts.view === 'list') drawList(listcol); else drawGrid(listcol);
      drawPanel();
    }

    function sortHead() {
      const h = (key, label, align) => {
        const on = ts.sort.key === key;
        return `<button class="sort-btn c-${{ size: 'size', type: 'type', modified: 'mod' }[key] || key}${on ? ' on' : ''}" data-sort="${key}" style="${align ? 'justify-self:end' : ''}" aria-label="Sort by ${label}${on ? (ts.sort.dir > 0 ? ', ascending' : ', descending') : ''}">${label}${on ? U.icon(ts.sort.dir > 0 ? 'arrowUp' : 'arrowDown') : ''}</button>`;
      };
      return `<div class="list-head" role="row"><span></span>${h('name', 'Name')}${h('size', 'Size')}${h('type', 'Type')}${master ? '<span class="sort-btn c-owner" style="cursor:default">Owner</span>' : ''}${h('modified', 'Modified')}</div>`;
    }
    function wireSort(scope) {
      scope.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => {
        const k = b.dataset.sort;
        ts.sort = ts.sort.key === k ? { key: k, dir: -ts.sort.dir } : { key: k, dir: k === 'name' || k === 'type' ? 1 : -1 };
        draw();
      });
    }

    function drawList(col) {
      const mobile = matchMedia('(max-width: 720px)').matches;
      col.innerHTML = sortHead() + '<div class="vlist" role="list"></div>';
      wireSort(col);
      vl = ui.virtual({
        scroller: main, host: col.querySelector('.vlist'),
        rows: items.map(e => ({ key: e.id, h: mobile ? 60 : 48, e })),
        render: ({ e }) => {
          const b = document.createElement('button');
          b.className = 'row' + (selected && selected.id === e.id ? ' selected' : '');
          b.dataset.id = e.id;
          b.setAttribute('role', 'listitem');
          const size = e.kind === 'folder' ? '' : U.formatBytes(e.size);
          b.innerHTML = `<span class="icon">${U.fileIcon(e)}</span>
            <span class="nm"><span class="nm-line">${U.nameHTML(e.name)}${master ? custodyBadge(e, owners) : ''}</span><span class="sub">${[size, U.relDate(e.modifiedAt), master && e.kind === 'file' ? ownerLabel(e.ownerId, owners) : ''].filter(Boolean).join(' · ')}</span></span>
            <span class="c mono c-size" style="text-align:right">${size}</span><span class="c c-type">${U.esc(U.typeLabel(e))}</span>
            ${master ? `<span class="c c-owner">${e.kind === 'folder' ? '' : U.esc(ownerLabel(e.ownerId, owners))}</span>` : ''}
            <span class="c c-mod" title="${U.esc(U.absDate(e.modifiedAt, true))}">${U.relDate(e.modifiedAt)}</span>`;
          return b;
        }
      });
      col.querySelector('.vlist').onclick = onPick;
    }

    function drawGrid(col) {
      const w = col.clientWidth || main.clientWidth - 40;
      const cols = gridCols = Math.max(2, Math.floor((w + 12) / (170 + 12)));
      const tileW = (w - (cols - 1) * 12) / cols;
      const h = Math.round(tileW * 0.75 + 24 + 8 + 40) + 12;
      const rows = [];
      for (let i = 0; i < items.length; i += cols) rows.push({ key: 'r' + i, h, items: items.slice(i, i + cols) });
      col.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><label class="muted" style="font-size:13px;display:flex;gap:8px;align-items:center">Sort
        <select class="plain-select" id="gsort" style="height:34px">${[['name', 'Name'], ['size', 'Size'], ['type', 'Type'], ['modified', 'Modified']].map(([k, l]) => `<option value="${k}" ${ts.sort.key === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <button class="icon-btn" id="gdir" aria-label="${ts.sort.dir > 0 ? 'Ascending' : 'Descending'}">${U.icon(ts.sort.dir > 0 ? 'arrowUp' : 'arrowDown')}</button></div><div class="vlist" role="list"></div>`;
      col.querySelector('#gsort').onchange = e => { ts.sort = { key: e.target.value, dir: ts.sort.dir }; draw(); };
      col.querySelector('#gdir').onclick = () => { ts.sort = { key: ts.sort.key, dir: -ts.sort.dir }; draw(); };
      vl = ui.virtual({
        scroller: main, host: col.querySelector('.vlist'), rows,
        render: (r) => {
          const d = document.createElement('div');
          d.className = 'fgrid-row';
          d.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
          d.innerHTML = r.items.map(e => `<button class="ftile${selected && selected.id === e.id ? ' selected' : ''}" data-id="${e.id}" style="height:${h - 12}px">
            <span class="thumb" style="${ui.bgStyle(e)}">${e.category === 'photos' ? '' : U.fileIcon(e)}</span>
            <span class="nm nm-line">${U.nameHTML(e.name)}${master ? custodyBadge(e, owners) : ''}</span><span class="c">${e.kind === 'folder' ? 'Folder' : `<span class="mono">${U.formatBytes(e.size)}</span> · ${U.relDate(e.modifiedAt)}`}</span></button>`).join('');
          return d;
        }
      });
      col.querySelector('.vlist').onclick = onPick;
    }

    function onPick(ev) {
      const b = ev.target.closest('[data-id]');
      if (!b) return;
      const e = data.items.find(x => x.id === b.dataset.id);
      if (e.kind === 'folder') { ts.query = ''; ctx.go(folderHash(shareId, U.joinPath(path, e.name))); return; }
      selected = e;
      history.replaceState(null, '', folderHash(shareId, path, e.id));
      ts.lastHash = location.hash;
      const panelWas = !!body.querySelector('.panel');
      body.querySelectorAll('.selected').forEach(x => x.classList.remove('selected'));
      b.classList.add('selected');
      body.querySelector('.files-layout').classList.add('with-panel');
      if (!panelWas && ts.view === 'grid') { const st = main.scrollTop; draw(); main.scrollTop = st; return; }
      drawPanel();
    }

    function drawPanel() {
      const pc = body.querySelector('#panelcol');
      if (!pc) return;
      if (!selected) { pc.innerHTML = ''; return; }
      pc.innerHTML = `<div class="sheet-veil" id="veil"></div>` + panelHTML(selected, share, owners);
      const keep = pc.querySelector('#keep-perm');
      if (keep) keep.onclick = async () => {
        const who = ownerLabel(selected.uploadedBy, owners), holder = ownerLabel(selected.ownerId, owners);
        const ok = await ui.confirm({ title: 'Keep this file permanently?', danger: true, confirm: 'Keep permanently',
          lead: `<b>${U.esc(selected.name)}</b> stays with ${U.esc(holder)} for good. <b>${U.esc(who)}</b> loses its claim: restoring that account will no longer bring this file back. This can’t be undone.` });
        if (!ok) return;
        try {
          await api.reassignPermanently([selected.id]);
          const fresh = await api.listFolder(shareId, path);
          data.items = fresh.items;
          selected = data.items.find(i => i.id === selected.id) || null;
          ui.toast(`Kept permanently with ${holder}`);
          const st = main.scrollTop; draw(); main.scrollTop = st;
        } catch (err) { ui.toast(err.message, 'error'); }
      };
      const close = () => {
        const id = selected && selected.id;
        selected = null;
        history.replaceState(null, '', folderHash(shareId, path));
        ts.lastHash = location.hash;
        const st = main.scrollTop;
        draw();
        main.scrollTop = st;
        const back = body.querySelector(`[data-id="${id}"]`);
        if (back) back.focus();
      };
      pc.querySelector('#panel-close').onclick = close;
      pc.querySelector('#veil').onclick = close;
      pc._close = close;
    }

    main.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
      ts.view = b.dataset.view;
      main.querySelectorAll('[data-view]').forEach(x => x.setAttribute('aria-pressed', x === b));
      draw();
    });

    draw();
    ctx.onKey = (e) => {
      if (e.key === 'Escape' && selected) { const pc = body.querySelector('#panelcol'); if (pc && pc._close) pc._close(); }
    };
    ctx.onResize = U.debounce(() => { const st = main.scrollTop; draw(); main.scrollTop = st; }, 150);
    ctx.cleanup = () => { if (vl) vl.destroy(); };
    if (selected && vl) {
      const i = items.indexOf(selected);
      vl.scrollToKey(ts.view === 'list' ? selected.id : 'r' + (i - i % gridCols));
      const n = body.querySelector(`[data-id="${selected.id}"]`);
      if (n) n.focus({ preventScroll: true });
      return { keepScroll: true };
    }
  }

  async function render(ctx) {
    const [shareId, ...rest] = ctx.route.segs.slice(1);
    ctx.state.tabs.files.lastHash = location.hash || '#/files';
    if (!shareId) return renderShares(ctx);
    return renderFolder(ctx, shareId, rest.join('/'), ctx.route.query.select);
  }

  root.Attic.files = { render, folderHash };
})(window);
