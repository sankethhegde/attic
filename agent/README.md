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

The device token arrives as an `HttpOnly` cookie in the window's session. The desktop tool writes it to disk as soon as it changes (`desktop/main.js`), so a crash straight after pairing doesn't lose it.

Tests: `desktop/scripts/pairing-test.mjs`. It runs the real tool against a throwaway server with pairing required, reaching it through this PC's network address so the server treats the tool as a new device.

## Live stats (milestone 2-3, D-03 and D-04) — built

Once this PC is paired, the desktop tool's main process reads the device token from the `attic_device` cookie (only the main process can; the page never sees it) and starts the agent. Pairing starts it, unpairing stops it, and the tool restarts it when it moves to another server.

- **`hub-agent.js`** opens `ws://<HP>:8080/api/hub?role=agent` with the token as `X-Attic-Device`, using the WebSocket built into Node and Electron. It waits for `{"type":"hello","interval":3000}`, then sends `{"type":"stats","stats":{…},"connection","ip"}` every `interval`. A dropped connection is retried after 1, 2, 4, 8, 15, then 30 s. Close code 4001 (unpaired) or 4000 (replaced by a newer agent) stops it for good.
- **`stats.js`** collects the report. CPU (from the per-core counters), RAM and the system drive come from core Node on every report, because they're cheap. Battery and Wi-Fi or Ethernet come from `systeminformation` (5.33.15, a dependency of `desktop/`). On Windows it starts PowerShell and takes about a second, so those two are refreshed every 30 s in the background and reused in between.
- **Settings → Server → Live stats** shows what the agent is doing: Sending to the HP, Reconnecting…, or Off.

The Devices view opens the same hub without `role` (`api.openHub`). It gets the list first, then one device at a time as each reports, so the cards change in place. While that connection is down it shows "Reconnecting…" and polls `/api/devices` every 5 s. The server's side is in [server/README.md](../server/README.md#live-stats-phase-2-milestone-2-3-d-03-and-d-04).

