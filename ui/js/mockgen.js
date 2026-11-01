// Mock devices and transfers for the Devices and Transfers views, until the device agents arrive in
// Phase 2. Seeded: same seed, same data, so a layout bug stays reproducible. (The mock file index that
// used to live here was retired in Phase 1C, milestone 6: files now come from the HP server.)
(function (root) {
  'use strict';
  const U = root.Attic ? root.Attic.util : require('./util.js');

  const SEED = 20261021;

  // ---------- Attic Hub mock devices and transfers (Phase 1B) ----------
  // The four home devices from the requirements: the HP is the server, the rest are clients.
  // Base stats only; the API adds live movement on every read so the Devices view has something to show.
  function generateHub(opts) {
    opts = opts || {};
    const now = opts.now || Date.now();
    const owner = (opts.accounts || []).find(a => a.type === 'master');
    const ownerId = owner ? owner.id : null;
    const iso = t => new Date(t).toISOString();
    const GB = 1e9, MB = 1e6;
    const devices = [
      { id: 'dev_hp', name: 'HP laptop', role: 'server', os: 'Windows 11', kind: 'laptop', connection: 'ethernet', ip: '192.168.1.10',
        online: true, lastSeenAt: iso(now), userId: ownerId,
        base: { cpu: 9, ramTotal: 16 * GB, ramUsed: 5.1 * GB, diskTotal: 256 * GB, diskFree: 141 * GB, battery: null } },
      { id: 'dev_acer', name: 'Acer Aspire 5', role: 'client', os: 'Windows 11 Home', kind: 'laptop', connection: 'wifi', ip: '192.168.1.23',
        online: true, lastSeenAt: iso(now), userId: ownerId, thisPC: true,
        base: { cpu: 22, ramTotal: 8 * GB, ramUsed: 5.6 * GB, diskTotal: 512 * GB, diskFree: 188 * GB, battery: 78, charging: false } },
      { id: 'dev_ally', name: 'ASUS ROG Ally', role: 'client', os: 'Windows 11', kind: 'handheld', connection: 'wifi', ip: '192.168.1.31',
        online: false, lastSeenAt: iso(now - 3.2 * 3600e3), userId: ownerId,
        base: { cpu: 31, ramTotal: 16 * GB, ramUsed: 9.4 * GB, diskTotal: 512 * GB, diskFree: 96 * GB, battery: 41, charging: false } },
      { id: 'dev_iphone', name: 'iPhone', role: 'client', os: 'iOS', kind: 'phone', connection: 'wifi', ip: '192.168.1.44',
        online: true, lastSeenAt: iso(now), userId: ownerId, browserOnly: true, base: null }
    ];
    const r = U.rng((opts.seed || SEED) + 31);
    const files = ['Trip to Coorg.zip', 'IMG_4471.HEIC', 'Quarterly budget 2026.xlsx', 'Gameplay clip 0417.mp4', 'Resume final.pdf',
      'Goa 2023 — family.mov', 'Save backup (Elden Ring).7z', 'Scans 2026-09.pdf', 'Wallpapers.zip', 'Diwali photos.zip',
      'ಹಬ್ಬದ ವಿಡಿಯೋ.mp4', 'setup-notes.txt', 'Recording 2026-10-12.m4a', 'Screenshot 2026-10-29 at 21.04.png'];
    const pairs = [['dev_acer', 'dev_hp'], ['dev_iphone', 'dev_acer'], ['dev_hp', 'dev_acer'], ['dev_acer', 'dev_iphone'], ['dev_iphone', 'dev_hp']];
    const transfers = [];
    let n = 1;
    const add = t => transfers.push(Object.assign({ id: 'tr_' + (n++), userId: ownerId, error: null }, t));
    const speedFor = (a, b) => [a, b].includes('dev_hp') && [a, b].every(d => d !== 'dev_iphone') ? 60 * MB + r() * 30 * MB : 14 * MB + r() * 18 * MB;
    // History, newest first in the view: done over the last ten days.
    for (let i = 0; i < 12; i++) {
      const [from, to] = pairs[i % pairs.length];
      const size = Math.round(Math.exp(Math.log(200e3) + r() * (Math.log(3.5 * GB) - Math.log(200e3))));
      const speed = speedFor(from, to);
      const start = now - (0.3 + i * 0.85 + r() * 0.5) * 864e5;
      add({ fileName: files[i % files.length], size, from, to, status: 'done', speed: Math.round(speed),
        startedAt: iso(start), finishedAt: iso(start + size / speed * 1000), bytesDone: size });
    }
    // Two failures to the Ally, a queued one waiting for it, and two in flight right now.
    add({ fileName: 'Gameplay clip 0417.mp4', size: 1.84 * GB, from: 'dev_ally', to: 'dev_hp', status: 'failed', speed: 22 * MB,
      startedAt: iso(now - 3.4 * 3600e3), finishedAt: iso(now - 3.2 * 3600e3), bytesDone: 0.61 * GB, error: 'Connection to ASUS ROG Ally was lost.' });
    add({ fileName: 'Save backup (Elden Ring).7z', size: 420 * MB, from: 'dev_ally', to: 'dev_acer', status: 'failed', speed: 18 * MB,
      startedAt: iso(now - 3.3 * 3600e3), finishedAt: iso(now - 3.2 * 3600e3), bytesDone: 212 * MB, error: 'Connection to ASUS ROG Ally was lost.' });
    add({ fileName: 'Wallpapers.zip', size: 310 * MB, from: 'dev_acer', to: 'dev_ally', status: 'queued', speed: null,
      startedAt: iso(now - 40 * 60e3), finishedAt: null, bytesDone: 0 });
    add({ fileName: 'Trip to Coorg.zip', size: 2.1 * GB, from: 'dev_acer', to: 'dev_hp', status: 'active', speed: 41 * MB,
      startedAt: iso(now - 9e3), finishedAt: null, bytesDone: 0 });
    add({ fileName: 'IMG_4471.HEIC', size: 3.4 * MB, from: 'dev_iphone', to: 'dev_acer', status: 'active', speed: 1.2 * MB,
      startedAt: iso(now - 1e3), finishedAt: null, bytesDone: 0 });
    transfers.forEach(t => { t.size = Math.round(t.size); t.bytesDone = Math.round(t.bytesDone); });
    return { version: 1, generatedAt: iso(now), devices, transfers };
  }

  const api = { generateHub, SEED };
  if (root.Attic) root.Attic.mock = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
