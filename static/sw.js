// Service worker: keeps a copy of the app's files so it opens without a connection,
// and lets phones install it to the home screen. Readings are never stored here;
// they live in the page's localStorage (see data.js).
//
// Change VERSION whenever the list of files below changes.
const VERSION = "v1";
const CACHE = "pulse-pressure-" + VERSION;
const FILES = [
    "./",
    "index.html",
    "style.css",
    "data.js",
    "chart.js",
    "app.js",
    "manifest.webmanifest",
    "icons/icon.svg",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
    self.skipWaiting();
});

// Remove copies kept by older versions
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k.startsWith("pulse-pressure-") && k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Serve the saved copy straight away and refresh it in the background, so the app
// opens instantly (even offline) and picks up updates on the next visit.
self.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    // Only this site's own files; note reading (/api/) always goes to the server
    if (event.request.method !== "GET" || url.origin !== location.origin || url.pathname.includes("/api/")) return;

    event.respondWith(caches.open(CACHE).then(async (cache) => {
        const saved = await cache.match(event.request, { ignoreSearch: true });
        const fresh = fetch(event.request)
            .then((response) => {
                if (response.ok) cache.put(event.request, response.clone());
                return response;
            })
            .catch(() => saved || Response.error());
        if (saved) {
            event.waitUntil(fresh);
            return saved;
        }
        return fresh;
    }));
});
