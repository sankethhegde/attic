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
// Milestone 3-2 (T-04, T-05): the tool lives in the system tray (desktop/tray.js). Closing the window
// hides it; a client starts with Windows, hidden, unless that's turned off; a file received into the Hub
// Inbox shows a Windows notification, and so do the HP's events for transfers this PC sent and devices
// going and coming (agent/notify.js). Preferences are per PC (agent/prefs.js).
// Milestone 3-3 (T-06 to T-08): the Hub Inbox folder, File Explorer's "Send to Attic Hub", and drops.
// Milestone 3-4 (T-09): low-resource mode, for the ROG Ally. While a game runs (agent/game-watch.js), or
// always if chosen, the agent reports every 15 s instead of 3 s, battery and network are read every 2
// minutes instead of 30 s, and the interface drops its animations, blur and background slideshow.
const { app, BrowserWindow, Menu, shell, ipcMain, dialog, Notification } = require('electron');
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
    // A server that falls asleep can't be reached (Wi-Fi fix, 8 Nov 2026): while it runs, Windows doesn't
    // put the HP to sleep when idle. Closing the lid is Windows' own setting (Server mode says so).
    app.whenReady().then(() => { try { require('electron').powerSaveBlocker.start('prevent-app-suspension'); } catch (e) { /* not available */ } });
  }
}
const connect = require(path.join(ROOT, 'agent', 'connect.js'));
const { createAgent, hubUrl } = require(path.join(ROOT, 'agent', 'hub-agent.js'));
const { createCollector } = require(path.join(ROOT, 'agent', 'stats.js'));
const inbox = require(path.join(ROOT, 'agent', 'inbox.js'));
const { createReceiver } = require(path.join(ROOT, 'agent', 'receiver.js'));
// Where received files land (2-4): the folder chosen in Settings (3-3), else Downloads\Attic Hub Inbox.
// ATTIC_INBOX points tests elsewhere by default. prefs is loaded once the app is ready.
const inboxDir = () => (prefs && prefs.inboxDir) || process.env.ATTIC_INBOX || inbox.defaultFolder();
const openInbox = () => { fs.mkdirSync(inboxDir(), { recursive: true }); return shell.openPath(inboxDir()); };
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

// ---------- tray, start-up and notifications (3-2) ----------
const prefsStore = require(path.join(ROOT, 'agent', 'prefs.js')).store(path.join(app.getPath('userData'), 'prefs.json'));
const { createNotifier, createEventFeed } = require(path.join(ROOT, 'agent', 'notify.js'));
const ICON = path.join(__dirname, 'build', 'icon.png');
// Started with Windows: straight to the tray. Also after an update installed itself at sign-in, which leaves
// a note to come back hidden (0.12.1).
const RELAUNCH_HIDDEN = path.join(app.getPath('userData'), 'relaunch-hidden');
const STARTED_HIDDEN = process.argv.includes('--hidden') || (!SUPERVISOR_ARG && (() => { try { fs.rmSync(RELAUNCH_HIDDEN); return true; } catch (e) { return false; } })());
const TEST_HOOKS = process.env.ATTIC_TEST_HOOKS === '1';  // the end-to-end tests read the tray and notifications
let prefs = null;
let tray = null;
let quitting = false;
const shownNotes = [];      // what was shown, for the tests (TEST_HOOKS only)

function notify(title, body, onClick) {
  if (TEST_HOOKS) shownNotes.push({ title, body, at: Date.now() });
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: ICON, silent: false });
  if (onClick) n.on('click', onClick);
  n.show();
}
const notifier = createNotifier({
  show: notify,
  reveal: p => shell.showItemInFolder(p),
  openInbox,
  enabled: () => !!(prefs && prefs.notify.received)
});

// Windows starts the installed tool at sign-in, hidden in the tray. A development copy only keeps the
// preference: registering electron.exe to start with Windows would be wrong.
function applyStartWithWindows() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  app.setLoginItemSettings({ openAtLogin: !!prefs.startWithWindows, path: process.execPath, args: ['--hidden'] });
}
function setPrefs(patch) {
  prefs = prefsStore.save(patch, mode && mode.mode);
  applyStartWithWindows();
  if (typeof patch.explorerMenu === 'boolean') applyExplorerMenu();
  if (patch.lowResource) startGameWatch();
  updateTray();
  return prefs;
}
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function trayStatus() {
  if (!mode) return 'Not set up yet';
  if (mode.mode === 'server') return control && control.lastUp != null ? (control.lastUp ? 'Server running' : 'Server stopped') : 'Server mode';
  if (server) return `Connected to ${server.name}`;
  return searching ? 'Looking for the server…' : 'Not connected';
}
function updateTray() { if (tray) tray.update(); }
function quitApp() { quitting = true; app.quit(); }

