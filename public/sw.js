/* Service worker.
 *
 * Goal: the app opens instantly and shows something useful with no network,
 * and is honest about the fact that what you are looking at is a snapshot.
 *
 * Only GET requests for the dashboard shell and static assets are cached.
 * Nothing under /api/, no login page, and no redirect is ever stored.
 */

var VERSION = 'v4';
var STATIC_CACHE = 'static-' + VERSION;
var PAGE_CACHE = 'page-' + VERSION;
var PAGE_KEY = '/';

var STATIC_ASSETS = [
  '/static/styles.css',
  '/static/app.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/manifest.json'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(function (cache) {
      // Individually, so one 404 cannot fail the whole install.
      return Promise.all(
        STATIC_ASSETS.map(function (url) {
          return cache.add(url).catch(function () {});
        })
      );
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) {
          return key !== STATIC_CACHE && key !== PAGE_CACHE;
        }).map(function (key) { return caches.delete(key); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

/** Wipes cached financial data. Called on sign-out. */
function clearPageCache() {
  return caches.delete(PAGE_CACHE);
}

/**
 * Rewrites a cached dashboard into its offline form: a banner naming when the
 * snapshot was taken, so a stale number is never mistaken for a live one.
 */
function asOfflinePage(response, cachedAt) {
  return response.text().then(function (html) {
    var stamp = cachedAt ? new Date(cachedAt) : null;
    var when = stamp
      ? stamp.toLocaleString(undefined, {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
        })
      : 'an earlier visit';

    var banner =
      '<div class="offline-banner" role="status">' +
      'Offline &mdash; showing the page as of ' + when + '. Numbers may have changed.' +
      '</div>';

    var injected = html.replace(/(<body[^>]*>)/i, '$1\n' + banner);
    return new Response(injected, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') {
    // Signing out clears the snapshot rather than leaving balances on disk.
    if (request.method === 'POST' && new URL(request.url).pathname === '/logout') {
      event.waitUntil(clearPageCache());
    }
    return;
  }

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return; // never cache API responses

  // --- Dashboard: network first, snapshot as the fallback -----------------
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          var isDashboard =
            url.pathname === PAGE_KEY && response.ok && response.type !== 'opaqueredirect';
          if (isDashboard) {
            var copy = response.clone();
            caches.open(PAGE_CACHE).then(function (cache) {
              return copy.blob().then(function (body) {
                cache.put(
                  PAGE_KEY,
                  new Response(body, {
                    status: 200,
                    headers: {
                      'Content-Type': 'text/html; charset=utf-8',
                      'X-Cached-At': new Date().toISOString()
                    }
                  })
                );
              });
            });
          }
          return response;
        })
        .catch(function () {
          return caches.open(PAGE_CACHE).then(function (cache) {
            return cache.match(PAGE_KEY).then(function (cached) {
              if (cached) return asOfflinePage(cached, cached.headers.get('X-Cached-At'));
              return new Response(
                '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
                  '<title>Offline</title><link rel="stylesheet" href="/static/styles.css">' +
                  '<main class="auth"><div class="auth__card"><h1 class="auth__title">Offline</h1>' +
                  '<p class="auth__sub">No connection, and nothing saved yet. Open the app once while online.</p></div></main>',
                { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
              );
            });
          });
        })
    );
    return;
  }

  // --- Static assets: cache first, refreshed in the background ------------
  if (url.pathname.indexOf('/static/') === 0 || url.pathname.indexOf('/icons/') === 0 ||
      url.pathname === '/manifest.json') {
    event.respondWith(
      caches.open(STATIC_CACHE).then(function (cache) {
        return cache.match(request).then(function (cached) {
          var network = fetch(request)
            .then(function (response) {
              if (response.ok) cache.put(request, response.clone());
              return response;
            })
            .catch(function () { return cached; });
          return cached || network;
        });
      })
    );
  }
});

self.addEventListener('message', function (event) {
  if (event.data === 'clear-cache') event.waitUntil(clearPageCache());
});
