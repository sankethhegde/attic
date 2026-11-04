// db.js — Phase 2, milestone 2-5: the HP's database, one SQLite file (data/attic.db) through Node's
// built-in node:sqlite, so there is still nothing to install. It holds transfer history for now; the
// requirements put users, devices and the file index in the same file later.
// Schema changes are numbered steps run once each, recorded in user_version.
'use strict';
const fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');

const STEPS = [
  // 1: transfers and their history (2-5). Names are copied in when a transfer starts, so history still
  // reads right after a device is unpaired or an account removed.
  `CREATE TABLE transfers (
     id TEXT PRIMARY KEY,
     file_name TEXT NOT NULL,
     size INTEGER NOT NULL,
     from_id TEXT, from_name TEXT,
     to_id TEXT NOT NULL, to_name TEXT,
     user_id TEXT NOT NULL, user_name TEXT,
     status TEXT NOT NULL,
     stage TEXT,
     bytes_done INTEGER NOT NULL DEFAULT 0,
     speed INTEGER, upload_speed INTEGER,
     started_at TEXT NOT NULL, uploaded_at TEXT, delivery_started_at TEXT, finished_at TEXT,
     error TEXT,
     attempts INTEGER NOT NULL DEFAULT 1
   );
   CREATE INDEX transfers_started ON transfers(started_at DESC);
   CREATE INDEX transfers_user ON transfers(user_id, started_at DESC);
   CREATE INDEX transfers_to ON transfers(to_id, status);
   CREATE INDEX transfers_status ON transfers(status);`
];

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'attic.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const have = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = have; v < STEPS.length; v++) {
    db.exec('BEGIN');
    try { db.exec(STEPS[v]); db.exec(`PRAGMA user_version = ${v + 1}`); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}

module.exports = { openDb };