// One window only: a second launch focuses the first. The startup task's run above is not a window.
if (SUPERVISOR_ARG) {
  // nothing else to do: the supervisor runs until it's asked to stop
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.sankethhegde.attichub'); // so Windows shows notifications as Attic Hub
  // A second launch shows the window; one from File Explorer's "Send to Attic Hub" (3-3) also brings files.
  app.on('second-instance', (_e, argv) => { showWindow(); queueSend(explorer.sendPaths(argv)); });
  app.whenReady().then(() => {
    saved = connect.store(path.join(app.getPath('userData'), 'server.json'));
    remembered = saved.load();
    mode = modeStore.load();
    prefs = prefsStore.load(mode && mode.mode);
    applyStartWithWindows();
    applyExplorerMenu();
    pendingSend.push(...explorer.sendPaths(process.argv)); // started from File Explorer
    createWindow();
    tray = require('./tray.js').createTray({
      iconPath: ICON,
      getState: () => ({ status: trayStatus(), mode: mode && mode.mode, startWithWindows: prefs.startWithWindows,
        canStartWithWindows: app.isPackaged, notify: prefs.notify, low: lowOut(), update: updateOut() }),
      actions: {
        open: showWindow,
        openInbox,
        serverControls: () => { showWindow(); if (mode && mode.mode === 'server') showServerPage(); },
        toggleStart: () => setPrefs({ startWithWindows: !prefs.startWithWindows }),
        toggleNotify: group => setPrefs({ notify: { [group]: !prefs.notify[group] } }),
        setLowResource: m => setPrefs({ lowResource: m }),
        installUpdate: () => installUpdate(),
        quit: quitApp
      }
    });
    // The server's state, for the tray, without asking Windows every time: just whether it answers.
    setInterval(async () => {
      if (!mode || mode.mode !== 'server' || !getControl()) return;
      control.lastUp = !!(await require(path.join(ROOT, 'agent', 'server-control.js')).hello(+new URL(control.url()).port, 1500));
      updateTray();
    }, 5000).unref();
    start();
    resumeAfterUpdate();
    // Waking from sleep: look for the HP at once rather than at the next scheduled try.
    require('electron').powerMonitor.on('resume', () => { if (!server && mode && mode.mode === 'client' && onStartScreen() && !searching) startSearch({ auto: true }); });
  });
  // "Start now" runs the server as a child of the tool; it stops with the tool.
  app.on('before-quit', () => { quitting = true; if (control) control.stopChild(); installOnQuit(); });
}

// What the window shows first: the choice (first launch), the search for the HP, or the server's screen.
function start() {
  if (!mode) return showChooser();
  startGameWatch(); // only a client watches for games; the role may just have changed
  scheduleUpdateChecks();
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
  updateTray();
}

function showStartScreen() {
  clearInterval(heartbeat);
  if (!onStartScreen()) win.loadFile(CONNECT_PAGE);
}

