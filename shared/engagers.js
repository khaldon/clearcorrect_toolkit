// Engager keep/remove logic, final-Rx technician alerts and tooth-number conversion.
//
// Engagers tab decision flow (see resolveEngagerDecision below):
//   P1 Rx instructions (Online Form)  >  P3 Additional treatment preferences note
//   ... and if neither explicitly mentions engagers -> P2 "Engagers removal for revisions".
//   Action words must sit within `proximity` words (default 6) of an engager word.
//   Conflicting KEEP/REMOVE inside the SAME section -> CONFLICT (needs review).
// (decide() further down is the older multi-version workflow; the popup no longer uses it.)

/* ======================= text helpers ======================= */

// Lower-case, strip accents and straighten quotes. Always keeps the same length as the
// input, so positions found in the folded text point at the same place in the original.
export function fold(s) {
  return String(s ?? '').split('').map((ch) => {
    if (ch === '\u2018' || ch === '\u2019') return "'";
    if (ch.charCodeAt(0) < 128) return ch.toLowerCase();
    const f = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return f.length === 1 ? f : ch;
  }).join('');
}

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LANG_WORDS = {
  es: 'el los las del que por favor con sin para una se como todos todas mantener conservar quitar retirar dejar eliminar ataches aditamentos botones',
  fr: 'le les des du et est pas pour avec sans une aux sur ne tous toutes merci garder conserver enlever laisser supprimer taquets boutons',
  de: 'der die das und nicht mit ohne fur bitte alle ein eine den zu bei behalten belassen entfernen knopfchen',
  pt: 'os dos nao com sem uma todos obrigado manter deixar remover retirar botoes',
  it: 'il gli dei delle che non con senza tutti tutte grazie mantenere lasciare rimuovere togliere attacchi bottoni'
};
const LANG_SETS = Object.fromEntries(Object.entries(LANG_WORDS).map(([k, v]) => [k, new Set(v.split(' '))]));

