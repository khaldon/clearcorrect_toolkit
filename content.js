// ClearComm Toolkits - content script (runs on ClearCorrect pages)
// Wrapped so injecting it twice (e.g. after an extension reload) does nothing.
(() => {
  if (window.__clearcommToolkitsLoaded) return;
  window.__clearcommToolkitsLoaded = true;

  /* ---------- settings (owned by the background worker) ---------- */

  let settings = null;
  let globalCaseNumber = null;

  async function loadSettings() {
    try {
      const res = await chrome.runtime.sendMessage({ action: 'GET_SETTINGS' });
      if (res?.ok) settings = res.settings;
    } catch (e) {
      // Extension was reloaded or updated; keep whatever we already have.
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes.settings) loadSettings();
        if (changes.needsLogin && changes.needsLogin.newValue === false) {
          startFeatures();
        }
      }
    });
  } catch (e) { /* context invalidated */ }

  /* ---------- reminder toast ---------- */

  const TOAST_POSITIONS = {
    'top-right': 'top: 20px; right: 20px;',
    'top-left': 'top: 20px; left: 20px;',
    'bottom-right': 'bottom: 20px; right: 20px;',
    'bottom-left': 'bottom: 20px; left: 20px;'
  };

  function showPortalAlert() {
    if (!window.location.hostname.includes('portal')) return;
    const cfg = settings?.toast;
    if (!cfg || !cfg.enabled || !String(cfg.text || '').trim()) return;
    if (document.getElementById('clearcomm-toast-alert')) return;

    const toast = document.createElement('div');
    toast.id = 'clearcomm-toast-alert';
    toast.innerText = cfg.text.trim();
    toast.style.cssText = `
      position: fixed;
      ${TOAST_POSITIONS[cfg.position] || TOAST_POSITIONS['top-right']}
      background-color: ${/^#[0-9a-f]{6}$/i.test(cfg.color) ? cfg.color : '#ff004f'};
      color: #ffffff;
      padding: 18px 25px;
      border-radius: 8px;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 16px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
      z-index: 999999;
      transition: opacity 0.5s ease;
      pointer-events: none;
    `;
    document.body.appendChild(toast);

    const visibleMs = Math.min(Math.max(Number(cfg.seconds) || 3.5, 1), 15) * 1000;
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 500);
    }, visibleMs);
  }

  /* ---------- STL file renamer (Files tab) ---------- */
  // Renames each STL to "<caseNumber>_<Maxillary|Mandibular|Arch>.stl" as
  // it's downloaded, using the same case-files table the portal renders.

  function getActiveCaseNumber() {
    if (window.location.href.toLowerCase().includes('setup.aspx')) {
      const element = document.getElementById('ctl00_MainPH_tcRecordHeaderLarge');
      if (element && element.textContent) {
        const m = element.textContent.replace(/^Setup:\s*|(-.*)$/g, '').trim();
        if (m) return m;
      }
    }
    const m = window.location.href.match(/[?&]id=(\d+)/i);
    return (m ? m[1] : null) || globalCaseNumber || 'UnknownCase';
  }

  function attachStlListeners() {
    const table = document.querySelector('table#ctl00_MainPH_frmCaseSubmission_tcRecord_tpFiles_grdAllFiles');
    if (!table) return false;

    const caseNumber = getActiveCaseNumber();
    const rows = Array.from(table.querySelectorAll('tr')).slice(1);
    let attachedAny = false;

    rows.forEach((row) => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) return;

      const link = cells[0]?.querySelector('a');
      const href = link ? link.getAttribute('href') : '';
      const rawType = cells[1]?.innerText.trim().toLowerCase() || '';

      if (link && href && href.toLowerCase().includes('.stl') && !link.dataset.stlListenerAttached) {
        link.dataset.stlListenerAttached = 'true';
        attachedAny = true;

        link.addEventListener('click', (e) => {
          e.preventDefault();

          const absoluteUrl = new URL(href, window.location.origin).href;

          let typeLabel = 'Arch';
          if (rawType.includes('upper') || rawType.includes('max')) typeLabel = 'Maxillary';
          else if (rawType.includes('lower') || rawType.includes('mand')) typeLabel = 'Mandibular';

          const newFileName = `${caseNumber}_${typeLabel}.stl`;

          chrome.runtime.sendMessage({
            action: 'DOWNLOAD_STL',
            url: absoluteUrl,
            filename: newFileName,
            caseId: caseNumber
          });
        });
      }
    });

    return attachedAny;
  }

  function watchForStlTable() {
    if (!window.location.hostname.includes('portal')) return;
    if (attachStlListeners()) return;
    const observer = new MutationObserver(() => attachStlListeners());
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ---------- Setup Page Case Number Extractor ---------- */
  function extractSetupCaseNumber() {
    if (!window.location.hostname.includes('portal')) return;
    if (window.location.href.toLowerCase().includes('setup.aspx')) {
      const element = document.getElementById('ctl00_MainPH_tcRecordHeaderLarge');
      if (element && element.textContent) {
        const caseNumber = element.textContent.replace(/^Setup:\s*|(-.*)$/g, '').trim();
        if (caseNumber) {
          globalCaseNumber = caseNumber;
          chrome.storage.local.set({ globalCaseNumber: caseNumber });
        }
      }
    } else {
      chrome.storage.local.get('globalCaseNumber', (res) => {
        if (res.globalCaseNumber) globalCaseNumber = res.globalCaseNumber;
      });
    }
  }

  /* ---------- start ---------- */

  async function startFeatures() {
    await loadSettings();
    showPortalAlert();
    watchForStlTable();
    extractSetupCaseNumber();
  }

  async function init() {
    const { needsLogin } = await chrome.storage.local.get('needsLogin');
    if (needsLogin) return; // Stop entirely if the user hasn't logged in for the first time

    startFeatures();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();