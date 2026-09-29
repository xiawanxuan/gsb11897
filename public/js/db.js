'use strict';
/* IndexedDB 持久化层：所有标签页共享同一数据库，作为跨标签页聚合的权威存储 */
const ReportDB = (() => {
  const DB_NAME = 'reporting-dashboard';
  const STORE = 'reports';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('eventTime', 'eventTime', { unique: false });
          store.createIndex('type', 'type', { unique: false });
          store.createIndex('source', 'source', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const out = fn(store);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  return {
    open,
    /* 返回 'added' | 'duplicate' */
    async put(record) {
      const db = await open();
      return tx(db, 'readwrite', (store) => {
        store.put(record);
      }).then(async () => {
        return 'added';
      });
    },
    async has(id) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getKey(id);
        req.onsuccess = () => resolve(req.result !== undefined);
        req.onerror = () => reject(req.error);
      });
    },
    async getAll() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        req.onsuccess = () => {
          const list = req.result || [];
          list.sort((a, b) => a.eventTime - b.eventTime || a.receivedAt - b.receivedAt);
          resolve(list);
        };
        req.onerror = () => reject(req.error);
      });
    },
    async count() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    /* 超出 max 时删除最旧的记录，返回删除条数 */
    async trimToMax(max) {
      const db = await open();
      const all = await this.getAll();
      const excess = all.length - max;
      if (excess <= 0) return 0;
      const doomed = all.slice(0, excess);
      await tx(db, 'readwrite', (store) => {
        for (const r of doomed) store.delete(r.id);
      });
      return doomed.length;
    },
    async clear() {
      const db = await open();
      return tx(db, 'readwrite', (store) => store.clear());
    },
  };
})();
