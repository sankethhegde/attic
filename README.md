# Attic Hub

Attic Hub is one installable Windows desktop tool. It stores your files on the HP home server and connects your home devices (the HP, the Acer, the ROG Ally and the iPhone) over the home network. It grew out of Attic, the home file server interface built in Phase 1A.

**Status: Phase 1C, the HP server.** Files, shares, accounts and ownership are real and live on the HP: the server in `server/` serves the interface on the home network, checks every password, and decides who sees which file. Devices and Transfers still show sample data until the device agents of Phase 2. The connection isn't encrypted yet (HTTPS is a later step), so use Attic on the home Wi-Fi only.

## Layout

| Folder | What it is |
| --- | --- |
| `ui/` | The interface: plain HTML, CSS and JavaScript, shared by the desktop tool and the iPhone. The HP server serves it. |
| `desktop/` | The Electron shell: the window now; tray, notifications and installer options in later phases |
| `server/` | The HP server (Phase 1C). See [server/README.md](server/README.md). |
| `agent/` | The client background part that reports stats and receives files (Phase 2) |
| `docs/` | Links to the requirements, plus [ACCEPTANCE.md](docs/ACCEPTANCE.md) |

## Run the server

On the HP, with Node.js installed and nothing else:

```bash
copy server\config.example.json server\config.json
node server/server.js
```

Edit the share paths in `config.json` first, or add shares later from Settings. The server prints the address for this PC and for the home network. Tests: `node --test "server/*.test.js"`.

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

On a fresh server the interface shows setup for the master account, with a password you choose. The master then adds an account for each device from the Dashboard.

## How the interface is built

- `ui/js/api.js` is the only module that talks to the server or touches browser storage. Every function is async and can fail. The screens never call `fetch` themselves.
- **Ownership:** every file has an `ownerId` (`null` means the common space) and an `uploadedBy`. The server applies it to every listing, download, upload and index: a device sees only its own and common files; the master sees everything.
- **Devices and Transfers:** sample data from `ui/js/mockgen.js` (`generateHub`), with live movement added in `api.js`, until Phase 2. Stats are visible only to the master.
- **Browser storage:** `fs.settings` (theme, background, views) and `fs.mockHub` (the sample devices) in localStorage, plus custom backgrounds in IndexedDB (`fs.backgrounds`). Accounts, sessions, shares and files are on the server.
- **The desktop tool** still opens `ui/` from disk, so it needs pointing at the HP server before it can sign in. That arrives with the tool's server address setting.

## Brand

Working name **Attic Hub**; the final name is an open question in the requirements. The mark is a roof over a storage box. The accent is indigo (`#4338ca` / `#a5b4fc`), and master mode shifts it to plum. The interface font is Manrope, loaded without blocking start-up, with the system font used offline.
