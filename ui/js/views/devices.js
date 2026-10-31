// Devices view (Attic Hub, Phase 1B on mock data): a card per home device with status and live stats.
// Pairing and send-to-device arrive in Phase 2; their controls are present but disabled, so the layout
// does not change when they arrive.
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
    if (d.browserOnly) return `<p class="dev-note">${U.icon('info')}<span>Safari can’t read the phone’s system stats, so only connection status is shown.</span></p>`;
    if (!d.online) return `<p class="dev-note">${U.icon('cloudOff')}<span>Offline. Stats return when it reconnects.</span></p>`;
    if (!master) return `<p class="dev-note">${U.icon('lock')}<span>System stats are visible to the master account.</span></p>`;
    const s = d.stats;
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
    return `<article class="hub-card${d.online ? '' : ' offline'}" data-id="${d.id}" aria-label="${U.esc(d.name)}, ${d.online ? 'online' : 'offline'}">
      <div class="hub-card-top">
        <span class="hub-art">${art}</span>
        <div class="hub-id">
          <h2 class="nm">${U.esc(d.name)}</h2>
          <div class="tags">${d.role === 'server' ? `<span class="tag tag-ok">${U.icon('database')}Server</span>` : ''}${d.thisPC ? `<span class="tag">This PC</span>` : ''}</div>
          <div class="c">${U.esc(d.os)}</div>
        </div>
      </div>
      <div class="hub-status">
        <span class="dot ${d.online ? 'on' : ''}" aria-hidden="true"></span>
        <span>${d.online ? 'Online' : 'Offline · last seen ' + U.relDate(d.lastSeenAt)}</span>
        <span class="grow"></span>
        <span class="conn">${U.icon(d.connection === 'ethernet' ? 'ethernet' : 'wifi')}${d.connection === 'ethernet' ? 'Ethernet' : 'Wi-Fi'} · <span class="mono">${U.esc(d.ip)}</span></span>
      </div>
      ${statsHTML(d, master)}
      <div class="hub-actions">
        <span class="tip" data-tip="Sending to devices arrives in Phase 2" tabindex="0"><button class="btn btn-secondary btn-sm" disabled>${U.icon('transfer')}Send a file</button></span>
      </div>
    </article>`;
  }

  async function render(ctx) {
    const { main, shell, state } = ctx;
    const master = state.session.type === 'master';
    shell.setLocation('<span class="title">Devices</span>');
    shell.setSearch(null);
    main.innerHTML = `<div class="page"><div class="page-head"><h1>Devices</h1><span class="muted" id="dcount"></span><span class="grow"></span>
        <span class="tip" data-tip="Pairing new devices arrives in Phase 2" tabindex="0"><button class="btn btn-primary btn-sm" disabled>${U.icon('plus')}Pair a device</button></span></div>
      <div class="banner banner-info">${U.icon('info')}<span>Mock devices for Phase 1B. Live stats are simulated; real devices report in once pairing arrives in Phase 2.</span></div>
      <div id="body"></div></div>`;
    const body = main.querySelector('#body');
    let timer = 0, alive = true;

    async function load(first) {
      let list;
      try { list = first ? await ui.load(body, api.listHubDevices(), `<div class="hub-grid">${'<div class="card skel" style="height:300px"></div>'.repeat(4)}</div>`) : await api.listHubDevices(); }
      catch (e) {
        if (!first) return schedule(); // a missed poll is not worth an error screen
        body.innerHTML = ui.errorState(e); body.querySelector('#retry').onclick = () => load(true); return;
      }
      if (!alive) return;
      const online = list.filter(d => d.online).length;
      main.querySelector('#dcount').textContent = `${online} of ${list.length} online`;
      if (!list.length) {
        body.innerHTML = ui.empty({ icon: 'device', title: 'No devices yet', text: 'Pair a PC or phone to see its status here.' });
        return;
      }
      if (first || !body.querySelector('.hub-grid')) body.innerHTML = `<div class="hub-grid">${list.map(d => cardHTML(d, master)).join('')}</div>`;
      else list.forEach(d => { // replace only what changed, so focus and scroll stay put
        const old = body.querySelector(`.hub-card[data-id="${d.id}"]`);
        const fresh = ui.el(cardHTML(d, master));
        if (old && old.innerHTML !== fresh.innerHTML && !old.contains(document.activeElement)) old.replaceWith(fresh);
      });
      schedule();
    }
    function schedule() { clearTimeout(timer); if (alive) timer = setTimeout(() => load(false), POLL_MS); }

    ctx.cleanup = () => { alive = false; clearTimeout(timer); };
    await load(true);
  }

  root.Attic.devices = { render };
})(window);
