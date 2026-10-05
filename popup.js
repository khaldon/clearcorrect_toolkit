import {
  DEFAULT_SETTINGS, GROUPS, NOTE_CATEGORIES, UPPER_ARCH, LOWER_ARCH,
  getSettings, saveSettings, mergeDeep, renderTemplate, templateFor, placeholdersFor
} from './shared/defaults.js';
import { resolveEngagerDecision, analyzeEngagerText } from './shared/engagers.js';
import { collectFromCase } from './shared/collector.js';

/* ================= helpers ================= */

const $ = (sel, root = document) => root.querySelector(sel); const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

const state = {
  settings: null,
  activeTab: null,
  caseId: null,
  category: null,
  form: null,
  draft: { notes: [], caseId: null },
  engagerDefaultRaw: '',
  engagerRxVersion: ''
};

let flashTimer;
function flash(message, type = 'info') {
  const bar = $('#snackbar');
  bar.textContent = message;
  bar.className = `snackbar show ${type}`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { bar.className = 'snackbar'; }, 4000);
}

const caseIdFromUrl = (url) => {
  try {
    const id = new URL(url).searchParams.get('id');
    if (id) return id;
  } catch (e) { /* fall through to regex */ }
  const m = String(url).match(/[?&]id=(\d+)/i);
  return m ? m[1] : null;
};
const isPortalUrl = (url) => /^https:\/\/([^/]+\.)?clearcorrect\.com\//i.test(url || '');

/* ================= appearance and tabs ================= */

function applyAppearance() {
  const { theme, zoom } = state.settings;
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  document.body.style.zoom = String(zoom);
}

function showTab(name, persist = true) {
  $$('.tab').forEach((t) => {     const on = t.dataset.tab === name;     t.setAttribute('aria-selected', String(on));     t.tabIndex = on ? 0 : -1;   });   $$
('.panel').forEach((p) => { p.hidden = p.id !== `panel-${name}`; });
  if (persist) chrome.storage.local.set({ ui: { lastTab: name } });
}

function initTabs(lastTab) {
  const tabs = $$('.tab');
  tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  $('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    showTab(next.dataset.tab);
    next.focus();
  });
  showTab(tabs.some((t) => t.dataset.tab === lastTab) ? lastTab : 'notes', false);
}

/* ================= case detection ================= */

async function fetchCurrentCaseId(tab) {
  let id = null;
  const isSetup = tab?.url?.toLowerCase().includes('setup.aspx');
  const isCase = tab?.url?.toLowerCase().includes('case.aspx');

  if (isSetup && tab.id) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const header = document.getElementById('ctl00_MainPH_tcRecordHeaderLarge');
          if (header && header.textContent) {
            const m = header.textContent.replace(/^Setup:\s*|(-.*)$/g, '').trim();
            if (m) return m;
          }
          return null;
        }
      });
      id = res?.result || null;
    } catch (e) {
      console.warn('Could not read the case number from the setup page.', e);
    }
  }
  
  if (!id && isCase && tab.id) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const node = document.querySelector('#ctl00_MainPH_lbl_txtCaseID');
          if (node && node.textContent) {
            const m = node.textContent.trim().match(/\d+/);
            return m ? m[0] : node.textContent.trim();
          }
          return null;
        }
      });
      id = res?.result || null;
    } catch (e) {
      console.warn('Could not read the case number from the case page.', e);
    }
  }

  if (!id && tab?.url) {
    id = caseIdFromUrl(tab.url);
  }
  
  if (!id) {
    const { globalCaseNumber } = await chrome.storage.local.get('globalCaseNumber');
    id = globalCaseNumber || null;
  }
  return id;
}

function setPill(kind, text) {
  const pill = $('#case-pill');
  pill.className = `pill ${kind}`;
  pill.textContent = text;
}

async function detectCase() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.activeTab = tab || null;

  if (!tab?.url || !isPortalUrl(tab.url)) {
    state.caseId = null;
    setPill('off', 'Not on ClearCorrect');
  } else {
    state.caseId = await fetchCurrentCaseId(tab);
    if (state.caseId) setPill('ok', `Case ${state.caseId}`);
    else setPill('idle', 'No case detected');
  }

  // Automatic reset logic when switching to a different case
  if (state.caseId && state.draft.caseId && String(state.draft.caseId) !== String(state.caseId)) {
    clearDraft();
  }
}

/* ================= notes: draft ================= */

const saveDraft = () => chrome.storage.local.set({ draft: state.draft });

