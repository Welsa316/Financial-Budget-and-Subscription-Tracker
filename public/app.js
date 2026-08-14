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
  // Desktop flattens every SECTION disclosure. Two kinds stay tappable on
  // both widths: the per-transaction drill-down (an action on one charge)
  // and the audit trails inside the paycheck working ("What the $X is made
  // of", "Previous 4 weeks") - detail worth having, not worth seeing on load.
  var allRows = document.querySelectorAll('details:not(.txn__details):not(.disclosure)');

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
      var section = allRows[i];
      var summary = section.querySelector(':scope > summary');
      // A deliberate collapse survives a resize.
      if (!section.dataset.touched) {
        section.open = query.matches || section.dataset.byDefault === 'open';
      }
      if (!summary) continue;
      // Only a summary whose section actually flattened open leaves the tab
      // order - a section the user kept closed must stay reachable, or its
      // content is locked away from the keyboard entirely. (Shipped that way
      // once: the tabIndex was assigned before the touched guard.)
      var flattened = query.matches && section.open;
      if (flattened && document.activeElement === summary) {
        // The control under focus is about to become inert; park focus on
        // the section so it does not fall back to the top of the document.
        section.tabIndex = -1;
        section.focus({ preventScroll: true });
      }
      summary.tabIndex = flattened ? -1 : 0;
    }
  }
  fitRowsToWidth(wide);
  wide.addEventListener('change', fitRowsToWidth);

  // Activating "Show N more" removes the summary from the page, and the
  // browser drops the lost focus at the top of the document - the reader
  // lands nowhere near the rows they just revealed. Hand focus to the
  // revealed list instead. (toggle does not bubble; capture catches it.)
  document.addEventListener(
    'toggle',
    function (event) {
      var details = event.target;
      if (!details.classList || !details.classList.contains('catcard__more') || !details.open) {
        return;
      }
      var list = details.querySelector('.txns');
      if (list) {
        list.tabIndex = -1;
        list.focus({ preventScroll: true });
      }
    },
    true,
  );

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

  // --- Sync on open ---------------------------------------------------------
  // The server syncs itself twice a day; this covers the moment that actually
  // matters: opening the app. If the data is older than half an hour when the
  // page loads - or when the installed app comes back to the foreground - a
  // sync starts on its own. A reload only happens when it brought something
  // new AND nothing has been touched yet; yanking the page out from under a
  // thumb mid-scroll is worse than being one tap behind.
  var stamp = document.getElementById('sync-stamp');
  var AUTO_STALE_MS = 30 * 60 * 1000;
  var AUTO_TIMEOUT_MS = 5 * 60 * 1000;
  var autoRunning = false;
  var touched = false;
  ['pointerdown', 'scroll', 'keydown'].forEach(function (kind) {
    window.addEventListener(kind, function () { touched = true; }, { once: true, passive: true });
  });

  function offerRefresh(count) {
    if (!stamp) return;
    stamp.textContent = 'Synced · ' + count + ' new — tap to update';
    stamp.classList.add('topbar__stamp--fresh');
    stamp.setAttribute('role', 'button');
    stamp.setAttribute('tabindex', '0');
    var go = function () { window.location.reload(); };
    stamp.addEventListener('click', go);
    stamp.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') go();
    });
  }

  function autoPoll(startedAt) {
    if (Date.now() - startedAt > AUTO_TIMEOUT_MS) { autoRunning = false; return; }
    fetch('/api/sync-status', { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.running) {
          window.setTimeout(function () { autoPoll(startedAt); }, 2000);
          return;
        }
        autoRunning = false;
        if (!data.last || data.last.status === 'error') return; // quiet; banners own chronic failure
        if (stamp && data.last.finished_at) stamp.dataset.finishedAt = data.last.finished_at;
        var brought = data.last.transactions_upserted || 0;
        if (brought > 0) {
          if (touched) offerRefresh(brought);
          else window.location.reload();
        } else if (stamp) {
          stamp.textContent = 'Synced just now';
        }
      })
      .catch(function () { autoRunning = false; });
  }

  function maybeAutoSync() {
    if (!stamp || stamp.dataset.connected !== '1' || autoRunning) return;
    if (document.visibilityState === 'hidden') return;
    var last = Date.parse(stamp.dataset.finishedAt || '');
    if (isFinite(last) && Date.now() - last < AUTO_STALE_MS) return;
    autoRunning = true;
    fetch('/api/sync', { method: 'POST', credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) { autoRunning = false; return; }
        autoPoll(Date.now());
      })
      .catch(function () { autoRunning = false; });
  }

  maybeAutoSync();
  document.addEventListener('visibilitychange', maybeAutoSync);

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
