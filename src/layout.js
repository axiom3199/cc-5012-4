// Text layout and measurement engine.
//
// All highlight rectangles are derived from measured glyph positions rather
// than character counts. Every time the font family, size, fallback stack or
// the loaded font set changes, the full layout is rebuilt and every width is
// re-measured — stale measurements are never reused for painting.
//
// Ligature strategy
// -----------------
// Adjacent grapheme clusters are measured both independently and together.
// When the shaped pair is narrower (or wider) than the sum of its parts beyond
// an epsilon, the clusters have merged into one glyph shape (ligature, ZWJ
// join, complex-script reordering) and are grouped into an atomic "shaping
// run". The default policy highlights the whole run at once so a single glyph
// is never sliced down the middle.

import { graphemes } from './gcs.js';

const EPS = 0.75;

const FONT_STACKS = {
  rounded: '"Baloo 2", "Comic Sans MS", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Color Emoji", "Apple Color Emoji", sans-serif',
  hei: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Color Emoji", "Apple Color Emoji", sans-serif',
  song: '"Songti SC", "SimSun", "Noto Serif CJK SC", "Noto Color Emoji", "Apple Color Emoji", serif',
};

export function fontStack(name) {
  return FONT_STACKS[name] || FONT_STACKS.rounded;
}

function makeCtx() {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(300, 80).getContext('2d');
  }
  return document.createElement('canvas').getContext('2d');
}

class UnionFind {
  constructor(n) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(x) {
    while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; }
    return x;
  }
  union(a, b) { this.p[this.find(a)] = this.find(b); }
}

// A single grapheme cluster that the font renders as one indivisible glyph:
// ZWJ sequences, variation-selector emoji, skin-tone forms and flag pairs.
function isInherentlyAtomic(cluster) {
  for (const ch of cluster) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200d) return true;
    if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
    if (cp >= 0x1f3fb && cp <= 0x1f3ff) return true;
    if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return true;
  }
  return false;
}

export class CanvasLayout {
  constructor(opts = {}) {
    this.width = opts.width ?? 1280;
    this.height = opts.height ?? 720;
    this.padding = opts.padding ?? 72;
    this.fontFamily = opts.fontFamily ?? 'rounded';
    this.fontSize = opts.fontSize ?? 56;
    this.lineHeightMul = opts.lineHeightMul ?? 1.55;
    // 'atomic-if-merged' (default) or 'prefix-cut'
    this.ligaturePolicy = opts.ligaturePolicy ?? 'atomic-if-merged';
    // Fixed top offset for the first visual line; used by per-part lanes.
    this.top = opts.top ?? null;
    this._ctx = makeCtx();
    this._measureCache = new Map();
    this.result = { visualLines: [], words: [], totalHeight: 0, fonts: '' };
  }

  update(patch = {}) {
    let fontChanged = false;
    for (const key of ['width', 'height', 'padding', 'fontFamily', 'fontSize', 'lineHeightMul', 'ligaturePolicy', 'top']) {
      if (key in patch && patch[key] !== this[key]) {
        this[key] = patch[key];
        if (key === 'fontFamily' || key === 'fontSize') fontChanged = true;
      }
    }
    // A different family/size invalidates every cached width.
    if (fontChanged) this._measureCache.clear();
    return this;
  }

  get fonts() {
    return `${this.fontSize}px ${fontStack(this.fontFamily)}`;
  }

  _measure(text) {
    const key = this.fonts + '|' + text;
    let w = this._measureCache.get(key);
    if (w === undefined) {
      this._ctx.font = this.fonts;
      w = this._ctx.measureText(text).width;
      this._measureCache.set(key, w);
    }
    return w;
  }