async function loadDraft() {
  const { draft } = await chrome.storage.local.get('draft');
  if (draft && Array.isArray(draft.notes)) {
    state.draft = { notes: draft.notes.filter((n) => typeof n === 'string'), caseId: draft.caseId ?? null };
  }
  renderNotes();
}

function clearDraft() {
  state.draft = { notes: [], caseId: null };
  saveDraft();
  renderNotes();
}

function renderNotes() {
  const list = $('#note-list');
  list.textContent = '';
  state.draft.notes.forEach((text, i) => {
    const li = el('li', 'note-item');
    li.append(el('span', 'note-text', text));
    const remove = el('button', 'icon-btn', '×');
    remove.type = 'button';
    remove.title = 'Remove this sentence';
    remove.setAttribute('aria-label', `Remove sentence ${i + 1}`);
    remove.addEventListener('click', () => {
      state.draft.notes.splice(i, 1);
      if (!state.draft.notes.length) state.draft.caseId = null;
      saveDraft();
      renderNotes();
    });
    li.append(remove);
    list.append(li);
  });
  const n = state.draft.notes.length;
  $('#note-count').textContent = String(n);
  $('#note-empty').hidden = n > 0;
  list.hidden = n === 0;
  $('#clear-notes').hidden = n === 0;
  $('#copy-btn').disabled = n === 0;
  $('#post-btn').disabled = n === 0;
}

/* ================= notes: categories and form ================= */

