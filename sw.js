// Realty Radar — minimal service worker.
// Caches the app shell so it opens offline; never caches API/Realie/GIS responses
// (those must always be live so the change feed and findings stay current).
const SHELL = "rr-shell-v1";
const ASSETS = ["./", "./index.html", "./manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only ever serve the static shell from cache. Let everything else hit the network.
  const isShell = url.origin === self.location.origin &&
                  (url.pathname.endsWith("/") || url.pathname.endsWith("index.html") ||
                   url.pathname.endsWith("manifest.json") || url.pathname.endsWith("sw.js"));
  if (e.request.method === "GET" && isShell) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
  }
});
