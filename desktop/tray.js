// tray.js — Phase 3, milestone 3-2 (T-04): Attic Hub in the system tray.
//
// Closing the window hides it; the tool keeps running in the tray, so the agent keeps reporting stats and
// collecting files. The menu says what the tool is doing, opens the window, the Hub Inbox (a client) or
// the server's controls (the server), switches start-with-Windows and received-file notifications, and
// quits. Clicking the icon opens the window. The menu is rebuilt whenever its state changes.
// 3-4 (T-09): on a client, low-resource mode's choice (Automatic, Always on, Off), and a line saying
// when it's on.
'use strict';
const { Tray, Menu, nativeImage } = require('electron');

// getState() → { status, mode, startWithWindows, canStartWithWindows, notify: { received, transfers, devices },
//   low: { pref, active, reason, app } }
//   update: the updater's state (3-5), for "Restart to update to …" once one is downloaded
// actions: { open, openInbox, serverControls, toggleStart, toggleNotify(group), setLowResource(pref), installUpdate, quit }
const LOW_WHY = { steam: 'a Steam game is running', fullscreen: 'a full-screen app is in front', on: 'set to Always on' };
function lowLine(low) {
  return low && low.active ? `Low-resource mode on: ${LOW_WHY[low.reason] || 'a game is running'}` : null;
}
function createTray({ iconPath, getState, actions }) {
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  const tray = new Tray(icon);
  tray.setToolTip('Attic Hub');
  tray.on('click', () => actions.open());

  function template() {
    const s = getState();
    const client = s.mode !== 'server';
    const lowNow = client ? lowLine(s.low) : null;
    const pref = s.low ? s.low.pref : 'auto';
    return [
      { label: s.status, enabled: false },
      ...(lowNow ? [{ label: lowNow, enabled: false }] : []),
      // 3-5: a downloaded update, ready to install.
      ...(s.update && s.update.status === 'ready' && s.update.latest && s.update.canInstall
        ? [{ type: 'separator' }, { label: `Restart to update to ${s.update.latest.version}`, click: () => actions.installUpdate() }] : []),
      { type: 'separator' },
      { label: 'Open Attic Hub', click: () => actions.open() },
      client ? { label: 'Open Hub Inbox', click: () => actions.openInbox() } : { label: 'Server controls', click: () => actions.serverControls() },
      { type: 'separator' },
      { label: s.canStartWithWindows ? 'Start with Windows' : 'Start with Windows (installed app only)', type: 'checkbox', checked: !!s.startWithWindows,
        enabled: !!s.canStartWithWindows, click: () => actions.toggleStart() },
      ...(client ? [{ label: 'Notifications', submenu: [
        { label: 'Notify me when files arrive', type: 'checkbox', checked: !!s.notify.received, click: () => actions.toggleNotify('received') },
        { label: 'Files I send: delivered or failed', type: 'checkbox', checked: !!s.notify.transfers, click: () => actions.toggleNotify('transfers') },
        { label: 'Devices going offline or coming back', type: 'checkbox', checked: !!s.notify.devices, click: () => actions.toggleNotify('devices') }
      ] }, { label: 'Low-resource mode', submenu: [
        { label: 'Automatic: while a game runs', type: 'radio', checked: pref === 'auto', click: () => actions.setLowResource('auto') },
        { label: 'Always on', type: 'radio', checked: pref === 'on', click: () => actions.setLowResource('on') },
        { label: 'Off', type: 'radio', checked: pref === 'off', click: () => actions.setLowResource('off') }
      ] }] : []),
      { type: 'separator' },
      { label: 'Quit Attic Hub', click: () => actions.quit() }
    ];
  }

  // The menu's items, submenus opened out, for the change check and the tests.
  const flat = items => items.flatMap(i => [i, ...(i.submenu ? flat(i.submenu) : [])]);

  let last = '';
  function update() {
    const t = template();
    const key = JSON.stringify(flat(t).map(i => [i.label, i.checked, i.enabled, i.type]));
    if (key === last) return;
    last = key;
    tray.setContextMenu(Menu.buildFromTemplate(t));
    const s = getState(), lowNow = s.mode !== 'server' ? lowLine(s.low) : null;
    tray.setToolTip('Attic Hub · ' + s.status + (lowNow ? '\n' + lowNow : ''));
  }
  update();

  return {
    update,
    // For the end-to-end tests: the menu as plain data, and clicking an item by its label.
    items: () => flat(template()).filter(i => i.label).map(i => ({ label: i.label, checked: i.type === 'checkbox' || i.type === 'radio' ? !!i.checked : undefined, enabled: i.enabled !== false })),
    click(label) { const i = flat(template()).find(x => x.label === label && x.click); if (i) i.click(); return !!i; },
    destroy() { tray.destroy(); }
  };
}

module.exports = { createTray };
