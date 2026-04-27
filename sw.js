// FORGE service worker — built on Google Workbox (MIT) instead of hand-rolled
// fetch handlers. Workbox ships well-tested cache strategies + a
// BackgroundSync queue that replays failed POST/PATCH/PUT/DELETE on
// reconnect, which is exactly what spec §12.5 "field mode (offline drafts)"
// describes.
//
// Strategies:
//   - SPA shell (HTML/CSS/JS, manifest, icon): StaleWhileRevalidate
//   - /api and /v1 GETs:                       NetworkFirst (3 s timeout)
//   - /api and /v1 writes:                     BackgroundSync queue with
//                                              auto-retry until succeed

importScripts("https://storage.googleapis.com/workbox-cdn/releases/7.1.0/workbox-sw.js");

if (!self.workbox) {
  // Fallback: minimal pass-through if the CDN is blocked.
  self.addEventListener("fetch", () => {});
  console.warn("[forge-sw] Workbox failed to load; pass-through mode");
} else {
  workbox.setConfig({ debug: false });
  const { precaching, routing, strategies, expiration, backgroundSync } = workbox;

  // ---------- pre-cache the SPA shell ----------
  // Bumped to v2 after the Hub/portals/audit-fix work. Includes the new
  // top-level modules so first-paint offline still works after install.
  precaching.precacheAndRoute([
    { url: "/",                       revision: "v2" },
    { url: "/index.html",             revision: "v2" },
    { url: "/styles.css",             revision: "v2" },
    { url: "/app.js",                 revision: "v2" },
    { url: "/manifest.webmanifest",   revision: "v2" },
    { url: "/icon.svg",               revision: "v2" },
    { url: "/src/screens/hub.js",     revision: "v2" },
    { url: "/src/core/groups.js",     revision: "v2" },
    { url: "/src/core/ui.js",         revision: "v2" },
    { url: "/src/core/store.js",      revision: "v2" },
    { url: "/src/core/router.js",     revision: "v2" },
  ]);

  // ---------- static assets: stale-while-revalidate ----------
  routing.registerRoute(
    ({ url, request }) =>
      url.origin === self.location.origin &&
      (request.destination === "script" ||
       request.destination === "style"  ||
       request.destination === "image"  ||
       url.pathname.startsWith("/src/")),
    new strategies.StaleWhileRevalidate({
      cacheName: `forge-static-${SHELL_REVISION}`,
      plugins: [new expiration.ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 30 * 86400 })],
    })
  );

  // ---------- /api + /v1 GETs: network-first with cache fallback ----------
  routing.registerRoute(
    ({ url, request }) => request.method === "GET" &&
      (url.pathname.startsWith("/api/") ||
       url.pathname.startsWith("/v1/")  ||
       url.pathname.startsWith("/graphql")),
    new strategies.NetworkFirst({
      cacheName: "forge-api",
      networkTimeoutSeconds: 3,
      plugins: [new expiration.ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 86400 })],
    })
  );

  // ---------- /api writes: BackgroundSync queue (offline draft replay) ----------
  const writeQueue = new backgroundSync.BackgroundSyncPlugin("forge-write-queue", {
    maxRetentionTime: 24 * 60, // minutes — Workbox replays for up to 24 h
    onSync: async ({ queue }) => {
      let entry;
      while ((entry = await queue.shiftRequest())) {
        try {
          await fetch(entry.request);
          notify({ type: "offline-replayed", url: entry.request.url });
        } catch (err) {
          // Put it back at the head and stop; Workbox will retry later.
          await queue.unshiftRequest(entry);
          throw err;
        }
      }
    },
  });

  routing.registerRoute(
    ({ url, request }) =>
      ["POST","PATCH","PUT","DELETE"].includes(request.method) &&
      url.pathname.startsWith("/api/"),
    new strategies.NetworkOnly({ plugins: [writeQueue] }),
    "POST"
  );
  routing.registerRoute(
    ({ url, request }) =>
      ["POST","PATCH","PUT","DELETE"].includes(request.method) &&
      url.pathname.startsWith("/api/"),
    new strategies.NetworkOnly({ plugins: [writeQueue] }),
    "PATCH"
  );
  routing.registerRoute(
    ({ url, request }) =>
      ["POST","PATCH","PUT","DELETE"].includes(request.method) &&
      url.pathname.startsWith("/api/"),
    new strategies.NetworkOnly({ plugins: [writeQueue] }),
    "PUT"
  );
  routing.registerRoute(
    ({ url, request }) =>
      ["POST","PATCH","PUT","DELETE"].includes(request.method) &&
      url.pathname.startsWith("/api/"),
    new strategies.NetworkOnly({ plugins: [writeQueue] }),
    "DELETE"
  );

  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
}

function notify(msg) {
  self.clients.matchAll().then(list => list.forEach(c => c.postMessage(msg)));
}
