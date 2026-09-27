// Shared by the popup and the background service worker.
// Everything a user can change lives in DEFAULT_SETTINGS.

export const UPPER_ARCH = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
export const LOWER_ARCH = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];

const ARCH_OPTIONS = ['upper', 'lower', 'upper and lower'];

export const GROUPS = [
  { id: 'missing', label: 'Missing data' },
  { id: 'gingiva', label: 'Gingiva and soft tissue' },
  { id: 'scan', label: 'Scan quality' },
  { id: 'hardware', label: 'Hardware' }
];

// Placeholders available in templates:
//   {teeth} {toothWord}  -> for "teeth" inputs
//   {arch}  {archWord}   -> for an input with id "arch"
//   {surface} {tissue} {defect} {appliance} -> the matching option input
export const NOTE_CATEGORIES = [
  {
    id: 'missing-distal', group: 'missing', short: 'Distal / last molar',
    label: 'Missing data: distal / last molar',
    inputs: [{ id: 'teeth', label: 'Teeth', type: 'teeth' }],
    template: 'Missing data was identified in the distal portion of {toothWord} {teeth}, necessitating exclusion of this area to prevent fitting issues.'
  },
  {
    id: 'missing-interproximal', group: 'missing', short: 'Interproximal',
    label: 'Missing data: interproximal',
    inputs: [{ id: 'teeth', label: 'Teeth', type: 'teeth' }],
    template: 'Missing data was identified in the interproximal area of {toothWord} {teeth}. The affected area was repaired to prevent potential fitting issues.'
  },
  {
    id: 'missing-surface', group: 'missing', short: 'Surface',
    label: 'Missing data: surface',
    inputs: [
      { id: 'surface', label: 'Surface', type: 'options', options: ['buccal', 'lingual', 'buccal and lingual'] },
      { id: 'teeth', label: 'Teeth', type: 'teeth' }
    ],
    template: 'Missing data was identified on the {surface} surface of {toothWord} {teeth}. The affected area was repaired to preserve the tooth anatomy and prevent potential fitting issues.'
  },
  {
    id: 'gum-height', group: 'gingiva', short: 'Lack of gum height',
    label: 'Lack of gum height',
    inputs: [{ id: 'arch', label: 'Arch', type: 'options', options: ARCH_OPTIONS }],
    template: 'There is a lack of gingival height in the {arch} {archWord}.'
  },
  {
    id: 'gingival-margins', group: 'gingiva', short: 'Gingival margin defects',
    label: 'Defects on gingival margins',
    inputs: [{ id: 'arch', label: 'Arch', type: 'options', options: ARCH_OPTIONS }],
    template: 'Minor defects were identified on the gingival margins of the {arch} {archWord}. The affected areas were removed to prevent potential fitting issues.'
  },
  {
    id: 'frenum-papilla', group: 'gingiva', short: 'Frenum / papilla',
    label: 'Frenum / papilla',
    inputs: [
      { id: 'tissue', label: 'Soft tissue', type: 'options', options: ['frenum', 'papilla', 'frenum and papilla'] },
      { id: 'arch', label: 'Arch', type: 'options', options: ARCH_OPTIONS }
    ],
    template: 'The soft tissue {tissue} was incompletely captured in the {arch} {archWord} and was repaired to minimize the risk of aligner impingement.'
  },
  {
    id: 'distortions', group: 'scan', short: 'Distortions / excess material',
    label: 'Distortions / excess material',
    inputs: [{ id: 'teeth', label: 'Teeth', type: 'teeth' }],
    template: 'Distortions were observed in {toothWord} {teeth}. The affected areas were repaired while preserving the tooth morphology.'
  },
  {
    id: 'graining', group: 'scan', short: 'Minor graining',
    label: 'Minor graining',
    inputs: [{ id: 'arch', label: 'Arch', type: 'options', options: ARCH_OPTIONS }],
    template: 'Minor graining was identified on the {arch} {archWord} and was repaired without affecting the overall tooth shape.'
  },
  {
    id: 'bubbles', group: 'scan', short: 'Bubbles / punch outs',
    label: 'Minor bubbles / punch outs',
    inputs: [
      { id: 'defect', label: 'Defect type', type: 'options', options: ['bubbles', 'punch outs', 'bubbles and punch outs'] },
      { id: 'teeth', label: 'Teeth', type: 'teeth' }
    ],
    template: 'Minor {defect} were identified on {toothWord} {teeth} and were repaired to preserve the tooth surface and prevent potential fitting issues.'
  },
  {
    id: 'brackets', group: 'hardware', short: 'Brackets / metal hardware',
    label: 'Brackets / metal hardware',
    inputs: [
      { id: 'appliance', label: 'Appliance', type: 'options', options: ['Metal Brackets', 'Other Appliances', 'Metal Brackets and Other Appliances'] },
      { id: 'arch', label: 'Arch', type: 'options', options: ARCH_OPTIONS }
    ],
    template: '{appliance} were identified on {arch} {archWord}, they were digitally removed to avoid fitting issues.'
  }
];

