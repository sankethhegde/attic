// Devices view (Attic Hub): a card per device paired with the HP (Phase 2, 2-2). The master pairs new
// devices with a one-time code and unpairs old ones. Live stats come from each device's agent in 2-3;
// until then the cards show status and last seen only. Send-to-device arrives in 2-4, so its button is
// present but disabled, and the layout doesn't change when it arrives.
(function (root) {
  'use strict';
  const { util: U, api, ui } = root.Attic;
  const POLL_MS = 3000;

  function meter(label, icon, valueText, pct, cls) {
    return `<div class="stat">
      <div class="stat-top">${U.icon(icon)}<span class="k">${label}</span><span class="v">${valueText}</span></div>
      ${pct == null ? '' : `<div class="meter ${cls || ''}" role="img" aria-label="${label} ${Math.round(pct)}%"><span style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></span></div>`}
    </div>`;
  }

  function statsHTML(d, master) {
    if (d.browserOnly) return `<p class="dev-note">${U.icon('info')}<span>A phone or tablet can’t report system stats from its browser, so only connection status is shown.</span></p>`;
    if (!d.online) return `<p class="dev-note">${U.icon('cloudOff')}<span>Offline. It shows as online again when it next talks to the HP.</span></p>`;
    if (!master) return `<p class="dev-note">${U.icon('lock')}<span>System stats are visible to the master account.</span></p>`;
    const s = d.stats;
    if (!s) return `<p class="dev-note">${U.icon('info')}<span>Live CPU, RAM, disk and battery figures arrive with the device agent in the next milestone (2-3).</span></p>`;
    const ramPct = U.pct(s.ramUsed, s.ramTotal), diskUsedPct = U.pct(s.diskTotal - s.diskFree, s.diskTotal);
    const level = p => p >= 90 ? 'crit' : p >= 80 ? 'warn' : '';
    return `<div class="stats">
      ${meter('CPU', 'cpu', `<span class="mono">${s.cpu}%</span>`, s.cpu, level(s.cpu))}
      ${meter('RAM', 'memory', `<span class="mono">${U.formatBytes(s.ramUsed)}</span> of <span class="mono">${U.formatBytes(s.ramTotal)}</span>`, ramPct, level(ramPct))}
      ${meter('Disk', 'hdd', `<span class="mono">${U.formatBytes(s.diskFree)}</span> free`, diskUsedPct, level(diskUsedPct))}
      ${s.battery == null
        ? meter('Power', 'plug', 'No battery · mains', null)
        : meter('Battery', 'battery', `<span class="mono">${s.battery}%</span>${s.charging ? ' · charging' : ''}`, s.battery, s.battery <= 15 ? 'crit' : s.battery <= 30 ? 'warn' : '')}
    </div>`;
  }

  function cardHTML(d, master) {
    const art = root.Attic.device.art(d.kind, 64);
    const where = master && d.lastAddress ? ` · <span class="mono">${U.esc(d.lastAddress.replace(/^::ffff:/, ''))}</span>` : '';
    return `<article class="hub-card${d.online ? '' : ' offline'}" data-id="${U.esc(d.id)}" aria-label="${U.esc(d.name)}, ${d.online ? 'online' : 'offline'}">
      <div class="hub-card-top">
        <span class="hub-art">${art}</span>
        <div class="hub-id">
          <h2 class="nm">${U.esc(d.name)}</h2>
          <div class="tags">${d.role === 'server' ? `<span class="tag tag-ok">${U.icon('database')}Server</span>` : ''}${d.thisPC ? `<span class="tag">This device</span>` : ''}</div>
          <div class="c">${U.esc(d.os || root.Attic.device.LABEL[d.kind] || 'Device')}</div>
        </div>
      </div>
      <div class="hub-status">
        <span class="dot ${d.online ? 'on' : ''}" aria-hidden="true"></span>
        <span>${d.online ? 'Online' : 'Offline · last seen ' + U.relDate(d.lastSeenAt)}${where}</span>
        <span class="grow"></span>
        ${master && d.pairedAt ? `<span class="conn" title="Paired ${U.esc(U.absDate(d.pairedAt))}">Paired ${U.relDate(d.pairedAt)}</span>` : ''}
      </div>
      ${statsHTML(d, master)}
      <div class="hub-actions">
        <span class="tip" data-tip="Sending to devices arrives in milestone 2-4" tabindex="0"><button class="btn btn-secondary btn-sm" disabled>${U.icon('transfer')}Send a file</button></span>
        ${master && d.role !== 'server' ? `<button class="btn btn-ghost btn-sm" data-unpair="${U.esc(d.id)}">${U.icon('x')}Unpair</button>` : ''}
      </div>
    </article>`;
  }

  // ---------- Pair a device (master) ----------
  // Issuing the code is the approval: whoever types it in the next 10 minutes joins. So the dialog
  // cancels its code when closed unused, and watches the device list to say when the device has joined.
  function pairDialog(onPaired) {
    let code = null, alive = true, tick = 0, poll = 0, knownIds = null;
    const d = ui.dialog({
      title: 'Pair a device',
      lead: 'On the new device, open Attic: the desktop tool, or the HP’s address in a browser. It asks for this code. The code works once, for 10 minutes.',
      body: '<div id="pc-body" aria-live="polite"></div>',
      actions: [{ label: 'Close', kind: 'secondary' }]
    });
    const body = d.el.querySelector('#pc-body');
    const stop = () => { alive = false; clearInterval(tick); clearTimeout(poll); };
    const obs = new MutationObserver(() => {
      if (d.el.isConnected) return;
      obs.disconnect();
      stop();
      if (code) api.cancelPairCode(code.id).catch(() => { /* already used or expired */ });
    });
    obs.observe(document.body, { childList: true });

    async function issue() {
      clearInterval(tick); clearTimeout(poll);
      if (code) { api.cancelPairCode(code.id).catch(() => {}); code = null; }
      body.innerHTML = `<div class="pair-code-big"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Getting a code</span></div>`;
      try {
        // The devices paired before this code exists, fetched here so the page's own list needn't have loaded.
        if (!knownIds) knownIds = new Set((await api.listHubDevices()).map(x => x.id));
        code = await api.createPairCode();
      }
      catch (e) {
        if (!alive) return;
        body.innerHTML = `<div class="banner banner-danger" role="alert">${U.icon('alert')}<span>${U.esc(e.message)}</span></div>
          <button class="btn btn-secondary btn-sm" id="pc-again">${U.icon('refresh')}Try again</button>`;
        body.querySelector('#pc-again').onclick = issue;
        return;
      }
      if (!alive) { api.cancelPairCode(code.id).catch(() => {}); return; }
      const shown = code.code.slice(0, 3) + ' ' + code.code.slice(3);
      body.innerHTML = `<div class="pair-code-big"><span class="digits" aria-label="Pairing code ${code.code.split('').join(' ')}">${shown}</span>
          <button class="icon-btn" id="pc-copy" type="button" aria-label="Copy the code" title="Copy">${U.icon('copy')}</button></div>
        <div class="pair-code-meta"><span id="pc-left"></span><span class="grow"></span>
          <button class="btn btn-ghost btn-sm" id="pc-new" type="button">${U.icon('refresh')}New code</button></div>
        <div class="pair-wait">${U.icon('device')}<span>Waiting for the device to use it. Closing this window cancels the code.</span></div>`;
      body.querySelector('#pc-new').onclick = issue;
      body.querySelector('#pc-copy').onclick = () => {
        navigator.clipboard.writeText(code.code).then(() => ui.toast('Code copied'), () => ui.toast('Couldn’t copy; type it instead', 'error'));
      };
      const left = body.querySelector('#pc-left');
      const show = () => {
        const ms = Date.parse(code.expiresAt) - Date.now();
        if (ms <= 0) {
          clearInterval(tick); clearTimeout(poll);
          code = null;
          body.innerHTML = `<p class="muted" style="margin:0 0 12px">That code expired without being used.</p>
            <button class="btn btn-primary btn-sm" id="pc-again">${U.icon('refresh')}Get a new code</button>`;
          body.querySelector('#pc-again').onclick = issue;
          return;
        }
        left.textContent = `Expires in ${Math.floor(ms / 60e3)}:${String(Math.floor(ms / 1e3) % 60).padStart(2, '0')}`;
      };
      show();
      tick = setInterval(show, 1000);
      watch();
    }

    // A new id in the device list means the code was used.
    async function watch() {
      if (!alive || !code) return;
      let list = null;
      try { list = await api.listHubDevices(); } catch (e) { /* try again next round */ }
      if (!alive || !code) return;
      const fresh = list && list.find(x => !knownIds.has(x.id));
      if (fresh) {
        code = null;
        stop();
        body.innerHTML = `<div class="pair-done"><span class="hub-art">${root.Attic.device.art(fresh.kind, 56)}</span>
          <div><b>${U.esc(fresh.name)} is paired</b><div class="c">${U.esc(fresh.os || '')}${fresh.os ? ' · ' : ''}It can now sign in with an account.</div></div></div>`;
        d.el.querySelector('.dialog-actions .btn').textContent = 'Done';
        d.el.querySelector('.dialog-actions .btn').focus();
        onPaired(fresh);
        return;
      }
      poll = setTimeout(watch, 2000);
    }

    issue();
  }

  async function unpair(d, master, after) {
    const ok = await ui.confirm({
      title: `Unpair ${d.name}?`,
      lead: d.thisPC
        ? 'This is the device you’re using now. You’ll be signed out here, and it needs a new code from the HP to use Attic again.'
        : `It stops working with the HP at once, and anyone signed in on it is signed out. To use it again, pair it with a new code. Accounts and files aren’t touched.`,
      confirm: 'Unpair', danger: true
    });
    if (!ok) return;
    try { await api.unpairHubDevice(d.id); }
    catch (e) { ui.toast(e.message, 'error'); return; }
    ui.toast(`${d.name} unpaired`);
    after();
  }

  async function render(ctx) {
    const { main, shell, state } = ctx;
    const master = state.session.type === 'master';
    shell.setLocation('<span class="title">Devices</span>');
    shell.setSearch(null);
    main.innerHTML = `<div class="page"><div class="page-head"><h1>Devices</h1><span class="muted" id="dcount"></span><span class="grow"></span>
        ${master ? `<button class="btn btn-primary btn-sm" id="pair">${U.icon('plus')}Pair a device</button>` : ''}</div>
      <div id="body"></div></div>`;
    const body = main.querySelector('#body');
    let timer = 0, alive = true, list = [];

    async function load(first) {
      let fresh;
      try { fresh = first ? await ui.load(body, api.listHubDevices(), `<div class="hub-grid">${'<div class="card skel" style="height:240px"></div>'.repeat(3)}</div>`) : await api.listHubDevices(); }
      catch (e) {
        if (!alive) return;
        if (!first) return schedule(); // a missed poll is not worth an error screen
        body.innerHTML = ui.errorState(e); body.querySelector('#retry').onclick = () => load(true); return;
      }
      if (!alive) return;
      list = fresh;
      const online = list.filter(d => d.online).length;
      main.querySelector('#dcount').textContent = `${online} of ${list.length} online`;
      const grid = body.querySelector('.hub-grid');
      const sameSet = grid && grid.children.length === list.length && list.every(d => grid.querySelector(`.hub-card[data-id="${CSS.escape(d.id)}"]`));
      if (first || !sameSet) body.innerHTML = `<div class="hub-grid">${list.map(d => cardHTML(d, master)).join('')}</div>`
        + (list.length === 1 && master ? `<div class="hub-empty">${U.icon('device')}<span>Only the HP so far. Use <b>Pair a device</b> to add the Acer, the ROG Ally or a phone.</span></div>` : '');
      else list.forEach(d => { // replace only what changed, so focus and scroll stay put
        const old = body.querySelector(`.hub-card[data-id="${CSS.escape(d.id)}"]`);
        const card = ui.el(cardHTML(d, master));
        if (old && old.innerHTML !== card.innerHTML && !old.contains(document.activeElement)) old.replaceWith(card);
      });
      schedule();
    }
    function schedule() { clearTimeout(timer); if (alive) timer = setTimeout(() => load(false), POLL_MS); }

    body.addEventListener('click', e => {
      const b = e.target.closest('[data-unpair]');
      const d = b && list.find(x => x.id === b.dataset.unpair);
      if (d) unpair(d, master, () => load(true));
    });
    const pairBtn = main.querySelector('#pair');
    if (pairBtn) pairBtn.onclick = () => pairDialog(() => load(false));

    ctx.cleanup = () => { alive = false; clearTimeout(timer); };
    await load(true);
  }

  root.Attic.devices = { render };
})(window);
