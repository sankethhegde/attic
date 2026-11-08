// Settings: one scrolling page of grouped sections. Changes apply immediately — no save button.
(function (root) {
  'use strict';
  const { util: U, api, ui, background } = root.Attic;

  // The interface's version: the desktop tool's when it runs there; the HP serves the same files.
  const VERSION = '0.12.3';
  const HUB_REQUIREMENTS_URL = 'https://claude.ai/artifact/PAvQYsCeT2cKm1oApbtzJv';
  const GUIDE_URL = 'https://claude.ai/artifact/1AXNgGjN22Pcmm2HtCqa3p';

  function seg(name, options, current, label) {
    return `<div class="seg" role="group" aria-label="${label}">${options.map(([v, l]) => `<button data-${name}="${v}" aria-pressed="${current === v}">${l}</button>`).join('')}</div>`;
  }

  async function render(ctx) {
    const { main, shell, state } = ctx;
    const master = state.session.type === 'master';
    shell.setLocation('<span class="title">Settings</span>');
    shell.setSearch(null);
    let s = state.settings;
    const acc = state.account;

    main.innerHTML = `<div class="page"><div class="settings">
      <div class="page-head" style="margin:0"><h1>Settings</h1></div>

      <section class="card" aria-labelledby="h-app">
        <h2 id="h-app">Appearance</h2>
        <div class="set-row"><div class="lbl">Theme<small>Follow system matches your device’s light or dark setting.</small></div>
          <div class="ctl">${seg('theme', [['light', 'Light'], ['dark', 'Dark'], ['system', 'Follow system']], s.theme, 'Theme')}</div></div>
        <div class="set-row" style="display:block"><div class="lbl" style="margin-bottom:12px">Login background<small>Shown behind the sign-in card on this browser.</small></div><div id="picker"></div></div>
        <div class="set-row"><div class="lbl">Default view for Files</div><div class="ctl">${seg('fview', [['list', 'List'], ['grid', 'Grid']], s.filesView, 'Default Files view')}</div></div>
        <div class="set-row"><div class="lbl">Photo thumbnail size</div><div class="ctl">${seg('psize', [['s', 'Small'], ['m', 'Medium'], ['l', 'Large']], s.photoSize, 'Photo thumbnail size')}</div></div>
      </section>

      <section class="card" aria-labelledby="h-acc">
        <h2 id="h-acc">Account</h2>
        <div class="set-row"><div class="lbl"><label for="dname">Display name</label><small>Shown in the header and device list.</small></div>
          <div class="ctl"><input class="plain-input" id="dname" value="${U.esc(acc.displayName)}" maxlength="40" style="width:240px"></div></div>
        <div class="set-row"><div class="lbl">Username<small>Used to sign in. It can’t be changed.</small></div><div class="ctl mono">@${U.esc(acc.username)}</div></div>
        <div class="set-row"><div class="lbl"><label for="email">Email</label><small>Where a password-reset link goes if you forget your password. You can also sign in with it.</small></div>
          <div class="ctl"><input class="plain-input" id="email" type="email" value="${U.esc(acc.email || '')}" placeholder="you@example.com" maxlength="254" autocapitalize="none" autocorrect="off" spellcheck="false" style="width:240px"></div></div>
        <div class="set-row" style="display:block"><div class="lbl" style="margin-bottom:10px">This device<small>Detected automatically. Correct it if the guess is wrong — it’s remembered in this browser.</small></div><div id="this-device"></div></div>
        <div class="set-row"><div class="lbl">Paired with the HP as<small>The master can unpair a device from the Devices tab.</small></div>
          <div class="ctl" id="paired-as"><span class="skel" style="display:inline-block;width:140px;height:14px"></span></div></div>
        <div class="set-row"><div class="lbl">Password</div><div class="ctl"><button class="btn btn-secondary btn-sm" id="chpass">${U.icon('lock')}Change password</button></div></div>
        <div class="set-row"><div class="lbl">Sign out<small>${state.session.persistent ? 'You’re set to stay signed in on this browser for 30 days.' : 'Your session ends when this tab closes.'}</small></div>
          <div class="ctl"><button class="btn btn-secondary btn-sm" id="signout">${U.icon('logout')}Sign out</button></div></div>
      </section>

      ${root.atticDesktop && root.atticDesktop.server ? `
      <section class="card" aria-labelledby="h-srv">
        <h2 id="h-srv">Server</h2>
        <div class="set-row"><div class="lbl">This PC is<small>Chosen when Attic Hub first started: the server (the HP) or a client.</small></div>
          <div class="ctl" id="srv-role" style="gap:8px;flex-wrap:wrap;justify-content:flex-end"><span class="skel" style="display:inline-block;width:120px;height:14px"></span></div></div>
        <div class="set-row"><div class="lbl">Connected to<small>The desktop tool finds the HP on your home network by itself, and remembers it for next time.</small></div>
          <div class="ctl" id="srv-now"><span class="skel" style="display:inline-block;width:180px;height:14px"></span></div></div>
        <div class="set-row" data-client><div class="lbl">Live stats<small>While this PC is paired, the tool sends the HP its CPU, RAM, disk, battery and network every few seconds, for the master’s Devices view.</small></div>
          <div class="ctl" id="srv-agent"><span class="skel" style="display:inline-block;width:120px;height:14px"></span></div></div>
        <div class="set-row" data-client><div class="lbl">Hub Inbox<small>Files other devices send to this PC land here, private to you. Changing the folder leaves files already received where they are.</small></div>
          <div class="ctl" style="flex-wrap:wrap;justify-content:flex-end;gap:8px"><span class="mono" id="inbox-path" style="font-size:12.5px;word-break:break-all"></span>
            <button class="btn btn-secondary btn-sm" id="inbox-open">${U.icon('folder')}Open folder</button>
            <button class="btn btn-secondary btn-sm" id="inbox-change">Change folder</button>
            <button class="btn btn-ghost btn-sm" id="inbox-reset" hidden>Use the default</button></div></div>
        <div class="set-row" id="inbox-recent-row" hidden><div class="lbl">Received<small>The latest files that arrived while the tool was open.</small></div>
          <div class="ctl"><ul class="inbox-recent" id="inbox-recent"></ul></div></div>
        <div class="set-row" data-client><div class="lbl">Use another server<small>Search the network again, or type an address. You’ll sign in on the server you pick.</small></div>
          <div class="ctl"><button class="btn btn-secondary btn-sm" id="srv-change">${U.icon('refresh')}Change server</button></div></div>
      </section>

      <section class="card" aria-labelledby="h-pc">
        <h2 id="h-pc">This PC</h2>
        <div class="set-row"><div class="lbl">Start with Windows<small id="pc-start-hint">Attic Hub starts in the system tray when you sign in, so files sent to this PC arrive. Closing the window keeps it in the tray; quit from the tray icon.</small></div>
          <div class="ctl"><label class="check"><input type="checkbox" id="pc-start"> On</label></div></div>
        <div class="set-row" data-client><div class="lbl">Notify me when files arrive<small>A Windows notification when a file lands in the Hub Inbox. Click it to see the file.</small></div>
          <div class="ctl"><label class="check"><input type="checkbox" id="pc-notify"> On</label></div></div>
        <div class="set-row" data-client><div class="lbl">Files I send<small>A notification when a file you sent from this PC is delivered, or doesn’t arrive.</small></div>
          <div class="ctl"><label class="check"><input type="checkbox" id="pc-notify-transfers"> On</label></div></div>
        <div class="set-row" data-client><div class="lbl">Devices<small>A notification when another device has been offline for half a minute, and when it’s back.</small></div>
          <div class="ctl"><label class="check"><input type="checkbox" id="pc-notify-devices"> On</label></div></div>
        <div class="set-row" data-client><div class="lbl">“Send to Attic Hub” in File Explorer<small id="pc-explorer-hint">Right-click files or a folder, then Send to Attic Hub (on Windows 11, under Show more options). Dropping files on this window works too.</small></div>
          <div class="ctl"><label class="check"><input type="checkbox" id="pc-explorer"> On</label></div></div>
        <div class="set-row" data-client><div class="lbl">Low-resource mode<small>For the ROG Ally. While it’s on, this PC reports its stats every 15 seconds instead of every 3, and this window holds still: no animations or blur. Automatic turns it on while a Steam game runs or a full-screen app is in front. <span id="pc-low-now" role="status"></span></small></div>
          <div class="ctl">${seg('low', [['auto', 'Automatic'], ['on', 'Always on'], ['off', 'Off']], null, 'Low-resource mode')}</div></div>
      </section>` : ''}

      ${ui.handheld ? `
      <section class="card" aria-labelledby="h-phone">
        <h2 id="h-phone">This ${ui.isIOS ? 'iPhone' : 'phone'}</h2>
        <div class="set-row" id="ph-secure-row"><div class="lbl">Secure connection<small id="ph-secure">Checking…</small></div>
          <div class="ctl" id="ph-secure-ctl"></div></div>
        <div class="set-row" id="ph-steps-row" hidden style="display:block"><ol class="ph-steps" id="ph-steps"></ol></div>
        <div class="set-row"><div class="lbl">Home Screen app<small id="ph-home">${ui.standalone
          ? 'You’re using Attic from the Home Screen.'
          : ui.isIOS ? 'In Safari, tap Share, then Add to Home Screen. Attic then opens full screen, like an app. Do it from the secure address: the Home Screen app keeps the address it was added from.'
          : 'In your browser’s menu, choose Add to Home Screen (or Install app).'}</small></div></div>
        <div class="set-row"><div class="lbl">On a phone<small>Attic works the same here, except: files sent to this phone wait until you open Attic; there are no notifications while it’s closed; and the phone doesn’t report its own stats.</small></div></div>
      </section>` : ''}

      ${master ? `
      <section class="card" aria-labelledby="h-sh">
        <div class="card-head" style="margin-bottom:4px"><h2 id="h-sh">Shares <span class="scope">Master</span></h2><span class="grow"></span><button class="btn btn-secondary btn-sm" id="add-share">${U.icon('plus')}Add share</button></div>
        <p class="muted" style="font-size:13px;margin:0 0 6px">Folders on the HP that Attic serves. Changes are saved to the server and apply straight away.</p>
        <div id="shares"><div class="skel" style="height:120px"></div></div>
      </section>

      <section class="card" aria-labelledby="h-dev">
        <h2 id="h-dev">Devices <span class="scope">Master</span></h2>
        <div class="set-row"><div class="lbl">Registered devices<small>Add, revoke and remove device accounts in one place.</small></div>
          <div class="ctl"><a class="btn btn-secondary btn-sm" href="#/dashboard">Open device list${U.icon('chevronRight')}</a></div></div>
      </section>

      <section class="card" aria-labelledby="h-pp" id="pp-card">
        <h2 id="h-pp">People Portfolio <span class="scope">Master</span></h2>
        <p class="muted" style="font-size:13px;margin:0 0 6px">People Portfolio saves its people, labels and notes here, and picks photos from the shared folders. Its photos aren’t moved or copied.</p>
        <div class="set-row"><div class="lbl">Save folder<small>A folder inside a shared folder. Each save is a new dated file; the newest 30 are kept.</small></div>
          <div class="ctl"><select class="plain-select" id="pp-share" aria-label="Shared folder"></select><input class="plain-input" id="pp-path" placeholder="Folder, e.g. Backups/People" style="width:220px" autocapitalize="none" spellcheck="false">
            <button class="btn btn-secondary btn-sm" id="pp-save-folder">Save</button></div></div>
        <div class="set-row"><div class="lbl"><label for="pp-origins">People Portfolio’s address</label><small>The page’s address, one per line, for example http://localhost:5173. Only these pages may use the key.</small></div>
          <div class="ctl" style="align-items:flex-start"><textarea class="plain-input" id="pp-origins" rows="2" style="width:280px;height:auto;padding:8px 12px" spellcheck="false" autocapitalize="none"></textarea>
            <button class="btn btn-secondary btn-sm" id="pp-save-origins">Save</button></div></div>
        <div class="set-row"><div class="lbl">Key<small id="pp-key-state">Checking…</small></div>
          <div class="ctl"><button class="btn btn-primary btn-sm" id="pp-key">Make a key</button></div></div>
        <div class="set-row" style="display:block"><div class="lbl">In People Portfolio<small id="pp-howto">Open ⋮ → Attic, enter <b class="mono" id="pp-address"></b>, and paste the key. Chrome on each PC must trust the HP once: <a href="/api/tls/ca.cer" download>download the HP’s certificate</a>, open it, and install it under “Trusted Root Certification Authorities”.</small></div></div>
      </section>

      <section class="card" aria-labelledby="h-adv">
        <h2 id="h-adv">Advanced <span class="scope">Master</span></h2>
        <div class="set-row" id="mail-row"><div class="lbl">Email for password resets<small id="mail-state">Checking…</small></div>
          <div class="ctl" id="mail-ctl"></div></div>
        <div class="set-row"><div class="lbl">Export settings<small>Theme, background and view preferences as JSON, with the share list for reference.</small></div>
          <div class="ctl"><button class="btn btn-secondary btn-sm" id="export">${U.icon('download')}Export JSON</button></div></div>
        <div class="set-row"><div class="lbl">Import settings<small>Replaces this browser’s preferences with the file’s. Shares aren’t imported: add them above.</small></div>
          <div class="ctl"><button class="btn btn-secondary btn-sm" id="import">${U.icon('upload')}Import JSON</button><input type="file" id="import-file" accept="application/json,.json" hidden></div></div>
        <div class="set-row desktop-only"><div class="lbl">Publish an update<small>Send a new Attic Hub installer (Attic-Hub-Setup-&lt;version&gt;.exe, from <span class="mono">npm run dist</span>) to the HP. Every device then downloads it from the HP and offers to restart into it, with no internet needed.</small></div>
          <div class="ctl"><button class="btn btn-secondary btn-sm" id="upd-publish">${U.icon('upload')}Choose installer</button><input type="file" id="upd-file" accept=".exe" hidden></div></div>
        <div class="set-row" id="upd-kept-row" hidden><div class="lbl">On the HP<small>The newest three are kept.</small></div>
          <div class="ctl"><ul class="inbox-recent" id="upd-kept"></ul></div></div>
        <div class="set-row"><div class="lbl" style="color:var(--danger)">Clear local data<small>Signs you out and resets this browser. Nothing on the server is touched.</small></div>
          <div class="ctl"><button class="btn btn-danger btn-sm" id="clear">${U.icon('trash')}Clear local data</button></div></div>
      </section>` : ''}

      <section class="card" aria-labelledby="h-about">
        <h2 id="h-about">About</h2>
        <div class="set-row"><div class="lbl">Version</div><div class="ctl mono">${VERSION}</div></div>
        ${root.atticDesktop && root.atticDesktop.updates ? `<div class="set-row" id="upd-row"><div class="lbl" id="h-updates">Updates<small>Attic Hub updates itself, like PixHaven: a new version published on GitHub (or, without internet, put on the HP) downloads by itself, not while a game runs, and installs the next time Attic Hub starts or quits. Restart to update installs it now. <span id="upd-status" role="status"></span></small></div>
          <div class="ctl"><button class="btn btn-secondary btn-sm" id="upd-check">${U.icon('refresh')}Check now</button><button class="btn btn-primary btn-sm" id="upd-install" hidden>Restart to update</button></div></div>` : ''}
        <div class="set-row"><div class="lbl">Running in</div><div class="ctl">${root.atticDesktop ? `Attic Hub desktop tool${root.atticDesktop.version ? ` <span class="mono">${U.esc(root.atticDesktop.version)}</span>` : ''}` : 'A web browser'}</div></div>
        <div class="set-row" style="display:block"><div class="banner banner-info" style="margin:0">${U.icon('info')}<span>Files, shares, accounts, devices and transfers are real and live on the HP. <span id="ix-lead">This connection isn’t encrypted, so use Attic on your home Wi-Fi only.</span> <span id="ix"></span></span></div></div>
        <div class="set-row"><div class="lbl">Help</div><div class="ctl" style="flex-direction:column;align-items:flex-end;gap:4px">
          <a href="${GUIDE_URL}" target="_blank" rel="noopener">User guide ${U.icon('chevronRight').replace('class="ic"', 'class="ic" style="width:14px;height:14px;vertical-align:-2px"')}</a>
          <a href="${HUB_REQUIREMENTS_URL}" target="_blank" rel="noopener">Attic Hub requirements ${U.icon('chevronRight').replace('class="ic"', 'class="ic" style="width:14px;height:14px;vertical-align:-2px"')}</a></div></div>
      </section>
    </div></div>`;

    const save = async (patch, msg) => {
      try { s = state.settings = await api.updateSettings(patch); if (msg) ui.toast(msg); }
      catch (e) { ui.toast(e.message, 'error'); }
    };
    const press = (name, v) => main.querySelectorAll(`[data-${name}]`).forEach(b => b.setAttribute('aria-pressed', b.dataset[name] === v));

    main.querySelectorAll('[data-theme]').forEach(b => b.onclick = async () => { press('theme', b.dataset.theme); ui.applyTheme(b.dataset.theme); ctx.shellApi.syncTheme(); await save({ theme: b.dataset.theme }); });
    main.querySelectorAll('[data-fview]').forEach(b => b.onclick = async () => { press('fview', b.dataset.fview); state.tabs.files.view = b.dataset.fview; await save({ filesView: b.dataset.fview }, `Files will open in ${b.dataset.fview} view`); });
    main.querySelectorAll('[data-psize]').forEach(b => b.onclick = async () => { press('psize', b.dataset.psize); await save({ photoSize: b.dataset.psize }, 'Thumbnail size saved'); });
    background.renderPicker(main.querySelector('#picker'));
    root.Attic.device.field(main.querySelector('#this-device'));
    const pairedAs = main.querySelector('#paired-as');
    api.getPairing().then(p => {
      pairedAs.innerHTML = p.thisPC ? '<span><b>The HP itself</b> · no pairing needed</span>'
        : p.device ? `<span><b>${U.esc(p.device.name)}</b></span>`
        : `<span class="muted">${p.required ? 'Not paired' : 'Pairing is off on the HP'}</span>`;
    }).catch(() => { pairedAs.innerHTML = '<span class="muted">Not known</span>'; });

    // Desktop tool only: which HP this tool is talking to, and a way to pick another (Phase 2, 2-1).
    const srvNow = main.querySelector('#srv-now');
    if (srvNow) {
      root.atticDesktop.server.current().then(sv => {
        srvNow.innerHTML = sv
          ? `<span><b>${U.esc(sv.name)}</b> · <span class="mono">${U.esc(sv.address)}:${sv.port}</span></span>`
          : '<span class="muted">Not known</span>';
        // Phase 2, 2-3: what the live-stats agent is doing.
        const AGENT = { reporting: 'Sending to the HP', connecting: 'Connecting…', retrying: 'Reconnecting…', unpaired: 'Stopped: this PC was unpaired',
          replaced: 'Stopped: another copy of the tool took over', stopped: 'Off', off: 'Off: this PC isn’t paired, or it’s the HP itself' };
        const st = sv && sv.agent || 'off';
        main.querySelector('#srv-agent').innerHTML = `<span class="${st === 'reporting' ? '' : 'muted'}">${st === 'reporting' ? '<span class="dot on" style="display:inline-block;margin-right:8px"></span>' : ''}${AGENT[st] || st}</span>`;
        // Phase 3, 3-1: this PC's role. The server has no agent, no inbox and no other server to pick;
        // it gets its service controls instead.
        const isServer = sv && sv.mode === 'server';
        main.querySelectorAll('[data-client]').forEach(r => { r.hidden = isServer; });
        const role = main.querySelector('#srv-role');
        role.innerHTML = `<span><b>${isServer ? 'The server' : 'A client'}</b></span>
          ${isServer ? `<button class="btn btn-secondary btn-sm" id="srv-controls">${U.icon('database')}Server controls</button>` : ''}
          <button class="btn btn-ghost btn-sm" id="srv-role-change">Change</button>`;
        if (isServer) role.querySelector('#srv-controls').onclick = () => root.atticDesktop.serverMode.controls();
        role.querySelector('#srv-role-change').onclick = async () => {
          const ok = await ui.confirm({ title: 'Change what this PC is?', confirm: 'Choose again',
            lead: isServer ? 'Attic Hub goes back to its first question. The server keeps running as a service until you stop or remove it from Server controls; nothing is deleted.'
              : 'Attic Hub goes back to its first question. Your pairing and files are kept.' });
          if (ok) root.atticDesktop.mode.change();
        };
      }).catch(() => { srvNow.innerHTML = '<span class="muted">Not known</span>'; });
      // Phase 2, 2-4: the Hub Inbox folder.
      if (root.atticDesktop.inbox) {
        root.atticDesktop.inbox.path().then(p => { main.querySelector('#inbox-path').textContent = p || ''; }).catch(() => {});
        root.atticDesktop.inbox.recent().then(list => {
          if (!list || !list.length) return;
          main.querySelector('#inbox-recent-row').hidden = false;
          main.querySelector('#inbox-recent').innerHTML = list.slice(0, 5).map(r =>
            `<li><span class="nm">${U.nameHTML(r.name)}</span><span class="c"><span class="mono">${U.formatBytes(r.size)}</span> · ${U.relDate(r.at)}</span></li>`).join('');
        }).catch(() => {});
        main.querySelector('#inbox-open').onclick = async () => {
          const err = await root.atticDesktop.inbox.open().catch(e => e.message);
          if (err) ui.toast('Couldn’t open the Hub Inbox: ' + err, 'error');
        };
        // Phase 3, 3-3 (T-07): another folder, or back to the default in Downloads.
        const showPath = p => { main.querySelector('#inbox-path').textContent = p || ''; };
        main.querySelector('#inbox-change').onclick = async () => {
          const r = await root.atticDesktop.inbox.choose();
          if (!r || r.canceled) return;
          if (r.error) return ui.toast(r.error, 'error');
          showPath(r.path);
          main.querySelector('#inbox-reset').hidden = false;
          ui.toast('Files sent to this PC now go to ' + r.path);
        };
        main.querySelector('#inbox-reset').onclick = async () => {
          const r = await root.atticDesktop.inbox.reset();
          showPath(r && r.path);
          main.querySelector('#inbox-reset').hidden = true;
          ui.toast('Back to the default Hub Inbox');
        };
      }
      main.querySelector('#srv-change').onclick = async () => {
        const ok = await ui.confirm({ title: 'Change server?', confirm: 'Change server',
          lead: 'The tool goes back to its start screen to find or type another server. You’ll need to sign in there.' });
        if (ok) root.atticDesktop.server.change();
      };
      // Phase 3, 3-2: this PC's own preferences, kept by the tool, not the account.
      if (root.atticDesktop.prefs) {
        const start = main.querySelector('#pc-start'), note = main.querySelector('#pc-notify');
        const noteT = main.querySelector('#pc-notify-transfers'), noteD = main.querySelector('#pc-notify-devices');
        const explorerBox = main.querySelector('#pc-explorer');
        const startHint = main.querySelector('#pc-start-hint'), startText = startHint.textContent;
        const devOnly = ' (The installed Attic Hub only: this is a development copy.)';
        const explorerHint = main.querySelector('#pc-explorer-hint'), explorerText = explorerHint.textContent;
        const show = p => {
          if (!p) return;
          start.checked = p.startWithWindows;
          start.disabled = !p.canStartWithWindows;
          note.checked = p.notifyReceived;
          noteT.checked = p.notifyTransfers;
          noteD.checked = p.notifyDevices;
          explorerBox.checked = p.explorerMenu;
          explorerBox.disabled = !p.canStartWithWindows; // the same rule: the installed app only
          main.querySelector('#inbox-reset').hidden = p.inboxDefault;
          startHint.textContent = (p.mode === 'server' ? 'The server already starts with Windows as a service. This only puts Attic Hub’s window in the tray at sign-in.' : startText)
            + (p.canStartWithWindows ? '' : devOnly);
          explorerHint.textContent = explorerText + (p.canStartWithWindows ? '' : devOnly);
          main.querySelector('#h-pc').dataset.loaded = '1';
        };
        root.atticDesktop.prefs.get().then(show).catch(() => {});
        start.onchange = async () => { show(await root.atticDesktop.prefs.set({ startWithWindows: start.checked })); ui.toast(start.checked ? 'Attic Hub starts with Windows' : 'Attic Hub no longer starts with Windows'); };
        note.onchange = async () => { show(await root.atticDesktop.prefs.set({ notifyReceived: note.checked })); ui.toast(note.checked ? 'You’ll be notified when files arrive' : 'No notifications for received files'); };
        noteT.onchange = async () => { show(await root.atticDesktop.prefs.set({ notifyTransfers: noteT.checked })); ui.toast(noteT.checked ? 'You’ll hear how files you send get on' : 'No notifications for files you send'); };
        noteD.onchange = async () => { show(await root.atticDesktop.prefs.set({ notifyDevices: noteD.checked })); ui.toast(noteD.checked ? 'You’ll hear when devices go and come back' : 'No notifications about devices'); };
        // 3-4: low-resource mode's choice, and whether it's on right now (live, as games start and stop).
        const lowNow = main.querySelector('#pc-low-now');
        const LOW_WHY = { steam: 'a Steam game is running', fullscreen: 'a full-screen app is in front' };
        const showLow = l => {
          if (!lowNow.isConnected) return root.removeEventListener('attic:low-state', onLow);
          if (!l) return;
          main.querySelectorAll('[data-low]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.low === l.pref)));
          let text;
          if (l.detect === 'unavailable' && l.pref === 'auto') text = l.problem || 'Attic Hub can’t tell when a game runs on this PC. Choose Always on instead.';
          else if (l.active && l.reason === 'on') text = 'On now.';
          else if (l.active) text = `On now: ${LOW_WHY[l.reason] || 'a game is running'}${l.app ? ` (${l.app})` : ''}.`;
          else text = l.pref === 'off' ? '' : 'Off now: no game is running.';
          lowNow.textContent = text;
          lowNow.dataset.active = l.active ? '1' : '0';
        };
        const onLow = ev => showLow(ev.detail); // ui.js passes the tool's updates on as this event
        if (root.atticDesktop.lowResource) {
          root.atticDesktop.lowResource.get().then(showLow).catch(() => {});
          root.addEventListener('attic:low-state', onLow);
          main.querySelectorAll('[data-low]').forEach(b => b.onclick = async () => {
            await root.atticDesktop.prefs.set({ lowResource: b.dataset.low });
            showLow(await root.atticDesktop.lowResource.get());
            ui.toast({ auto: 'Low-resource mode turns on while a game runs', on: 'Low-resource mode is on', off: 'Low-resource mode is off' }[b.dataset.low]);
          });
        }
        explorerBox.onchange = async () => { show(await root.atticDesktop.prefs.set({ explorerMenu: explorerBox.checked })); ui.toast(explorerBox.checked ? '“Send to Attic Hub” is in File Explorer' : '“Send to Attic Hub” is gone from File Explorer'); };
      }
    }

    // Feedback round 1: your email (where reset links go).
    const emailIn = main.querySelector('#email');
    const saveEmail = async () => {
      const v = emailIn.value.trim();
      if (v === (state.account.email || '')) return;
      if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return ui.toast('That doesn’t look like an email address', 'error');
      try { state.account = await api.updateEmail(acc.id, v); ui.toast(v ? 'Email saved' : 'Email removed'); }
      catch (e) { ui.toast(e.message, 'error'); emailIn.value = state.account.email || ''; }
    };
    emailIn.onblur = saveEmail;
    emailIn.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); emailIn.blur(); } };

    // Master: the Gmail address the HP sends reset links from, with a Google app password.
    const mailRow = main.querySelector('#mail-row');
    if (mailRow) {
      const st = mailRow.querySelector('#mail-state'), ctl = mailRow.querySelector('#mail-ctl');
      const drawMail = m => {
        if (!m || !m.configured) {
          st.innerHTML = 'Off. Set up a Gmail address and Attic emails a reset link to anyone who forgets their password. It needs a Google <b>app password</b>: Google Account → Security → 2-Step Verification → App passwords.';
          ctl.innerHTML = `<button class="btn btn-secondary btn-sm" id="mail-set">${U.icon('mail')}Set up Gmail</button>`;
        } else {
          st.innerHTML = `On: reset links come from <b>${U.esc(m.user)}</b>.`;
          ctl.innerHTML = `<button class="btn btn-secondary btn-sm" id="mail-test">${U.icon('mail')}Send a test</button><button class="btn btn-ghost btn-sm" id="mail-set">Change</button><button class="btn btn-ghost btn-sm" id="mail-off">Turn off</button>`;
        }
        const set = ctl.querySelector('#mail-set'), test = ctl.querySelector('#mail-test'), off = ctl.querySelector('#mail-off');
        if (set) set.onclick = () => mailDialog(m, drawMail);
        if (test) test.onclick = async () => {
          test.disabled = true;
          try { const r = await api.testMail(); ui.toast(`Test email sent to ${r.to}`); } catch (e) { ui.toast(e.message, 'error'); }
          test.disabled = false;
        };
        if (off) off.onclick = async () => {
          if (!(await ui.confirm({ title: 'Turn off reset emails?', confirm: 'Turn off', lead: 'The HP forgets the Gmail address and its app password. You can still set anyone’s password from the Dashboard.' }))) return;
          try { drawMail(await api.removeMail()); ui.toast('Reset emails are off'); } catch (e) { ui.toast(e.message, 'error'); }
        };
      };
      api.getMail().then(drawMail).catch(e => { st.textContent = e.message; });
    }

    const dname = main.querySelector('#dname');
    const saveName = async () => {
      const v = dname.value.trim();
      if (!v) { dname.value = state.account.displayName; return ui.toast('Display name can’t be empty', 'error'); }
      if (v === state.account.displayName) return;
      try { state.account = await api.updateDisplayName(acc.id, v); ui.toast('Display name saved'); ctx.refreshShell(); }
      catch (e) { ui.toast(e.message, 'error'); }
    };
    dname.onblur = saveName;
    dname.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); dname.blur(); } };
    main.querySelector('#signout').onclick = () => ctx.signOut();
    main.querySelector('#chpass').onclick = () => changePassword(acc);

    // Phase 3, 3-5: this PC's updates from the HP.
    const updRow = main.querySelector('#upd-row');
    if (updRow) {
      const D = root.atticDesktop.updates, status = main.querySelector('#upd-status');
      const checkBtn = main.querySelector('#upd-check'), installBtn = main.querySelector('#upd-install');
      const pct = u => u.latest && u.latest.size ? Math.floor(100 * u.done / u.latest.size) : 0;
      const showUpd = u => {
        if (!u || !status.isConnected) return;
        const v = u.latest && u.latest.version;
        const text = {
          idle: '', checking: 'Checking the HP…',
          current: v ? `Up to date: ${U.esc(u.current)} is the newest version.` : 'Up to date.',
          available: `${U.esc(v || '')} is available.`,
          downloading: `Downloading ${U.esc(v || '')} from the HP… ${pct(u)}%`,
          waiting: `${U.esc(v || '')} is available. It downloads once the game ends (low-resource mode).`,
          ready: `${U.esc(v || '')} is ready. It installs itself the next time Attic Hub starts or quits.${u.latest && u.latest.notes ? ` What’s new: ${U.esc(u.latest.notes)}` : ''}${u.canInstall ? '' : ' (The installed Attic Hub only: this is a development copy.)'}`,
          error: U.esc(u.error || 'Something went wrong.')
        }[u.status] || '';
        status.innerHTML = text;
        status.dataset.status = u.status;
        installBtn.hidden = !(u.status === 'ready' && u.canInstall);
        if (v) installBtn.textContent = `Restart to update to ${v}`;
        checkBtn.disabled = u.status === 'checking' || u.status === 'downloading';
      };
      D.get().then(showUpd).catch(() => {});
      D.onChange(showUpd);
      checkBtn.onclick = async () => showUpd(await D.check());
      installBtn.onclick = async () => {
        const ok = await ui.confirm({ title: 'Restart to update?', confirm: 'Restart and update',
          lead: 'Attic Hub closes, installs the new version, and opens again in a moment. Transfers in progress pick up where they left off.' });
        if (!ok) return;
        const r = await D.install();
        if (r && r.error) ui.toast(r.error, 'error');
        else ui.toast('Updating… Attic Hub opens again in a moment');
      };
      if (ui.wantUpdates) { ui.wantUpdates = false; updRow.scrollIntoView({ block: 'center' }); } // from the notification
    }

    if (master) {
      // Phase 5, 5-1: People Portfolio's save folder, its page addresses, and its key.
      const pp = { share: main.querySelector('#pp-share'), path: main.querySelector('#pp-path'), origins: main.querySelector('#pp-origins'), keyState: main.querySelector('#pp-key-state') };
      const secure = location.protocol === 'https:' ? location.host : null;
      api.getTls().then(t => { const el = main.querySelector('#pp-address'); if (el) el.textContent = secure ? `https://${secure}` : `https://${location.hostname}:${(t && t.httpsPort) || 8443}`; });
      const showPP = s => {
        if (!s || !pp.share.isConnected) return;
        if (s.folder) { pp.share.value = s.folder.shareId; pp.path.value = s.folder.path; }
        pp.origins.value = (s.origins || []).join('\n');
        pp.keyState.textContent = s.hasKey ? `A key is set (made ${U.absDate(s.keyCreatedAt, true)}). Making a new one stops the old one.` : 'No key yet. Make one, then paste it into People Portfolio.';
        main.querySelector('#pp-key').textContent = s.hasKey ? 'Make a new key' : 'Make a key';
        main.querySelector('#pp-card').dataset.loaded = '1';
      };
      Promise.all([api.listShares(), api.getPeopleSettings()]).then(([shares, s]) => {
        pp.share.innerHTML = shares.map(x => `<option value="${U.esc(x.id)}">${U.esc(x.name)}</option>`).join('');
        showPP(s);
      }).catch(e => { pp.keyState.textContent = e.message; });
      main.querySelector('#pp-save-folder').onclick = async () => {
        try { showPP(await api.setPeopleSettings({ folder: { shareId: pp.share.value, path: pp.path.value.trim() } })); ui.toast('Save folder set'); }
        catch (e) { ui.toast(e.code === 'NOT_FOUND' ? 'That folder doesn’t exist in this shared folder. Create it in Files first.' : e.message, 'error'); }
      };
      main.querySelector('#pp-save-origins').onclick = async () => {
        try { showPP(await api.setPeopleSettings({ origins: pp.origins.value.split(/\s+/).filter(Boolean) })); ui.toast('Address saved'); }
        catch (e) { ui.toast(e.message, 'error'); }
      };
      main.querySelector('#pp-key').onclick = async () => {
        const had = pp.keyState.textContent.startsWith('A key is set');
        if (had && !(await ui.confirm({ title: 'Make a new key?', confirm: 'Make a new key', lead: 'The old key stops working at once. Paste the new one into People Portfolio afterwards.' }))) return;
        try {
          const r = await api.newPeopleKey();
          ui.dialog({ title: 'People Portfolio’s key', lead: 'Copy it now and paste it into People Portfolio (⋮ → Attic). It isn’t shown again.',
            body: `<input class="plain-input mono" id="pp-key-value" readonly value="${U.esc(r.key)}" style="width:100%">`,
            actions: [
              { label: 'Close', kind: 'secondary' },
              { label: 'Copy', kind: 'primary', onClick: async (close, dlg) => { const i = dlg.querySelector('#pp-key-value'); i.select(); try { await navigator.clipboard.writeText(i.value); ui.toast('Key copied'); } catch (e) { document.execCommand('copy'); } } }
            ] });
          showPP(await api.getPeopleSettings());
        } catch (e) { ui.toast(e.message, 'error'); }
      };

      // Phase 3, 3-5: publish an installer to the HP; the HP offers it to every device.
      const kept = main.querySelector('#upd-kept'), keptRow = main.querySelector('#upd-kept-row');
      const drawKept = async () => {
        try {
          const list = await api.listUpdates();
          keptRow.hidden = !list.length;
          kept.innerHTML = list.map(r => `<li><span class="mono">${U.esc(r.version)}</span> · ${U.formatBytes(r.size)} · ${U.esc(U.relDate(r.releaseDate))}${r.notes ? ` · ${U.esc(r.notes)}` : ''}</li>`).join('');
        } catch (e) { keptRow.hidden = true; }
      };
      drawKept();
      const pick = main.querySelector('#upd-file');
      main.querySelector('#upd-publish').onclick = () => pick.click();
      pick.onchange = async () => {
        const file = pick.files[0];
        pick.value = '';
        if (!file) return;
        if (!/^Attic-Hub-Setup-\d+\.\d+\.\d+\.exe$/.test(file.name)) return ui.toast('Choose the installer as the build names it: Attic-Hub-Setup-<version>.exe', 'error');
        const notes = await new Promise(resolve => ui.dialog({
          title: `Publish ${file.name}?`, lead: `${U.formatBytes(file.size)}. The HP checks it’s a newer Attic Hub, then offers it to every device.`,
          body: '<label class="form-grid"><span>What’s new (optional)</span><input class="plain-input" id="upd-notes" maxlength="500" autocomplete="off"></label>',
          actions: [
            { label: 'Cancel', kind: 'secondary', onClick: c => { c(); resolve(null); } },
            { label: 'Publish', kind: 'primary', onClick: (c, dlg) => { const v = dlg.querySelector('#upd-notes').value; c(); resolve(v); } }
          ]
        }));
        if (notes === null) return;
        const btn = main.querySelector('#upd-publish'), label = btn.innerHTML;
        btn.disabled = true;
        const job = api.publishUpdate(file, { notes: notes.trim(), onProgress: (done, size) => { btn.textContent = `Publishing… ${Math.floor(100 * done / size)}%`; } });
        try { const r = await job.promise; ui.toast(`Attic Hub ${r.version} is on the HP. Devices will offer it now.`); drawKept(); }
        catch (e) { ui.toast(e.message, 'error'); }
        finally { btn.disabled = false; btn.innerHTML = label; }
      };
      drawShares();
      main.querySelector('#add-share').onclick = () => shareDialog(null, drawShares);
      main.querySelector('#export').onclick = async () => {
        const data = await api.exportSettings();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        a.download = 'attic-settings.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        ui.toast('Settings exported');
      };
      const file = main.querySelector('#import-file');
      main.querySelector('#import').onclick = () => file.click();
      file.onchange = async () => {
        const f = file.files[0];
        file.value = '';
        if (!f) return;
        try {
          const data = JSON.parse(await f.text());
          const ok = await ui.confirm({ title: 'Import settings?', lead: `This replaces this browser’s theme, background and view preferences with the ones in <b>${U.esc(f.name)}</b>. Shares, accounts and files aren’t touched.`, confirm: 'Import' });
          if (!ok) return;
          await api.importSettings(data);
          state.settings = await api.getSettings();
          ui.applyTheme(state.settings.theme);
          ui.toast('Settings imported');
          render(ctx);
        } catch (e) { ui.toast(e instanceof SyntaxError ? 'That file isn’t valid JSON.' : e.message, 'error'); }
      };
      main.querySelector('#clear').onclick = async () => {
        const ok = await ui.confirm({
          title: 'Clear all local data?', danger: true, confirm: 'Clear everything',
          lead: 'Everything Attic keeps in this browser will be deleted:',
          body: `<ul><li>Your session — you’ll be signed out</li><li>Theme, view and background settings</li><li>All custom background images you added</li></ul>
            <p class="muted" style="font-size:13px;margin:8px 0 0">Accounts, shares and files are kept on the server and aren’t affected. This can’t be undone.</p>`
        });
        if (!ok) return;
        await api.clearAllData();
        ctx.reset();
      };
    }
    // Phase 4, 4-1: this phone's connection. Over http, the one-time steps to trust the HP's own
    // certificate, then the secure address.
    const secure = location.protocol === 'https:';
    const ixLead = main.querySelector('#ix-lead');
    if (ixLead) ixLead.textContent = secure ? 'The connection is encrypted with the HP’s own certificate.' : 'This connection isn’t encrypted, so use Attic on your home Wi-Fi only.';
    if (main.querySelector('#h-phone')) {
      const out = main.querySelector('#ph-secure'), ctl = main.querySelector('#ph-secure-ctl');
      api.getTls().then(tls => {
        if (!out.isConnected) return;
        const fp = tls && tls.caFingerprint ? `<span class="mono fp">${U.esc(tls.caFingerprint)}</span>` : '';
        if (secure) { out.innerHTML = `On. Attic is encrypted with the HP’s own certificate${fp ? `, from the certificate authority with fingerprint ${fp}` : ''}.`; return; }
        if (!tls || !tls.httpsPort) { out.textContent = 'The HP doesn’t offer a secure address yet, so use Attic on your home Wi-Fi only.'; return; }
        const url = api.secureUrl(tls);
        out.innerHTML = 'Off: this address isn’t encrypted. The HP has a secure one; trust the HP once, then use it.';
        ctl.innerHTML = `<a class="btn btn-primary btn-sm" id="ph-go" href="${U.esc(url)}">Open the secure address</a>`;
        main.querySelector('#ph-steps-row').hidden = false;
        main.querySelector('#ph-steps').innerHTML = ui.secureSteps(tls);
      });
    }
    api.indexInfo().then(i => { const el = main.querySelector('#ix'); if (el) el.textContent = `${U.formatCount(i.entries)} files you can see, drives last read ${U.absDate(i.generatedAt, true)}.`; }).catch(() => {});

    async function drawShares() {
      const box = main.querySelector('#shares');
      let list;
      try { list = await api.listShares(); }
      catch (e) { box.innerHTML = ui.errorState(e, 'retry-sh'); box.querySelector('#retry-sh').onclick = drawShares; return; }
      box.innerHTML = list.length ? list.map(x => `<div class="share-cfg">
          <span style="color:var(--muted)">${U.shareIcon(x.deviceType)}</span>
          <span style="min-width:0"><b>${U.esc(x.name)}</b>${x.available ? '' : ` <span class="tag">${U.icon('cloudOff')}Unavailable</span>`}</span>
          <span class="mono hide-sm" style="min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--muted)">${U.esc(x.rootPath)}</span>
          <span style="display:flex;gap:6px"><button class="btn btn-ghost btn-sm" data-edit="${x.id}">Edit</button><button class="btn btn-ghost btn-sm" data-del="${x.id}" aria-label="Remove ${U.esc(x.name)}">${U.icon('trash')}</button></span>
        </div>`).join('') : ui.empty({ icon: 'database', title: 'No shares', text: 'Add a share to make a drive’s folder browsable.' });
      box.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => shareDialog(list.find(x => x.id === b.dataset.edit), drawShares));
      box.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        const x = list.find(y => y.id === b.dataset.del);
        const ok = await ui.confirm({ title: `Remove ${x.name}?`, lead: `Attic will stop serving <span class="mono">${U.esc(x.rootPath)}</span>. Nothing on the drive is deleted.`, confirm: 'Remove share', danger: true });
        if (!ok) return;
        try { await api.removeShare(x.id); ui.toast(`${x.name} removed`); drawShares(); } catch (e) { ui.toast(e.message, 'error'); }
      });
    }
  }

  function shareDialog(share, after) {
    const f = (id, label, value) => `<div class="field no-icon"><input id="${id}" placeholder=" " value="${U.esc(value || '')}" autocomplete="off"><label for="${id}">${label}</label><div class="field-msg" id="${id}-msg"></div></div>`;
    ui.dialog({
      title: share ? `Edit ${share.name}` : 'Add share',
      body: `<div class="form-grid">${f('sh-name', 'Name', share && share.name)}${f('sh-path', 'Path on the server (e.g. D:\\Shared)', share && share.rootPath)}
        <div class="field no-icon"><select id="sh-type">${[['ssd', 'SSD'], ['hdd', 'Internal drive'], ['external', 'External drive']].map(([v, l]) => `<option value="${v}" ${share && share.deviceType === v ? 'selected' : ''}>${l}</option>`).join('')}</select><label for="sh-type">Drive type</label><div class="field-msg"></div></div></div>`,
      actions: [{ label: 'Cancel' }, { label: share ? 'Save' : 'Add share', kind: 'primary', onClick: async (close, dlg) => {
        const name = dlg.querySelector('#sh-name').value.trim(), path = dlg.querySelector('#sh-path').value.trim();
        dlg.querySelector('#sh-name-msg').textContent = name ? '' : 'Enter a name';
        dlg.querySelector('#sh-path-msg').textContent = path ? '' : 'Enter a path';
        if (!name || !path) return;
        try {
          const s = await api.saveShare({ id: share && share.id, name, rootPath: path, deviceType: dlg.querySelector('#sh-type').value });
          close();
          ui.toast(share ? 'Share saved' : s && !s.available ? `${name} added. The folder doesn’t exist yet, so it shows as unavailable.` : 'Share added');
          after();
        } catch (e) { (e.code === 'INVALID' && /name/i.test(e.message) ? dlg.querySelector('#sh-name-msg') : dlg.querySelector('#sh-path-msg')).textContent = e.message; }
      } }]
    });
  }

  // The HP signs in to Gmail with the app password before keeping it; it's never shown again.
  function mailDialog(m, after) {
    ui.dialog({
      title: 'Email for password resets',
      lead: 'Attic sends reset links from this Gmail address. Use an app password, not your Google password: Google Account → Security → 2-Step Verification → App passwords. It’s kept only on the HP.',
      body: `<form class="form-grid" novalidate>
        <div class="field no-icon"><input id="ml-user" type="email" placeholder=" " autocomplete="email" autocapitalize="none" spellcheck="false" value="${U.esc((m && m.user) || '')}"><label for="ml-user">Gmail address</label></div>
        <div class="field no-icon"><input id="ml-pass" type="password" placeholder=" " autocomplete="off"><label for="ml-pass">App password (16 letters)</label></div>
        <div class="form-error" id="ml-err" role="alert"></div></form>`,
      actions: [
        { label: 'Cancel', kind: 'secondary' },
        { label: 'Check and save', kind: 'primary', onClick: async (close, dlg) => {
          const user = dlg.querySelector('#ml-user').value.trim(), pass = dlg.querySelector('#ml-pass').value, err = dlg.querySelector('#ml-err');
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(user)) { err.textContent = 'Enter the Gmail address to send from'; return; }
          if (pass.replace(/\s/g, '').length < 8) { err.textContent = 'Paste the app password Google gave you'; return; }
          err.textContent = 'Checking with Gmail…';
          try { const r = await api.setMail(user, pass); close(); after(r); ui.toast('Reset emails are on'); }
          catch (e) { err.textContent = e.message; }
        } }
      ]
    });
  }

  function changePassword(acc) {
    const f = (id, label) => `<div class="field no-icon"><input id="${id}" type="password" placeholder=" " autocomplete="off"><label for="${id}">${label}</label><div class="field-msg" id="${id}-msg"></div></div>`;
    ui.dialog({
      title: 'Change password',
      body: `<div class="form-grid">${f('cp-cur', 'Current password')}${f('cp-new', 'New password')}${f('cp-new2', 'Confirm new password')}</div>
        <p class="form-note" style="margin-top:4px">${U.icon('info')}<span>At least 6 characters. Your other signed-in devices are signed out when it changes.</span></p>`,
      actions: [{ label: 'Cancel' }, { label: 'Change password', kind: 'primary', onClick: async (close, dlg) => {
        const v = id => dlg.querySelector('#' + id).value;
        const set = (id, m) => dlg.querySelector(`#${id}-msg`).textContent = m;
        set('cp-cur', v('cp-cur') ? '' : 'Enter your current password');
        set('cp-new', v('cp-new').length >= 6 ? '' : 'Use at least 6 characters');
        set('cp-new2', v('cp-new2') === v('cp-new') ? '' : 'Passwords don’t match');
        if (!v('cp-cur') || v('cp-new').length < 6 || v('cp-new2') !== v('cp-new')) return;
        try { await api.changePassword(acc.id, v('cp-cur'), v('cp-new')); close(); ui.toast('Password changed'); }
        catch (e) { set('cp-cur', e.message); }
      } }]
    });
  }

  root.Attic.settings = { render };
})(window);
