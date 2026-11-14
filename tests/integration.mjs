// Headless integration smoke test for the full render pipeline:
// synthesized sample audio -> document + timings -> measured layout ->
// renderAt(t) frames. No browser is required; DOM/callas APIs are stubbed.
// Run: node tests/integration.mjs

import assert from 'node:assert/strict';
import { sampleDefinition, timingFromSchedule, buildSampleAudio, duetDefinition, timingFromPartSchedules, buildDuetAudio, skewCharSlots } from '../src/sample.js';
import { buildDocument, buildMultiPartDocument, stateAt, stateForParts, isPending, pendingIds, PART_A, PART_B, defaultParts, wordsOfPart } from '../src/model.js';
import { CanvasLayout } from '../src/layout.js';
import { ScoreLayout } from '../src/scorelayout.js';
import { renderAt } from '../src/renderer.js';
import { graphemes } from '../src/gcs.js';
import { VIEW_SOLO, VIEW_REFERENCE, VIEW_HIDDEN } from '../src/parts.js';
import { validateExport, captureExportSnapshot } from '../src/exporter.js';

// ---- browser API stubs ----

const HIGHLIGHT_COLOR_A = '#ffd32a'; // part A palette highlight
const HIGHLIGHT_COLOR_B = '#74b9ff'; // part B palette highlight

class MockCtx2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.calls = { highlight: 0, fillText: 0, badges: [], highlightColors: new Set() };
    this.font = '';
    this.fillStyle = '';
    this.strokeStyle = '';
    this.textAlign = '';
    this.textBaseline = '';
    this.lineWidth = 1;
    this._scale = 1;
  }
  set font(v) {
    const m = /^(\d+(?:\.\d+)?)px/.exec(v);
    this._scale = m ? Number(m[1]) / 56 : 1;
    this._font = v;
  }
  get font() { return this._font; }
  measureText(text) {
    let w = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1f3fb && cp <= 0x1f3ff)) continue;
      let unit = cp === 0x20 ? 14 : 20;
      if ([...text].some((c, i, arr) => c.codePointAt(0) === 0x200d)) unit *= 0.8;
      w += unit;
    }
    return { width: w * this._scale };
  }
  createLinearGradient() { return { addColorStop() {} }; }
  fillRect() {}
  save() {} restore() {} beginPath() {} closePath() {} moveTo() {} lineTo() {} arcTo() {}
  fill() {
    if (this.fillStyle === HIGHLIGHT_COLOR_A || this.fillStyle === HIGHLIGHT_COLOR_B) {
      this.calls.highlight++;
      this.calls.highlightColors.add(this.fillStyle);
    }
  }
  stroke() {}
  setLineDash() {} fillText() { this.calls.fillText++; } strokeText() {}
}

globalThis.OffscreenCanvas = class {
  constructor(w = 300, h = 80) { this.width = w; this.height = h; this._ctx = new MockCtx2D(this); }
  getContext() { return this._ctx; }
};

class FakeParam {
  constructor(v) { this.value = v; }
  setValueAtTime() {} exponentialRampToValueAtTime() {}
}
class FakeNode {
  constructor(ctx) { this.context = ctx; this.gain = new FakeParam(1); this.frequency = new FakeParam(440); }
  connect(n) { return n; } start() {} stop() {}
}
class FakeOffline {
  constructor(channels, frames, sr) {
    this.numberOfChannels = channels; this.sampleRate = sr; this.length = frames;
    this.state = 'suspended';
  }
  createGain() { return new FakeNode(this); }
  createOscillator() { return new FakeNode(this); }
  createChannelMerger() { return new FakeNode(this); }
  createStereoPanner() {
    const node = new FakeNode(this);
    node.pan = { value: 0 };
    return node;
  }
  get destination() { return new FakeNode(this); }
  async startRendering() {
    const channels = [];
    for (let ch = 0; ch < this.numberOfChannels; ch++) channels.push(new Float32Array(this.length));
    return {
      numberOfChannels: this.numberOfChannels,
      sampleRate: this.sampleRate,
      length: this.length,
      getChannelData: ch => channels[ch] || channels[0],
    };
  }
}
globalThis.OfflineAudioContext = FakeOffline;
globalThis.Blob = class Blob { constructor(parts, opts) { this.parts = parts; this.type = opts?.type || ''; this.size = parts.reduce((n, p) => n + (p.byteLength || p.length || 0), 0); } };

