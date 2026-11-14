// Single rendering path shared by the live preview and the video exporter.
// Both call renderAt(ctx, ..., time) with the same layout and timing tables,
// so the audio clock seen during preview and the frame clock used while
// exporting resolve to identical highlight states.
//
// Two layout shapes are accepted:
//   - a ScoreLayout result with per-part lanes (the duet/round pipeline)
//   - a legacy single-part CanvasLayout result (the original solo pipeline)
//
// Part view modes only change painting. They never modify the timeline:
//   'solo'      the part is the active voice — full color + bright highlight
//   'reference' visible but muted, no highlight (un-highlighted reference)
//   'hidden'    the lane area stays reserved but nothing is painted in it

import { stateAt, stateForParts, isPending, PART_COLORS, PART_A } from './model.js';

const BASE_COLORS = {
  bgTop: '#fff7e6',
  bgBottom: '#ffe3f1',
  text: '#2f3542',
  textDone: '#57606f',
  pending: '#a4b0be',
  barBg: '#ecccb8',
  barFill: '#ff6b81',
  title: '#6c5ce7',
  refText: '#b8c0cc',
  refDone: '#cfd6e0',
};

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawHighlightRect(ctx, x, y, w, h, palette) {
  ctx.save();
  ctx.fillStyle = palette.highlight;
  ctx.strokeStyle = palette.highlightStroke;
  ctx.lineWidth = 2.5;
  roundRect(ctx, x - 6, y - 3, w + 12, h + 6, 12);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawBadge(ctx, text, x, y, fontSize, color) {
  ctx.save();
  ctx.font = `${Math.round(fontSize * 0.32)}px sans-serif`;
  const pad = fontSize * 0.14;
  const w = ctx.measureText(text).width + pad * 2;
  const h = fontSize * 0.5;
  ctx.fillStyle = color;
  roundRect(ctx, x, y - h - fontSize * 0.12, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + pad, y - h / 2 - fontSize * 0.12);
  ctx.restore();
}

function drawLaneLabel(ctx, lane, fontSize) {
  ctx.save();
  ctx.font = `700 ${Math.round(fontSize * 0.4)}px sans-serif`;
  ctx.fillStyle = lane.part.color || PART_COLORS[lane.partId].badge;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(lane.part.name || `声部 ${lane.partId}`, 24, lane.top + 4);
  ctx.restore();
}

function drawWordBase(ctx, geo, isActive, isDone, pending, fontStr, fontSize, palette, muted) {
  ctx.save();
  ctx.font = fontStr;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  if (pending) {
    ctx.fillStyle = muted ? BASE_COLORS.refText : BASE_COLORS.pending;
    ctx.fillText(geo.word.text, geo.x, geo.baseline);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(geo.x, geo.y + geo.height);
    ctx.lineTo(geo.x + geo.width, geo.y + geo.height);
    ctx.stroke();
    if (!muted) drawBadge(ctx, '待标', geo.x, geo.y, fontSize, palette.badge);
    ctx.restore();
    return;
  }

  if (muted) {
    ctx.fillStyle = isDone ? BASE_COLORS.refDone : BASE_COLORS.refText;
  } else {
    ctx.fillStyle = isActive ? palette.activeText : (isDone ? BASE_COLORS.textDone : BASE_COLORS.text);
  }
  ctx.fillText(geo.word.text, geo.x, geo.baseline);
  ctx.restore();
}

function activeRunsForChar(geo, activeCharIndex, policy) {
  // Returns { full: [runIndexes], partial: { runIndex, ratio } }
  const full = [];
  let partial = null;
  if (activeCharIndex < 0) {
    return { full, partial: { runIndex: geo.runs.length - 1, ratio: 1 } };
  }
  for (let ri = 0; ri < geo.runs.length; ri++) {
    const run = geo.runs[ri];
    if (run.end < activeCharIndex) {
      full.push(ri);
    } else if (activeCharIndex >= run.start && activeCharIndex <= run.end) {
      if (policy === 'prefix-cut' && !run.atomic) {
        // Non-merged clusters can be cut at measured prefix positions.
        const local = activeCharIndex - run.start;
        const total = geo.prefix[run.end + 1] - geo.prefix[run.start];
        const done = geo.prefix[run.start + local + 1] - geo.prefix[run.start];
        partial = { runIndex: ri, ratio: total ? done / total : 1 };
      } else {
        // Atomic shaping run: never slice a single glyph. Highlight the
        // whole run when the playback head reaches any member cluster.
        full.push(ri);
      }
      break;
    }
  }
  return { full, partial };
}

function paintWordHighlights(ctx, lane, geo, rec, active, mode, palette) {
  if (!active) return;
  if (mode === 'word' || active.charIndex < 0 || !Array.isArray(rec.chars) || !rec.chars.length) {
    drawHighlightRect(ctx, geo.x, geo.y, geo.width, geo.height, palette);
    return;
  }
  const { full, partial } = activeRunsForChar(geo, active.charIndex, lane.ligaturePolicy);
  for (const ri of full) {
    const run = geo.runs[ri];
    drawHighlightRect(ctx, geo.x + run.x, geo.y, run.width, geo.height, palette);
  }
  if (partial) {
    const run = geo.runs[partial.runIndex];
    drawHighlightRect(ctx, geo.x + run.x, geo.y, run.width * partial.ratio, geo.height, palette);
  }
}

function paintChrome(ctx, width, height, time, duration, title, fontSize, pendingCount) {
  // Progress bar + clock
  const barW = width - 160;
  const barX = 80;
  const barY = height - 34;
  ctx.save();
  ctx.fillStyle = BASE_COLORS.barBg;
  roundRect(ctx, barX, barY, barW, 10, 5);
  ctx.fill();
  if (duration > 0) {
    const ratio = Math.max(0, Math.min(1, time / duration));
    ctx.fillStyle = BASE_COLORS.barFill;
    roundRect(ctx, barX, barY, barW * ratio, 10, 5);
    ctx.fill();
  }
  ctx.font = '20px sans-serif';
  ctx.fillStyle = BASE_COLORS.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const tNow = formatClock(time);
  const tDur = duration ? formatClock(duration) : '--:--';
  ctx.fillText(`${tNow} / ${tDur}`, barX, barY - 4);
  if (pendingCount) {
    ctx.textAlign = 'right';
    ctx.fillStyle = '#747d8c';
    ctx.fillText(`待标 ${pendingCount} 词`, barX + barW, barY - 4);
  }
  ctx.restore();

  if (title) {
    ctx.save();
    ctx.font = `700 ${Math.round(fontSize * 0.72)}px sans-serif`;
    ctx.fillStyle = BASE_COLORS.title;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(title, width / 2, 24);
    ctx.restore();
  }
}

// Multi-lane rendering used by the duet/round pipeline.
function renderScore(ctx, L, doc, timings, time, options) {
  const { width, height } = ctx.canvas;
  const {
    mode = 'word', title = '', duration = 0,
    parts = [], partViews = {},
  } = options;

  const states = stateForParts(doc, timings, time, parts.map(p => p.id));

  // Pass 1: highlight shapes behind the text (solo lanes only).
  for (const lane of L.lanes) {
    const view = partViews[lane.partId] || 'solo';
    if (view !== 'solo') continue;
    const palette = PART_COLORS[lane.partId] || PART_COLORS[PART_A];
    const state = states[lane.partId] || { activeId: null, activeCharIndex: -1 };
    for (const geo of lane.words) {
      const rec = timings[geo.id];
      if (isPending(rec)) continue;
      paintWordHighlights(ctx, lane, geo, rec,
        geo.id === state.activeId ? { charIndex: state.activeCharIndex } : null,
        mode, palette);
    }
  }

  // Pass 2: lane labels and text.
  for (const lane of L.lanes) {
    const view = partViews[lane.partId] || 'solo';
    if (view === 'hidden') continue;
    const palette = PART_COLORS[lane.partId] || PART_COLORS[PART_A];
    const muted = view === 'reference';
    const state = states[lane.partId] || { activeId: null };
    drawLaneLabel(ctx, lane, lane.fontSize);
    for (const geo of lane.words) {
      const rec = timings[geo.id];
      const pending = isPending(rec);
      const isActive = !pending && !muted && geo.id === state.activeId;
      const isDone = !pending && !isActive && rec.end <= time;
      drawWordBase(ctx, geo, isActive, isDone, pending, lane.fonts, lane.fontSize, palette, muted);
    }
  }

  const pendingCount = doc.words.filter(w => isPending(timings[w.id])).length;
  paintChrome(ctx, width, height, time, duration, title, L.fontSize, pendingCount);
}

// Legacy single-part rendering, kept byte-for-byte compatible with the
// original solo pipeline and its tests.
function renderLegacy(ctx, L, doc, timings, time, { mode = 'word', title = '', duration = 0 }) {
  const { width, height } = ctx.canvas;
  const fontSize = L.fontSize;
  const palette = PART_COLORS[PART_A];
  const { activeId, activeCharIndex } = stateAt(doc, timings, time);

  for (const geo of L.words) {
    const rec = timings[geo.id];
    if (isPending(rec) || geo.id !== activeId) continue;
    paintWordHighlights(ctx, { ligaturePolicy: L.ligaturePolicy }, geo, rec,
      { charIndex: activeCharIndex }, mode, palette);
  }
  for (const geo of L.words) {
    const rec = timings[geo.id];
    const pending = isPending(rec);
    const isActive = geo.id === activeId;
    const isDone = !pending && !isActive && rec.end <= time;
    drawWordBase(ctx, geo, isActive, isDone, pending, L.fonts, fontSize, palette, false);
  }
  const pendingCount = doc.words.filter(w => isPending(timings[w.id])).length;
  paintChrome(ctx, width, height, time, duration, title, fontSize, pendingCount);
}

export function renderAt(ctx, options) {
  const {
    layout, doc, timings, time,
    mode = 'word', title = '', duration = 0,
    parts = null, partViews = null,
  } = options;
  const L = layout.words ? layout : layout.result;
  const { width, height } = ctx.canvas;

  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, BASE_COLORS.bgTop);
  grad.addColorStop(1, BASE_COLORS.bgBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  if (L.lanes && parts && parts.length) {
    return renderScore(ctx, L, doc, timings, time, {
      mode, title, duration, parts,
      partViews: partViews || Object.fromEntries(parts.map(p => [p.id, 'solo'])),
    });
  }
  return renderLegacy(ctx, L, doc, timings, time, { mode, title, duration });
}

function formatClock(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
