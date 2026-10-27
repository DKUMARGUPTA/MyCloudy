/*
 * Self-unregistering service worker (sandbox preview hygiene).
 *
 * The preview gateway domain has a leftover service worker registered from
 * an earlier experiment (the browser keeps probing GET /sw.js on every
 * navigation — 404s in dev.log — and a stale SW can serve outdated HTML/
 * chunks). This script is served at /sw.js so any existing registration
 * updates to IT: on activate it deletes every Cache Storage bucket for the
 * origin, unregisters itself, and lets all clients return to plain network
 * fetches. The app never registers a service worker (PRD: device-only PWA
 * is out of scope), so after one pass this file simply sits unused.
 */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
        await self.registration.unregister();
      } catch {
        /* best effort */
      }
    })()
  );
});
