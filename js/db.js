/* IndexedDB 持久层：跨标签页共享的报告存储 */
window.ReportHub = window.ReportHub || {};
ReportHub.db = (() => {
  const DB_NAME = 'report-hub-db';
  const STORE = 'reports';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('ts', 'ts', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const result = fn(store);
      t.oncomplete = () => resolve(result && result._value !== undefined ? result._value : undefined);
      t.onerror = () => reject(t.error);
    }));
  }

  function getAll() {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, 'readonly');
      const req = t.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  }

  return {
    put: (report) => tx('readwrite', (s) => s.put(report)),
    putAll: (reports) => tx('readwrite', (s) => reports.forEach((r) => s.put(r))),
    deleteIds: (ids) => tx('readwrite', (s) => ids.forEach((id) => s.delete(id))),
    clear: () => tx('readwrite', (s) => s.clear()),
    getAll,
  };
})();
