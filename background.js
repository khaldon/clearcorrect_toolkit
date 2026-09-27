// ClearComm Toolkits - background service worker
import { getSettings } from './shared/defaults.js';
import { getLogSettings, logActivity } from './shared/activity-log.js';

/* ---------- helpers ---------- */

const stripBlob = (u) => (typeof u === 'string' && u.startsWith('blob:')) ? u.slice(5) : u;
const isPortalUrl = (u) => {
  try {
    const h = new URL(stripBlob(u)).hostname;
    return h === 'clearcorrect.com' || h.endsWith('.clearcorrect.com');
  } catch { return false; }
};
const pathOf = (u) => { try { return new URL(stripBlob(u)).pathname.toLowerCase(); } catch { return ''; } };
const idOf = (u) => { try { return new URL(stripBlob(u)).searchParams.get('id'); } catch { return null; } };
const isCasePage = (u) => pathOf(u).includes('/detail/case.aspx');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- message router ---------- */

const handlers = {
  GET_SETTINGS: async () => ({ ok: true, settings: await getSettings() }),
  POST_NOTE: postNote,
  ACTIVATE_LOGIN: activateLogin,
  DOWNLOAD_STL: downloadStl
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.action];
  if (!handler) return false;

  if (message?.action !== 'ACTIVATE_LOGIN') {
    chrome.storage.local.get('needsLogin').then(({ needsLogin }) => {
      if (needsLogin) {
        sendResponse({ ok: false, error: 'Login required before using the extension.' });
        return;
      }
      handler(message, sender)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    });
    return true;
  }

  handler(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // keep the channel open for the async response
});

/* ---------- first install: arm the one-time login prompt ---------- */

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.storage.local.set({ needsLogin: true });
});

/* ---------- reading the signed-in portal username ---------- */

async function getUsernameFromTab(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const node = document.querySelector('#ctl00_lblUserName');
        if (!node || !node.textContent) return null;
        return node.textContent.replace('Welcome, ', '').trim();
      }
    });
    return res?.result || null;
  } catch {
    return null;
  }
}

/* ---------- one-time "log in" button (first install only) ---------- */

async function activateLogin({ tabId }) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || !isPortalUrl(tab.url)) return { ok: false, reason: 'NOT_PORTAL' };

  const username = await getUsernameFromTab(tabId);
  if (!username) return { ok: false, reason: 'NO_USERNAME' };

  await logActivity({ username, caseId: '', action: 'Logged in (first use)' });
  await chrome.storage.local.set({ needsLogin: false });
  return { ok: true, username };
}

/* ---------- STL downloads, renamed by content.js's table watcher ---------- */
// content.js sends the exact case number and target filename (e.g.
// "12345_Maxillary.stl") - no guessing needed here, we just download it
// under that name and remember which case/tab it came from so the
// completion listener below can log it accurately.

const pendingStlDownloads = new Map(); // downloadId -> { caseId, tabId }

function downloadStl({ url, filename, caseId }, sender) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, conflictAction: 'uniquify' }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[ClearComm] STL download failed:', chrome.runtime.lastError.message);
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      pendingStlDownloads.set(downloadId, { caseId: caseId || '', tabId: sender?.tab?.id });
      resolve({ ok: true, downloadId });
    });
  });
}

/* ---------- Post a note to the portal ---------- */

function navigateAndWait(tabId, url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('The page took too long to load.'));
    }, timeout);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.update(tabId, { url }).catch((err) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(err);
    });
  });
}

const activePostNoteLocks = new Set();

async function postNote({ tabId, caseId, text }) {
  if (activePostNoteLocks.has(tabId)) {
    return { ok: false, reason: 'ALREADY_IN_PROGRESS' };
  }
  activePostNoteLocks.add(tabId);

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url || !isPortalUrl(tab.url)) return { ok: false, reason: 'NOT_PORTAL' };
    if (!caseId) return { ok: false, reason: 'NO_CASE' };
    if (!text || !String(text).trim()) return { ok: false, reason: 'EMPTY' };

    const settings = await getSettings();
    const onCaseNotes = isCasePage(tab.url) && String(idOf(tab.url)) === String(caseId);

    if (!onCaseNotes) {
      const target = `${new URL(tab.url).origin}/detail/case.aspx?id=${encodeURIComponent(caseId)}#tabNotes`;
      await navigateAndWait(tabId, target);
      await sleep(500); // let ASP.NET form and tabs settle
    }

    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: injectNoteToPortal,
      args: [text, {
        typeId: settings.notes.noteTypeId,
        reasonId: settings.notes.noteReasonId,
        submit: !!settings.notes.autoSubmit
      }]
    });
    const result = injection?.result || { ok: false, reason: 'NO_RESULT' };

    if (result.ok) {
      if (result.submitted && !result.verified) {
        // Note was clicked but could not be confirmed in the table — do NOT log to sheet
        console.warn('[ClearComm] Note submitted but not verified in the notes table. Sheet log skipped.');
      } else {
        // Prefer the username read directly from the table row (most accurate),
        // fall back to the portal header username if the table didn't return one.
        const headerUsername = await getUsernameFromTab(tabId);
        const username = result.verifiedUsername || headerUsername;
        logActivity({
          username,
          caseId,
          action: result.submitted ? 'Posted note' : 'Filled in note (not saved)',
          noteText: result.verifiedNoteContent || text
        });
      }
    }

    return result;
  } finally {
    activePostNoteLocks.delete(tabId);
  }
}

/* ---------- log file downloads from the portal ---------- */

