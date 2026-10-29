// Master dashboard: storage summary, per-share breakdown, storage by type (with drill-down), devices, uploads.
(function (root) {
  'use strict';
  const { util: U, api, ui, files } = root.Attic;

  const SHARE_KIND = { ssd: 'SSD', hdd: 'Internal drive', external: 'External drive' };
  const color = c => `var(--cat-${c})`;
  const level = p => p >= 90 ? 'crit' : p >= 80 ? 'warn' : '';
  const queue = []; // upload queue survives tab switches

  function statusTag(p) {
    if (p >= 90) return `<span class="tag tag-danger">${U.icon('alert')}Almost full</span>`;
    if (p >= 80) return `<span class="tag tag-warning">${U.icon('alert')}Getting full</span>`;
    return `<span class="tag tag-ok">${U.icon('check')}Healthy</span>`;
  }

  // ---------- tooltip ----------
  let tip = null;
  function showTip(ev, html) {
    if (!tip) { tip = document.createElement('div'); tip.className = 'chart-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    tip.innerHTML = html;
    const x = Math.min(innerWidth - tip.offsetWidth - 8, ev.clientX + 14), y = ev.clientY + 16;
    tip.style.left = x + 'px'; tip.style.top = (y + tip.offsetHeight > innerHeight ? ev.clientY - tip.offsetHeight - 10 : y) + 'px';
  }
  function hideTip() { if (tip) { tip.remove(); tip = null; } }

  // ================= dashboard =================
  async function renderDashboard(ctx) {
    const { main, shell } = ctx;
    shell.setLocation('<span class="title">Dashboard</span>');
    shell.setSearch(null);
    main.innerHTML = `<div class="page"><div class="page-head"><h1>Dashboard</h1><span class="grow"></span>
      <div class="refresh"><span id="checked" aria-live="polite"></span><button class="btn btn-secondary btn-sm" id="refresh">${U.icon('refresh')}Refresh</button></div></div>
      <div id="banners"></div>
      <div class="dash">
        <section class="card" id="summary" aria-labelledby="sum-h"><div class="skel" style="height:120px"></div></section>
        <section class="card" id="per-share" aria-labelledby="ps-h"><div class="skel" style="height:140px"></div></section>
        <section class="card" id="by-type" aria-labelledby="bt-h"><div class="skel" style="height:160px"></div></section>
        <section class="card" id="by-owner" aria-labelledby="bo-h"><div class="skel" style="height:160px"></div></section>
        <section class="card" id="devices" aria-labelledby="dv-h"><div class="skel" style="height:160px"></div></section>
        <section class="card" id="upload" aria-labelledby="up-h"></section>
      </div></div>`;

    async function loadStorage() {
      const btn = main.querySelector('#refresh');
      btn.disabled = true;
      try {
        const s = await api.getStorage();
        drawSummary(s); drawShares(s); drawTypes(s); drawOwners(s); drawBanners(s);
        main.querySelector('#checked').textContent = 'Updated ' + U.timeOnly(s.checkedAt);
        return s;
      } catch (e) {
        ['#summary', '#per-share', '#by-type', '#by-owner'].forEach(id => { const el = main.querySelector(id); el.innerHTML = ui.errorState(e, 'retry' + id.slice(1)); el.querySelector('button').onclick = refresh; });
      } finally { btn.disabled = false; }
    }
    async function refresh() { const s = await loadStorage(); loadDevices(); drawUpload(s); }

    // A dashboard that looks the same at 40% and 95% has failed at its one job.
    function drawBanners(s) {
      main.querySelector('#banners').innerHTML = s.shares.filter(x => x.total && x.free / x.total < 0.1).map(x =>
        `<div class="banner banner-danger" role="alert">${U.icon('alert')}<span><b>${U.esc(x.name)}</b> has only ${U.formatBytes(x.free)} free (${U.formatPct(U.pct(x.free, x.total))}).${x.available ? ' Free up space before it fills completely.' : ' Last known figures — the drive is unavailable.'}</span></div>`).join('');
    }

    function drawSummary(s) {
      const t = s.totals, p = U.pct(t.used, t.total);
      const segs = s.segments.map(g => ({ key: g.category, size: g.size, count: g.count })).concat([{ key: 'free', size: t.total - t.used }]);
      main.querySelector('#summary').innerHTML = `
        <div class="card-head"><h2 id="sum-h">Storage across all shares</h2></div>
        <div class="hero-num">${U.formatBytes(t.used)} <small>of ${U.formatBytes(t.total)} used</small></div>
        <div class="status-line"><b style="font-size:17px">${U.formatPct(p)}</b>${statusTag(p)}<span class="muted" style="font-size:13px">${U.formatCount(t.count)} files on ${s.shares.length} shares</span></div>
        <div class="segbar-wrap ${level(p)}"><div class="segbar" role="img" aria-label="${segs.map(x => `${U.CATEGORY_LABEL[x.key]} ${U.formatBytes(x.size)}`).join(', ')}">
          ${segs.map(x => `<span class="s" data-k="${x.key}" style="flex:${x.size} 1 0;background:${color(x.key)}"></span>`).join('')}</div></div>
        <p class="muted" style="font-size:12.5px;margin:10px 0 0">Coloured by file type, matching <a href="#by-type" id="to-type">Storage by type</a> below. The grey end is free space.</p>`;
      const bar = main.querySelector('#summary .segbar');
      bar.querySelectorAll('.s').forEach(el => {
        const x = segs.find(g => g.key === el.dataset.k);
        el.onmousemove = ev => showTip(ev, `<div class="t"><span class="sw" style="background:${color(x.key)}"></span>${U.CATEGORY_LABEL[x.key]}</div><div class="mono">${U.formatBytes(x.size)}</div><div class="muted">${U.formatPct(U.pct(x.size, t.total))} of capacity</div>`);
        el.onmouseleave = hideTip;
      });
      main.querySelector('#to-type').onclick = (e) => { e.preventDefault(); main.querySelector('#by-type').scrollIntoView({ behavior: ui.reducedMotion() ? 'auto' : 'smooth' }); };
    }

    function drawShares(s) {
      main.querySelector('#per-share').innerHTML = `
        <div class="card-head"><h2 id="ps-h">Shares</h2></div>
        <div class="share-rows">
          <div class="share-row head"><span></span><span>Share</span><span>Usage</span><span class="num">Used</span><span class="num">Free</span><span class="num">Total</span></div>
          ${s.shares.map(x => {
            const p = U.pct(x.used, x.total);
            return `<div class="share-row${x.available ? '' : ' unavailable'}">
              <span class="icon-tile" style="color:var(--muted)">${U.shareIcon(x.deviceType)}</span>
              <span style="min-width:0"><span class="nm">${U.esc(x.name)}</span> ${x.available ? '' : `<span class="tag">${U.icon('cloudOff')}Unavailable</span>`}
                <span class="c" style="display:block">${SHARE_KIND[x.deviceType] || 'Drive'}${x.available ? '' : ' · last seen ' + U.absDate(x.lastSeenAt, true)}</span></span>
              <span class="bar-cell"><span class="meter ${x.available ? level(p) : ''}" style="display:block" role="img" aria-label="${U.formatPct(p)} full"><span style="width:${p.toFixed(1)}%"></span></span>
                <span class="c">${U.formatPct(p)} full${p >= 90 ? ' — almost full' : p >= 80 ? ' — getting full' : ''}</span></span>
              <span class="num mono">${U.formatBytes(x.used)}</span><span class="num mono hide-sm">${U.formatBytes(x.free)}</span><span class="num mono hide-sm">${U.formatBytes(x.total)}</span>
            </div>`;
          }).join('')}
        </div>`;
    }

    function drawTypes(s) {
      const used = s.totals.used;
      const el = main.querySelector('#by-type');
      el.innerHTML = `
        <div class="card-head"><h2 id="bt-h">Storage by type</h2><span class="grow"></span><span class="muted" style="font-size:13px">Select a type to see its largest files</span></div>
        <div class="segbar" id="type-bar" style="height:28px">
          ${s.segments.map(g => `<button class="s" data-cat="${g.category}" style="flex:${g.size} 1 0;background:${color(g.category)}" aria-label="${U.CATEGORY_LABEL[g.category]}: ${U.formatBytes(g.size)}, ${U.formatPct(U.pct(g.size, used))} of used space. Open details."></button>`).join('')}
        </div>
        <div class="legend" id="type-legend">
          ${s.segments.map(g => `<div class="leg-group"><button class="leg" data-cat="${g.category}"><span class="sw" style="background:${color(g.category)}"></span>
              <span><span class="nm">${U.CATEGORY_LABEL[g.category]}</span><span class="c" style="display:block">${U.formatCount(g.count)} files · ${U.formatPct(U.pct(g.size, used))}</span></span>
              <span class="v mono">${U.formatBytes(g.size)}</span></button>
            ${g.collapsed && g.collapsed.length ? g.collapsed.map(c => `<button class="leg sub" data-cat="${c.category}" title="Under 2% of used space, so it’s counted inside Other on the bar">
              <span><span class="nm">incl. ${U.CATEGORY_LABEL[c.category]}</span><span class="c" style="display:block">${U.formatCount(c.count)} files</span></span><span class="v mono">${U.formatBytes(c.size)}</span></button>`).join('') : ''}</div>`).join('')}
        </div>`;
      const bar = el.querySelector('#type-bar'), legend = el.querySelector('#type-legend');
      const hot = (cat) => {
        bar.classList.toggle('dim', !!cat);
        bar.querySelectorAll('.s').forEach(x => x.classList.toggle('hot', x.dataset.cat === cat));
        legend.querySelectorAll('.leg:not(.sub)').forEach(x => x.classList.toggle('hot', x.dataset.cat === cat));
      };
      bar.querySelectorAll('.s').forEach(b => {
        const g = s.segments.find(x => x.category === b.dataset.cat);
        b.onmousemove = ev => { hot(g.category); showTip(ev, `<div class="t"><span class="sw" style="background:${color(g.category)}"></span>${U.CATEGORY_LABEL[g.category]}</div><div><span class="mono">${U.formatBytes(g.size)}</span> · ${U.formatCount(g.count)} files</div><div class="muted">${U.formatPct(U.pct(g.size, used))} of used space</div>${g.collapsed && g.collapsed.length ? `<div class="muted">Includes ${g.collapsed.map(c => U.CATEGORY_LABEL[c.category]).join(', ')}</div>` : ''}`); };
        b.onmouseleave = () => { hot(null); hideTip(); };
        b.onfocus = () => hot(g.category); b.onblur = () => hot(null);
      });
      legend.querySelectorAll('.leg:not(.sub)').forEach(l => { l.onmouseenter = () => hot(l.dataset.cat); l.onmouseleave = () => hot(null); });
      el.querySelectorAll('[data-cat]').forEach(b => b.onclick = () => { hideTip(); ctx.go('#/dashboard/' + b.dataset.cat); });
    }

    // ---------- devices ----------
    async function loadDevices() {
      const el = main.querySelector('#devices');
      let list;
      try { list = await api.listDevices(); }
      catch (e) { el.innerHTML = ui.errorState(e, 'retry-dev'); el.querySelector('#retry-dev').onclick = loadDevices; return; }
      const D = root.Attic.device;
      const view = ctx.state.settings.devicesView === 'grid' ? 'grid' : 'list';
      const status = d => d.status === 'active' ? `<span class="tag tag-ok">${U.icon('check')}Active</span>` : `<span class="tag tag-danger">${U.icon('ban')}Revoked</span>`;
      const seen = d => d.lastSeenAt ? 'Last seen ' + U.relDate(d.lastSeenAt) : 'Never signed in';
      const owned = d => `<span class="mono">${U.formatCount(d.owned.count)}</span> files, <span class="mono">${U.formatBytes(d.owned.bytes)}</span>`;
      const seenOn = d => d.lastDeviceType ? `<span style="display:flex;align-items:center;gap:4px">${D.art(d.lastDeviceType, 18)}on a ${D.LABEL[d.lastDeviceType].toLowerCase()}</span>` : '';
      const actions = d => `${d.status === 'active' ? `<button class="btn btn-secondary btn-sm" data-revoke="${d.id}">${U.icon('ban')}Revoke</button>` : `<button class="btn btn-secondary btn-sm" data-restore="${d.id}">${U.icon('undo')}Restore</button>`}
              <button class="btn btn-ghost btn-sm" data-remove="${d.id}" aria-label="Remove ${U.esc(d.displayName)}">${U.icon('trash')}Remove</button>`;
      // Grid shows the device as its illustration; "other" devices fall back to the desktop drawing.
      const artType = t => D.LABEL[t] ? t : 'desktop';
      const rows = () => `<div class="dev-rows">${list.map(d => `
          <div class="dev-row${d.status === 'revoked' ? ' revoked' : ''}">
            <span class="icon-tile">${U.deviceIcon(d.deviceType)}</span>
            <span style="min-width:0"><span class="nm">${U.esc(d.displayName)}</span><span class="c" style="display:block">@${U.esc(d.username)}</span><span class="c" style="display:block">${owned(d)}</span></span>
            <span class="c hide-sm">${seen(d)}${seenOn(d)}</span>
            <span class="c hide-sm dev-added">Added ${U.absDate(d.createdAt)}</span>
            <span>${status(d)}</span>
            <span class="actions">${actions(d)}</span>
          </div>`).join('')}</div>`;
      const cards = () => `<div class="dev-grid">${list.map(d => `
          <div class="dev-card${d.status === 'revoked' ? ' revoked' : ''}">
            <div class="dev-card-top"><span class="dev-card-art">${D.art(artType(d.deviceType), 72)}</span>${status(d)}</div>
            <div class="nm">${U.esc(d.displayName)}</div>
            <div class="c">@${U.esc(d.username)} · ${D.LABEL[d.deviceType] || 'Other device'}</div>
            <div class="c">${seen(d)}</div>${seenOn(d) ? `<div class="c">${seenOn(d)}</div>` : ''}
            <div class="c">Owns ${owned(d)}</div>
            <div class="c">Added ${U.absDate(d.createdAt)}</div>
            <div class="actions">${actions(d)}</div>
          </div>`).join('')}</div>`;
      el.innerHTML = `
        <div class="card-head"><h2 id="dv-h">Registered devices</h2><span class="tag">${list.filter(d => d.status === 'active').length} active</span><span class="grow"></span>
          <div class="seg" role="group" aria-label="Device list view">
            <button data-dview="list" aria-pressed="${view === 'list'}">${U.icon('list')}<span>List</span></button>
            <button data-dview="grid" aria-pressed="${view === 'grid'}">${U.icon('grid')}<span>Grid</span></button></div>
          <button class="btn btn-primary btn-sm" id="add-dev">${U.icon('plus')}Add device</button></div>
        <p class="muted" style="font-size:13px;margin:-6px 0 10px">Registered means the account exists — not that the device is online now. Live status arrives in Phase 1B.</p>
        ${list.length ? (view === 'grid' ? cards() : rows())
        : ui.empty({ icon: 'device', title: 'No devices yet', text: 'Give each phone, tablet or laptop its own account, so a lost one can be revoked on its own.' })}`;
      el.querySelectorAll('[data-dview]').forEach(b => b.onclick = async () => {
        if (b.dataset.dview === view) return;
        ctx.state.settings = await api.updateSettings({ devicesView: b.dataset.dview }).catch(() => Object.assign(ctx.state.settings, { devicesView: b.dataset.dview }));
        await loadDevices();
        el.querySelector(`[data-dview="${b.dataset.dview}"]`).focus();
      });
      el.querySelector('#add-dev').onclick = () => addDeviceDialog(loadDevices);
      const after = () => { loadDevices(); loadStorage(); };
      el.querySelectorAll('[data-revoke]').forEach(b => b.onclick = () => custodyDialog('revoke', list.find(x => x.id === b.dataset.revoke), after));
      el.querySelectorAll('[data-restore]').forEach(b => b.onclick = () => restoreDialog(list.find(x => x.id === b.dataset.restore), after));
      el.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => custodyDialog('remove', list.find(x => x.id === b.dataset.remove), after));
    }

    // ---------- storage by owner ----------
    function drawOwners(s) {
      const el = main.querySelector('#by-owner');
      const max = Math.max(1, ...s.byOwner.map(o => o.bytes));
      el.innerHTML = `
        <div class="card-head"><h2 id="bo-h">Storage by owner</h2><span class="grow"></span>
          ${s.custody ? `<span class="tag tag-custody" style="font-size:12px;padding:3px 9px">${U.icon('undo')}${U.formatCount(s.custody)} files in custody</span>` : ''}</div>
        <div class="owner-rows">${s.byOwner.map(o => `
          <div class="owner-row">
            <span class="nm">${U.esc(o.name)}${o.status === 'revoked' ? ' <span class="muted">(revoked)</span>' : ''}<span class="c">${o.type === 'common' ? 'Shared with every account' : o.type === 'master' ? 'Master' : o.type === 'unknown' ? 'No longer exists' : 'Device'}</span></span>
            <span class="bar" role="img" aria-label="${U.formatPct(U.pct(o.bytes, s.totals.used))} of used space"><span style="width:${U.pct(o.bytes, max).toFixed(1)}%" class="${o.type === 'common' ? 'common' : ''}"></span></span>
            <span class="mono num">${U.formatBytes(o.bytes)}</span>
            <span class="c num hide-sm">${U.formatCount(o.count)} files</span>
            <span class="c num">${U.formatPct(U.pct(o.bytes, s.totals.used))}</span>
          </div>`).join('')}</div>`;
    }

    // ---------- upload (simulated) ----------
    async function drawUpload(s) {
      const el = main.querySelector('#upload');
      const avail = s ? s.shares.filter(x => x.available) : [];
      el.innerHTML = `
        <div class="card-head"><h2 id="up-h">Upload</h2><span class="tag">${U.icon('info')}Simulated in Phase 1A</span></div>
        <div class="drop" id="drop">${U.icon('upload')}<p>Drag files here, or</p>
          <button class="btn btn-secondary" id="browse">Browse files</button><input type="file" id="pick" multiple hidden></div>
        <div class="dest"><label for="dshare">To</label><select class="plain-select" id="dshare">${avail.map(x => `<option value="${x.id}">${U.esc(x.name)}</option>`).join('')}</select>
          <label for="dfolder" class="sr-only">Folder</label><select class="plain-select" id="dfolder" style="max-width:240px"><option value="">(top level)</option></select>
          <span class="grow"></span>${queue.length ? '<button class="btn btn-ghost btn-sm" id="clearq">Clear finished</button>' : ''}</div>
        <div class="queue" id="queue" aria-live="polite"></div>
        <p class="muted" style="font-size:12.5px;margin:10px 0 0">Files are checked and shown with progress, then marked done — nothing is stored until Phase 2.</p>`;
      const dshare = el.querySelector('#dshare'), dfolder = el.querySelector('#dfolder');
      const fillFolders = async () => {
        dfolder.innerHTML = '<option value="">(top level)</option>';
        if (!dshare.value) return;
        try {
          const f = await api.listFolder(dshare.value, '');
          dfolder.innerHTML += f.items.filter(i => i.kind === 'folder').map(i => `<option>${U.esc(i.name)}</option>`).join('');
        } catch (e) { /* keep top level */ }
      };
      dshare.onchange = fillFolders;
      fillFolders();
      const drop = el.querySelector('#drop'), pick = el.querySelector('#pick');
      el.querySelector('#browse').onclick = () => pick.click();
      pick.onchange = () => { enqueue(pick.files); pick.value = ''; };
      drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
      drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); enqueue(e.dataTransfer.files); };
      const clear = el.querySelector('#clearq');
      if (clear) clear.onclick = () => { for (let i = queue.length - 1; i >= 0; i--) if (queue[i].state !== 'uploading') queue.splice(i, 1); drawUpload(s); };
      drawQueue();

      function enqueue(fileList) {
        if (!dshare.value) { ui.toast('No share is available to upload to', 'error'); return; }
        const dest = (avail.find(x => x.id === dshare.value) || {}).name + (dfolder.value ? ' / ' + dfolder.value : '');
        for (const f of fileList) {
          const item = { id: Math.random().toString(36).slice(2), name: f.name, size: f.size, dest, progress: 0, state: 'queued', error: api.validateUpload(f) };
          if (item.error) item.state = 'rejected';
          queue.unshift(item);
          if (!item.error) {
            item.state = 'uploading';
            const job = api.simulateUpload(f, p => { item.progress = p; updateRow(item); });
            item.cancel = job.cancel;
            job.promise.then(() => { item.state = 'done'; updateRow(item); }).catch(() => { item.state = 'cancelled'; updateRow(item); });
          }
        }
        drawUpload(s);
      }
    }
    function rowHTML(q) {
      const st = { uploading: Math.round(q.progress * 100) + '%', done: 'Done (not stored)', rejected: q.error, cancelled: 'Cancelled', queued: 'Waiting' }[q.state];
      return `<span>${U.fileIcon({ kind: 'file', category: U.classify(q.name) })}</span>
        <span style="min-width:0"><span class="nm">${U.nameHTML(q.name)}</span><span class="c" style="display:block">to ${U.esc(q.dest)}</span></span>
        <span class="mono hide-sm" style="text-align:right">${U.formatBytes(q.size)}</span>
        <span class="bar-cell">${q.state === 'rejected' ? '' : `<span class="bar" style="display:block"><span style="width:${(q.progress * 100).toFixed(1)}%"></span></span>`}<span class="st">${U.esc(st)}</span></span>
        ${q.state === 'uploading' ? `<button class="icon-btn" data-cancel="${q.id}" aria-label="Cancel ${U.esc(q.name)}" style="width:32px;height:32px">${U.icon('x')}</button>` : '<span></span>'}`;
    }
    function drawQueue() {
      const box = main.querySelector('#queue');
      if (!box) return;
      box.innerHTML = queue.map(q => `<div class="qrow ${q.state === 'done' ? 'done' : q.state === 'rejected' ? 'bad' : ''}" id="q-${q.id}">${rowHTML(q)}</div>`).join('');
      box.onclick = e => { const b = e.target.closest('[data-cancel]'); if (b) { const q = queue.find(x => x.id === b.dataset.cancel); if (q && q.cancel) q.cancel(); } };
    }
    function updateRow(q) {
      const r = main.querySelector('#q-' + q.id);
      if (!r) return;
      r.className = 'qrow ' + (q.state === 'done' ? 'done' : q.state === 'rejected' ? 'bad' : '');
      r.innerHTML = rowHTML(q);
    }

    main.querySelector('#refresh').onclick = refresh;
    ctx.cleanup = hideTip;
    const s = await loadStorage();
    drawUpload(s);
    await loadDevices();
  }

  function addDeviceDialog(after) {
    const f = (id, label, type, extra) => `<div class="field no-icon"><input id="${id}" type="${type || 'text'}" placeholder=" " autocomplete="off" ${extra || ''}><label for="${id}">${label}</label><div class="field-msg" id="${id}-msg"></div></div>`;
    ui.dialog({
      title: 'Add device', lead: 'Each device gets its own account, so it can be revoked on its own if it’s lost.',
      body: `<form id="dev-form" class="form-grid" novalidate>
        ${f('d-name', 'Display name (e.g. Pixel 8)')}${f('d-user', 'Username')}${f('d-pass', 'Password', 'password')}
        <div class="field no-icon"><select id="d-type">${['phone', 'tablet', 'laptop', 'desktop', 'other'].map(t => `<option value="${t}">${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select><label for="d-type">Device type</label><div class="field-msg"></div></div>
        <p class="mock-note" style="margin-top:0">${U.icon('info')}<span>Use a placeholder like test1234. Prototype passwords are stored in plain text.</span></p></form>`,
      actions: [
        { label: 'Cancel' },
        { label: 'Add device', kind: 'primary', onClick: async (close, dlg) => {
          const v = id => dlg.querySelector('#' + id).value;
          const errs = { 'd-name': v('d-name').trim() ? '' : 'Enter a display name', 'd-user': v('d-user').trim() ? '' : 'Choose a username', 'd-pass': v('d-pass').length >= 6 ? '' : 'Use at least 6 characters' };
          for (const k in errs) { dlg.querySelector(`#${k}-msg`).textContent = errs[k]; dlg.querySelector('#' + k).parentElement.classList.toggle('invalid', !!errs[k]); }
          const bad = Object.keys(errs).find(k => errs[k]);
          if (bad) return dlg.querySelector('#' + bad).focus();
          try {
            const d = await api.createDevice({ displayName: v('d-name'), username: v('d-user'), password: v('d-pass'), deviceType: v('d-type') });
            close(); ui.toast(`${d.displayName} added`); after();
          } catch (e) {
            dlg.querySelector('#d-user-msg').textContent = e.message;
            dlg.querySelector('#d-user').parentElement.classList.add('invalid');
            dlg.querySelector('#d-user').focus();
          }
        } }
      ],
      onOpen: (dlg) => dlg.querySelector('#dev-form').onsubmit = e => { e.preventDefault(); dlg.querySelector('.dialog-actions .btn-primary').click(); }
    });
  }

  // Revoke and remove both ask who takes custody. Remove says plainly that it can't be undone,
  // because otherwise the difference from revoke is invisible.
  async function custodyDialog(kind, d, after) {
    let summary, owners;
    try { [summary, owners] = await Promise.all([api.ownershipSummary(d.id), api.listOwners()]); }
    catch (e) { ui.toast(e.message, 'error'); return; }
    const candidates = owners.filter(o => o.id !== d.id && o.status === 'active').sort((a, b) => (a.type === 'master' ? -1 : 0) - (b.type === 'master' ? -1 : 0));
    const files = `<b>${U.formatCount(summary.owned.count)} ${summary.owned.count === 1 ? 'file' : 'files'}</b> (<span class="mono">${U.formatBytes(summary.owned.bytes)}</span>)`;
    const remove = kind === 'remove';
    const lead = remove
      ? `This deletes <b>@${U.esc(d.username)}</b> and its history. Its ${files} move to the account you choose — <b>for good</b>.`
      : `${U.esc(d.displayName)} won’t be able to sign in. Its ${files} move to the account you choose, and come back if you restore it.`;
    ui.dialog({
      title: `${remove ? 'Remove' : 'Revoke'} ${d.displayName}?`, lead,
      body: `<div class="field no-icon"><select id="custodian">${candidates.map(o => `<option value="${o.id}">${U.esc(o.displayName)}${o.type === 'master' ? ' (master)' : ''}</option>`).join('')}</select><label for="custodian">Who takes these files</label><div class="field-msg"></div></div>
        ${remove ? `<div class="banner banner-danger" style="margin:6px 0 0">${U.icon('alert')}<span>This can’t be undone. Files won’t return even if a device is added later with the same name. To keep the option of giving them back, revoke instead.</span></div>`
          : `<p class="muted" style="font-size:13px;margin:6px 0 0">Files keep a record of who uploaded them, so restoring ${U.esc(d.displayName)} returns exactly these.</p>`}`,
      actions: [
        { label: 'Cancel' },
        { label: remove ? 'Remove device' : 'Revoke access', kind: 'danger', onClick: async (close, dlg) => {
          const custodianId = dlg.querySelector('#custodian').value;
          const holder = candidates.find(o => o.id === custodianId);
          try {
            const r = remove ? await api.removeDevice(d.id, custodianId) : await api.revokeDevice(d.id, custodianId);
            close();
            ui.toast(`${d.displayName} ${remove ? 'removed' : 'revoked'} · ${U.formatCount(r.moved.count)} files now with ${holder.displayName}`);
            after();
          } catch (e) { ui.toast(e.message, 'error'); }
        } }
      ]
    });
  }

  // Restore states exactly how many files come back. Zero is a correct answer when the claim was cleared.
  async function restoreDialog(d, after) {
    let summary;
    try { summary = await api.ownershipSummary(d.id); }
    catch (e) { ui.toast(e.message, 'error'); return; }
    const n = summary.inCustody.count;
    const ok = await ui.confirm({
      title: `Restore ${d.displayName}?`, confirm: 'Restore access',
      lead: `${U.esc(d.displayName)} will be able to sign in again. ` + (n
        ? `<b>${U.formatCount(n)} ${n === 1 ? 'file' : 'files'}</b> (<span class="mono">${U.formatBytes(summary.inCustody.bytes)}</span>) held in custody will come back to it.`
        : `<b>0 files</b> will come back — nothing it uploaded is being held for it. Files kept permanently or transferred on removal stay where they are.`)
    });
    if (!ok) return;
    try {
      const r = await api.restoreDevice(d.id);
      ui.toast(`${d.displayName} restored · ${U.formatCount(r.returned.count)} files returned`);
      after();
    } catch (e) { ui.toast(e.message, 'error'); }
  }

  // ================= drill-down (a route, so back works and it can be linked) =================
  async function renderDetail(ctx, cat) {
    const { main, shell } = ctx;
    shell.setSearch(null);
    const label = U.CATEGORY_LABEL[cat] || cat;
    shell.setLocation(`<div class="crumbs"><button class="crumb" id="crumb-dash">Dashboard</button><span class="crumb-sep">${U.icon('chevronRight')}</span><span class="crumb current">${U.esc(label)}</span></div>`);
    document.getElementById('crumb-dash').onclick = () => back();
    main.innerHTML = `<div class="page"><div class="page-head">
        <button class="btn btn-ghost btn-sm" id="back">${U.icon('arrowLeft')}Dashboard</button></div>
      <div id="body"><div class="skel" style="height:120px;margin-bottom:16px"></div>${ui.skeletonRows(8)}</div></div>`;
    main.querySelector('#back').onclick = back;
    function back() { if (ctx.state.cameFromDashboard) history.back(); else ctx.go('#/dashboard'); }
    const body = main.querySelector('#body');
    let d;
    try { d = await api.getCategoryDetail(cat); }
    catch (e) { body.innerHTML = ui.errorState(e); body.querySelector('#retry').onclick = () => renderDetail(ctx, cat); return; }
    if (!d.count) { body.innerHTML = ui.empty({ icon: 'search', title: `No ${label.toLowerCase()} files`, text: 'Nothing in the index belongs to this type.' }); return; }
    const maxExt = d.byExt[0].size, shares = await api.listShares().catch(() => []);
    body.innerHTML = `
      <div class="card" style="margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><span class="sw" style="width:14px;height:14px;border-radius:4px;background:${color(cat)}"></span><h1 style="font-size:22px;font-weight:800">${U.esc(label)}</h1>
          ${d.includes.length > 1 ? `<span class="tag">Includes ${d.includes.filter(c => c !== cat).map(c => U.CATEGORY_LABEL[c]).join(', ')}</span>` : ''}</div>
        <div class="hero-num">${U.formatBytes(d.total)} <small>in ${U.formatCount(d.count)} files · ${U.formatPct(U.pct(d.total, d.used))} of used space</small></div>
      </div>
      <div class="two-col" style="margin-bottom:16px">
        <section class="card"><div class="card-head"><h2>By share</h2></div><div class="ext-rows">
          ${d.byShare.map(s => `<div class="ext-row share-ext"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700${s.available ? '' : ';color:var(--muted)'}">${U.esc(s.name)}</span>
            <span class="bar"><span style="width:${U.pct(s.size, d.total).toFixed(1)}%;background:${color(cat)}"></span></span><span class="mono" style="text-align:right">${U.formatBytes(s.size)}</span><span class="muted" style="text-align:right">${U.formatPct(U.pct(s.size, d.total))}</span></div>`).join('')}
        </div></section>
        <section class="card"><div class="card-head"><h2>By extension</h2></div><div class="ext-rows">
          ${d.byExt.slice(0, 10).map(x => `<div class="ext-row"><span class="mono" style="font-weight:700">.${U.esc(x.ext)}</span>
            <span class="bar"><span style="width:${U.pct(x.size, maxExt).toFixed(1)}%;background:${color(U.classify('x.' + x.ext) === 'other' ? 'other' : U.classify('x.' + x.ext))}"></span></span>
            <span class="mono" style="text-align:right">${U.formatBytes(x.size)}</span><span class="muted" style="text-align:right">${U.formatCount(x.count)}</span></div>`).join('')}
          ${d.byExt.length > 10 ? `<p class="muted" style="font-size:12.5px;margin:4px 0 0">+ ${d.byExt.length - 10} more extensions</p>` : ''}
        </div></section>
      </div>
      <section class="card" style="padding-bottom:8px"><div class="card-head"><h2>Largest files</h2><span class="muted" style="font-size:13px">${U.formatCount(d.count)} files, largest first</span></div>
        <div class="dl-head"><span>Name</span><span style="text-align:right">Size</span><span>Share</span><span>Path</span><span>Modified</span><span></span></div>
        <div class="vlist" id="dl"></div></section>`;
    const mobile = matchMedia('(max-width: 720px)').matches;
    const vl = ui.virtual({
      scroller: main, host: body.querySelector('#dl'),
      rows: d.files.map(f => ({ key: f.id, h: mobile ? 60 : 48, f })),
      render: ({ f }) => {
        const s = shares.find(x => x.id === f.share);
        return ui.el(`<div class="dl-row" role="row"><span style="min-width:0;display:flex;gap:10px;align-items:center">${U.fileIcon(f)}<span style="min-width:0;flex:1"><span style="font-weight:600">${U.nameHTML(f.name)}</span>${mobile ? `<span class="c" style="display:block"><span class="mono">${U.formatBytes(f.size)}</span> · ${U.esc(s ? s.name : f.share)}</span>` : ''}</span></span>
          <span class="mono hide-sm" style="text-align:right">${U.formatBytes(f.size)}</span><span class="c hide-sm">${U.esc(s ? s.name : f.share)}</span>
          <span class="c mono hide-sm" title="${U.esc(f.path)}">${U.esc(f.path || '/')}</span><span class="c hide-sm">${U.relDate(f.modifiedAt)}</span>
          <span style="text-align:right"><button class="btn btn-ghost btn-sm" data-reveal="${f.id}" ${s && !s.available ? 'disabled title="Share unavailable"' : ''}>${U.icon('reveal')}<span class="hide-sm">Reveal</span></button></span></div>`);
      }
    });
    body.querySelector('#dl').onclick = e => {
      const b = e.target.closest('[data-reveal]');
      if (!b) return;
      const f = d.files.find(x => x.id === b.dataset.reveal);
      ctx.go(files.folderHash(f.share, f.path, f.id));
    };
    ctx.cleanup = () => vl.destroy();
  }

  async function render(ctx) {
    const cat = ctx.route.segs[1];
    if (cat) return renderDetail(ctx, cat);
    return renderDashboard(ctx);
  }

  root.Attic.dashboard = { render };
})(window);
