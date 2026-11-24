const CACHE_VERSION = "swisshost-v3";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DATA_CACHE = `${CACHE_VERSION}-data`;

const SHELL_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/logo.svg",
  "/icons/favicon-64.png",
  "/icons/icon-192.png",
  "/icons/maskable-192.png",
  "/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== STATIC_CACHE && k !== DATA_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never cache authenticated, admin, or export endpoints (PRD §3.3)
  if (
    url.pathname.startsWith("/api/v1/me") ||
    url.pathname.startsWith("/api/v1/auth") ||
    url.pathname.startsWith("/api/v1/exports") ||
    url.pathname.startsWith("/admin")
  ) {
    return;
  }

  // Immutable hashed Vite build assets & icons: cache-first
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((res) => {
            if (res.ok) {
              const clone = res.clone();
              caches.open(STATIC_CACHE).then((c) => c.put(request, clone));
            }
            return res;
          })
      )
    );
    return;
  }

  // Public API: network-first, fallback to last-known static catalog cache ONLY for non-live routes/stops/agencies
  if (url.pathname.startsWith("/api/")) {
    const cacheableStaticApi =
      url.pathname === "/api/v1/agencies" ||
      url.pathname.includes("/routes") ||
      url.pathname.includes("/stops");

    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok && cacheableStaticApi) {
            const clone = res.clone();
            caches.open(DATA_CACHE).then((c) => c.put(request, clone));
          }
          return res;
        })
        .catch(async () => {
          if (cacheableStaticApi) {
            const cached = await caches.match(request);
            if (cached) return cached;
          }
          return new Response(
            JSON.stringify({
              title: "Offline",
              status: 503,
              detail: "Network unavailable. Live transit tracking requires an active connection.",
            }),
            { status: 503, headers: { "Content-Type": "application/json" } }
          );
        })
    );
    return;
  }

  // SPA navigation: network-first, refresh the cached shell, fall back to it offline
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(STATIC_CACHE).then((c) => c.put("/", clone));
          }
          return res;
        })
        .catch(async () => (await caches.match("/")) || new Response("Offline", { status: 503 }))
    );
  }
});
