# Phase 1A acceptance — results

Run on 2026-10-21 against the checklist in the requirements doc. Most checks were scripted in the browser against live data rather than eyeballed. Phone checks were done with emulation at 360px, not on a real phone; see "Still to do" below.

**Result: every item passes.** Six problems turned up during the run, and all six are fixed (listed at the end).

## First run and accounts

| Check | Result | How it was verified |
| --- | --- | --- |
| Empty storage shows setup, which creates the master | ✅ | Fresh browser profile, opened from disk |
| Setup never appears again once a master exists | ✅ | `needsSetup()` returns false; `#/setup` redirects |
| Master creates a device account that can sign in | ✅ | Real Add device dialog, including its validation, then a sign-in |
| Revoked device is refused | ✅ | Revoke (with confirm), then sign-in refused |
| Wrong credentials give one generic message | ✅ | Wrong password, unknown user, and revoked account with wrong password all say "Incorrect username or password" |

## Login screen

| Check | Result | How it was verified |
| --- | --- | --- |
| Backgrounds rotate on the interval and cross-fade | ✅ | 10 s interval, in order: the two layers swap with a 1.5 s fade |
| Custom image added, selected, persists across restart | ✅ | IndexedDB image survives reloads, including from disk |
| Text legible over every bundled image | ✅ | Calculated for the worst case (pure white or black under the card): lowest is 4.77:1, which is above the 4.5:1 minimum. This holds for **any** image. |
| Master mode reachable and returns to device login | ✅ | |
| Enter submits; focus starts in username | ✅ | |
| All motion stops with reduced motion | ✅ | Emulated in Chrome: animations at 0, no zoom, background stays on one image |

## Navigation

| Check | Result | How it was verified |
| --- | --- | --- |
| All tabs render; Dashboard only for master | ✅ | A device account has no Dashboard tab; `#/dashboard` redirects |
| Back and forward work everywhere, including drill-down | ✅ | Drill-down back restores scroll exactly |
| A folder URL reloads to the same place | ✅ | Also works with `?select=` for a file |
| Tab state survives switching away and back | ✅ | Files sort and Photos scroll position both kept |

## Files

| Check | Result | How it was verified |
| --- | --- | --- |
| All three mock shares list correctly | ✅ | |
| 500-item folder scrolls smoothly | ✅ | Virtualised: about 20 rows in the page at once |
| Long names truncate in the middle, keeping the extension | ✅ | |
| Kannada and Hindi names render | ✅ | 4 Kannada and 3 Hindi names, plus a Kannada folder |
| Deep paths collapse breadcrumbs | ✅ | 9 levels → `Main storage › … › Archive`; "…" opens a menu |
| Sorting works on every column | ✅ | All 4 columns in both directions, folders always first |
| Unavailable share shows its state | ✅ | Greyed card, then its own "unavailable" screen |

## Photos, Videos, Other

| Check | Result | How it was verified |
| --- | --- | --- |
| Each tab shows only its own types | ✅ | 1,508 + 665 + 827 = 3,000 files, with 0 misfiled |
| Mixed-case extensions classify correctly | ✅ | `.JPG`, `.JPEG`, `.Mp4`, `.PDF` |
| Date grouping is correct | ✅ | Today, Yesterday and each month's count match the data |
| Lightbox opens; arrow keys navigate | ✅ | |
| "Reveal in Files" lands on the right folder | ✅ | |

## Dashboard

| Check | Result | How it was verified |
| --- | --- | --- |
| Totals equal the sum of mock file sizes | ✅ | 2,320,832,079,500 bytes, both overall and per share |
| Segment proportions match the figures | ✅ | Bar widths equal the size shares to 0.1% |
| Drill-down lists files largest first | ✅ | Every category; extension and share subtotals add up |
| Warning colours at 80% and 90% | ✅ | Amber at 85% (tested by temporarily lowering capacity), red at 93% |
| Dropped files appear in the queue with progress | ✅ | Empty file rejected with a reason |

## Cross-cutting

| Check | Result | How it was verified |
| --- | --- | --- |
| Dark and light themes work on every screen | ✅ | 9 screens × 2 themes |
| 360px width with no horizontal scrolling | ✅ | The same 18 combinations, checking every element |
| Every screen reachable by keyboard alone | ✅ | No click-only elements; real Tab, Enter and Escape walk |
| Empty states designed and different from error states | ✅ | |
| Clearing local data returns to first run | ✅ | No `fs.*` keys left behind |
| Opens directly from disk (`file://`) | ✅ | Headless Chrome: full flow, 0 console errors |

## Ownership and custody (added to the requirements on 2026-10-22)

