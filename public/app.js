/* Dashboard client. Plain ES modules-free script — no build step, no framework. */
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
})();
