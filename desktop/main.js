// Attic Hub desktop shell. Phase 2, milestone 2-1: on start it finds the HP on the home network
// (agent/connect.js), shows a "Looking for server" screen meanwhile, and then opens the interface the HP
// serves, so sign-in and every file call go to the real server. A typed address is the fallback.
// Tray, notifications, Explorer integration and Server/Client mode arrive in later phases.
const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron');
const path = require('path');

// Packaged builds carry ui/, agent/ and server/discovery.js inside the app; in development they sit
// next to desktop/.
const ROOT = app.isPackaged ? __dirname : path.join(__dirname, '..');
const CONNECT_PAGE = path.join(ROOT, 'ui', 'connect.html');
const connect = require(path.join(ROOT, 'agent', 'connect.js'));

const HEARTBEAT_MS = 15e3; // how often an open session checks the HP is still there
let win = null;
let remembered = null;     // the server used last time (from user data)
let server = null;         // the server whose interface is open now
let lastState = null;      // the start screen's current state, replayed when it (re)loads
let choices = [];          // servers offered on a "choose" screen
let searching = false;
let heartbeat = 0;
let saved = null;

// One window only: a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
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
    createWindow();
    startSearch();
  });
}

const originOf = s => connect.urlFor(s).replace(/\/$/, '');
const onStartScreen = () => win && win.webContents.getURL().startsWith('file://');
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
  }, 450);
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
  ? { name: server.name, address: server.address, port: server.port, serverId: server.serverId, url: connect.urlFor(server) } : null);
ipcMain.on('hub:change', e => { if (trusted(e)) { server = null; startSearch({ mode: 'change' }); } });

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
      additionalArguments: ['--attic-version=' + app.getVersion()],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(CONNECT_PAGE);

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
    startSearch({ mode: 'lost', lost: { name: lost.name } });
  });

  win.on('closed', () => { win = null; clearInterval(heartbeat); });
}

app.on('window-all-closed', () => app.quit());
