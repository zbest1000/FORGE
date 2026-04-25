// FORGE service worker — field-mode shell cache + offline write queue.
//
// On install: pre-cache the SPA shell so the app boots without network.
// On fetch: network-first for /api and /v1 (so live data wins when online),
// cache-first for static assets (HTML, CSS, JS).
// On `/api/*` POST/PATCH/PUT/DELETE while offline: store in IndexedDB
// queue and reply with `{ queued: true, id }`. The app replays them on
// the next 'online' event via the message channel.

const CACHE_NAME = "forge-shell-v1";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try { await cache.addAll(SHELL); } catch { /* offline install */ }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return event.respondWith(handleWrite(req));
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/") || url.pathname.startsWith("/metrics")) {
    return event.respondWith(networkFirst(req));
  }
  return event.respondWith(cacheFirst(req));
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    return res;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: "offline", path: new URL(req.url).pathname }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok && req.url.startsWith(self.location.origin)) cache.put(req, res.clone());
    return res;
  } catch {
    return cache.match("/index.html") || new Response("offline", { status: 503 });
  }
}

async function handleWrite(req) {
  try {
    return await fetch(req.clone());
  } catch (err) {
    // Only queue API writes — opaque writes elsewhere are not safe to replay.
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) throw err;
    const body = await req.clone().text();
    const queued = {
      id: Math.random().toString(36).slice(2, 10),
      url: req.url,
      method: req.method,
      headers: [...req.headers.entries()],
      body,
      ts: new Date().toISOString(),
    };
    await enqueue(queued);
    notifyClients({ type: "offline-queued", id: queued.id, url: queued.url });
    return new Response(JSON.stringify({ queued: true, id: queued.id, offline: true }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }
}

self.addEventListener("message", async (event) => {
  if (event.data?.type === "replay-queue") {
    const replayed = await replay();
    event.source?.postMessage?.({ type: "replay-done", count: replayed });
  }
});

self.addEventListener("online", () => replay().catch(() => {}));

// ---------- offline queue (IndexedDB) ----------
const DB_NAME = "forge-offline";
const STORE = "queue";

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function enqueue(entry) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}

async function listQueue() {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readonly");
    const r = tx.objectStore(STORE).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  });
}

async function dequeue(id) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => res(true);
    tx.onerror = () => rej(tx.error);
  });
}

async function replay() {
  const items = await listQueue();
  let done = 0;
  for (const it of items) {
    try {
      const res = await fetch(it.url, {
        method: it.method,
        headers: new Headers(it.headers),
        body: it.body || undefined,
      });
      if (res.ok || (res.status >= 200 && res.status < 400)) {
        await dequeue(it.id);
        notifyClients({ type: "offline-replayed", id: it.id, status: res.status });
        done++;
      }
    } catch { /* still offline */ }
  }
  return done;
}

function notifyClients(msg) {
  self.clients.matchAll().then(list => list.forEach(c => c.postMessage(msg)));
}
