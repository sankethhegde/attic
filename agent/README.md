# agent/ — the client background part (Phase 2)

Empty until Phase 2. This will be the part of the desktop tool that runs on each client PC (the Acer and the ROG Ally). It reports live stats to the HP — CPU, RAM, disk, battery, Wi-Fi or Ethernet, IP — and receives files into the Hub Inbox.

Planned: the `systeminformation` npm package for stats, a WebSocket connection to the HP for status and notifications, and discovery of the HP on the home network. Nobody should have to type an IP address.

**Discovery is ready on the HP** (Phase 2, 2-1): it answers a UDP broadcast on port 41980. The protocol is in [server/README.md](../server/README.md#discovery-phase-2-milestone-2-1-d-01), and `findServers()` in `server/discovery.js` is a working client the agent can reuse. `node server/find-server.js` tries it from any PC.

The Devices and Transfers views in `ui/` already show this data from the mock in `ui/js/mockgen.js`. The agent has to produce the same shapes.