| Check | Result | How it was verified |
| --- | --- | --- |
| A device sees only its own files and common files, in listings, search, media tabs and storage figures | ✅ | Walked every folder as the tablet: 1,429 files, exactly its own plus the common ones; media tabs match; drive cards show only those figures |
| Another account's files are absent, not greyed or locked | ✅ | Opening another account's file returns "not found"; the phone's burst folder doesn't exist for the tablet |
| Master sees every file, with an owner column and a working owner filter | ✅ | All 3,000 files; filter covers each owner, Common and In custody |
| Revoke dialog shows file count and size, and offers master or another active account as custodian | ✅ | "1,125 files (550 GB)"; the list leaves out the device itself and revoked accounts |
| After revoking, files appear under the custodian with a custody badge | ✅ | Owner shows Work laptop; badge says "Held for Pixel 8" |
| Re-adding returns exactly those files, and the confirmation states how many | ✅ | Confirmation says 1,125; the same 1,125 file IDs came back |
| Files the custodian uploaded during custody stay with the custodian | ✅ | Restore only returns files whose `uploadedBy` is the restored account; the custodian's own files were unchanged |
| Removing warns it can't be undone, and afterwards nothing returns | ✅ | Every `uploadedBy` pointing at the account is cleared |
| A new account reusing a removed username inherits no files | ✅ | A new `oldphone` owns 0 files and has 0 in custody |
| Revoking a custodian passes its files on, and the original uploader's restore still works | ✅ | Tablet → Work laptop → master, then the tablet got all 232 back |
| `rawIndex` is referenced nowhere outside the scoped accessor | ✅ | Source search: defined once, called only inside `visibleIndex` |

All-or-nothing was also tested: with storage forced to fail in the middle of a revoke, the index, the accounts and the device status all stayed unchanged.

## Phase 1B: desktop tool (2026-10-31)

| Check | Result | How it was verified |
| --- | --- | --- |
| The tool installs on the Acer and opens the Attic interface in its own window | ⏳ Needs you | Installer built (`Attic-Hub-Setup-0.2.0.exe`, 106 MB). The packaged app opens the interface in its own window; running the installer on the Acer is still to do. |
| Every Phase 1A view works inside the tool as it did in the browser | ✅ | `scripts/smoke-test.mjs` against both the dev build and the packaged exe: setup, 10 views each render content, the session survives a reload, 0 console errors |
| Devices and Transfers views show mock devices and transfers | ✅ | 4 devices (HP server, Acer, ROG Ally offline, iPhone status-only) with stats moving every 3 s; 17 transfers with live progress, a queued one, failures with Retry, and history |

Also checked: 360px with no horizontal scrolling on Devices, Transfers, Dashboard, Files, Photos and Settings, in both themes; Manrope still loads when online.

Fixed during 1B: the Google Fonts stylesheet blocked every script until it downloaded, so a fresh or offline start could freeze. It now loads without blocking. A hidden tooltip at the edge of the page widened it at 360px; tooltips now take no space until shown.

## Phase 2, milestone 2-1: finding the HP, the Acer's half (2026-11-01)

The HP's half (the discovery responder) was built and merged in pull request #5. This is the client's half: `agent/connect.js`, the start screen `ui/connect.html`, and Settings → Server.

| Check | Result | How it was verified |
| --- | --- | --- |
| A new device finds the HP without an IP address being typed | ✅ against a local server · ⏳ real HP | `discovery-test.mjs` on the dev build and the packaged exe: a fresh tool found a throwaway server by broadcast and opened its interface. The real HP didn't answer from this PC on 1 Nov, so this is still to be run against it. |
| "Looking for server" state | ✅ | The start screen shows while searching, then "Found …" or "No Attic server found" with the likely causes |
| Typed address as a fallback | ✅ | Bad addresses get a reason (`Nothing answered at 127.0.0.1:1.`, `An IP address has four numbers…`); a good one connects |
| Several servers answer | ✅ | Unit test: the screen lists them to choose from, and the one used last is marked |
| The HP changes IP | ✅ | Unit test: the remembered `serverId` is followed to its new address |
| A different server at the remembered address | ✅ | Unit test: not trusted, because the `serverId` must match |
| The HP goes away while the interface is open | ✅ | It's noticed within 30 s, and the tool shows "Reconnecting…", then "Can’t reach …" with Search again |
| Restart goes straight to the remembered server | ✅ | Reconnected in about 1 s on the dev build and the packaged exe |
| Server address in the tool's settings (Setup row) | ✅ | Settings → Server shows the HP's name and address, and Change server returns to the start screen |
| Every view still works inside the tool | ✅ | `smoke-test.mjs` against a throwaway server: 9 views, 0 console errors |

Tests: `node --test "agent/*.test.js"` (9 tests) and `node --test "server/*.test.js"` (83 tests, unchanged), all passing.

**Against the real HP (2 Nov 2026).** The HP (DESKTOP-UL55ECB) is at 192.168.1.12, on the same Wi-Fi and access point as the Acer, with its firewall correct.

