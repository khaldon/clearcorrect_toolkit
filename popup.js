import {
  DEFAULT_SETTINGS, GROUPS, NOTE_CATEGORIES, UPPER_ARCH, LOWER_ARCH,
  getSettings, saveSettings, mergeDeep, renderTemplate, templateFor, placeholdersFor
} from './shared/defaults.js';

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
  draft: { notes: [], caseId: null }
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

  await loadDraft();
  await detectCase();
  await initFirstRunLogin();
}

init();