// ---- pipeline ----

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const def = sampleDefinition();
const doc = buildDocument(def.rawText, { splitCJK: false });
const timings = timingFromSchedule(doc, def);
const layout = new CanvasLayout({ width: 1280, height: 720, fontSize: 56, fontFamily: 'hei' });
layout.relayout(doc);

test('sample document has the authored word instances in order', () => {
  assert.equal(doc.words.length, def.schedule.length);
  assert.equal(doc.words.filter(w => w.text === 'la').length, 6);
  // Combining-mark pinyin words each split into base + mark clusters.
  const first = layout.wordById(doc.words[0].id);
  assert.deepEqual(graphemes(doc.words[0].text), ['n', doc.words[0].text.slice(1)]);
  assert.equal(first.clusters.length, 2);
});

test('fish is pending and nothing else in its slot is fabricated', () => {
  const fish = doc.words.find(w => w.text === 'fish');
  assert.ok(isPending(timings[fish.id]));
  assert.deepEqual(pendingIds(doc, timings), [fish.id]);
});

test('ZWJ family and flag each measure to a single atomic glyph', () => {
  for (const text of ['👨‍👩‍👧', '🏳️‍🌈']) {
    const w = doc.words.find(x => x.text === text);
    const geo = layout.wordById(w.id);
    assert.equal(geo.clusters.length, 1);
    assert.equal(geo.runs.length, 1);
    assert.ok(geo.runs[0].atomic);
  }
});

test('renderAt paints every frame without error and respects pending vs active', () => {
  const canvas = { width: 1280, height: 720 };
  const rctx = new MockCtx2D(canvas);
  // Times inside confirmed word spans, inside a pause gap, and inside the
  // pending "fish" silence — gaps must render no highlight.
  const activeTimes = [0.7, 1.2, 2.0, 3.1, 4.3, 5.7, 6.2, 7.3, 8.5, 10.2];
  const gapTimes = [0.95, 2.8, 9.6];
  for (const t of activeTimes) {
    rctx.calls.highlight = 0;
    renderAt(rctx, { layout, doc, timings, time: t, mode: 'word', title: def.title, duration: def.duration });
    assert.ok(stateAt(doc, timings, t).activeId, `precondition: t=${t} is inside a word`);
    assert.ok(rctx.calls.highlight > 0, `t=${t} should highlight the active word`);
  }
  for (const t of gapTimes) {
    rctx.calls.highlight = 0;
    renderAt(rctx, { layout, doc, timings, time: t, mode: 'word', title: def.title, duration: def.duration });
    assert.equal(stateAt(doc, timings, t).activeId, null, `t=${t} is a pause/pending gap`);
    assert.equal(rctx.calls.highlight, 0, `t=${t} must not highlight during a gap`);
  }
  assert.ok(rctx.calls.fillText > 0);
});

test('char mode only highlights within words that have grapheme timing', () => {
  const canvas = { width: 1280, height: 720 };
  const rctx = new MockCtx2D(canvas);
  // shine spans 2.90–3.40 with per-grapheme times.
  const st = stateAt(doc, timings, 3.1);
  const shine = doc.words.find(w => w.text === 'shine');
  assert.equal(st.activeId, shine.id);
  assert.ok(st.activeCharIndex >= 0);
  renderAt(rctx, { layout, doc, timings, time: 3.1, mode: 'char', title: '', duration: def.duration });
  assert.ok(rctx.calls.highlight > 0);

  // A word-level-only word at its time falls back to whole-word highlight.
  const float = doc.words.find(w => w.text === 'float');
  const st2 = stateAt(doc, timings, 3.6);
  assert.equal(st2.activeId, float.id);
  assert.equal(st2.activeCharIndex, -1);
});

test('identical "la" instances in two choruses resolve independently', () => {
  const laIds = doc.words.filter(w => w.text === 'la').map(w => w.id);
  assert.equal(new Set(laIds).size, 6);
  const chorusA = stateAt(doc, timings, 8.5).activeId;
  const chorusB = stateAt(doc, timings, 10.0).activeId;
  assert.ok(chorusA && chorusB && chorusA !== chorusB);
});

