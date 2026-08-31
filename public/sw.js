const CACHE_NAME = "cabadra-staff-v1";
const STATIC_ASSETS = [
  "/",
  "/receptionist",
  "/kitchen",
  "/icon-192x192.png",
  "/icon-512x512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;
  if (!request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(request)
        .then((networkResponse) => {
          if (
            request.url.includes("/api/") ||
            request.url.includes("firebase") ||
            request.url.includes("google")
          ) {
            return networkResponse;
          }

          const clonedResponse = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, clonedResponse);
          });
          return networkResponse;
        })
        .catch(() => {
          if (request.mode === "navigate") {
            return caches.match("/receptionist");
          }
        });
    })
  );
});