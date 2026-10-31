// Tells the interface it is running inside the desktop tool. Nothing else crosses the bridge yet;
// later phases add mode, Hub Inbox and notification calls here.
const { contextBridge } = require('electron');

const arg = (process.argv.find(a => a.startsWith('--attic-version=')) || '').split('=')[1];

contextBridge.exposeInMainWorld('atticDesktop', {
  isDesktop: true,
  version: arg || null,
  platform: process.platform
});
