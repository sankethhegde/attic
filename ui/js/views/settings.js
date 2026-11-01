// Settings: one scrolling page of grouped sections. Changes apply immediately — no save button.
(function (root) {
  'use strict';
  const { util: U, api, ui, background } = root.Attic;

  const VERSION = '0.2.0 · Phase 1B';
  const HUB_REQUIREMENTS_URL = 'https://claude.ai/artifact/PAvQYsCeT2cKm1oApbtzJv';
  const REQUIREMENTS_URL = 'https://claude.ai/artifact/VryAcjg2CZieJSu6gUu3tJ';

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
        <div class="set-row" style="display:block"><div class="lbl" style="margin-bottom:10px">This device<small>Detected automatically. Correct it if the guess is wrong — it’s remembered in this browser.</small></div><div id="this-device"></div></div>
        <div class="set-row"><div class="lbl">Password</div><div class="ctl"><button class="btn btn-secondary btn-sm" id="chpass">${U.icon('lock')}Change password</button></div></div>
        <div class="set-row"><div class="lbl">Sign out<small>${state.session.persistent ? 'You’re set to stay signed in on this browser for 30 days.' : 'Your session ends when this tab closes.'}</small></div>
          <div class="ctl"><button class="btn btn-secondary btn-sm" id="signout">${U.icon('logout')}Sign out</button></div></div>
      </section>

      ${master ? `
      <section class="card" aria-labelledby="h-sh">
        <div class="card-head" style="margin-bottom:4px"><h2 id="h-sh">Shares <span class="scope">Master</span></h2><span class="grow"></span><button class="btn btn-secondary btn-sm" id="add-share">${U.icon('plus')}Add share</button></div>
        <p class="muted" style="font-size:13px;margin:0 0 6px">Edits change mock configuration only. In Phase 1B they write the server’s config.</p>
        <div id="shares"><div class="skel" style="height:120px"></div></div>
      </section>

      <section class="card" aria-labelledby="h-dev">
        <h2 id="h-dev">Devices <span class="scope">Master</span></h2>
        <div class="set-row"><div class="lbl">Registered devices<small>Add, revoke and remove device accounts in one place.</small></div>
          <div class="ctl"><a class="btn btn-secondary btn-sm" href="#/dashboard">Open device list${U.icon('chevronRight')}</a></div></div>
      </section>

      <section class="card" aria-labelledby="h-adv">
        <h2 id="h-adv">Advanced <span class="scope">Master</span></h2>
        <div class="set-row"><div class="lbl">Export settings<small>Theme, backgrounds, view preferences and shares, as JSON.</small></div>
          <div class="ctl"><button class="btn btn-secondary btn-sm" id="export">${U.icon('download')}Export JSON</button></div></div>
        <div class="set-row"><div class="lbl">Import settings<small>Replaces current settings and shares with the file’s.</small></div>
          <div class="ctl"><button class="btn btn-secondary btn-sm" id="import">${U.icon('upload')}Import JSON</button><input type="file" id="import-file" accept="application/json,.json" hidden></div></div>
        <div class="set-row"><div class="lbl">Simulate failures<small>Makes 10% of data requests fail, to test error states.</small></div>
          <div class="ctl"><label class="check"><input type="checkbox" id="fail" ${s.dev.failRate ? 'checked' : ''}> On</label></div></div>
        <div class="set-row"><div class="lbl">External backup unplugged<small>Shows the unavailable-share state everywhere.</small></div>
          <div class="ctl"><label class="check"><input type="checkbox" id="unplug"> Unplugged</label></div></div>
        <div class="set-row"><div class="lbl" style="color:var(--danger)">Clear local data<small>Returns Attic to first-run setup.</small></div>
          <div class="ctl"><button class="btn btn-danger btn-sm" id="clear">${U.icon('trash')}Clear local data</button></div></div>
      </section>` : ''}

      <section class="card" aria-labelledby="h-about">
        <h2 id="h-about">About</h2>
        <div class="set-row"><div class="lbl">Version</div><div class="ctl mono">${VERSION}</div></div>
        <div class="set-row"><div class="lbl">Running in</div><div class="ctl">${root.atticDesktop ? `Attic Hub desktop tool${root.atticDesktop.version ? ` <span class="mono">${U.esc(root.atticDesktop.version)}</span>` : ''}` : 'A web browser'}</div></div>
        <div class="set-row" style="display:block"><div class="banner banner-info" style="margin:0">${U.icon('info')}<span>This is Phase 1B, still on mock data. No real files are read, stored or uploaded, devices and transfers are simulated, and the sign-in is <b>not secure</b>. <span id="ix"></span></span></div></div>
        <div class="set-row"><div class="lbl">Requirements</div><div class="ctl" style="flex-direction:column;align-items:flex-end;gap:4px">
          <a href="${HUB_REQUIREMENTS_URL}" target="_blank" rel="noopener">Attic Hub requirements ${U.icon('chevronRight').replace('class="ic"', 'class="ic" style="width:14px;height:14px;vertical-align:-2px"')}</a>
          <a href="${REQUIREMENTS_URL}" target="_blank" rel="noopener">Phase 1A requirements ${U.icon('chevronRight').replace('class="ic"', 'class="ic" style="width:14px;height:14px;vertical-align:-2px"')}</a></div></div>
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

    if (master) {
      drawShares();
      main.querySelector('#add-share').onclick = () => shareDialog(null, drawShares);
      main.querySelector('#fail').onchange = e => save({ dev: { failRate: e.target.checked ? 0.1 : 0 } }, e.target.checked ? 'Failures on: 10% of requests will fail' : 'Failures off');
      const unplug = main.querySelector('#unplug');
      api.listShares().then(l => { const b = l.find(x => x.id === 'backup'); if (b) unplug.checked = !b.available; else unplug.closest('.set-row').remove(); }).catch(() => {});
      unplug.onchange = async () => {
        try { await api.setShareAvailable('backup', !unplug.checked); ui.toast(unplug.checked ? 'External backup is now unavailable' : 'External backup reconnected'); drawShares(); }
        catch (e) { ui.toast(e.message, 'error'); }
      };
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
          const ok = await ui.confirm({ title: 'Import settings?', lead: `This replaces your current settings and share list with the ones in <b>${U.esc(f.name)}</b>. Accounts and files aren’t touched.`, confirm: 'Import' });
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
          body: `<ul><li>Your session — you’ll be signed out</li><li>Theme, view and background settings</li><li>Share configuration</li><li>The mock file index (it’s regenerated identically)</li><li>All custom background images you added</li></ul>
            <p class="muted" style="font-size:13px;margin:8px 0 0">Accounts are kept on the server and aren’t affected. This can’t be undone.</p>`
        });
        if (!ok) return;
        await api.clearAllData();
        ctx.reset();
      };
    }
    api.indexInfo().then(i => { const el = main.querySelector('#ix'); if (el) el.textContent = `Mock index: ${U.formatCount(i.entries)} entries, generated ${U.absDate(i.generatedAt)}.`; }).catch(() => {});

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
        try { await api.saveShare({ id: share && share.id, name, rootPath: path, deviceType: dlg.querySelector('#sh-type').value }); close(); ui.toast(share ? 'Share saved' : 'Share added'); after(); }
        catch (e) { ui.toast(e.message, 'error'); }
      } }]
    });
  }

  function changePassword(acc) {
    const f = (id, label) => `<div class="field no-icon"><input id="${id}" type="password" placeholder=" " autocomplete="off"><label for="${id}">${label}</label><div class="field-msg" id="${id}-msg"></div></div>`;
    ui.dialog({
      title: 'Change password',
      body: `<div class="form-grid">${f('cp-cur', 'Current password')}${f('cp-new', 'New password')}${f('cp-new2', 'Confirm new password')}</div>
        <p class="mock-note" style="margin-top:4px">${U.icon('info')}<span>Prototype only: passwords are stored in plain text in this browser. Use a placeholder.</span></p>`,
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