function buildCategories() {
  const wrap = $('#category-groups');   for (const group of GROUPS) {     const row = el('div', 'cat-group');     row.append(el('div', 'group-label', group.label));     const chips = el('div', 'chips');     NOTE_CATEGORIES.filter((c) => c.group === group.id).forEach((cat) => {       const btn = el('button', 'cat-chip', cat.short);       btn.type = 'button';       btn.dataset.id = cat.id;       btn.setAttribute('aria-pressed', 'false');       btn.addEventListener('click', () => selectCategory(cat.id));       chips.append(btn);     });     row.append(chips);     wrap.append(row);   } }  function closeForm() {   state.category = null;   state.form = null;   $$('.cat-chip').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  $('#form-card').hidden = true; }  function selectCategory(id) {   if (state.category?.id === id) { closeForm(); return; }   const cat = NOTE_CATEGORIES.find((c) => c.id === id);   state.category = cat;   $$('.cat-chip').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
  buildForm(cat);
  $('#form-card').hidden = false;
  $('#form-card').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function buildForm(cat) {
  $('#form-title').textContent = cat.label;
  const fields = $('#form-fields');
  fields.textContent = '';
  const handlers = {};
  cat.inputs.forEach((input) => {
    const field = el('div', 'field');
    field.append(el('div', 'field-label', input.label));
    handlers[input.id] = input.type === 'teeth' ? buildArchPicker(field) : buildOptions(field, cat, input);
    fields.append(field);
  });
  state.form = { cat, handlers };
  updatePreview();
}

function buildOptions(parent, cat, input) {
  const group = el('div', 'segmented');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', input.label);
  input.options.forEach((option, i) => {
    const label = el('label', 'seg');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `${cat.id}-${input.id}`;
    radio.value = option;
    radio.checked = i === 0;
    radio.addEventListener('change', updatePreview);
    label.append(radio, el('span', '', cap(option)));
    group.append(label);
  });
  parent.append(group);
  return {
    get: () => group.querySelector('input:checked')?.value ?? '',
    reset: () => { const first = group.querySelector('input'); if (first) first.checked = true; }
  };
}

function buildArchPicker(parent) {
  const selected = new Set();
  const buttons = new Map();
  const wrap = el('div', 'arch');

  const head = el('div', 'arch-head');
  head.append(el('span', '', 'Patient right'), el('span', '', 'Patient left'));
  wrap.append(head);

  const makeRow = (list, kind) => {
    const row = el('div', `arch-row ${kind}`);
    [list.slice(0, 8), list.slice(8)].forEach((half) => {
      const cell = el('div', 'half');
      half.forEach((tooth) => {
        const btn = el('button', 'tooth', String(tooth));
        btn.type = 'button';
        btn.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-label', `Tooth ${tooth}`);
        btn.addEventListener('click', () => {
          if (selected.has(tooth)) selected.delete(tooth); else selected.add(tooth);
          btn.setAttribute('aria-pressed', String(selected.has(tooth)));
          refresh();
          updatePreview();
        });
        buttons.set(tooth, btn);
        cell.append(btn);
      });
      row.append(cell);
    });
    return row;
  };
  wrap.append(makeRow(UPPER_ARCH, 'upper'), makeRow(LOWER_ARCH, 'lower'));

  const foot = el('div', 'arch-foot');
  const summary = el('span', 'muted', 'No teeth selected');
  const clear = el('button', 'link-btn', 'Clear');
  clear.type = 'button';
  foot.append(summary, clear);
  wrap.append(foot);

  const ordered = () => [...UPPER_ARCH, ...LOWER_ARCH].filter((t) => selected.has(t)).map(String);
  const refresh = () => {
    const list = ordered();
    summary.textContent = list.length ? `${list.length} selected: ${list.join(', ')}` : 'No teeth selected';
    clear.hidden = list.length === 0;
  };
  const reset = () => {
    selected.clear();
    buttons.forEach((b) => b.setAttribute('aria-pressed', 'false'));
    refresh();
  };
  clear.addEventListener('click', () => { reset(); updatePreview(); });

  parent.append(wrap);
  refresh();
  return { get: ordered, reset };
}

function collectValues() {
  if (!state.form) return null;
  const vals = {};
  for (const [id, handler] of Object.entries(state.form.handlers)) {
    const v = handler.get();
    if (!v || (Array.isArray(v) && v.length === 0)) return null;
    vals[id] = v;
  }
  return vals;
}

function finishSentence(text) {
  const t = text.trim();
  return t.endsWith('.') ? t : `${t}.`;
}

function updatePreview() {
  if (!state.form) return;
  const vals = collectValues();
  const box = $('#form-preview');
  const addBtn = $('#add-btn');
  if (!vals) {
    box.textContent = 'Select the teeth to see the sentence that will be added.';
    box.classList.add('empty');
    addBtn.disabled = true;
    return;
  }
  box.classList.remove('empty');
  box.textContent = finishSentence(renderTemplate(templateFor(state.settings, state.form.cat), vals));
  addBtn.disabled = false;
}

function addCurrentToNote() {
  const vals = collectValues();
  if (!vals) return;
  const sentence = finishSentence(renderTemplate(templateFor(state.settings, state.form.cat), vals));
  state.draft.notes.push(sentence);
  if (!state.draft.caseId) state.draft.caseId = state.caseId;
  saveDraft();
  renderNotes();
  Object.values(state.form.handlers).forEach((h) => h.reset());
  updatePreview();
  flash('Added to your note', 'ok');
}

/* ================= engagers ================= */

const VERDICT = {
  KEEP:     { icon: '🟢', label: 'KEEP',                       cls: 'ok' },
  REMOVE:   { icon: '🔴', label: 'REMOVE',                     cls: 'remove' },
  CONFLICT: { icon: '⚠️', label: 'CONFLICT - NEED REVIEW',     cls: 'warn' },
  REVIEW:   { icon: '❔', label: 'NO INSTRUCTION - NEED REVIEW', cls: 'warn' }
};
const BADGE_CLASS = { KEEP: 'keep', REMOVE: 'remove', MIXED: 'warn', CONFLICT: 'warn' };

// Highlight colours: engager words teal, KEEP wording green, REMOVE wording red (a negation such as
// "do not" is highlighted together with the word it reverses).
function markClass(m) {
  if (m.kind === 'verb' || m.kind === 'action') return m.decision === 'REMOVE' ? 'eg-mark-remove' : 'eg-mark-keep';
  return 'eg-mark-term';
}

// Builds highlighted DOM from the analysed text and the marks analyzeEngagerText returns.
function buildHighlighted(text, marks) {
  const frag = document.createDocumentFragment();
  if (!marks || !marks.length) { frag.append(document.createTextNode(text)); return frag; }
  let cursor = 0;
  marks.forEach((m) => {
    if (m.start < cursor) return;
    if (m.start > cursor) frag.append(document.createTextNode(text.slice(cursor, m.start)));
    const mark = document.createElement('mark');
    mark.className = markClass(m);
    mark.title = m.kind === 'term' || m.kind === 'topic' ? 'Engager word' : `${m.decision || 'KEEP'} wording${m.negated ? ' (negated)' : ''}`;
    mark.textContent = text.slice(m.start, m.end);
    frag.append(mark);
    cursor = m.end;
  });
  if (cursor < text.length) frag.append(document.createTextNode(text.slice(cursor)));
  return frag;
}

const decisionName = (d) => (d === 'MIXED' || d === 'CONFLICT' ? 'CONFLICT' : d);

// One line per keyword pair: which instruction word, next to which engager word, in which sentence.
function evidenceList(evidence, sourceName) {
  const ul = el('ul', 'eg-evidence');
  evidence.forEach((ev) => {
    const li = el('li');
    const kw = (t) => { const n = el('span', 'eg-kw', t); return n; };
    if (ev.yesno) {
      li.append('Page value ', kw(`"${ev.action}"`), ` → read as ${ev.decision}`);
    } else {
      li.append(kw(`"${ev.action}"`), ev.negated ? ' (negated, so reversed)' : '', ' next to ', kw(`"${ev.term}"`), ` → ${ev.decision}`);
      if (ev.sentence) { li.append(el('br'), el('q', null, ev.sentence)); }
    }
    ul.append(li);
  });
  return ul;
}

// One block per section: title + verdict badge + "DECIDED" badge, optional original/translation, highlighted text.
function addSectionBlock(wrap, sec, prep) {
  const block = el('div', `eg-highlight-block${sec.decisive ? ' decisive' : ''}${!sec.decisive && !sec.decision ? ' muted-block' : ''}`);
  const label = el('div', 'eg-highlight-label', sec.id === 'rx' && state.engagerRxVersion ? `${sec.label} - ${state.engagerRxVersion}` : sec.label);
  const verdictText = sec.decision === 'MIXED' ? 'CONFLICT' : sec.decision || 'no instruction';
  label.append(el('span', `eg-badge ${BADGE_CLASS[sec.decision] || 'idle'}`, verdictText));
  if (sec.decisive) label.append(el('span', 'eg-badge used', 'USED FOR THE DECISION'));
  else if (sec.decision) label.append(el('span', 'eg-badge over', 'NOT USED'));
  block.append(label);

  if (!sec.text.trim()) {
    block.append(el('div', 'muted', sec.id === 'rx' ? 'No Rx instructions found in any version.' : sec.id === 'default' ? 'Not found on the page.' : 'Empty - nothing written here.'));
  } else {
    if (prep?.translated) {
      const orig = el('div', 'eg-original');
      const origBody = el('div');
      origBody.append(buildHighlighted(prep.original, prep.originalMarks));
      orig.append(el('div', null, `Original (${prep.lang}):`), origBody);
      block.append(orig);
      block.append(el('div', 'eg-highlight-label', `English translation (detected: ${prep.lang})`));
    } else if (prep?.failed) {
      block.append(el('div', 'eg-note', 'Automatic translation was not available - analysed as written (the built-in multilingual keywords still apply).'));
    }
    const body = el('div');
    body.append(buildHighlighted(sec.text, sec.marks));
    block.append(body);
  }
  if (sec.evidence?.length) block.append(evidenceList(sec.evidence, sec.id));
  if (sec.note) block.append(el('div', 'eg-note', sec.note));
  wrap.append(block);
}

// Every note goes through automatic translation to English first (Google Translate detects the language;
// English comes back unchanged), then the English text is analysed.
async function translateToEnglish(text) {
  const q = text.slice(0, 4000);
  const base = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t';
  const res = encodeURIComponent(q).length < 1800
    ? await fetch(`${base}&q=${encodeURIComponent(q)}`)
    : await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `q=${encodeURIComponent(q)}` });
  if (!res.ok) throw new Error(`Translate service returned ${res.status}`);
  const data = await res.json();
  return { translated: (data?.[0] || []).map((part) => part?.[0] || '').join('').trim(), lang: data?.[2] || 'und' };
}

