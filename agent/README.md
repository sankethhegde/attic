# agent/ — the client background part (Phase 2)

Empty until Phase 2. This will be the part of the desktop tool that runs on each client PC (the Acer and the ROG Ally). It reports live stats to the HP — CPU, RAM, disk, battery, Wi-Fi or Ethernet, IP — and receives files into the Hub Inbox.

Planned: the `systeminformation` npm package for stats, a WebSocket connection to the HP for status and notifications, and discovery of the HP on the home network by UDP broadcast or mDNS. Nobody should have to type an IP address.

The Devices and Transfers views in `ui/` already show this data from the mock in `ui/js/mockgen.js`. The agent has to produce the same shapes.