- ✅ **The tool opens the real HP:** from a remembered or typed address it opened `http://192.168.1.12:8080/` in 0.6 s, confirmed the `serverId` and showed the HP's sign-in screen.
- ✅ **A discovery request sent directly to 192.168.1.12** gets the right answer: `Found DESKTOP-UL55ECB → http://192.168.1.12:8080`.
- ❌ **Discovery by broadcast fails, because the HP doesn't receive broadcasts from the Acer.** Neither the subnet broadcast nor `255.255.255.255` arrives. The same goes for the Acer's ARP lookups: until the HP contacted the Acer first, the Acer reported the HP as "Destination host unreachable". Other devices on the Wi-Fi answer the Acer's broadcasts, so this is specific to the HP. The likely cause is Wi-Fi power saving on the HP's adapter ("Wi-Fi 2"), which makes it miss broadcast frames.

So the check "a new device finds the HP without an IP address being typed" is waiting on the HP's network, not on Attic. Fixes, on the HP:
1. Device Manager → Network adapters → the Wi-Fi adapter → Power Management: untick "Allow the computer to turn off this device". On the Advanced tab, set any power-saving option (MIMO power save, packet coalescing) to off or maximum performance.
2. Control Panel → Power Options → plan settings → Wireless Adapter Settings → Maximum Performance.
3. Or, best for an always-on server: connect the HP to the router by Ethernet.

Then `node server/find-server.js` on the Acer should find the HP without its address.

**Re-run, 2 Nov 2026 (evening): ✅ discovery by broadcast now finds the real HP.** `node server/find-server.js` on the Acer, with no address given, answered `Found DESKTOP-UL55ECB → http://192.168.1.12:8080`. The desktop tool found it too, during `discovery-test.mjs`. So "A new device finds the HP without an IP address being typed" passes on the real network.

`discovery-test.mjs` now allows for the real HP being on the network. When two servers answer, the tool rightly asks which one, and the test picks its throwaway server. When the throwaway server stops, the tool moves to the only other Attic server, and the test returns to the start screen for the typed-address checks.

## Phase 2, milestone 2-2: pairing and unpairing, the Acer's half (2 Nov 2026)

The HP's half (codes, claim, device identity, unpairing) was built and merged in pull request #7. This is the interface's half, built against it. The HP's design replaced the one the Acer first drafted: issuing a code is the approval, and the device token is an HttpOnly cookie.

| Check | Result | How it was verified |
| --- | --- | --- |
| "Pair a device" works (D-02) | ✅ | Master only. It shows the HP's code in large digits with a 10-minute countdown, Copy and New code. It notices when the code is used ("ROG Ally is paired"), and closing it unused cancels the code on the HP |
| Code entry screen | ✅ | An unpaired device sees "Pair this device" before setup or sign-in. The name defaults to the PC's name (`Sanks-World`), and the device type uses the 1A detection. A wrong code shows the HP's reason, and the right one moves on to sign-in |
| Unpair button on a device card (D-11) | ✅ | Master only, not on the HP. It asks first, and warns when it's the device you're using. The device is removed on the HP |
| An unpaired device cannot list files or devices (Phase 2 check) | ✅ | `GET /api/files` from an unpaired address → `403`. Unpaired while in use, the tool goes back to "Pair this device" with the reason |
| Pairing survives a restart | ✅ | The cookie is written to disk as soon as it arrives. The first run showed that a hard kill straight after pairing could lose it |
| The token never reaches the page | ✅ | `attic_device` is HttpOnly and absent from `document.cookie` |
| Devices view on real data | ✅ | `/api/devices`: the HP plus each paired device, with "This device", online or last seen, and the last address and pairing date for the master. Live stats wait for 2-3; Transfers keeps sample data until 2-4 |
| 360px, no horizontal scrolling | ✅ | Devices and the Pair a device dialog |

Tests: `pairing-test.mjs` 19/19, `discovery-test.mjs` 13/13, `smoke-test.mjs` (10 views, 0 console errors), and `node --test "server/*.test.js"` 98/98. Fixed during the run: the dialog could take an existing device for the new one if opened before the list loaded, and deletes need a JSON body to pass the server's CSRF check.

Still to do with the real machines: pair the Acer with the real HP (the master issues the code on the HP), then the ROG Ally.

## Phase 2, milestone 2-3: live stats, the Acer's half (2 Nov 2026)

The HP's half (the WebSocket hub, its own stats, who is online) was built and merged in pull request #8. This is the agent that reports a client PC's stats, and the Devices view going live.

| Check | Result | How it was verified |
| --- | --- | --- |
| Stats on the Devices view update within 5 seconds of a change (Phase 2 check) | ✅ against a local server | A second device's report reached the master's Devices view in about 0.27 s, and a battery drop to 12% showed in red in the same time. Measured in the real tool against a throwaway server |
| The agent collects CPU, RAM, disk, battery and network (D-04) | ✅ | The Acer's first report arrived 1 s after pairing: CPU 33%, RAM 10.2 of 16.7 GB, 380 GB free of 510, battery 76%, Wi-Fi, 192.168.1.5 |
| The Devices view switches from mock to live (D-03) | ✅ | One WebSocket, a "Live" badge, and no `/api/devices` polling while it's connected. Cards change in place; a new device's card appears without a reload |
| Offline devices | ✅ | When an agent stops, its card goes offline straight away, with the last figures greyed and "Last reported …" |
| The HP's own card | ✅ | It shows its CPU, RAM and disk, and "No battery · mains", as measured by the HP itself |
| Unpairing stops the agent | ✅ | The HP closes the agent's connection (4001), the agent stops, and the tool goes back to pairing |
| Packaged app | ✅ | `live-stats-test.mjs` passes against `dist/win-unpacked/Attic Hub.exe`, so `systeminformation` is bundled |