test('re-layout after a font/size change yields new metrics but same timing resolution', () => {
  const before = layout.wordById(doc.words[0].id).width;
  layout.update({ fontSize: 88 });
  layout.relayout(doc);
  const after = layout.wordById(doc.words[0].id).width;
  assert.notEqual(before, after);
  // Timing is independent of geometry: same states at same times.
  assert.equal(stateAt(doc, timings, 2.0).activeId, doc.words[2].id);
});

test('synthesized audio is a WAV blob matching the authored duration', async () => {
  const blob = await buildSampleAudio(def);
  assert.equal(blob.type, 'audio/wav');
  assert.ok(blob.size > 44);
  const view = new DataView(blob.parts[0]);
  assert.equal(String.fromCharCode(...new Uint8Array(blob.parts[0].slice(0, 4))), 'RIFF');
});

// ---- duet / round pipeline ----

console.log('\nduet / round pipeline:');

const duet = duetDefinition();
const duetDoc = buildMultiPartDocument(duet.partTexts, {
  splitCJK: duet.splitCJK, parts: [PART_A, PART_B],
});
const duetTimings = timingFromPartSchedules(duetDoc, duet, [PART_A, PART_B]);
const parts = defaultParts();
const score = new ScoreLayout({ width: 1280, height: 720, fontSize: 40, parts });
const scoreResult = score.relayout(duetDoc);

test('duet document has two independent parts with their own instances', () => {
  assert.ok(wordsOfPart(duetDoc, PART_A).length > 0);
  assert.ok(wordsOfPart(duetDoc, PART_B).length > 0);
  const echoA = wordsOfPart(duetDoc, PART_A).find(w => w.text === 'echo');
  const echoB = wordsOfPart(duetDoc, PART_B).find(w => w.text === 'echo');
  assert.ok(echoA && echoB && echoA.id !== echoB.id);
  assert.equal(scoreResult.lanes.length, 2);
  assert.deepEqual(scoreResult.lanes.map(l => l.partId), [PART_A, PART_B]);
});

test('same word at the same instant highlights both parts in their own colors', () => {
  const canvas = { width: 1280, height: 720 };
  const rctx = new MockCtx2D(canvas);
  const states = stateForParts(duetDoc, duetTimings, 0.8, [PART_A, PART_B]);
  assert.equal(duetDoc.words.find(w => w.id === states[PART_A].activeId).text, 'echo');
  assert.equal(duetDoc.words.find(w => w.id === states[PART_B].activeId).text, 'echo');
  assert.notEqual(states[PART_A].activeId, states[PART_B].activeId);
  renderAt(rctx, {
    layout: score, doc: duetDoc, timings: duetTimings, time: 0.8,
    mode: 'word', title: duet.title, duration: duet.duration,
    parts, partViews: { A: VIEW_SOLO, B: VIEW_SOLO },
  });
  assert.ok(rctx.calls.highlightColors.has(HIGHLIGHT_COLOR_A));
  assert.ok(rctx.calls.highlightColors.has(HIGHLIGHT_COLOR_B));
});

test("part A's long hold stays active across two phrases sung by part B", () => {
  const hold = wordsOfPart(duetDoc, PART_A).find(w => w.text === 'hold');
  const bWords = wordsOfPart(duetDoc, PART_B);
  for (const t of [2.1, 2.8, 3.6, 4.5]) {
    assert.equal(stateAt(duetDoc, duetTimings, t, PART_A).activeId, hold.id, `A holds at ${t}`);
  }
  // B advances through two phrases while A holds; after phrase 2 ends, the
  // overlapping round entry ("two" 3.95–4.50 vs "round" 4.20–4.70) wins.
  const at22 = stateAt(duetDoc, duetTimings, 2.2, PART_B).activeId;
  const at455 = stateAt(duetDoc, duetTimings, 4.55, PART_B).activeId;
  assert.equal(duetDoc.words.find(w => w.id === at22).text, 'one');
  assert.equal(duetDoc.words.find(w => w.id === at455).text, 'round');
});

