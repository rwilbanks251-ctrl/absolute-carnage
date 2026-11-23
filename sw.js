// Minimal service worker so phones can install the site to the home screen.
// No caching: the team data always comes live from the server.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