Tests: `live-stats-test.mjs` 17/17 (dev build and packaged), `pairing-test.mjs` 19/19, `discovery-test.mjs` 13/13, `smoke-test.mjs` (0 console errors), `node --test "agent/*.test.js"` 16/16 and `node --test "server/*.test.js"` 109/109.

Still to do with the real machines: once the Acer is paired with the real HP, open Devices on the HP and watch the Acer's card. Then the ROG Ally, the second client from 2-3 on.

## Phase 2, milestone 2-4: send to device and the Hub Inbox, the Acer's half (4 Nov 2026)

The HP's half (transfer endpoints, the offline queue, delivery over the hub) was built and merged in pull request #11. This is the interface's send and the agent's receiving, built against it, and checked in the real tool against a throwaway copy of the server.

| Check | Result | How it was verified |
| --- | --- | --- |
| "Send a file" enabled (D-05) | ✅ | On every other client's card (not the HP's, which doesn't receive transfers, and not this PC's). Files or a folder from this PC; a folder goes as its files |
| Device picker | ✅ | Paired devices except this one and the HP, from the live list. It says whether each one will collect now, or later (offline, or online without the tool running) |
| Send to device from Files | ✅ | A file on the HP is read back and sent: 300 KB, queued for the Ally |
| Upload with progress | ✅ | Progress in the dialog, then a toast saying where the file is ("… is on the HP. ROG Ally gets it when it comes online.") |
| A transfer to an offline device is delivered when it comes online (Phase 2 check, D-07) | ✅ | Both ways. From the tool to the offline Ally: the HP held it, the Ally was told on connect, and the bytes matched exactly. To the tool while it was closed: delivered intact when it started again |
| A 2 GB file arrives complete in a Hub Inbox (Phase 2 check) | ✅ against a local server | `BIG=1 send-test.mjs`: 2 GB streamed from the stand-in Ally, collected by the tool at about 350 MB/s over this PC's own network; SHA-256 matches |
| Agent saves received files to the Hub Inbox | ✅ | Collected within about 0.2 s of arriving on the HP. A second file with the same name becomes "name (2)", and no partial files are left |
| Resuming and cancelling | ✅ | Unit tests against a stand-in HP: a dropped download resumes with `Range`; a cancelled or vanished transfer leaves nothing |
| Unpairing cancels what's waiting | ✅ | The Ally's queued file was cancelled when it was unpaired |
| Settings shows the Hub Inbox | ✅ | The folder, Open folder, and the files received this session |
| Packaged app | ✅ | `send-test.mjs` passes against `dist/win-unpacked/Attic Hub.exe` |

Tests: `send-test.mjs` 19/19 (20/20 with `BIG=1`), on the dev build and the packaged app. Also `node --test "agent/*.test.js"` 23/23, `smoke-test.mjs` (0 console errors), `pairing-test.mjs` 19/19, `live-stats-test.mjs` 17/17, `discovery-test.mjs` 13/13 and `node --test "server/*.test.js"` 120/120.

Found during the run: a device the HP counts as online without an agent (it made a request in the last 2 minutes) can't collect a file yet. The dialog no longer promises "collecting it now" to such a device.

Still to do with the real machines: send from the Acer to the ROG Ally over the home network, once both are paired with the real HP. The Transfers view on real data is 2-5, below.

## Phase 2, milestone 2-5: Transfers on real data, the Acer's half (4 Nov 2026)

The HP's half (live progress events, Retry, history in a SQLite database) was built and merged in pull request #13. This is the Transfers view, built against it. The last sample data (`ui/js/mockgen.js`) is gone.

| Check | Result | How it was verified |
| --- | --- | --- |
| Transfers view: progress, speed, success or failure (D-06) | ✅ | "Now" lists what's moving or waiting. A 40 MB upload from the Ally showed 0.2%, 15%, then 30%, with bytes and speed, live over the hub. Once delivered it moved to History as "Done · 41.9 MB · 150 MB/s" without a reload |
| Retry (D-06) | ✅ | After a Cancel, Retry re-sent the file from this PC by itself, because the HP had deleted its copy (attempt 2). After a reload the page no longer has the file, so Retry asked for it: the file picker opened, and the chosen file went out (attempt 3) |
| Cancel | ✅ | It moves the transfer to History as Cancelled, and stops an upload in flight |
| Transfer history with sender, receiver, size and time (D-08) | ✅ | From the HP's database, 50 at a time with Show older (50, then 54). Status filter, device filter, and search by file name ("Screenshot 4" → 10). Names are kept as they were, and the master sees "sent by …" |
| Where a waiting file is | ✅ | "On the HP, waiting for ROG Ally to collect it"; "The HP needs the file again" with Send the file, on the device that sent it |
| No polling while live | ✅ | No `/api/transfers` requests in 6 s while the hub is connected; every 5 s while it's down |
| 360px | ✅ | No sideways scrolling |

