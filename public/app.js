/* Dashboard client. No build step, no framework. */
(function () {
  'use strict';

  // Offline snapshot + home-screen install. Registered after load so it never
  // competes with the first render.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {
        // A failed registration just means no offline copy; the app still works.
      });
    });
  }

  // Desktop shows the working; the phone hides it behind a tap. The browser
  // hides <details> content with content-visibility on its slot rather than
  // display on the child, so CSS cannot force it open — this can, and without
  // it the desktop layout is simply a wider set of collapsed rows.
  var wide = window.matchMedia('(min-width: 900px)');
  // Everything except the per-transaction drill-down: desktop flattens every
  // section disclosure, while opening a single charge to reclassify it stays
  // an action on both widths.
  var allRows = document.querySelectorAll('details:not(.txn__details)');

  // Whatever the server decided is the phone's answer. The review queue ships
  // open because a queue nobody opens is a queue nobody clears, and narrowing
  // the window must put that back rather than closing everything alike.
  for (var r = 0; r < allRows.length; r++) {
    allRows[r].dataset.byDefault = allRows[r].open ? 'open' : 'shut';
    // Touched means the USER toggled it. The toggle event cannot tell who
    // acted — a programmatic .open change fires it too, so the desktop
    // auto-open used to mark every section touched and the narrow-width
    // restore then skipped all of them. A click on the summary is the user.
    var summary = allRows[r].querySelector(':scope > summary');
    if (summary) {
      summary.addEventListener('click', function () {
        this.parentNode.dataset.touched = '1';
      });
    }
  }

  function fitRowsToWidth(query) {
    for (var i = 0; i < allRows.length; i++) {
      var summary = allRows[i].querySelector(':scope > summary');
      // Flattened summaries are labels, not controls: CSS takes them out of
      // the pointer's reach, this takes them out of the tab order.
      if (summary) summary.tabIndex = query.matches ? -1 : 0;
      // A deliberate collapse survives a resize.
      if (allRows[i].dataset.touched) continue;
      allRows[i].open = query.matches || allRows[i].dataset.byDefault === 'open';
    }
  }
  fitRowsToWidth(wide);
  wide.addEventListener('change', fitRowsToWidth);

  // Signing out must not leave balances sitting in the cache.
  var logout = document.querySelector('form[action="/logout"]');
  if (logout) {
    logout.addEventListener('submit', function () {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage('clear-cache');
      }
    });
  }

  // Border on the sticky bar only once content scrolls under it.
  var topbar = document.querySelector('.topbar');
  if (topbar) {
    var applyScrollState = function () {
      topbar.classList.toggle('topbar--scrolled', window.scrollY > 4);
    };
    applyScrollState();
    window.addEventListener('scroll', applyScrollState, { passive: true });
  }

  // --- Sync now -----------------------------------------------------------
  var button = document.getElementById('sync-now');
  var feedback = document.getElementById('sync-feedback');
  if (!button) return;

  var POLL_MS = 1500;
  var TIMEOUT_MS = 5 * 60 * 1000;

  function say(message) {
    if (feedback) feedback.textContent = message;
  }

  function finish(message, reload) {
    button.removeAttribute('aria-busy');
    button.disabled = false;
    button.textContent = 'Sync now';
    say(message);
    if (reload) window.location.reload();
  }

  function poll(startedAt) {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      finish('Sync is taking longer than expected. Reload to check.', false);
      return;
    }
    fetch('/api/sync-status', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.running) {
          window.setTimeout(function () { poll(startedAt); }, POLL_MS);
          return;
        }
        if (data.last && data.last.status === 'error') {
          finish(data.last.error || 'Sync failed.', false);
          return;
        }
        finish('', true);
      })
      .catch(function () {
        finish('Lost contact with the server.', false);
      });
  }

  button.addEventListener('click', function () {
    button.setAttribute('aria-busy', 'true');
    button.disabled = true;
    button.textContent = 'Syncing…';
    say('Contacting your bank…');

    fetch('/api/sync', { method: 'POST', credentials: 'same-origin' })
      .then(function (response) {
        return response.json().then(function (data) {
          return { ok: response.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) throw new Error(result.data.error || 'Could not start the sync.');
        poll(Date.now());
      })
      .catch(function (error) {
        finish(error.message, false);
      });
  });
})();
