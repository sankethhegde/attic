# Attic Hub

Attic Hub is one installable Windows desktop tool. It stores your files on the HP home server and connects your home devices (the HP, the Acer, the ROG Ally and the iPhone) over the home network. It grew out of Attic, the home file server interface built in Phase 1A.

**Status: Phase 1B, on mock data.** The desktop tool wraps the Attic interface and adds Devices and Transfers views. No real files, devices or transfers exist yet; the HP server arrives in Phase 1C. The sign-in is a mock and **not secure**: use placeholder passwords such as `test1234`.

## Layout

| Folder | What it is |
| --- | --- |
| `ui/` | The interface: plain HTML, CSS and JavaScript, shared by the desktop tool and (later) the iPhone. Open `ui/index.html` in a browser to run it without the tool. |
| `desktop/` | The Electron shell: the window now; tray, notifications and installer options in later phases |
| `server/` | The HP server (Phase 1C) |
| `agent/` | The client background part that reports stats and receives files (Phase 2) |
| `docs/` | Links to the requirements, plus [ACCEPTANCE.md](docs/ACCEPTANCE.md) |

## Run and build the desktop tool

From `desktop/`:

```bash
npm install
```

Electron's binary download is an install script, which npm may hold for approval. If `node_modules/electron/dist/electron.exe` is missing afterwards, run `node node_modules/electron/install.js`.

| Command | Does |
| --- | --- |
| `npm start` | Opens the tool from source |
| `npm run dist` | Builds `dist/Attic-Hub-Setup-<version>.exe`, the installer for every PC |
| `npm run pack` | Builds the unpacked app only (`dist/win-unpacked/`), which is quicker for testing |
| `npm run icons` | Regenerates `build/icon.ico` and `build/icon.png` from the logo SVG |
| `node scripts/smoke-test.mjs [exe]` | Opens the tool (or a built exe), visits every view and fails on any console error |
| `node scripts/serve-ui.js` | Serves `ui/` on localhost, to check it in a normal browser |

## First run

With empty storage the tool shows setup for the master account. Setup also creates test device accounts, all with password `test1234`: `phone`, `worklaptop`, `tablet`, and `oldphone` (revoked). **Test accounts**, at the bottom of the login card, lists them all.

## How the interface is built

- `ui/js/api.js` is the only module that touches storage. Every function is async, has a simulated delay of 100–300 ms, and can fail. Phase 1C swaps its internals for calls to the HP server; nothing else in `ui/` changes.
- **Ownership:** every file has an `ownerId` (`null` means the common space) and an `uploadedBy`. Every read goes through `visibleIndex(session)`. A device sees only its own and common files; the master sees everything.
- **Devices and Transfers:** mock data from `ui/js/mockgen.js` (`generateHub`), with live movement added in `api.js`. Stats are visible only to the master.
- **Storage keys:** `fs.accounts`, `fs.session`, `fs.settings`, `fs.shares`, `fs.mockIndex` and `fs.mockHub` in localStorage, plus custom backgrounds in IndexedDB (`fs.backgrounds`). In the desktop tool these live in the app's user-data folder.

## Brand

Working name **Attic Hub**; the final name is an open question in the requirements. The mark is a roof over a storage box. The accent is indigo (`#4338ca` / `#a5b4fc`), and master mode shifts it to plum. The interface font is Manrope, loaded without blocking start-up, with the system font used offline.
