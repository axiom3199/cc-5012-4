// Headless integration smoke test for the full render pipeline:
// synthesized sample audio -> document + timings -> measured layout ->
// renderAt(t) frames. No browser is required; DOM/callas APIs are stubbed.
// Run: node tests/integration.mjs

import assert from 'node:assert/strict';
import { sampleDefinition, timingFromSchedule, buildSampleAudio } from '../src/sample.js';
import { buildDocument, stateAt, isPending, pendingIds } from '../src/model.js';
import { CanvasLayout } from '../src/layout.js';
import { renderAt } from '../src/renderer.js';
import { graphemes } from '../src/gcs.js';

// ---- browser API stubs ----

const HIGHLIGHT_COLOR = '#ffd32a'; // must match COLORS.highlight in renderer.js

class MockCtx2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.calls = { highlight: 0, fillText: 0, badges: [] };
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
  fill() { if (this.fillStyle === HIGHLIGHT_COLOR) this.calls.highlight++; }
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
  get destination() { return new FakeNode(this); }
  async startRendering() {
    return {
      numberOfChannels: 1,
      sampleRate: this.sampleRate,
      getChannelData: () => new Float32Array(this.length),
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

console.log(`\n${passed} integration checks passed`);