Tests: `transfers-test.mjs` 17/17. Also `send-test.mjs` 19/19, `pairing-test.mjs` 19/19, `live-stats-test.mjs` 17/17, `discovery-test.mjs` 13/13, `smoke-test.mjs` (0 console errors), `node --test "agent/*.test.js"` 23/23 and `node --test "server/*.test.js"` 126/126.

Still to do with the real machines: watch a transfer from the Acer to the ROG Ally in Transfers on the HP.

## Phase 3, milestone 3-1: server or client, the Acer's half (4 Nov 2026)

The HP's half (the startup task and the supervisor in `server/service/`) was built and merged in pull request #15. This is the desktop tool's first-launch choice and Server mode, built on it.

| Check | Result | How it was verified |
| --- | --- | --- |
| First launch: choose Server or Client mode (T-02) | ✅ | A fresh tool asks "what does this PC do?". Client goes on to look for the HP and isn't asked again; Settings → Server → "This PC is" can change it |
| Server mode, set up | ✅ | A new server: `config.json` and the storage folder created (never over an existing one). An existing folder without a server is refused with the reason; the repository's folder is accepted, so the HP keeps its accounts and history |
| Server mode, run | ✅ | "Start now" runs the server under the HP's supervisor, logging to `data\logs`; Stop stops it; closing the tool stops a server started for now |
| Open Attic on the server | ✅ | Opens the server's own interface with no pairing (it's the HP). Its Settings show "This PC is: The server" with Server controls, and hide the client-only rows |
| The installed tool runs the server as the task will (T-03) | ✅ in the packaged app | `Attic Hub.exe ...\supervisor.js`, exactly as the startup task runs it: no window, the server answers and serves the interface, and it stops cleanly (exit 0) on the Stop button's request. The server and interface ship as plain folders beside the app (`resources\server`, `resources\ui`) |
| Install as a service (Administrator prompt), and Remove | ⏳ final pass on the HP | It can't be tested without a person approving Windows' prompt. The task script is the HP's own `installScript()`, and recognising the installed task as this tool's is unit-tested |
| The HP server runs after a reboot with no one signed in (Phase 3 check) | ⏳ final pass on the HP | Install from the tool, restart the HP, don't sign in, and reach it from the Acer |

Tests: `mode-test.mjs` 14/14 on the development build, 18/18 on the packaged app. Also `node --test "agent/*.test.js"` 29/29, `node --test "server/*.test.js"` 133/133, `smoke-test.mjs` (0 console errors), `discovery-test.mjs` 13/13, `pairing-test.mjs` 19/19, `live-stats-test.mjs` 17/17, `send-test.mjs` 19/19 and `transfers-test.mjs` 17/17. The earlier tests now answer the first-launch question as a client.

Found during the run:
- **The task's run crashed the app.** Making the whole Electron process act as Node let Electron's own helper processes inherit the setting, and Chromium gave up. Now only the supervisor's own child process runs as Node.
- **A relative supervisor path broke the task's run.** It's now made absolute first.
- **electron-builder can't unpack files from outside `desktop/`.** The server and the interface now ship as `extraResources` instead.

## Phase 3, milestone 3-2: tray, start-up and notifications, the Acer's half (5 Nov 2026)

The HP's half (notification events, kept and caught up) was built and merged in pull request #17. This is the tray, start-up, and the notifications themselves, checked in the real tool against a throwaway server, with a stand-in ROG Ally.

| Check | Result | How it was verified |
| --- | --- | --- |
| Client mode lives in the system tray (T-04) | ✅ | The tray says "Connected to …". Its menu has Open Attic Hub, Open Hub Inbox, Start with Windows, Notifications (three switches) and Quit. Closing the window hides it, and the tool keeps running; the first time, a notification says where it went |
| Starts with Windows, can be turned off (T-04) | ✅ installed app | Switching it on and off in Settings adds and removes the real start-up entry. Started that way (`--hidden`) it begins in the tray. A development copy greys it out. The test leaves no start-up entry behind |
| A received file triggers a Windows notification on the client (Phase 3 check, T-05) | ✅ against a local server | "File received from ROG Ally: Save backup.7z · 300 KB · in your Hub Inbox", with the window closed. Three files at once made one notification. The HP's own copy of the event isn't shown a second time |
| Transfer done or failed (T-05) | ✅ | From the HP's events: "File delivered: Report.pdf reached ROG Ally." and "Transfer failed: … didn't arrive: Not enough space on C:." |
| Device online or offline (T-05) | ✅ | "ROG Ally is offline" after the HP's 30 s grace, and "ROG Ally is online" when it reconnected |
| Missed while closed | ✅ | A failure that happened while the tool was closed was shown on its next start, and nothing already shown appeared again |
| Switches | ✅ | Turned off from the tray, files still arrived but nothing was shown. Settings → This PC shows the same switches, and a change there is kept and followed by the tray |

