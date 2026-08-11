/* Dashboard client. No build step, no framework. */
(function () {
  'use strict';

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
