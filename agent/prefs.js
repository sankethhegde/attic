// prefs.js — Phase 3, milestone 3-2 (T-04, T-05): the desktop tool's own preferences, per PC, in the
// tool's user-data folder (prefs.json): start with Windows, and which notifications to show.
// Separate from the interface's settings, which live in the browser's storage and are per account.
'use strict';
const fs = require('fs');
const path = require('path');

// A client starts with Windows unless turned off; the server already starts with Windows as a service,
// so its window doesn't need to.
// notify: received files, transfers this PC sent (delivered or failed), devices going and coming.
// seen: the newest HP event already shown, per server, so a restart catches up without repeats.
const NOTIFY = ['received', 'transfers', 'devices'];
const defaults = mode => ({
  startWithWindows: mode !== 'server',
  notify: { received: true, transfers: true, devices: true },
  trayHintShown: false,
  seen: {}
});

function store(file) {
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { return {}; } };
  return {
    load(mode) {
      const saved = read(), d = defaults(mode);
      return Object.assign(d, saved, { notify: Object.assign({}, d.notify, saved.notify) });
    },
    // Merges `patch` into what's saved; only known keys are kept.
    save(patch, mode) {
      const cur = this.load(mode);
      const notify = Object.assign({}, cur.notify);
      for (const k of NOTIFY) if (patch.notify && typeof patch.notify[k] === 'boolean') notify[k] = patch.notify[k];
      const seen = Object.assign({}, cur.seen);
      for (const [id, n] of Object.entries(patch.seen || {})) if (Number.isSafeInteger(n)) seen[id] = n;
      const next = {
        startWithWindows: typeof patch.startWithWindows === 'boolean' ? patch.startWithWindows : cur.startWithWindows,
        notify,
        trayHintShown: typeof patch.trayHintShown === 'boolean' ? patch.trayHintShown : cur.trayHintShown,
        seen
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2));
      fs.renameSync(file + '.tmp', file);
      return next;
    }
  };
}

module.exports = { store, defaults, NOTIFY };
