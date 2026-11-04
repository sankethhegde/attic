// Send to a device (Phase 2, 2-4, D-05 and D-07): choose what to send and which device gets it. A file
// sent to a device lands in that device's Hub Inbox; one sent to an offline device waits and goes when it
// comes online. Opened from a device card (files and folders from this device) and from a file's details
// in Files (a file on the HP). The send itself is api.sendToDevice, a sample until the HP's transfer
// endpoints exist.
(function (root) {
  'use strict';
  const { util: U, api, ui } = root.Attic;

  // opts: { to: deviceId to preselect, file: a Files entry on the HP (else local files are chosen here), onSent }
  async function open(opts) {
    opts = opts || {};
    let devices;
    try { devices = await api.listHubDevices(); }
    catch (e) { ui.toast(e.message, 'error'); return; }
    const me = devices.find(d => d.thisPC) || null;
    const targets = devices.filter(d => !d.thisPC);
    let items = opts.file ? [{ name: opts.file.name, size: opts.file.size, onHP: true }] : [];
    let to = targets.find(d => d.id === opts.to) || null;
    const preset = to;

    const d = ui.dialog({
      title: preset ? `Send to ${preset.name}` : 'Send to a device',
      lead: 'It lands in that device’s Hub Inbox, private to whoever is signed in there. An offline device gets it when it next comes online.',
      wide: true,
      body: `<div class="send">
        ${api.sendIsSample ? `<div class="banner banner-info">${U.icon('info')}<span>Sample for now: the HP doesn’t accept transfers yet, so this adds a sample to the Transfers tab. Nothing is sent.</span></div>` : ''}
        <h3 class="send-h">What</h3>
        <div id="sd-what"></div>
        ${opts.file ? '' : `<div class="send-pick">
          <button type="button" class="btn btn-secondary btn-sm" id="sd-files">${U.icon('file')}Choose files</button>
          <button type="button" class="btn btn-secondary btn-sm" id="sd-folder">${U.icon('folder')}Choose a folder</button>
          <input type="file" id="sd-in-files" multiple hidden>
          <input type="file" id="sd-in-folder" webkitdirectory hidden>
        </div>`}
        <h3 class="send-h">To</h3>
        <div class="send-to" role="radiogroup" aria-label="Device to send to" id="sd-to"></div>
        <div class="form-error" id="sd-error" role="alert"></div>
      </div>`,
      actions: [
        { label: 'Cancel', kind: 'secondary' },
        { label: 'Send', kind: 'primary', onClick: (close) => send(close) }
      ]
    });
    const el = d.el;
    const sendBtn = el.querySelector('.dialog-actions [data-i="1"]');

    function drawWhat() {
      const box = el.querySelector('#sd-what');
      if (!items.length) { box.innerHTML = `<p class="send-empty">Nothing chosen yet.</p>`; return refresh(); }
      const total = items.reduce((a, x) => a + x.size, 0);
      box.innerHTML = `<ul class="send-items">${items.map((x, i) => `<li>
          <span class="send-ic">${x.count ? U.icon('folder') : U.fileIcon({ kind: 'file', category: U.classify(x.name) })}</span>
          <span class="send-nm">${U.nameHTML(x.name)}<span class="c">${x.onHP ? 'On the HP · ' : ''}${x.count ? `${U.formatCount(x.count)} file${x.count === 1 ? '' : 's'} · ` : ''}<span class="mono">${U.formatBytes(x.size)}</span></span></span>
          ${x.onHP ? '' : `<button type="button" class="icon-btn" data-rm="${i}" aria-label="Remove ${U.esc(x.name)}">${U.icon('x')}</button>`}
        </li>`).join('')}</ul>
        ${items.length > 1 ? `<p class="send-total">${items.length} items · <span class="mono">${U.formatBytes(total)}</span></p>` : ''}`;
      box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { items.splice(Number(b.dataset.rm), 1); drawWhat(); });
      refresh();
    }

    function drawTo() {
      const box = el.querySelector('#sd-to');
      if (!targets.length) { box.innerHTML = `<p class="send-empty">No other devices are paired yet. The master pairs them from the Devices tab.</p>`; return refresh(); }
      box.innerHTML = targets.map(t => `<button type="button" class="send-dev${to && to.id === t.id ? ' on' : ''}" role="radio" aria-checked="${!!(to && to.id === t.id)}" data-id="${U.esc(t.id)}">
          <span class="send-art">${root.Attic.device.art(t.kind, 40)}</span>
          <span class="send-dn"><b>${U.esc(t.name)}</b><span class="c"><span class="dot ${t.online ? 'on' : ''}" aria-hidden="true"></span>${t.online ? 'Online' : 'Offline · it gets this when it comes online'}</span></span>
          ${t.role === 'server' ? `<span class="tag">${U.icon('database')}Server</span>` : ''}
        </button>`).join('');
      box.querySelectorAll('[data-id]').forEach(b => b.onclick = () => { to = targets.find(t => t.id === b.dataset.id); drawTo(); box.querySelector(`[data-id="${CSS.escape(to.id)}"]`).focus(); });
      refresh();
    }

    function refresh() {
      sendBtn.disabled = !items.length || !to;
      sendBtn.textContent = to ? (to.online ? `Send to ${to.name}` : `Queue for ${to.name}`) : 'Send';
    }

    // Local files: one item per file; a folder becomes one item with its file count and total size.
    if (!opts.file) {
      const inFiles = el.querySelector('#sd-in-files'), inFolder = el.querySelector('#sd-in-folder');
      el.querySelector('#sd-files').onclick = () => inFiles.click();
      el.querySelector('#sd-folder').onclick = () => inFolder.click();
      inFiles.onchange = () => {
        for (const f of inFiles.files) items.push({ name: f.name, size: f.size, file: f });
        inFiles.value = '';
        drawWhat();
      };
      inFolder.onchange = () => {
        const groups = new Map();
        for (const f of inFolder.files) {
          const top = (f.webkitRelativePath || f.name).split('/')[0];
          const g = groups.get(top) || { name: top, size: 0, count: 0, files: [] };
          g.size += f.size; g.count++; g.files.push(f);
          groups.set(top, g);
        }
        inFolder.value = '';
        if (!groups.size) { el.querySelector('#sd-error').textContent = 'That folder is empty.'; return; }
        groups.forEach(g => items.push(g));
        drawWhat();
      };
    }

    async function send(close) {
      if (!items.length || !to) return;
      el.querySelector('#sd-error').textContent = '';
      sendBtn.disabled = true;
      try {
        const made = await api.sendToDevice({ items: items.map(x => ({ name: x.name, size: x.size, count: x.count })), from: me, to });
        close();
        const what = made.length === 1 ? made[0].fileName : `${made.length} items`;
        ui.toast(to.online ? `Sending ${what} to ${to.name}` : `${what} will go to ${to.name} when it comes online`);
        if (opts.onSent) opts.onSent(made);
      } catch (e) {
        refresh();
        el.querySelector('#sd-error').innerHTML = U.icon('alertCircle') + `<span>${U.esc(e.message)}</span>`;
      }
    }

    drawWhat();
    drawTo();
    (el.querySelector('#sd-files') || el.querySelector('.send-dev')) && (el.querySelector('#sd-files') || el.querySelector('.send-dev')).focus();
  }

  root.Attic.send = { open };
})(window);
