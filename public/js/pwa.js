// Installable app: registers the service worker and offers an
// "Install app" button. Android/Chrome installs with one tap; iPhone
// Safari has no install button, so it gets "Share -> Add to Home
// Screen" instructions instead. Nothing shows once the app is installed.
(function () {
  'use strict';
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {});
    });
  }

  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone) return;

  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var DISMISS_KEY = 'pwa-install-dismissed';
  var DISMISS_DAYS = 30;
  var deferred = null;

  function dismissedRecently() {
    try {
      var t = parseInt(localStorage.getItem(DISMISS_KEY) || '0', 10);
      return t && Date.now() - t < DISMISS_DAYS * 864e5;
    } catch (e) { return false; }
  }
  function rememberDismiss() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {}
  }

  var SHARE_ICON = '<svg class="pwa-share" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  var banner = null;
  function closeBanner(remember) {
    if (banner) { banner.remove(); banner = null; }
    if (remember) rememberDismiss();
  }
  function showBanner(mode) {
    closeBanner(false);
    banner = document.createElement('div');
    banner.className = 'pwa-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Install this app');
    var body = mode === 'ios'
      ? '<strong>Install this app</strong><span>Tap ' + SHARE_ICON + ' <b>Share</b> at the bottom of Safari, then <b>Add to Home Screen</b>.</span>'
      : '<strong>Install this app</strong><span>Add it to your home screen for one-tap, full-screen access.</span>';
    banner.innerHTML =
      '<img src="/icons/icon-192.png" alt="" />' +
      '<div class="pwa-text">' + body + '</div>' +
      '<div class="pwa-actions">' +
      (mode === 'ios' ? '' : '<button type="button" class="pwa-install">Install</button>') +
      '<button type="button" class="pwa-close" aria-label="Not now">' + (mode === 'ios' ? 'Got it' : 'Not now') + '</button>' +
      '</div>';
    document.body.appendChild(banner);
    var installBtn = banner.querySelector('.pwa-install');
    if (installBtn) installBtn.addEventListener('click', install);
    banner.querySelector('.pwa-close').addEventListener('click', function () { closeBanner(true); });
  }

  function install() {
    if (!deferred) return;
    var prompt = deferred;
    deferred = null;
    prompt.prompt();
    prompt.userChoice.then(function (choice) {
      closeBanner(choice && choice.outcome !== 'accepted');
      if (choice && choice.outcome === 'accepted') setButtons(false);
    }).catch(function () {});
  }

  // Any element with data-pwa-install (e.g. in the sidebar) becomes an
  // "Install app" button whenever installing is possible.
  function setButtons(show) {
    var els = document.querySelectorAll('[data-pwa-install]');
    for (var i = 0; i < els.length; i++) els[i].hidden = !show;
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('[data-pwa-install]');
    if (!btn) return;
    e.preventDefault();
    if (deferred) install();
    else if (isIOS) showBanner('ios');
  });

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    setButtons(true);
    if (!dismissedRecently()) showBanner('android');
  });
  window.addEventListener('appinstalled', function () {
    deferred = null;
    setButtons(false);
    closeBanner(false);
  });

  function ready() {
    if (isIOS) {
      setButtons(true);
      if (!dismissedRecently()) showBanner('ios');
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
