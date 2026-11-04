// Attic Hub desktop shell. Phase 2, milestone 2-1: on start it finds the HP on the home network
// (agent/connect.js), shows a "Looking for server" screen meanwhile, and then opens the interface the HP
// serves, so sign-in and every file call go to the real server. A typed address is the fallback.
// Pairing (2-2) happens in that interface; the HP keeps this PC's device token in a cookie, which the
// window's session stores across restarts.
// Milestone 2-3: once paired, the agent (agent/hub-agent.js) reports this PC's stats to the HP's live hub
// every few seconds, using that cookie's token.
// Phase 3, milestone 3-1 (T-02, T-03): the first launch asks whether this PC is the server or a client
// (agent/mode.js). A client does all of the above. The server gets its own screen (ui/server.html):
// set up a new server or use an existing server folder, then install it as a Windows startup task
// (agent/server-control.js, over the HP's server/service/). The installed task runs this same program
// with the supervisor's path as its argument; then it runs the supervisor without any window.
// Tray, notifications and Explorer integration arrive in later milestones.
const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// What the pairing screen (2-2) suggests for this PC: its name, and Windows 10 or 11 (build 22000 and up).
const HOSTNAME = os.hostname().slice(0, 64);
const OS_NAME = process.platform === 'win32' ? (Number(os.release().split('.')[2]) >= 22000 ? 'Windows 11' : 'Windows 10') : os.type();

// Packaged builds carry ui/, agent/ and server/discovery.js inside the app; in development they sit
// next to desktop/.
const ROOT = app.isPackaged ? __dirname : path.join(__dirname, '..');
// The interface and the whole server ship as plain folders beside the app (resources\ui, resources\server),
// so the startup task and the server read them from disk like any Node program.
const RES = app.isPackaged ? process.resourcesPath : ROOT;
const CONNECT_PAGE = path.join(RES, 'ui', 'connect.html');
const SERVER_PAGE = path.join(RES, 'ui', 'server.html');
const modeLib = require(path.join(ROOT, 'agent', 'mode.js'));
const modeStore = modeLib.store(path.join(app.getPath('userData'), 'mode.json'));

// ---------- the startup task (3-1) ----------
// Windows starts "Attic Hub Server" as `Attic Hub.exe <...>\server\service\supervisor.js`. That run has
// no window. It starts this same program again as plain Node (ELECTRON_RUN_AS_NODE, in the child's
// environment only: Electron's own helper processes must not inherit it) to run the supervisor, pointed
// at the folder chosen in Server mode, and lives exactly as long as the supervisor does, so Windows sees
// the task running and its restart-on-failure applies.
const SUPERVISOR_ARG = (a => a && path.resolve(a))(process.argv.slice(1).find(a => /[\\/]service[\\/]supervisor\.js$/i.test(a)));
if (SUPERVISOR_ARG) {
  app.disableHardwareAcceleration();
  const m = modeStore.load();
  if (!m || m.mode !== 'server' || !m.server) {
    console.error('Attic Hub: this PC isn’t set up as the server. Open Attic Hub and choose Server mode.');
    app.exit(2);
  } else {
    const sup = require('child_process').spawn(process.execPath, [SUPERVISOR_ARG], {
      cwd: path.dirname(path.dirname(SUPERVISOR_ARG)), stdio: 'ignore', windowsHide: true,
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1', ATTIC_DATA: m.server.data, ATTIC_CONFIG: m.server.config })
    });
    sup.on('exit', code => app.exit(code == null ? 1 : code));
    sup.on('error', () => app.exit(1));
  }
}
const connect = require(path.join(ROOT, 'agent', 'connect.js'));
const { createAgent, hubUrl } = require(path.join(ROOT, 'agent', 'hub-agent.js'));
const { createCollector } = require(path.join(ROOT, 'agent', 'stats.js'));
const inbox = require(path.join(ROOT, 'agent', 'inbox.js'));
const { createReceiver } = require(path.join(ROOT, 'agent', 'receiver.js'));
// Where received files land (2-4); choosing another is 3-3. ATTIC_INBOX points tests elsewhere.
const INBOX = process.env.ATTIC_INBOX || inbox.defaultFolder();
let si = null;
try { si = require('systeminformation'); } catch (e) { /* battery unknown, network guessed by name */ }

const HEARTBEAT_MS = 15e3; // how often an open session checks the HP is still there
let win = null;
let remembered = null;     // the server used last time (from user data)
let server = null;         // the server whose interface is open now
let lastState = null;      // the start screen's current state, replayed when it (re)loads
let choices = [];          // servers offered on a "choose" screen
let searching = false;
let heartbeat = 0;
let saved = null;
let agent = null;          // the live-stats agent for `server`, while this PC is paired with it
let agentToken = null;
let agentState = 'off';
let collect = null;        // made once, so its CPU meter keeps measuring between reports
let receiver = null;       // collects files sent to this PC into the Hub Inbox (2-4), alongside the agent
const received = [];       // the latest files received this session, newest first, for Settings

