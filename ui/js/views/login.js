// First-run setup and the login screen. The HP server checks every password (Phase 1C, milestone 3).
(function (root) {
  'use strict';
  const { util: U, api, ui, background } = root.Attic;

  // Passwords are hashed on the server, but until HTTPS arrives they cross the home network unencrypted.
  // Under the form: whether the connection is encrypted (Phase 4, 4-1: the HP's HTTPS). On a phone over
  // http, the steps to trust the HP once and move to its secure address (filled in by secureHint()).
  const HTTP_NOTE = () => location.protocol === 'https:'
    ? `<p class="form-note">${U.icon('lock')}<span>Encrypted with the HP’s own certificate.</span></p>`
    : `<p class="form-note">${U.icon('info')}<span>This connection isn’t encrypted. Sign in only on your home Wi-Fi.</span></p>`
      + (ui.handheld ? '<details class="secure-hint" hidden><summary>Use the secure address</summary><ol class="ph-steps"></ol><a class="btn btn-secondary btn-block" id="go-secure">Open the secure address</a></details>' : '');
  function secureHint(stage) {
    const d = stage.querySelector('.secure-hint');
    if (!d) return;
    api.getTls().then(tls => {
      const url = api.secureUrl(tls);
      if (!url || !d.isConnected) return;
      d.querySelector('.ph-steps').innerHTML = ui.secureSteps(tls);
      d.querySelector('#go-secure').href = url;
      d.hidden = false;
    });
  }

  // A username: 3–32 letters, numbers, dots, dashes or underscores, or an email address (feedback 1;
  // the HP must accept it too).
  const USERNAME_OK = u => /^[a-zA-Z0-9._-]{3,32}$/.test(u) || /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(u) && u.length <= 254;

  function field({ id, label, type, icon, autocomplete, eye, value }) {
    return `<div class="field${eye ? ' has-eye' : ''}${icon ? '' : ' no-icon'}" data-field="${id}">
      ${icon ? U.icon(icon) : ''}
      <input id="${id}" name="${id}" type="${type || 'text'}" placeholder=" " autocomplete="${autocomplete || 'off'}" spellcheck="false"${autocomplete === 'username' ? ' autocapitalize="none" autocorrect="off"' : ''} value="${U.esc(value || '')}" aria-describedby="${id}-msg">
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

  // ---------- feedback round 1: forgot password, reset, sign up (the HP's side: PR #28) ----------
  // The same card as sign-in, with a way back to it.
  function card(app, inner) {
    app.innerHTML = `<div class="stage" id="stage"><form class="login-card" novalidate>${ui.brand()}${inner}
      <div style="text-align:center;margin-top:14px"><a class="link-btn" href="#/login">${U.icon('arrowLeft').replace('class="ic"', 'class="ic" style="width:16px;height:16px;vertical-align:-3px;margin-right:4px"')}Back to sign in</a></div>
      ${HTTP_NOTE()}</form></div>`;
    const stage = app.querySelector('#stage');
    secureHint(stage);
    background.engine.mount(stage);
    const form = stage.querySelector('form');
    wireEyes(form);
    return form;
  }
  const done_ = (form, title, html) => {
    form.innerHTML = `${ui.brand()}<h1>${U.esc(title)}</h1><div class="banner banner-info" role="status" style="margin:12px 0 0">${U.icon('check')}<span>${html}</span></div>
      <a class="btn btn-primary btn-block" href="#/login" style="height:48px;margin-top:18px">Back to sign in</a>${HTTP_NOTE()}`;
    form.querySelector('.btn').focus();
  };

  // Forgot password: the HP emails a one-time link if the account has an email and mail is set up.
  function renderForgot(app) {
    const form = card(app, `<h1>Forgot your password?</h1>
      <p class="sub">Type your username or email. If your account has an email address, the HP sends a link to choose a new password. It works for 30 minutes.</p>
      ${field({ id: 'fg-login', label: 'Username or email', icon: 'user', autocomplete: 'username' })}
      <button class="btn btn-primary btn-block" type="submit" style="height:48px">Send the link</button>
      <div class="form-error" id="fg-error" role="alert"></div>`);
    const input = form.querySelector('#fg-login');
    input.focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      if (!input.value.trim()) { setFieldError(form, 'fg-login', 'Enter your username or email'); shake(form); return input.focus(); }
      const btn = form.querySelector('[type=submit]');
      busy(btn, true);
      try {
        const r = await api.forgotPassword(input.value);
        done_(form, r.mail ? 'Check your email' : 'Ask the master', U.esc(r.message) + (r.mail ? ' Check your spam folder too.' : ' The master can set a new password for you in the Dashboard.'));
      } catch (err) {
        busy(btn, false, 'Send the link');
        form.querySelector('#fg-error').innerHTML = U.icon('alertCircle') + `<span>${U.esc(err.message)}</span>`;
        shake(form);
      }
    };
  }

  // The link from the email: #/reset?token=… → a new password, then sign in.
  function renderReset(app, token, done) {
    const form = card(app, `<h1>Choose a new password</h1>
      <p class="sub">Your other devices are signed out when it changes.</p>
      ${field({ id: 'rs-pass', label: 'New password', type: 'password', icon: 'lock', eye: true, autocomplete: 'new-password' })}
      ${field({ id: 'rs-pass2', label: 'Confirm new password', type: 'password', icon: 'lock', eye: true, autocomplete: 'new-password' })}
      <button class="btn btn-primary btn-block" type="submit" style="height:48px">Change password</button>
      <div class="form-error" id="rs-error" role="alert"></div>`);
    if (!token) form.querySelector('#rs-error').innerHTML = U.icon('alertCircle') + '<span>This link is incomplete. Ask for a new one from Forgot password.</span>';
    form.querySelector('#rs-pass').focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const p = form.querySelector('#rs-pass').value, p2 = form.querySelector('#rs-pass2').value;
      setFieldError(form, 'rs-pass', p.length >= 6 ? '' : 'Use at least 6 characters');
      setFieldError(form, 'rs-pass2', p2 === p ? '' : 'The passwords don’t match');
      if (p.length < 6 || p !== p2) { shake(form); return; }
      const btn = form.querySelector('[type=submit]');
      busy(btn, true);
      try {
        const r = await api.resetPassword(token, p);
        done({ username: r.username, message: r.message });
      } catch (err) {
        busy(btn, false, 'Change password');
        const expired = /token|link|expired|invalid/i.test(err.message) || err.code === 'NOT_FOUND';
        const msg = U.esc(err.message), ask = /Ask for a new one.$/.test(err.message);
        form.querySelector('#rs-error').innerHTML = U.icon('alertCircle') + `<span>${ask ? msg.replace(/Ask for a new one.$/, '<a href="#/forgot">Ask for a new one</a>.') : msg + (expired ? ' <a href="#/forgot">Ask for a new link</a>.' : '')}</span>`;
        shake(form);
      }
    };
  }

  // Sign up: a new account on this paired device, waiting for the master's approval.
  function renderSignup(app) {
    const form = card(app, `<h1>Create an account</h1>
      <p class="sub">The master approves new accounts before they can sign in. Your files are private to you.</p>
      ${field({ id: 'sg-name', label: 'Your name', icon: 'user', autocomplete: 'name' })}
      ${field({ id: 'sg-user', label: 'Username or email', icon: 'user', autocomplete: 'username' })}
      ${field({ id: 'sg-email', label: 'Email, for password resets (optional)', icon: 'mail', type: 'email', autocomplete: 'email' })}
      ${field({ id: 'sg-pass', label: 'Password', type: 'password', icon: 'lock', eye: true, autocomplete: 'new-password' })}
      ${field({ id: 'sg-pass2', label: 'Confirm password', type: 'password', icon: 'lock', eye: true, autocomplete: 'new-password' })}
      <button class="btn btn-primary btn-block" type="submit" style="height:48px;margin-top:6px">Create account</button>
      <div class="form-error" id="sg-error" role="alert"></div>`);
    const v = id => form.querySelector('#' + id).value;
    const emailRow = form.querySelector('[data-field="sg-email"]');
    // A username that is an email address is the account's email too.
    form.querySelector('#sg-user').addEventListener('input', () => { emailRow.hidden = /@/.test(v('sg-user')); });
    form.querySelector('#sg-email').setAttribute('autocapitalize', 'none');
    let deviceType = null;
    root.Attic.device.current().then(d => { deviceType = d.type; }).catch(() => {});
    form.querySelector('#sg-name').focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const user = v('sg-user').trim(), email = emailRow.hidden ? '' : v('sg-email').trim();
      const errs = {
        'sg-name': v('sg-name').trim() ? '' : 'Enter your name',
        'sg-user': !user ? 'Choose a username' : USERNAME_OK(user) ? '' : 'Use 3–32 letters, numbers, dots, dashes or underscores, or an email address',
        'sg-email': !email || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? '' : 'That doesn’t look like an email address',
        'sg-pass': v('sg-pass').length >= 6 ? '' : 'Use at least 6 characters',
        'sg-pass2': v('sg-pass2') === v('sg-pass') ? '' : 'The passwords don’t match'
      };
      Object.entries(errs).forEach(([k, m]) => setFieldError(form, k, m));
      const bad = Object.keys(errs).find(k => errs[k]);
      if (bad) { shake(form); return form.querySelector('#' + bad).focus(); }
      const btn = form.querySelector('[type=submit]');
      busy(btn, true);
      try {
        const r = await api.signUp({ displayName: v('sg-name'), username: user, password: v('sg-pass'), email, deviceType });
        done_(form, 'Waiting for approval', `Thanks, ${U.esc(r.account.displayName)}. ${U.esc(r.message)} You can sign in as <b>${U.esc(r.account.username)}</b> once it’s approved.`);
      } catch (err) {
        busy(btn, false, 'Create account');
        form.querySelector('#sg-error').innerHTML = U.icon('alertCircle') + `<span>${U.esc(err.message)}</span>`;
        shake(form);
      }
    };
  }

  // ---------- first run ----------
  function renderSetup(app, done) {
    app.innerHTML = `<div class="stage" id="stage">
      <form class="login-card" novalidate>
        ${ui.brand()}
        <h1>Set up Attic</h1>
        <p class="sub">Create the master account. It sees every share and manages every device. You’ll only do this once.</p>
        ${field({ id: 'su-name', label: 'Display name', icon: 'user', autocomplete: 'name' })}
        ${field({ id: 'su-user', label: 'Username or email', icon: 'user', autocomplete: 'username' })}
        ${field({ id: 'su-pass', label: 'Password', type: 'password', icon: 'lock', eye: true, autocomplete: 'new-password' })}
        ${field({ id: 'su-pass2', label: 'Confirm password', type: 'password', icon: 'lock', eye: true, autocomplete: 'new-password' })}
        <button class="btn btn-primary btn-block" type="submit" style="height:48px;margin-top:6px">Create master account</button>
        <div class="form-error" role="alert"></div>
        ${HTTP_NOTE()}
      </form></div>`;
    const stage = app.querySelector('#stage');
    secureHint(stage);
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
      else if (!USERNAME_OK(v('su-user').trim())) errs['su-user'] = 'Use 3–32 letters, numbers, dots, dashes or underscores, or an email address';
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
        ${opts.notice ? `<div class="banner banner-info" role="status">${U.icon('check')}<span>${U.esc(opts.notice)}</span></div>` : ''}
        <div id="lg-device" class="lg-device"></div>
        ${field({ id: 'lg-user', label: 'Username or email', icon: 'user', autocomplete: 'username', value: opts.username })}
        ${field({ id: 'lg-pass', label: 'Password', type: 'password', icon: 'lock', eye: true, autocomplete: 'current-password' })}
        <div class="opts-row"><label class="check"><input type="checkbox" id="lg-stay"> Stay signed in</label>
          <span class="field-hint" id="caps" hidden>Caps Lock is on</span></div>
        <button class="btn btn-primary btn-block" type="submit" style="height:48px">Sign in</button>
        <div class="form-error" id="lg-error" role="alert"></div>
        <div class="lg-links"><a class="link-btn" href="#/forgot" id="lg-forgot">Forgot password?</a><a class="link-btn" href="#/signup" id="lg-signup">Create an account</a></div>
        <div id="lg-switch"></div>
        ${HTTP_NOTE()}
      </form>
      <button class="corner-btn" id="bg-btn" type="button" aria-label="Change login background" title="Change background">${U.icon('image')}</button>
    </div>`;
    const stage = app.querySelector('#stage');
    secureHint(stage);
    background.engine.mount(stage);
    const form = stage.querySelector('form');
    const card = form;
    wireEyes(form);

    function setMode(m, focus) {
      mode = m;
      card.classList.toggle('master', m === 'master');
      form.querySelector('#lg-signup').hidden = m === 'master'; // the master's account already exists
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

  // ---------- pairing (Phase 2, 2-2) ----------
  // A device the HP doesn't know yet trades a one-time code, issued by the master on the HP, for its
  // identity. The HP keeps that identity in an HttpOnly cookie; after this the device signs in as usual.
  function osGuess() {
    const ua = root.navigator.userAgent || '';
    if (/iPhone|iPod/.test(ua)) return 'iOS';
    if (/iPad/.test(ua) || (/Macintosh/.test(ua) && root.navigator.maxTouchPoints > 1)) return 'iPadOS';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Mac OS X/.test(ua)) return 'macOS';
    if (/CrOS/.test(ua)) return 'ChromeOS';
    return /Linux/.test(ua) ? 'Linux' : '';
  }
  function defaultName(type) {
    const desk = root.atticDesktop;
    if (desk && desk.hostname) return desk.hostname;
    const os = osGuess();
    if (os === 'iOS') return 'iPhone';
    if (os === 'iPadOS') return 'iPad';
    return (os ? os + ' ' : '') + (root.Attic.device.LABEL[type] || 'device').toLowerCase();
  }

  function renderPair(app, done, opts) {
    opts = opts || {};
    app.innerHTML = `<div class="stage" id="stage">
      <form class="login-card" novalidate aria-labelledby="pr-title">
        ${ui.brand()}
        <h1 id="pr-title">Pair this device</h1>
        <p class="sub">On the HP, the master opens <b>Devices → Pair a device</b> and gets a 6-digit code. Type it here. Each device needs this once.</p>
        ${opts.unpaired ? `<div class="banner banner-warning" role="status">${U.icon('alert')}<span>This device was unpaired on the HP. Ask for a new code to keep using Attic here.</span></div>` : ''}
        <div class="field pair-code" data-field="pr-code">
          ${U.icon('lock')}
          <input id="pr-code" type="text" placeholder=" " inputmode="numeric" autocomplete="one-time-code" maxlength="7" spellcheck="false" aria-describedby="pr-code-msg">
          <label for="pr-code">Pairing code</label>
          <div class="field-msg" id="pr-code-msg" aria-live="polite"></div>
        </div>
        ${field({ id: 'pr-name', label: 'Name for this device', icon: 'monitor' })}
        <div id="pr-device" class="lg-device"></div>
        <button class="btn btn-primary btn-block" type="submit" style="height:48px">Pair</button>
        <div class="form-error" id="pr-error" role="alert"></div>
        ${HTTP_NOTE()}
      </form>
    </div>`;
    const stage = app.querySelector('#stage');
    secureHint(stage);
    background.engine.mount(stage);
    const form = stage.querySelector('form');
    const code = form.querySelector('#pr-code'), name = form.querySelector('#pr-name');
    wireEyes(form);
    let kind = 'desktop', nameTouched = false;
    name.addEventListener('input', () => { nameTouched = true; });
    const setKind = d => { kind = d.type; if (!nameTouched) name.value = defaultName(kind); };
    root.Attic.device.field(form.querySelector('#pr-device'), { compact: true, onChange: async () => setKind(await root.Attic.device.current()) }).then(setKind);
    // Digits only, shown as "482 913" so it's easy to compare with the HP's screen.
    code.addEventListener('input', () => {
      const d = code.value.replace(/\D/g, '').slice(0, 6);
      code.value = d.length > 3 ? d.slice(0, 3) + ' ' + d.slice(3) : d;
    });
    code.focus();

    form.onsubmit = async (e) => {
      e.preventDefault();
      const digits = code.value.replace(/\D/g, '');
      setFieldError(form, 'pr-code', digits.length === 6 ? '' : digits ? 'The code is 6 digits' : 'Enter the code shown on the HP');
      setFieldError(form, 'pr-name', name.value.trim() ? '' : 'Give this device a name');
      form.querySelector('#pr-error').textContent = '';
      if (digits.length !== 6 || !name.value.trim()) { shake(form); (digits.length !== 6 ? code : name).focus(); return; }
      const btn = form.querySelector('[type=submit]');
      busy(btn, true);
      try {
        const desk = root.atticDesktop;
        const dev = await api.claimPairing({ code: digits, name: name.value, kind, os: (desk && desk.osName) || osGuess() });
        await leave(form);
        ui.toast(`Paired as ${dev.name}`);
        done(dev);
      } catch (err) {
        busy(btn, false, 'Pair');
        if (err.code === 'BAD_CODE') { setFieldError(form, 'pr-code', err.message); code.select(); code.focus(); }
        else if (err.code === 'INVALID') { setFieldError(form, 'pr-name', err.message); name.focus(); }
        else form.querySelector('#pr-error').innerHTML = U.icon('alertCircle') + `<span>${U.esc(err.message)}</span>`;
        shake(form);
      }
    };
  }

  root.Attic.login = { renderSetup, renderLogin, renderPair, renderForgot, renderReset, renderSignup };
})(window);
