// publish-update.js — Phase 3, milestone 3-5 (T-10): put a new desktop-tool installer on the HP from the
// command line, for every client to update to. The running server notices within 30 seconds and tells
// the clients. (From another PC, the master can upload instead: PUT /api/updates/files/<name>.)
// Usage: node server/publish-update.js <path>\Attic-Hub-Setup-0.7.0.exe [--notes "What changed"] [--replace]
'use strict';
const fs = require('fs'), path = require('path');
const { createUpdates } = require('./updates');

const CONFIG_PATH = process.env.ATTIC_CONFIG || path.join(__dirname, 'config.json');
const DATA_DIR = process.env.ATTIC_DATA || path.join(__dirname, 'data');

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--notes');
  if (!file) { console.log('Usage: node server/publish-update.js <path>\\Attic-Hub-Setup-<version>.exe [--notes "What changed"] [--replace]'); process.exitCode = 1; return; }
  const i = args.indexOf('--notes');
  const notes = i >= 0 ? args[i + 1] || '' : '';
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { /* defaults */ }
  const dir = path.resolve(cfg.updatesDir || path.join(DATA_DIR, 'updates'));
  const st = fs.statSync(file);
  const r = await createUpdates({ dir }).publish(fs.createReadStream(file), { fileName: path.basename(file), notes, replace: args.includes('--replace'), size: st.size, publishedBy: 'command line' });
  console.log(`Published Attic Hub ${r.version} (${(r.size / 1e6).toFixed(1)} MB, SHA-256 ${r.sha256.slice(0, 16)}…) to ${dir}`);
  console.log('Clients connected to the HP hear about it within 30 seconds.');
}

main().catch(e => { console.error(e.message); process.exitCode = 1; });
