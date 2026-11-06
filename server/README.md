# server/ — the HP server (Phase 1C)

The server that runs on the HP laptop. Built one milestone at a time from `docs/PHASE-1C.md`.

**Now: milestones 1–6, the whole brief.** Core Node only, no install step. It serves `ui/`, reports the real drives, owns accounts, passwords and sessions, browses, downloads and uploads real folders, enforces who owns what, and indexes every share for Photos, Videos, Other and the Dashboard. The browser's file mock is gone; only Devices and Transfers keep sample data, until Phase 2.

**Phase 2 on the server:** discovery (2-1) answers clients looking for the HP on the home network, pairing (2-2) lets only devices the master approved use it, the live hub (2-3) carries each device's stats to the master as they change, and transfers (2-4) send a file to another device through the HP, holding it while that device is offline. Transfers report live progress, can be retried, and are kept as history in a database (2-5).

**Phase 3 on the server:**
- **3-1:** the HP server runs as a background service that starts with Windows, before anyone signs in, and comes back after a crash. See [Run it as a service](#run-it-as-a-service-phase-3-milestone-3-1-t-03).
- **3-2:** it sends each client the events it should turn into Windows notifications. See [Notification events](#notification-events-phase-3-milestone-3-2-t-05).
- **3-5:** it serves the newest desktop-tool installer and its version, so every client can update itself. See [Updates](#updates-phase-3-milestone-3-5-t-10). 3-3 and 3-4 have no server side.

**Phase 4 on the server:**
- **4-1:** it serves the interface to Safari over HTTPS, with a certificate the iPhone trusts. See [HTTPS for the iPhone](#https-for-the-iphone-phase-4-milestone-4-1).
- **4-2:** a phone's large videos get through: there's no five-minute cut-off, and uploads resume after a drop. See [Large uploads from the phone](#large-uploads-from-the-phone-phase-4-milestone-4-2).

## Run it

```
copy server\config.example.json server\config.json   (first time only, then edit the paths)
node server/server.js
```

It prints the port, the addresses to open (this PC and the home network), and each share with its free space or `UNAVAILABLE`.

- `config.json` holds the HP's real paths and is gitignored. `config.example.json` is the committed template.
- Point shares at folders, never at a drive root: `D:\Shared`, not `D:\`.
- A share whose path is missing (an unplugged external drive) reports `available: false` with the last time it was seen. Those times live in `server/data/`, also gitignored.
- For phones on the home Wi-Fi, Windows Firewall needs inbound TCP 8080 allowed on the Private profile only.

## Run it as a service (Phase 3, milestone 3-1, T-03)

So the HP serves files after a reboot with nobody signed in, the server runs as a Windows startup task. It doesn't need a separate service-wrapper program, and it gives the same three things: it starts at boot, needs no sign-in, and comes back after a crash. This is the HP's half of 3-1. The desktop tool's first-launch "Server or Client" screen is the Acer's half, and will run these same commands.

Install it once, from an **Administrator** PowerShell (Start → type PowerShell → right-click "Windows PowerShell" → Run as administrator):

```
cd C:\Users\HP\Desktop\Claude\attic
node server/service/service.js install
```

Stop any server you started by hand first; `install` refuses while one is holding port 8080. It registers the task "Attic Hub Server" and starts it.

| Command | Needs admin | Does |
| --- | --- | --- |
| `node server/service/service.js install` | yes | Register the task and start it |
| `node server/service/service.js uninstall` | yes | Stop it and remove the task. Data and settings stay |
| `node server/service/service.js start` / `stop` / `restart` | no | Run or stop it now. `stop` asks the supervisor to finish cleanly, then ends the task |
| `node server/service/service.js status` (`--json`) | no | Is the task installed, is the supervisor running (and how many restarts), is the server answering |
| `node server/service/service.js logs` (`--lines 50`) | no | The end of the server's log |

**The task** (`service/service.js`):
- **When it runs:** at startup, before anyone signs in. Windows keeps it from starting twice.
- **Which account:** your Windows account with `S4U` ("run whether signed in or not", without storing your password). It can reach this PC's drives, and files it writes stay yours. It can't reach network shares, which Attic doesn't use. Not elevated.
- **Power and time:** it starts and keeps running on battery, and has no time limit.
- **If it dies:** Windows restarts it every minute, up to 999 times.

**The supervisor** (`service/supervisor.js`) is what the task runs. It runs `server.js` and:
- **Crashes:** restarts the server after it exits, waiting 1, 2, 5, 10, then 30 seconds between tries. A run that lasted a minute resets the wait.
- **Hangs:** restarts the server when it stops answering `GET /api/hello`, after three misses 15 seconds apart.
- **Logs:** writes everything the server prints, with times, to `server/data/logs/attic-YYYY-MM-DD.log`. Lines from stderr are marked `!`. It keeps 14 days.
- **State:** keeps its current state in `server/data/supervisor.json` for `status`, and refuses to start a second copy.
- **Orphans:** a server started by the supervisor exits within 2 seconds if the supervisor goes, so stopping the task never leaves a server holding the port.

For the acceptance check ("the HP server runs after a reboot with no one signed in"): install, restart the HP, and don't sign in. From the Acer, `node server/find-server.js` should find it, and `http://192.168.1.12:8080` should open. Then sign in on the HP and run `status`, which should show the supervisor running since boot.

Two Windows settings matter for this:
- **The Wi-Fi network** must be one saved for all users, which is the default, so the HP connects before anyone signs in. Ethernet always does.
- **Sleep** stops everything. For an always-on server, set Power Options → "When plugged in, put the computer to sleep" to Never, and choose "Do nothing" for closing the lid while it's plugged in.

`service.test.js` covers it:
- that the generated task starts at boot, as S4U, on battery, with no time limit, restarted if it dies, and with paths quoted safely;
- that `status` reads Windows without changing it;
- the supervisor restarting a crashed server and a hung one;
- the growing wait for a server that keeps crashing;
- stopping on request, and the server not outliving a killed supervisor;
- one supervisor at a time.

Nothing in the tests installs a real task.

## Path safety (milestone 2)

`safe-path.js` turns a share id and a client-supplied relative path into an absolute path inside that share, or `null`. Every endpoint that accepts a path must go through it. Run the tests with:

```
node --test "server/*.test.js"
```

The brief's version (resolve, then check containment) failed three of its own seven rejection cases on Windows, so it has a second layer in front: each path segment must be a name Windows stores exactly as typed. Refused: dot-only segments, trailing dots or spaces (Windows strips them, so they alias other names), `:` (drive letters and alternate data streams), reserved device names (`CON`, `NUL`, `COM1`…), empty segments, leading slashes, and anything still percent-encoded. The HTTP layer decodes a path once; `safePath` never decodes again.

Not covered yet: a junction or symlink *inside* a share that points outside it. Before milestone 4 serves files, check `fs.realpath` of the target is still inside the share.

## Login and sessions (milestone 3)

`auth.js` holds accounts, passwords and sessions. The mock sign-in in `ui/js/api.js` (plaintext passwords in browser storage, the "Test accounts" list) is gone.

- **Passwords** are stored only as scrypt hashes (Node's built-in `crypto`), in `server/data/accounts.json`. Minimum 6 characters.
- **Sessions** are a random 256-bit token in an `HttpOnly; SameSite=Strict` cookie, so page scripts can't read it and other sites can't send it. The server stores only the token's SHA-256 in `server/data/sessions.json`. "Stay signed in" lasts 30 days; otherwise the cookie ends with the browser and the server forgets it after a day.
- **Every `/api/` route needs a session** except `GET/POST /api/setup` and `/api/session`. A device's `/api/shares` has no capacity or free space, as in the mock.
- **Sign-in** gives one message for unknown user, wrong password or wrong account type. A revoked account is named only once its password is right. Unknown usernames still cost one hash, so timing doesn't reveal them. Five failures from one address lock it out for 15 minutes.
- **Revoking** a device or **changing a password** ends that account's other sessions at once.
- **Writes** must be `application/json` from the same origin, which a form on another site can't send.

| Route | Who | Does |
| --- | --- | --- |
| `GET /api/setup` | anyone | `{ needsSetup }` |
| `POST /api/setup` | anyone, once | Create the master |
| `GET / POST / DELETE /api/session` | anyone | Who am I / sign in / sign out |
| `GET / POST /api/accounts` | master | List accounts / add a device |
| `PATCH /api/accounts/:id` | self or master | Display name |
| `POST /api/accounts/:id/password` | self | Change password |
| `PUT /api/accounts/:id/status` | master | `active` or `revoked` |
| `DELETE /api/accounts/:id` | master | Remove a device |

Files, devices, transfers and ownership are still the browser mock, reading the session and account list the server returns. Revoke, restore and remove write the mock index first and put it back if the server refuses, so the two stay all-or-nothing.

Not yet: HTTPS (passwords cross the home network unencrypted until then), and the Phase 1B desktop tool, which opens `ui/` from disk and so can no longer sign in without this server.

Tests: `node --test "server/*.test.js"` starts a throwaway server on a temporary config and data folder (`ATTIC_CONFIG`, `ATTIC_DATA`, `ATTIC_PORT`) and drives it over HTTP.

## Browse and download (milestone 4)

`files.js` lists real folders and streams real files. The Files tab now shows the HP's actual folders; Photos, Videos, Other and the Dashboard still read the mock index until milestone 6.

| Route | Who | Does |
| --- | --- | --- |
| `GET /api/shares/:id/folder?path=` | signed in | One folder's entries, in the mock's shape |
| `GET /api/shares/:id/file?path=` | signed in | The file, as an attachment, if the caller may see it |

- **Every path goes through `safePath()`**, then the real location on disk is checked to be inside the share. Symlinks and junctions are left out of listings, so a link planted in a share can't lead out of it (this closes the gap noted under milestone 2). Names the API couldn't address again (a trailing dot, say) are left out too.
- **Downloads stream** with backpressure, so memory stays flat for any size. Single byte ranges are honoured (`206`, `Accept-Ranges: bytes`), so a browser can resume a large download. The filename is sent in UTF-8 (`filename*`), and `nosniff` stops a browser treating a file as a page.
- An unplugged share answers `409 UNAVAILABLE`; a locked file `423 LOCKED`.

The 2 GB test in `files.test.js` builds a 2 GB file in a temporary share and downloads it end to end (about 7 seconds on the HP), then resumes from near the end.

## Ownership and upload (milestone 5)

`ownership.js` decides who sees which real file; `files.js` asks it on every listing, download and upload. The Phase 1A rule holds on the server now: **a device sees its own files and the common space, the master sees everything, and another account's file is "not found", never "forbidden".** A folder shows when it leads to something you can see, or is empty for everyone, so a folder holding only someone else's files doesn't exist for you and can't be uploaded into.

- **Records, not scans.** `server/data/ownership.json` holds `{ ownerId, uploadedBy }` only for files that have an owner other than the default. A file with no record belongs to the master, which covers everything on the disk before Attic. Nothing walks the drives.
- **Keyed on the disk's own spelling.** Every check uses the path `realpath` returns, never the client's spelling, so `UPLOADS\TABLET-NOTE.TXT` can't stand in for someone else's `Uploads/tablet-note.txt`.
- **Upload** is `PUT /api/shares/:id/file?path=<folder>/<name>` with the file as the body (and an `X-Attic-Upload: 1` header, which forces a CORS preflight from any other site). It streams to a temporary `~attic-….part` in the destination folder and is hard-linked into place under a free name (`photo (1).jpg`), so nothing is ever overwritten and a half-sent file never appears. A dropped connection deletes the temporary file. The uploader owns the result. 20 GB per file.
- **Revoke, restore, remove and keep permanently** move ownership on the server: ownership is written first and rolled back if the account change is refused, so each is all-or-nothing.

| Route | Who | Does |
| --- | --- | --- |
| `PUT /api/shares/:id/file?path=` | signed in | Upload into a folder you can see |
| `GET /api/accounts/:id/ownership` | master | `{ owned, inCustody }` counts and bytes, for the revoke dialog |
| `POST /api/accounts/:id/revoke` | master | `{ custodianId }`: files to the custodian, device signed out |
| `POST /api/accounts/:id/restore` | master | What the device uploaded comes back |
| `POST /api/accounts/:id/remove` | master | `{ custodianId }`: files to the custodian, every claim cleared |
| `POST /api/files/keep` | master | `{ ids }`: end the uploader's claim |

The Files tab has an Upload button for every account (the Dashboard's upload panel is master-only).

`ownership.test.js` covers the three Phase 1C acceptance checks and the Phase 1B ownership checks against a real server, including a restart.

## Index, previews and shares (milestone 6)

The last of the file mock is gone from `ui/`: Photos, Videos, Other, the Dashboard, device file totals and Settings all read the server.

- **The index** (`GET /api/files`) is every file in every available share, scoped by ownership like everything else. One walk per share is reused for 30 seconds and dropped after an upload; the Dashboard's Refresh, and `?fresh=1`, walk again so files added in Explorer appear. It walks one folder at a time and skips links, junctions, uploads in flight and unaddressable names, the same rules as a listing. Past 200,000 files in a share it stops: that is the point where the brief's SQLite index is due.
- **Previews** (`?inline=1` on a file) serve photos, video and audio as their own type, so the Photos grid, the viewer and the players show the real thing. Only an allowlist of media types is served in place, never SVG, HTML or PDF, and every file response carries `nosniff` and a sandboxing content security policy. Previews are full images; resized thumbnails would need an image library, which the brief keeps out for now.
- **Shares** are added, edited and removed from Settings (`POST /api/shares`, `PUT` and `DELETE /api/shares/:id`, master only). The change is written to `config.json` before it takes effect, and port and host are left alone. A drive root, a relative or network path, and a folder inside (or around) another share are refused. Editing keeps the share's id, so ownership records still match. Removing a share never touches the disk.
- **Drive figures** say which drive each share is on (`drive`), so two shares on one drive count its capacity once. The Dashboard shows the drives' real used and free space, the files in the shares by type, and the rest of the used space as "other data on the drives".

| Route | Who | Does |
| --- | --- | --- |
| `GET /api/files` | signed in | Every file the caller may see, across all shares |
| `GET /api/shares/:id/file?path=&inline=1` | signed in | A photo, video or audio file shown in place |
| `POST /api/shares` | master | Add a share |
| `PUT /api/shares/:id` | master | Rename it, point it elsewhere, change its drive type |
| `DELETE /api/shares/:id` | master | Stop serving it |

`index.test.js` covers the index, previews and share editing, including a restart.

## Discovery (Phase 2, milestone 2-1, D-01)

Clients find the HP on the home network without anyone typing an address. `discovery.js` answers a UDP broadcast with where to reach the server. This is the HP's half of 2-1; the agent on the Acer, its "Looking for server" state and the typed-address fallback are the other half.

The protocol, for the agent to implement (or reuse `findServers()` from `discovery.js`):

| | Packet |
| --- | --- |
| Client broadcasts to UDP **41980** | `{"attic":"discover","v":1,"nonce":"<8–64 of A-Z a-z 0-9 _ ->"}`, at most 512 bytes |
| HP answers that client only | `{"attic":"here","v":1,"nonce":<same>,"serverId":"<32 hex>","name":"<PC name>","address":"<HP's IP on the client's subnet>","port":8080}` |

- **Home network only.** A request is answered only when the sender is on the same subnet as one of the HP's network interfaces, or is the HP itself. Anything else (malformed, oversized, another version, a sender asking more than 20 times in 10 seconds) gets silence, so the port tells a stranger nothing.
- **The reply is small and says only where the server is**: no accounts, shares or files.
- **`serverId`** is random, kept in `server/data/server-id.json`, and survives restarts and IP changes, so a client can recognise the same HP. `GET /api/hello` returns it too, so a client can confirm the address it found is the server it meant (pairing in 2-2 builds on this).
- **Send to every broadcast address.** Windows sends `255.255.255.255` out of one interface only, so a client also sends to each subnet's own broadcast (`broadcastTargets()` lists them).
- **If the UDP port is taken, the server still starts**, without discovery, and says so. Turn it off with `"discovery": { "enabled": false }` in `config.json`, or change `"port"`. The socket doesn't use address reuse, so another program can't share the port and intercept requests.

Try it from any PC on the network, Node only:

```
node server/find-server.js
```

For other PCs to reach it, Windows Firewall on the HP must allow inbound UDP 41980 on the Private profile, alongside TCP 8080 (an Administrator PowerShell):

```
New-NetFirewallRule -DisplayName "Attic discovery (UDP 41980, Private)" -Direction Inbound -Protocol UDP -LocalPort 41980 -Action Allow -Profile Private
```

`discovery.test.js` covers the subnet rule, malformed packets, the rate limit, the id across a restart, and starting with the port taken.

## Pairing and unpairing (Phase 2, milestone 2-2, D-02 and D-11)

Accounts say who is using Attic; paired devices say which machine the request comes from. **Every API request needs both.** This is the HP's half of 2-2; the "Pair a device" button, the code-entry screen and the Unpair button are the Acer's half.

How a device pairs:

1. The master asks the HP for a code (`POST /api/pairing/codes`, from Devices → Pair a device). **Issuing the code is the approval:** one code, one new device.
2. The new device opens the HP's interface, sees it isn't paired (`GET /api/pairing`), and sends the code with its name (`POST /api/pairing/claim`).
3. The HP stores the device (`server/data/devices.json`) and returns a 256-bit device token **only in an `attic_device` cookie** (`HttpOnly; SameSite=Strict`, 400 days, renewed at every sign-in). It keeps only the token's SHA-256. The desktop tool's background part can send the same token as an `X-Attic-Device` header instead.

The rules:

- **An unpaired device can do nothing but pair.** It still gets the interface itself (`/`, so it can show the pairing screen), `GET /api/hello` and `GET /api/pairing`. Every other `/api/` call, setup and sign-in included, answers `403 NOT_PAIRED`.
- **The HP itself needs no pairing.** A request from this PC (`127.0.0.1` or `::1`) is the HP, which is how the master signs in to issue the first code. `"trustThisPC": false` turns that off.
- **A session belongs to the device it was signed in on.** A session cookie copied to another device, or sent with no device, is refused. Sessions made before 2-2 belong to no device, so everyone signs in once more, the HP's own browser included.
- **Codes** are six digits, last 10 minutes, work once, and live in memory only (a restart cancels them). At most 5 wait at once. Spaces and dashes are ignored (`123 456`). Five wrong codes lock that address out for 15 minutes, and 20 wrong codes from anywhere cancel every outstanding code, so a guesser's odds are at most about 1 in 10,000 each time the master issues a code (1 in 50,000 with a single code waiting).
- **Unpairing** deletes the device. Its token stops working on its next request, everyone signed in on it is signed out, and a browser still holding its cookie has it cleared. It can pair again with a new code, as a new device. The HP can't be unpaired.
- **Last seen**: a paired device's last request time and address are recorded, at most once a minute. `online` means seen in the last 2 minutes, until 2-3's live connection replaces it.

| Route | Who | Does |
| --- | --- | --- |
| `GET /api/pairing` | anyone | `{ required, paired, thisPC, device }` for the calling device |
| `POST /api/pairing/claim` | an unpaired device | `{ code, name, kind?, os? }` → `201 { device }` and the `attic_device` cookie |
| `GET / POST /api/pairing/codes` | master | Outstanding codes / issue one `{ id, code, issuedAt, expiresAt }` |
| `DELETE /api/pairing/codes/:id` | master | Cancel a code |
| `GET /api/devices` | signed in | The HP and every paired device: `id, name, kind, os, role, online, lastSeenAt, thisPC`; the master also gets `pairedAt, pairedBy, lastAddress` |
| `DELETE /api/devices/:id` | master | Unpair |

`kind` is one of `laptop`, `desktop`, `handheld`, `phone`, `tablet`, `other`. The HP's own entry uses `"serverKind"` from `config.json` (default `desktop`).

Pairing is on by default. To turn it off while the client's half is being built, set `"pairing": { "required": false }` in `config.json`; the server's start-up lines say `Pairing: OFF`.

`pairing.test.js` covers it against a real server. `127.0.0.1` is the HP, and `127.0.0.2` and up stand in for other machines.

## Live stats (Phase 2, milestone 2-3, D-03 and D-04)

The Devices view goes live through one WebSocket, `GET /api/hub`. `hub.js` keeps the latest stats per device and who is connected; `ws.js` is a small WebSocket implementation in core Node (JSON text frames up to 64 KB, ping/pong, close). This is the HP's half of 2-3. The agent that collects a client's stats with `systeminformation`, and the Devices view switching from mock to live, are the Acer's half.

**Two kinds of connection**

| | Opens | Identified by | Gets |
| --- | --- | --- | --- |
| **Agent** (a client PC's background part) | `ws://<HP>:8080/api/hub?role=agent` | Its device token alone (`X-Attic-Device` header or `attic_device` cookie). No user session: it reports about the machine, and can read nothing back | `{"type":"hello","deviceId","interval":3000}`, then nothing but errors |
| **Viewer** (the interface) | `ws://<HP>:8080/api/hub` | A session on a paired device, like any API call | `{"type":"devices","devices":[…]}` first (the same list as `GET /api/devices`), then `{"type":"device","device":{…}}` per change and `{"type":"removed","id"}` on unpair |

**The agent's report**, about every 3 seconds:

```json
{ "type": "stats",
  "stats": { "cpu": 22, "ramTotal": 8000000000, "ramUsed": 5600000000, "diskTotal": 512000000000, "diskFree": 188000000000, "battery": 78, "charging": false },
  "connection": "wifi", "ip": "192.168.1.23" }
```

`stats` is the shape the Devices view already reads. Bytes are numbers, percentages are 0–100, and `battery` is `null` without one. `connection` is `wifi`, `ethernet` or `other`. A report that doesn't check out gets `{"type":"error","code":"INVALID"}` and changes nothing. Reports closer together than about a second are ignored.

**Who sees what**
- **The master** gets every change as it arrives: stats, `ip` and `statsAt`, plus `lastStats` once a device goes offline. In the tests a report reaches the master in a few milliseconds, against the 5-second acceptance target.
- **Everyone else** sees each device's name, kind, `online`, `lastSeenAt` and `connection`, with `stats: null`. They hear only when a device comes or goes, never stats changes.
- **The HP** measures itself (`self-stats.js`: CPU, RAM and the system drive, from core Node; battery `null`) every 3 seconds, and only while a master has the Devices view open.

**Online** means a device's agent is connected. A device with no agent (the iPhone's browser, `browserOnly: true`) is online while its interface is connected, or for 2 minutes after its last request. A dropped agent shows offline as soon as its connection ends; one that goes silent is dropped after 35 seconds without a reply to a ping.

**Safety**
- A browser's `Origin` must be this server, so a page on another site can't open a hub connection with your cookies.
- Unpairing closes that device's agent and viewers at once. Signing out, a password change, a revoke or a removal closes the connections whose session ended, and every connection is re-checked on each 15-second ping.
- One agent per device: a new one (the tool restarted) replaces the old.
- More than 40 messages in 10 seconds closes the connection. So does a binary, fragmented, unmasked or oversized frame, each with the RFC's close code.
- The latest stats are kept in `server/data/device-stats.json`, written at most every 30 seconds and when an agent disconnects.

`hub.test.js` plays both an agent on "another machine" (127.0.0.2) and the interface on the HP.

## Send to device and the offline queue (Phase 2, milestone 2-4, D-05 and D-07)

Every client talks only to the HP, so a file from the Acer to the ROG Ally goes in two legs. `transfers.js` holds it in between. This is the HP's half of 2-4; the "Send a file" button, the device picker, and the agent saving into the Hub Inbox are the Acer's half.

1. **Upload.** The sender says what's coming (`POST /api/transfers { to, fileName, size }`), then streams exactly that many bytes (`PUT /api/transfers/:id/file`, with `X-Attic-Upload: 1`). The HP spools the file to `server/data/transfers/<id>.bin`, or to the folder named in `"transferSpool"` in `config.json`. The transfer is then `queued`.
2. **Delivery.** If the receiving device's agent is connected to the hub, it gets `{"type":"transfer","transfer":{…}}` at once. If not, then when it next connects, its first message after `hello` is `{"type":"inbox","transfers":[…]}` with everything waiting for it. That is the offline queue. It downloads `GET /api/transfers/:id/file` (resumable with `Range`) and confirms with `POST /api/transfers/:id/received`. The HP then deletes its copy.

**Statuses** use the Transfers view's words: `active` (with `stage` `upload` or `deliver`), `queued`, `done`, `failed` and `cancelled`. Once a leg ends, `speed` (the delivery) and `uploadSpeed` hold its average in bytes per second. While a leg is moving, `bytesDone` and `speed` are live (2-5, below).

| Route | Who | Does |
| --- | --- | --- |
| `GET /api/transfers` | signed in | Master: every transfer. Others: the ones they sent, and the ones to the device they're on. Newest first |
| `POST /api/transfers` | signed in, on a paired device | `{ to, fileName, size }` → `201`, `active` / `upload` |
| `PUT /api/transfers/:id/file` | the sender, on the same device | The file, exactly `size` bytes → `queued` |
| `DELETE /api/transfers/:id` | the sender or the master | Cancel. An upload still arriving stops; the HP's copy is deleted; the receiving agent gets `{"type":"transfer-cancelled","id"}` |
| `GET /api/inbox` | the receiving device | What's waiting for it |
| `GET /api/transfers/:id/file` | the receiving device | Download, `Range` supported |
| `POST /api/transfers/:id/received` | the receiving device | Saved whole → `done` |
| `POST /api/transfers/:id/failed` | the receiving device | `{ error }`: it couldn't save the file → `failed` (the HP keeps its copy until it expires) |

**The receiving end is a device, not an account.** Its agent calls with the device token alone (`X-Attic-Device`), as on the hub; an interface signed in on that device works too. No other device or account can fetch the file: the sender, the master's browser and other devices all get "not found". The HP itself doesn't receive transfers; to put a file on the HP, upload it in Files.

**Rules**
- **Names** must be one file name that Windows can store (the same rules as share paths), up to 200 characters. Shortcuts (`.lnk`, `.url`, `.scf`) are refused. A folder goes as files, or zipped, by the sender.
- **Size:** at most 20 GB, as for uploads. The body must be exactly the declared size; anything else fails the transfer and leaves nothing behind. The HP refuses a transfer that would leave its drive with less than 1 GB free (`507 DISK_FULL`). Each account can have 50 unfinished transfers.
- **Expiry:** a file nobody collects within 14 days is deleted and the transfer fails. The HP checks hourly.
- **Restarts:** queued files survive them. An upload cut off by a restart fails; a delivery cut off goes back to `queued`. Spool files with no open transfer are deleted at start-up.
- **Unpairing** a device cancels everything that was waiting for it.
- **Live updates:** every change goes to the master's viewers, the sender's, and any on the receiving device, as `{"type":"transfer","transfer":{…}}`.

`transfers.test.js` covers both Phase 2 acceptance checks for transfers:
- A 2 GB file sent from the "Acer" arrives complete in the "ROG Ally's" inbox. The SHA-256 matches end to end, and it took about 17 s on this PC's loopback.
- A transfer to an offline device waits through an HP restart and is delivered when the device comes online.

It also covers resuming, who may fetch, cancelling mid-upload, unpairing, expiry and bad input. `test-util.js` holds the helpers it shares.

## Progress, Retry and history (Phase 2, milestone 2-5, D-06 and D-08)

This is the HP's half of 2-5. Its other half, the Transfers view on real data, is the Acer's.

**The database.** Transfers are rows in `server/data/attic.db`, a SQLite file opened through Node's built-in `node:sqlite`, so there's still nothing to install (`db.js`). Schema changes are numbered steps, run once each and recorded in `user_version`. 2-4's `transfers.json` is brought in on first start and renamed `transfers.json.imported`. Each row keeps the names as they were when the transfer started (`fromName`, `toName`, `userName`), so history still reads right after a device is unpaired or an account is removed. Finished transfers are kept for a year, up to the newest 10,000.

**Progress (D-06).** While a leg moves, the HP counts its bytes: what arrives on an upload, and what goes out on a delivery (resumed ranges included). About twice a second it sends `{"type":"progress","id","stage","bytesDone","size","speed"}` to the hub viewers who may see that transfer. `speed` is bytes per second, smoothed. The last delivery event carries the whole size. `GET /api/transfers` and `GET /api/transfers/:id` show the same live figures. Progress isn't written to the database; each leg's result is, when it ends.

**Retry** is for a `failed` or `cancelled` transfer, by the sender or the master:
- If the HP still holds the file (a delivery failed), it goes back to `queued`, and the receiving agent hears about it as if it were new.
- Otherwise (an upload failed, a transfer was cancelled, or a copy expired), it becomes `active` / `upload`, and the sender sends the file again with the same `PUT /api/transfers/:id/file`, from the device it was sent from.
- `attempts` counts the tries.

**History (D-08).** `GET /api/transfers/history` returns finished transfers (`done`, `failed`, `cancelled`) newest first, with sender, receiving device, sending device, size, and start and finish times. It returns `{ items, next }`; pass `next` back as `before` for the following page. It uses the same rule as the list: the master sees everything, anyone else their own transfers and the ones to their device.

| Route | Who | Does |
| --- | --- | --- |
| `GET /api/transfers/:id` | who may see it | One transfer, with live progress |
| `POST /api/transfers/:id/retry` | the sender or the master | `queued` again, or `active` / `upload` for a new PUT |
| `GET /api/transfers/history` | signed in | `?limit=` (default 50, at most 200), `&before=<next>`, `&status=done\|failed\|cancelled`, `&device=<id>` (either end), `&q=` (part of the file name) |

`GET /api/transfers` (the Transfers view's list) is capped at the newest 200 and takes `?limit=` up to 500.

`transfers.test.js` covers 2-5 as well:
- progress on both legs;
- live bytes in the list;
- Retry with and without the HP's copy;
- paging and every filter, including a `%` in the search;
- names kept after unpairing, and history across a restart;
- bringing in `transfers.json`.

## Notification events (Phase 3, milestone 3-2, T-05)

The HP tells each client what to notify about; the client shows the Windows notification. This is the HP's half of 3-2; the tray, start-up and the notifications themselves are the Acer's half. `events.js` does it.

| `kind` | When | Who hears it | Example `title` / `body` |
| --- | --- | --- | --- |
| `transfer.received` | A file reached a device's Hub Inbox | The receiving device | File received / Trip to Coorg.zip from Acer Aspire 5 is in your Hub Inbox. |
| `transfer.done` | A file you sent was delivered | The sender's device and account | File delivered / Trip to Coorg.zip reached ASUS ROG Ally. |
| `transfer.failed` | A file you sent didn't arrive | The sender's device and account | Transfer failed / Save backup.7z to ASUS ROG Ally didn't arrive: Not enough space on C:. |
| `device.offline` | A device's agent has been gone 30 s | Every other device, every account | ASUS ROG Ally is offline |
| `device.online` | A device announced offline is back | Every other device, every account | ASUS ROG Ally is online |

A cancelled transfer makes no notification: the person who cancelled it knows.

**Delivery.** Each event goes out at once over the hub as `{"type":"event","event":{seq,at,kind,title,body,deviceId,transferId}}`:
- **to agents** (`?role=agent`), for the device events;
- **to interfaces**, whether open on that device or signed in as that account.

`title` and `body` are ready to show. `seq` always rises, and is the same event however it arrives, so a client showing both its agent's and its interface's copy can drop duplicates.

**Catching up.** Events are kept in the database (`events` table in `data/attic.db`) for 7 days, up to 1,000. When an agent connects, its messages after `hello` include `{"type":"events","last":<newest seq>}`. A client that saved the last `seq` it showed then asks `GET /api/events?after=<seq>` for what it missed, oldest first. The response is `{ events, last, more }`, with `&limit=` (default 100, at most 500). Without `after`, it gives just `last`, for a client starting out. An agent asks with its device token; an interface with its session, which adds the account's events.

**Quiet by design:**
- **Going offline:** announced only after 30 s away, so a tool restart or a moment's Wi-Fi drop says nothing.
- **Coming online:** announced only for a device whose going was.
- **HP restarts:** after one, every agent reconnecting causes no notifications.
- **Your own device:** it never hears about itself.
- **Unpairing** a device forgets any pending announcement about it.

`events.test.js` covers:
- who hears each kind, and who doesn't;
- the failure reason;
- no notification on cancel;
- offline after the grace period, then online;
- a quick reconnect and an HP restart staying quiet;
- catching up, paging and filtering to the caller;
- events surviving a restart;
- the 7-day limit.

## Updates (Phase 3, milestone 3-5, T-10)

The HP holds the newest desktop-tool installer, and every client asks it whether there's a newer version than its own. This is the HP's half of 3-5; the tool checking, offering and installing is the Acer's half. `updates.js` does it.

**Publishing a release.** The installer must be named as the desktop build names it, `Attic-Hub-Setup-<version>.exe` (from `desktop/`, `npm run dist`). There are two ways:
- **From the PC that built it**, signed in as the master: `PUT /api/updates/files/Attic-Hub-Setup-0.7.0.exe` with the file as the body and `X-Attic-Upload: 1`. Add `?notes=` for what changed.
- **On the HP:**
  ```
  node server/publish-update.js C:\path\to\Attic-Hub-Setup-0.7.0.exe --notes "What changed"
  ```
  The running server picks it up within 30 seconds; no restart is needed.

The HP checks each upload:
- the file must be a Windows program (it starts `MZ`), up to 1 GB;
- its version comes from its name;
- it must be newer than the latest, compared as numbers, so 0.10.0 comes after 0.9.0. `replace=1` (`--replace`) re-publishes the same version.

It records the size, SHA-512 and SHA-256, and keeps the newest 3 releases in `server/data/updates/`, or in `"updatesDir"` from `config.json`, along with `manifest.json`.

**Announcing it.** A new latest release goes at once to every agent and interface as `{"type":"update","latest":{…}}`, and as the notification event `update.available` ("Attic Hub 0.7.0 is available"). Each agent also gets `{"type":"update","latest"}` when it connects (`latest: null` before anything is published).

**Reading it.** Readers are any paired device, by its device token alone (an agent), or any session.

| Route | Who | Does |
| --- | --- | --- |
| `GET /api/updates/latest?current=0.6.0` | paired device or session | `{ version, fileName, size, sha512, sha256, releaseDate, notes, url }`, plus `newer` when `current` is given. `404 NO_UPDATE` before the first release |
| `GET /api/updates/files/<installer>` | paired device or session | The installer, with `Range` for resuming. Only files in the manifest are served |
| `GET /api/updates/files/latest.yml` | paired device or session | The same release in the format electron-updater's `generic` provider reads: point it at `http://<HP>:8080/api/updates/files` and send `X-Attic-Device` in its request headers. There's no `.blockmap`, so it downloads the whole installer |
| `PUT /api/updates/files/<installer>` | master | Publish. `?notes=`, `?replace=1` |
| `GET /api/updates` | master | The kept releases, newest first |

The installers aren't code-signed yet, so Windows SmartScreen may warn when one runs. The hashes check that the file arrived intact from the HP. They don't prove who built it; only the master can publish, which is what stands in for that on the home network.

`updates.test.js` covers:
- no update before the first release;
- publishing by upload and by command line, and the announcement;
- `newer` for an older and the same version;
- download, resume and the hashes;
- `latest.yml`;
- the refusals: not the master, a bad name, not a program, the same or an older version, and path tricks;
- replacing, keeping 3, and a restart.

## HTTPS for the iPhone (Phase 4, milestone 4-1)

Safari needs HTTPS for a Home Screen web app, and the requirements want traffic encrypted. The server therefore also listens on **HTTPS, port 8443**, with the same interface and API. Plain http on 8080 stays, for the desktop tools. This is the HP's half of 4-1; the phone layout, manifest and icons are the Acer's half.

**No certificate to buy, nothing to install on the HP.** On first start the HP makes its own small certificate authority, "Attic Hub CA (DESKTOP-…)", in `server/data/tls/` (gitignored). With it, it issues a server certificate covering:
- its PC name, plain and `.local`;
- `localhost`;
- every home-network address it has.

`tls.js` builds both certificates itself and signs them with `node:crypto`, so no OpenSSL command is needed. The server certificate meets Apple's rules:
- ECDSA P-256 with SHA-256;
- its names in Subject Alternative Name;
- usable for server authentication only;
- valid for 397 days.

It's re-issued in place, with no restart, when the HP's address changes (as it did, from .12 to .3) or when it has less than 30 days left. The phone never has to trust anything again.

**The CA can only vouch for this PC.** It carries name constraints. They limit it to this PC's name, `localhost` and home-network addresses (10/8, 172.16/12, 192.168/16, 127/8). So even if its key were copied off the HP, it couldn't be used to fake a real website on a phone that trusts it. `https.test.js` checks that a certificate the CA signs for `example.com`, `www.apple.com` or `8.8.8.8` is refused.

**On the iPhone, once:**
1. In Safari, open `http://<HP address>:8080/api/tls/profile.mobileconfig` and allow the download.
2. Settings → General → VPN & Device Management → "Attic Hub (DESKTOP-…)" → Install.
3. Settings → General → About → Certificate Trust Settings → turn on "Attic Hub CA (DESKTOP-…)".
4. Open `https://<HP address>:8443`. To check it's the right CA, compare its fingerprint with `caFingerprint` from `/api/tls`.

| Route | Who | Does |
| --- | --- | --- |
| `GET /api/tls` | anyone, over http too | `{ caFingerprint, httpsPort, names, validUntil, caUrl, profileUrl }` |
| `GET /api/tls/ca.cer` | anyone | The CA certificate (DER), for anything that wants it as a file |
| `GET /api/tls/profile.mobileconfig` | anyone | The iOS profile that installs the CA |

These are public because a phone needs them before it trusts the HTTPS address, and a CA certificate is public by nature. The CA's key and the server's key never leave `data/tls/`.

**Trusted at pairing.** `POST /api/pairing/claim` now also returns `tls: { caFingerprint, httpsPort }`, so a client can pin the HP's CA.

**Over HTTPS:**
- **Cookies:** sign-in and device cookies are `Secure`.
- **Origin:** a request must come from the `https://` origin. An `http://` origin counts as another site.
- **Live hub:** it works as `wss://…:8443/api/hub`.

**Settings and failures**
- **Turning it off:** `"https": { "enabled": false }`, or set `"port"`. `"names"` adds host names; set them before the CA is first made, because its constraints are fixed then.
- **Port taken:** the server carries on over http and prints `HTTPS: off`.
- **Static files:** `.webmanifest`, `.woff2` and `.txt` are now served with their right types, for the Home Screen app.
- **Firewall:** this HP's "Node.js JavaScript Runtime" firewall rules already allow any port. Elsewhere, allow inbound TCP 8443 on the Private profile, as for 8080.

`https.test.js` covers:
- the CA and the profile over http;
- HTTPS trusted with the CA and refused without it;
- Apple's certificate rules;
- the name constraints refusing other sites, even when signed with the CA's own key;
- Secure cookies, the HTTPS origin rule and `wss://`;
- the fingerprint at pairing;
- the manifest type, and starting with the port taken;
- re-issuing on an address change and near the end, with the CA unchanged.

## Large uploads from the phone (Phase 4, milestone 4-2)

The requirements gave 4-2 no server work "unless large-video uploads need tuning". They did, in two ways. This is the HP's half; the camera-roll picker and sending from the phone are the Acer's half.

**1. No five-minute cut-off.** Node ends any request still running after 5 minutes (`requestTimeout`), and Attic had kept that default. Over Wi-Fi, a 3 GB video upload or send takes about that long, so it failed near the end. Loopback tests are too fast to show it. Now a request may take as long as it needs, and only a connection that's gone *silent* for 5 minutes (nothing sent or received) is closed. This applies to both http and HTTPS, so the one-request uploads from 1C-5 and 2-4 benefit too.

**2. Resumable uploads** (`uploads.js`). On a phone, one long request rarely survives: the screen locks, Safari goes to the background, or the Wi-Fi drops. A resumable upload sends the file in pieces and carries on after a break:

1. `POST /api/uploads`, with `{ shareId, folder, name, size }` for Files, or `{ transferId }` for a send (after `POST /api/transfers`). It answers with `{ id, offset: 0, size, chunkSize: 8388608, maxChunk }`.
2. `PUT /api/uploads/<id>?offset=<n>` with each piece as the body (`X-Attic-Upload: 1`), up to 64 MB; 8 MB is a good size. Each answer gives the new `offset`. The last one has `done: true` and `result`: the file's entry, as a Files upload returns it, or the transfer, now `queued`.
3. After a drop, `GET /api/uploads/<id>` gives the `offset` the HP has. A piece sent at the wrong offset gets `409 OFFSET` with the right one.
4. `DELETE /api/uploads/<id>` gives up, deleting what arrived.

How it behaves:
- **Bytes go straight to their destination:** a hidden `~attic-….part` file in the destination folder, or `<id>.chunked` in the transfer spool. Finishing a 10 GB video is therefore a link or a rename, not a copy.
- **Nothing is overwritten:** the file lands under a name nobody has taken (`IMG_0420 (1).MOV`). It's owned by the uploader, exactly as with the one-request upload.
- **Nothing is wasted:** the bytes of a piece cut off part-way are kept.
- **Sessions survive restarts:** they're kept in `server/data/uploads.json`. A send's transfer stays `active` / `upload` while its resumable upload is unfinished, instead of failing, and shows live progress.
- **Only the starter can continue:** the same account on the same device. Anyone else gets "not found".
- **Room is checked up front:** the share's drive must have room for the file before the upload starts.
- **Abandoned uploads are cleaned up:** a session untouched for a day is dropped. For a send, the transfer fails, ready for Retry.

| Route | Who | Does |
| --- | --- | --- |
| `POST /api/uploads` | signed in | Start, to a share's folder or a transfer you created |
| `GET /api/uploads/<id>` | the starter | `{ offset, size, … }`: where it got to |
| `PUT /api/uploads/<id>?offset=<n>` | the starter | The next piece |
| `DELETE /api/uploads/<id>` | the starter | Give up |

`uploads.test.js` covers:
- a video in pieces, with a drop mid-piece, carried on and landing whole, as the phone's own file and never overwriting;
- the wrong offset, past the end, another account or device, and bad starts;
- an HP restart mid-upload;
- an empty file;
- a send in pieces through a drop and a restart, arriving whole;
- cancelling the transfer;
- a slow upload outlasting the idle limit while a silent one is closed;
- the one-day clean-up.

## Feedback round 1 (server)

Four items from the notes after trying 0.11.0. The interface's half was built on `feedback-1-ui`.

**1. Email addresses as usernames.**
- A username can now be an email address (up to 254 characters), as well as 3–32 letters, numbers, dots, dashes or underscores.
- Sign-in matches without regard to case, and takes either the username or the account's email.
- Every account can have an `email`. A username that's an email address is the account's email unless another is given.
- `PATCH /api/accounts/:id` changes `displayName` and/or `email`, for yourself, or for anyone if you're the master.
- Usernames and emails share one name space: no account's username or email can be another's.

**2. Forgot password, by email.** `mail.js` sends mail through Gmail. It's a small SMTP client over TLS on port 465, with no mail library.

The master sets it up once with `PUT /api/mail { user, appPassword }`. The `user` is the Gmail address to send from. The `appPassword` comes from Google Account → Security → 2-Step Verification → App passwords. Google shows it in groups of four letters, and the spaces are ignored. The HP signs in to Gmail with it before keeping it. It's kept in `server/data/mail.json`, which is gitignored with the rest of `data/`, and the API never sends it back:
- `GET /api/mail` shows `{ configured, user, host, port }`;
- `POST /api/mail/test` sends a test email to the master;
- `DELETE /api/mail` forgets it.

Then:
- **`POST /api/password/forgot { login }`** (the username or the email) always gives the same answer, so it can't reveal which accounts exist. If the account has an email and mail is set up, a link `…/#/reset?token=…` is sent to it.
  - The token is random and kept only as its SHA-256 (`data/resets.json`). It lasts 30 minutes, works once, and a newer one replaces it.
  - The link uses the address the request came to, but only if that is one of the HP's own names or addresses, so a forged `Host` header can't point it elsewhere.
  - Limits: 5 requests per 15 minutes from one device, and 3 emails per hour per account.
- **`POST /api/password/reset { token, next }`** sets the new password and signs the account out everywhere. Wrong tokens count towards the sign-in lockout.
- **`POST /api/accounts/:id/set-password { next }`** lets the master set anyone else's password, signing them out. Your own is still changed with your current one.

**3. Sign up, approved by the master.**
- **`POST /api/signup { displayName, username, password, email?, deviceType? }`**, from a paired device, makes an account with `status: "pending"`.
- **Signing in before approval** gives `403 PENDING` ("waiting for the master's approval"), and only after the password is right, so it can't be used to probe.
- **The master is told** with the notification event `account.signup` ("New account waiting for approval").
- **Deciding:** `POST /api/accounts/:id/approve` makes the account active, and sends `account.approved` to the device it signed up on. `…/decline` removes it.
- **Limits:** 5 attempts an hour per device, and at most 20 waiting at once.

**4. Faster sends: relayed while they arrive.** A send used to reach the HP whole before the receiving device started, so it took the two legs end to end, about twice as long. Now:
- **Early start:** as soon as an upload starts arriving (one request or resumable), the receiving agent gets `{"type":"transfer"}` with `active` / `upload`. Its download is fed bytes as they land, and waits when it catches up.
- **Finishing:** when the upload completes, the transfer is `active` / `deliver`, and the agent's `received` completes it as before.
- **Failures:** if the upload fails or is cancelled, the download is cut off, and the agent's retry finds the transfer gone. If the receiving device reports it can't save the file, the upload is stopped.
- **Compatibility:** this needs no change to the agent; it downloads whatever it's told about, and resumes with `Range`.
- **Measured on loopback:** 8 MB sent over 2.9 s reached the receiver after 0.1 s and finished as the upload did. Real Wi-Fi is still to be measured.

`feedback1.test.js` covers all four. The email part uses a stand-in for Gmail: a local TLS SMTP server, trusted through `ATTIC_MAIL_CA`.

## Rules that carry over

The contract is fixed: every function in `ui/js/api.js` becomes an endpoint that returns the same JSON shapes the mock returns today.

- Every read goes through one scoped accessor, `visibleIndex(session)`. A missing owner filter must not be possible.
- Ownership changes (revoke, restore, remove, keep permanently) are transactions: all of it or none of it.
- No endpoint that takes a path ships before milestone 2 (path safety); none that returns a file ships before milestone 3 (login).
