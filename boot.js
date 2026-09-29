// Tiny safety net (classic script, loaded after popup.js): if popup.js could not start -
// usually a missing file such as shared/collector.js - say so instead of failing silently.
(() => {
  const banner = (msg) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:9999;padding:10px 12px;border-radius:8px;background:#a02b22;color:#fff;font:12px/1.4 system-ui,sans-serif';
    d.textContent = msg;
    document.body.appendChild(d);
  };
  const missing = 'ClearComm: popup.js did not start. Make sure these files exist next to manifest.json: shared/defaults.js, shared/engagers.js, shared/collector.js, shared/page-collect.js. Details: chrome://extensions > ClearComm > Errors.';
  const script = document.querySelector('script[type="module"]');
  if (script) script.addEventListener('error', () => banner(missing));
  window.addEventListener('error', (e) => { if (!window.__clearcommPopupReady) banner(`${missing} (${e.message})`); });
  setTimeout(() => { if (!window.__clearcommPopupReady) banner(missing); }, 2000);
})();
