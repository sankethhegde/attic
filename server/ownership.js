// ownership.js — Phase 1C, milestone 5: who owns which real file, enforced by the server.
//
// A record per file that has an owner other than the default: { ownerId, uploadedBy }. A file with no
// record belongs to the master (everything that was on the disk before Attic). ownerId null is the
// common space. Records live in server/data/ownership.json, written whole and renamed into place.
//
// The rule from Phase 1A carries over: nothing reads records except through view(session). A device
// sees its own files and common files; a folder shows when it leads to one of those, or is empty for
// everyone. The master sees everything. There is no other way in.
'use strict';
const fs = require('fs'), path = require('path');

const MASTER = 'acc_master';
const DEFAULT = Object.freeze({ ownerId: MASTER, uploadedBy: null });
const key = (share, rel) => share + '\n' + rel;
const splitKey = k => { const i = k.indexOf('\n'); return { share: k.slice(0, i), rel: k.slice(i + 1) }; };

function createOwnership(dataDir) {
  const file = path.join(dataDir, 'ownership.json');
  let records;
  try { records = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { records = {}; }

  function save(next) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
    records = next;
  }
  // Records equal to the default carry no information; dropping them keeps the file small.
  function normalise(next) {
    for (const k of Object.keys(next)) if (next[k].ownerId === MASTER && next[k].uploadedBy === null) delete next[k];
    return next;
  }
  const recordOf = (share, rel) => records[key(share, rel)] || DEFAULT;

  return {
    MASTER,

    // ---------- the one way to read ownership ----------
    view(session) {
      const me = session.accountId, all = session.type === 'master';
      const mine = r => r.ownerId === me || r.ownerId === null;
      return {
        all,
        recordOf: (share, rel) => Object.assign({}, recordOf(share, rel)),
        fileVisible: (share, rel) => all || mine(recordOf(share, rel)),
        // isEmpty is only asked when no visible file lies below, so the disk is touched as little as possible.
        async folderVisible(share, rel, isEmpty) {
          if (all || rel === '') return true;
          const prefix = key(share, rel + '/');
          for (const k of Object.keys(records)) if (k.startsWith(prefix) && mine(records[k])) return true;
          return isEmpty();
        }
      };
    },

    // ---------- changes ----------
    // Every change builds a new record set and saves it once. snapshot()/rollback() let the caller undo
    // it if a second store (the accounts) refuses its half.
    snapshot: () => JSON.parse(JSON.stringify(records)),
    rollback: snap => save(snap),

    setRecord(share, rel, rec) {
      const next = Object.assign({}, records, { [key(share, rel)]: { ownerId: rec.ownerId, uploadedBy: rec.uploadedBy } });
      save(normalise(next));
    },

    // Revoke: everything the account owns goes to the custodian. uploadedBy is untouched, so restore can return it.
    revoke(id, custodianId) { return this._change(r => r.ownerId === id ? { ownerId: custodianId, uploadedBy: r.uploadedBy } : null); },
    // Restore: what the account uploaded and someone else holds comes back.
    restore(id) { return this._change(r => r.uploadedBy === id && r.ownerId !== id ? { ownerId: id, uploadedBy: r.uploadedBy } : null); },
    // Remove: owned files go to the custodian, and every claim the account had is cleared for good.
    remove(id, custodianId) {
      return this._change(r => {
        if (r.ownerId !== id && r.uploadedBy !== id) return null;
        return { ownerId: r.ownerId === id ? custodianId : r.ownerId, uploadedBy: r.uploadedBy === id ? null : r.uploadedBy };
      }, (before, after) => before.ownerId === id);
    },
    // Keep permanently: the holder keeps it; the uploader's claim ends.
    keep(keys) {
      const set = new Set(keys.map(k => key(k.share, k.rel)));
      return this._change((r, k) => set.has(k) && r.uploadedBy && r.uploadedBy !== r.ownerId ? { ownerId: r.ownerId, uploadedBy: null } : null);
    },

    // Applies fn to every record; returns the keys whose ownership moved (counted for the confirmation).
    _change(fn, counts) {
      const next = Object.assign({}, records), moved = [];
      for (const k of Object.keys(records)) {
        const r = fn(records[k], k);
        if (!r) continue;
        if (!counts || counts(records[k], r)) moved.push(splitKey(k));
        next[k] = r;
      }
      save(normalise(next));
      return moved;
    },

    // What an account owns now, and what it uploaded that someone else holds.
    summaryKeys(id) {
      const owned = [], inCustody = [];
      for (const k of Object.keys(records)) {
        const r = records[k];
        if (r.ownerId === id) owned.push(splitKey(k));
        if (r.uploadedBy === id && r.ownerId !== id) inCustody.push(splitKey(k));
      }
      return { owned, inCustody };
    }
  };
}

module.exports = { createOwnership, MASTER };