  // Full re-measurement of one word: cluster geometry + atomic shaping runs.
  measureWord(word) {
    const clusters = graphemes(word.text);
    this._ctx.font = this.fonts;
    // Independent widths: each cluster measured in isolation.
    const independent = clusters.map(c => this._measure(c));
    const fullWidth = this._measure(word.text);

    // Prefix positions come from shaping the word as one string, which keeps
    // kerning and contextual forms honest.
    const prefix = [0];
    let acc = '';
    for (const c of clusters) {
      acc += c;
      prefix.push(this._measure(acc));
    }
    const widths = prefix.slice(1).map((p, k) => p - prefix[k]);

    const uf = new UnionFind(clusters.length);
    for (let k = 0; k < clusters.length - 1; k++) {
      // Compare against independent widths: a shaped pair that differs from
      // the two isolated clusters means a ligature / ZWJ join / reordering.
      const pairWidth = this._measure(clusters[k] + clusters[k + 1]);
      const separate = independent[k] + independent[k + 1];
      if (Math.abs(pairWidth - separate) > EPS) {
        uf.union(k, k + 1);
      }
    }
    // Whole-word sanity check: if contextual shaping changes the total width
    // beyond the epsilon, treat the word conservatively as one atomic run.
    if (clusters.length > 1 &&
        Math.abs(fullWidth - independent.reduce((a, b) => a + b, 0)) > EPS * 2) {
      for (let k = 1; k < clusters.length; k++) uf.union(0, k);
    }

    const groups = new Map();
    for (let k = 0; k < clusters.length; k++) {
      const root = uf.find(k);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(k);
    }
    const runs = [...groups.values()]
      .map(ids => ({
        start: ids[0],
        end: ids[ids.length - 1],
        x: prefix[ids[0]],
        width: prefix[ids[ids.length - 1] + 1] - prefix[ids[0]],
        // Atomic when clusters merged via shaping, or when the single cluster
        // itself is an indivisible ZWJ/flag/skin-tone glyph.
        atomic: ids.length > 1 ||
          clusters.slice(ids[0], ids[ids.length - 1] + 1).some(isInherentlyAtomic),
      }))
      .sort((a, b) => a.start - b.start);

    return {
      id: word.id,
      word,
      clusters,
      prefix,
      clusterWidths: widths,
      independentWidths: independent,
      width: fullWidth,
      runs,
      hasMergedRuns: runs.some(r => r.atomic),
    };
  }

  // Rebuild every position from scratch. Safe to call after fonts finish
  // loading, after a fallback change, or after lyric/layout edits.
  relayout(doc) {
    this._measureCache.clear();
    const space = this._measure(' ');
    const lineHeightPx = this.fontSize * this.lineHeightMul;
    const contentRight = this.width - this.padding;

    // First pass: hard line breaks from the lyric plus soft wrapping.
    const visualLines = [];
    let current = [];
    let cursorX = this.padding;
    let hardLine = -1;

    const breakLine = () => {
      if (current.length) visualLines.push(current);
      current = [];
      cursorX = this.padding;
    };

    for (const word of doc.words) {
      if (word.line !== hardLine) {
        breakLine();
        hardLine = word.line;
      }
      const geo = this.measureWord(word);
      const gap = current.length ? space : 0;
      if (current.length && cursorX + gap + geo.width > contentRight) breakLine();
      const x = cursorX + (current.length ? space : 0);
      current.push({ geo, x });
      cursorX = x + geo.width;
    }
    breakLine();

    // Second pass: center each visual line and assign absolute coordinates.
    const totalHeight = visualLines.length * lineHeightPx;
    const startY = this.top ?? Math.max(this.padding, (this.height - totalHeight) / 2);
    const placedWords = [];

    visualLines.forEach((items, li) => {
      const lineWidth = items.reduce((sum, it, idx) =>
        sum + it.geo.width + (idx ? space : 0), 0);
      let x = Math.max(this.padding, (this.width - lineWidth) / 2);
      const top = startY + li * lineHeightPx;
      const baseline = top + lineHeightPx / 2 + this.fontSize * 0.34;
      const boxTop = baseline - this.fontSize * 0.86;
      const boxHeight = this.fontSize * 1.18;

      for (const it of items) {
        const placed = {
          ...it.geo,
          x,
          y: boxTop,
          baseline,
          height: boxHeight,
          visualLine: li,
        };
        placedWords.push(placed);
        x += it.geo.width + space;
      }
    });

    this.result = {
      visualLines,
      words: placedWords,
      totalHeight,
      fonts: this.fonts,
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      ligaturePolicy: this.ligaturePolicy,
    };
    return this.result;
  }

  wordById(id) {
    return this.result.words.find(w => w.id === id) || null;
  }
}
