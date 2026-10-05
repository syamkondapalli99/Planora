/* =========================================================
   PLANORA SERVICE WORKER  (sw.js)

   Makes Planora an installable app that still opens with no
   signal. Your tasks, goals and journal already live on the
   device (and sync to your account when you're back online);
   this file keeps the app's own files available offline.

   - Pages + scripts: network first (always the latest version),
     saved copy when offline.
   - Icon font / CDN files: saved copy first, refreshed in the background.
   - Account and AI requests (/api, /auth) are never cached.
   ========================================================= */

const VERSION = "planora-2026-10-05-calmhome";
const SHELL = [
    "/offline.html",
    "/style.css", "/extras.css", "/devices.css", "/desktop.css", "/fonts/figtree-latin-wght-normal.woff2", "/fonts/bricolage-grotesque-latin-wght-normal.woff2",
    "/device.js", "/pwa.js", "/planora-config.js", "/vendor/supabase.js", "/auth.js", "/planora-core.js", "/planora-priority.js",
    "/focus.js", "/smart-planner.js", "/script.js", "/home.js", "/app-extras.js",
    "/calendar.js", "/calendar-views.js", "/gcal.js", "/planner.js", "/journal-link.js", "/ai-assistant.js", "/login.js",
    "/manifest.webmanifest",
    "/icons/logo-128.png", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png", "/icons/favicon-32.png"
];

self.addEventListener("install", event => {
    event.waitUntil((async () => {
        const cache = await caches.open(VERSION);
        // One missing file must not stop the app from installing
        await Promise.all(SHELL.map(url => cache.add(new Request(url, { cache: "reload" })).catch(() => {})));
        self.skipWaiting();
    })());
});

self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k.startsWith("planora-") && k !== VERSION).map(k => caches.delete(k)));
        await self.clients.claim();
    })());
});

function neverCache(url) {
    return url.origin === self.location.origin && /^\/(api|auth)(\/|$)/.test(url.pathname);
}

self.addEventListener("fetch", event => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (neverCache(url)) return;
    if (!/^https?:$/.test(url.protocol)) return;

    // Pages
    if (req.mode === "navigate") {
        event.respondWith((async () => {
            try {
                const res = await fetch(req);
                // Only keep real pages (not "please sign in" redirects)
                if (res.ok && !res.redirected) {
                    const cache = await caches.open(VERSION);
                    cache.put(url.pathname, res.clone());
                }
                return res;
            } catch (e) {
                const cache = await caches.open(VERSION);
                return (await cache.match(url.pathname)) || (await cache.match("/offline.html")) || Response.error();
            }
        })());
        return;
    }

    // Planora's own files
    if (url.origin === self.location.origin) {
        event.respondWith((async () => {
            const cache = await caches.open(VERSION);
            try {
                const res = await fetch(req);
                if (res.ok) cache.put(req, res.clone());
                return res;
            } catch (e) {
                return (await cache.match(req, { ignoreSearch: true })) || Response.error();
            }
        })());
        return;
    }

    // Only static files from known CDNs are kept. Everything else cross-site
    // (Supabase sign-in and data, Google, Apple, OpenAI…) always goes straight
    // to the network and is never stored.
    if (!/^(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname)) return;

    // Icon fonts and other CDN files: saved copy first, refresh in background
    event.respondWith((async () => {
        const cache = await caches.open(VERSION);
        const hit = await cache.match(req);
        const refresh = fetch(req).then(res => {
            if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
            return res;
        }).catch(() => null);
        return hit || (await refresh) || Response.error();
    })());
});
