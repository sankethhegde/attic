// Bootstrap and hash router. The URL always reflects where you are, so back/forward and reload work.
(function (root) {
  'use strict';
  const A = root.Attic;
  const { api, ui } = A;
  const app = document.getElementById('app');

  const VIEWS = { dashboard: A.dashboard, files: A.files, photos: A.media, videos: A.media, other: A.media, settings: A.settings };

  // Per-tab conveniences (scroll, sort, folder); per browser, not synced between devices.
  const freshTabs = (view) => ({
    files: { view: view || 'list', sort: { key: 'name', dir: 1 }, query: '', lastHash: '#/files' },
    photos: { sort: 'newest', share: '', query: '' },
    videos: { sort: 'newest', share: '', query: '' },
    other: { sort: 'newest', share: '', query: '' }
  });
  const state = { session: null, account: null, settings: null, needsSetup: false, tabs: freshTabs(), scroll: {}, cameFromDashboard: false };
  let shellApi = null, ctx = null, token = 0, prevKey = null, loginOpts = null;

  function parse() {
    const h = location.hash.replace(/^#\/?/, '');
    const [p, q] = h.split('?');
    return { segs: p.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (e) { return s; } }), query: Object.fromEntries(new URLSearchParams(q || '')), key: '#/' + p };
  }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  function replace(hash) { history.replaceState(null, '', hash); route(); }
  const landing = () => state.session.type === 'master' ? '#/dashboard' : '#/files';

  async function signOut() {
    await api.signOut().catch(() => {});
    leaveShell();
    state.session = state.account = null;
    state.tabs = freshTabs(state.settings.filesView);
    state.scroll = {};
    ui.toast('Signed out');
    go('#/login');
  }
  function leaveShell() { if (ctx && ctx.cleanup) ctx.cleanup(); ctx = null; shellApi = null; prevKey = null; }

  async function route() {
    const my = ++token;
    const r = parse();
    const seg = r.segs[0] || '';
    ui.closeMenus();
    document.querySelectorAll('.veil, .lightbox, .chart-tip').forEach(x => x.remove());

    if (state.needsSetup) {
      if (seg !== 'setup') return replace('#/setup');
      leaveShell();
      document.title = 'Set up · Attic';
      return A.login.renderSetup(app, (opts) => { state.needsSetup = false; loginOpts = opts; A.background.engine.unmount(); go('#/login'); });
    }
    if (!state.session) {
      if (seg !== 'login') return replace('#/login');
      leaveShell();
      document.title = 'Sign in · Attic';
      const opts = loginOpts; loginOpts = null;
      return A.login.renderLogin(app, (res) => {
        A.background.engine.unmount();
        state.session = res.session; state.account = res.account;
        go(landing());
      }, opts || {});
    }
    if (!seg || seg === 'login' || seg === 'setup') return replace(landing());
    if (!VIEWS[seg] || (seg === 'dashboard' && state.session.type !== 'master')) return replace('#/files');

    if (!shellApi) {
      A.background.engine.unmount();
      shellApi = A.shell.create(app, { state, signOut });
    }
    // Leaving a view: remember its scroll so returning lands where you were.
    const main = shellApi.main;
    if (prevKey) state.scroll[prevKey] = main.scrollTop;
    state.cameFromDashboard = prevKey === '#/dashboard' && seg === 'dashboard';
    if (ctx && ctx.cleanup) ctx.cleanup();
    prevKey = r.key;

    shellApi.setTab(seg === 'settings' ? null : seg);
    document.title = ({ dashboard: 'Dashboard', files: 'Files', photos: 'Photos', videos: 'Videos', other: 'Other', settings: 'Settings' }[seg]) + ' · Attic';
    ctx = {
      main, route: r, state, shell: shellApi, shellApi, go, signOut,
      reset: () => { location.hash = '#/setup'; location.reload(); },
      refreshShell: () => { leaveShell(); route(); }
    };
    main.scrollTop = 0;
    const result = await VIEWS[seg].render(ctx);
    if (my !== token) return;
    if (!(result && result.keepScroll)) main.scrollTop = state.scroll[r.key] || 0;
    // Keyboard users land in the new content instead of back at the top of the page.
    if (!document.activeElement || document.activeElement === document.body) main.focus({ preventScroll: true });
  }

  document.addEventListener('keydown', e => { if (ctx && ctx.onKey) ctx.onKey(e); });
  root.addEventListener('resize', () => { if (ctx && ctx.onResize) ctx.onResize(); });

  async function boot() {
    try {
      state.settings = await api.getSettings();
      ui.applyTheme(state.settings.theme);
      state.tabs = freshTabs(state.settings.filesView);
      state.needsSetup = await api.needsSetup();
      if (!state.needsSetup) {
        const s = await api.getSession();
        if (s) { state.session = s.session; state.account = s.account; }
      }
    } catch (e) {
      app.innerHTML = `<div class="page">${ui.errorState(e)}</div>`;
      app.querySelector('#retry').onclick = () => location.reload();
      return;
    }
    root.addEventListener('hashchange', route);
    route();
  }
  boot();
})(window);
