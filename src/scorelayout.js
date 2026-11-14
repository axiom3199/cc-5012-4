// Multi-part score layout.
//
// Each voice part owns a stable vertical "lane". Lane order follows the parts
// array index and never changes at playback time: a short pause inside a lane
// cannot make two lanes swap top/bottom positions. A lane internally reuses
// the single-part CanvasLayout measurement engine, so all glyph geometry,
// soft wrapping and atomic shaping-run logic stays in one place.
//
// When a lane's wrapped content is taller than the area it was given, the
// overflow is reported as a real layout conflict instead of being silently
// clipped or pushed into the neighboring lane.

import { CanvasLayout } from './layout.js';
import { wordsOfPart } from './model.js';

export class ScoreLayout {
  constructor(opts = {}) {
    this.width = opts.width ?? 1280;
    this.height = opts.height ?? 720;
    this.padding = opts.padding ?? 56;
    this.laneGap = opts.laneGap ?? 24;
    this.fontFamily = opts.fontFamily ?? 'rounded';
    this.fontSize = opts.fontSize ?? 44;
    this.ligaturePolicy = opts.ligaturePolicy ?? 'atomic-if-merged';
    // Bumped whenever geometry changes in a way that affects an exported file.
    this.layoutVersion = opts.layoutVersion ?? 1;
    this.parts = opts.parts || [];
    // 'all' shows every lane; a single part id allocates the full stage to it.
    this.focusPart = opts.focusPart ?? 'all';
    this.lanes = [];
    this.result = { lanes: [], words: [], conflicts: [], layoutVersion: this.layoutVersion };
  }

  update(patch = {}) {
    let geometryChanged = false;
    for (const key of ['width', 'height', 'padding', 'laneGap', 'fontFamily', 'fontSize', 'ligaturePolicy', 'parts', 'focusPart']) {
      if (key in patch && patch[key] !== this[key]) {
        this[key] = patch[key];
        if (key === 'fontFamily' || key === 'fontSize' || key === 'width' ||
            key === 'height' || key === 'padding' || key === 'laneGap') {
          geometryChanged = true;
        }
      }
    }
    if (geometryChanged) this.layoutVersion += 1;
    return this;
  }

  _engineFor(y, h) {
    return new CanvasLayout({
      width: this.width,
      height: h,
      padding: this.padding,
      fontFamily: this.fontFamily,
      fontSize: this.fontSize,
      ligaturePolicy: this.ligaturePolicy,
      top: y,
    });
  }

  relayout(doc) {
    const visibleParts = this.focusPart === 'all'
      ? this.parts
      : this.parts.filter(p => p.id === this.focusPart);
    const laneCount = Math.max(1, visibleParts.length);
    const laneH = (this.height - this.padding * 2 - this.laneGap * (laneCount - 1)) / laneCount;

    const lanes = [];
    const conflicts = [];
    let allWords = [];

    visibleParts.forEach((part, laneIdx) => {
      const top = this.padding + laneIdx * (laneH + this.laneGap);
      const partDoc = { words: wordsOfPart(doc, part.id) };

      // Probe pass to learn the content height, so short lanes are vertically
      // centered within their reserved area instead of sticking to the top.
      const probe = this._engineFor(top, laneH);
      const probed = probe.relayout(partDoc);
      const innerTop = top + Math.max(0, (laneH - probed.totalHeight) / 2);

      // Second pass with the resolved fixed top; geometry is deterministic.
      const engine = this._engineFor(innerTop, laneH);
      const partResult = engine.relayout(partDoc);

      // Every measured coordinate already sits inside the lane's area.
      const words = partResult.words.map(w => ({ ...w, part: part.id, lane: laneIdx }));

      const overflow = partResult.totalHeight - laneH;
      const lane = {
        partId: part.id,
        part,
        index: laneIdx,
        top,
        height: laneH,
        words,
        totalHeight: partResult.totalHeight,
        overflow: overflow > 1 ? overflow : 0,
        fonts: partResult.fonts,
        fontSize: partResult.fontSize,
        ligaturePolicy: partResult.ligaturePolicy,
      };
      if (lane.overflow > 0) {
        conflicts.push({
          type: 'lane-overflow',
          part: part.id,
          lane: laneIdx,
          overflow: lane.overflow,
          message: `声部 ${part.name} 内容超出分配区域 ${lane.overflow.toFixed(1)}px，请缩小字号或减少每行字数`,
        });
      }
      lanes.push(lane);
      allWords = allWords.concat(words);
    });

    // Lane boundary crossings are a second class of layout conflict: two
    // lanes may never paint into each other's reserved area.
    for (let i = 0; i < lanes.length - 1; i++) {
      const limit = lanes[i].top + lanes[i].height;
      for (const w of lanes[i + 1].words) {
        if (w.y < limit) {
          conflicts.push({
            type: 'lane-crossing',
            parts: [lanes[i].partId, lanes[i + 1].partId],
            wordId: w.id,
            message: `声部 ${lanes[i + 1].part.name} 的词“${w.word.text}”侵入上一声部区域`,
          });
          break;
        }
      }
    }

    this.lanes = lanes;
    this.result = {
      lanes,
      words: allWords,
      conflicts,
      layoutVersion: this.layoutVersion,
      fonts: lanes[0]?.fonts || '',
      fontSize: this.fontSize,
      ligaturePolicy: this.ligaturePolicy,
    };
    return this.result;
  }

  wordById(id) {
    return this.result.words.find(w => w.id === id) || null;
  }

  laneOf(partId) {
    return this.result.lanes.find(l => l.partId === partId) || null;
  }
}
