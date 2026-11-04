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
