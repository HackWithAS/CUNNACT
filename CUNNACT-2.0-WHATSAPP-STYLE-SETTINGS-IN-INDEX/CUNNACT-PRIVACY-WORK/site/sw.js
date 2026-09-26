const CACHE = "cunnact-shell-v12";
const SHELL = [
  "/index.html","/login.html","/register.html","/landing.html",
  "/css/style.css","/css/chat.css","/css/settings.css","/css/security.css","/css/animations.css",
  "/js/app.js","/js/settings.js","/js/firebase.js","/js/firebase-config.js","/js/ui.js","/js/toast.js",
  "/assets/brand/cunnact-icon.svg","/assets/brand/cunnact-logo.svg","/assets/brand/cunnact-logo-light.svg",
  "/assets/icons/cunnact-192.png","/assets/icons/cunnact-32.png","/assets/icons/cunnact-512.png"
];
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k.startsWith("cunnact-shell-")).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== "GET") return;
  if (url.pathname.endsWith("/firebase-messaging-sw.js")) return;
  event.respondWith(fetch(event.request).then(response => {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
    return response;
  }).catch(() => caches.match(event.request).then(hit => {
    if (hit) return hit;
    // Only substitute the app shell for page navigations. Falling back to
    // index.html for a failed image/CSS/JS request used to render broken
    // HTML in place of that asset instead of just letting it 404.
    if (event.request.mode === "navigate") return caches.match("/index.html");
    return Response.error();
  })));
});
