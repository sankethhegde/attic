# Attic Hub

Attic Hub is one installable Windows desktop tool. It stores your files on the HP home server and connects your home devices (the HP, the Acer, the ROG Ally and the iPhone) over the home network. It grew out of Attic, the home file server interface built in Phase 1A.

**Status: 0.11.0, Phases 1 to 4 built.** Files, shares, accounts and ownership live on the HP (Phase 1C): the server in `server/` serves the interface on the home network, checks every password, and decides who sees which file. Devices find the HP, pair with it, report live stats, and send files to each other through it, with progress and history (Phase 2). The tool lives in the tray, has notifications, File Explorer's "Send to Attic Hub", the ROG Ally's low-resource mode and updates from the HP (Phase 3). The iPhone uses it in Safari over HTTPS, as a Home Screen app, with camera-roll uploads that survive a dropped connection (Phase 4). Nothing in the interface is sample or test data.

**How to use it:** the [Attic Hub user guide](https://claude.ai/artifact/1AXNgGjN22Pcmm2HtCqa3p) covers installing on the HP, the PCs and the iPhone, every feature, and troubleshooting. Settings → About links to it too.

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
| `node scripts/smoke-test.mjs [exe]` | Starts a throwaway server, opens the tool (or a built exe) against it, visits every view and fails on any console error |
| `node scripts/discovery-test.mjs [exe]` | The 2-1 flow end to end: finds a throwaway server by broadcast, survives it going away, takes a typed address, and reconnects on restart |
| `node scripts/pairing-test.mjs [exe]` | The 2-2 flow end to end: pairs the tool with a throwaway server using a code, pairs a second device from Pair a device, unpairs, restarts, and is unpaired while in use |
| `node scripts/live-stats-test.mjs [exe]` | The 2-3 flow end to end: after pairing, the tool's agent reports to a throwaway server; the Devices view goes live; a second device's report is timed to the screen |
| `node scripts/send-test.mjs [exe]` | The 2-4 flow end to end: sends from the tool to an offline device, and to the tool while it's open and while it's closed, checking every file arrives intact in the Hub Inbox. `BIG=1` adds a 2 GB file |
| `node scripts/transfers-test.mjs [exe]` | The 2-5 flow end to end: live progress, a finished transfer moving to History, Cancel, Retry (automatic, and after a reload by choosing the file), filters, search, paging, and 360px |
| `node scripts/mode-test.mjs [exe]` | The 3-1 flow: the first-launch choice, Client remembered, Server set up new (and an existing folder checked), started without installing, opened as the HP, stopped. With an exe, also runs it the way the Windows startup task does |
| `node scripts/tray-test.mjs [exe]` | The 3-2 flow: the tray and its menu, closing to the tray, a received file's notification (one for several), the HP's events (delivered, failed, offline, online), switching them off, catching up after a restart, `--hidden`. With an exe, also switches the real start-with-Windows entry on and off |
| `node scripts/shortcuts-test.mjs [exe]` | The 3-3 flow: choosing the Hub Inbox folder, "Send to Attic Hub" launches (a file and a folder) making one Send dialog and sending by path, Retry by path, dropping a file on the window, the Dashboard's Upload keeping its drops. With an exe, also adds and removes the real right-click entry |
| `node scripts/low-resource-test.mjs [exe]` | The 3-4 flow: low-resource mode on Automatic, turned on by a Steam game (a test registry key, never Steam's) and by a real full-screen window, with reports slowing at the HP and the interface holding still; Always on, Off, the tray's choice, and the game watcher ending with the tool |
| `node scripts/update-test.mjs [exe]` | The 3-5 flow: publishing an installer from Settings as the master, the HP announcing it, the download checked against its SHA-512, a release held back during a game, the notification and tray item, and Restart to update running the installer silently (a stand-in installer that only records how it was started) |
| `node scripts/phone-test.mjs` | The 4-1 flow: a browser emulating an iPhone (Safari's user agent, touch, no desktop tool) pairs over http, follows the steps to the HP's HTTPS address, and checks every view and the main dialogs at 390 and 320 px (nothing scrolling sideways, 40 px tap targets, 16 px inputs), the Home Screen manifest and icons, and the desktop-only actions being gone. `SHOTS=<folder>` saves screenshots; `AUDIT=1` prints every measurement |
| `node scripts/accounts-test.mjs` | Feedback round 1: an emulated iPhone signs up with an email username and waits; the master approves it, sets an email, sends a test reset email and sets someone's password; Forgot password's emailed link resets it, and works once. Email goes to a local stand-in for Gmail |
| `node scripts/serve-ui.js` | Serves `ui/` on localhost, to check it in a normal browser |

## First run

The first time Attic Hub opens it asks one question: **is this PC the server, or a client?** (Phase 3, 3-1). Settings → Server → "This PC is" changes it later.

- **A client** (the Acer, the ROG Ally) looks for the HP on the home network and opens the HP's interface. Everything in Phase 2 is the client's.
- **The server** (the HP) shows Server mode's screen. Set the server up once, either as **a new server** (choose a folder for everyone's files; its settings and data go in `%APPDATA%\Attic Hub\server`) or with **an existing server folder**, such as the repository's `attic\server`, so its accounts, devices and history carry over. Then:
  - **Install as a service** registers the Windows startup task from `server/service/` (Windows asks for permission once). From then on the server starts with Windows, before anyone signs in, and restarts after a crash.
  - **Start now without installing** runs it only until Attic Hub closes.
  - **Open Attic** shows the server's own interface. This PC is the HP, so it needs no pairing.
  - Start, Stop, Restart, Remove the service, and the server's log are there too.

The installed tool carries the whole server (`resources\server`) and runs it with its own built-in Node, so the HP needs nothing else installed. Windows' task starts `Attic Hub.exe ...\supervisor.js`; that run has no window.

**In the tray** (3-2). Attic Hub lives in the system tray:
- **Closing the window** keeps it running, so a client keeps reporting stats and collecting files. The first time, a notification says so.
- **The tray menu** shows what it's doing ("Connected to …", or the server's state). It opens the window and the Hub Inbox (on the server, its controls), has switches for start-with-Windows and for each kind of notification, and quits.
- **A client starts with Windows**, hidden in the tray, unless that's turned off in the tray or in Settings → This PC. The server already starts as a service, so its window doesn't by default.

**Notifications** (3-2):
- **File received**, from the tool itself. Several arriving together make one notification. Clicking it shows the file.
- **From the HP's events:** a file this PC sent was delivered or didn't arrive (with the reason), and another device has gone offline or come back.
- **While the tool was closed:** on the next start, it shows what it missed, and a long list becomes one summary. Nothing is shown twice.
- **Switches** for each kind are in the tray and in Settings → This PC. They're per PC, kept in `prefs.json`.

**Sending and receiving, the shortcuts** (3-3):
- **The Hub Inbox folder** is chosen in Settings → Server → Hub Inbox (Change folder, or Use the default). The next file goes there; files already received stay where they are.
- **Right-click "Send to Attic Hub"** in File Explorer works on files and folders (on Windows 11, under Show more options). It opens the Send dialog with them. Picking several makes one dialog, and a folder goes as its files. The tool sends them by their paths, and Retry can send them again the same way. The entry is per user (no Administrator), switchable in Settings → This PC, and removed on uninstall.
- **Dropping files or folders** anywhere on the window opens the Send dialog. The Dashboard's Upload area still uploads to the HP. Windows doesn't let a program take drops on its tray icon, so the tray isn't a drop target.

**Low-resource mode, for the ROG Ally** (3-4). In Settings → This PC and in the tray:
- **Automatic** (a client's default) turns it on while a Steam game runs or a full-screen app is in front. A maximized window doesn't count.
- **Always on** and **Off** don't watch for games at all.
- **While it's on**, this PC reports its stats every 15 seconds instead of every 3, and reads battery and network every 2 minutes. It stays online at the HP. Attic Hub's window holds still: no animations, transitions, blur or changing login background.
- **When the game ends**, everything is back to normal at once.

**Updates** (3-5; like PixHaven since 0.12.1):
- **Releasing:** bump `version` in `desktop/package.json`, commit, and push a tag `v<version>`. GitHub Actions (`.github/workflows/release.yml`) runs the unit tests, builds `Attic-Hub-Setup-<version>.exe` with `latest.yml`, and puts them in a **draft** release. Press **Publish release** at https://github.com/sankethhegde/attic/releases. That is the only manual step.
- **Every PC** (HP, Acer, ROG Ally) asks GitHub for the newest published release 30 s after it starts, then every 4 hours (the HP hourly). It downloads it in the background (not while a game runs on the Ally), checks it against the SHA-512 in `latest.yml`, and installs it:
  - the next time Attic Hub quits;
  - at a start with Windows (hidden), unseen, coming back hidden;
  - or at once with **Restart to update** (tray, Settings → About, or Server mode's screen).
- **On the HP**, installing stops the service for a moment and starts it again. The HP isn't updated on quit (its service runs the same program), only at sign-in or with Restart to update.
- **Without internet**, the HP is the fallback: Settings → Advanced → Publish an update (master) still puts an installer on the HP for the PCs to take.
- **The installers aren't code-signed yet**, so Windows may warn the first time one is run by hand.

## The iPhone (Phase 4)

The iPhone uses the same interface in Safari, served by the HP (4-1):
- **Secure address.** The HP serves HTTPS on port 8443 with its own certificate (see [server/README.md](server/README.md#https-for-the-iphone-phase-4-milestone-4-1)). Opened at the plain address (`http://<HP>:8080`), the pairing screen and Settings → This iPhone show the one-time steps: download the HP's profile, install it, turn on full trust, then open the secure address. The phone stays paired and signed in when it moves.
- **Home Screen app.** From the secure address, Share → Add to Home Screen. It opens full screen with the Attic icon. The files are `ui/manifest.webmanifest` and `ui/assets/app-icons/`, from `ui/assets/logo/attic-app-icon.svg` (`npm run icons -- --web` in `desktop/`).
- **Phone layout.**
  - Seven tabs at the bottom, with Dashboard shown as "Home" on narrow phones.
  - Controls at least 40–44 px, and text fields at 16 px, so Safari doesn't zoom in.
  - Content kept clear of the notch and the home indicator.
  - Toasts sit above the tab bar.
  - Checked at 390 and 320 px.
- **Camera roll and big videos (4-2).** On the iPhone, Upload (in Files) and Send a file offer Photo Library, Take Photo or Video, and Choose File. Any file over 16 MB, on any device, goes up in 8 MB pieces through the HP's resumable uploads (`api.js`, `resumableUpload`). When the Wi-Fi drops or the screen locks, it shows "Waiting…", then carries on from where the HP got to. The screen is kept awake while it sends, where Safari allows it.
- **Not on a phone:** Choose a folder, Drag files here, and Publish an update are hidden (`ui.handheld`, class `desktop-only`). Settings → This iPhone says what else differs: files wait until Attic is opened, there are no notifications while it's closed, and the phone doesn't report its own stats.

On a fresh server the interface shows setup for the master account, with a password you choose. The master then adds an account for each device from the Dashboard.

## How the interface is built

- `ui/js/api.js` is the only module that talks to the server or touches browser storage. Every function is async and can fail. The screens never call `fetch` themselves.
- **Ownership:** every file has an `ownerId` (`null` means the common space) and an `uploadedBy`. The server applies it to every listing, download, upload and index: a device sees only its own and common files; the master sees everything.
- **Pairing (Phase 2, 2-2):** a device the HP doesn't know sees "Pair this device" before anything else, and types the one-time code the master gets from Devices → Pair a device. The HP keeps the device's identity in an HttpOnly cookie; the desktop tool writes it to disk straight away, so pairing survives restarts. The master unpairs a device from its card; a device unpaired while in use goes back to the pairing screen.
- **Devices** are the HP's paired devices, live (2-3): each paired PC's agent reports CPU, RAM, disk, battery and network every 3 seconds, and the Devices view hears every change over one WebSocket (`/api/hub`). Only the master sees stats.
- **Send to a device (2-4):** "Send a file" on another device's card (files or a folder from this device), and "Send to device" in a file's details in Files (a file on the HP). Both open the Send dialog: choose what and which device, with offline devices marked "it gets this when it comes online". The file goes to the HP, which holds it until the receiving device's agent collects it into that device's Hub Inbox (`Downloads\Attic Hub Inbox`, shown in Settings).
- **Transfers (2-5):** "Now" shows what's moving or waiting, with live progress over the same WebSocket. "History" pages through finished transfers from the HP's database, with status and device filters and a file-name search. The sender and the master can Cancel and Retry. When the HP no longer holds the file, Retry sends it again from the device it came from: automatically if this page still has it, otherwise after asking for it.
- **Browser storage:** `fs.settings` (theme, background, views) in localStorage, plus custom backgrounds in IndexedDB (`fs.backgrounds`). Everything else is on the server. The sample data of Phase 1A–1B (`ui/js/mockgen.js`) is gone.
- **The desktop tool finds the HP by itself** (Phase 2, 2-1). It starts on a "Looking for server" screen (`ui/connect.html`), finds the HP through `agent/connect.js` (the last server used, then a discovery broadcast), and opens the interface the HP serves, so sign-in and files are real. If nothing answers, the screen explains why and takes a typed address. Settings → Server shows which HP it's using and can change it.

## Brand

Working name **Attic Hub**; the final name is an open question in the requirements. The mark is a roof over a storage box. The accent is indigo (`#4338ca` / `#a5b4fc`), and master mode shifts it to plum. The interface font is Manrope, loaded without blocking start-up, with the system font used offline.
