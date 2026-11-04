// Transfers view (Phase 2, 2-5, D-06 and D-08): files sent between devices through the HP. "Now" holds
// what's moving or waiting, with live progress over the hub; "History" pages through finished transfers,
// with filters and search. Retry and Cancel are for the sender and the master. A retried transfer whose
// file the HP no longer holds needs it again from the device that sent it.
(function (root) {
  'use strict';
  const { util: U, api, ui } = root.Attic;

  const FILTERS = [['', 'All'], ['done', 'Done'], ['failed', 'Failed'], ['cancelled', 'Cancelled']];
  const STATUS = {
    active: ['tag-ok', 'transfer', 'Sending'], queued: ['', 'clock', 'Waiting'], done: ['tag-done', 'check', 'Done'],
    failed: ['tag-danger', 'alertCircle', 'Failed'], cancelled: ['', 'x', 'Cancelled']
  };
  const OPEN = t => t.status === 'active' || t.status === 'queued';
  const POLL_MS = 5000; // only while the live connection is down

  async function render(ctx) {
    const { main, shell, state } = ctx;
    const master = state.session.type === 'master', me = state.session.accountId;
    const ts = state.tabs.transfers = state.tabs.transfers || { status: '', device: '', q: '' };
    shell.setLocation('<span class="title">Transfers</span>');
    main.innerHTML = `<div class="page"><div class="page-head"><h1>Transfers</h1><span class="muted" id="tcount"></span>
        <span class="live-badge" id="live" hidden></span></div>
      <section aria-labelledby="h-now" class="tr-section"><h2 class="tr-h" id="h-now">Now</h2><div id="now"></div></section>
      <section aria-labelledby="h-hist" class="tr-section">
        <div class="tr-hist-head"><h2 class="tr-h" id="h-hist">History</h2><span class="grow"></span>
          <select class="plain-select tr-device" id="t-device" aria-label="Device"><option value="">Any device</option></select>
          <div class="seg" role="group" aria-label="Show">${FILTERS.map(([v, l]) => `<button data-f="${v}" aria-pressed="${ts.status === v}">${l}</button>`).join('')}</div></div>
        <div id="hist"></div>
      </section></div>`;
    const nowEl = main.querySelector('#now'), histEl = main.querySelector('#hist'), liveEl = main.querySelector('#live');
    let open = [], hist = [], next = null, devs = new Map(), myDevice = null, alive = true, timer = 0, hub = null, isLive = false, loadToken = 0;

    // ---------- rows ----------
    const kindOf = id => (devs.get(id) || {}).kind || 'desktop';
    const nameOf = (id, name) => U.esc(name || (devs.get(id) || {}).name || 'Removed device');
    const canManage = x => master || x.userId === me;
    // A retried transfer the HP has no copy of waits for its file, from the device that sent it.
    const needsFile = x => x.status === 'active' && x.stage === 'upload' && !x.bytesDone && !api.isUploading(x.id);

    function detailHTML(x) {
      const of = `<span class="mono">${U.formatBytes(x.bytesDone || 0)}</span> of <span class="mono">${U.formatBytes(x.size)}</span>`;
      const speed = x.speed ? ` · <span class="mono">${U.formatBytes(x.speed)}/s</span>` : '';
      const tries = x.attempts > 1 ? ` · try ${x.attempts}` : '';
      if (x.status === 'active' && x.stage === 'deliver') return `Delivering to ${nameOf(x.to, x.toName)} · ${of}${speed}`;
      if (x.status === 'active' && needsFile(x)) {
        return x.from === myDevice ? `The HP needs the file again${tries}.` : `Waiting for ${nameOf(x.from, x.fromName)} to send the file again${tries}.`;
      }
      if (x.status === 'active') return `Sending to the HP · ${of}${speed}`;
      if (x.status === 'queued') return `On the HP, waiting for ${nameOf(x.to, x.toName)} to collect it${tries}`;
      if (x.status === 'failed') return `${U.esc(x.error || 'Transfer failed.')} · ${U.relDate(x.finishedAt)}${tries}`;
      if (x.status === 'cancelled') return `Cancelled ${U.relDate(x.finishedAt)}`;
      return `<span class="mono">${U.formatBytes(x.size)}</span>${x.speed ? ` · <span class="mono">${U.formatBytes(x.speed)}/s</span>` : ''} · ${U.relDate(x.finishedAt)}${tries}`;
    }

    function rowHTML(x) {
      const [cls, icon, label] = STATUS[x.status] || STATUS.done;
      const moving = x.status === 'active' && !needsFile(x);
      const pct = U.pct(x.bytesDone || 0, x.size || 1);
      const by = master && x.userId !== me && x.userName ? `<span class="tr-by">· sent by ${U.esc(x.userName)}</span>` : '';
      return `<div class="tr-row" data-id="${U.esc(x.id)}">
        <span class="tr-icon">${U.fileIcon({ kind: 'file', category: U.classify(x.fileName) })}</span>
        <div class="tr-main">
          <div class="tr-name">${U.nameHTML(x.fileName)}</div>
          <div class="tr-route">${root.Attic.device.art(kindOf(x.from), 20)}<span>${nameOf(x.from, x.fromName)}</span>${U.icon('arrowRight')}${root.Attic.device.art(kindOf(x.to), 20)}<span>${nameOf(x.to, x.toName)}</span>${by}</div>
          ${moving ? `<div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="${U.esc(x.fileName)} progress"><span style="width:${pct.toFixed(1)}%"></span></div>` : ''}
          <div class="c">${detailHTML(x)}</div>
        </div>
        <span class="tag ${cls}">${U.icon(icon)}${label}</span>
        <span class="tr-actions">
          ${needsFile(x) && x.from === myDevice && canManage(x) ? `<button class="btn btn-secondary btn-sm" data-resend="${U.esc(x.id)}">${U.icon('upload')}Send the file</button>` : ''}
          ${(x.status === 'failed' || x.status === 'cancelled') && canManage(x) ? `<button class="btn btn-secondary btn-sm" data-retry="${U.esc(x.id)}">${U.icon('refresh')}Retry</button>` : ''}
          ${OPEN(x) && canManage(x) ? `<button class="btn btn-ghost btn-sm" data-cancel="${U.esc(x.id)}" aria-label="Cancel ${U.esc(x.fileName)}">${U.icon('x')}Cancel</button>` : ''}
        </span>
      </div>`;
    }

    // ---------- drawing ----------
    function counts() {
      const sending = open.filter(x => x.status === 'active').length, waiting = open.filter(x => x.status === 'queued').length;
      main.querySelector('#tcount').textContent = [sending && `${sending} sending`, waiting && `${waiting} waiting`].filter(Boolean).join(' · ') || 'Nothing moving';
    }
    // Keeps keyboard focus on the same button when a list is redrawn.
    function keepFocus(box, html) {
      const f = document.activeElement, row = f && f.closest && f.closest('.tr-row');
      const id = row && box.contains(row) && row.dataset.id, attr = id && ['data-retry', 'data-cancel', 'data-resend'].find(a => f.hasAttribute(a));
      box.innerHTML = html;
      if (id) { const el = box.querySelector(`.tr-row[data-id="${CSS.escape(id)}"] ${attr ? `[${attr}]` : 'button'}`); if (el) el.focus(); }
    }
    function drawNow() {
      counts();
      keepFocus(nowEl, open.length ? `<div class="tr-list">${open.map(rowHTML).join('')}</div>`
        : `<p class="tr-quiet">${U.icon('check')}Nothing is moving or waiting. Send a file from a device’s card on the Devices tab.</p>`);
    }
    function drawHist() {
      if (!hist.length) {
        histEl.innerHTML = ts.status || ts.device || ts.q
          ? ui.empty({ icon: 'transfer', title: 'Nothing matches', text: 'No finished transfers match these filters.' })
          : ui.empty({ icon: 'transfer', title: 'No history yet', text: 'Finished transfers between your devices are kept here for a year.' });
        return;
      }
      keepFocus(histEl, `<div class="tr-list">${hist.map(rowHTML).join('')}</div>
        ${next ? `<div class="tr-more"><button class="btn btn-secondary btn-sm" id="t-more">Show older</button></div>` : ''}`);
      const more = histEl.querySelector('#t-more');
      if (more) more.onclick = () => loadHist(true);
    }

    // ---------- loading ----------
    const matches = t => !OPEN(t) && (!ts.status || t.status === ts.status) && (!ts.device || t.from === ts.device || t.to === ts.device)
      && (!ts.q || t.fileName.toLowerCase().includes(ts.q.toLowerCase()));

    async function loadNow(first) {
      try {
        const list = first ? await ui.load(nowEl, api.listTransfers(), ui.skeletonRows(2)) : await api.listTransfers();
        if (!alive) return;
        open = list.filter(OPEN);
        drawNow();
      } catch (e) {
        if (!alive || !first) return;
        nowEl.innerHTML = ui.errorState(e); nowEl.querySelector('#retry').onclick = () => loadNow(true);
      }
    }
    async function loadHist(more) {
      const my = ++loadToken;
      try {
        const q = { status: ts.status, device: ts.device, q: ts.q, before: more ? next : undefined };
        const page = more ? await api.transferHistory(q) : await ui.load(histEl, api.transferHistory(q), ui.skeletonRows(6));
        if (!alive || my !== loadToken) return;
        hist = more ? hist.concat(page.items) : page.items;
        next = page.next || null;
        drawHist();
      } catch (e) {
        if (!alive || my !== loadToken) return;
        histEl.innerHTML = ui.errorState(e); histEl.querySelector('#retry').onclick = () => loadHist(false);
      }
    }
    function schedule() { clearTimeout(timer); if (alive && !isLive) timer = setTimeout(async () => { await loadNow(false); schedule(); }, POLL_MS); }

    // ---------- live ----------
    function onTransfer(t) {
      const i = open.findIndex(x => x.id === t.id);
      if (OPEN(t)) { if (i >= 0) open[i] = t; else open.unshift(t); }
      else if (i >= 0) open.splice(i, 1);
      drawNow();
      const j = hist.findIndex(x => x.id === t.id);
      if (j >= 0) hist.splice(j, 1);
      if (matches(t)) hist.unshift(t);
      if (j >= 0 || matches(t)) drawHist();
    }
    // Progress patches the row in place, so a click or focus on it isn't disturbed twice a second.
    function onProgress(p) {
      const x = open.find(t => t.id === p.id);
      if (!x) return;
      Object.assign(x, { status: 'active', stage: p.stage, bytesDone: p.bytesDone, speed: p.speed });
      const row = nowEl.querySelector(`.tr-row[data-id="${CSS.escape(p.id)}"]`);
      const bar = row && row.querySelector('.meter');
      if (!bar) return drawNow();
      const pct = U.pct(p.bytesDone, p.size || 1);
      bar.firstElementChild.style.width = pct.toFixed(1) + '%';
      bar.setAttribute('aria-valuenow', Math.round(pct));
      row.querySelector('.c').innerHTML = detailHTML(x);
    }
    function setLive(status) {
      isLive = status === 'live';
      liveEl.hidden = false;
      liveEl.className = 'live-badge' + (isLive ? ' on' : '');
      liveEl.innerHTML = isLive ? '<span class="dot on" aria-hidden="true"></span>Live' : '<span class="spinner" aria-hidden="true"></span>Reconnecting…';
      if (isLive) { clearTimeout(timer); loadNow(false); } else schedule();
    }

    // ---------- actions ----------
    // Sends a transfer's file again from this device: the one this page sent, or one the person picks.
    function resend(t, file) {
      let job;
      try { job = api.resendTransfer(t, file); }
      catch (e) { return ui.toast(e.message, 'error'); }
      drawNow();
      job.promise.then(() => ui.toast(`${t.fileName} is on the HP again`), e => { if (e.code !== 'CANCELLED') ui.toast(e.message, 'error'); drawNow(); });
    }
    function chooseFile(t) {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.onchange = () => { if (inp.files[0]) resend(t, inp.files[0]); };
      inp.click();
    }
    main.querySelector('.page').addEventListener('click', async e => {
      const r = e.target.closest('[data-retry]'), c = e.target.closest('[data-cancel]'), s = e.target.closest('[data-resend]');
      if (!r && !c && !s) return;
      const find = id => open.concat(hist).find(x => x.id === id);
      if (s) return chooseFile(find(s.dataset.resend));
      try {
        if (c) { const x = await api.cancelTransfer(c.dataset.cancel); onTransfer(x); return ui.toast(`Cancelled ${x.fileName}`); }
        const t = await api.retryTransfer(r.dataset.retry);
        onTransfer(t);
        if (t.status === 'queued') return ui.toast(`${t.fileName} is queued again for ${t.toName || 'the device'}`);
        // The HP no longer has the file: send it again from here, or say where it has to come from.
        if (t.from !== myDevice) return ui.toast(`The HP needs ${t.fileName} again from ${t.fromName || 'the device that sent it'}. Retry it there.`);
        if (api.hasFileFor(t.id)) resend(t);
        else { ui.toast(`Choose ${t.fileName} again to send it`); chooseFile(t); }
      } catch (err) { ui.toast(err.message, 'error'); }
    });
    main.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
      ts.status = b.dataset.f;
      main.querySelectorAll('[data-f]').forEach(x => x.setAttribute('aria-pressed', x === b));
      loadHist(false);
    });
    const devSel = main.querySelector('#t-device');
    devSel.onchange = () => { ts.device = devSel.value; loadHist(false); };
    let qTimer = 0;
    shell.setSearch({ placeholder: 'Search transfers by file name', value: ts.q, onInput: v => { ts.q = v.trim(); clearTimeout(qTimer); qTimer = setTimeout(() => loadHist(false), 250); } });

    ctx.cleanup = () => { alive = false; clearTimeout(timer); clearTimeout(qTimer); if (hub) hub.close(); };

    try {
      const list = await api.listHubDevices();
      devs = new Map(list.map(d => [d.id, d]));
      myDevice = (list.find(d => d.thisPC) || {}).id || null;
      devSel.innerHTML += list.map(d => `<option value="${U.esc(d.id)}"${ts.device === d.id ? ' selected' : ''}>${U.esc(d.name)}${d.thisPC ? ' (this device)' : ''}</option>`).join('');
    } catch (e) { /* names come with each transfer anyway */ }
    if (!alive) return;
    await Promise.all([loadNow(true), loadHist(false)]);
    if (!alive) return;
    hub = api.openHub({ onStatus: setLive, onTransfer, onProgress });
  }

  root.Attic.transfers = { render };
})(window);
