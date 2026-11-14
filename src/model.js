// Lyrics document model and the timing table that is intentionally kept
// separate from the text layout.
//
// Document: { words: [{ id, text, line, index, part }] }
// Timings:  { [wordId]: { start, end, chars: [{start, end}] | null } }
//
// The same word text appearing more than once (repeated chorus, repeated
// syllables such as na-na) produces separate instances with separate ids and
// therefore separate timings. Timing is never derived from word text.
//
// A word belongs to exactly one voice part (声部). Two parts may sing at the
// same time: their words keep independent instances, timings and colors and
// are never flattened into a single-threaded subtitle stream.

import { graphemes } from './gcs.js';

export const PART_A = 'A';
export const PART_B = 'B';

export const PART_COLORS = {
  // Warm palette for the lead part, cool palette for the answering part.
  [PART_A]: {
    id: PART_A, name: '声部 A',
    highlight: '#ffd32a', highlightStroke: '#ff9f1a',
    activeText: '#d63031', badge: '#e17055',
  },
  [PART_B]: {
    id: PART_B, name: '声部 B',
    highlight: '#74b9ff', highlightStroke: '#0984e3',
    activeText: '#0984e3', badge: '#6c5ce7',
  },
};

export function defaultParts() {
  return [
    { id: PART_A, name: PART_COLORS[PART_A].name, color: PART_COLORS[PART_A].highlight },
    { id: PART_B, name: PART_COLORS[PART_B].name, color: PART_COLORS[PART_B].highlight },
  ];
}

