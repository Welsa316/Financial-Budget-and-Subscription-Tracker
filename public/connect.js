/* Teller Connect enrollment. Loaded only on /connect so the dashboard keeps no
   external script dependency. */
(function () {
  'use strict';

  var root = document.getElementById('connect-root');
  var launch = document.getElementById('connect-launch');
  var status = document.getElementById('connect-status');
  if (!root || !launch) return;

  function say(message, kind) {
    status.textContent = message;
    status.className = 'connect__status' + (kind ? ' connect__status--' + kind : '');
  }

  if (typeof window.TellerConnect === 'undefined') {
    launch.disabled = true;
    say('Could not load Teller. Check your connection and reload.', 'error');
    return;
  }

  var enrollmentId = root.dataset.enrollmentId;
  var institution = root.dataset.institution;

  var options = {
    applicationId: root.dataset.applicationId,
    environment: root.dataset.environment,
    products: ['balance', 'transactions'],
    nonce: root.dataset.nonce,
    onSuccess: function (enrollment) {
      say('Saving your connection…');
      launch.disabled = true;

      fetch('/api/enrollment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          nonce: root.dataset.nonce,
          accessToken: enrollment.accessToken,
          enrollment: enrollment.enrollment,
          user: enrollment.user
        })
      })
        .then(function (response) {
          return response.json().then(function (data) {
            return { ok: response.ok, data: data };
          });
        })
        .then(function (result) {
          if (!result.ok) throw new Error(result.data.error || 'Could not save the connection.');
          say('Connected. Pulling your transactions…', 'ok');
          window.location.href = '/';
        })
        .catch(function (error) {
          launch.disabled = false;
          say(error.message, 'error');
        });
    },
    onExit: function () {
      say('Cancelled. Nothing was connected.');
    },
    onFailure: function (failure) {
      say((failure && failure.message) || 'Teller reported a failure.', 'error');
    }
  };

  // enrollmentId repairs an existing connection; institution skips the picker
  // on a first-time link.
  if (enrollmentId) {
    options.enrollmentId = enrollmentId;
  } else if (institution) {
    options.institution = institution;
  }

  var connect = window.TellerConnect.setup(options);

  launch.addEventListener('click', function () {
    say('');
    connect.open();
  });
})();