// Every note goes through automatic translation to English FIRST (the service detects the language;
// English comes back unchanged). Then the English text is analysed.
async function prepareText(raw) {
  const original = String(raw || '').trim();
  if (!original) return { original: '', text: '', lang: 'en', translated: false };
  try {
    const t = await translateToEnglish(original);
    EG('translated:', t.lang, '|', original.slice(0, 60), '->', t.translated.slice(0, 80));
    if (!t.translated) throw new Error('empty translation');
    if (t.lang === 'en') return { original, text: original, lang: 'en', translated: false };
    return { original, text: t.translated, lang: t.lang, translated: true, originalMarks: analyzeEngagerText(original, state.settings.engagers).marks };
  } catch (err) {
    console.error('[ClearComm][popup] translation failed', err);
    return { original, text: original, lang: 'und', translated: false, failed: true };
  }
}

let analyzing = false;
async function analyzeEngagers({ rx: rxRaw = '', pref: prefRaw = '', defaultRaw: defRaw = '' }) {
  if (analyzing) return;
  analyzing = true;
  try {
    const words = state.settings.engagers;
    // 1) detect language (+ translate to English), 2) proximity engine, 3) priority cascade
    const [rxPrep, prefPrep, defPrep] = await Promise.all([prepareText(rxRaw), prepareText(prefRaw), prepareText(defRaw)]);
    const res = resolveEngagerDecision({ rx: rxPrep.text, pref: prefPrep.text, defaultRaw: defPrep.text }, words);
    EG('decision:', res.decision, '| decided by:', res.decidedBy, '|', res.reason, res.sections);
    const resultCard = $('#eg-result');
    resultCard.hidden = false;

    const decided = res.sections.find((sec) => sec.decisive);
    const WHERE = { rx: 'the Rx', pref: 'the preferences note', default: 'the revisions default' };
    const decidedEv = decided?.evidence?.[0];
    const ACTION = {
      KEEP: 'KEEP the engagers',
      REMOVE: 'REMOVE the engagers',
      CONFLICT: 'Check manually',
      REVIEW: 'Check manually'
    };
    const cls = res.decision === 'KEEP' ? 'keep' : res.decision === 'REMOVE' ? 'remove' : 'warn';
    $('#eg-banner').className = `eg-banner ${cls}`;
    $('#eg-banner-icon').textContent = res.decision === 'KEEP' ? '✔' : res.decision === 'REMOVE' ? '✖' : '!';
    $('#eg-action').textContent = ACTION[res.decision] || ACTION.REVIEW;
    $('#eg-banner .eg-caption').textContent = res.decision === 'CONFLICT' || res.decision === 'REVIEW' ? 'Needs you' : 'Recommended';

    // One short reason line.
    const ev = decided?.evidence?.[0];
    let basis;
    if (res.decision === 'CONFLICT') basis = `${{ rx: 'The Rx', pref: 'The preferences note', default: 'The revisions default' }[decided?.id] || 'The text'} says both keep and remove.`;
    else if (res.decision === 'REVIEW') basis = 'Nothing about engagers was found.';
    else if (decidedEv?.yesno) basis = `Nothing about engagers in the Rx or notes, so the revisions default "${decidedEv.action}" applies.`;
    else if (ev) basis = `From ${WHERE[decided.id]}: "${ev.action}" next to "${ev.term}".`;
    else basis = res.reason;
    $('#eg-basis').textContent = basis;

    // The deciding text, translated and highlighted.
    const quote = $('#eg-quote');
    quote.textContent = '';
    const showSec = decided && !decidedEv?.yesno ? decided : null;
    if (showSec && showSec.text.trim()) {
      const prep = { rx: rxPrep, pref: prefPrep, default: defPrep }[showSec.id];
      const tag = `${showSec.id === 'rx' ? 'Rx' : showSec.id === 'pref' ? 'Preferences note' : 'Revisions default'}${prep?.translated ? ` (translated from ${prep.lang})` : ''}`;
      const body = el('div');
      body.append(buildHighlighted(showSec.text, showSec.marks));
      quote.append(el('div', 'eg-quote-tag', tag), body);
      quote.hidden = false;
    } else {
      quote.hidden = true;
    }

    const wrap = $('#eg-highlight-wrap');
    wrap.textContent = '';
    const prepById = { rx: rxPrep, pref: prefPrep, default: defPrep };
    res.sections.forEach((sec) => addSectionBlock(wrap, sec, prepById[sec.id]));

  } finally {
    analyzing = false;
  }
}