let idCounter = 0;
export function newId(prefix = 'w') {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}_${idCounter}`;
}

// Split a single lyric line into word strings.
// When splitCJK is true, CJK ideographs become standalone words while Latin
// runs and emoji clusters keep their natural boundaries.
export function splitLine(line, splitCJK = false) {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (!splitCJK) return trimmed.split(/\s+/).filter(Boolean);

  const words = [];
  let buf = '';
  const flush = () => { if (buf) { words.push(buf); buf = ''; } };
  for (const cluster of graphemes(trimmed)) {
    const cp = cluster.codePointAt(0);
    const isSpace = /\s/.test(cluster);
    const isCJK = (cp >= 0x3400 && cp <= 0x4dbf) ||
                   (cp >= 0x4e00 && cp <= 0x9fff) ||
                   (cp >= 0xf900 && cp <= 0xfaff);
    if (isSpace) { flush(); continue; }
    if (isCJK) { flush(); words.push(cluster); continue; }
    buf += cluster;
  }
  flush();
  return words;
}

// Build a document from raw multi-line lyric text.
// opts.part assigns every resulting word to one voice part.
export function buildDocument(rawText, { splitCJK = false, part = PART_A } = {}) {
  const lines = rawText.split(/\r?\n/);
  const words = [];
  lines.forEach((line, lineIdx) => {
    for (const text of splitLine(line, splitCJK)) {
      words.push({ id: newId(), text, line: lineIdx, index: words.length, part });
    }
  });
  return { words };
}

// Assemble one document from per-part raw lyric texts. Each part's lines are
// numbered independently; the resulting word ids remain globally unique.
export function buildMultiPartDocument(partTexts, { splitCJK = false, parts = [PART_A, PART_B] } = {}) {
  const words = [];
  parts.forEach(pid => {
    const partDoc = buildDocument(partTexts[pid] ?? '', { splitCJK, part: pid });
    for (const w of partDoc.words) words.push(w);
  });
  words.forEach((w, i) => { w.index = i; });
  return { words };
}

// Words of one part, in document order.
export function wordsOfPart(doc, part) {
  return doc.words.filter(w => w.part === part);
}

// Move a set of word instances to another part. Each keeps its id and
// therefore its confirmed timing — part switching only changes display and
// highlight ownership, never the underlying time data.
export function assignWordsToPart(doc, ids, part) {
  const idSet = new Set(ids);
  for (const w of doc.words) {
    if (idSet.has(w.id)) w.part = part;
  }
}

// Rebuild one part after a text/layout edit while preserving confirmed
// timings. Matching uses a longest-common-subsequence over word strings in
// document order, so identical repeated words are matched as distinct
// instances rather than sharing one timing record. Words of other parts are
// untouched and keep both their place and their timings.
export function rebuildPartDocument(prevDoc, prevTimings, part, rawText, opts = {}) {
  const nextPartDoc = buildDocument(rawText, { ...opts, part });
  if (!prevDoc) return { doc: nextPartDoc, timings: {} };

  const a = prevDoc.words.filter(w => w.part === part);
  const b = nextPartDoc.words;
  const others = prevDoc.words.filter(w => w.part !== part);
  const { timings } = lcsRemap(a, b, prevTimings);
  // Preserve every surviving timing record: untouched parts keep theirs,
  // rebuilt part contributes the LCS-remapped subset.
  const liveIds = new Set([...others.map(w => w.id), ...b.map(w => w.id)]);
  for (const [id, rec] of Object.entries(prevTimings)) {
    if (liveIds.has(id) && !(id in timings)) timings[id] = rec;
  }
  const merged = { words: [...others, ...b] };
  reindex(merged);
  return { doc: merged, timings };
}

// Whole-document rebuild used by single-part projects and the first boot.
export function rebuildDocument(prevDoc, prevTimings, rawText, opts = {}) {
  const part = opts.part || PART_A;
  const nextDoc = buildDocument(rawText, { ...opts, part });
  if (!prevDoc) return { doc: nextDoc, timings: {} };
  return lcsRemap(prevDoc.words, nextDoc.words, prevTimings, nextDoc);
}

function reindex(doc) {
  doc.words.forEach((w, i) => { w.index = i; });
}

function lcsRemap(a, b, prevTimings, prebuiltDoc = null) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i].text === b[j].text
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const timings = {};
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i].text === b[j].text) {
      if (prevTimings[a[i].id]) timings[b[j].id] = prevTimings[a[i].id];
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  const doc = prebuiltDoc || { words: b };
  reindex(doc);
  return { doc, timings };
}

// Timing-state helpers. A word without a start/end pair is explicitly
// pending. We never fabricate timings by averaging character counts.
export function isPending(t) {
  return !t || typeof t.start !== 'number' || typeof t.end !== 'number';
}
export function isConfirmed(t) {
  return !isPending(t);
}
export function pendingIds(doc, timings) {
  return doc.words.filter(w => isPending(timings[w.id])).map(w => w.id);
}
export function confirmedCount(doc, timings) {
  return doc.words.reduce((n, w) => n + (isConfirmed(timings[w.id]) ? 1 : 0), 0);
}

// Resolve the highlight state of every word at playback time t.
// Returns { activeId, activeCharIndex, nextStart }.
// When part is given, only words of that part are considered, so two parts
// can each hold an active word at the same instant.
export function stateAt(doc, timings, t, part = null) {
  let activeId = null;
  let activeCharIndex = -1;
  let nextStart = null;

  for (const w of doc.words) {
    if (part !== null && w.part !== part) continue;
    const rec = timings[w.id];
    if (isPending(rec)) continue;
    if (t >= rec.start && t < rec.end) {
      activeId = w.id;
      activeCharIndex = -1;
      if (Array.isArray(rec.chars) && rec.chars.length) {
        const idx = rec.chars.findIndex(c => t >= c.start && t < c.end);
        if (idx >= 0) activeCharIndex = idx;
      }
      break;
    }
    if (rec.start > t && (nextStart === null || rec.start < nextStart)) {
      nextStart = rec.start;
    }
  }
  return { activeId, activeCharIndex, nextStart };
}

// Resolve every part at once. Each entry is an independent stateAt result;
// simultaneous singing therefore yields multiple non-null activeId values
// rather than one winner overwriting the other.
export function stateForParts(doc, timings, t, parts) {
  const out = {};
  for (const pid of parts) {
    out[pid] = stateAt(doc, timings, t, pid);
  }
  return out;
}

// Timing overlap diagnostics.
//
// Overlap *within* one part is an authoring error: a single voice cannot sing
// two words at once. Overlap *across* parts is the normal duet/round case and
// is reported as information only — it must never block or be flattened away.
export function findOverlaps(doc, timings, parts = [PART_A, PART_B]) {
  const byPart = new Map(parts.map(p => [p, []]));
  for (const w of doc.words) {
    const rec = timings[w.id];
    if (isPending(rec)) continue;
    if (!byPart.has(w.part)) byPart.set(w.part, []);
    byPart.get(w.part).push({ id: w.id, text: w.text, part: w.part, start: rec.start, end: rec.end });
  }

  const intra = [];
  const cross = [];
  for (const list of byPart.values()) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (cur.start < prev.end) {
        intra.push({
          type: 'intra-part',
          part: cur.part,
          a: { id: prev.id, text: prev.text },
          b: { id: cur.id, text: cur.text },
          start: cur.start,
          end: Math.min(prev.end, cur.end),
        });
      }
    }
  }

  const partLists = parts.map(p => (byPart.get(p) || []).slice()).filter(l => l.length);
  for (let x = 0; x < partLists.length; x++) {
    for (let y = x + 1; y < partLists.length; y++) {
      for (const a of partLists[x]) {
        for (const b of partLists[y]) {
          if (a.start < b.end && b.start < a.end) {
            cross.push({
              type: 'cross-part',
              parts: [a.part, b.part],
              a: { id: a.id, text: a.text, part: a.part },
              b: { id: b.id, text: b.text, part: b.part },
              start: Math.max(a.start, b.start),
              end: Math.min(a.end, b.end),
            });
          }
        }
      }
    }
  }
  return { intra, cross };
}

export function serializeProject({
  version = 2, rawText, splitCJK, font, timings, audioName,
  parts = null, partTexts = null, layoutVersion = 1,
}) {
  return JSON.stringify({
    version,
    rawText,
    splitCJK,
    font: font || null,
    audioName: audioName || null,
    timings,
    parts,
    partTexts,
    layoutVersion,
  }, null, 2);
}

// Returns { project, migrated }. A version-1 (single-voice) project is loaded
// automatically as a one-part document; its timings are keyed by the same
// word ids and therefore survive untouched.
export function parseProject(json) {
  const data = JSON.parse(json);
  if (!data || typeof data !== 'object' || !('timings' in data)) {
    throw new Error('无效的工程文件：缺少 timings 字段');
  }
  const base = {
    rawText: String(data.rawText ?? ''),
    splitCJK: Boolean(data.splitCJK),
    font: data.font || null,
    audioName: data.audioName || null,
    timings: data.timings || {},
    layoutVersion: Number(data.layoutVersion) || 1,
  };
  if (data.version === 2 && (data.parts || data.partTexts)) {
    return {
      project: {
        ...base,
        parts: data.parts || defaultParts(),
        partTexts: data.partTexts || {},
      },
      migrated: false,
    };
  }
  // v1 (or unversioned): every word belongs to part A, part B starts empty.
  return {
    project: {
      ...base,
      parts: defaultParts(),
      partTexts: { [PART_A]: base.rawText, [PART_B]: '' },
    },
    migrated: true,
  };
}
