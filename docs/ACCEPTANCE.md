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

**To finish 2-1 on the real HP:** pull `main` on the HP and restart the server, so `/api/hello` and discovery are running. Make sure Windows Firewall on the HP allows inbound **UDP 41980** and **TCP 8080** on the Private profile. Then start the tool on the Acer. It should find the HP without an address being typed.

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
