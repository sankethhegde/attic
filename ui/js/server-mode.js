// The desktop tool's screen in Server mode (Phase 3, milestone 3-1, T-02 and T-03).
// Not set up yet: create a new server (storage folders, kept in the tool's own folder) or use an existing
// server folder, so the HP's accounts, devices and history carry over. Set up: the service's state, and
// Install (with Windows' permission prompt), Start, Stop, Restart, Remove, Start now without installing,
// and Open Attic. The work happens in the tool's main process (agent/server-control.js).
(function (root) {
  'use strict';
  const { util: U, ui } = root.Attic;
  const sm = root.atticDesktop && root.atticDesktop.serverMode;
  const app = document.getElementById('app');
  ui.applyTheme('system');
  if (!sm) { app.innerHTML = '<p style="padding:24px">This page belongs to the Attic Hub desktop tool.</p>'; return; }

  let st = null, busy = false, timer = 0, setupKind = 'new', msg = null;

  app.innerHTML = `<div class="stage connect-stage server-stage">
    <main class="login-card server-card" aria-labelledby="s-title">
      ${ui.brand()}
      <h1 id="s-title">This PC is the Attic server</h1>
      <div id="s-body" aria-live="polite"><div class="connect-progress"><span class="spinner" aria-hidden="true"></span><span>Checking the server…</span></div></div>
      <p class="server-foot">Is this PC a client instead? <button type="button" class="link-btn" id="s-mode">Change what this PC is</button></p>
    </main></div>`;
  const body = app.querySelector('#s-body');
  app.querySelector('#s-mode').onclick = () => root.atticDesktop.mode.change();

  const banner = () => msg ? `<div class="banner banner-${msg.kind}" role="${msg.kind === 'danger' ? 'alert' : 'status'}">${U.icon(msg.kind === 'danger' ? 'alert' : 'check')}<span>${U.esc(msg.text)}</span></div>` : '';

  // ---------- not set up yet ----------
  function setupHTML() {
    return `<p class="sub">First, where does the server keep its files? You only do this once.</p>
      ${banner()}
      <div class="connect-list" role="radiogroup" aria-label="How to set up">
        <button type="button" class="connect-choice mode-choice${setupKind === 'new' ? ' on' : ''}" role="radio" aria-checked="${setupKind === 'new'}" data-kind="new">
          ${U.icon('plus')}<span><b>Set up a new server</b><span class="c">Choose a folder for everyone’s files. Accounts and settings are kept in Attic Hub’s own folder.</span></span></button>
        <button type="button" class="connect-choice mode-choice${setupKind === 'existing' ? ' on' : ''}" role="radio" aria-checked="${setupKind === 'existing'}" data-kind="existing">
          ${U.icon('database')}<span><b>Use an existing server folder</b><span class="c">The server you already run, like the repository’s <span class="mono">attic\\server</span>. Its accounts, devices and history carry over.</span></span></button>
      </div>
      <form id="s-form" class="connect-form" novalidate>
        ${setupKind === 'new' ? `
          ${folderField('s-store', 'Store files in', st.suggestedStorage)}
          <div class="field no-icon"><input id="s-name" type="text" placeholder=" " value="Main storage" maxlength="40"><label for="s-name">Name shown in Files</label></div>
          <details class="server-more"><summary>Port</summary>
            <div class="field no-icon"><input id="s-port" type="number" placeholder=" " value="8080" min="1024" max="65535"><label for="s-port">Port</label></div>
            <p class="connect-hint">8080 unless something else on this PC uses it. Devices find the server whatever the port.</p></details>
          <p class="connect-hint">Settings and accounts go in <span class="mono">${U.esc(st.newDir)}</span>.</p>
          <button class="btn btn-primary btn-block" type="submit">Create the server</button>`
        : `
          ${folderField('s-existing', 'Server folder', '')}
          <p class="connect-hint">The folder with <span class="mono">config.json</span> and <span class="mono">data</span>. The repository’s top folder works too.</p>
          <button class="btn btn-primary btn-block" type="submit">Use this folder</button>`}
        <div class="form-error" id="s-error" role="alert"></div>
      </form>`;
  }
  function folderField(id, label, value) {
    return `<div class="folder-field"><div class="field no-icon"><input id="${id}" type="text" placeholder=" " value="${U.esc(value)}" spellcheck="false"><label for="${id}">${label}</label></div>
      <button type="button" class="btn btn-secondary" data-browse="${id}">${U.icon('folder')}Browse</button></div>`;
  }
  function wireSetup() {
    body.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { setupKind = b.dataset.kind; msg = null; draw(); });
    body.querySelectorAll('[data-browse]').forEach(b => b.onclick = async () => {
      const p = await sm.pickFolder(b.dataset.browse === 's-store' ? 'Where should Attic store files?' : 'Choose the server folder');
      if (p) body.querySelector('#' + b.dataset.browse).value = p;
    });
    body.querySelector('#s-form').onsubmit = async e => {
      e.preventDefault();
      const err = body.querySelector('#s-error');
      err.textContent = '';
      const opts = setupKind === 'new'
        ? { shares: [{ name: body.querySelector('#s-name').value, rootPath: body.querySelector('#s-store').value }], port: Number(body.querySelector('#s-port').value) }
        : { existing: body.querySelector('#s-existing').value };
      const btn = body.querySelector('[type=submit]');
      btn.disabled = true;
      const r = await sm.setup(opts);
      if (r && r.error) { btn.disabled = false; err.innerHTML = U.icon('alertCircle') + `<span>${U.esc(r.error)}</span>`; return; }
      msg = { kind: 'info', text: setupKind === 'new' ? 'Server created. Install it as a service so it runs whenever this PC is on.' : 'Using that server folder. Install it as a service so it runs whenever this PC is on.' };
      refresh();
    };
  }

  // ---------- set up ----------
  function statusRows(s) {
    const t = s.task, sup = s.supervisor, srv = s.server;
    const row = (k, v, ok) => `<div class="srv-row"><span class="k">${k}</span><span class="v">${ok === true ? '<span class="dot on" aria-hidden="true"></span>' : ok === false ? '<span class="dot" aria-hidden="true"></span>' : ''}${v}</span></div>`;
    return `<div class="srv-rows">
      ${row('Service', !t ? 'Not installed' : t.ours ? `Installed · starts with Windows${t.state === 'running' ? ' · running' : ''}` : 'Installed, but for another copy of the server', t ? t.ours && t.state === 'running' : null)}
      ${row('Server', srv ? `Answering as <b>${U.esc(srv.name)}</b> on port <span class="mono">${s.port}</span>${srv.byHand ? ' · started by hand, not by Attic Hub' : ''}` : `Not running (port <span class="mono">${s.port}</span>)`, !!srv)}
      ${sup ? row('Supervisor', `Running since ${U.relDate(sup.since).toLowerCase()}${sup.startedNow ? ', until Attic Hub closes' : ''}${sup.restarts ? ` · ${sup.restarts} restart${sup.restarts === 1 ? '' : 's'}` : ''}`) : ''}
      ${addressRow(s)}
    </div>`;
  }
  // This PC's address on the home network (8 Nov 2026): what the other devices, a browser or the iPhone use.
  function addressRow(s) {
    const n = st.network;
    if (!n) return '';
    const port = s.port || 8080;
    const list = n.addresses.length ? n.addresses.map(a => `<span class="srv-ip"><b class="mono" data-ip>${U.esc(a.address)}</b> <span class="muted">(${U.esc(a.via)})</span></span>`).join('<br>') : 'Not connected to a network';
    const first = n.addresses[0];
    return `<div class="srv-row"><span class="k">Address</span><span class="v">${list}
      ${first ? `<br><span class="muted">In a browser: <span class="mono">http://${U.esc(first.address)}:${port}</span> · by name: <span class="mono">${U.esc(n.hostname)}</span></span>` : ''}</span></div>`;
  }
  // A laptop that sleeps when its lid closes takes Attic away from every device.
  function lidHTML() {
    const n = st.network;
    if (!n || n.lidSleeps !== true) return '';
    return `<div class="banner banner-warning" role="status">${U.icon('alert')}<span>Closing this PC’s lid puts it to sleep, and the other devices lose Attic until it wakes. Attic Hub already stops it sleeping when idle.</span>
      <button type="button" class="btn btn-secondary btn-sm" data-act="lid">Keep running with the lid closed</button></div>`;
  }
  function actionsHTML(s) {
    const t = s.task, running = !!s.server, b = (a, label, kind, icon) => `<button type="button" class="btn btn-${kind}" data-act="${a}">${icon ? U.icon(icon) : ''}${label}</button>`;
    const out = [];
    if (running && !s.server.byHand) out.push(b('open', 'Open Attic', 'primary', 'arrowRight'));
    if (!t || !t.ours) {
      if (st.installable) out.push(b('install', t ? 'Install for this copy' : 'Install as a service', running ? 'secondary' : 'primary', 'shield'));
      if (!running) out.push(b('startNow', 'Start now without installing', 'secondary', 'refresh'));
    } else if (!running) out.push(b('start', 'Start', 'primary', 'refresh'));
    if (running && !s.server.byHand) out.push(b('restart', 'Restart', 'secondary', 'refresh'), b('stop', 'Stop', 'secondary', 'x'));
    return `<div class="srv-actions">${out.join('')}</div>`;
  }
  // 3-5: an update for the tool itself, from this PC's own server. Installing stops the service for a
  // moment and starts it again afterwards.
  const updates = root.atticDesktop.updates;
  let upd = null;
  function updateHTML() {
    if (!upd || !upd.latest) return '';
    const v = U.esc(upd.latest.version);
    if (upd.status === 'downloading') return `<div class="banner banner-info" role="status">${U.icon('download')}<span>Getting Attic Hub ${v} ready… ${upd.latest.size ? Math.floor(100 * upd.done / upd.latest.size) : 0}%</span></div>`;
    if (upd.status !== 'ready') return '';
    return `<div class="banner banner-info" role="status">${U.icon('info')}<span>Attic Hub ${v} is ready to install.${upd.canInstall ? ' The server stops for a moment while it installs, then starts again.' : ' (The installed Attic Hub only: this is a development copy.)'}</span>
      ${upd.canInstall ? '<button type="button" class="btn btn-primary btn-sm" data-act="update">Restart to update</button>' : ''}</div>`;
  }
  if (updates) {
    updates.get().then(u => { upd = u; if (!busy) draw(); }).catch(() => {});
    updates.onChange(u => { const was = upd && upd.status; upd = u; if (!busy && was !== u.status) draw(); });
  }

  function managedHTML() {
    const s = st.status;
    return `<p class="sub">Every other device reaches Attic through this PC. ${s.task && s.task.ours ? 'It starts with Windows, before anyone signs in, and restarts itself after a crash.' : 'Install it as a service so it starts with Windows, before anyone signs in.'}</p>
      ${banner()}
      ${updateHTML()}
      ${lidHTML()}
      ${!st.installable ? `<div class="banner banner-info">${U.icon('info')}<span>This is a development copy. It can start the server for now; installing the service is done from the installed Attic Hub.</span></div>` : ''}
      ${statusRows(s)}
      ${actionsHTML(s)}
      ${!s.task || !s.task.ours ? (st.installable ? `<p class="connect-hint">${U.icon('shield')} Installing asks Windows for permission (an Administrator prompt), once.</p>` : '') : ''}
      <details class="server-more"><summary>Folder and log</summary>
        <p class="connect-hint">Settings and data: <span class="mono">${U.esc(st.paths.dir)}</span></p>
        <pre class="srv-log" tabindex="0" aria-label="Server log">${st.logs.length ? U.esc(st.logs.join('\n')) : 'No log yet. It starts once the server has run.'}</pre>
        <div class="srv-actions">
          ${s.task && s.task.ours ? '<button type="button" class="btn btn-ghost btn-sm" data-act="remove">Remove the service</button>' : ''}
          <button type="button" class="btn btn-ghost btn-sm" data-act="forget">Use a different folder</button>
        </div>
      </details>`;
  }

  const LABELS = { install: 'Installing… Windows asks for permission', remove: 'Removing the service…', start: 'Starting…', stop: 'Stopping…',
    restart: 'Restarting…', startNow: 'Starting the server…', open: 'Opening Attic…' };
  const DONE = { install: 'Installed. The server now starts with Windows, before anyone signs in.', remove: 'The service is removed. Your files and settings are untouched.',
    start: 'Started.', stop: 'Stopped.', restart: 'Restarted.', startNow: 'Started. It runs until you close Attic Hub, or install it as a service.' };

  async function act(name) {
    if (busy) return;
    if (name === 'remove' && !(await ui.confirm({ title: 'Remove the service?', danger: true, confirm: 'Remove',
      lead: 'The server stops and no longer starts with Windows. Files, accounts and settings stay where they are. Windows asks for permission.' }))) return;
    if (name === 'stop' && !(await ui.confirm({ title: 'Stop the server?', confirm: 'Stop',
      lead: 'Every device loses Attic until it starts again. Files waiting for a device are kept.' }))) return;
    if (name === 'lid') {
      const r = await sm.lidStayAwake();
      msg = r && r.error ? { kind: 'danger', text: r.error } : { kind: 'info', text: 'Done: plugged in, this PC keeps running with the lid closed.' };
      return refresh();
    }
    if (name === 'update') {
      if (!(await ui.confirm({ title: `Update to Attic Hub ${upd.latest.version}?`, confirm: 'Restart and update',
        lead: 'The server stops for a moment while the new version installs, then starts again. Devices reconnect by themselves.' }))) return;
      const r = await updates.install();
      msg = r && r.error ? { kind: 'danger', text: r.error } : { kind: 'info', text: 'Updating… Attic Hub opens again in a moment.' };
      return draw();
    }
    if (name === 'forget' && !(await ui.confirm({ title: 'Use a different folder?', confirm: 'Choose again',
      lead: 'The server stops, and you choose its folder again. Nothing on disk is deleted.' }))) return;
    busy = true;
    msg = null;
    body.querySelector('.srv-actions').innerHTML = `<div class="connect-progress"><span class="spinner" aria-hidden="true"></span><span>${LABELS[name] || 'Working…'}</span></div>`;
    const r = name === 'open' ? await sm.open() : name === 'forget' ? await sm.forget() : await sm.action(name);
    busy = false;
    if (name === 'open' && r && r.ok) return;
    msg = r && r.error ? { kind: 'danger', text: r.error } : DONE[name] ? { kind: 'info', text: DONE[name] } : null;
    refresh();
  }

  function draw() {
    if (!st) return;
    body.innerHTML = st.configured ? managedHTML() : setupHTML();
    if (st.configured) body.querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act));
    else wireSetup();
  }

  // The state is checked every few seconds while nothing is being done, so a crash or a restart shows.
  async function refresh() {
    clearTimeout(timer);
    try { st = await sm.state(); } catch (e) { st = null; }
    if (!busy) {
      const keepOpen = body.querySelector('details[open]'), focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.act;
      const typing = body.querySelector('#s-form') && body.contains(document.activeElement);
      if (!typing) {
        draw();
        if (keepOpen) { const d = body.querySelector('details'); if (d) d.open = true; }
        if (focused) { const b = body.querySelector(`[data-act="${focused}"]`); if (b) b.focus(); }
      }
    }
    if (st && st.configured) timer = setTimeout(refresh, 3000);
  }
  refresh();
})(window);
