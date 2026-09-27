// ClearComm Toolkits - activity log
// Sends "who did what, on which case" events to a Google Sheet through a
// Google Apps Script Web App (see google-apps-script.js for the sheet side).

const STORAGE_KEY = 'activityLog';

const DEFAULT_LOG_SETTINGS = {
  enabled: true,
  webhookUrl: 'https://script.google.com/macros/s/AKfycbxSgKaOlRLsN6nwgRSHqjRNzYhgHuJJljtBUCvou-UyMhXEsysKY2yx2LHpWPh2lPf3OQ/exec',
  lastUsername: ''
};

export async function getLogSettings() {
  const { [STORAGE_KEY]: saved } = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_LOG_SETTINGS, ...(saved || {}) };
}

export async function saveLogSettings(partial) {
  const current = await getLogSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

const pad = (n) => String(n).padStart(2, '0');

function stamp() {
  const d = new Date();
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  };
}

const QUEUE_KEY = 'activityLogQueue';
let isProcessing = false;
let storageLock = Promise.resolve();

// Client-side dedup cache: tracks recently-sent download events to prevent
// duplicate rows when the same file is triggered twice within a short window.
// Key = "action|caseId|fileName", value = timestamp of last send.
const _recentDedup = new Map();
const DEDUP_WINDOW_MS = 3000; // 3-second window

function isDuplicate(payload) {
  // Only deduplicate download-type actions (not logins or note posts)
  if (!payload.action.toLowerCase().includes('download')) return false;
  const key = `${payload.action}|${payload.caseId}|${payload.fileName}`;
  const now = Date.now();
  const last = _recentDedup.get(key);
  if (last && (now - last) < DEDUP_WINDOW_MS) return true;
  _recentDedup.set(key, now);
  // Clean up stale entries to prevent memory growth
  for (const [k, t] of _recentDedup) {
    if (now - t > DEDUP_WINDOW_MS * 2) _recentDedup.delete(k);
  }
  return false;
}

async function enqueuePayload(payload) {
  const next = async () => {
    const data = await chrome.storage.local.get(QUEUE_KEY);
    const queue = data[QUEUE_KEY] || [];
    queue.push(payload);
    await chrome.storage.local.set({ [QUEUE_KEY]: queue });
  };
  storageLock = storageLock.then(next).catch(console.error);
  await storageLock;
}

 



async function removeBatchPayloads(count) {
  const next = async () => {
    const data = await chrome.storage.local.get(QUEUE_KEY);
    const queue = data[QUEUE_KEY] || [];
    if (queue.length > 0) {
      queue.splice(0, count); // Remove the batch that was just sent
      await chrome.storage.local.set({ [QUEUE_KEY]: queue });
    }
  };
  storageLock = storageLock.then(next).catch(console.error);
  await storageLock;
}

async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;
  
  try {
    const cfg = await getLogSettings();
    if (!cfg.enabled || !cfg.webhookUrl) return;

    while (true) {
      const data = await chrome.storage.local.get(QUEUE_KEY);
      const queue = data[QUEUE_KEY] || [];
      
      if (queue.length === 0) break; // done
      
      // Batch up to 100 items at a time to prevent payload size issues
      const batchSize = Math.min(queue.length, 100);
      const batch = queue.slice(0, batchSize);
      
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        
        await fetch(cfg.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          // Send as a batch payload rather than a single log
          body: JSON.stringify({ isBatch: true, logs: batch }),
          redirect: 'follow',
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        
        // Successfully sent, remove the entire batch from the queue
        await removeBatchPayloads(batchSize);
        
        // Only delay if there are still more items to process in the next loop
        if (queue.length > batchSize) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
      } catch (err) {
        console.warn("Activity log fetch temporary issue, will retry:", err?.message || err);
        break; // Break loop on network error, will retry on next action
      }
    }
  } finally {
    isProcessing = false;
  }
} 




// Start processing in case there are leftover items
if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(processQueue);
  chrome.runtime.onInstalled && chrome.runtime.onInstalled.addListener(processQueue);
}

/**
 * Best-effort log of one activity row. Never throws - logging must not be
 * able to break notes, posting, or downloads if the sheet is unreachable.
 * Now uses a persistent queue to handle bulk requests without rate limits.
 */
export async function logActivity({ username, caseId, action, fileName, noteText }) {
  const cfg = await getLogSettings();

  if (username) await saveLogSettings({ lastUsername: username });
  if (!cfg.enabled || !cfg.webhookUrl) return { ok: false, reason: 'NOT_CONFIGURED' };

  const { date, time } = stamp();
  const payload = {
    date,
    time,
    username: username || cfg.lastUsername || 'Unknown',
    caseId: caseId != null ? String(caseId) : '',
    action,
    fileName: fileName || '',
    noteText: noteText || '' // Included in webhook request
  };

  if (isDuplicate(payload)) return { ok: true, skipped: 'dedup' };

  await enqueuePayload(payload);
  processQueue();
  
  return { ok: true, queued: true };
}