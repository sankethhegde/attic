// Login background: rotating, cross-fading images with a fixed readability scrim, plus the picker.
// A decorative feature must never block login: every failure falls back quietly.
(function (root) {
  'use strict';
  const { util: U, api, ui } = root.Attic;

  const urls = new Map(); // id -> object URL for custom blobs
  function urlFor(bg) {
    if (bg.url) return bg.url;
    if (!urls.has(bg.id)) urls.set(bg.id, URL.createObjectURL(bg.blob));
    return urls.get(bg.id);
  }
  function preload(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(resolve);
      img.onerror = reject;
      img.src = src;
    });
  }

  // ---------- rotation engine ----------
  const engine = {
    stage: null, layers: [], front: 0, list: [], settings: null, idx: -1, timer: 0, failed: new Set(), token: 0,

    async mount(stage) {
      this.unmount();
      this.stage = stage;
      this.layers = [0, 1].map(() => { const d = document.createElement('div'); d.className = 'bg-layer'; stage.prepend(d); return d; });
      const scrim = document.createElement('div');
      scrim.className = 'scrim';
      this.layers[1].after(scrim);
      await this.reload(true);
    },

    async reload(first) {
      const token = ++this.token;
      try {
        const [list, settings] = await Promise.all([api.listBackgrounds(), api.getSettings()]);
        if (token !== this.token) return;
        this.list = list; this.settings = settings.background; this.failed.clear();
      } catch (e) { this.list = []; }
      const sel = this.list.findIndex(b => b.id === this.settings.selected);
      let start;
      if (this.settings.mode === 'pin' && sel >= 0) start = sel;
      else if (!first && sel >= 0) start = sel;
      else if (this.settings.mode === 'order') start = sel >= 0 ? sel : 0;
      else start = Math.floor(Math.random() * Math.max(1, this.list.length)); // random on each visit
      await this.show(start);
      this.schedule();
    },

    schedule() {
      clearTimeout(this.timer);
      const s = this.settings;
      // Reduced motion: keep one still image rather than swapping pictures on a timer.
      if (!s || s.mode === 'pin' || !s.interval || this.list.length < 2 || ui.reducedMotion()) return;
      this.timer = setTimeout(async () => { await this.show(this.nextIndex()); this.schedule(); }, s.interval * 1000);
    },

    nextIndex() {
      const n = this.list.length;
      if (this.settings.mode === 'shuffle' && n > 1) { let i; do { i = Math.floor(Math.random() * n); } while (i === this.idx); return i; }
      return (this.idx + 1) % n;
    },

    // Preload first, then swap the two stacked layers, so a fade never reveals a half-loaded picture.
    async show(i) {
      const n = this.list.length;
      for (let tries = 0; tries < n; tries++) {
        const bg = this.list[(i + tries) % n];
        if (this.failed.has(bg.id)) continue;
        try {
          const src = urlFor(bg);
          await preload(src);
          if (!this.stage) return;
          this.idx = (i + tries) % n;
          const next = this.layers[1 - this.front], cur = this.layers[this.front];
          next.style.backgroundImage = `url("${src}")`;
          next.classList.toggle('zoom', !ui.reducedMotion());
          next.classList.add('on');
          cur.classList.remove('on');
          this.front = 1 - this.front;
          return;
        } catch (e) { this.failed.add(bg.id); }
      }
      // Every image failed: the stage's solid colour shows and the form still works.
      this.layers.forEach(l => l.classList.remove('on'));
    },

    unmount() {
      clearTimeout(this.timer);
      this.token++;
      this.layers.forEach(l => l.remove());
      if (this.stage) this.stage.querySelectorAll('.scrim').forEach(s => s.remove());
      this.layers = []; this.stage = null;
    }
  };

  // ---------- picker (login corner + Settings) ----------
  async function renderPicker(host, opts) {
    opts = opts || {};
    host.innerHTML = '<div class="bg-gallery">' + Array.from({ length: 6 }, () => '<div class="skel" style="aspect-ratio:16/10"></div>').join('') + '</div>';
    let list, settings;
    try { [list, settings] = await Promise.all([api.listBackgrounds(), api.getSettings()]); }
    catch (e) { host.innerHTML = ui.errorState(e, 'bg-retry'); host.querySelector('#bg-retry').onclick = () => renderPicker(host, opts); return; }
    const bg = settings.background;
    const custom = list.filter(b => !b.bundled).length;
    host.innerHTML = `
      <div class="bg-gallery" role="list" aria-label="Background images">
        ${list.map(b => `<div role="listitem" style="position:relative">
          <button class="bg-thumb${bg.selected === b.id ? ' sel' : ''}" data-id="${b.id}" style="background-image:url('${urlFor(b)}')"
            aria-pressed="${bg.selected === b.id}" aria-label="${U.esc(b.name)}${b.bundled ? '' : ' (yours)'}">
            <span class="sel-mark">${U.icon('check')}</span>${b.bundled ? '' : '<span class="badge">Yours</span>'}</button>
          ${b.bundled ? '' : `<button class="bg-remove" data-remove="${b.id}" aria-label="Remove ${U.esc(b.name)}" title="Remove">${U.icon('trash')}</button>`}
        </div>`).join('')}
        <button class="bg-add" id="bg-add" ${custom >= api.MAX_CUSTOM_BG ? 'disabled' : ''}>${U.icon('plus')}Add your own<span style="font-weight:500;font-size:11.5px">${custom}/${api.MAX_CUSTOM_BG} · JPG, PNG, WebP</span></button>
        <input type="file" id="bg-file" accept="image/jpeg,image/png,image/webp" multiple hidden>
      </div>
      <div class="opt-row"><div class="lbl">Rotation<small>How the login screen moves through images</small></div>
        <div class="seg" role="group" aria-label="Rotation mode">
          ${[['shuffle', 'Shuffle'], ['order', 'In order'], ['pin', 'Pin selected']].map(([v, l]) => `<button data-mode="${v}" aria-pressed="${bg.mode === v}">${l}</button>`).join('')}
        </div></div>
      <div class="opt-row"><div class="lbl">Change every</div>
        <div class="seg" role="group" aria-label="Interval">
          ${[[10, '10 sec'], [30, '30 sec'], [120, '2 min'], [0, 'Never']].map(([v, l]) => `<button data-int="${v}" aria-pressed="${bg.interval === v}" ${bg.mode === 'pin' ? 'disabled' : ''}>${l}</button>`).join('')}
        </div></div>
      <p class="muted" style="font-size:12.5px;margin:14px 0 0">Custom images stay in this browser only. Every image gets a darkening overlay so the sign-in card stays readable.</p>`;

    const changed = async (patch, msg) => {
      try { await api.updateSettings({ background: patch }); if (msg) ui.toast(msg); if (opts.onChange) opts.onChange(); renderPicker(host, opts); }
      catch (e) { ui.toast(e.message, 'error'); }
    };
    host.querySelectorAll('.bg-thumb').forEach(b => b.onclick = () => changed({ selected: b.dataset.id }));
    host.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => changed({ mode: b.dataset.mode }, 'Rotation updated'));
    host.querySelectorAll('[data-int]').forEach(b => b.onclick = () => changed({ interval: +b.dataset.int }, 'Interval updated'));
    host.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
      try { await api.removeBackground(b.dataset.remove); ui.toast('Image removed'); if (opts.onChange) opts.onChange(); renderPicker(host, opts); }
      catch (e) { ui.toast(e.message, 'error'); }
    });
    const file = host.querySelector('#bg-file');
    host.querySelector('#bg-add').onclick = () => file.click();
    file.onchange = async () => {
      let added = 0, lastId = null;
      for (const f of file.files) {
        try { const r = await api.addBackground(f); added++; lastId = r.id; }
        catch (e) { ui.toast(e.message, 'error'); if (e.code === 'LIMIT') break; }
      }
      if (added) {
        await api.updateSettings({ background: { selected: lastId } }).catch(() => {});
        ui.toast(added === 1 ? 'Image added' : `${added} images added`);
        if (opts.onChange) opts.onChange();
      }
      renderPicker(host, opts);
    };
  }

  root.Attic.background = { engine, renderPicker, urlFor };
})(window);