Tests: `tray-test.mjs` 19/19 on the development build, 20/20 on the packaged app. Also `node --test "agent/*.test.js"` 37/37, `node --test "server/*.test.js"` 140/140, `mode-test.mjs` 14/14 (18/18 packaged), `smoke-test.mjs` (0 console errors), `discovery-test.mjs` 13/13, `pairing-test.mjs` 19/19, `live-stats-test.mjs` 17/17, `send-test.mjs` 19/19 and `transfers-test.mjs` 17/17.

For the final pass on the real machines: the notifications on the Acer for a file from the ROG Ally, and start-with-Windows after a real sign-in.

## Phase 3, milestone 3-3: Hub Inbox and sending shortcuts (5 Nov 2026)

3-3 has no server side. Everything below was checked in the real tool against a throwaway server, with a stand-in ROG Ally.

| Check | Result | How it was verified |
| --- | --- | --- |
| Choose the Hub Inbox folder (T-07) | ✅ | Settings → Hub Inbox → Change folder: the next file from the Ally landed in the chosen folder, not the old one. A folder that isn't a full path is refused with the reason. Use the default puts files back in Downloads\Attic Hub Inbox |
| Right-click "Send to Attic Hub" in File Explorer (T-06) | ✅ | Two launches as Explorer makes them (`--send` a file, `--send` a folder) opened one Send dialog: the file, plus the folder as "2 files". All three were queued for the Ally, and the file arrived byte for byte. In the packaged app, the switch adds the per-user entry for this program and removes it again; the test leaves none behind |
| Retry for a file sent from Explorer | ✅ | After a reload, Retry sent it again from its path without asking (attempt 2) |
| Drag a file onto the window to send it (T-08) | ✅ | "Drop to send to a device", then the Send dialog with the file, then sent. A drop on the Dashboard's Upload area still uploads to the HP |
| Drag a file onto the tray icon (T-08) | ⛔ not possible on Windows | Electron (like Windows itself) only lets a tray icon take drops on macOS. The window and Explorer's right-click are the ways in |

Tests: `shortcuts-test.mjs` 12/12 on the development build and on the packaged app. Also `node --test "agent/*.test.js"` 41/41, `node --test "server/*.test.js"` 148/148, `tray-test.mjs` 19/19, `mode-test.mjs` 14/14, `smoke-test.mjs` (0 console errors), `discovery-test.mjs` 13/13, `pairing-test.mjs` 19/19, `live-stats-test.mjs` 17/17, `send-test.mjs` 19/19 and `transfers-test.mjs` 17/17.

Found during the run:
- **A development launch sent its own folder.** Chromium moved the app's own "." argument after `--send`, and it was taken as a picked folder. Only full paths after `--send` are taken now, which is all File Explorer ever passes.
- **The Settings hint grew with each change** (from 3-2): it added "(The installed Attic Hub only…)" again on every switch. It's now set fresh each time.

For the final pass on the real machines: right-click a file on the Acer in Windows 11's File Explorer, and uninstall to see the entry go.

## Phase 3, milestone 3-4: ROG Ally low-resource mode (5 Nov 2026)

3-4 has no server side. Checked in the real tool against a throwaway server. The game watcher was the real one, told about a Steam game through a registry key of the test's own (never Steam's), and shown a real full-screen window from another program.

| Check | Result | How it was verified |
| --- | --- | --- |
| Automatic by default on a client; off with no game | ✅ | Settings → This PC → Low-resource mode shows Automatic and "Off now: no game is running". The watcher was compiled on first use into the tool's own folder (under a second) and is running |
| A game turns it on (T-09) | ✅ | A Steam game starting turned it on within a moment: Settings says "On now: a Steam game is running", and the tray says so too. A full-screen window from another program did the same ("a full-screen app is in front"). A maximized window doesn't count |
| Slower stats interval (T-09) | ✅ | The agent reports every 15 s instead of 3 s, and reads battery and network (PowerShell each time) every 2 minutes instead of 30 s. At the HP, no report arrived for 10 s after the change, and this PC stayed online throughout |
| No animations while a game runs (T-09) | ✅ | The interface takes the low-resource class: no animations, transitions or blur behind glass panels, and the login background stops changing |
| Back to normal when the game ends | ✅ | A report straight away, then every 3 s again; the interface moves again |
| Always on, Off, and the tray | ✅ | Always on: on without a game, and the watcher stops. Off: stays off with a game running. The tray's Low-resource mode menu shows and changes the same choice, kept in `prefs.json` |
| The watcher ends with the tool | ✅ | Quit from the tray: its process ended too. It uses about 16 MB of memory and no CPU between checks |