/** Cheap local guess: 'en' | 'ar' | 'es' | 'fr' | 'de' | 'pt' | 'it' | 'und' (some other language). */
export function guessLanguage(text) {
  const raw = String(text ?? '').replace(/[\u2000-\u206F\u00A0]/g, ' ');
  if (!raw.trim()) return 'en';
  if (/[\u0600-\u06FF]/.test(raw)) return 'ar';
  if (/[\u0400-\u04FF]/.test(raw)) return 'ru';
  if (/[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/.test(raw)) return 'und';
  const toks = tokensOf(fold(raw)).map((t) => t.text);
  let best = null; let bestScore = 0;
  for (const [lang, set] of Object.entries(LANG_SETS)) {
    const score = toks.filter((t) => set.has(t)).length;
    if (score > bestScore) { best = lang; bestScore = score; }
  }
  if (best && (bestScore >= 2 || (bestScore >= 1 && toks.length <= 6))) return best;
  return /[^\x00-\x7F]/.test(raw) ? 'und' : 'en';
}

export function isNonEnglish(text) {
  return guessLanguage(text) !== 'en';
}

const prep = (list) => (Array.isArray(list) ? list : [])
  .map((w) => ({ orig: String(w).trim(), f: fold(w).trim() }))
  .filter((w) => w.f);

function tokensOf(f) {
  const out = [];
  const re = /\p{L}+/gu;
  let m;
  while ((m = re.exec(f)) !== null) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

const inside = (a, c) => a.start >= c.start && a.end <= c.end;

function clauseSpans(f) {
  const spans = [];
  const re = /[^.;!?\n]+/g;
  let m;
  while ((m = re.exec(f)) !== null) spans.push({ start: m.index, end: m.index + m[0].length });
  return spans;
}

/* ---------- fuzzy matching (small spelling mistakes) ---------- */

// Optimal-string-alignment distance: insert, delete, replace, or swap two neighbouring letters.
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array(b.length + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Short words must match exactly (so "clear" is never read as "cleat"); longer words may
// have 1 mistake (6 to 9 letters) or 2 (10+), and must start with the same letter.
const tolerance = (len) => (len >= 10 ? 2 : len >= 6 ? 1 : 0);

function fuzzyEq(token, term, allowPlural) {
  const forms = allowPlural ? [term, `${term}s`, `${term}es`] : [term];
  const tol = tolerance(term.length);
  for (const form of forms) {
    if (token === form) return true;
    if (tol && token[0] === form[0] && Math.abs(token.length - form.length) <= tol && distance(token, form) <= tol) return true;
  }
  return false;
}

// Finds words/phrases in folded text. Single words are compared token by token.
function wordHits(f, toks, list, { prefix = false, fuzzy = false, stop = null, plural = false } = {}) {
  const hits = [];
  for (const w of list) {
    if (w.f.includes(' ')) {
      const re = new RegExp(`(?<!\\p{L})${escapeRegExp(w.f)}${prefix ? '' : '(?!\\p{L})'}`, 'gu');
      let m;
      while ((m = re.exec(f)) !== null) hits.push({ start: m.index, end: m.index + m[0].length, word: w.orig });
      continue;
    }
    for (const t of toks) {
      const exact = t.text === w.f || (prefix && t.text.startsWith(w.f));
      const near = !exact && fuzzy && !(stop && stop.has(t.text)) && fuzzyEq(t.text, w.f, plural);
      if (exact || near) hits.push({ start: t.start, end: t.end, word: w.orig, fuzzy: near });
    }
  }
  return hits;
}

/* ======================= engager keep / remove ======================= */

const INVERT = { KEEP: 'REMOVE', REMOVE: 'KEEP', OPEN: 'CLOSE', CLOSE: 'OPEN' };
// "do not remove", "no need to remove", "no quitar", "nicht entfernen" ...
const NEGATION = /(?:\b(?:do not|don't|dont|never|not|no need to|need not)\s+(?:\w+\s+){0,2}|\b(?:no|nao|non|nicht|ne pas|sin)\s+)$/;

function effective(hit, f) {
  const before = f.slice(Math.max(0, hit.start - 30), hit.start);
  const negated = NEGATION.test(before);
  const m = negated ? NEGATION.exec(before) : null;
  const markStart = m ? hit.start - before.length + m.index : hit.start;   // include "do not" in the highlight
  return { name: negated ? INVERT[hit.name] : hit.name, negated, markStart };
}

function substringHits(f, list, name) {
  const hits = [];
  for (const w of list) {
    let i = f.indexOf(w.f);
    while (i !== -1) {
      hits.push({ start: i, end: i + w.f.length, name, word: w.orig });
      i = f.indexOf(w.f, i + 1);
    }
  }
  return hits;
}

// A longer phrase ("do not remove") wins over the shorter word inside it ("remove").
function dropContained(hits) {
  const sorted = [...hits].sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const kept = [];
  for (const h of sorted) {
    if (!kept.some((k) => h.start >= k.start && h.end <= k.end)) kept.push(h);
  }
  return kept.sort((a, b) => a.start - b.start);
}

function topicSpansOf(f, toks, words) {
  const cfg = words.alerts;
  if (!cfg) return [];
  const fuzzy = words.fuzzy !== false;
  return wordHits(f, toks, [...prep(cfg.retainerWords), ...prep(cfg.spaceWords)], { prefix: true, fuzzy });
}

/**
 * Reads one note and decides keep / remove for ENGAGERS (also called attachments, cleats,
 * buttons ...). A keep/remove word only counts when it sits in the same sentence as an
 * engager word, so "remove the wire" is not mistaken for "remove the engagers".
 * Returns { decision, word, confidence, negated, marks, teeth } or null for an empty note.
 */
export function analyzeEngagerText(text, words) {
  const src = String(text ?? '');
  if (!src.trim()) return null;

  const f = fold(src);
  const toks = tokensOf(f);
  const fuzzy = words.fuzzy !== false;
  const keep = prep(words.keepWords);
  const remove = prep(words.removeWords);
  const dist = Number.isFinite(Number(words.proximity)) ? Number(words.proximity) : 6;

  // Words sitting between two spans (0 when they touch or overlap): the "distance" of the proximity rule.
  const gapWords = (a, b) => {
    const [first, second] = a.start <= b.start ? [a, b] : [b, a];
    if (second.start < first.end) return 0;
    return toks.filter((t) => t.start >= first.end && t.end <= second.start).length;
  };

  const termHits = wordHits(f, toks, prep(words.engagerTerms), { fuzzy, plural: true });
  const topicSpans = topicSpansOf(f, toks, words);
  const clauses = clauseSpans(f);

  let verbs = dropContained([...substringHits(f, keep, 'KEEP'), ...substringHits(f, remove, 'REMOVE')]);
  // "retain" inside "retainer" is not an instruction about engagers.
  verbs = verbs.filter((v) => !topicSpans.some((t) => v.start < t.end && v.end > t.start));

  // Spelling mistakes in single-word verbs ("remvoe"), only inside sentences that mention engagers.
  if (fuzzy) {
    const single = [...keep.map((w) => ({ ...w, name: 'KEEP' })), ...remove.map((w) => ({ ...w, name: 'REMOVE' }))]
      .filter((w) => !w.f.includes(' ') && w.f.length >= 6);
    for (const c of clauses) {
      if (!termHits.some((t) => inside(t, c))) continue;
      for (const t of toks.filter((tok) => inside(tok, c))) {
        if (verbs.some((v) => v.start < t.end && v.end > t.start)) continue;
        const hit = single.find((w) => fuzzyEq(t.text, w.f, false));
        if (hit) verbs.push({ start: t.start, end: t.end, name: hit.name, word: hit.orig, fuzzy: true });
      }
    }
    verbs = verbs.filter((v) => !topicSpans.some((t) => v.start < t.end && v.end > t.start));
    verbs.sort((a, b) => a.start - b.start);
  }

  // 1) Pair each engager word with the nearest verb before it ("keep the attachments"),
  //    otherwise the nearest one after it ("attachments should be removed").
  const picks = [];
  const pairs = [];
  const termClauses = [];
  for (const c of clauses) {
    const ct = termHits.filter((t) => inside(t, c));
    const cv = verbs.filter((v) => inside(v, c));
    if (!ct.length) continue;
    termClauses.push(c);
    if (!cv.length) continue;
    for (const t of ct) {
      // Proximity rule: the action must be within `dist` words of the engager word.
      const near = cv.filter((v) => gapWords(v, t) <= dist);
      if (!near.length) continue;
      const before = near.filter((v) => v.start < t.start);
      const after = near.filter((v) => v.start >= t.start);
      const best = before.length ? before.reduce((a, b) => (b.start > a.start ? b : a)) : after.reduce((a, b) => (b.start < a.start ? b : a));
      picks.push(best);
      pairs.push({ t, v: best, c });
    }
  }

  let used = [...new Set(picks)];
  let confidence = 'high';
  let sourceClauses = termClauses;

  // 2) No engager word next to a verb: fall back to the general wording, but ignore
  //    sentences that are about retainers, wires or spaces.
  if (!used.length && words.requireTarget === false) {
    const general = verbs.filter((v) => {
      const c = clauses.find((cl) => inside(v, cl));
      return c && !topicSpans.some((t) => inside(t, c));
    });
    used = general;
    confidence = 'low';
    sourceClauses = clauses.filter((c) => general.some((v) => inside(v, c)));
  }

  const marks = termHits.map((t) => ({ start: t.start, end: t.end, kind: 'term' }));
  if (!used.length) {
    return { decision: null, word: '', confidence, negated: false, marks: mergeMarks(marks), teeth: [], evidence: [] };
  }

  used.forEach((v) => { const e = effective(v, f); marks.push({ start: e.markStart, end: v.end, kind: 'verb', decision: e.name, negated: e.negated }); });
  const eff = used.map((v) => effective(v, f));
  const names = [...new Set(eff.map((e) => e.name))];
  const first = used[0];

  const numbering = detectNumbering(f, words.numbering, clauses.map((c) => f.slice(c.start, c.end)));
  const teeth = [];
  sourceClauses.forEach((c) => teeth.push(...extractTeeth(f.slice(c.start, c.end), numbering)));

  // Evidence for the UI: which engager word + which instruction word + the sentence they sit in.
  const seen = new Set();
  const evidence = [];
  for (const { t, v, c } of pairs) {
    if (!used.includes(v)) continue;
    const key = `${t.start}:${v.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const e = effective(v, f);
    evidence.push({
      term: src.slice(t.start, t.end),
      action: src.slice(v.start, v.end),
      dictionaryWord: v.word,
      decision: e.name,
      negated: e.negated,
      sentence: src.slice(c.start, c.end).trim()
    });
  }

  return {
    evidence,
    decision: names.length === 1 ? names[0] : 'MIXED',
    word: names.length === 1 ? first.word : '',
    confidence,
    negated: eff.some((e) => e.negated),
    marks: mergeMarks(marks),
    teeth: uniqueTeeth(teeth)
  };
}

export function checkText(text, words) {
  const a = analyzeEngagerText(text, words);
  return a && a.decision ? { decision: a.decision, word: a.word, confidence: a.confidence } : null;
}

// First keep/remove match across a list of notes (in the order given).
export function firstMatch(notes, words) {
  for (const n of notes) {
    const m = checkText(n.text, words);
    if (m) return { ...m, label: n.label };
  }
  return null;
}

/* ======================= priority workflow ======================= */

const decisionWord = (d) => (d === 'KEEP' ? 'keep' : d === 'REMOVE' ? 'remove' : 'mixed instructions');

export function decide(data, words) {
  const versions = (data.versions || []).map((v) => ({ ...v, match: checkText(v.additionalInfo, words) }));
  const n = versions.length;
  const pref = (data.engagersPreference || '').trim();
  const declines = (data.declineNotes || []).filter((d) => d && d.trim());

  // Every note the doctor wrote, newest first, so the popup can show (and translate) the real text.
  const notes = [];
  for (const v of [...versions].reverse()) {
    if (v.additionalInfo && v.additionalInfo.trim()) notes.push({ label: `Version ${v.versionIndex} Request`, text: v.additionalInfo });
  }
  if (pref) notes.push({ label: 'Doctor Preference Profile', text: pref });
  declines.forEach((d) => notes.push({ label: 'Doctor Decline Note', text: d }));

  const latest = versions[n - 1];
  const steps = [
    { id: 1, title: latest ? `Latest Rx (Version ${latest.versionIndex})` : 'Latest Rx' },
    { id: 2, title: 'Earlier Rx versions' },
    { id: 3, title: 'Doctor preference profile' },
    { id: 4, title: 'Decline note' },
    { id: 5, title: 'System default' }
  ];
  let decision = null;
  const use = (step, d, detail) => { step.status = 'used'; step.detail = detail; decision = d; };
  const answered = () => decision !== null;
  const lowNote = (m) => (m.confidence === 'low' ? ' No engager word was next to it, so read the note.' : '');
  const foundIn = (v) => `Version ${v.versionIndex}: ${decisionWord(v.match.decision)}${v.match.word ? ` (matched "${v.match.word}")` : ''}.${lowNote(v.match)}`;
  const fromMatch = (m, source, text) => ({ decision: m.decision, word: m.word, source, text, confidence: m.confidence });

  // 1. Latest version
  if (!latest) {
    Object.assign(steps[0], { status: 'missing', detail: 'No Rx versions were found.' });
  } else if (latest.match) {
    use(steps[0], fromMatch(latest.match, `Version ${latest.versionIndex} Request`, latest.additionalInfo), foundIn(latest));
  } else {
    Object.assign(steps[0], { status: 'nomatch', detail: latest.additionalInfo && latest.additionalInfo.trim() ? 'It has a note, but no keep or remove instruction about engagers.' : 'It has no note.' });
  }

  // 2. Earlier versions, stepping backwards; stop at the first valid one
  if (answered()) {
    Object.assign(steps[1], { status: 'skipped', detail: 'Not needed.' });
  } else if (n <= 1) {
    Object.assign(steps[1], { status: 'missing', detail: 'There are no earlier versions.' });
  } else {
    let hit = null;
    for (let i = n - 2; i >= 0 && !hit; i--) if (versions[i].match) hit = versions[i];
    if (hit) use(steps[1], fromMatch(hit.match, `Version ${hit.versionIndex} Request`, hit.additionalInfo), foundIn(hit));
    else Object.assign(steps[1], { status: 'nomatch', detail: `Checked Version ${n - 1} down to Version 1: no keep or remove instruction.` });
  }

  // 3. Additional template preferences (doctor preference profile)
  if (answered()) {
    Object.assign(steps[2], { status: 'skipped', detail: 'Not needed.' });
  } else if (!pref) {
    Object.assign(steps[2], { status: 'missing', detail: 'No preference profile note.' });
  } else {
    const m = checkText(pref, words);
    if (m) use(steps[2], fromMatch(m, 'Doctor Preference Profile', pref), `${decisionWord(m.decision)}${m.word ? ` (matched "${m.word}")` : ''}.${lowNote(m)}`);
    else Object.assign(steps[2], { status: 'nomatch', detail: 'The profile has no keep or remove wording.' });
  }

  // 4. Decline: explicit "Declined / Action Required" state, needs manual review
  if (answered()) {
    Object.assign(steps[3], { status: 'skipped', detail: 'Not needed.' });
  } else if (declines.length) {
    const hint = firstMatch(declines.map((text) => ({ label: 'Doctor Decline Note', text })), words);
    use(steps[3], { decision: 'REVIEW', word: '', source: 'Declined / Action Required', text: declines.join('\n'), hint: hint ? { decision: hint.decision, word: hint.word } : null },
      'The case was declined. Review it manually before doing anything.');
  } else {
    Object.assign(steps[3], { status: 'missing', detail: 'No decline note.' });
  }

  // 5. System default
  if (answered()) {
    Object.assign(steps[4], { status: 'skipped', detail: 'Not needed.' });
  } else {
    use(steps[4], { decision: 'DEFAULT', word: '', source: 'System default (no instructions found)', text: 'Follow standard clinical guidelines for this case.' }, 'No instructions anywhere, so the system default applies.');
  }

  // Technician alerts come from the final version only.
  const finalVersion = latest ? { versionIndex: latest.versionIndex, text: latest.rawInfo ?? latest.additionalInfo ?? '' } : null;
  const alerts = words.alerts?.enabled && finalVersion
    ? { versionIndex: finalVersion.versionIndex, items: analyzeFinalRx(finalVersion.text, words) }
    : null;

  return { ...decision, versions, stlSummary: data.stlSummary, notes, trace: steps, finalRx: finalVersion, alerts };
}

/* ======================= tooth numbering -> FDI ======================= */
// Recognises FDI (11-48), Universal / US (1-32) and Palmer written as UR6, LL3, "upper right 6".
// Everything is reported as FDI.

const isFdi = (n) => n >= 11 && n <= 48 && n % 10 >= 1 && n % 10 <= 8;

export function universalToFdi(n) {
  if (n >= 1 && n <= 8) return 19 - n;       // upper right: 1 -> 18 ... 8 -> 11
  if (n >= 9 && n <= 16) return n + 12;      // upper left:  9 -> 21 ... 16 -> 28
  if (n >= 17 && n <= 24) return 55 - n;     // lower left: 17 -> 38 ... 24 -> 31
  if (n >= 25 && n <= 32) return n + 16;     // lower right: 25 -> 41 ... 32 -> 48
  return null;
}

const PALMER_QUADRANT = { ur: 1, ul: 2, ll: 3, lr: 4 };
const SKIP_AFTER = /^\s*(?:years?|yrs?|yo\b|old\b|mm|millimet\w*|weeks?|days?|months?|steps?|stages?|aligners?|sets?|times?|x\b|%|spaces?|gaps?|wires?|retainers?|attachments?|engagers?|cleats?|buttons?|teeth|units?|pieces?|pairs?)/;
const SKIP_BEFORE = /(?:age|aged|patient|version|v|step|stage|case|id|aligner|set|week|day|month|page|line|row|tray)\s*#?\s*$/;

function palmerTokens(seg) {
  const out = [];
  const add = (m, quadrant, digit) => out.push({ start: m.index, end: m.index + m[0].length, fdi: quadrant * 10 + Number(digit), from: m[0].trim().toUpperCase() });
  let re = /(?<![\w'])(ur|ul|ll|lr)\s*-?\s*([1-8])(?!\d)/g;
  let m;
  while ((m = re.exec(seg)) !== null) add(m, PALMER_QUADRANT[m[1]], m[2]);
  re = /(?<![\w'])([1-8])\s*-?\s*(ur|ul|ll|lr)(?![\w])/g;
  while ((m = re.exec(seg)) !== null) add(m, PALMER_QUADRANT[m[2]], m[1]);
  re = /\b(upper|lower)\s+(right|left)\s+(?:tooth\s+|#\s*)?([1-8])(?!\d)/g;
  while ((m = re.exec(seg)) !== null) {
    const quadrant = m[1] === 'upper' ? (m[2] === 'right' ? 1 : 2) : (m[2] === 'left' ? 3 : 4);
    add(m, quadrant, m[3]);
  }
  return out;
}

function numberCandidates(seg, skip = []) {
  const out = [];
  const re = /(?<![\d.])(#?)(\d{1,2})(?!\d)/g;
  let m;
  while ((m = re.exec(seg)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (seg[end] === '.' && /\d/.test(seg[end + 1] || '')) continue;                 // decimals such as 0.5
    if (/[\/:]/.test(seg[end] || '') || /[\/:]/.test(seg[start - 1] || '')) continue; // dates and times such as 5/12
    if (SKIP_AFTER.test(seg.slice(end))) continue;                                   // "2 mm", "3 spaces"
    if (SKIP_BEFORE.test(seg.slice(Math.max(0, start - 12), start))) continue;       // "version 2", "step 3"
    if (skip.some((s) => start < s.end && end > s.start)) continue;
    out.push({ n: Number(m[2]), start, end });
  }
  return out;
}

/** Decides which numbering a note uses: 'fdi' or 'universal'. `mode` may force it. */
export function detectNumbering(text, mode, interestingClauses = []) {
  if (mode === 'fdi' || mode === 'universal') return mode;
  const f = fold(text);
  if (/\b(?:universal|american)\b|\bu\.?s\.?a?\.?\s+(?:tooth\s+)?numbering/.test(f)) return 'universal';
  if (/\bfdi\b|\biso\b/.test(f)) return 'fdi';
  // A number that cannot be an FDI tooth (like 6, 9, 10, 19, 29) in a tooth sentence means Universal.
  for (const seg of interestingClauses) {
    const palmer = palmerTokens(seg);
    if (numberCandidates(seg, palmer).some(({ n }) => n >= 1 && n <= 32 && !isFdi(n))) return 'universal';
  }
  return 'fdi';
}

/** Teeth mentioned in one sentence, converted to FDI: [{ fdi, from, system }]. */
export function extractTeeth(seg, numbering) {
  const found = [];
  const palmer = palmerTokens(seg);
  palmer.forEach((p) => found.push({ pos: p.start, fdi: String(p.fdi), from: p.from, system: 'Palmer' }));

  const cands = numberCandidates(seg, palmer);
  cands.forEach((c, i) => {
    if (numbering === 'universal') {
      if (c.n < 1 || c.n > 32) return;
      found.push({ pos: c.start, fdi: String(universalToFdi(c.n)), from: String(c.n), system: 'Universal' });
      // "6-11" or "6 to 11": every tooth in between
      const prev = cands[i - 1];
      if (prev && /^\s*(?:-|to|through|thru)\s*$/.test(seg.slice(prev.end, c.start)) && prev.n < c.n && (prev.n <= 16) === (c.n <= 16)) {
        for (let k = prev.n + 1; k < c.n; k++) found.push({ pos: prev.end + (k - prev.n) / 100, fdi: String(universalToFdi(k)), from: String(k), system: 'Universal' });
      }
    } else if (isFdi(c.n)) {
      found.push({ pos: c.start, fdi: String(c.n), from: null, system: null });
    }
  });
  found.sort((a, b) => a.pos - b.pos);
  return uniqueTeeth(found.map(({ fdi, from, system }) => ({ fdi, from, system })));
}

function uniqueTeeth(list) {
  const seen = new Set();
  return list.filter((t) => (seen.has(t.fdi) ? false : (seen.add(t.fdi), true)));
}

/* ======================= final-Rx alerts for the cut technician ======================= */
// Looks for retainer / wire and space / diastema wording in ONE text (the final Rx)
// and turns each hit into a plain suggestion such as "Keep the retainer / wire".

export const ALERT_SUGGESTIONS = {
  retainer: {
    label: 'Retainer / wire',
    KEEP: 'Keep the retainer / wire.',
    REMOVE: 'Remove (cut) the retainer / wire.',
    NOTE: 'A retainer / wire is mentioned. Read the note to see what to do.',
    CHECK: 'The retainer / wire instructions are mixed. Read the note carefully.'
  },
  space: {
    label: 'Spaces / diastemas',
    OPEN: 'Open the space / diastema.',
    CLOSE: 'Close the space / diastema.',
    NOTE: 'A space / diastema is mentioned. Read the note to see what to do.',
    CHECK: 'The space instructions are mixed. Read the note carefully.'
  },
  custom: {
    label: 'Highlighted word',
    NOTE: 'One of your highlight words appears in the final Rx.',
    CHECK: 'Read the note carefully.'
  }
};

function mergeMarks(marks) {
  const rank = { term: 0, topic: 0, verb: 1, action: 1 };
  const sorted = [...marks].sort((a, b) => a.start - b.start || (rank[a.kind] ?? 2) - (rank[b.kind] ?? 2));
  const out = [];
  for (const m of sorted) {
    if (out.length && m.start < out[out.length - 1].end) continue; // drop overlaps
    out.push(m);
  }
  return out;
}

function analyzeClause(clause, fc, words, stop) {
  const cfg = words.alerts;
  const fuzzy = words.fuzzy !== false;
  const toks = tokensOf(fc);
  const items = [];
  const topics = [
    { id: 'retainer', words: cfg.retainerWords, actions: { KEEP: cfg.keepVerbs, REMOVE: cfg.removeVerbs } },
    { id: 'space', words: cfg.spaceWords, actions: { OPEN: cfg.openWords, CLOSE: cfg.closeWords } }
  ];

  for (const topic of topics) {
    const topicHits = wordHits(fc, toks, prep(topic.words), { prefix: true, fuzzy, stop });
    if (!topicHits.length) continue;

    const actionHits = [];
    for (const [name, list] of Object.entries(topic.actions)) {
      wordHits(fc, toks, prep(list), { fuzzy }).forEach((h) => {
        // "retainer" is a topic word, not a spelling mistake of the verb "retained".
        if (!(h.fuzzy && topicHits.some((t) => h.start < t.end && h.end > t.start))) actionHits.push({ ...h, name });
      });
    }

    // Each topic word is paired with the nearest action word BEFORE it ("keep the wire"),
    // or, if there is none, the nearest one after it ("spaces should be closed").
    const chosen = topicHits.map((t) => {
      const before = actionHits.filter((a) => a.start < t.start);
      const after = actionHits.filter((a) => a.start >= t.start);
      let best = null;
      if (before.length) best = before.reduce((a, b) => (b.start > a.start ? b : a));
      else if (after.length) best = after.reduce((a, b) => (b.start < a.start ? b : a));
      return { topic: t, action: best };
    });

    const resolved = chosen.map(({ action }) => {
      if (!action) return { name: 'NOTE', negated: false };
      const negated = NEGATION.test(fc.slice(Math.max(0, action.start - 30), action.start));
      return { name: negated ? INVERT[action.name] : action.name, negated };
    });
    const names = [...new Set(resolved.map((r) => r.name))];

    const marks = [];
    chosen.forEach(({ topic: t, action: a }) => {
      marks.push({ start: t.start, end: t.end, kind: 'topic' });
      if (a) marks.push({ start: a.start, end: a.end, kind: 'action' });
    });

    items.push({
      topic: topic.id,
      action: names.length === 1 ? names[0] : 'CHECK',
      negated: names.length === 1 && resolved.some((r) => r.negated),
      sentence: clause,
      marks: mergeMarks(marks),
      _fc: fc
    });
  }

  const extra = wordHits(fc, toks, prep(cfg.extraWords), { prefix: true, fuzzy });
  if (extra.length) {
    items.push({
      topic: 'custom', action: 'NOTE', negated: false, sentence: clause,
      marks: mergeMarks(extra.map((h) => ({ start: h.start, end: h.end, kind: 'topic' }))),
      _fc: fc
    });
  }
  return items;
}

// "Close space between 8 and 9, open the diastema 6-7" holds two instructions. Split at commas
// when each side has its own retainer / space word; pieces without one stay with the piece before.
function splitByTopic(clause, words) {
  if (!clause.includes(',')) return [clause];
  const cfg = words.alerts;
  const topicWords = prep([...(cfg.retainerWords || []), ...(cfg.spaceWords || [])]);
  const hasTopic = (t) => { const f = fold(t); return wordHits(f, tokensOf(f), topicWords, { prefix: true, fuzzy: words.fuzzy !== false }).length > 0; };
  const groups = [];
  for (const part of clause.split(',')) {
    const withTopic = hasTopic(part);
    const last = groups[groups.length - 1];
    if (!last || (withTopic && last.topic)) groups.push({ text: part, topic: withTopic });
    else { last.text += `,${part}`; last.topic = last.topic || withTopic; }
  }
  return groups.map((g) => g.text.trim()).filter(Boolean);
}

/** `words` is the engagers settings object (uses words.alerts, words.fuzzy, words.numbering). */
export function analyzeFinalRx(text, words) {
  const cfg = words?.alerts;
  if (!cfg || !text || !String(text).trim()) return [];

  // Words that are instructions themselves are never treated as a "spelling mistake" of a topic word.
  const stop = new Set([cfg.keepVerbs, cfg.removeVerbs, cfg.openWords, cfg.closeWords]
    .flatMap((l) => prep(l)).filter((w) => !w.f.includes(' ')).map((w) => w.f));

  const original = String(text).replace(/[\u2018\u2019]/g, "'");
  const clauses = original.split(/[\n.;!?]+/).map((c) => c.trim()).filter(Boolean);
  const items = [];
  for (const clause of clauses) {
    for (const part of splitByTopic(clause, words)) items.push(...analyzeClause(part, fold(part), words, stop));
  }

  const numbering = detectNumbering(text, words.numbering, clauses.map(fold));
  return items.map(({ _fc, ...item }) => ({ ...item, numbering, teeth: extractTeeth(_fc, numbering) }));
}

/* ======================= Engagers tab: 3-section priority ======================= */

const SECTION_TITLES = {
  rx: 'Rx instructions (Online Form)',
  pref: 'Additional treatment preferences notes',
  default: 'Engagers removal for revisions'
};

const explicit = (a) => !!a && (a.decision === 'KEEP' || a.decision === 'REMOVE' || a.decision === 'MIXED');

/** Plain "Yes" / "No" style value of the revisions row (no engager wording): No -> KEEP, Yes -> REMOVE. */
export function defaultFromYesNo(raw) {
  const t = String(raw || '').toLowerCase();
  if (!t.trim()) return '';
  if (/\b(no|not|don'?t|dont|never|keep|retain|maintain|leave|preserve)\b/.test(t)) return 'KEEP';
  if (/\b(yes|remove|removal|replace|delete|cancel|take off)\b/.test(t)) return 'REMOVE';
  return '';
}

/**
 * Combines the three sources into one decision (all texts already translated to English).
 *   input:  { rx, pref, defaultRaw }
 *   output: { decision: 'KEEP'|'REMOVE'|'CONFLICT'|'REVIEW', decidedBy: 'rx'|'pref'|'default'|null, reason, sections }
 *
 * Order of authority:
 *   1. Rx instructions                      (if it mentions engagers)
 *   2. Additional treatment preferences     (if it says keep / remove)
 *   3. Engagers removal for revisions       (final default: a plain Yes / No)
 *  ...except that when the "Engagers removal for revisions" value itself contains engager wording
 *  (e.g. "Don't remove engagers") it is promoted to 2nd place, above the preferences note.
 * KEEP and REMOVE together inside ONE source -> CONFLICT (never silently picked).
 */
export function resolveEngagerDecision({ rx = '', pref = '', defaultRaw = '' } = {}, words) {
  const aRx = analyzeEngagerText(rx, words);
  const aPref = analyzeEngagerText(pref, words);
  const aDef = analyzeEngagerText(defaultRaw, words);
  const defHasKeywords = explicit(aDef);
  const yesNo = defHasKeywords ? '' : defaultFromYesNo(defaultRaw);

  const order = defHasKeywords ? ['rx', 'default', 'pref'] : ['rx', 'pref', 'default'];
  const texts = { rx, pref, default: defaultRaw };
  const analyses = { rx: aRx, pref: aPref, default: aDef };

  const sections = order.map((id, i) => {
    const a = analyses[id];
    const isYesNo = id === 'default' && !defHasKeywords;
    const decision = isYesNo ? (yesNo || null) : (a?.decision || null);
    let label = `Priority ${i + 1} · ${SECTION_TITLES[id]}`;
    if (id === 'default') label += defHasKeywords ? ' (has engager wording)' : ' (final default)';
    return {
      id, priority: i + 1, label, text: String(texts[id] || ''),
      decision, kind: isYesNo ? 'yesno' : 'keywords',
      word: a?.word || '', negated: !!a?.negated, confidence: a?.confidence || null,
      marks: isYesNo ? [] : (a?.marks || []), teeth: a?.teeth || [],
      evidence: isYesNo
        ? (yesNo ? [{ yesno: true, term: SECTION_TITLES.default, action: String(defaultRaw).trim(), dictionaryWord: '', decision: yesNo, negated: false, sentence: '' }] : [])
        : (a?.evidence || []),
      decisive: false, note: ''
    };
  });

  let decision = 'REVIEW';
  let decidedBy = null;
  let reason = 'No instruction about engagers was found in the Rx, the notes or the revisions default.';

  for (const sec of sections) {
    if (!sec.decision) continue;
    decidedBy = sec.id;
    sec.decisive = true;
    if (sec.decision === 'MIXED') {
      decision = 'CONFLICT';
      reason = `${SECTION_TITLES[sec.id]} contains both KEEP and REMOVE wording for engagers.`;
    } else {
      decision = sec.decision;
      reason = `${SECTION_TITLES[sec.id]} says ${decision}${sec.word ? ` ("${sec.word}")` : ''}${sec.negated ? ' (reversed by a negation)' : ''}.`;
    }
    break;
  }

  // Notes on the sources that were not used.
  const decidedIdx = sections.findIndex((x) => x.decisive);
  sections.forEach((sec, i) => {
    if (sec.decisive || decidedIdx === -1 || i < decidedIdx) return;
    if (sec.decision && sec.decision !== 'MIXED' && sec.decision !== decision) sec.note = `Says ${sec.decision}, but a higher-priority source decided.`;
  });

  return { decision, decidedBy, reason, sections };
}