// mode: 'start' (normal), 'lost' (the open server stopped answering), 'change' (the user asked to pick
// another server, so nothing connects on its own).
// Wi-Fi fix (8 Nov 2026): nothing found is no longer the end. The tool searches again by itself (after 3,
// 5, 10, then every 15 s; every 30 s after two minutes) until the HP answers, so a server still starting
// up, or a broadcast lost on Wi-Fi, needs no "Search again". Waking from sleep searches at once.
const AUTO_RETRY_MS = [3e3, 5e3, 10e3, 15e3];
let autoRetry = 0, attempt = 0, autoStartedAt = 0;
function stopAutoRetry() { clearTimeout(autoRetry); autoRetry = 0; }
async function startSearch({ mode = 'start', lost = null, auto = false } = {}) {
  if (searching || !win) return;
  stopAutoRetry();
  if (!auto) { attempt = 0; autoStartedAt = Date.now(); }
  attempt++;
  searching = true;
  stopAgent();
  showStartScreen();
  const from = mode === 'change' ? null : remembered;
  sendState({ state: 'searching', step: from ? 'remembered' : 'broadcast', server: from, lost, attempt });
  let r;
  try {
    r = await connect.search({ remembered: from, onProgress: p => sendState(Object.assign({ state: 'searching', lost, attempt }, p)) });
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
  // Not found: try again by itself, unless the user is picking another server by hand.
  let retryIn = 0;
  if (mode !== 'change') {
    retryIn = Date.now() - autoStartedAt > 120e3 ? 30e3 : AUTO_RETRY_MS[Math.min(attempt - 1, AUTO_RETRY_MS.length - 1)];
    if (process.env.ATTIC_AUTO_RETRY_MS) retryIn = +process.env.ATTIC_AUTO_RETRY_MS; // tests
    autoRetry = setTimeout(() => { if (!server && !searching && onStartScreen()) startSearch({ mode, lost, auto: true }); }, retryIn);
  }
  sendState(Object.assign({}, r, { lost, retryIn, attempt }));
}

function useServer(s) {
  stopAutoRetry();
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
  collect = collect || createCollector({ si, slowMs: () => (low.active ? LOW_SLOW_MS : 30e3) });
  agentToken = c.value;
  // Files sent to this PC (2-4) are announced over the same connection and collected into the Hub Inbox.
  receiver = createReceiver({ server: s, token: c.value, dir: inboxDir, onEvent: ev => {
    if (ev.type !== 'received') return;
    received.unshift({ name: path.basename(ev.path), path: ev.path, size: ev.transfer.size, at: new Date().toISOString() });
    received.length = Math.min(received.length, 20);
    notifier.received({ path: ev.path, size: ev.transfer.size, fromName: ev.transfer.fromName }); // 3-2
  } });
  // The HP's notification events (3-2): transfers this PC sent, and devices going and coming.
  const token = c.value;
  const feed = createEventFeed({
    fetchEvents: async after => {
      const r = await fetch(`${connect.urlFor(s)}api/events?after=${after}`, { headers: { 'X-Attic-Device': token } });
      if (!r.ok) throw new Error('events ' + r.status);
      return r.json();
    },
    getLast: () => (prefs.seen[s.serverId] == null ? null : prefs.seen[s.serverId]),
    setLast: seq => { prefs = prefsStore.save({ seen: { [s.serverId]: seq } }, mode && mode.mode); },
    show: (title, body) => notify(title, body, showWindow),
    enabled: group => group === 'accounts' || !!prefs.notify[group] // sign-ups and approvals: always
  });
  agent = createAgent({ url: hubUrl(s), token: c.value, collect, pace: statsPace, onState: st => { agentState = st; }, onMessage: msg => {
    if (msg.type === 'event' || msg.type === 'events') feed.handle(msg);
    else if (msg.type === 'inbox') receiver.add(msg.transfers);
    else if (msg.type === 'transfer' && msg.transfer) receiver.add([msg.transfer]);
    else if (msg.type === 'transfer-cancelled') receiver.cancel(msg.id);
    else if (msg.type === 'update') getUpdater().offer(msg.latest); // 3-5: on connect, and when one is published
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
  stopAutoRetry();
  sendState({ state: 'checking', address: pick.address });
  try { useServer(await connect.hello(pick)); }
  catch (err) { sendState({ state: 'typed-error', message: err.message, address: pick.address }); }
});
ipcMain.on('hub:connectTo', async (e, text) => {
  if (!trusted(e)) return;
  let target;
  try { target = connect.normalizeAddress(text); }
  catch (err) { return sendState({ state: 'typed-error', message: err.message, address: String(text || '') }); }
  stopAutoRetry();
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
  // The first choice sets start-with-Windows to suit the role (a client starts with Windows; the server's
  // service already does). A later change of role keeps what was chosen.
  if (!was) setPrefs({ startWithWindows: prefsStore.load(m).startWithWindows && m !== 'server' });
  start();
});
ipcMain.on('mode:change', e => { if (trusted(e)) showChooser({ changing: true }); });

// ---------- the tool's own preferences (3-2) ----------
const prefsOut = p => ({ startWithWindows: p.startWithWindows, notifyReceived: p.notify.received, notifyTransfers: p.notify.transfers,
  notifyDevices: p.notify.devices, canStartWithWindows: app.isPackaged, mode: mode && mode.mode,
  explorerMenu: p.explorerMenu, inboxDefault: !p.inboxDir, lowResource: p.lowResource });
ipcMain.handle('prefs:get', e => trusted(e) && prefs ? prefsOut(prefs) : null);
ipcMain.handle('prefs:set', (e, patch) => {
  if (!trusted(e) || !patch) return null;
  return prefsOut(setPrefs({ startWithWindows: patch.startWithWindows, explorerMenu: patch.explorerMenu, lowResource: patch.lowResource,
    notify: { received: patch.notifyReceived, transfers: patch.notifyTransfers, devices: patch.notifyDevices } }));
});
if (TEST_HOOKS) {
  ipcMain.handle('test:tray', () => tray ? tray.items() : null);
  ipcMain.handle('test:trayClick', (e, label) => tray ? tray.click(String(label)) : false);
  ipcMain.handle('test:notes', () => shownNotes.slice());
  ipcMain.handle('test:window', () => win ? { visible: win.isVisible() } : null);
  ipcMain.handle('test:closeWindow', () => { if (win) win.close(); return true; }); // what the window's X does
  ipcMain.handle('test:loginItem', () => app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] }).openAtLogin);
  ipcMain.handle('test:explorerMenu', () => explorer.status(process.execPath));
  // 3-4: pretend the game watcher saw a game ({ game, why, app }), or null to go back to the real one;
  // and the pace the agent is using now.
  ipcMain.handle('test:game', (e, g) => { testGame = g || null; applyLow(); return lowOut(); });
  ipcMain.handle('test:pace', () => ({ statsMs: statsPace(3000), slowMs: low.active ? LOW_SLOW_MS : 30e3, watcherPid: watcher ? watcher.pid : null }));
}

