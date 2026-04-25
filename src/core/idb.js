// Persistent append-only stores for long-running logs (audit, events, DLQ).
//
// Primary path: Dexie.js (Apache 2.0).
// Fallback: bare IndexedDB wrapper kept in this file, used if Dexie
// cannot be loaded.

import { vendor } from "./vendor.js";

const DB_NAME = "forge";
const DB_VERSION = 1;
const STORES = ["auditLog", "events", "dlq", "search"];

let _dexiePromise = null;
let _rawDbPromise = null;

async function openDexie() {
  if (_dexiePromise) return _dexiePromise;
  const Dexie = await vendor.dexie();
  const db = new Dexie(DB_NAME);
  const schema = {};
  for (const s of STORES) schema[s] = "id"; // primary key: id
  db.version(DB_VERSION).stores(schema);
  _dexiePromise = Promise.resolve(db);
  return db;
}

function openRaw() {
  if (_rawDbPromise) return _rawDbPromise;
  _rawDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no IDB"));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _rawDbPromise;
}

async function useDexieOr(fn, rawFn) {
  try {
    const db = await openDexie();
    return await fn(db);
  } catch {
    const raw = await openRaw();
    return rawFn(raw);
  }
}

export async function append(store, entry) {
  return useDexieOr(
    db => db.table(store).put(entry).then(() => true),
    raw => new Promise((resolve, reject) => {
      const tx = raw.transaction(store, "readwrite");
      tx.objectStore(store).put(entry);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    })
  );
}

export async function getAll(store) {
  return useDexieOr(
    db => db.table(store).toArray(),
    raw => new Promise((resolve, reject) => {
      const tx = raw.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    })
  );
}

export async function clear(store) {
  return useDexieOr(
    db => db.table(store).clear().then(() => true),
    raw => new Promise((resolve, reject) => {
      const tx = raw.transaction(store, "readwrite");
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    })
  );
}

export async function remove(store, id) {
  return useDexieOr(
    db => db.table(store).delete(id).then(() => true),
    raw => new Promise((resolve, reject) => {
      const tx = raw.transaction(store, "readwrite");
      tx.objectStore(store).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    })
  );
}
