// Detects what kind of device is running Attic, and draws it.
// Phone / tablet / computer is reliable. Laptop vs desktop is not exposed by browsers, so it's inferred
// from the Battery API and marked as a guess; the person can correct it, and that choice is remembered.
(function (root) {
  'use strict';
  const { util: U, api, ui } = root.Attic;

  const LABEL = { phone: 'Mobile phone', tablet: 'Tablet', laptop: 'Laptop', desktop: 'Desktop computer', handheld: 'Handheld PC' };

  // Small illustrations: neutral body, accent screen.
  const ART = {
    phone: `<rect x="17" y="4" width="22" height="40" rx="5" fill="var(--dev-body)" stroke="var(--dev-line)" stroke-width="1.5"/>
      <rect x="20" y="9" width="16" height="28" rx="2" fill="var(--accent)"/><rect x="24.5" y="5.6" width="7" height="1.6" rx=".8" fill="var(--dev-line)"/>
      <path d="M23 26l4-4 3 3 3-3 3 3v4H23z" fill="var(--accent-ink)" opacity=".55"/><circle cx="25" cy="15" r="2" fill="var(--accent-ink)" opacity=".7"/>
      <rect x="25" y="40" width="6" height="1.6" rx=".8" fill="var(--dev-line)"/>`,
    tablet: `<rect x="8" y="6" width="40" height="36" rx="5" fill="var(--dev-body)" stroke="var(--dev-line)" stroke-width="1.5"/>
      <rect x="12" y="10" width="32" height="26" rx="2" fill="var(--accent)"/>
      <path d="M12 31l8-8 6 6 5-5 13 11H12z" fill="var(--accent-ink)" opacity=".55"/><circle cx="19" cy="16" r="2.4" fill="var(--accent-ink)" opacity=".7"/>
      <circle cx="28" cy="39" r="1.2" fill="var(--dev-line)"/>`,
    laptop: `<rect x="10" y="8" width="36" height="25" rx="3" fill="var(--dev-body)" stroke="var(--dev-line)" stroke-width="1.5"/>
      <rect x="13.5" y="11.5" width="29" height="18" rx="1.5" fill="var(--accent)"/>
      <path d="M13.5 26l7-6 5 4.5 4-3.5 13 8.5H13.5z" fill="var(--accent-ink)" opacity=".55"/><circle cx="19" cy="16" r="2" fill="var(--accent-ink)" opacity=".7"/>
      <path d="M4 35h48l-3 5H7z" fill="var(--dev-body)" stroke="var(--dev-line)" stroke-width="1.5" stroke-linejoin="round"/><rect x="24" y="35.5" width="8" height="1.6" rx=".8" fill="var(--dev-line)"/>`,
    desktop: `<rect x="5" y="5" width="46" height="30" rx="3" fill="var(--dev-body)" stroke="var(--dev-line)" stroke-width="1.5"/>
      <rect x="9" y="9" width="38" height="22" rx="1.5" fill="var(--accent)"/>
      <path d="M9 27l9-8 6 5.5 5-4 18 11.5H9z" fill="var(--accent-ink)" opacity=".55"/><circle cx="16" cy="14.5" r="2.4" fill="var(--accent-ink)" opacity=".7"/>
      <path d="M24 35h8l2 7H22z" fill="var(--dev-body)" stroke="var(--dev-line)" stroke-width="1.5" stroke-linejoin="round"/>
      <rect x="16" y="42" width="24" height="3" rx="1.5" fill="var(--dev-line)"/>`
  };
  // A handheld gaming PC (the ROG Ally): wide body, screen in the middle, sticks and buttons either side.
  ART.handheld = `<rect x="2.5" y="12" width="51" height="24" rx="9" fill="var(--dev-body)" stroke="var(--dev-line)" stroke-width="1.5"/>
      <rect x="15" y="15" width="26" height="18" rx="2" fill="var(--accent)"/>
      <path d="M15 29l6-5 4 3.5 4-3 12 7.5H15z" fill="var(--accent-ink)" opacity=".55"/><circle cx="20" cy="19.5" r="1.8" fill="var(--accent-ink)" opacity=".7"/>
      <circle cx="9" cy="20" r="2.6" fill="var(--dev-line)"/><circle cx="47" cy="28" r="2.6" fill="var(--dev-line)"/>
      <circle cx="45.5" cy="19" r="1.2" fill="var(--dev-line)"/><circle cx="48.5" cy="21.5" r="1.2" fill="var(--dev-line)"/>
      <path d="M7 28.5h4M9 26.5v4" stroke="var(--dev-line)" stroke-width="1.6" stroke-linecap="round"/>`;
  const art = (type, size) => `<svg class="dev-art" width="${size || 48}" height="${size || 48}" viewBox="0 0 56 48" aria-hidden="true">${ART[type] || ART.desktop}</svg>`;

  // ---------- detection ----------
  async function detect() {
    const nav = root.navigator, ua = nav.userAgent || '';
    const uaData = nav.userAgentData;
    const touch = nav.maxTouchPoints || 0;
    const shortSide = Math.min(root.screen.width, root.screen.height);

    // iPadOS reports itself as a Mac; touch points give it away.
    if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua) || (/Macintosh/.test(ua) && touch > 1) || (/Android/i.test(ua) && !/Mobile/i.test(ua)))
      return { type: 'tablet', sure: true, how: 'From your browser’s device info' };
    if ((uaData && uaData.mobile) || /Mobi|iPhone|iPod|Android.+Mobile|Windows Phone/i.test(ua))
      return { type: 'phone', sure: true, how: 'From your browser’s device info' };
    if (touch > 1 && shortSide >= 600 && shortSide <= 1100 && /Android|CrOS/i.test(ua))
      return { type: 'tablet', sure: false, how: 'Touch screen at tablet size' };

    // A computer. A battery that is discharging, or not full, means a laptop.
    if (nav.getBattery) {
      try {
        const b = await nav.getBattery();
        if (!b.charging || b.level < 1 || (b.dischargingTime !== Infinity && b.dischargingTime > 0))
          return { type: 'laptop', sure: true, how: 'This computer has a battery' };
        return { type: 'desktop', sure: false, how: 'No battery activity seen — could also be a plugged-in laptop' };
      } catch (e) { /* fall through */ }
    }
    const mac = /Macintosh|Mac OS X/.test(ua);
    return { type: mac ? 'laptop' : 'desktop', sure: false, how: 'Your browser doesn’t say whether this is a laptop or desktop' };
  }

  // Detected, unless the person corrected it — that choice is remembered in settings.
  async function current() {
    const detected = await detect();
    let override = null;
    try { override = (await api.getSettings()).thisDevice || null; } catch (e) { /* use detection */ }
    return override ? { type: override, sure: true, how: 'Set by you', detected, override: true } : Object.assign({ detected, override: false }, detected);
  }

  // ---------- the "This device" field ----------
  async function field(host, opts) {
    opts = opts || {};
    host.innerHTML = `<div class="dev-field"><span class="skel" style="width:48px;height:48px;border-radius:12px"></span><span class="skel" style="height:12px;width:50%"></span></div>`;
    const d = await current();
    host.innerHTML = `<div class="dev-field${opts.compact ? ' compact' : ''}" data-type="${d.type}">
      <span class="dev-tile">${art(d.type)}</span>
      <span class="dev-text"><span class="dev-k">This device</span><span class="dev-v">${LABEL[d.type]}</span>
        <span class="dev-how">${d.sure ? '' : `${U.icon('info')}Best guess · `}${U.esc(d.how)}</span></span>
      <button type="button" class="link-btn dev-change" aria-haspopup="menu" aria-expanded="false" aria-label="Change device type, currently ${LABEL[d.type]}">Change</button>
    </div>`;
    host.querySelector('.dev-change').onclick = (e) => {
      const btn = e.currentTarget;
      ui.menu(btn, `${['phone', 'tablet', 'laptop', 'desktop'].map(t => `<button class="menu-item" role="menuitemradio" aria-checked="${d.type === t}" data-t="${t}">
          <span style="display:inline-flex;width:28px">${art(t, 28)}</span>${LABEL[t]}${d.type === t ? `<span style="margin-left:auto;color:var(--accent)">${U.icon('check')}</span>` : ''}</button>`).join('')}
        <div class="menu-sep"></div><button class="menu-item" role="menuitem" data-t="">${U.icon('refresh')}Detect automatically${d.override ? '' : ' (on)'}</button>`,
      (m, close) => m.querySelectorAll('[data-t]').forEach(b => b.onclick = async () => {
        close();
        try { await api.updateSettings({ thisDevice: b.dataset.t || null }); } catch (err) { ui.toast(err.message, 'error'); return; }
        ui.toast(b.dataset.t ? `Saved: this is a ${LABEL[b.dataset.t].toLowerCase()}` : 'Detecting automatically');
        await field(host, opts);
        if (opts.onChange) opts.onChange();
        host.querySelector('.dev-change').focus();
      }));
    };
    return d;
  }

  root.Attic.device = { detect, current, field, art, LABEL };
})(window);