// This PC on the network, for Server mode's card (8 Nov 2026): its home-network addresses (Wi-Fi or
// Ethernet), its PC name, and whether closing the lid puts it to sleep (Windows' own setting).
function networkInfo() {
  const addresses = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      addresses.push({ address: a.address, via: /wi-?fi|wlan|wireless/i.test(name) ? 'Wi-Fi' : /ethernet|^eth/i.test(name) ? 'Ethernet' : name });
    }
  }
  // Ethernet first: the steadier one to give the other devices.
  addresses.sort((x, y) => (x.via === 'Ethernet' ? 0 : 1) - (y.via === 'Ethernet' ? 0 : 1));
  return { addresses, hostname: HOSTNAME };
}
let lidCache = { at: 0, sleeps: null };
function lidSleeps() {
  if (process.platform !== 'win32' || Date.now() - lidCache.at < 60e3) return Promise.resolve(lidCache.sleeps);
  return new Promise(resolve => require('child_process').execFile('powercfg', ['/q', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION'], { windowsHide: true, timeout: 5000 }, (err, out) => {
    const m = /Current AC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(out || '');
    lidCache = { at: Date.now(), sleeps: m ? parseInt(m[1], 16) !== 0 : null }; // 0 = do nothing
    resolve(lidCache.sleeps);
  }));
}
let awakeBlocker = null; // no idle sleep while this PC's server runs
function keepAwake(on) {
  const { powerSaveBlocker } = require('electron');
  if (on && awakeBlocker === null) awakeBlocker = powerSaveBlocker.start('prevent-app-suspension');
  else if (!on && awakeBlocker !== null) { powerSaveBlocker.stop(awakeBlocker); awakeBlocker = null; }
}
ipcMain.handle('server:state', async e => {
  if (!trusted(e)) return null;
  const c = getControl();
  const drives = ['D', 'E', 'C'].filter(d => fs.existsSync(d + ':\\'));
  const status = c ? await c.status() : null;
  keepAwake(!!(status && status.server));
  return {
    configured: !!c, paths: mode && mode.server, newDir: NEW_SERVER_DIR, installable: app.isPackaged,
    suggestedStorage: `${drives[0] || 'C'}:\\Attic`,
    status, logs: c ? c.logs(30) : [],
    network: Object.assign(networkInfo(), { lidSleeps: await lidSleeps() })
  };
});
// "Keep running with the lid closed": Windows' own setting, for when plugged in only.
ipcMain.handle('server:lidStayAwake', async e => {
  if (!trusted(e)) return null;
  const run = args => new Promise((resolve, reject) => require('child_process').execFile('powercfg', args, { windowsHide: true, timeout: 10000 }, err => err ? reject(err) : resolve()));
  try {
    await run(['/setacvalueindex', 'SCHEME_CURRENT', 'SUB_BUTTONS', 'LIDACTION', '0']);
    await run(['/setactive', 'SCHEME_CURRENT']);
    lidCache.at = 0;
    return { ok: true };
  } catch (err) { return { error: 'Windows didn’t accept it: ' + err.message + ' Set it in Control Panel → Power Options → Choose what closing the lid does.' }; }
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
ipcMain.handle('inbox:path', e => trusted(e) ? inboxDir() : null);
ipcMain.handle('inbox:recent', e => trusted(e) ? received.map(r => ({ name: r.name, size: r.size, at: r.at })) : []);
ipcMain.handle('inbox:open', async e => {
  if (!trusted(e)) return 'Not allowed';
  try { return await openInbox(); } catch (err) { return err.message; } // '' when it opened
});
// Choosing another Hub Inbox folder (3-3, T-07). Files already received stay where they are; the next
// file goes to the new folder. `folder` is for the tests; a person picks one in Windows' folder dialog.
ipcMain.handle('inbox:choose', async (e, folder) => {
  if (!trusted(e)) return { error: 'Not allowed' };
  if (!folder) {
    const r = await dialog.showOpenDialog(win, { title: 'Where should files sent to this PC go?', defaultPath: inboxDir(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return { canceled: true };
    folder = r.filePaths[0];
  }
  try { setPrefs({ inboxDir: await inbox.checkFolder(folder) }); return { path: inboxDir() }; }
  catch (err) { return { error: err.message }; }
});
ipcMain.handle('inbox:reset', e => { if (!trusted(e)) return null; setPrefs({ inboxDir: null }); return { path: inboxDir() }; });

// ---------- Send from File Explorer (3-3, T-06) and by path ----------
// `Attic Hub.exe --send "<path>"` comes from the right-click entry, once per picked item. The paths are
// gathered for a moment, then the interface is asked to show its Send dialog (or picks them up once
// it's signed in). The files are sent from here, by path: the page can't read them.
const explorer = require(path.join(ROOT, 'agent', 'explorer.js'));
const uploader = require(path.join(ROOT, 'agent', 'uploader.js'));
let pendingSend = [], sendTimer = 0, sendJob = null;
const sentPaths = new Map(); // transfer id → path, so Retry can send it again
function queueSend(paths) {
  if (!paths.length) return;
  pendingSend.push(...paths);
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => { showWindow(); if (win && server) win.webContents.send('send:request'); }, 700);
}
ipcMain.handle('send:pending', async e => {
  if (!trusted(e) || !pendingSend.length) return [];
  const paths = [...new Set(pendingSend)];
  pendingSend = [];
  return (await uploader.expand(paths)).map((f, i) => Object.assign(f, { id: 'p' + Date.now().toString(36) + i }));
});
// Files on the HP's own PC (Server mode) or the paired HP, sent with the window's own sign-in.
async function sendBase() {
  if (!server) throw new Error('Attic Hub isn’t connected to the HP.');
  const base = connect.urlFor(server);
  const cookies = await win.webContents.session.cookies.get({ url: base });
  return { base, cookie: cookies.map(c => `${c.name}=${c.value}`).join('; ') };
}
ipcMain.handle('send:upload', async (e, { files, to }) => {
  if (!trusted(e)) return { error: 'Not allowed' };
  try {
    const { base, cookie } = await sendBase();
    sendJob = uploader.send({ base, cookie, files, to,
      onProgress: p => { if (win) win.webContents.send('send:progress', p); },
      onSent: (id, f) => sentPaths.set(id, f.path) });
    const out = await sendJob.promise;
    return { transfers: out };
  } catch (err) { return { error: err.message, code: err.code }; }
  finally { sendJob = null; }
});
ipcMain.on('send:cancel', e => { if (trusted(e) && sendJob) sendJob.cancel(); });
ipcMain.handle('send:hasPath', (e, id) => trusted(e) && sentPaths.has(id));
// Retry for a file that was sent by path: the same file again, by its path.
ipcMain.handle('send:resend', async (e, t) => {
  if (!trusted(e) || !sentPaths.has(t.id)) return { error: 'Choose the file to send again.' };
  try {
    const { base, cookie } = await sendBase();
    const p = sentPaths.get(t.id);
    const size = (await fs.promises.stat(p)).size;
    if (size !== t.size) return { error: `${path.basename(p)} has changed since it was sent. Send it again from File Explorer.` };
    await new Promise((resolve, reject) => {
      const req = require('http').request(new URL(`/api/transfers/${encodeURIComponent(t.id)}/file`, base),
        { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream', 'X-Attic-Upload': '1', 'Content-Length': size } },
        res => { res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error(`The HP answered ${res.statusCode}.`))); });
      req.on('error', reject);
      fs.createReadStream(p).pipe(req);
    });
    return { ok: true };
  } catch (err) { return { error: err.message }; }
});

// ---------- low-resource mode (3-4, T-09) ----------
// Automatic watches for a game with a small helper (agent/game-watch.js), compiled once into the tool's
// user-data folder. It runs only while Automatic is chosen on a client; Always on needs no watching.
const gameWatch = require(path.join(ROOT, 'agent', 'game-watch.js'));
const LOW_STATS_MS = 15e3;   // a report every 15 s instead of every 3 s
const LOW_SLOW_MS = 120e3;   // battery and network (PowerShell each time) every 2 minutes instead of 30 s
let watcher = null, watchStarting = false, watchProblem = null, game = null, testGame = null, watchRetry = 0;
let low = { active: false, reason: null };
function statsPace(ms) { return low.active ? Math.max(ms, LOW_STATS_MS) : ms; }
// For Settings and the tray: the choice, whether it's on now and why, and whether games can be seen.
function lowOut() {
  const pref = prefs ? prefs.lowResource : 'auto';
  const client = !!mode && mode.mode === 'client';
  const detect = pref !== 'auto' || !client ? 'off' : testGame || (watcher && watcher.state) ? 'ok' : watchProblem ? 'unavailable' : 'starting';
  return { pref, active: low.active, reason: low.reason || null, app: low.app || null, detect, problem: watchProblem,
    statsSeconds: Math.round(statsPace(3000) / 1000) };
}
function applyLow() {
  if (!prefs) return;
  const pref = mode && mode.mode === 'server' && prefs.lowResource === 'auto' ? 'off' : prefs.lowResource;
  const next = gameWatch.decide(pref, testGame || game);
  const flipped = next.active !== low.active;
  low = next;
  if (flipped && agent) agent.nudge(); // the new pace starts now, not after the old wait
  if (flipped && !low.active && updater) updater.retry(); // an update held back during the game (3-5)
  if (win && !win.isDestroyed()) win.webContents.send('low:state', lowOut());
  updateTray();
}
async function startGameWatch() {
  if (!prefs) return;
  const want = prefs.lowResource === 'auto' && !!mode && mode.mode === 'client' && process.platform === 'win32';
  if (!want) { stopGameWatch(); return applyLow(); }
  if (watcher || watchStarting) return applyLow();
  watchStarting = true;
  try {
    const exe = await gameWatch.ensureHelper(path.join(app.getPath('userData'), 'helpers'));
    if (!exe) throw new Error('This PC has no .NET Framework C# compiler, so Attic Hub can’t tell when a game runs.');
    if (prefs.lowResource !== 'auto') return;
    watchProblem = null;
    // Tests point the Steam check at a key of their own, and check more often.
    const args = [];
    if (process.env.ATTIC_STEAM_KEY) args.push('--steam-key', process.env.ATTIC_STEAM_KEY);
    if (process.env.ATTIC_GAMEWATCH_MS) args.push('--every', process.env.ATTIC_GAMEWATCH_MS);
    const w = watcher = gameWatch.watch({ exe, args, onChange: s => { game = s; applyLow(); },
      onExit: () => {
        if (watcher !== w) return;
        watcher = null; game = null; applyLow();
        clearTimeout(watchRetry); watchRetry = setTimeout(startGameWatch, 10e3);
      } });
  } catch (err) { watchProblem = err.message; }
  finally { watchStarting = false; applyLow(); }
}
function stopGameWatch() {
  clearTimeout(watchRetry);
  if (watcher) { const w = watcher; watcher = null; w.stop(); }
  game = null;
}
app.on('will-quit', stopGameWatch);
ipcMain.handle('low:get', e => trusted(e) ? lowOut() : null);

// ---------- updates from the HP (3-5, T-10) ----------
// The HP announces its newest installer to the agent (on connect, and when one is published); the tool
// also asks now and then, and when Settings says Check now. A newer one downloads in the background
// (not during a game: low-resource mode holds it), is checked against the HP's SHA-512, and then the
// tool offers "Restart to update": the installer runs silently and starts Attic Hub again.
// On the HP itself (Server mode) it asks its own server, and installing stops the service first and
// starts it again after the update.
const { createUpdater } = require(path.join(ROOT, 'agent', 'updater.js'));
const UPDATE_DIR = path.join(app.getPath('userData'), 'updates');
const RESUME_FILE = path.join(app.getPath('userData'), 'update-resume.json');
const CHECK_CLIENT_MS = 4 * 3600e3;  // GitHub, then the HP (which also tells the agent at once)
const CHECK_SERVER_MS = 3600e3;      // the HP: GitHub hourly (its own copy is cheap to ask)
// 0.12.1, like PixHaven: GitHub's newest published release (github.com/sankethhegde/attic/releases).
// Only the installed app asks GitHub; development copies and the tests don't, unless ATTIC_GITHUB_API
// points them at a stand-in ('off' turns it off anywhere).
const GITHUB = process.env.ATTIC_GITHUB_API === 'off' ? null
  : process.env.ATTIC_GITHUB_API ? { api: process.env.ATTIC_GITHUB_API, owner: 'sankethhegde', repo: 'attic' }
  : app.isPackaged && !TEST_HOOKS ? { owner: 'sankethhegde', repo: 'attic' } : null;
let installing = false, autoTried = false;
const canInstall = () => app.isPackaged || (TEST_HOOKS && process.env.ATTIC_DEV_INSTALL === '1');
let updater = null, checkTimer = 0;
function updateServer() {
  if (mode && mode.mode === 'server') {
    const c = getControl();
    if (!c) return null;
    const u = new URL(c.url());
    u.hostname = '127.0.0.1'; // the HP trusts its own address, so it needs no pairing to ask itself
    return { base: u.href, headers: {} };
  }
  if (!server || !agentToken) return null; // a client asks as its paired device
  return { base: connect.urlFor(server), headers: { 'X-Attic-Device': agentToken } };
}
function getUpdater() {
  if (updater) return updater;
  updater = createUpdater({ current: app.getVersion(), dir: UPDATE_DIR, server: updateServer, github: GITHUB, canDownload: () => !low.active, onState: s => {
    if (win && !win.isDestroyed()) win.webContents.send('update:state', updateOut());
    updateTray();
    // Once per version: a notification that it's ready. Clicking it shows where to install it.
    if (s.status === 'ready' && s.latest && prefs.updateShown !== s.latest.version) {
      setPrefs({ updateShown: s.latest.version });
      notify(`Attic Hub ${s.latest.version} is ready`, 'It installs itself the next time Attic Hub starts or quits. To update now, choose Restart to update in the tray.', showUpdates);
    }
    // Started with Windows and still in the tray: install now, unseen, and come back hidden.
    if (s.status === 'ready' && STARTED_HIDDEN && !autoTried && canInstall() && !low.active && win && !win.isVisible() && process.uptime() < 900) {
      autoTried = true;
      installUpdate({ hidden: true }).catch(() => {});
    }
  } });
  return updater;
}
function updateOut() {
  const s = updater ? updater.state : { status: 'idle', current: app.getVersion(), latest: null, done: 0, error: null };
  return Object.assign({}, s, { canInstall: canInstall(), mode: mode && mode.mode, low: low.active });
}
function scheduleUpdateChecks() {
  clearInterval(checkTimer);
  if (!mode) return;
  const server_ = mode.mode === 'server';
  const ask = () => { if (GITHUB || updateServer()) getUpdater().check(); };
  checkTimer = setInterval(ask, server_ ? CHECK_SERVER_MS : CHECK_CLIENT_MS);
  checkTimer.unref();
  // Soon after start: GitHub (or the HP, once its server answers or this PC is paired).
  setTimeout(ask, +process.env.ATTIC_UPDATE_FIRST_MS || (GITHUB ? 30e3 : 5000)).unref(); // tests: sooner
}
function showUpdates() {
  showWindow();
  if (!win) return;
  if (mode && mode.mode === 'server') return; // Server mode's screen shows it at the top
  win.webContents.send('update:open');
}
// opts.hidden: at sign-in, unseen (the new version starts in the tray). opts.relaunch false: on quit.
async function installUpdate(opts = {}) {
  if (!canInstall()) return { error: 'Only the installed Attic Hub can update itself: this is a development copy.' };
  if (installing) return { ok: true };
  const r = await getUpdater().installer();
  if (r.error) return r;
  installing = true;
  if (opts.hidden) { try { fs.writeFileSync(RELAUNCH_HIDDEN, '1'); } catch (e) { /* it shows its window instead */ } }
  // The HP: the service runs this same program, so it stops for the update and starts again afterwards.
  if (mode && mode.mode === 'server' && getControl()) {
    try {
      const st = await control.status();
      if (st.task && st.task.ours && st.server) {
        await control.stop();
        fs.writeFileSync(RESUME_FILE, JSON.stringify({ startService: true, from: app.getVersion(), to: r.version }));
      }
    } catch (e) { return { error: 'Couldn’t stop the server for the update: ' + e.message }; }
  }
  require('child_process').spawn(r.file, r.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  setTimeout(quitApp, 300);
  return { ok: true, version: r.version };
}
// Quitting Attic Hub with an update downloaded installs it, without starting it again (like PixHaven).
// Not on the HP: its service runs this program, so the HP updates at sign-in or from Restart to update.
function installOnQuit() {
  if (installing || !updater || updater.state.status !== 'ready' || !canInstall() || (mode && mode.mode === 'server')) return;
  const st = updater.state;
  const file = path.join(UPDATE_DIR, st.latest.fileName);
  if (!fs.existsSync(file)) return;
  installing = true;
  require('child_process').spawn(file, ['/S', '--updated'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
// After an update on the HP: start the service again.
async function resumeAfterUpdate() {
  let flag;
  try { flag = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8')); } catch (e) { return; }
  fs.rmSync(RESUME_FILE, { force: true });
  if (flag.startService && getControl()) { try { await control.start(); } catch (e) { /* Server mode's screen shows it stopped */ } }
}
ipcMain.handle('update:get', e => trusted(e) ? updateOut() : null);
ipcMain.handle('update:check', async e => {
  if (!trusted(e)) return null;
  if (!GITHUB && !updateServer()) return Object.assign(updateOut(), { status: 'error', error: 'Attic Hub isn’t connected to the HP (or this PC isn’t paired yet).' });
  await getUpdater().check();
  return updateOut();
});
ipcMain.handle('update:install', e => trusted(e) ? installUpdate() : null);

// The right-click entry follows its preference, in the installed app only (a development copy would
// point Explorer at electron.exe).
async function applyExplorerMenu() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  try {
    if (prefs.explorerMenu) { if ((await explorer.status(process.execPath)) !== 'ours') await explorer.register(process.execPath); }
    else if ((await explorer.status(process.execPath)) !== 'none') await explorer.unregister();
  } catch (e) { /* the menu entry is a convenience; the tool works without it */ }
}

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
      additionalArguments: ['--attic-version=' + app.getVersion(), '--attic-host=' + encodeURIComponent(HOSTNAME), '--attic-os=' + encodeURIComponent(OS_NAME)]
        .concat(TEST_HOOKS ? ['--attic-test=1'] : []),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  // Started with Windows: stay in the tray until opened.
  win.once('ready-to-show', () => { if (!STARTED_HIDDEN) win.show(); });

  // Closing the window keeps Attic Hub running in the tray (3-2): the agent keeps reporting and collecting
  // files. The first time, a notification says where it went. Quit is in the tray's menu.
  win.on('close', e => {
    if (quitting || !tray) return;
    e.preventDefault();
    win.hide();
    if (!prefs.trayHintShown) {
      setPrefs({ trayHintShown: true });
      notify('Attic Hub is still running', mode && mode.mode === 'server'
        ? 'It’s in the system tray. The server keeps running either way.'
        : 'It’s in the system tray, so files sent to this PC still arrive. Quit from the tray icon’s menu.', showWindow);
    }
  });

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