chrome.downloads.onChanged.addListener(async (delta) => {
  const { needsLogin } = await chrome.storage.local.get('needsLogin');
  if (needsLogin) return; // Completely abort download tracking if not logged in

  if (!delta.state || delta.state.current !== 'complete') return;
  try {
    const [item] = await chrome.downloads.search({ id: delta.id });
    if (!item) return;

    const pending = pendingStlDownloads.get(delta.id);
    pendingStlDownloads.delete(delta.id);

    const fileName = (item.filename || '').split(/[\\/]/).pop();
    let caseId = pending?.caseId;
    let username = pending?.tabId != null ? await getUsernameFromTab(pending.tabId) : null;

    if (!caseId) {
      const origin = item.referrer || item.url;
      if (!isPortalUrl(origin)) return;
      caseId = idOf(origin) || '';
    }

    if (!username) {
      const cached = await getLogSettings();
      username = (await findUsernameNearUrl(item.referrer || item.url)) || cached.lastUsername || 'Unknown';
    }

    logActivity({ username, caseId, action: 'Downloaded a file', fileName });
  } catch {
    // Logging is best-effort; a download should never fail because of it.
  }
});

async function findUsernameNearUrl(refUrl) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.clearcorrect.com/*' });
    if (!tabs.length) return null;
    const targetId = idOf(refUrl);
    const match = tabs.find((t) => targetId && String(idOf(t.url)) === String(targetId)) || tabs[0];
    return match ? await getUsernameFromTab(match.id) : null;
  } catch {
    return null;
  }
}

// Runs inside the ClearCorrect page. Must stay self-contained (no outer references).
async function injectNoteToPortal(noteText, opts) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Try activating the Notes tab header if it exists and tab is not active
  const activateNotesTab = () => {
    const tabSelectors = [
      '#ctl00_MainPH_tcRecord_tpNotes_header',
      'a[href*="tabNotes"]',
      'a[href*="Notes"]',
      '[id*="tpNotes"]'
    ];
    for (const sel of tabSelectors) {
      const el = document.querySelector(sel);
      if (el && typeof el.click === 'function') {
        try { el.click(); return true; } catch (e) {}
      }
    }
    return false;
  };

  activateNotesTab();

  const waitFor = async (id, timeout) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = document.getElementById(id);
      if (el && (el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0)) return el;
      if (el && el.offsetParent === null) activateNotesTab();
      await sleep(200);
    }
    return document.getElementById(id);
  };

  const box = await waitFor('ctl00_MainPH_txtNote', 10000);
  const saveBtn = document.getElementById('ctl00_MainPH_btnSaveNote') ||
                  document.querySelector('input[type="submit"][name="ctl00$MainPH$btnSaveNote"]') ||
                  document.querySelector('input[type="submit"][value="Add Note"]');
  if (!box || !saveBtn) return { ok: false, reason: 'NO_ELEMENTS' };

  // Deduplicate against duplicate form submissions
  if (saveBtn.dataset.clearcommSubmitting === 'true') {
    return { ok: true, submitted: true, deduplicated: true };
  }

  const setSelect = (el, value) => {
    if (!el || !value) return false;
    const exists = Array.from(el.options).some((o) => o.value === String(value));
    if (exists) el.value = String(value);
    return exists;
  };

  const type = document.getElementById('ctl00_MainPH_ddlNoteTypeID');
  const reason = document.getElementById('ctl00_MainPH_ddlNoteReasonID');
  const typeSet = setSelect(type, opts.typeId);
  const reasonSet = setSelect(reason, opts.reasonId);

  const textarea = box;
  const saveButton = saveBtn;
  const clientState = document.querySelector('#ctl00_MainPH_tbwmNote_ClientState');

  // 1. Tell the server it's real text
  if (clientState) clientState.value = "true";

  // 2. Lock the value so the site's script cannot clear it
  Object.defineProperty(textarea, 'value', {
    get: function() { return noteText; },
    set: function() { /* ignore resets */ },
    configurable: true
  });

  // 3. Force clean styles
  textarea.classList.remove('tbwm');
  textarea.style.color = "black";

  // 4. Trigger events to satisfy page logic
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));

  let verified = false;
  let verifiedUsername = null;
  let verifiedNoteContent = null;

  if (opts.submit) {
    saveButton.dataset.clearcommSubmitting = 'true';

    // 5. Click the Save button
    saveButton.click();

    // Poll the notes table until the new note appears at the top (up to 10 s)
    for (let i = 0; i < 20; i++) {
      await sleep(500);

      const table = document.getElementById('ctl00_MainPH_grdtabNotes');
      if (!table || table.rows.length < 2) continue;

      const row = table.rows[1]; // Most recently added note is always row[1]
      if (!row || row.cells.length < 2) continue;

      const noteCell = row.cells[1];

      // Use a partial ID match so we never need to hardcode the "ctl02" counter
      const noteSpan = noteCell.querySelector('[id*="lbhNoteText"]');
      if (!noteSpan || !noteSpan.firstChild) continue;
      const noteContent = noteSpan.firstChild.textContent.trim();

      // Get the username from the italic "created: … by <username>" div
      const createdDiv = noteCell.querySelector('div[style*="font-style:italic"]');
      const postedBy = createdDiv ? createdDiv.innerText.split('by ').pop().trim() : null;

      // Accept if the submitted text matches (handles portal truncation)
      if (
        noteContent === noteText.trim() ||
        noteContent.includes(noteText.trim()) ||
        noteText.trim().includes(noteContent)
      ) {
        verified = true;
        verifiedUsername = postedBy;
        verifiedNoteContent = noteContent;
        break;
      }
    }

    setTimeout(() => { delete saveButton.dataset.clearcommSubmitting; }, 5000);
  }

  return {
    ok: true,
    submitted: !!opts.submit,
    verified,
    verifiedUsername,
    verifiedNoteContent,
    typeSet,
    reasonSet
  };
}