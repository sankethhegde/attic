# server/ — the HP server (Phase 1C)

The server that runs on the HP laptop. Built one milestone at a time from `docs/PHASE-1C.md`.

**Now: milestones 1–6, the whole brief.** Core Node only, no install step. It serves `ui/`, reports the real drives, owns accounts, passwords and sessions, browses, downloads and uploads real folders, enforces who owns what, and indexes every share for Photos, Videos, Other and the Dashboard. The browser's file mock is gone; only Devices and Transfers keep sample data, until Phase 2.

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

## Rules that carry over

The contract is fixed: every function in `ui/js/api.js` becomes an endpoint that returns the same JSON shapes the mock returns today.

- Every read goes through one scoped accessor, `visibleIndex(session)`. A missing owner filter must not be possible.
- Ownership changes (revoke, restore, remove, keep permanently) are transactions: all of it or none of it.
- No endpoint that takes a path ships before milestone 2 (path safety); none that returns a file ships before milestone 3 (login).
