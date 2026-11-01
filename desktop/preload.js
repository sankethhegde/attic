// The bridge between the window and the desktop tool. It tells the interface it runs inside the tool,
// and (Phase 2, 2-1) lets the start screen drive the search for the HP and Settings show or change it.
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
  }
});
