// Service worker : rend l'appli installable et met en cache le "shell".
const CACHE = "agent-code-v1";
const SHELL = [
  "/",
  "/static/style.css",
  "/static/script.js",
  "/static/icon-192.png",
  "/static/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((cles) => Promise.all(cles.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                 // POST (/api/chat…) : jamais de cache
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return;     // API : toujours le réseau

  // Navigation : réseau d'abord, cache en secours (mode hors-ligne).
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match("/")));
    return;
  }
  // Autres ressources (CSS, JS, icônes) : cache d'abord.
  e.respondWith(caches.match(req).then((cache) => cache || fetch(req)));
});
