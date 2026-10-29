# Attic — Phase 1A

The browser interface for the home file server, running entirely on mock data. Open `index.html` in a browser; there's nothing to install and no server to run.

> **The sign-in is a UI shell and is not secure.** Everything lives in browser storage, readable from dev tools. Use placeholder passwords such as `test1234`, and never put real files behind it. In Phase 1B the auth code in `js/api.js` gets deleted and rewritten server-side, not ported.

## First run

1. Open `index.html`. With empty storage you get the one-time setup screen for the master account.
2. Setup also seeds four device accounts, all with password `test1234`: `phone`, `worklaptop`, `tablet`, and `oldphone` (revoked).
3. Device accounts sign in from the main form. The master signs in through **Sign in as master**.
4. If you don't remember an account, open **Test accounts** at the bottom of the login card. It lists every account, and clicking one switches to the right mode and fills in the username. It's prototype-only: `api.listTestAccounts()` must be deleted in Phase 1B, because a real server never shows usernames to someone who hasn't signed in.

## Layout

| Path | What it is |
| --- | --- |
| `js/api.js` | **The only data gateway.** Every function is async, adds 100–300 ms of delay, and can fail. Phase 1B rewrites its insides and nothing else. |
| `js/mockgen.js` | Seeded generator for the roughly 3,000-file index. The same seed always produces the same data. It includes the awkward cases on purpose. |
| `js/util.js` | Classification (extensions are lowercased first), size and date formatting, middle truncation, and icons |
| `js/idb.js` | IndexedDB store for custom login backgrounds (`fs.backgrounds`) |
| `js/device.js` | Detects phone / tablet / laptop / desktop and draws the device illustrations. Phone vs tablet comes from the user agent. Laptop vs desktop is inferred from the Battery API, because browsers don't report it. A guess is labelled "Best guess", and a correction made with **Change** is saved as `thisDevice` in settings. |
| `js/ui.js` | Logo, dialogs, menus, toasts, skeletons, and the virtual list |
| `js/views/*` | Login and setup, background picker, shell, Files, Photos/Videos/Other, Dashboard, Settings |
| `js/app.js` | Hash router and session bootstrap |
| `assets/logo/` | Mark, mark (mono), mark (reversed), wordmark, and lockups, as hand-written SVG |
| `assets/bg/`, `assets/thumbs/` | Bundled login scenes and photo placeholders, all SVG and all under 16 KB |

## Ownership

Every file has an `ownerId` (who can see it now; `null` means the common space) and an `uploadedBy` (who put it there). A device account sees its own files plus the common ones, and nothing else. The master sees everything.

The raw index is private to `api.js`. Every endpoint reads files through `visibleIndex(session)`, so a missing owner filter isn't possible. Revoke, restore, remove and "keep permanently" each write all of their changes or none of them.

The mock data starts with about 40% common files, the rest spread unevenly across the devices, and 24 files from the revoked `oldphone` already held in the master's custody.

## Storage keys

`fs.accounts`, `fs.session` (localStorage when "Stay signed in" is ticked, sessionStorage otherwise), `fs.settings`, `fs.shares` and `fs.mockIndex` live in localStorage. Custom background images live in IndexedDB under `fs.backgrounds`.

## Testing aids (Settings → Advanced, master only)

- **Simulate failures:** 10% of data requests fail, so the error states get exercised.
- **External backup unplugged:** switches on the unavailable-share state everywhere.
- **Export / import:** saves and restores settings and shares as JSON.
- **Clear local data:** returns the app to first-run setup.

## Brand

- Name: **Attic**. The mark is a roof over a storage box, built on a 24-unit grid so it stays legible as a favicon.
- Accent: indigo, `#4338ca` in light mode and `#a5b4fc` in dark mode. Master mode shifts the accent to plum (`#86198f` / `#f0abfc`). Red is reserved for destructive actions and errors.
- Type: Manrope, falling back to the system UI font when offline. Monospace is used only for sizes and paths.
