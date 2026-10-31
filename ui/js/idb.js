// Minimal IndexedDB wrapper for custom background images, stored as binary blobs.
// localStorage would need base64 strings (a third larger) and caps out near 5MB.
(function (root) {
  'use strict';
  const DB = 'fs.backgrounds', STORE = 'images';

  function open() {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) return reject(new Error('IndexedDB is not available in this browser'));
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : undefined); };
      t.onerror = () => { db.close(); reject(t.error); };
      t.onabort = () => { db.close(); reject(t.error || new Error('Storage quota exceeded')); };
    });
  }

  root.Attic.idb = {
    all: () => tx('readonly', s => s.getAll()),
    put: rec => tx('readwrite', s => s.put(rec)),
    remove: id => tx('readwrite', s => s.delete(id)),
    destroy: () => new Promise(resolve => {
      if (!root.indexedDB) return resolve();
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    })
  };
})(window);