const ENGAGER_FETCH_FAILURES = {
  NOT_PORTAL: 'Open a ClearCorrect page first.',
  WRONG_PAGE: 'Open a case or setup page to pull this automatically.',
  NO_SUBMISSION_LINK: "Couldn't find the Submission link on this page.",
  NO_SUBMISSION_POPUP: "The case submission form didn't open in time."
};

function updateEngagerPagePill() {
  const pill = $('#eg-page-pill');
  const url = state.activeTab?.url || '';
  if (!isPortalUrl(url)) { pill.className = 'pill off'; pill.textContent = 'Not on ClearCorrect'; return; }
  if (url.toLowerCase().includes('setup.aspx')) { pill.className = 'pill ok'; pill.textContent = 'Setup page'; return; }
  if (url.toLowerCase().includes('case.aspx')) { pill.className = 'pill ok'; pill.textContent = 'Case page'; return; }
  pill.className = 'pill idle';
  pill.textContent = 'Open a case or setup page';
}

const debugLines = [];
const EG = (...a) => {
  console.log('[ClearComm][popup]', ...a);
  const line = a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ');
  debugLines.push(`${new Date().toLocaleTimeString()}  ${line}`);
  const box = document.getElementById('eg-debug');
  if (box) box.value = debugLines.join('\n');
};
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs the two page phases directly from the popup (no background worker involved), in every
// frame of the tab, because the case submission pop-up may live inside an iframe.
// Runs one page step, in every frame (or only in `frameId`). Never throws: a page reload in the
// middle of a step just returns [] and the collector re-checks the page.
function makeExec(tabId) {
  return async (func, args = [], frameId = null) => {
    try {
      const target = frameId == null ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] };
      const res = await chrome.scripting.executeScript({ target, world: 'MAIN', func, args });
      return res.map((r) => ({ frameId: r.frameId, result: r.result }));
    } catch (err) {
      EG('  step error (page may be reloading):', String(err?.message || err));
      return [];
    }
  };
}