test('a short pause never makes the lanes swap order', () => {
  const before = scoreResult.lanes.map(l => l.top);
  score.relayout(duetDoc);
  const after = score.result.lanes.map(l => l.top);
  assert.deepEqual(before, after);
  // The pause at 3.1–3.4 leaves B with no active word, but A keeps holding.
  const states = stateForParts(duetDoc, duetTimings, 3.25, [PART_A, PART_B]);
  assert.ok(states[PART_A].activeId);
  assert.equal(states[PART_B].activeId, null);
});

test('reference part stays visible but gets no highlight; hidden part paints nothing', () => {
  const canvas = { width: 1280, height: 720 };
  const rctx = new MockCtx2D(canvas);
  renderAt(rctx, {
    layout: score, doc: duetDoc, timings: duetTimings, time: 0.8,
    mode: 'word', duration: duet.duration, parts,
    partViews: { A: VIEW_SOLO, B: VIEW_REFERENCE },
  });
  assert.ok(rctx.calls.highlightColors.has(HIGHLIGHT_COLOR_A));
  assert.ok(!rctx.calls.highlightColors.has(HIGHLIGHT_COLOR_B));
  const fillsWithRef = rctx.calls.fillText;
  assert.ok(fillsWithRef > 0); // reference text is still drawn, muted

  const rctx2 = new MockCtx2D(canvas);
  renderAt(rctx2, {
    layout: score, doc: duetDoc, timings: duetTimings, time: 0.8,
    mode: 'word', duration: duet.duration, parts,
    partViews: { A: VIEW_SOLO, B: VIEW_HIDDEN },
  });
  // Lane B hidden: only A highlights, and fewer text draws occur.
  assert.ok(!rctx2.calls.highlightColors.has(HIGHLIGHT_COLOR_B));
  assert.ok(rctx2.calls.fillText < fillsWithRef);
});

test('seeking restores both per-part highlight glyph ranges', () => {
  // "round" carries grapheme timing; seek straight into it.
  const round = wordsOfPart(duetDoc, PART_B).find(w => w.text === 'round');
  const rec = duetTimings[round.id];
  assert.ok(Array.isArray(rec.chars) && rec.chars.length === 5);
  const t = rec.chars[2].start + 0.01;
  const st = stateAt(duetDoc, duetTimings, t, PART_B);
  assert.equal(st.activeId, round.id);
  assert.equal(st.activeCharIndex, 2);
  // Simultaneous A state resolves independently at the same seeked time.
  const stA = stateAt(duetDoc, duetTimings, t, PART_A);
  assert.ok(stA.activeId === null || stA.activeId !== round.id);
});

test('skewed correction slots differ from even slots and remain valid data', () => {
  const text = 'star';
  const skewed = skewCharSlots(text, 4.8, 5.3);
  assert.equal(skewed.length, graphemes(text).length);
  assert.ok(skewed[0].end - 4.8 > (5.3 - 4.8) / 4 + 0.01);
  assert.equal(skewed[skewed.length - 1].end, 5.3);
});

test('duet export validation passes and the snapshot pins views and layout version', () => {
  const v = validateExport({
    doc: duetDoc, timings: duetTimings, parts, layoutResult: score.result,
  });
  assert.equal(v.ok, true, v.errors.join(';'));
  const partViews = { A: VIEW_SOLO, B: VIEW_REFERENCE };
  const snap = captureExportSnapshot({
    doc: duetDoc, timings: duetTimings, parts, partViews, focusPart: 'all',
    layoutResult: score.result, mode: 'char', title: duet.title, font: null,
  });
  assert.equal(snap.layoutVersion, score.result.layoutVersion);
  assert.equal(snap.partViews.B, VIEW_REFERENCE);
  assert.deepEqual(snap.parts.map(p => p.id), [PART_A, PART_B]);
});

test('stereo duet audio renders a two-channel WAV blob', async () => {
  const blob = await buildDuetAudio(duet);
  assert.equal(blob.type, 'audio/wav');
  const dv = new DataView(blob.parts[0]);
  assert.equal(dv.getUint16(22, true), 2); // two channels
  assert.ok(blob.size > 44);
});

console.log(`\n${passed} integration checks passed`);
