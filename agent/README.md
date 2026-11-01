# agent/ — the client background part (Phase 2)

The part of the desktop tool that runs on each client PC (the Acer and the ROG Ally). It finds the HP, and later reports live stats (CPU, RAM, disk, battery, Wi-Fi or Ethernet, IP) and receives files into the Hub Inbox.

## Finding the HP (milestone 2-1, D-01) — built

`connect.js` runs in the desktop tool's main process when the tool starts:

1. **The server used last time**, at its last address, confirmed by its `serverId`. This is the fast path, usually under a second.
2. **A discovery broadcast** using `findServers()` from `server/discovery.js` (UDP 41980), retried once. If the remembered server answers from a new address, the tool follows it there.
3. **Nothing found, or several servers:** the start screen (`ui/connect.html`) says so. It offers Search again, a choice between servers, and a typed address.

Every candidate is confirmed with `GET /api/hello` (the right app, and the `serverId` it claimed) before the tool opens the interface the HP serves. A different server sitting at the remembered address isn't trusted. The remembered server is kept in the tool's user-data folder as `server.json`, never in the repository.

Typed addresses accept `192.168.1.10`, `192.168.1.10:8080`, `http://192.168.1.10:8080/` or a hostname, with port 8080 by default. Anything else is refused with a reason.

While the interface is open, the tool asks the HP `/api/hello` every 15 seconds. Two misses in a row, or a page that fails to load, take it back to the start screen to search again.

Tests: `node --test "agent/*.test.js"` (the logic, offline), and `desktop/scripts/discovery-test.mjs`. The second runs the whole flow in the real tool against a throwaway copy of the server.

## Pairing (milestone 2-2, D-02 and D-11) — built

Pairing happens in the interface the HP serves, not here, so browsers and the iPhone get the same screen. The interface checks `GET /api/pairing` before setup or sign-in. If the device isn't paired, it shows "Pair this device", which sends the master's one-time code to `POST /api/pairing/claim`. The routes are in [server/README.md](../server/README.md#pairing-and-unpairing-phase-2-milestone-2-2-d-02-and-d-11).

The device token arrives as an `HttpOnly` cookie in the window's session. The desktop tool writes it to disk as soon as it changes (`desktop/main.js`), so a crash straight after pairing doesn't lose it. In 2-3 the background part reads it from Electron's cookie store and sends it as `X-Attic-Device`.

Tests: `desktop/scripts/pairing-test.mjs`. It runs the real tool against a throwaway server with pairing required, reaching it through this PC's network address so the server treats the tool as a new device.

## Still to come

- **2-3 Live stats:** the `systeminformation` npm package, over a WebSocket to the HP.
- **2-4 Hub Inbox:** receiving files sent from other devices.

**The live hub is ready on the HP** (Phase 2, 2-3). The agent opens `ws://<HP>:8080/api/hub?role=agent` with the `X-Attic-Device` header and waits for `{"type":"hello","interval":3000}`. Then, every `interval` ms, it sends `{"type":"stats","stats":{cpu,ramTotal,ramUsed,diskTotal,diskFree,battery,charging},"connection","ip"}`. On a close it reconnects with a backoff; a close code of 4001 means the device was unpaired. The Devices view opens `/api/hub` without `role`, gets `{"type":"devices"}` and then `{"type":"device"}` changes. The details are in [server/README.md](../server/README.md#live-stats-phase-2-milestone-2-3-d-03-and-d-04).

The Transfers view in `ui/` shows sample data from `ui/js/mockgen.js` until then. The agent has to produce the same shapes.