function setEngagerStep(step, failed = false) {
  const steps = $$('#eg-steps li');
  steps.forEach((li) => {
    const n = Number(li.dataset.step);
    li.className = n < step ? 'done' : n === step ? (failed ? 'failed' : 'active') : '';
  });
}

async function fetchEngagerDataFromPage() {
  const [freshTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (freshTab) state.activeTab = freshTab;
  EG('button clicked; tab:', state.activeTab?.id, state.activeTab?.url);
  const btn = $('#eg-fetch');
  const status = $('#eg-auto-status');
  debugLines.length = 0;

  if (!isPortalUrl(state.activeTab?.url)) {
    flash('Open a ClearCorrect case or setup page first.', 'error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Checking…';
  $('#eg-result').hidden = true;
  $('#eg-steps').hidden = false;
  let currentStep = 1;
  setEngagerStep(1);
  status.textContent = '';

  let res;
  try {
    res = await collectFromCase({
      url: state.activeTab.url,
      exec: makeExec(state.activeTab.id),
      log: EG,
      progress: (msg, step) => { if (step) { currentStep = step; setEngagerStep(step); } status.textContent = msg; }
    });
  } catch (err) {
    console.error('[ClearComm][popup] collect failed', err);
    res = { ok: false, error: String(err?.message || err) };
  }

  btn.disabled = false;
  btn.textContent = 'Check this case';

  if (!res?.ok) {
    setEngagerStep(currentStep, true);
    status.textContent = ENGAGER_FETCH_FAILURES[res?.reason] || `Couldn't read this case (${res?.error || 'unknown error'}).`;
    return;
  }

  const rx = res.rxFound ? res.rxText : '';
  const pref = res.additionalPrefsRaw || '';
  state.engagerDefaultRaw = res.engagersDefaultRaw || '';
  state.engagerRxVersion = res.rxFound && res.rxVersionLabel ? `version ${res.rxVersionLabel}` : '';

  setEngagerStep(4);
  status.textContent = res.rxFound ? 'Translating and deciding…' : 'No Rx found in any version. Translating and deciding…';
  EG('analysing', { rx, pref, defaultRaw: state.engagerDefaultRaw });
  await analyzeEngagers({ rx, pref, defaultRaw: state.engagerDefaultRaw });
  setEngagerStep(5);                       // every step done
  status.textContent = res.rxFound ? '' : 'No Rx was found in any version.';
}

function bindEngagers() {
  $('#eg-fetch').addEventListener('click', fetchEngagerDataFromPage);
  $('#eg-debug-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('#eg-debug').value); flash('Debug log copied', 'ok'); }
    catch { $('#eg-debug').select(); flash('Press Ctrl+C to copy the log', 'info'); }
  });
}

/* ================= notes: copy and post ================= */

const fullNoteText = () => state.draft.notes.join(' ');

async function copyNote(message = 'Note copied') {
  try {
    await navigator.clipboard.writeText(fullNoteText());
    flash(message, 'ok');
    return true;
  } catch (e) {
    flash("Couldn't copy the note. Select the text and copy it manually.", 'error');
    return false;
  }
}

const POST_FAILURES = {
  NOT_PORTAL: 'Open a ClearCorrect case first.',
  NO_CASE: "The case number wasn't found on this page.",
  NO_ELEMENTS: "The note box wasn't found on the page.",
  EMPTY: 'There is no note to post.'
};

async function postToPortal() {
  if (state.isPosting || !state.draft.notes.length) return;
  state.isPosting = true;

  const postBtn = $('#post-btn');
  if (postBtn) {
    postBtn.disabled = true;
    postBtn.textContent = 'Posting…';
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const caseId = tab ? await fetchCurrentCaseId(tab) : null;
    const res = tab
      ? await send({ action: 'POST_NOTE', tabId: tab.id, caseId, text: fullNoteText() })
      : { ok: false, reason: 'NOT_PORTAL' };

    if (res?.ok) {
      if (res.submitted && !res.verified) {
        // The Save button was clicked but the note was NOT confirmed in the table.
        // Warn the user and keep the draft so the count badge stays correct.
        flash('Note sent but not confirmed in portal. Please check manually.', 'error');
      } else if (res.typeSet === false || res.reasonSet === false) {
        flash('Posted, but the note type or reason was not found on the page. Check Settings.', 'error');
        if (state.settings.notes.clearAfterPost) clearDraft();
      } else {
        flash(res.submitted ? 'Note posted to the portal ✓' : 'Note filled in. Review it, then save it on the page.', 'ok');
        if (res.submitted && state.settings.notes.clearAfterPost) clearDraft();
      }
      return;
    }

    const why = POST_FAILURES[res?.reason] || `Couldn't post the note (${res?.error || 'unknown error'}).`;
    await copyNote(`${why} The note was copied instead.`);
  } finally {
    state.isPosting = false;
    if (postBtn) {
      postBtn.disabled = false;
      postBtn.textContent = 'Post to portal';
    }
  }
}

/* ================= first-run login ================= */

async function initFirstRunLogin() {
  const { needsLogin } = await chrome.storage.local.get('needsLogin');
  const card = $('#login-card');
  
  const navTabs = $('.tabs');
  const dock = $('.dock');
  const sectionTitle = $('.section-title');
  const categoryGroups = $('#category-groups');
  
  if (!needsLogin) { 
    card.hidden = true; 
    if (navTabs) navTabs.style.display = '';
    if (dock) dock.style.display = '';
    if (sectionTitle) sectionTitle.style.display = '';
    if (categoryGroups) categoryGroups.style.display = '';
    return; 
  }

  card.hidden = false;
  if (navTabs) navTabs.style.display = 'none';
  if (dock) dock.style.display = 'none';
  if (sectionTitle) sectionTitle.style.display = 'none';
  if (categoryGroups) categoryGroups.style.display = 'none';

  const btn = $('#login-btn');
  const hint = $('#login-hint');
  const onPortal = isPortalUrl(state.activeTab?.url);
  btn.disabled = !onPortal;
  hint.textContent = onPortal ? '' : 'Open any ClearCorrect page, then come back and click this.';

  // Remove existing listeners to avoid duplicates if re-inited
  const newBtn = btn.cloneNode(true);
  btn.replaceWith(newBtn);

  newBtn.addEventListener('click', async () => {
    if (newBtn.disabled) return;
    newBtn.disabled = true;
    newBtn.textContent = 'Logging in…';
    const res = await send({ action: 'ACTIVATE_LOGIN', tabId: state.activeTab?.id });
    if (res?.ok) {
      flash(`Logged in as ${res.username}`, 'ok');
      await initFirstRunLogin(); // Re-evaluate and unhide
      return;
    }
    newBtn.disabled = false;
    newBtn.textContent = 'Log in with my portal account';
    flash(res?.reason === 'NOT_PORTAL' ? 'Open a ClearCorrect page first.' : "Couldn't find your username on this page.", 'error');
  });
}

/* ================= settings ================= */

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => o[k], obj);
  target[last] = value;
}

