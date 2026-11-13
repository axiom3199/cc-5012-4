// Lyrics document model and the timing table that is intentionally kept
// separate from the text layout.
//
// Document: { words: [{ id, text, line, index }] }
// Timings:  { [wordId]: { start, end, chars: [{start, end}] | null } }
//
// The same word text appearing more than once (repeated chorus, repeated
// syllables such as na-na) produces separate instances with separate ids and
// therefore separate timings. Timing is never derived from word text.

import { graphemes } from './gcs.js';

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
export function buildDocument(rawText, { splitCJK = false } = {}) {
  const lines = rawText.split(/\r?\n/);
  const words = [];
  lines.forEach((line, lineIdx) => {
    for (const text of splitLine(line, splitCJK)) {
      words.push({ id: newId(), text, line: lineIdx, index: words.length });
    }
  });
  return { words };
}

// Rebuild after a text/layout edit while preserving confirmed timings.
// Matching uses a longest-common-subsequence over word strings in document
// order, so identical repeated words are matched as distinct instances rather
// than sharing one timing record.
export function rebuildDocument(prevDoc, prevTimings, rawText, opts = {}) {
  const nextDoc = buildDocument(rawText, opts);
  if (!prevDoc) return { doc: nextDoc, timings: {} };

  const a = prevDoc.words;
  const b = nextDoc.words;
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
  return { doc: nextDoc, timings };
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
export function stateAt(doc, timings, t) {
  let activeId = null;
  let activeCharIndex = -1;
  let nextStart = null;

  for (const w of doc.words) {
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

export function serializeProject({ rawText, splitCJK, font, timings, audioName }) {
  return JSON.stringify({
    version: 1,
    rawText,
    splitCJK,
    font: font || null,
    audioName: audioName || null,
    timings,
  }, null, 2);
}

export function parseProject(json) {
  const data = JSON.parse(json);
  if (!data || typeof data !== 'object' || !('timings' in data)) {
    throw new Error('无效的工程文件：缺少 timings 字段');
  }
  return {
    rawText: String(data.rawText ?? ''),
    splitCJK: Boolean(data.splitCJK),
    font: data.font || null,
    audioName: data.audioName || null,
    timings: data.timings || {},
  };
}
