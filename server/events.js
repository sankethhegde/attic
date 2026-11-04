// events.js — Phase 3, milestone 3-2 (T-05): the events a client turns into Windows notifications.
//
// Each event has a number (`seq`, always rising), a kind, a ready-to-show title and body, and who it's
// for: devices (their agent, and any interface open on them) and accounts (any interface signed in as
// them). It's pushed the moment it happens and kept in the database for 7 days, so a tray that was
// asleep or offline catches up with GET /api/events?after=<the last seq it saw>.
//
// Kinds, and who hears them:
//   transfer.received  a file reached a device's Hub Inbox      the receiving device
//   transfer.done      a sent file was delivered                the sender (its device and account)
//   transfer.failed    a sent file couldn't be delivered        the sender
//   device.online      a device's agent came back               every other device, every account
//   device.offline     a device's agent has gone                every other device, every account
// Going offline is announced only after 30 s away, so a quick reconnect (the tool restarting, Wi-Fi
// dropping for a moment, the HP itself restarting) says nothing; "online" is announced only for a
// device whose going was. Core Node only.
'use strict';

const KEEP_MS = 7 * 864e5;
const KEEP_MAX = 1000;
const OFFLINE_AFTER_MS = 30e3;

const pub = r => r && { seq: r.seq, at: r.at, kind: r.kind, title: r.title, body: r.body, deviceId: r.device_id, transferId: r.transfer_id };
const list = v => v === '*' ? '*' : JSON.parse(v || '[]');

function createEvents({ db, deliver = () => {}, offlineAfterMs = +process.env.ATTIC_OFFLINE_AFTER_MS || OFFLINE_AFTER_MS }) {
  const insert = db.prepare('INSERT INTO events (at, kind, title, body, device_id, transfer_id, to_devices, to_accounts, not_device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const get = db.prepare('SELECT * FROM events WHERE seq = ?');
  const lastSeq = () => db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM events').get().n;

  // Is this event for a device / an account?
  const forDevice = (r, id) => !!id && (r.to_devices === '*' ? r.not_device !== id : list(r.to_devices).includes(id));
  const forAccount = (r, id) => !!id && (r.to_accounts === '*' || list(r.to_accounts).includes(id));

  function emit(kind, { title, body, deviceId = null, transferId = null, toDevices = [], toAccounts = [], notDevice = null }) {
    const enc = v => v === '*' ? '*' : JSON.stringify([...new Set(v.filter(Boolean))]);
    const r = insert.run(new Date().toISOString(), kind, title.slice(0, 120), body.slice(0, 300), deviceId, transferId, enc(toDevices), enc(toAccounts), notDevice);
    const row = get.get(Number(r.lastInsertRowid));
    deliver(pub(row), { forDevice: id => forDevice(row, id), forAccount: id => forAccount(row, id), allDevices: row.to_devices === '*', notDevice, devices: row.to_devices === '*' ? [] : list(row.to_devices) });
    return pub(row);
  }

  // ---------- device presence, debounced ----------
  const pendingOffline = new Map(); // deviceId -> timer
  const announcedOffline = new Set();
  function presence(device, online) {
    if (!device) return;
    if (online) {
      clearTimeout(pendingOffline.get(device.id));
      pendingOffline.delete(device.id);
      if (announcedOffline.delete(device.id)) {
        emit('device.online', { title: `${device.name} is online`, body: `${device.name} is connected to the HP again.`, deviceId: device.id, toDevices: '*', toAccounts: '*', notDevice: device.id });
      }
      return;
    }
    if (pendingOffline.has(device.id) || announcedOffline.has(device.id)) return;
    const timer = setTimeout(() => {
      pendingOffline.delete(device.id);
      announcedOffline.add(device.id);
      emit('device.offline', { title: `${device.name} is offline`, body: `${device.name} hasn’t been connected to the HP for ${Math.round(offlineAfterMs / 1000)} seconds.`, deviceId: device.id, toDevices: '*', toAccounts: '*', notDevice: device.id });
    }, offlineAfterMs);
    timer.unref();
    pendingOffline.set(device.id, timer);
  }
  // An unpaired device is gone for good: nothing more to say about it.
  function forget(deviceId) { clearTimeout(pendingOffline.get(deviceId)); pendingOffline.delete(deviceId); announcedOffline.delete(deviceId); }

  // ---------- transfers ----------
  // Called with each transfer change; only the endings make notifications.
  function transfer(t) {
    const from = t.fromName || t.userName || 'another device', to = t.toName || 'the other device';
    if (t.status === 'done') {
      emit('transfer.received', { title: 'File received', body: `${t.fileName} from ${from} is in your Hub Inbox.`, deviceId: t.to, transferId: t.id, toDevices: [t.to] });
      emit('transfer.done', { title: 'File delivered', body: `${t.fileName} reached ${to}.`, deviceId: t.to, transferId: t.id, toDevices: [t.from], toAccounts: [t.userId] });
    } else if (t.status === 'failed') {
      emit('transfer.failed', { title: 'Transfer failed', body: `${t.fileName} to ${to} didn’t arrive${t.error ? ': ' + t.error.replace(/\.$/, '') : ''}.`, deviceId: t.to, transferId: t.id, toDevices: [t.from], toAccounts: [t.userId] });
    }
  }

  return {
    emit, presence, forget, transfer, lastSeq,
    // What `who` missed after `after`: oldest first, at most `limit`. who = { deviceId, accountId }.
    since(who, after = 0, limit = 100) {
      const rows = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT 2000').all(Math.max(0, Math.floor(+after) || 0));
      const mine = rows.filter(r => forDevice(r, who.deviceId) || forAccount(r, who.accountId));
      const n = Math.max(1, Math.min(500, Math.floor(+limit) || 100));
      return { events: mine.slice(0, n).map(pub), last: lastSeq(), more: mine.length > n };
    },
    prune(t0 = Date.now()) {
      db.prepare('DELETE FROM events WHERE at < ?').run(new Date(t0 - KEEP_MS).toISOString());
      db.prepare(`DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT ${KEEP_MAX})`).run();
    }
  };
}

module.exports = { createEvents, OFFLINE_AFTER_MS };