Tests: `low-resource-test.mjs` 16/16 on the development build and on the packaged app. Also `node --test "agent/*.test.js"` 46/46, `node --test "server/*.test.js"` 148/148, `tray-test.mjs` 19/19, `shortcuts-test.mjs` 12/12, `mode-test.mjs` 14/14, `smoke-test.mjs` (0 console errors), `discovery-test.mjs` 13/13, `pairing-test.mjs` 19/19, `live-stats-test.mjs` 17/17, `send-test.mjs` 19/19 and `transfers-test.mjs` 17/17.

Found during the run:
- **A maximized window looked like a game.** With the taskbar hidden, a maximized window covers the screen exactly like a full-screen one. Maximized windows don't count now; games and full-screen video aren't maximized windows.
- **The tray test could read the page before its bridge was ready** after a hidden start. It waits now.

For the final pass on the real machines: on the ROG Ally, start a Steam game and a Game Pass game (full screen), and check the tray says low-resource mode is on, and the HP's Devices view still shows the Ally online.

## Phase 3, milestone 3-5: updates from the HP, the Acer's half (5 Nov 2026)

The HP's half was done in pull request #18. Checked in the real tool against a throwaway copy of the real server. The "installer" was a stand-in compiled for the test: a real Windows program that only writes down how it was started, so nothing was installed on this PC.

| Check | Result | How it was verified |
| --- | --- | --- |
| Check now, before anything is published | ✅ | Settings → About → Updates: "Up to date. The HP has no update to offer yet." |
| Publish an update (master) | ✅ | Settings → Advanced → Publish an update, with a note: the HP keeps it, and Settings lists it |
| The tool hears, downloads and checks it (T-10) | ✅ | The HP's announcement started the download at once. The file matched the HP's SHA-512, and Settings says "9.9.9 is ready to install. What's new: Faster sending". The unit tests also cover a cut-off download resuming, and a file that doesn't match being deleted |
| It's offered (T-10) | ✅ | A notification, shown once per version (not again after a restart), "Restart to update to 9.9.9" in the tray, and the same button in Settings |
| Not during a game | ✅ | A release published while low-resource mode was on waited ("It downloads once the game ends"), then downloaded when it ended, and replaced the older download |
| Restart to update | ✅ | It ran the downloaded installer with `/S --updated --force-run` and quit. electron-builder's installer scripts were read to confirm that, for this installer, those start Attic Hub again after a silent install |
| The HP updating itself | ✅ in part | The HP can ask its own server without pairing. Stopping the service for the update, and starting it again afterwards, needs the real HP |

Tests: `update-test.mjs` 12/12 on the development build and on the packaged app. Also `node --test "agent/*.test.js"` 52/52, `node --test "server/*.test.js"` 148/148, `smoke-test.mjs` (0 console errors), `tray-test.mjs` 19/19, `mode-test.mjs` 14/14 (18/18 packaged), `discovery-test.mjs` 13/13, `pairing-test.mjs` 19/19, `live-stats-test.mjs` 17/17, `send-test.mjs` 19/19, `transfers-test.mjs` 17/17, `shortcuts-test.mjs` 12/12 and `low-resource-test.mjs` 16/16. The full installer builds: `Attic-Hub-Setup-0.10.0.exe`, 112 MB.

Found during the work:
- **An update would have removed the Explorer entry.** The new installer runs the old uninstaller, and the 3-3 uninstall step deleted "Send to Attic Hub" every time. It now keeps it during an update. The tool would have put it back on its next start anyway.

For the final pass on the real machines:
- install 0.10.0 on the Acer, publish a newer build from its Settings, and restart into it;
- do the same on the HP with the service running, and check it's running again afterwards.

## Phase 4, milestone 4-1: phone layout and Home Screen app, the Acer's half (5 Nov 2026)

The HP's half (HTTPS the iPhone trusts) was done in pull request #23. Checked with a browser emulating an iPhone: Safari's user agent, touch, 390 px and 320 px wide, and no desktop tool. It reached a throwaway copy of the real server at this PC's network address, over http and then over HTTPS. Only certificates from the HP's own CA were accepted.

