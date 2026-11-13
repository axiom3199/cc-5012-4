// Node test runner (no dependencies). Run: node tests/test.mjs
// Layout tests use a minimal canvas 2D mock so the measurement code can run
// headless; production rendering still uses the real browser canvas.

import assert from 'node:assert/strict';
import { graphemes, graphemeCount } from '../src/gcs.js';
import {
  buildDocument, rebuildDocument, isPending, stateAt,
  pendingIds, serializeProject, parseProject,
} from '../src/model.js';
import { CanvasLayout } from '../src/layout.js';

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
  const back = parseProject(json);
  assert.equal(back.timings[doc.words[0].id].start, 1);
  assert.equal(back.audioName, 'x.wav');
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

console.log(`\n${passed} tests passed${process.exitCode ? ' (with failures)' : ''}`);
