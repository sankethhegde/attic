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

## Still to come

- **2-2 Pairing:** a one-time code approved on the HP, instead of signing in as a device account.
- **2-3 Live stats:** the `systeminformation` npm package, over a WebSocket to the HP.
- **2-4 Hub Inbox:** receiving files sent from other devices.

The Devices and Transfers views in `ui/` show sample data from `ui/js/mockgen.js` until then. The agent has to produce the same shapes.
