// Service worker : rend l'appli installable et met en cache le "shell".
// Stratégie réseau d'abord : on ne sert JAMAIS un vieux CSS/JS si le réseau
// est disponible (le cache ne sert qu'en mode hors-ligne).
const CACHE = "agent-code-v7";
const SHELL = [
  "/",
  "/static/style.css",
  "/static/script.js",
  "/static/icon-192.png",
  "/static/icon-512.png",
  "/static/icon-maskable-192.png",
  "/static/icon-maskable-512.png",
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
  if (url.origin !== location.origin) return;       // CDN : laisser le navigateur gérer

  // Réseau d'abord (et mise à jour du cache), cache seulement en secours.
  e.respondWith(
    fetch(req)
      .then((reponse) => {
        const copie = reponse.clone();
        caches.open(CACHE).then((c) => c.put(req, copie));
        return reponse;
      })
      .catch(() =>
        caches.match(req).then((cache) => cache || (req.mode === "navigate" ? caches.match("/") : undefined))
      )
  );
});