let mode = null;            // { mode: 'client' | 'server', server?: { dir, config, data } } (mode.json)
let control = null;         // Server mode's controls (agent/server-control.js), for mode.server

// One window only: a second launch focuses the first. The startup task's run above is not a window.
if (SUPERVISOR_ARG) {
  // nothing else to do: the supervisor runs until it's asked to stop
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    saved = connect.store(path.join(app.getPath('userData'), 'server.json'));
    remembered = saved.load();
    mode = modeStore.load();
    createWindow();
    start();
  });
  // "Start now" runs the server as a child of the tool; it stops with the tool.
  app.on('before-quit', () => { if (control) control.stopChild(); });
}

// What the window shows first: the choice (first launch), the search for the HP, or the server's screen.
function start() {
  if (!mode) return showChooser();
  if (mode.mode === 'server') return showServerPage();
  startSearch();
}
function showChooser(extra = {}) {
  stopAgent();
  server = null;
  showStartScreen();
  sendState(Object.assign({ state: 'mode', current: mode && mode.mode }, extra));
}

// ---------- Server mode (3-1) ----------
const NEW_SERVER_DIR = path.join(app.getPath('userData'), 'server');
function getControl() {
  if (!mode || mode.mode !== 'server' || !mode.server) return null;
  if (control && control.dir === mode.server.dir) return control;
  if (control) control.stopChild();
  const service = require(path.join(RES, 'server', 'service', 'service.js'));
  // Installed: the task runs this program (see SUPERVISOR_ARG). A development copy can try the server
  // ("start now") but doesn't install a task that points at a development folder.
  const supervisor = path.join(RES, 'server', 'service', 'supervisor.js');
  control = require(path.join(ROOT, 'agent', 'server-control.js')).createControl({
    paths: mode.server, service, exe: process.execPath, supervisor, workDir: path.dirname(path.dirname(supervisor)),
    nodeEnv: { ELECTRON_RUN_AS_NODE: '1' }, canInstall: app.isPackaged
  });
  control.dir = mode.server.dir;
  return control;
}
function showServerPage() {
  stopAgent();
  server = null;
  clearInterval(heartbeat);
  const here = win.webContents.getURL();
  if (!here.startsWith('file://') || !here.endsWith('server.html')) win.loadFile(SERVER_PAGE);
}
// The HP's own interface, from this PC: it's trusted as the HP, so it needs no pairing.
async function openOwnServer() {
  const c = getControl();
  const st = await c.status();
  if (!st.server) throw new Error('The server isn’t running. Start it first.');
  server = { serverId: st.server.serverId, name: st.server.name, address: 'localhost', port: st.port };
  win.loadURL(c.url());
  clearInterval(heartbeat);
  heartbeat = setInterval(checkStillThere, HEARTBEAT_MS);
}

const originOf = s => connect.urlFor(s).replace(/\/$/, '');
// The start screen is connect.html; Server mode's own screen (server.html) is a different page.
const onStartScreen = () => win && /^file:.*connect\.html/.test(win.webContents.getURL());
// Messages are accepted only from the start screen or the confirmed server's own pages.
const trusted = e => {
  const url = (e.senderFrame && e.senderFrame.url) || '';
  return url.startsWith('file://') || (server && url.startsWith(originOf(server) + '/'));
};

function sendState(s) {
  lastState = s;
  if (onStartScreen()) win.webContents.send('hub:state', s);
}

function showStartScreen() {
  clearInterval(heartbeat);
  if (!onStartScreen()) win.loadFile(CONNECT_PAGE);
}

// mode: 'start' (normal), 'lost' (the open server stopped answering), 'change' (the user asked to pick
// another server, so nothing connects on its own).
async function startSearch({ mode = 'start', lost = null } = {}) {
  if (searching || !win) return;
  searching = true;
  stopAgent();
  showStartScreen();
  const from = mode === 'change' ? null : remembered;
  sendState({ state: 'searching', step: from ? 'remembered' : 'broadcast', server: from, lost });
  let r;
  try {
    r = await connect.search({ remembered: from, onProgress: p => sendState(Object.assign({ state: 'searching', lost }, p)) });
  } catch (e) {
    r = { state: 'not-found', heard: 0, error: e.message };
  }
  searching = false;
  if (!win) return;
  if (r.state === 'connected' && mode !== 'change') return useServer(r.server);
  const list = r.state === 'connected' ? [r.server] : r.servers || [];
  if (list.length) {
    choices = list;
    return sendState({ state: 'choose', servers: list, rememberedId: remembered && remembered.serverId });
  }
  sendState(Object.assign({}, r, { lost }));
}

