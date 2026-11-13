// Single rendering path shared by the live preview and the video exporter.
// Both call renderAt(ctx, ..., time) with the same layout and timing tables,
// so the audio clock seen during preview and the frame clock used while
// exporting resolve to identical highlight states.

import { stateAt, isPending } from './model.js';

const COLORS = {
  bgTop: '#fff7e6',
  bgBottom: '#ffe3f1',
  text: '#2f3542',
  textDone: '#57606f',
  textActive: '#d63031',
  pending: '#a4b0be',
  highlight: '#ffd32a',
  highlightStroke: '#ff9f1a',
  badgeBg: '#747d8c',
  badgeText: '#ffffff',
  barBg: '#ecccb8',
  barFill: '#ff6b81',
  title: '#6c5ce7',
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

function drawHighlightRect(ctx, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = COLORS.highlight;
  ctx.strokeStyle = COLORS.highlightStroke;
  ctx.lineWidth = 2.5;
  roundRect(ctx, x - 6, y - 3, w + 12, h + 6, 12);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawBadge(ctx, text, x, y, fontSize) {
  ctx.save();
  ctx.font = `${Math.round(fontSize * 0.32)}px sans-serif`;
  const pad = fontSize * 0.14;
  const w = ctx.measureText(text).width + pad * 2;
  const h = fontSize * 0.5;
  ctx.fillStyle = COLORS.badgeBg;
  roundRect(ctx, x, y - h - fontSize * 0.12, w, h, h / 2);
  ctx.fill();
  ctx.fillStyle = COLORS.badgeText;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + pad, y - h / 2 - fontSize * 0.12);
  ctx.restore();
}

function drawWordBase(ctx, geo, isActive, isDone, pending, fontStr, fontSize) {
  ctx.save();
  ctx.font = fontStr;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  if (pending) {
    ctx.fillStyle = COLORS.pending;
    ctx.fillText(geo.word.text, geo.x, geo.baseline);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = COLORS.pending;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(geo.x, geo.y + geo.height);
    ctx.lineTo(geo.x + geo.width, geo.y + geo.height);
    ctx.stroke();
    drawBadge(ctx, '待标', geo.x, geo.y, fontSize);
    ctx.restore();
    return;
  }

  ctx.fillStyle = isActive ? COLORS.textActive : (isDone ? COLORS.textDone : COLORS.text);
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

export function renderAt(ctx, {
  layout, doc, timings, time,
  mode = 'word',
  title = '',
  duration = 0,
}) {
  // Accept either a CanvasLayout engine or a ready layout result object.
  const L = layout.words ? layout : layout.result;
  const { width, height } = ctx.canvas;
  const fontSize = L.fontSize;

  // Background
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, COLORS.bgTop);
  grad.addColorStop(1, COLORS.bgBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Title
  if (title) {
    ctx.save();
    ctx.font = `700 ${Math.round(fontSize * 0.72)}px sans-serif`;
    ctx.fillStyle = COLORS.title;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(title, width / 2, 28);
    ctx.restore();
  }

  const { activeId, activeCharIndex } = stateAt(doc, timings, time);

  // Pass 1: highlight shapes behind the text.
  for (const geo of L.words) {
    const rec = timings[geo.id];
    const pending = isPending(rec);
    if (pending) continue;
    const isActive = geo.id === activeId;

    if (!isActive) continue;

    if (mode === 'word' || activeCharIndex < 0 || !Array.isArray(rec.chars) || !rec.chars.length) {
      drawHighlightRect(ctx, geo.x, geo.y, geo.width, geo.height);
    } else {
      const { full, partial } = activeRunsForChar(geo, activeCharIndex, L.ligaturePolicy);
      for (const ri of full) {
        const run = geo.runs[ri];
        drawHighlightRect(ctx, geo.x + run.x, geo.y, run.width, geo.height);
      }
      if (partial) {
        const run = geo.runs[partial.runIndex];
        drawHighlightRect(ctx, geo.x + run.x, geo.y, run.width * partial.ratio, geo.height);
      }
    }
  }

  // Pass 2: text on top of highlights.
  for (const geo of L.words) {
    const rec = timings[geo.id];
    const pending = isPending(rec);
    const isActive = geo.id === activeId;
    const isDone = !pending && !isActive && rec.end <= time;
    drawWordBase(ctx, geo, isActive, isDone, pending, L.fonts, fontSize);
  }

  // Progress bar + clock
  const barW = width - 160;
  const barX = 80;
  const barY = height - 34;
  ctx.save();
  ctx.fillStyle = COLORS.barBg;
  roundRect(ctx, barX, barY, barW, 10, 5);
  ctx.fill();
  if (duration > 0) {
    const ratio = Math.max(0, Math.min(1, time / duration));
    ctx.fillStyle = COLORS.barFill;
    roundRect(ctx, barX, barY, barW * ratio, 10, 5);
    ctx.fill();
  }
  ctx.font = '20px sans-serif';
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const tNow = formatClock(time);
  const tDur = duration ? formatClock(duration) : '--:--';
  ctx.fillText(`${tNow} / ${tDur}`, barX, barY - 4);
  const pendingCount = doc.words.filter(w => isPending(timings[w.id])).length;
  if (pendingCount) {
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.badgeBg;
    ctx.fillText(`待标 ${pendingCount} 词`, barX + barW, barY - 4);
  }
  ctx.restore();
}

function formatClock(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
