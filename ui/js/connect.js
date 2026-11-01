// The desktop tool's "Looking for server" screen (Phase 2, milestone 2-1, D-01).
// The search runs in the tool's main process (agent/connect.js); this page shows its progress and offers
// the fallbacks: search again, pick one of several servers, or type the address.
(function (root) {
  'use strict';
  const { util: U, ui } = root.Attic;
  const hub = root.atticDesktop && root.atticDesktop.hub;
  const app = document.getElementById('app');

  ui.applyTheme('system');

  if (!hub) {
    app.innerHTML = `<div class="stage connect-stage"><div class="login-card">${ui.brand()}
      <h1>Attic Hub desktop tool</h1><p class="sub">This page is the desktop tool’s start screen. In a browser, open the address the HP server prints instead.</p></div></div>`;
    return;
  }

  app.innerHTML = `<div class="stage connect-stage">
    <main class="login-card connect-card" aria-labelledby="c-title">
      ${ui.brand()}
      <div id="c-state" aria-live="polite"></div>
      <form id="c-form" class="connect-form" novalidate>
        <div class="divider" id="c-or">or type its address</div>
        <div class="field" data-field="c-addr">
          ${U.icon('monitor')}
          <input id="c-addr" type="text" placeholder=" " autocomplete="off" spellcheck="false" inputmode="url" aria-describedby="c-addr-msg c-addr-hint">
          <label for="c-addr">Server address</label>
          <div class="field-msg" id="c-addr-msg" aria-live="polite"></div>
        </div>
        <p class="connect-hint" id="c-addr-hint">Like 192.168.1.10. The HP prints its address when the server starts.</p>
        <button class="btn btn-secondary btn-block" type="submit" id="c-go">Connect</button>
      </form>
    </main>
  </div>`;

  const stateEl = app.querySelector('#c-state');
  const form = app.querySelector('#c-form');
  const addr = app.querySelector('#c-addr');
  const go = app.querySelector('#c-go');
  const field = form.querySelector('[data-field]');
  let busy = false;

  function setError(msg) {
    field.classList.toggle('invalid', !!msg);
    form.querySelector('#c-addr-msg').textContent = msg || '';
    addr.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }
  addr.addEventListener('input', () => setError(''));

  const serverLine = s => `<span class="mono">${U.esc(s.address)}:${s.port}</span>`;
  const spinner = text => `<div class="connect-progress"><span class="spinner" aria-hidden="true"></span><span>${text}</span></div>`;

  function render(s) {
    busy = s.state === 'searching' || s.state === 'checking' || s.state === 'connected';
    go.disabled = busy;
    let html = '';
    if (s.state === 'searching') {
      html = `<h1 id="c-title">${s.lost ? `Reconnecting to ${U.esc(s.lost.name)}` : 'Looking for your Attic server'}</h1>
        <p class="sub">${s.lost ? 'The connection dropped. Looking for it on your home network again.' : 'Searching your home network. This takes a few seconds.'}</p>
        ${spinner(s.step === 'remembered' && s.server ? `Trying ${U.esc(s.server.name || 'the last server')} at ${serverLine(s.server)}…` : 'Asking the network for the HP…')}`;
    } else if (s.state === 'checking') {
      html = `<h1 id="c-title">Checking ${U.esc(s.address)}</h1><p class="sub">Making sure it’s an Attic server.</p>${spinner('Connecting…')}`;
    } else if (s.state === 'connected') {
      html = `<h1 id="c-title">Found ${U.esc(s.server.name)}</h1><p class="sub">At ${serverLine(s.server)}. Opening Attic…</p>${spinner('Opening…')}`;
    } else if (s.state === 'choose') {
      html = `<h1 id="c-title">More than one server answered</h1><p class="sub">Choose the one to use. The tool remembers it next time.</p>
        <div class="connect-list" role="list">${s.servers.map(x => `<button type="button" class="connect-choice" role="listitem" data-id="${x.serverId}">
          ${U.icon('database')}<span><b>${U.esc(x.name)}</b><span class="c">${serverLine(x)}${x.serverId === s.rememberedId ? ' · used last time' : ''}</span></span>${U.icon('chevronRight')}</button>`).join('')}</div>
        <button type="button" class="btn btn-ghost btn-sm" id="c-retry">${U.icon('refresh')}Search again</button>`;
    } else if (s.state === 'not-found') {
      const heard = s.heard > 0
        ? `<li>A server answered the search but didn’t accept a connection. On the HP, Windows Firewall needs inbound <b>TCP ${s.port || 8080}</b> allowed on the Private profile.</li>` : '';
      html = `<h1 id="c-title">${s.lost ? `Can’t reach ${U.esc(s.lost.name)}` : 'No Attic server found'}</h1>
        <p class="sub">${s.lost ? 'The HP stopped answering. It may be off, asleep or restarting.' : 'Nothing answered on your home network.'}</p>
        <ul class="connect-checks">
          <li>Make sure the HP is on and the Attic server is running.</li>
          <li>Make sure this PC is on the same Wi-Fi or network as the HP.</li>
          <li>On the HP, Windows Firewall must allow inbound <b>UDP 41980</b> on the Private profile, or discovery can’t reach it.</li>
          ${heard}
        </ul>
        ${s.error ? `<p class="connect-hint">Search error: ${U.esc(s.error)}</p>` : ''}
        <button type="button" class="btn btn-primary btn-block" id="c-retry">${U.icon('refresh')}Search again</button>`;
    } else if (s.state === 'typed-error') {
      html = `<h1 id="c-title">Couldn’t connect</h1><p class="sub">Check the address, or search the network again.</p>
        <button type="button" class="btn btn-primary btn-block" id="c-retry">${U.icon('refresh')}Search again</button>`;
      setError(s.message);
      addr.focus();
    }
    stateEl.innerHTML = html;
    const retry = stateEl.querySelector('#c-retry');
    if (retry) retry.onclick = () => { setError(''); hub.retry(); };
    stateEl.querySelectorAll('[data-id]').forEach(b => b.onclick = () => hub.choose(b.dataset.id));
    if (s.address && !addr.value) addr.value = s.address;
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    if (busy) return;
    if (!addr.value.trim()) { setError('Type the server’s address, like 192.168.1.10.'); addr.focus(); return; }
    setError('');
    hub.connectTo(addr.value);
  };

  hub.onState(render);
  hub.ready();
})(window);
