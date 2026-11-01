// hub-agent.js — Phase 2, milestone 2-3 (D-03, D-04): report this PC's stats to the HP's live hub.
//
// Opens ws://<HP>/api/hub?role=agent with the device token from pairing (2-2) in the X-Attic-Device
// header, waits for { type: "hello", interval }, then sends { type: "stats", stats, connection, ip }
// every `interval` ms. A dropped connection is retried with a growing wait (1 s up to 30 s). Close code
// 4001 means this PC was unpaired, and 4000 that a newer agent took over; both stop it for good.
// Uses the WebSocket built into Node and Electron, which can send the header.
'use strict';

const BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];

function hubUrl(server) { return `ws://${server.address}:${server.port}/api/hub?role=agent`; }

// opts: { url, token, collect, onState(state, detail), WebSocketImpl }
// States: 'connecting', 'reporting', 'retrying' (detail: ms until the next try), 'unpaired', 'replaced', 'stopped'.
function createAgent({ url, token, collect, onState = () => {}, WebSocketImpl = globalThis.WebSocket, backoff = BACKOFF }) {
  let ws = null, timer = 0, retry = 0, tries = 0, stopped = false, state = null, sending = false;
  const set = (s, detail) => { state = s; onState(s, detail); };

  function connect() {
    if (stopped) return;
    set('connecting');
    try { ws = new WebSocketImpl(url, { headers: { 'X-Attic-Device': token } }); }
    catch (e) { return schedule(); }
    const mine = ws;
    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
      if (msg.type === 'hello') {
        tries = 0;
        set('reporting');
        loop(Math.max(1000, Number(msg.interval) || 3000), mine);
      }
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = ev => {
      if (ws !== mine) return;
      clearTimeout(timer);
      ws = null;
      if (stopped) return;
      if (ev.code === 4001) { stopped = true; return set('unpaired'); }
      if (ev.code === 4000) { stopped = true; return set('replaced'); }
      schedule();
    };
  }

  function loop(interval, mine) {
    const tick = async () => {
      if (stopped || ws !== mine) return;
      if (!sending) {
        sending = true;
        try {
          const r = await collect();
          if (ws === mine && mine.readyState === 1) mine.send(JSON.stringify({ type: 'stats', stats: r.stats, connection: r.connection, ip: r.ip }));
        } catch (e) { /* a failed reading skips one report */ }
        sending = false;
      }
      timer = setTimeout(tick, interval);
    };
    tick();
  }

  function schedule() {
    const wait = backoff[Math.min(tries++, backoff.length - 1)];
    set('retrying', wait);
    clearTimeout(retry);
    retry = setTimeout(connect, wait);
  }

  connect();
  return {
    get state() { return state; },
    stop() {
      stopped = true;
      clearTimeout(timer); clearTimeout(retry);
      if (ws) { try { ws.close(1000, 'Stopped'); } catch (e) { /* already closing */ } ws = null; }
      set('stopped');
    }
  };
}

module.exports = { createAgent, hubUrl, BACKOFF };
