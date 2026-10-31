// Transfers view (Attic Hub, Phase 1B on mock data): progress, speed, outcome and history of
// device-to-device transfers, with retry and cancel. Real transfers arrive in Phase 2.
(function (root) {
  'use strict';
  const { util: U, api, ui } = root.Attic;

  const FILTERS = [['all', 'All'], ['active', 'Active'], ['queued', 'Waiting'], ['failed', 'Failed'], ['done', 'Done']];
  const STATUS = {
    active: ['tag-ok', 'transfer', 'Sending'], queued: ['', 'clock', 'Waiting'], done: ['tag-done', 'check', 'Done'],
    failed: ['tag-danger', 'alertCircle', 'Failed'], cancelled: ['', 'x', 'Cancelled']
  };

  function rowHTML(x, devs) {
    const from = devs.get(x.from), to = devs.get(x.to);
    const name = d => d ? U.esc(d.name) : 'Removed device';
    const art = d => root.Attic.device.art(d ? d.kind : 'desktop', 20);
    const [cls, icon, label] = STATUS[x.status] || STATUS.done;
    const pct = U.pct(x.bytesDone, x.size);
    let detail = '';
    if (x.status === 'active') detail = `<span class="mono">${U.formatBytes(x.bytesDone)}</span> of <span class="mono">${U.formatBytes(x.size)}</span> · <span class="mono">${U.formatBytes(x.speed)}/s</span>`;
    else if (x.status === 'queued') detail = `Waiting for ${name(to)} to come online`;
    else if (x.status === 'failed') detail = `${U.esc(x.error || 'Transfer failed.')} Stopped at <span class="mono">${U.formatBytes(x.bytesDone)}</span>.`;
    else if (x.status === 'done') detail = `<span class="mono">${U.formatBytes(x.size)}</span> · ${x.speed ? `<span class="mono">${U.formatBytes(x.speed)}/s</span> · ` : ''}${U.relDate(x.finishedAt)}`;
    else detail = `Cancelled ${U.relDate(x.finishedAt)}`;
    return `<div class="tr-row" data-id="${x.id}">
      <span class="tr-icon">${U.fileIcon({ kind: 'file', category: U.classify(x.fileName) })}</span>
      <div class="tr-main">
        <div class="tr-name">${U.nameHTML(x.fileName)}</div>
        <div class="tr-route">${art(from)}<span>${name(from)}</span>${U.icon('arrowRight')}${art(to)}<span>${name(to)}</span></div>
        ${x.status === 'active' ? `<div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="${U.esc(x.fileName)} progress"><span style="width:${pct.toFixed(1)}%"></span></div>` : ''}
        <div class="c">${detail}</div>
      </div>
      <span class="tag ${cls}">${U.icon(icon)}${label}</span>
      <span class="tr-actions">
        ${x.status === 'failed' || x.status === 'cancelled' ? `<button class="btn btn-secondary btn-sm" data-retry="${x.id}">${U.icon('refresh')}Retry</button>` : ''}
        ${x.status === 'active' || x.status === 'queued' ? `<button class="btn btn-ghost btn-sm" data-cancel="${x.id}" aria-label="Cancel ${U.esc(x.fileName)}">${U.icon('x')}Cancel</button>` : ''}
      </span>
    </div>`;
  }

  async function render(ctx) {
    const { main, shell, state } = ctx;
    const ts = state.tabs.transfers = state.tabs.transfers || { filter: 'all' };
    shell.setLocation('<span class="title">Transfers</span>');
    shell.setSearch(null);
    main.innerHTML = `<div class="page"><div class="page-head"><h1>Transfers</h1><span class="muted" id="tcount"></span><span class="grow"></span>
        <div class="seg" role="group" aria-label="Show">${FILTERS.map(([v, l]) => `<button data-f="${v}" aria-pressed="${ts.filter === v}">${l}</button>`).join('')}</div></div>
      <div class="banner banner-info">${U.icon('info')}<span>Mock transfers for Phase 1B. Progress is simulated; real device-to-device transfers arrive in Phase 2.</span></div>
      <div id="body"></div></div>`;
    const body = main.querySelector('#body');
    let list = [], devs = new Map(), timer = 0, alive = true;

    function draw() {
      const shown = list.filter(x => ts.filter === 'all' || x.status === ts.filter || (ts.filter === 'done' && x.status === 'cancelled'));
      const active = list.filter(x => x.status === 'active').length, waiting = list.filter(x => x.status === 'queued').length;
      main.querySelector('#tcount').textContent = [active && `${active} sending`, waiting && `${waiting} waiting`].filter(Boolean).join(' · ') || `${list.length} in history`;
      if (!list.length) { body.innerHTML = ui.empty({ icon: 'transfer', title: 'No transfers yet', text: 'Files sent between your devices show up here, with progress and history.' }); return; }
      if (!shown.length) { body.innerHTML = ui.empty({ icon: 'transfer', title: 'Nothing here', text: 'No transfers match this filter.' }); return; }
      const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('.tr-row');
      const keep = focused && focused.dataset.id, keepAttr = keep && ['data-retry', 'data-cancel'].find(a => document.activeElement.hasAttribute(a));
      body.innerHTML = `<div class="tr-list">${shown.map(x => rowHTML(x, devs)).join('')}</div>`;
      if (keep) { const el = body.querySelector(`.tr-row[data-id="${keep}"] ${keepAttr ? `[${keepAttr}]` : 'button'}`); if (el) el.focus(); }
    }

    async function load(first) {
      try {
        const [tr, dv] = await (first ? ui.load(body, Promise.all([api.listTransfers(), api.listHubDevices()]), ui.skeletonRows(8)) : Promise.all([api.listTransfers(), api.listHubDevices()]));
        list = tr; devs = new Map(dv.map(d => [d.id, d]));
      } catch (e) {
        if (!first) return schedule();
        body.innerHTML = ui.errorState(e); body.querySelector('#retry').onclick = () => load(true); return;
      }
      if (!alive) return;
      draw();
      schedule();
    }
    // Poll quickly while something is moving, slowly otherwise.
    function schedule() { clearTimeout(timer); if (alive) timer = setTimeout(() => load(false), list.some(x => x.status === 'active') ? 1000 : 5000); }

    main.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
      ts.filter = b.dataset.f;
      main.querySelectorAll('[data-f]').forEach(x => x.setAttribute('aria-pressed', x === b));
      draw();
    });
    body.onclick = async (e) => {
      const r = e.target.closest('[data-retry]'), c = e.target.closest('[data-cancel]');
      if (!r && !c) return;
      try {
        const x = r ? await api.retryTransfer(r.dataset.retry) : await api.cancelTransfer(c.dataset.cancel);
        ui.toast(r ? (x.status === 'queued' ? `Waiting for ${(devs.get(x.to) || {}).name || 'the device'} to come online` : `Retrying ${x.fileName}`) : `Cancelled ${x.fileName}`);
        load(false);
      } catch (err) { ui.toast(err.message, 'error'); }
    };

    ctx.cleanup = () => { alive = false; clearTimeout(timer); };
    await load(true);
  }

  root.Attic.transfers = { render };
})(window);