export const SETTINGS_VERSION = 3;

export const DEFAULT_SETTINGS = {
  settingsVersion: SETTINGS_VERSION,
  theme: 'auto',            // auto | light | dark
  zoom: 1,                  // popup text size, 0.8 - 1.3
  notes: {
    clearAfterPost: false,  // empty the note after it is posted
    autoSubmit: true,       // click "Add Note" on the portal after filling it in
    noteTypeId: '7',        // portal dropdown values
    noteReasonId: '50',
    templates: {}           // { [categoryId]: custom template text }
  },
  toast: {
    enabled: true,
    text: "PLEASE DON'T FORGET THE B GRADE NOTE IF NEEDED",
    seconds: 3.5,
    position: 'top-right',  // top-right | top-left | bottom-right | bottom-left
    color: '#ff004f'
  },
  stl: {
    enabled: true,
    pattern: '{case}_{arch}', // tokens: {case} {arch} {date} {original}
    upperLabel: 'Maxillary',
    lowerLabel: 'Mandibular',
    otherLabel: 'arch',
    folder: '',               // optional sub-folder inside Downloads
    saveAs: false             // ask where to save every file
  },
  engagers: {
    translate: false,         // sends the doctor's note to Google Translate when clicked
    fuzzy: true,              // tolerate small spelling mistakes (attchemnt, engagres ...)
    numbering: 'auto',        // tooth numbering used in Rx notes: auto | fdi | universal
    // Every name doctors use for engagers, in several languages (accents are ignored).
    engagerTerms: [
      'engager', 'attachment', 'attachement', 'attatchment', 'cleat', 'cleet', 'button', 'botton', 'rests',
      'atache', 'ataches', 'attache', 'attaches', 'aditamento', 'aditamentos', 'boton', 'botones', 'botao', 'botoes',
      'taquet', 'taquets', 'bouton', 'boutons', 'attacco', 'attacchi', 'bottone', 'bottoni', 'knopfchen'
    ],
    keepWords: [
      'restore', 'maintain', 'keep', 'retain', 'continue', 'preserve', 'leave',
      'please leave', 'leave current', 'leave existing', 'leave as is',
      'retain all attachments', 'plaster casts', 'keep casts', 'same engagers',
      'start with same engagers', 'do not cancel', 'please do not cancel',
      "don't replace", 'do not replace', 'maintain all old rests', 'old attachment',
      'old attachments', 'keep attachments', 'keep engagers', 'maintain attachments', 'maintain engagers',
      // negated wording, so "do not remove" is read as keep
      'do not remove', "don't remove", 'dont remove', 'do not delete', "don't delete",
      // Spanish, Portuguese, French, Italian, German
      'mantener', 'conservar', 'dejar', 'manter', 'deixar', 'garder', 'conserver', 'laisser', 'mantenere', 'lasciare',
      'behalten', 'belassen', 'no quitar', 'no retirar', 'no eliminar', 'nao remover', 'nao retirar',
      'ne pas enlever', 'ne pas retirer', 'ne pas supprimer', 'non rimuovere', 'non togliere', 'nicht entfernen'
    ],
    removeWords: [
      'remove', 'delete', 'replace', 'cancel', 'stop', 'take off',
      'quitar', 'retirar', 'eliminar', 'tirar', 'enlever', 'supprimer', 'rimuovere', 'togliere', 'entfernen'
    ],
    // Extra checks on the FINAL Rx only, for the cut technician.
    alerts: {
      enabled: true,
      retainerWords: ['retainer', 'wire', 'retenedor', 'retentor', 'alambre', 'draht'],
      keepVerbs: ['keep', 'keeping', 'retain', 'retaining', 'retained', 'maintain', 'maintaining', 'leave', 'leaving',
        'preserve', 'preserving', 'continue', 'with wire', 'with retainer',
        'mantener', 'conservar', 'dejar', 'manter', 'deixar', 'garder', 'laisser', 'mantenere', 'lasciare', 'behalten'],
      removeVerbs: ['remove', 'removing', 'removed', 'removal', 'delete', 'deleting', 'cut', 'cutting', 'take off',
        'discard', 'no wire', 'no retainer', 'without wire', 'without retainer',
        'quitar', 'retirar', 'eliminar', 'cortar', 'remover', 'enlever', 'retirer', 'supprimer', 'rimuovere', 'togliere', 'entfernen'],
      spaceWords: ['space', 'spacing', 'diastema', 'gap', 'espacio', 'espaco', 'espace', 'spazio', 'lucke'],
      openWords: ['open', 'opening', 'opened', 'create', 'creating', 'leave open', 'keep open',
        'leave space', 'leave a space', 'leave the space', 'leave the spaces',
        'abrir', 'abra', 'ouvrir', 'aprire', 'offnen'],
      closeWords: ['close', 'closed', 'closing', 'closure', 'no space', 'no spaces', 'no gap', 'no gaps',
        'eliminate', 'eliminating', 'without space', 'without spaces', 'without gaps',
        'cerrar', 'cierre', 'cierra', 'fechar', 'feche', 'fermer', 'fermeture', 'chiudere', 'schliessen'],
      extraWords: []   // any other words you want highlighted in the final Rx
    }
  }
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Copies known keys from `extra` onto `base` (type-checked), so stored or
// imported settings can never break the UI. Empty-object defaults (templates)
// accept any keys.
export function mergeDeep(base, extra) {
  if (!isObj(extra)) return base;
  for (const key of Object.keys(extra)) {
    if (!(key in base)) continue;
    const b = base[key];
    const e = extra[key];
    if (isObj(b) && Object.keys(b).length === 0 && isObj(e)) base[key] = { ...e };
    else if (isObj(b) && isObj(e)) mergeDeep(b, e);
    else if (Array.isArray(b) ? Array.isArray(e) : typeof b === typeof e) base[key] = e;
  }
  return base;
}

// Word lists that gain new default entries when the extension is updated.
const LIST_PATHS = [
  ['engagers', 'keepWords'], ['engagers', 'removeWords'], ['engagers', 'engagerTerms'],
  ['engagers', 'alerts', 'retainerWords'], ['engagers', 'alerts', 'keepVerbs'], ['engagers', 'alerts', 'removeVerbs'],
  ['engagers', 'alerts', 'spaceWords'], ['engagers', 'alerts', 'openWords'], ['engagers', 'alerts', 'closeWords']
];
const at = (obj, path) => path.reduce((o, k) => (o == null ? o : o[k]), obj);

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = mergeDeep(structuredClone(DEFAULT_SETTINGS), settings || {});
  if ((settings?.settingsVersion ?? 0) < SETTINGS_VERSION) {
    // After an update, add the new default words to lists the user may have saved earlier
    // (their own additions are kept).
    for (const path of LIST_PATHS) {
      const list = at(merged, path);
      const defaults = at(DEFAULT_SETTINGS, path);
      if (Array.isArray(list) && Array.isArray(defaults)) {
        const have = new Set(list.map((w) => String(w).toLowerCase()));
        defaults.forEach((w) => { if (!have.has(String(w).toLowerCase())) list.push(w); });
      }
    }
    merged.settingsVersion = SETTINGS_VERSION;
    await chrome.storage.local.set({ settings: merged });
  }
  return merged;
}

export function saveSettings(settings) {
  return chrome.storage.local.set({ settings });
}

export function templateFor(settings, category) {
  const custom = settings?.notes?.templates?.[category.id];
  return typeof custom === 'string' && custom.trim() ? custom : category.template;
}

export function placeholdersFor(category) {
  const out = [];
  for (const input of category.inputs) {
    if (input.type === 'teeth') out.push('{teeth}', '{toothWord}');
    else if (input.id === 'arch') out.push('{arch}', '{archWord}');
    else out.push(`{${input.id}}`);
  }
  return out;
}

export function renderTemplate(template, vals) {
  const teeth = Array.isArray(vals.teeth) ? vals.teeth : [];
  const ctx = {
    ...vals,
    teeth: teeth.join(', '),
    toothWord: teeth.length > 1 ? 'teeth' : 'tooth',
    archWord: typeof vals.arch === 'string' && vals.arch.includes('and') ? 'arches' : 'arch'
  };
  return template.replace(/\{(\w+)\}/g, (match, key) => (ctx[key] !== undefined ? ctx[key] : match));
}