| Check | Result | How it was verified |
| --- | --- | --- |
| Moving to the secure address | ✅ | Over http, the pairing screen and Settings → This iPhone show the four steps (with the CA's fingerprint) and Open the secure address. The profile they link to downloads from the HP. The phone stayed paired and signed in over HTTPS, and Settings then says it's encrypted |
| Layout at phone width | ✅ | Every view (Dashboard, Files, a photo folder, Documents, Photos, Videos, Other, Devices, Transfers, Settings) and the Send, Pair a device and file details sheets, at 390 px and 320 px: nothing wider than the screen, and nothing scrolling sideways |
| Touch | ✅ | Every tap target at least 40 px (buttons 44 px), and every text field 16 px, so Safari doesn't zoom in when one is tapped |
| Tab bar | ✅ | All seven labels whole at 390 px and 320 px ("Home" for Dashboard on narrow phones). Toasts sit above it |
| Home Screen app | ✅ | `manifest.webmanifest` (standalone, served as `application/manifest+json`), icons that load at their stated sizes (192, 512, 512 maskable, and a 180 px Apple touch icon), and Safari's full-screen tags. Content stays clear of the notch and home indicator |
| Desktop-only actions hidden | ✅ | No Choose a folder, no Drag files here (the button says Choose photos or files), no Publish an update |

Tests: `phone-test.mjs` 14/14. Also `node --test "agent/*.test.js"` 52/52, `node --test "server/*.test.js"` 157/157, and every desktop suite: `smoke-test.mjs` (0 console errors), `tray-test.mjs` 19/19, `mode-test.mjs` 14/14, `discovery-test.mjs` 13/13, `pairing-test.mjs` 19/19, `live-stats-test.mjs` 17/17, `send-test.mjs` 19/19, `transfers-test.mjs` 17/17, `shortcuts-test.mjs` 12/12, `low-resource-test.mjs` 16/16, `update-test.mjs` 12/12.

Found and fixed:
- **Safari would zoom into every text field:** they were 15 px.
- **Buttons were 30–32 px tall** on a phone. On touch screens they're now 40–44 px. That includes the desktop tool on the ROG Ally's touch screen.
- **The tab bar squeezed its labels.** "Transfers" was cut off at 320 px.
- **Toasts covered the tab bar.**
- **The pairing card scrolled sideways** at 390 px (it kept its 420 px width).
- **A share's long folder path** made Files scroll sideways.

For the final pass on the real iPhone:
- install the HP's profile and trust it;
- open the secure address, and add Attic to the Home Screen;
- check the notch and home indicator in portrait and landscape, and the light and dark themes.

## Phase 4, milestone 4-2: camera-roll upload and send, the Acer's half (5 Nov 2026)

The HP's half (no time limit on long uploads, resumable uploads) was done in pull request #24. Checked in the same emulated iPhone as 4-1, over HTTPS, with the connection slowed to 6 MB/s and then cut for 4 seconds part-way.

| Check | Result | How it was verified |
| --- | --- | --- |
| Upload a video from the camera roll | ✅ | A 40 MB "IMG_0420.MOV" chosen in Files → Upload went up in 8 MB pieces. Cut off at 15%, the button said "Waiting…", then it carried on by itself and landed byte for byte, with no half-sent file left in the folder |
| Send a video to a device from the phone | ✅ | Devices → Send a file offers "Choose photos or files". A 24 MB clip sent to the ROG Ally showed "Waiting for the connection… carries on by itself" during the cut, then was queued and delivered intact |
| Big files from the PCs too | ✅ | `send-test.mjs` with `BIG=1`: a 2 GB file sent from the desktop tool now goes in pieces, up in 10 s and delivered intact at 192 MB/s |
| The screen stays on while sending | ✅ in part | Screen Wake Lock is requested while pieces go up. Whether Safari grants it needs the real iPhone |

Also removed: the last test leftovers in the product. These were the made-up 100–300 ms delays on settings, the "Simulate failures" switch, "sample data" wording, "arrives in Phase 2/4" notes, a disabled Delete button, and a "0.2.0 · Phase 1B" version label.

Tests: `phone-test.mjs` 17/17. Also `node --test "agent/*.test.js"` 52/52, `node --test "server/*.test.js"` 165/165, and every desktop suite: `smoke-test.mjs` (0 console errors), `tray-test.mjs` 19/19, `mode-test.mjs` 14/14, `discovery-test.mjs` 13/13, `pairing-test.mjs` 19/19, `live-stats-test.mjs` 17/17, `send-test.mjs` 20/20 (with `BIG=1`), `transfers-test.mjs` 17/17, `shortcuts-test.mjs` 12/12, `low-resource-test.mjs` 16/16, `update-test.mjs` 12/12. Packaged app: smoke, low-resource, shortcuts and update tests pass. Installer: `Attic-Hub-Setup-0.11.0.exe`, 112 MB.

For the final pass on the real iPhone: upload a real 4K video from the camera roll, and lock the screen part-way. Also check whether Safari's picker sends the original, or a smaller or converted copy (HEIC to JPEG, a compressed video). If it converts, note which picker setting keeps the original, for the user guide.

## Problems found and fixed during the run

1. **Focus after navigation:** after opening a folder or tab, keyboard focus fell back to the top of the page, so you had to Tab through the header again. It now moves into the new content.
2. **Reduced motion:** the login background kept changing pictures on its timer. It now stays on one image.
3. **Details dialog on phones:** long paths made it wider than the screen, cutting off "Reveal in Files". This affected Photos, Videos and Other.
4. **Drill-down on phones:** the "By share" bars disappeared at 360px.
5. **Device list at medium widths:** rows were crushed at about 730–1060px and caused sideways scrolling.
6. **Grid cards in Other:** the last line of text on each card was clipped.

## Still to do (needs you)

- **A real phone.** Everything above was emulated. Open it on your Pixel or tablet and click through it.
- **Google Fonts:** keep the link or drop it. It's the only network request, and offline the app falls back to the system font without problems.
