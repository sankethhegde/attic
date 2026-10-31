// Attic Hub desktop shell (Phase 1B): one window that hosts the existing interface from ui/.
// Tray, notifications, Explorer integration and Server/Client mode arrive in later phases.
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

// Packaged builds carry ui/ inside the app; in development it sits next to desktop/.
const UI_INDEX = app.isPackaged
  ? path.join(__dirname, 'ui', 'index.html')
  : path.join(__dirname, '..', 'ui', 'index.html');

let win = null;

// One window only: a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(createWindow);
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
      additionalArguments: ['--attic-version=' + app.getVersion()],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(UI_INDEX);

  // The interface is local files only. Web links (the requirements doc, for example) open in the
  // default browser; nothing navigates the app window away from ui/.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => { win = null; });
}

app.on('window-all-closed', () => app.quit());
