// The bridge between the window and the desktop tool. It tells the interface it runs inside the tool,
// and (Phase 2, 2-1) lets the start screen drive the search for the HP and Settings show or change it.
// Phase 3, 3-1: the server-or-client choice, and Server mode's controls. 3-2: the tool's preferences.
const { contextBridge, ipcRenderer } = require('electron');

const arg = name => {
  const a = process.argv.find(x => x.startsWith(`--attic-${name}=`));
  try { return a ? decodeURIComponent(a.slice(name.length + 9)) : null; } catch (e) { return null; }
};

contextBridge.exposeInMainWorld('atticDesktop', {
  isDesktop: true,
  version: arg('version'),
  platform: process.platform,
  // Suggested on the pairing screen (2-2): this PC's name and Windows version.
  hostname: arg('host'),
  osName: arg('os'),
  // The start screen: follow the search, retry it, pick a server, or type an address.
  hub: {
    onState: cb => { ipcRenderer.on('hub:state', (_e, s) => cb(s)); },
    ready: () => ipcRenderer.send('hub:ready'),
    retry: () => ipcRenderer.send('hub:retry'),
    choose: id => ipcRenderer.send('hub:choose', String(id)),
    connectTo: text => ipcRenderer.send('hub:connectTo', String(text))
  },
  // Settings: which HP this tool is using, and a way back to the start screen to pick another.
  server: {
    current: () => ipcRenderer.invoke('hub:current'),
    change: () => ipcRenderer.send('hub:change')
  },
  // The Hub Inbox (2-4): where files sent to this PC land.
  inbox: {
    path: () => ipcRenderer.invoke('inbox:path'),
    recent: () => ipcRenderer.invoke('inbox:recent'),
    open: () => ipcRenderer.invoke('inbox:open')
  },
  // This PC's role (3-1): the first-launch choice, and changing it later from Settings.
  mode: {
    choose: m => ipcRenderer.send('mode:choose', String(m)),
    change: () => ipcRenderer.send('mode:change')
  },
  // Server mode's screen (3-1): set up the server, run it as a Windows service, and open its interface.
  serverMode: {
    state: () => ipcRenderer.invoke('server:state'),
    pickFolder: title => ipcRenderer.invoke('server:pickFolder', String(title || '')),
    setup: opts => ipcRenderer.invoke('server:setup', JSON.parse(JSON.stringify(opts || {}))),
    forget: () => ipcRenderer.invoke('server:forget'),
    action: name => ipcRenderer.invoke('server:action', String(name)),
    open: () => ipcRenderer.invoke('server:open'),
    controls: () => ipcRenderer.send('server:controls')
  },
  // This PC's own preferences (3-2): start with Windows, and notifications for received files.
  prefs: {
    get: () => ipcRenderer.invoke('prefs:get'),
    set: patch => ipcRenderer.invoke('prefs:set', JSON.parse(JSON.stringify(patch || {})))
  },
  // The end-to-end tests only (ATTIC_TEST_HOOKS=1): the tray menu and the notifications shown.
  test: arg('test') ? {
    tray: () => ipcRenderer.invoke('test:tray'),
    trayClick: label => ipcRenderer.invoke('test:trayClick', String(label)),
    notes: () => ipcRenderer.invoke('test:notes'),
    window: () => ipcRenderer.invoke('test:window'),
    closeWindow: () => ipcRenderer.invoke('test:closeWindow'),
    loginItem: () => ipcRenderer.invoke('test:loginItem')
  } : undefined
});
