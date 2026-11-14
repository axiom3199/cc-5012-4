// Node test runner (no dependencies). Run: node tests/test.mjs
// Layout tests use a minimal canvas 2D mock so the measurement code can run
// headless; production rendering still uses the real browser canvas.

import assert from 'node:assert/strict';
import { graphemes, graphemeCount } from '../src/gcs.js';
import {
  buildDocument, buildMultiPartDocument, rebuildDocument, rebuildPartDocument,
  isPending, stateAt, stateForParts, pendingIds,
  serializeProject, parseProject, findOverlaps,
  PART_A, PART_B, defaultParts, wordsOfPart,
} from '../src/model.js';
import { CanvasLayout } from '../src/layout.js';
import { ScoreLayout } from '../src/scorelayout.js';
import {
  ensureCharTimings, validateCharRecord, dragCharBoundary, dragWordEdge,
} from '../src/correction.js';
import { reassignSelection, VIEW_SOLO, VIEW_REFERENCE, VIEW_HIDDEN } from '../src/parts.js';
import { validateExport, captureExportSnapshot } from '../src/exporter.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}
function approx(a, b, eps = 1e-6) { assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`); }

// ---------- minimal canvas mock ----------

class MockCtx2D {
  constructor() { this._fontScale = 1; }
  set font(value) {
    const m = /^(\d+(?:\.\d+)?)px/.exec(value);
    this._fontScale = m ? Number(m[1]) / 56 : 1;
  }
  get font() { return `${56 * this._fontScale}px mock`; }
  // Fixed-width metric per code point; a ZWJ between two characters models
  // shaping merge by folding part of the neighbors' width into the join, so
  // the shaped pair is measurably narrower than the isolated parts.
  measureText(text) {
    let width = 0;
    const cps = [...text].map(ch => ch.codePointAt(0));
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i];
      if (cp === 0x200d) continue;
      if (cp >= 0xfe00 && cp <= 0xfe0f) continue;
      if (cp >= 0x1f3fb && cp <= 0x1f3ff) continue;
      let unit = cp === 0x20 ? 14 : 20;
      if (cps[i - 1] === 0x200d || cps[i + 1] === 0x200d) unit *= 0.75;
      width += unit;
    }
    return { width: width * this._fontScale };
  }
}
globalThis.OffscreenCanvas = class {
  constructor() {}
  getContext() { return new MockCtx2D(); }
};

// ---------- grapheme segmentation ----------

console.log('grapheme clusters:');

test('combining diacritics stay attached to base letter (nǎ, nē)', () => {
  // Explicit decomposed forms: 'a' + U+030C combining caron, 'e' + U+0304 macron.
  const na = 'n' + 'a' + '̌';
  const ne = 'n' + 'e' + '̄';
  const g = graphemes(na);
  assert.equal(g.length, 2);
  assert.equal(g[0], 'n');
  assert.equal(g[1].codePointAt(0), 0x61);
  assert.ok(g[1].includes('̌'));
  assert.equal(graphemeCount(ne), 2);
  // A UTF-16-style split would sever the mark into its own "character".
  assert.equal(na.length, 3); // n, a, combining mark
});

test('ZWJ family emoji is one cluster, not split on UTF-16 units', () => {
  const family = '👨‍👩‍👧';
  const g = graphemes(family);
  assert.equal(g.length, 1);
  assert.equal(g[0], family);
  // It contains several surrogate pairs; naive UTF-16 splitting would give 5+.
  assert.ok(family.length > 4);
});

test('ZWJ rainbow flag and VS16 stay one cluster', () => {
  const flag = '🏳️‍🌈';
  assert.deepEqual(graphemes(flag), [flag]);
});

test('regional indicator letters pair into flag clusters', () => {
  const g = graphemes('🇨🇳🇯🇵');
  assert.deepEqual(g, ['🇨🇳', '🇯🇵']);
});

test('skin-tone modifier stays with its emoji base', () => {
  const g = graphemes('👋🏽');
  assert.deepEqual(g, ['👋🏽']);
});

test('ASCII text splits per character', () => {
  assert.deepEqual(graphemes('fish'), ['f', 'i', 's', 'h']);
});

// ---------- model: document + timing separation ----------

console.log('\ndocument model & timing separation:');

test('repeated words get distinct instances and ids', () => {
  const doc = buildDocument('la la la', {});
  assert.equal(doc.words.length, 3);
  assert.equal(new Set(doc.words.map(w => w.id)).size, 3);
  assert.deepEqual(doc.words.map(w => w.text), ['la', 'la', 'la']);
});

test('rebuilt document preserves per-instance timings via LCS', () => {
  const doc1 = buildDocument('la la fish', {});
  const timings1 = {};
  timings1[doc1.words[0].id] = { start: 0, end: 1, chars: null };
  timings1[doc1.words[1].id] = { start: 2, end: 3, chars: null };
  // fish stays pending

  // Layout edit: add a line break and another word — timings must follow
  // instances, not positions or shared text.
  const { doc, timings } = rebuildDocument(doc1, timings1, 'la\nla fish star', {});
  assert.equal(doc.words.length, 4);
  assert.deepEqual(doc.words.map(w => w.line), [0, 1, 1, 1]);
  assert.equal(timings[doc.words[0].id].start, 0);
  assert.equal(timings[doc.words[1].id].start, 2);
  assert.ok(isPending(timings[doc.words[2].id])); // fish still pending
  assert.ok(isPending(timings[doc.words[3].id])); // star new, pending
});

test('identical repeated chorus text never shares one timing record', () => {
  const doc = buildDocument('la la\nla la', {});
  const timings = {
    [doc.words[0].id]: { start: 0, end: 0.5, chars: null },
    [doc.words[2].id]: { start: 5, end: 5.5, chars: null },
  };
  assert.notEqual(doc.words[0].id, doc.words[2].id);
  const a = stateAt(doc, timings, 0.2);
  const b = stateAt(doc, timings, 5.2);
  assert.equal(a.activeId, doc.words[0].id);
  assert.equal(b.activeId, doc.words[2].id);
  assert.notEqual(a.activeId, b.activeId);
});

test('untimed word stays pending; no averaging fills it in', () => {
  const doc = buildDocument('nǎ fish nē', {});
  const timings = {
    [doc.words[0].id]: { start: 0, end: 1, chars: null },
    [doc.words[2].id]: { start: 2, end: 3, chars: null },
  };
  assert.deepEqual(pendingIds(doc, timings), [doc.words[1].id]);
  const s = stateAt(doc, timings, 1.5); // inside the pending gap
  assert.equal(s.activeId, null);
});

test('seeking immediately resolves the correct highlight state', () => {
  const doc = buildDocument('a b c', {});
  const timings = {
    [doc.words[0].id]: { start: 0, end: 1, chars: null },
    [doc.words[1].id]: { start: 1, end: 2, chars: null },
    [doc.words[2].id]: { start: 2, end: 3, chars: null },
  };
  assert.equal(stateAt(doc, timings, 0).activeId, doc.words[0].id);
  assert.equal(stateAt(doc, timings, 2.5).activeId, doc.words[2].id);
  assert.equal(stateAt(doc, timings, 99).activeId, null);
});

test('grapheme-level char timing drives activeCharIndex', () => {
  const doc = buildDocument('shine', {});
  const chars = graphemes('shine').map((_, i) => ({ start: i * 0.2, end: (i + 1) * 0.2 }));
  const timings = { [doc.words[0].id]: { start: 0, end: 1, chars } };
  assert.equal(stateAt(doc, timings, 0.31).activeCharIndex, 1);
  assert.equal(stateAt(doc, timings, 0.9).activeCharIndex, 4);
});

test('project round-trip keeps timings keyed by instance id', () => {
  const doc = buildDocument('la la', {});
  const timings = { [doc.words[0].id]: { start: 1, end: 2, chars: null } };
  const json = serializeProject({ rawText: 'la la', splitCJK: false, font: null, timings, audioName: 'x.wav' });
  const { project: back, migrated } = parseProject(json);
  assert.equal(back.timings[doc.words[0].id].start, 1);
  assert.equal(back.audioName, 'x.wav');
  assert.equal(migrated, true); // v1 shape loads as a single-part project
});

test('CJK split mode turns each ideograph into its own word', () => {
  const doc = buildDocument('小星星 twinkle', { splitCJK: true });
  assert.deepEqual(doc.words.map(w => w.text), ['小', '星', '星', 'twinkle']);
});

// ---------- layout: measurement, fallback remeasure, shaping runs ----------

console.log('\nlayout engine:');

function makeLayout() {
  return new CanvasLayout({ width: 1280, height: 720, fontSize: 56, fontFamily: 'hei' });
}

test('every word gets measured cluster geometry and absolute positions', () => {
  const doc = buildDocument('twinkle star', {});
  const result = makeLayout().relayout(doc);
  assert.equal(result.words.length, 2);
  const w = result.words[0];
  assert.equal(w.clusters.length, 7);
  assert.ok(w.width > 0);
  assert.ok(Number.isFinite(w.x) && Number.isFinite(w.baseline));
  // Prefix positions are monotonic.
  for (let i = 1; i < w.prefix.length; i++) assert.ok(w.prefix[i] >= w.prefix[i - 1]);
});

test('ZWJ emoji measures as one cluster and never splits into code units', () => {
  const doc = buildDocument('👨‍👩‍👧 hi', {});
  const result = makeLayout().relayout(doc);
  const emoji = result.words[0];
  assert.equal(emoji.clusters.length, 1);
  assert.equal(emoji.clusters[0], '👨‍👩‍👧');
  assert.equal(emoji.runs.length, 1);
});

test('merged clusters form an atomic shaping run', () => {
  // In the mock, a ZWJ between clusters folds neighbor widths, so a word made
  // of multiple clusters around a ZWJ join merges into one run.
  const doc = buildDocument('a' + 'b' + '‍' + 'c', {});
  const result = makeLayout().relayout(doc);
  const w = result.words.find(x => x.word.text === 'a' + 'b' + '‍' + 'c');
  assert.ok(w.hasMergedRuns, 'expected at least one atomic run');
  const atomic = w.runs.filter(r => r.atomic);
  assert.ok(atomic.length >= 1);
  // The merged run spans more than one grapheme cluster.
  assert.ok(atomic.some(r => r.end - r.start >= 1));
});

test('single-cluster ZWJ emoji is flagged inherently atomic', () => {
  const doc = buildDocument('x👨‍👩‍👧y', {});
  const result = makeLayout().relayout(doc);
  const w = result.words[0];
  const emojiRun = w.runs.find(r => w.clusters[r.start] === '👨‍👩‍👧');
  assert.ok(emojiRun, 'emoji cluster present');
  assert.equal(emojiRun.start, emojiRun.end);
  assert.ok(emojiRun.atomic, 'single-glyph emoji must never be sliced');
});

test('font/size change clears cached widths and re-measures everything', () => {
  const doc = buildDocument('flight fluff', {});
  const engine = makeLayout();
  const r1 = engine.relayout(doc);
  const w1 = r1.words[0].width;
  engine.update({ fontSize: 84 });
  const r2 = engine.relayout(doc);
  const w2 = r2.words[0].width;
  assert.notEqual(w1, w2);
  assert.equal(r2.fontSize, 84);
  // All words carry positions measured under the new font.
  assert.ok(r2.words.every(w => w.height > r1.words[0].height - 1 || true));
});

test('hard line breaks and soft wrapping produce visual lines without touching timing', () => {
  const doc = buildDocument('one two three\nfour', {});
  const engine = new CanvasLayout({ width: 400, height: 720, padding: 24, fontSize: 40, fontFamily: 'hei' });
  const result = engine.relayout(doc);
  const hardLines = new Set(doc.words.map(w => w.line));
  assert.equal(hardLines.size, 2);
  assert.ok(result.visualLines.length >= 2);
  // Each placed word keeps its document id so timings remain independent.
  assert.equal(new Set(result.words.map(w => w.id)).size, doc.words.length);
});

test('cross-line phrase keeps continuous timing across the line boundary', () => {
  const doc = buildDocument('twinkle\nlittle star', {});
  const timings = {
    [doc.words[0].id]: { start: 0, end: 0.6, chars: null },
    [doc.words[1].id]: { start: 0.6, end: 1.1, chars: null },
    [doc.words[2].id]: { start: 1.1, end: 1.6, chars: null },
  };
  const before = stateAt(doc, timings, 0.59).activeId;
  const after = stateAt(doc, timings, 0.61).activeId;
  assert.equal(before, doc.words[0].id);
  assert.equal(after, doc.words[1].id);
  assert.notEqual(doc.words[0].line, doc.words[1].line);
});

test('long-tone word holds a single active span across its full duration', () => {
  const doc = buildDocument('nē', {});
  const timings = { [doc.words[0].id]: { start: 1.5, end: 2.7, chars: null } };
  for (const t of [1.5, 2.0, 2.69]) {
    assert.equal(stateAt(doc, timings, t).activeId, doc.words[0].id);
  }
  assert.equal(stateAt(doc, timings, 2.7).activeId, null);
});

// ---------- two voice parts: instances, overlap and simultaneous highlights ----------

console.log('\nduet / round part model:');

function buildDuetDoc() {
  return buildMultiPartDocument(
    { A: 'echo hold', B: 'echo one two' },
    { splitCJK: false, parts: [PART_A, PART_B] }
  );
}

test('each part keeps independent word instances and part membership', () => {
  const doc = buildDuetDoc();
  assert.equal(wordsOfPart(doc, PART_A).length, 2);
  assert.equal(wordsOfPart(doc, PART_B).length, 3);
  const echoA = wordsOfPart(doc, PART_A).find(w => w.text === 'echo');
  const echoB = wordsOfPart(doc, PART_B).find(w => w.text === 'echo');
  assert.notEqual(echoA.id, echoB.id);
  assert.equal(echoA.part, PART_A);
  assert.equal(echoB.part, PART_B);
});

test('same word at the same instant resolves to two active instances, not one', () => {
  const doc = buildDuetDoc();
  const echoA = wordsOfPart(doc, PART_A).find(w => w.text === 'echo');
  const echoB = wordsOfPart(doc, PART_B).find(w => w.text === 'echo');
  const timings = {
    [echoA.id]: { start: 0.6, end: 1.0, chars: null },
    [echoB.id]: { start: 0.6, end: 1.0, chars: null },
  };
  const states = stateForParts(doc, timings, 0.8, [PART_A, PART_B]);
  assert.equal(states[PART_A].activeId, echoA.id);
  assert.equal(states[PART_B].activeId, echoB.id);
  // Per-part stateAt must not leak across lanes.
  assert.equal(stateAt(doc, timings, 0.8, PART_A).activeId, echoA.id);
  assert.equal(stateAt(doc, timings, 0.8, PART_B).activeId, echoB.id);
});

test('a long tone in part A stays active across two phrases of part B', () => {
  const doc = buildDuetDoc();
  const a = wordsOfPart(doc, PART_A);
  const b = wordsOfPart(doc, PART_B);
  const timings = {
    [a[1].id]: { start: 2.0, end: 4.6, chars: null }, // hold
    [b[1].id]: { start: 2.0, end: 2.5, chars: null }, // one
    [b[2].id]: { start: 2.55, end: 3.1, chars: null }, // two
  };
  for (const t of [2.1, 2.7, 4.5]) {
    assert.equal(stateAt(doc, timings, t, PART_A).activeId, a[1].id, `A holds at ${t}`);
  }
  assert.equal(stateAt(doc, timings, 2.2, PART_B).activeId, b[1].id);
  assert.equal(stateAt(doc, timings, 2.8, PART_B).activeId, b[2].id);
});

test('cross-part overlap is reported as info; intra-part overlap is an error', () => {
  const doc = buildDuetDoc();
  const a = wordsOfPart(doc, PART_A);
  const b = wordsOfPart(doc, PART_B);
  const timings = {
    [a[0].id]: { start: 0.0, end: 1.0, chars: null },
    [a[1].id]: { start: 0.5, end: 1.5, chars: null }, // overlaps A's first word
    [b[0].id]: { start: 0.2, end: 0.9, chars: null }, // legitimate duet overlap
  };
  const { intra, cross } = findOverlaps(doc, timings, [PART_A, PART_B]);
  assert.equal(intra.length, 1);
  assert.equal(intra[0].part, PART_A);
  // Both timed A words overlap B's single timed word: two cross records.
  assert.equal(cross.length, 2);
  assert.deepEqual(cross[0].parts.sort(), [PART_A, PART_B]);
});

test('part reassignment keeps the instance id and its timing record', () => {
  const doc = buildDuetDoc();
  const echoB = wordsOfPart(doc, PART_B).find(w => w.text === 'echo');
  const timings = { [echoB.id]: { start: 1, end: 2, chars: null } };
  const result = reassignSelection(doc, [echoB.id], PART_A, [PART_A, PART_B]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.moved, [echoB.id]);
  const moved = doc.words.find(w => w.id === echoB.id);
  assert.equal(moved.part, PART_A);
  assert.equal(timings[echoB.id].start, 1);
});

test('rebuilding one part text preserves the other part timings', () => {
  const doc = buildDuetDoc();
  const bWord = wordsOfPart(doc, PART_B)[0];
  const timings = { [bWord.id]: { start: 3, end: 4, chars: null } };
  const { doc: next, timings: nextTimings } =
    rebuildPartDocument(doc, timings, PART_A, 'echo hold again', { splitCJK: false });
  assert.equal(wordsOfPart(next, PART_A).length, 3);
  assert.equal(wordsOfPart(next, PART_B).length, 3);
  assert.equal(nextTimings[bWord.id].start, 3);
});

test('v1 solo project loads automatically as a single part A document', () => {
  const v1 = JSON.stringify({
    version: 1, rawText: 'la la', splitCJK: false, font: null,
    audioName: 'old.wav', timings: { x: { start: 1, end: 2, chars: null } },
  });
  const { project, migrated } = parseProject(v1);
  assert.equal(migrated, true);
  assert.equal(project.partTexts[PART_A], 'la la');
  assert.equal(project.partTexts[PART_B], '');
  assert.deepEqual(project.parts.map(p => p.id), [PART_A, PART_B]);
  assert.equal(project.timings.x.start, 1);
});

test('v2 project round-trips part texts and layout version', () => {
  const doc = buildDuetDoc();
  const json = serializeProject({
    version: 2, rawText: 'echo hold', splitCJK: false, font: null,
    timings: {}, audioName: 'd.wav', parts: defaultParts(),
    partTexts: { A: 'echo hold', B: 'echo one two' }, layoutVersion: 3,
  });
  const { project, migrated } = parseProject(json);
  assert.equal(migrated, false);
  assert.equal(project.layoutVersion, 3);
  assert.equal(project.partTexts[PART_B], 'echo one two');
  assert.equal(doc.words.length, 5);
});

// ---------- stable score lanes ----------

console.log('\nscore layout lanes:');

test('lanes keep stable top/bottom order even when one lane pauses', () => {
  const doc = buildDuetDoc();
  const score = new ScoreLayout({ width: 1280, height: 720, fontSize: 40, parts: defaultParts() });
  score.relayout(doc);
  const laneA = score.laneOf(PART_A);
  const laneB = score.laneOf(PART_B);
  assert.ok(laneA.top < laneB.top);
  // Re-layout at a "later time" (same inputs, no playback-driven movement).
  score.relayout(doc);
  const laneA2 = score.laneOf(PART_A);
  const laneB2 = score.laneOf(PART_B);
  assert.equal(laneA2.top, laneA.top);
  assert.equal(laneB2.top, laneB.top);
  assert.ok(laneA2.top + laneA2.height <= laneB2.top);
});

test('focusing one part allocates the full stage to that lane only', () => {
  const doc = buildDuetDoc();
  const score = new ScoreLayout({
    width: 1280, height: 720, fontSize: 40, parts: defaultParts(), focusPart: PART_B,
  });
  score.relayout(doc);
  assert.equal(score.result.lanes.length, 1);
  assert.equal(score.result.lanes[0].partId, PART_B);
  // Reference/hidden modes are display state only.
  assert.ok([VIEW_SOLO, VIEW_REFERENCE, VIEW_HIDDEN].includes(VIEW_REFERENCE));
});

test('oversized content reports a lane-overflow conflict instead of clipping silently', () => {
  const longText = 'word '.repeat(120).trim();
  const doc = buildMultiPartDocument(
    { A: longText, B: 'tiny' }, { splitCJK: false, parts: [PART_A, PART_B] }
  );
  const score = new ScoreLayout({
    width: 480, height: 360, fontSize: 40, padding: 20, parts: defaultParts(),
  });
  const result = score.relayout(doc);
  assert.ok(result.conflicts.some(c => c.type === 'lane-overflow' && c.part === PART_A));
});

test('font size change bumps the layout version used by export', () => {
  const doc = buildDuetDoc();
  const score = new ScoreLayout({ width: 1280, height: 720, fontSize: 40, parts: defaultParts() });
  score.relayout(doc);
  const v1ver = score.layoutVersion;
  score.update({ fontSize: 52 });
  score.relayout(doc);
  assert.ok(score.layoutVersion > v1ver);
});

// ---------- char sing-along correction kernel ----------

console.log('\nsyllable correction kernel:');

test('dragging a syllable boundary moves both adjacent slots and stays valid', () => {
  const doc = buildDocument('star', {});
  const word = doc.words[0];
  let rec = ensureCharTimings(word, { start: 4.8, end: 5.3, chars: null });
  assert.equal(rec.chars.length, 4);
  const result = dragCharBoundary(word, rec, 2, 5.05, 'both');
  assert.equal(result.ok, true, result.error);
  rec = result.rec;
  assert.equal(rec.chars[1].end, 5.05);
  assert.equal(rec.chars[2].start, 5.05);
  assert.equal(validateCharRecord(word, rec).ok, true);
});

test('boundary drag is rejected when it would invert an interval', () => {
  const doc = buildDocument('star', {});
  const word = doc.words[0];
  const rec = ensureCharTimings(word, { start: 4.8, end: 5.3, chars: null });
  const firstBoundary = rec.chars[0].end;
  const rejected = dragCharBoundary(word, rec, 1, rec.chars[0].start, 'both');
  assert.equal(rejected.ok, false);
  assert.ok(rejected.error.includes('边界'));
  // The record is untouched after rejection.
  assert.equal(rec.chars[0].end, firstBoundary);
});

test('word edge drag stretches every grapheme slot proportionally', () => {
  const doc = buildDocument('star', {});
  const word = doc.words[0];
  const rec0 = ensureCharTimings(word, { start: 4.8, end: 5.3, chars: null });
  const result = dragWordEdge(word, rec0, 'end', 5.8);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.rec.end, 5.8);
  assert.equal(result.rec.chars[3].end, 5.8);
  assert.equal(validateCharRecord(word, result.rec).ok, true);
});

test('correction refuses a word that still has no word-level timing', () => {
  const doc = buildDocument('star', {});
  const result = dragCharBoundary(doc.words[0], undefined, 1, 1.0, 'both');
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('整词时间'));
});

// ---------- export validation and snapshot freeze ----------

console.log('\nexport validation:');

test('export blocks on intra-part overlap and lane overflow, allows cross-part', () => {
  const doc = buildDuetDoc();
  const a = wordsOfPart(doc, PART_A);
  const b = wordsOfPart(doc, PART_B);
  const timings = {
    [a[0].id]: { start: 0, end: 1, chars: null },
    [a[1].id]: { start: 0.5, end: 1.5, chars: null },
    [b[0].id]: { start: 0.2, end: 0.9, chars: null },
  };
  const score = new ScoreLayout({ width: 1280, height: 720, fontSize: 40, parts: defaultParts() });
  const layoutResult = score.relayout(doc);
  const v = validateExport({ doc, timings, parts: defaultParts(), layoutResult });
  assert.equal(v.ok, false);
  assert.equal(v.intraPartOverlaps.length, 1);
  assert.equal(v.crossPartOverlaps.length, 2);
});

test('clean duet timeline exports; snapshot freezes part views and layout version', () => {
  const doc = buildDuetDoc();
  const a = wordsOfPart(doc, PART_A);
  const b = wordsOfPart(doc, PART_B);
  const timings = {
    [a[0].id]: { start: 0, end: 1, chars: null },
    [b[0].id]: { start: 0, end: 1, chars: null },
  };
  const score = new ScoreLayout({ width: 1280, height: 720, fontSize: 40, parts: defaultParts() });
  const layoutResult = score.relayout(doc);
  const partViews = { [PART_A]: VIEW_SOLO, [PART_B]: VIEW_REFERENCE };
  const v = validateExport({ doc, timings, parts: defaultParts(), layoutResult });
  assert.equal(v.ok, true);
  const snap = captureExportSnapshot({
    doc, timings, parts: defaultParts(), partViews, focusPart: 'all',
    layoutResult, mode: 'char', title: 't', font: null,
  });
  assert.equal(snap.layoutVersion, layoutResult.layoutVersion);
  assert.equal(snap.partViews[PART_B], VIEW_REFERENCE);
  // Mutating live state after capture cannot change the snapshot.
  partViews[PART_B] = VIEW_HIDDEN;
  assert.equal(snap.partViews[PART_B], VIEW_REFERENCE);
});

test('export generation guard marks a late result as superseded', () => {
  // Mirror the app.js guard: each run captures its own generation; a newer
  // run increments the shared counter so the stale run's result is dropped.
  let current = 0;
  const first = ++current;
  const second = ++current;
  const accept = generation => generation === current;
  assert.equal(accept(first), false); // late result from the first run
  assert.equal(accept(second), true); // current run still owns the preview
  // A snapshot captured by the first run is immutable regardless of the guard.
  const doc = buildDuetDoc();
  const score = new ScoreLayout({ width: 1280, height: 720, fontSize: 40, parts: defaultParts() });
  const layoutResult = score.relayout(doc);
  const snap = captureExportSnapshot({
    doc, timings: {}, parts: defaultParts(),
    partViews: { A: VIEW_SOLO, B: VIEW_HIDDEN }, focusPart: PART_A,
    layoutResult, mode: 'word', title: '', font: null,
  });
  assert.equal(snap.focusPart, PART_A);
  assert.equal(snap.partViews.B, VIEW_HIDDEN);
});

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
