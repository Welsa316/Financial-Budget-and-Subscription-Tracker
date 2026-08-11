/* Service worker placeholder. Offline caching is added in a later build step;
   this exists so the registration and the /sw.js route resolve cleanly. */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});