function useServer(s) {
  remembered = saved.save(s);
  server = s;
  sendState({ state: 'connected', server: s });
  setTimeout(() => {
    if (!win || server !== s) return;
    win.loadURL(connect.urlFor(s));
    clearInterval(heartbeat);
    heartbeat = setInterval(checkStillThere, HEARTBEAT_MS);
    startAgent();
  }, 450);
}

// The agent runs while this PC is paired with the open server: its device token is the HttpOnly cookie
// the HP set at pairing, which only the main process can read. The HP itself has no cookie and no agent;
// it measures itself.
async function startAgent() {
  if (!server || !win) return stopAgent();
  const s = server;
  const [c] = await win.webContents.session.cookies.get({ url: connect.urlFor(s), name: 'attic_device' }).catch(() => []);
  if (server !== s) return;
  if (!c) return stopAgent();
  if (agent && agentToken === c.value) return; // a sign-in renews the same cookie
  stopAgent();
  collect = collect || createCollector({ si });
  agentToken = c.value;
  // Files sent to this PC (2-4) are announced over the same connection and collected into the Hub Inbox.
  receiver = createReceiver({ server: s, token: c.value, dir: INBOX, onEvent: ev => {
    if (ev.type === 'received') received.unshift({ name: path.basename(ev.path), path: ev.path, size: ev.transfer.size, at: new Date().toISOString() });
    received.length = Math.min(received.length, 20);
  } });
  agent = createAgent({ url: hubUrl(s), token: c.value, collect, onState: st => { agentState = st; }, onMessage: msg => {
    if (msg.type === 'inbox') receiver.add(msg.transfers);
    else if (msg.type === 'transfer' && msg.transfer) receiver.add([msg.transfer]);
    else if (msg.type === 'transfer-cancelled') receiver.cancel(msg.id);
  } });
}
function stopAgent() {
  if (agent) agent.stop();
  if (receiver) receiver.stop();
  agent = null;
  receiver = null;
  agentToken = null;
  agentState = 'off';
}

// While the interface is open, make sure the HP still answers; two misses in a row go back to searching.
let misses = 0;
async function checkStillThere() {
  if (!server || onStartScreen()) return;
  try {
    const s = await connect.hello(server, { timeoutMs: 4000 });
    misses = s.serverId === server.serverId ? 0 : 2;
  } catch (e) { misses++; }
  if (misses >= 2) {
    misses = 0;
    const lost = server;
    server = null;
    if (mode && mode.mode === 'server') return showServerPage(); // this PC's own server stopped
    startSearch({ mode: 'lost', lost: { name: lost.name } });
  }
}

ipcMain.on('hub:ready', e => { if (trusted(e) && lastState) e.sender.send('hub:state', lastState); });
ipcMain.on('hub:retry', e => { if (trusted(e)) startSearch(); });
ipcMain.on('hub:choose', async (e, id) => {
  if (!trusted(e)) return;
  const pick = choices.find(s => s.serverId === id);
  if (!pick) return;
  sendState({ state: 'checking', address: pick.address });
  try { useServer(await connect.hello(pick)); }
  catch (err) { sendState({ state: 'typed-error', message: err.message, address: pick.address }); }
});
ipcMain.on('hub:connectTo', async (e, text) => {
  if (!trusted(e)) return;
  let target;
  try { target = connect.normalizeAddress(text); }
  catch (err) { return sendState({ state: 'typed-error', message: err.message, address: String(text || '') }); }
  sendState({ state: 'checking', address: target.address });
  try { useServer(await connect.hello(target)); }
  catch (err) { sendState({ state: 'typed-error', message: err.message, address: String(text) }); }
});
ipcMain.handle('hub:current', e => trusted(e) && server
  ? { name: server.name, address: server.address, port: server.port, serverId: server.serverId, url: connect.urlFor(server), agent: agentState,
      mode: mode ? mode.mode : null } : null);
ipcMain.on('hub:change', e => { if (trusted(e)) { server = null; startSearch({ mode: 'change' }); } });

// ---------- the role: server or client (3-1) ----------
ipcMain.on('mode:choose', (e, m) => {
  if (!trusted(e) || !modeLib.MODES.includes(m)) return;
  const was = mode;
  // Back to Server mode keeps its folder; anything else starts that mode fresh.
  mode = modeStore.save(m === 'server' && was && was.server ? { mode: 'server', server: was.server } : { mode: m });
  start();
});
ipcMain.on('mode:change', e => { if (trusted(e)) showChooser({ changing: true }); });

