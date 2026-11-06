// notify.js — Phase 3, milestone 3-2 (T-05): Windows notifications for files this PC receives.
//
// The receiver (receiver.js) reports each file as it lands in the Hub Inbox. One file gets its own
// notification, naming it and who sent it; clicking it shows the file in File Explorer. Files that land
// close together (a folder, or a backlog collected on start-up) become one notification, so the corner
// of the screen doesn't fill up. `show(title, body, onClick)` does the showing (Electron's Notification).
//
// Everything else comes from the HP (its side of 3-2): ready-to-show events over the agent's hub
// connection for transfers this PC sent (delivered or failed) and devices going offline or coming back.
// createEventFeed() shows those, remembers the newest one shown, and after a restart asks the HP for what
// it missed (GET /api/events?after=), so nothing is lost or shown twice. The HP's "file received" event
// is only marked as seen: the notifier above already showed it, with the file's own location. Core Node.
'use strict';
const path = require('path');

const fmtBytes = n => {
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return i ? `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}` : `${n} ${u[0]}`;
};

// opts: { show(title, body, onClick), reveal(path), openInbox(), enabled() → bool, windowMs }
function createNotifier({ show, reveal, openInbox, enabled = () => true, windowMs = 2500 }) {
  let batch = [], timer = 0;

  function flush() {
    timer = 0;
    const files = batch;
    batch = [];
    if (!files.length || !enabled()) return;
    if (files.length === 1) {
      const f = files[0];
      const from = f.fromName ? ` from ${f.fromName}` : '';
      return show(`File received${from}`, `${path.basename(f.path)} · ${fmtBytes(f.size)} · in your Hub Inbox`, () => reveal(f.path));
    }
    const total = files.reduce((a, f) => a + (f.size || 0), 0);
    const senders = [...new Set(files.map(f => f.fromName).filter(Boolean))];
    const from = senders.length === 1 ? ` from ${senders[0]}` : '';
    show(`${files.length} files received${from}`, `${files.slice(0, 2).map(f => path.basename(f.path)).join(', ')}${files.length > 2 ? ` and ${files.length - 2} more` : ''} · ${fmtBytes(total)}`,
      () => openInbox());
  }

  return {
    // A file was saved: { path, size, fromName }
    received(f) {
      batch.push(f);
      if (!timer) timer = setTimeout(flush, windowMs);
    },
    flush() { clearTimeout(timer); flush(); }
  };
}

// Which preference switch each HP event kind falls under. Kinds not listed aren't shown.
// Feedback round 1: a sign-up waiting for the master, and an account approved, are always shown ('accounts').
const GROUP = { 'transfer.done': 'transfers', 'transfer.failed': 'transfers', 'device.offline': 'devices', 'device.online': 'devices',
  'account.signup': 'accounts', 'account.approved': 'accounts' };
const CATCH_UP_SHOWN = 3; // after a restart, more missed events than this become one summary

// opts: { fetchEvents(after) → { events, last, more }, getLast() → seq | null, setLast(seq),
//         show(title, body, event), enabled(group) → bool }
function createEventFeed({ fetchEvents, getLast, setLast, show, enabled }) {
  let catching = null;
  const shown = e => GROUP[e.kind] && enabled(GROUP[e.kind]);
  const advance = seq => { const last = getLast(); if (last == null || seq > last) setLast(seq); };

  async function catchUp(after) {
    const missed = [];
    for (let from = after, page = 0; page < 20; page++) {
      const r = await fetchEvents(from);
      missed.push(...(r.events || []));
      if (!r.more || !r.events || !r.events.length) break;
      from = r.events[r.events.length - 1].seq;
    }
    const show_ = missed.filter(shown);
    if (show_.length <= CATCH_UP_SHOWN) show_.forEach(e => show(e.title, e.body, e));
    else show(`${show_.length} updates while Attic Hub was closed`, show_.slice(-2).map(e => e.title).join(' · ') + ' and more', null);
    if (missed.length) advance(missed[missed.length - 1].seq);
  }

  return {
    // A hub message for the agent: { type: 'events', last } on connect, { type: 'event', event } live.
    handle(msg) {
      if (msg.type === 'events' && Number.isSafeInteger(msg.last)) {
        const last = getLast();
        if (last == null) return setLast(msg.last); // first time with this HP: nothing old is news
        if (msg.last > last && !catching) {
          catching = catchUp(last).catch(() => { /* the next connect tries again */ }).finally(() => { catching = null; });
        }
        return catching;
      }
      if (msg.type === 'event' && msg.event && Number.isSafeInteger(msg.event.seq)) {
        const e = msg.event, last = getLast();
        if (last != null && e.seq <= last) return; // already shown (or caught up)
        advance(e.seq);
        if (shown(e)) show(e.title, e.body, e);
      }
    }
  };
}

module.exports = { createNotifier, createEventFeed, fmtBytes, GROUP };
