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
