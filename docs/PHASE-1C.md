# Phase 1C — the first working server

A build brief for the HP laptop. Read this, then build milestone 1 only.

## The goal of version one

Open `http://<hp-ip>:8080` on your phone and see the real drives of the HP laptop.

Nothing else. No login yet, no file browsing, no uploads. One endpoint returning real data over the home network proves the whole chain works: Windows, firewall, network, server, static files, and the `api.js` swap pattern. Everything after that is the same move repeated.

Resist building more before this runs. A server that does six things badly is harder to debug than one that does one thing properly.

## What milestone 1 does

- Listens on port 8080, bound to `0.0.0.0`
- Serves everything in `ui/` as static files
- Answers `GET /api/shares` with the real drives, read from disk
- Leaves every other `api.js` function on mock data

## What it deliberately does not do yet

Login, sessions, folder listing, downloads, uploads, ownership, SQLite, Express, WebSocket, Windows service, HTTPS. Each has its own milestone below.

## Build order

| # | Milestone | Done when |
| --- | --- | --- |
| 1 | Walking skeleton | Phone on home Wi-Fi shows the HP's real drives |
| 2 | Path safety | The traversal tests below all pass |
| 3 | Login and sessions | Password checked on the server; mock auth deleted |
| 4 | Browse and download | Files tab works on real folders; a 2 GB file downloads |
| 5 | Ownership | `visibleIndex` enforced server-side; the acceptance checks pass |
| 6 | Everything else | Remaining endpoints; mock implementation removed |

Milestones 2 and 3 are not optional extras. No endpoint that takes a path ships before 2, and no endpoint that returns a file ships before 3.

## Milestone 1, in detail

### config.json

Keep configuration in a file, never in code, so the HP's real paths never get committed:

```json
{
  "port": 8080,
  "host": "0.0.0.0",
  "shares": [
    { "id": "system", "name": "System",          "rootPath": "C:\\AtticShared" },
    { "id": "main",   "name": "Main storage",    "rootPath": "D:\\Shared" },
    { "id": "backup", "name": "External backup", "rootPath": "X:\\AtticBackup" }
  ]
}
```

Add `config.json` to `.gitignore` and commit a `config.example.json` beside it.

Point shares at specific folders, never at a drive root. `D:\Shared`, not `D:\`. If the path checking has a bug, the blast radius is that folder rather than the whole disk.

### Reading real drive figures

For each share, report `total`, `used` and `free` in bytes, plus `available: false` when the path does not exist — the external drive will be unplugged sometimes, and that state has to be real from the start, not simulated.

The JSON shape must match exactly what `ui/js/api.js` returns today from the mock. Same field names, same units, same date format. If the shapes match, the swap is a one-function change; if they drift, every screen needs touching.

### The api.js swap

Change only `listShares()`:

```javascript
async listShares() {
  const res = await fetch('/api/shares');
  if (!res.ok) throw new ApiError('UNREACHABLE', 'Could not reach the server.');
  return res.json();
}
```

Every other function keeps reading mock data. The app must still work with one real function and the rest mocked — if it does not, something outside `api.js` is touching storage, and that needs fixing before going further.

### Windows setup for milestone 1

- Firewall: allow inbound TCP 8080, **Private profile only**
- Test `http://localhost:8080` on the HP first, then the phone
- If the first works and the second does not, it is the firewall almost every time

## Milestone 2: path safety

Write this function before any endpoint that accepts a path, and test it before using it.

```javascript
function safePath(shareId, relPath) {
  const root = SHARES[shareId];
  if (!root) return null;
  if (String(relPath).includes('\0')) return null;
  const rel = String(relPath).replace(/^[/\\]+/, '');
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}
```

Resolve first, then check containment. Searching the string for `..` is not enough — URL encoding, mixed slashes and Windows path quirks all defeat it.

These must all return `null`:

```
../../../Windows/System32/config
..\..\..\Windows\System32
%2e%2e%2f%2e%2e%2f
/absolute/path
C:\Windows
....//....//
foo/../../../etc
```

And these must resolve inside the share:

```
(empty string)
Trip 2026
Trip 2026/Goa/beach.jpg
folder with spaces/file.txt
```

Write these as a test file and run it. This is the one function where a bug hands over the whole machine.

## Notes on the stack

The requirements name Express, WebSocket and SQLite. All three are reasonable, and none is needed for milestones 1 and 2.

Core Node's `http` and `fs` cover the skeleton with no install step, and JSON files on disk hold accounts fine until there are concurrent writers. Add each dependency at the milestone that needs it: SQLite when the file index needs querying rather than scanning, WebSocket when transfers need live progress, Express when hand-written routing starts hurting.

Adding them up front means debugging four unfamiliar things at once instead of one.

## Definition of done for milestone 1

- [ ] `node server/server.js` starts and prints the port and the shares
- [ ] `http://localhost:8080` serves the interface on the HP
- [ ] `http://<hp-ip>:8080` serves it to the phone over home Wi-Fi
- [ ] The share picker shows the HP's real drives with real free space
- [ ] Unplugging the external drive makes that share show as unavailable
- [ ] Every other tab still works on mock data
- [ ] `config.json` is gitignored and `config.example.json` is committed

When all seven hold, commit, and start milestone 2.