function writeInput(input, value) {
  const kind = input.dataset.kind || (input.type === 'checkbox' ? 'checkbox' : 'text');
  if (kind === 'checkbox') input.checked = !!value;
  else if (kind === 'percent') input.value = String(Math.round(Number(value) * 100));
  else input.value = value ?? '';
}

function readInput(input) {
  const kind = input.dataset.kind || (input.type === 'checkbox' ? 'checkbox' : 'text');
  if (kind === 'checkbox') return input.checked;
  if (kind === 'percent') return Math.round(Number(input.value)) / 100;
  if (kind === 'number') {
    const n = parseFloat(input.value);
    if (Number.isNaN(n)) return undefined;
    return Math.min(Math.max(n, Number(input.min) || n), Number(input.max) || n);
  }
  return input.value;
}

let saveTimer;
function persistSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveSettings(state.settings), 250);
}

function syncSettingsUI() {
  $$('[data-setting]').forEach((input) => writeInput(input, getPath(state.settings, input.dataset.setting)));$('#zoom-value').textContent = `${Math.round(state.settings.zoom * 100)}%`;
  applyAppearance();
}

function bindSettings() {
  $$('[data-setting]').forEach((input) => {
    input.addEventListener('input', () => {
      const value = readInput(input);
      if (value === undefined) return;
      setPath(state.settings, input.dataset.setting, value);
      persistSettings();
      if (input.dataset.setting === 'theme' || input.dataset.setting === 'zoom') {
        $('#zoom-value').textContent = `${Math.round(state.settings.zoom * 100)}%`;
        applyAppearance();
      }
    });
  });

  $('#export-btn').addEventListener('click', () => {
    const payload = { app: 'clearcomm-toolkits', version: chrome.runtime.getManifest().version, settings: state.settings };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'clearcomm-settings.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('#import-btn').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const incoming = parsed && typeof parsed === 'object' && parsed.settings ? parsed.settings : parsed;
      state.settings = mergeDeep(structuredClone(DEFAULT_SETTINGS), incoming);
      await saveSettings(state.settings);
      syncSettingsUI();
      buildTemplateEditor();
      updatePreview();
      flash('Settings imported', 'ok');
    } catch (err) {
      flash("That file isn't a valid settings export.", 'error');
    }
  });

  let resetArmed = false;
  $('#reset-all').addEventListener('click', async () => {
    const btn = $('#reset-all');
    if (!resetArmed) {
      resetArmed = true;
      btn.textContent = 'Click again to confirm reset';
      setTimeout(() => { resetArmed = false; btn.textContent = 'Reset everything to defaults'; }, 3500);
      return;
    }
    resetArmed = false;
    btn.textContent = 'Reset everything to defaults';
    state.settings = structuredClone(DEFAULT_SETTINGS);
    await saveSettings(state.settings);
    syncSettingsUI();
    buildTemplateEditor();
    updatePreview();
    flash('Settings reset', 'ok');
  });

  $('#version').textContent = `v${chrome.runtime.getManifest().version}`;
}