Tests: `node --test "agent/*.test.js"` (the agent's logic and the collector, offline), and `desktop/scripts/live-stats-test.mjs`. The second pairs the real tool with a throwaway server, checks its reports reach the HP, and plays a second device's agent to time a report reaching the master's screen.

## Send to device and the Hub Inbox (milestone 2-4, D-05 and D-07) — built

Every file goes through the HP, which holds it until the receiving device collects it. The server's side is in [server/README.md](../server/README.md#send-to-device-and-the-offline-queue-phase-2-milestone-2-4-d-05-and-d-07).

**Sending** happens in the interface (`ui/js/views/send.js` and `api.sendToDevice`), so it works the same in a browser.
- Each file is announced with `POST /api/transfers { to, fileName, size }`, then streamed with `PUT /api/transfers/:id/file`, with progress shown.
- A folder goes as its files, one by one, because a transfer carries one file name.
- A file already on the HP (Files → Send to device) is read back from the HP first, because the HP has no copy-in-place for transfers.

**Receiving** is the agent's job, in the desktop tool's main process:
- **`receiver.js`** listens on the agent's hub connection:
  - `{"type":"inbox","transfers":[…]}` arrives on every connect: the offline queue.
  - `{"type":"transfer"}` arrives the moment something new is sent to this PC.
- **One file at a time**, it downloads `GET /api/transfers/:id/file` with the device token, checks the size, moves the file into the inbox, and confirms with `POST …/received`.
  - A dropped connection resumes with `Range` from the part file, after 2, 5 and 15 s. Past that, the HP lists the file again on the next connect.
  - A file this PC can't save (disk full, no permission) is reported with `POST …/failed`.
  - `transfer-cancelled` drops the download, part file and all.
- **`inbox.js`** is the file-system side, in `Downloads\Attic Hub Inbox` (`ATTIC_INBOX` overrides it, for tests):
  - Windows-safe names, and a clash becomes `name (2).ext` rather than an overwrite.
  - Downloads in progress sit in the hidden `.attic-partial` folder, named by transfer, so they can resume.
- **Settings → Server → Hub Inbox** shows the folder, opens it, and lists what arrived this session. Choosing another folder is milestone 3-3 (T-07).

Only a device whose agent is running collects files. A device that's online only through its browser (`browserOnly`) gets the file later, and the Send dialog says so.

Tests:
- `node --test "agent/*.test.js"` covers `inbox.js`, and `receiver.js` against a stand-in HP: confirming, resuming, and cancelled transfers.
- `desktop/scripts/send-test.mjs` runs the real tool against a throwaway server, sending both ways, including a file sent while the tool was closed. `BIG=1` adds a 2 GB file.

## Progress, Retry and history (milestone 2-5, D-06 and D-08)

The agent needs nothing new for 2-5. Retry on the HP re-announces a queued transfer exactly like a new one, and `receiver.js` collects it as before. The Transfers view in `ui/` does the rest, as described in the main README.

## Server or client (Phase 3, milestone 3-1, T-02 and T-03)

The same tool runs on every PC. The first launch asks which this PC is; the server's side runs the HP's service (`server/service/`) from the tool.

- **`mode.js`** keeps the answer in `mode.json` in the tool's user-data folder. For the server it also checks or creates the server's folder:
  - `createServer()` writes a new `config.json` (one share per chosen folder, pairing and discovery on) and never overwrites an existing one.
  - `checkExisting()` accepts a folder with a usable `config.json`, including the repository's top folder.
- **`server-control.js`** drives the Windows startup task "Attic Hub Server":
  - `status()` reads whether the task is installed and points at this tool, whether the supervisor is running (`data\supervisor.json`), and whether the server answers.
  - `install()` and `remove()` run the HP's `installScript()` or `Unregister-ScheduledTask` in an elevated PowerShell, through Windows' permission prompt.
  - `start()`, `stop()` (the supervisor's stop file first, then the task), `restart()` and `logs()`.
  - `startNow()` runs the supervisor as a child of the tool, with nothing installed.
  - PowerShell runs asynchronously, so the window never freezes.
- **`desktop/main.js`** launched as `Attic Hub.exe <...>\supervisor.js` (which is what the task does) starts no window. It runs the supervisor as a Node-mode child of itself, pointed at the chosen folder, and exits when the supervisor does. Only the child gets `ELECTRON_RUN_AS_NODE`: Electron's own helper processes can't run with it.

Tests: `node --test "agent/*.test.js"` (`mode.js`, and `server-control.js` without a real task). Also `desktop/scripts/mode-test.mjs`, the real tool in both modes; with the packaged exe it also starts the server exactly as the task will. Nothing installs a real task; that's for the final pass on the HP.

## Tray, start-up and notifications (Phase 3, milestone 3-2, T-04 and T-05)

- **`prefs.js`** holds the tool's own per-PC preferences in `prefs.json`: start with Windows (on for a client, off for the server), three notification switches (`received`, `transfers`, `devices`), and the newest HP event shown, per server.
- **`notify.js`** decides what to show:
  - `createNotifier()` takes each file the receiver saves. One file gets its own notification, and clicking it shows the file in File Explorer. Files landing within 2.5 s become one notification, which opens the inbox.
  - `createEventFeed()` takes the HP's events from the agent's hub connection (`{"type":"event"}` live, `{"type":"events","last"}` on connect). It shows delivered, failed, offline and online events, if switched on. After a restart it catches up with `GET /api/events?after=<last shown>`, and more than three missed events become one summary. The HP's own "file received" event is only marked as seen, since the notifier above has already shown it with the file's location. A first connect to an HP shows nothing old.
- **`desktop/tray.js`** is the tray icon and menu. `desktop/main.js` keeps the window alive when it's closed, starts hidden with `--hidden` (how Windows starts it), and registers start-with-Windows with `app.setLoginItemSettings`, in the installed app only.

Tests: `node --test "agent/*.test.js"` (`notify.js` and `prefs.js`). Also `desktop/scripts/tray-test.mjs`, the real tool with a stand-in ROG Ally, run with `ATTIC_TEST_HOOKS=1` so the test can read the tray menu and the notifications shown.

## Hub Inbox folder and sending shortcuts (Phase 3, milestone 3-3, T-06, T-07, T-08)

- **The inbox folder** is `prefs.inboxDir` (null: the default in Downloads). `inbox.checkFolder()` accepts only a full path it can create and write to. The receiver reads the folder once per file, so a change applies from the next file.
- **`explorer.js`** writes "Send to Attic Hub" for files (`*`) and folders (`Directory`) under `HKCU\Software\Classes`, with Windows' `reg.exe` and no Administrator rights. The command is `"<Attic Hub.exe>" --send "%1"`. `desktop/build/installer.nsh` removes it on uninstall. `sendPaths()` takes only full paths after `--send`, because Chromium can reorder a launch's arguments.
- **`desktop/main.js`** gathers `--send` launches (one per picked item, through the single-instance handoff) for 0.7 s, then asks the interface to show its Send dialog. If nobody is signed in yet, the interface picks them up after sign-in.
- **`uploader.js`** sends those files from the main process, since the page can't read a path: it expands folders into their files, then does `POST /api/transfers` and `PUT` the file, streamed from disk with the window's own cookies. The tool remembers each transfer's path, so Retry sends the same file again.
- **Dropping files on the window** is handled in the interface (`ui/js/views/send.js`), which opens dropped folders into their files.

Tests: `node --test "agent/*.test.js"` (`explorer.js`, `checkFolder`, the new preferences). Also `desktop/scripts/shortcuts-test.mjs`, the real tool with real `--send` launches; with the packaged exe it also checks the real registry entry, and always removes it.

## Still to come

The rest of Phase 3: the ROG Ally's low-resource mode (3-4), and updates (3-5).
