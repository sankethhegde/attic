// First-run setup and the login screen. The HP server checks every password (Phase 1C, milestone 3).
(function (root) {
  'use strict';
  const { util: U, api, ui, background } = root.Attic;

  // Passwords are hashed on the server, but until HTTPS arrives they cross the home network unencrypted.
  const HTTP_NOTE = `<p class="mock-note">${U.icon('info')}<span>This connection isn’t encrypted yet. Sign in only on your home Wi-Fi.</span></p>`;

  function field({ id, label, type, icon, autocomplete, eye, value }) {
    return `<div class="field${eye ? ' has-eye' : ''}${icon ? '' : ' no-icon'}" data-field="${id}">
      ${icon ? U.icon(icon) : ''}
      <input id="${id}" name="${id}" type="${type || 'text'}" placeholder=" " autocomplete="${autocomplete || 'off'}" spellcheck="false" value="${U.esc(value || '')}" aria-describedby="${id}-msg">
      <label for="${id}">${label}</label>
      ${eye ? `<button type="button" class="icon-btn eye" aria-label="Show password" aria-pressed="false">${U.icon('eye')}</button>` : ''}
      <div class="field-msg" id="${id}-msg" aria-live="polite"></div>
    </div>`;
  }
  function setFieldError(form, id, msg) {
    const f = form.querySelector(`[data-field="${id}"]`);
    if (!f) return; // the Stay signed in checkbox has no message
    f.classList.toggle('invalid', !!msg);
    f.querySelector('.field-msg').textContent = msg || '';
    f.querySelector('input').setAttribute('aria-invalid', msg ? 'true' : 'false');
  }
  function wireEyes(form) {
    form.querySelectorAll('.eye').forEach(btn => btn.onclick = () => {
      const input = btn.parentElement.querySelector('input');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', show);
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      btn.innerHTML = U.icon(show ? 'eyeOff' : 'eye');
    });
    form.querySelectorAll('input').forEach(i => i.addEventListener('input', () => setFieldError(form, i.id, '')));
  }
  function busy(btn, on, label) {
    btn.disabled = on;
    btn.innerHTML = on ? `<span class="spinner" aria-hidden="true"></span><span class="sr-only">Checking</span>` : label;
  }
  function shake(card) {
    if (ui.reducedMotion()) return;
    card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
  }
  function leave(card) {
    return new Promise(r => { if (ui.reducedMotion()) return r(); card.classList.add('leaving'); setTimeout(r, 340); });
  }

  // ---------- first run ----------
  function renderSetup(app, done) {
    app.innerHTML = `<div class="stage" id="stage">
      <form class="login-card" novalidate>
        ${ui.brand()}
        <h1>Set up Attic</h1>
        <p class="sub">Create the master account. It sees every share and manages every device. You’ll only do this once.</p>
        ${field({ id: 'su-name', label: 'Display name', icon: 'user', autocomplete: 'name' })}
        ${field({ id: 'su-user', label: 'Username', icon: 'user', autocomplete: 'username' })}
        ${field({ id: 'su-pass', label: 'Password', type: 'password', icon: 'lock', eye: true, autocomplete: 'new-password' })}
        ${field({ id: 'su-pass2', label: 'Confirm password', type: 'password', icon: 'lock', eye: true, autocomplete: 'new-password' })}
        <button class="btn btn-primary btn-block" type="submit" style="height:48px;margin-top:6px">Create master account</button>
        <div class="form-error" role="alert"></div>
        ${HTTP_NOTE}
      </form></div>`;
    const stage = app.querySelector('#stage');
    background.engine.mount(stage);
    const form = stage.querySelector('form');
    const card = form;
    wireEyes(form);
    form.querySelector('#su-name').focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = id => form.querySelector('#' + id).value;
      const errs = {};
      if (!v('su-name').trim()) errs['su-name'] = 'Enter a display name';
      if (!v('su-user').trim()) errs['su-user'] = 'Choose a username';
      else if (!/^[a-zA-Z0-9._-]{3,32}$/.test(v('su-user').trim())) errs['su-user'] = 'Use 3–32 letters, numbers, dots, dashes or underscores';
      if (!v('su-pass')) errs['su-pass'] = 'Choose a password';
      else if (v('su-pass').length < 6) errs['su-pass'] = 'Use at least 6 characters';
      if (!errs['su-pass'] && v('su-pass2') !== v('su-pass')) errs['su-pass2'] = 'Passwords don’t match';
      ['su-name', 'su-user', 'su-pass', 'su-pass2'].forEach(id => setFieldError(form, id, errs[id]));
      const first = Object.keys(errs)[0];
      if (first) { shake(card); form.querySelector('#' + first).focus(); return; }
      const btn = form.querySelector('[type=submit]');
      busy(btn, true);
      try {
        await api.createMaster({ displayName: v('su-name').trim(), username: v('su-user').trim(), password: v('su-pass') });
        await leave(card);
        ui.toast('Master account created');
        done({ showAccounts: true });
      } catch (err) {
        busy(btn, false, 'Create master account');
        form.querySelector('.form-error').innerHTML = U.icon('alertCircle') + U.esc(err.message);
      }
    };
  }

  // ---------- login ----------
  function renderLogin(app, done, opts) {
    opts = opts || {};
    let mode = opts.mode === 'master' ? 'master' : 'device';
    app.innerHTML = `<div class="stage" id="stage">
      <form class="login-card" novalidate aria-labelledby="lg-title">
        ${ui.brand()}
        <span class="mode-badge">${U.icon('shield')}Master access</span>
        <h1 id="lg-title"></h1>
        <p class="sub" id="lg-sub"></p>
        <div id="lg-device" class="lg-device"></div>
        ${field({ id: 'lg-user', label: 'Username', icon: 'user', autocomplete: 'username', value: opts.username })}
        ${field({ id: 'lg-pass', label: 'Password', type: 'password', icon: 'lock', eye: true, autocomplete: 'current-password' })}
        <div class="opts-row"><label class="check"><input type="checkbox" id="lg-stay"> Stay signed in</label>
          <span class="field-hint" id="caps" hidden>Caps Lock is on</span></div>
        <button class="btn btn-primary btn-block" type="submit" style="height:48px">Sign in</button>
        <div class="form-error" id="lg-error" role="alert"></div>
        <div id="lg-switch"></div>
        ${HTTP_NOTE}
      </form>
      <button class="corner-btn" id="bg-btn" type="button" aria-label="Change login background" title="Change background">${U.icon('image')}</button>
    </div>`;
    const stage = app.querySelector('#stage');
    background.engine.mount(stage);
    const form = stage.querySelector('form');
    const card = form;
    wireEyes(form);

    function setMode(m, focus) {
      mode = m;
      card.classList.toggle('master', m === 'master');
      form.querySelector('#lg-title').textContent = m === 'master' ? 'Master sign-in' : 'Welcome back';
      form.querySelector('#lg-sub').textContent = m === 'master'
        ? 'Full access to every share, device and setting.'
        : 'Sign in with this device’s account to reach your files.';
      form.querySelector('#lg-switch').innerHTML = m === 'master'
        ? `<div style="text-align:center;margin-top:14px"><button type="button" class="link-btn" id="lg-back">${U.icon('arrowLeft').replace('class="ic"', 'class="ic" style="width:16px;height:16px;vertical-align:-3px;margin-right:4px"')}Back to device login</button></div>`
        : `<div class="divider">or</div><button type="button" class="btn btn-secondary btn-block" id="lg-master">${U.icon('shield')}Sign in as master</button>`;
      form.querySelector('#lg-error').textContent = '';
      ['lg-user', 'lg-pass'].forEach(id => setFieldError(form, id, ''));
      const sw = form.querySelector('#lg-master') || form.querySelector('#lg-back');
      sw.onclick = () => setMode(m === 'master' ? 'device' : 'master', true);
      if (focus) form.querySelector('#lg-user').focus();
    }
    setMode(mode);
    form.querySelector(opts.username ? '#lg-pass' : '#lg-user').focus();
    let thisDevice = null;
    root.Attic.device.field(form.querySelector('#lg-device'), { compact: true, onChange: async () => { thisDevice = (await root.Attic.device.current()).type; } })
      .then(d => { thisDevice = d.type; });

    const caps = form.querySelector('#caps');
    form.querySelector('#lg-pass').addEventListener('keyup', e => { caps.hidden = !(e.getModifierState && e.getModifierState('CapsLock')); });

    form.onsubmit = async (e) => {
      e.preventDefault();
      const user = form.querySelector('#lg-user').value, pass = form.querySelector('#lg-pass').value;
      // Empty fields are caught before any check runs, next to the field.
      setFieldError(form, 'lg-user', user.trim() ? '' : 'Enter your username');
      setFieldError(form, 'lg-pass', pass ? '' : 'Enter your password');
      form.querySelector('#lg-error').textContent = '';
      if (!user.trim() || !pass) { shake(card); form.querySelector(user.trim() ? '#lg-pass' : '#lg-user').focus(); return; }
      const btn = form.querySelector('[type=submit]');
      busy(btn, true);
      try {
        const res = await api.signIn({ mode, username: user, password: pass, stay: form.querySelector('#lg-stay').checked, deviceType: thisDevice });
        await leave(card);
        done(res);
      } catch (err) {
        busy(btn, false, 'Sign in');
        form.querySelector('#lg-error').innerHTML = U.icon('alertCircle') + `<span>${U.esc(err.message)}</span>`;
        form.querySelector('#lg-pass').value = '';
        form.querySelector('#lg-pass').focus();
        shake(card);
      }
    };

    stage.querySelector('#bg-btn').onclick = () => {
      ui.dialog({
        title: 'Login background', wide: true,
        lead: 'Pick an image, add your own, and choose how often it changes.',
        body: '<div id="picker"></div>',
        actions: [{ label: 'Done', kind: 'primary' }],
        onOpen: (dlg) => background.renderPicker(dlg.querySelector('#picker'), { onChange: () => background.engine.reload() })
      });
    };
  }

  root.Attic.login = { renderSetup, renderLogin };
})(window);
