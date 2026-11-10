// Persistent translation cache in IndexedDB, shared by the worker and extension pages; least recently used go first.
const CACHE_MAX = 50000;
// Last-use times are refreshed at most this often, so cache hits rarely cost a write.
const CACHE_TOUCH_MS = 24 * 3600 * 1000;
let cacheDbPromise = null;

function cacheDb() {
  if (cacheDbPromise) return cacheDbPromise;
  cacheDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open('a-translate-cache', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('tr', { keyPath: 'k' }).createIndex('t', 't');
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        cacheDbPromise = null;
      };
      db.onclose = () => { cacheDbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  cacheDbPromise.catch(() => { cacheDbPromise = null; });
  return cacheDbPromise;
}

// `fn` queues requests on the store and returns an object they fill in; it resolves once the transaction commits.
async function cacheTx(mode, fn) {
  const db = await cacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tr', mode);
    const result = fn(tx.objectStore('tr'));
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// { key: translation } for the keys found. A read-only lookup, so parallel requests don't queue behind each other;
// stale last-use times are refreshed afterwards without waiting.
async function cacheGet(keys) {
  const now = Date.now();
  const touch = [];
  const out = await cacheTx('readonly', (store) => {
    const found = {};
    for (const k of new Set(keys)) {
      store.get(k).onsuccess = (e) => {
        const row = e.target.result;
        if (!row) return;
        found[k] = row.v;
        if (now - row.t > CACHE_TOUCH_MS) touch.push(row);
      };
    }
    return found;
  });
  if (touch.length) cacheTx('readwrite', (store) => touch.forEach((row) => store.put({ ...row, t: now }))).catch(() => {});
  return out;
}

// Counting is a full scan in Chrome's IndexedDB, so the size is checked once per worker start and every N writes.
const CACHE_CHECK_EVERY = 200;
let writesSinceCheck = Infinity;

function cachePut(entries) {
  const now = Date.now();
  const list = Object.entries(entries);
  writesSinceCheck += list.length;
  const check = writesSinceCheck >= CACHE_CHECK_EVERY;
  if (check) writesSinceCheck = 0;
  return cacheTx('readwrite', (store) => {
    for (const [k, v] of list) store.put({ k, v, t: now });
    if (!check) return;
    store.count().onsuccess = (e) => {
      // Evict an extra 10% so this doesn't run again right away once full.
      let excess = e.target.result - CACHE_MAX;
      if (excess <= 0) return;
      excess += CACHE_MAX / 10;
      store.index('t').openCursor().onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (!cursor || excess-- <= 0) return;
        cursor.delete();
        cursor.continue();
      };
    };
  });
}

async function cacheSizeLabel() {
  const res = await cacheTx('readonly', (store) => {
    const out = { n: 0 };
    store.count().onsuccess = (e) => { out.n = e.target.result; };
    return out;
  }).catch(() => ({ n: 0 }));
  return res.n ? `${res.n} 条` : '空';
}

function clearCache() {
  return cacheTx('readwrite', (store) => { store.clear(); });
}