function buildTemplateEditor() {
  const list = $('#template-list');
  list.textContent = '';
  NOTE_CATEGORIES.forEach((cat) => {
    const wrap = el('div', 'tpl');
    const head = el('div', 'tpl-head');
    head.append(el('strong', '', cat.label));
    const reset = el('button', 'link-btn', 'Restore original');
    reset.type = 'button';
    head.append(reset);

    const area = document.createElement('textarea');
    area.rows = 3;
    area.value = templateFor(state.settings, cat);
    area.setAttribute('aria-label', `Wording for ${cat.label}`);

    const hint = el('p', 'muted small', `Placeholders: ${placeholdersFor(cat).join(' ')}`);

    const syncReset = () => { reset.hidden = area.value === cat.template; };
    area.addEventListener('input', () => {
      const text = area.value;
      if (!text.trim() || text === cat.template) delete state.settings.notes.templates[cat.id];
      else state.settings.notes.templates[cat.id] = text;
      syncReset();
      persistSettings();
      if (state.form?.cat.id === cat.id) updatePreview();
    });
    reset.addEventListener('click', () => {
      area.value = cat.template;
      area.dispatchEvent(new Event('input'));
    });
    syncReset();

    wrap.append(head, area, hint);
    list.append(wrap);
  });
}

/* ================= start ================= */

async function init() {
  window.__clearcommPopupReady = true;
  console.log('[ClearComm][popup] init');
  state.settings = await getSettings();
  applyAppearance();

  const { ui } = await chrome.storage.local.get('ui');
  initTabs(ui?.lastTab);

  buildCategories();
  $('#form-close').addEventListener('click', closeForm);
  $('#add-btn').addEventListener('click', addCurrentToNote);
  $('#clear-notes').addEventListener('click', clearDraft);
  $('#copy-btn').addEventListener('click', () => copyNote());
  $('#post-btn').addEventListener('click', postToPortal);

  bindSettings();
  syncSettingsUI();
  buildTemplateEditor();
  bindEngagers();

  await loadDraft();
  await detectCase();
  updateEngagerPagePill();
  await initFirstRunLogin();
}

init();