ipcMain.handle('server:state', async e => {
  if (!trusted(e)) return null;
  const c = getControl();
  const drives = ['D', 'E', 'C'].filter(d => fs.existsSync(d + ':\\'));
  return {
    configured: !!c, paths: mode && mode.server, newDir: NEW_SERVER_DIR, installable: app.isPackaged,
    suggestedStorage: `${drives[0] || 'C'}:\\Attic`,
    status: c ? await c.status() : null, logs: c ? c.logs(30) : []
  };
});
ipcMain.handle('server:pickFolder', async (e, title) => {
  if (!trusted(e)) return null;
  const r = await dialog.showOpenDialog(win, { title: String(title || 'Choose a folder'), properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
// Set up: a new server in the tool's folder, or an existing server folder. Errors come back as text.
ipcMain.handle('server:setup', async (e, opts) => {
  if (!trusted(e)) return { error: 'Not allowed' };
  try {
    const p = opts && opts.existing ? modeLib.checkExisting(opts.existing)
      : modeLib.createServer(NEW_SERVER_DIR, { shares: (opts && opts.shares) || [], port: opts && opts.port });
    mode = modeStore.save({ mode: 'server', server: { dir: p.dir, config: p.config, data: p.data } });
    return { ok: true };
  } catch (err) { return { error: err.message }; }
});
// Forget the folder (nothing on disk is deleted), to set up again.
ipcMain.handle('server:forget', async e => {
  if (!trusted(e)) return null;
  if (control) { await control.stop().catch(() => {}); control = null; }
  mode = modeStore.save({ mode: 'server' });
  return { ok: true };
});
ipcMain.handle('server:action', async (e, name) => {
  if (!trusted(e)) return { error: 'Not allowed' };
  const c = getControl();
  const fn = c && { install: c.install, remove: c.remove, start: c.start, stop: c.stop, restart: c.restart, startNow: c.startNow }[name];
  if (!fn) return { error: 'Set up the server first.' };
  try { await fn(); return { ok: true }; } catch (err) { return { error: err.message }; }
});
ipcMain.handle('server:open', async e => {
  if (!trusted(e)) return { error: 'Not allowed' };
  try { await openOwnServer(); return { ok: true }; } catch (err) { return { error: err.message }; }
});
ipcMain.on('server:controls', e => { if (trusted(e) && mode && mode.mode === 'server') showServerPage(); });

// The Hub Inbox (2-4): where it is, and opening it in File Explorer (made first if nothing has arrived yet).
ipcMain.handle('inbox:path', e => trusted(e) ? INBOX : null);
ipcMain.handle('inbox:recent', e => trusted(e) ? received.map(r => ({ name: r.name, size: r.size, at: r.at })) : []);
ipcMain.handle('inbox:open', async e => {
  if (!trusted(e)) return 'Not allowed';
  try { await require('fs').promises.mkdir(INBOX, { recursive: true }); } catch (err) { return err.message; }
  return shell.openPath(INBOX); // '' when it opened
});

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 400,
    minHeight: 560,
    title: 'Attic Hub',
    icon: path.join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: ['--attic-version=' + app.getVersion(), '--attic-host=' + encodeURIComponent(HOSTNAME), '--attic-os=' + encodeURIComponent(OS_NAME)],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win.show());

  // The HP's device cookie (2-2) is this PC's pairing. Write it to disk as soon as it arrives or changes,
  // so a crash or power cut straight after pairing doesn't lose it.
  const cookies = win.webContents.session.cookies;
  // Pairing also starts the live-stats agent (2-3), and unpairing stops it.
  cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (cookie.name !== 'attic_device') return;
    cookies.flushStore().catch(() => {});
    if (removed) { if (cookie.value === agentToken) stopAgent(); }
    else startAgent();
  });
  win.loadFile(mode && mode.mode === 'server' ? SERVER_PAGE : CONNECT_PAGE);

  // The window shows only the start screen and the confirmed server's pages. Anything else (the
  // requirements doc, for example) opens in the default browser.
  const allowed = url => url.startsWith('file://') || (server && (url === connect.urlFor(server) || url.startsWith(originOf(server) + '/')));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !allowed(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (allowed(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  // The HP went away while loading its page: search again rather than show a browser error.
  win.webContents.on('did-fail-load', (event, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !server || !url.startsWith(originOf(server))) return; // -3: navigation replaced
    const lost = server;
    server = null;
    if (mode && mode.mode === 'server') return showServerPage();
    startSearch({ mode: 'lost', lost: { name: lost.name } });
  });

  win.on('closed', () => { stopAgent(); win = null; clearInterval(heartbeat); });
}

app.on('window-all-closed', () => { if (!SUPERVISOR_ARG) app.quit(); });
