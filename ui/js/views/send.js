// Send to a device (Phase 2, 2-4, D-05 and D-07): choose what to send and which device gets it. The file
// goes to the HP, which holds it until the receiving device's agent collects it into that device's Hub
// Inbox: straight away if it's online, otherwise when it next comes online. Opened from a device card
// (files or a folder from this device) and from a file's details in Files (a file on the HP).
// Phase 3, 3-3: also from File Explorer's "Send to Attic Hub" (files known by their paths, which the
// desktop tool sends) and from files or folders dropped anywhere on the window.
(function (root) {
  'use strict';
  const { util: U, api, ui } = root.Attic;

  // [{ name, size, group, ... }] → the dialog's items: a file each, and a group per folder.
  function groupItems(list) {
    const out = [], groups = new Map();
    for (const f of list) {
      if (!f.group) { out.push({ name: f.name, size: f.size, files: [f] }); continue; }
      let g = groups.get(f.group);
      if (!g) { g = { name: f.group, size: 0, folder: true, files: [] }; groups.set(f.group, g); out.push(g); }
      g.size += f.size;
      g.files.push(f);
    }
    return out;
  }

  // Files dropped on the window: folders are opened up into their files. → [{ file, group }]
  async function droppedFiles(dt) {
    const out = [];
    const entries = [...(dt.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return [...(dt.files || [])].map(file => ({ file, group: null }));
    const fileOf = entry => new Promise((res, rej) => entry.file(res, rej));
    const readAll = reader => new Promise((res, rej) => { const all = []; const next = () => reader.readEntries(b => b.length ? (all.push(...b), next()) : res(all), rej); next(); });
    async function walk(entry, group) {
      if (out.length >= 1000) return;
      if (entry.isFile) out.push({ file: await fileOf(entry), group });
      else if (entry.isDirectory) for (const e of await readAll(entry.createReader())) await walk(e, group || entry.name);
    }
    for (const e of entries) await walk(e, null);
    return out;
  }

  // opts: { to: deviceId to preselect, file: a Files entry on the HP, local: [{ path, name, size, group }]
  //         (from File Explorer), dropped: [{ file, group }] (dropped on the window) }
  async function open(opts) {
    opts = opts || {};
    let devices;
    try { devices = await api.listHubDevices(); }
    catch (e) { ui.toast(e.message, 'error'); return; }
    // Any paired device but this one. The HP doesn't receive transfers: files go onto it through Files.
    const targets = devices.filter(d => !d.thisPC && d.role !== 'server');
    // One entry per file sent. A folder is sent as its files, shown here as one group.
    let items = opts.file ? [{ name: opts.file.name, size: opts.file.size, files: [{ name: opts.file.name, size: opts.file.size, entry: opts.file }], onHP: true }]
      : opts.local ? groupItems(opts.local.map(f => ({ name: f.name, size: f.size, path: f.path, group: f.group })))
      : opts.dropped ? groupItems(opts.dropped.map(x => ({ name: x.file.name, size: x.file.size, source: x.file, group: x.group })))
      : [];
    const pickable = !opts.file && !opts.local; // files from Explorer are sent by path, so nothing else mixes in
    let to = targets.find(d => d.id === opts.to) || null;
    let job = null;
    // Only a device's agent (the desktop tool) collects files, so 'online' alone isn't enough.
    const collects = t => t.online && !t.browserOnly;

    const d = ui.dialog({
      title: to ? `Send to ${to.name}` : 'Send to a device',
      lead: 'It goes to that device’s Hub Inbox, private to whoever is signed in there. An offline device gets it when it next comes online; the HP holds it until then, for up to 14 days.',
      wide: true,
      body: `<div class="send">
        <h3 class="send-h">What</h3>
        <div id="sd-what"></div>
        ${!pickable ? '' : `<div class="send-pick">
          <button type="button" class="btn btn-secondary btn-sm" id="sd-files">${ui.handheld ? `${U.icon('photo')}Choose photos or files` : `${U.icon('file')}Choose files`}</button>
          <button type="button" class="btn btn-secondary btn-sm desktop-only" id="sd-folder">${U.icon('folder')}Choose a folder</button>
          <input type="file" id="sd-in-files" multiple hidden>
          <input type="file" id="sd-in-folder" webkitdirectory hidden>
        </div>`}
        <h3 class="send-h">To</h3>
        <div class="send-to" role="radiogroup" aria-label="Device to send to" id="sd-to"></div>
        <div class="send-progress" id="sd-progress" hidden aria-live="polite"></div>
        <div class="form-error" id="sd-error" role="alert"></div>
      </div>`,
      actions: [
        { label: 'Cancel', kind: 'secondary', onClick: close => { if (job) job.cancel(); close(); } },
        { label: 'Send', kind: 'primary', onClick: close => send(close) }
      ]
    });
    const el = d.el;
    const sendBtn = el.querySelector('.dialog-actions [data-i="1"]');
    // Closing the dialog any other way (Escape, a click outside) also stops a send in progress.
    const obs = new MutationObserver(() => { if (!el.isConnected) { obs.disconnect(); if (job) job.cancel(); } });
    obs.observe(document.body, { childList: true });

    function drawWhat() {
      const box = el.querySelector('#sd-what');
      if (!items.length) { box.innerHTML = `<p class="send-empty">Nothing chosen yet.</p>`; return refresh(); }
      const total = items.reduce((a, x) => a + x.size, 0), count = items.reduce((a, x) => a + x.files.length, 0);
      box.innerHTML = `<ul class="send-items">${items.map((x, i) => `<li>
          <span class="send-ic">${x.folder ? U.icon('folder') : U.fileIcon({ kind: 'file', category: U.classify(x.name) })}</span>
          <span class="send-nm">${U.nameHTML(x.name)}<span class="c">${x.onHP ? 'On the HP · ' : ''}${x.folder ? `${U.formatCount(x.files.length)} file${x.files.length === 1 ? '' : 's'}, sent one by one · ` : ''}<span class="mono">${U.formatBytes(x.size)}</span></span></span>
          ${x.onHP ? '' : `<button type="button" class="icon-btn" data-rm="${i}" aria-label="Remove ${U.esc(x.name)}">${U.icon('x')}</button>`}
        </li>`).join('')}</ul>
        ${count > 1 ? `<p class="send-total">${U.formatCount(count)} files · <span class="mono">${U.formatBytes(total)}</span></p>` : ''}`;
      box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { if (job) return; items.splice(Number(b.dataset.rm), 1); drawWhat(); });
      refresh();
    }

    function drawTo() {
      const box = el.querySelector('#sd-to');
      if (!targets.length) { box.innerHTML = `<p class="send-empty">No other devices are paired yet. The master pairs them from the Devices tab.</p>`; return refresh(); }
      box.innerHTML = targets.map(t => `<button type="button" class="send-dev${to && to.id === t.id ? ' on' : ''}" role="radio" aria-checked="${!!(to && to.id === t.id)}" data-id="${U.esc(t.id)}">
          <span class="send-art">${root.Attic.device.art(t.kind, 40)}</span>
          <span class="send-dn"><b>${U.esc(t.name)}</b><span class="c"><span class="dot ${t.online ? 'on' : ''}" aria-hidden="true"></span>${collects(t) ? 'Online' : t.online ? 'Online, but its Attic Hub tool isn’t running · it gets this when it is' : 'Offline · it gets this when it comes online'}</span></span>
        </button>`).join('');
      box.querySelectorAll('[data-id]').forEach(b => b.onclick = () => {
        if (job) return;
        to = targets.find(t => t.id === b.dataset.id);
        drawTo();
        box.querySelector(`[data-id="${CSS.escape(to.id)}"]`).focus();
      });
      refresh();
    }

    function refresh() {
      sendBtn.disabled = !!job || !items.length || !to;
      if (!job) sendBtn.textContent = to ? (collects(to) ? `Send to ${to.name}` : `Send for ${to.name} to collect`) : 'Send';
    }

    // Local files: each file is its own item; a folder is one item holding its files.
    if (pickable) {
      const inFiles = el.querySelector('#sd-in-files'), inFolder = el.querySelector('#sd-in-folder');
      el.querySelector('#sd-files').onclick = () => inFiles.click();
      el.querySelector('#sd-folder').onclick = () => inFolder.click();
      inFiles.onchange = () => {
        for (const f of inFiles.files) items.push({ name: f.name, size: f.size, files: [{ name: f.name, size: f.size, source: f }] });
        inFiles.value = '';
        drawWhat();
      };
      inFolder.onchange = () => {
        const groups = new Map();
        for (const f of inFolder.files) {
          const top = (f.webkitRelativePath || f.name).split('/')[0];
          const g = groups.get(top) || { name: top, size: 0, folder: true, files: [] };
          g.size += f.size;
          g.files.push({ name: f.name, size: f.size, source: f });
          groups.set(top, g);
        }
        inFolder.value = '';
        if (!groups.size) { el.querySelector('#sd-error').textContent = 'That folder is empty.'; return; }
        groups.forEach(g => items.push(g));
        drawWhat();
      };
    }

    async function send(close) {
      if (job || !items.length || !to) return;
      const files = items.flatMap(x => x.files);
      const bar = el.querySelector('#sd-progress');
      el.querySelector('#sd-error').textContent = '';
      bar.hidden = false;
      el.querySelectorAll('#sd-files, #sd-folder').forEach(b => { b.disabled = true; });
      job = (files.some(f => f.path) ? api.sendLocalFiles : api.sendToDevice)({
        files, to,
        onProgress: p => {
          const pct = p.total ? Math.min(100, p.loaded / p.total * 100) : 100;
          // 4-2: a big file goes in pieces; after a drop (Wi-Fi, a locked screen) it waits, then carries on.
          bar.innerHTML = `<div class="send-progress-top"><span>${p.paused ? `Waiting for the connection… ${U.esc(p.name)} carries on by itself.`
            : p.phase === 'fetch' ? `Reading ${U.esc(p.name)} from the HP…` : `Sending ${U.esc(p.name)} to the HP…`}</span>
            <span class="mono">${U.formatBytes(p.loaded)} of ${U.formatBytes(p.total)}</span></div>
            <div class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="Sending"><span style="width:${pct.toFixed(1)}%"></span></div>`;
        }
      });
      refresh();
      sendBtn.textContent = 'Sending…';
      try {
        const sent = await job.promise;
        job = null;
        close();
        const what = sent.length === 1 ? sent[0].fileName : `${U.formatCount(sent.length)} files`;
        ui.toast(collects(to) ? `${what} sent. ${to.name} is collecting it now.` : `${what} is on the HP. ${to.name} gets it when it comes online.`);
      } catch (e) {
        job = null;
        if (!el.isConnected || e.code === 'CANCELLED') return;
        bar.hidden = true;
        el.querySelectorAll('#sd-files, #sd-folder').forEach(b => { b.disabled = false; });
        refresh();
        el.querySelector('#sd-error').innerHTML = U.icon('alertCircle') + `<span>${U.esc(e.message)}</span>`;
      }
    }

    drawWhat();
    drawTo();
    const first = el.querySelector('#sd-files') || el.querySelector('.send-dev.on') || el.querySelector('.send-dev');
    if (first) first.focus();
  }

  // Once signed in (3-3): files sent from File Explorer open the Send dialog, and so do files dropped
  // anywhere on the window. Drop zones of their own (Upload on the Dashboard) still take their drops.
  let watching = false;
  function watch() {
    if (watching) return;
    watching = true;
    const desk = root.atticDesktop && root.atticDesktop.send;
    if (desk) {
      const take = async () => {
        if (document.querySelector('.dialog')) return; // one at a time; they wait for the next request
        const list = await desk.pending().catch(() => []);
        if (list.length) open({ local: list });
      };
      desk.onRequest(take);
      take();
    }
    let depth = 0, veil = null;
    const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    const hide = () => { depth = 0; if (veil) { veil.remove(); veil = null; } };
    document.addEventListener('dragenter', e => {
      if (!hasFiles(e) || document.querySelector('.dialog')) return;
      depth++;
      if (!veil) {
        veil = document.createElement('div');
        veil.className = 'drop-veil';
        veil.innerHTML = `<div class="drop-card">${U.icon('transfer')}<b>Drop to send to a device</b><span>Files and folders go to another device’s Hub Inbox</span></div>`;
        document.body.appendChild(veil);
      }
    });
    document.addEventListener('dragleave', e => { if (hasFiles(e) && --depth <= 0) hide(); });
    document.addEventListener('dragover', e => { if (hasFiles(e) && veil) e.preventDefault(); });
    document.addEventListener('drop', async e => {
      const had = !!veil;
      hide();
      if (!hasFiles(e) || e.defaultPrevented || !had) return; // a drop zone of its own took it
      e.preventDefault();
      const dropped = await droppedFiles(e.dataTransfer);
      if (dropped.length) open({ dropped });
    });
  }

  root.Attic.send = { open, watch, droppedFiles };
})(window);
