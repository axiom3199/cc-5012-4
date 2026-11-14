// Grapheme-by-grapheme sing-along correction kernel.
//
// All operations are pure with respect to the timing table: they return a new
// timing record (or a structured failure) instead of mutating caller state,
// so the editor can drive the same kernel from mouse drags, number inputs and
// automated tests. A failure is reported back to the sing-along UI rather than
// thrown away — the boundary simply does not move.
//
// A "syllable" here is one grapheme cluster; combining marks and ZWJ emoji
// stay indivisible (see gcs.js).

import { graphemes } from './gcs.js';
import { isPending } from './model.js';

export const EPS = 1e-3;

// Ensure a word record carries one editable slot per grapheme cluster.
// Existing confirmed slots are preserved; missing ones are seeded from the
// word's outer span by equal division ONLY as an editable starting point
// (the user explicitly entered char correction for this word).
export function ensureCharTimings(word, rec) {
  const clusters = graphemes(word.text);
  let chars;
  if (rec && Array.isArray(rec.chars) && rec.chars.length === clusters.length) {
    chars = rec.chars.map(c => ({ start: c.start ?? null, end: c.end ?? null }));
  } else {
    const start = rec?.start ?? 0;
    const end = rec?.end ?? start + clusters.length * 0.2;
    const span = (end - start) / clusters.length;
    chars = clusters.map((_, i) => ({
      start: start + i * span,
      end: i === clusters.length - 1 ? end : start + (i + 1) * span,
    }));
  }
  return {
    start: rec?.start ?? chars[0].start,
    end: rec?.end ?? chars[chars.length - 1].end,
    chars,
  };
}

function validNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// Validate the full record: well-formed intervals, ordered non-overlapping
// grapheme slots inside the word span.
export function validateCharRecord(word, rec) {
  const errors = [];
  if (!rec || !Array.isArray(rec.chars)) {
    return { ok: false, errors: ['缺少逐字时间数据'] };
  }
  const clusters = graphemes(word.text);
  if (rec.chars.length !== clusters.length) {
    errors.push(`字素数量不符：需要 ${clusters.length}，实际 ${rec.chars.length}`);
  }
  if (!validNumber(rec.start) || !validNumber(rec.end) || rec.end <= rec.start) {
    errors.push('整词区间无效：终点必须晚于起点');
  }
  rec.chars.forEach((c, i) => {
    if (!validNumber(c.start) || !validNumber(c.end)) {
      errors.push(`第 ${i + 1} 个字时间不完整`);
    } else if (c.end <= c.start) {
      errors.push(`第 ${i + 1} 个字终点早于起点`);
    }
    if (i > 0) {
      const prev = rec.chars[i - 1];
      if (validNumber(prev.end) && validNumber(c.start) && c.start < prev.end - EPS) {
        errors.push(`第 ${i} 与第 ${i + 1} 个字的时间区间重叠`);
      }
    }
    if (validNumber(c.start) && validNumber(rec.start) && c.start < rec.start - EPS) {
      errors.push(`第 ${i + 1} 个字起点早于整词起点`);
    }
    if (validNumber(c.end) && validNumber(rec.end) && c.end > rec.end + EPS) {
      errors.push(`第 ${i + 1} 个字终点晚于整词终点`);
    }
  });
  return { ok: errors.length === 0, errors };
}

// Drag the boundary between grapheme index-1 and index.
// side: 'left' moves the end of the left slot, 'right' moves the start of the
// right slot, 'both' moves both together (the default joint drag).
// Returns { ok, rec, error }.
export function dragCharBoundary(word, rec, index, newTime, side = 'both') {
  if (isPending(rec)) {
    return { ok: false, rec: null, error: '该词尚未标记整词时间，无法校正音节' };
  }
  const next = ensureCharTimings(word, rec);
  const t = Number(newTime);
  if (!validNumber(t)) {
    return { ok: false, rec: null, error: '边界时间必须是非负数字' };
  }
  if (index < 1 || index >= next.chars.length) {
    return { ok: false, rec: null, error: `音节边界索引越界：${index}` };
  }
  const left = next.chars[index - 1];
  const right = next.chars[index];

  if (side === 'left' || side === 'both') {
    if (t <= left.start + EPS) {
      return { ok: false, rec: null, error: '边界不能早于或等于左侧音节的起点' };
    }
    left.end = t;
  }
  if (side === 'right' || side === 'both') {
    if (t >= right.end - EPS) {
      return { ok: false, rec: null, error: '边界不能晚于或等于右侧音节的终点' };
    }
    right.start = t;
  }
  // Keep the outer word span consistent with the outermost slots.
  next.start = next.chars[0].start;
  next.end = next.chars[next.chars.length - 1].end;

  const check = validateCharRecord(word, next);
  if (!check.ok) {
    return { ok: false, rec: null, error: check.errors.join('；') };
  }
  return { ok: true, rec: next, error: null };
}

// Drag the whole word's start (edge = 'start') or end (edge = 'end').
// The outer span moves and every grapheme slot is shifted/stretched to stay
// inside it proportionally.
export function dragWordEdge(word, rec, edge, newTime) {
  if (isPending(rec)) {
    return { ok: false, rec: null, error: '该词尚未标记时间' };
  }
  const next = ensureCharTimings(word, rec);
  const t = Number(newTime);
  if (!validNumber(t)) {
    return { ok: false, rec: null, error: '边界时间必须是非负数字' };
  }
  if (edge === 'start') {
    if (t >= next.end - EPS) {
      return { ok: false, rec: null, error: '词起点不能晚于或等于词终点' };
    }
    const oldStart = next.start;
    const oldEnd = next.end;
    next.start = t;
    for (const c of next.chars) {
      c.start = t + ((c.start - oldStart) / (oldEnd - oldStart)) * (oldEnd - t);
      c.end = t + ((c.end - oldStart) / (oldEnd - oldStart)) * (oldEnd - t);
    }
    next.chars[0].start = t;
  } else if (edge === 'end') {
    if (t <= next.start + EPS) {
      return { ok: false, rec: null, error: '词终点不能早于或等于词起点' };
    }
    const oldStart = next.start;
    const oldEnd = next.end;
    next.end = t;
    for (const c of next.chars) {
      c.start = oldStart + ((c.start - oldStart) / (oldEnd - oldStart)) * (t - oldStart);
      c.end = oldStart + ((c.end - oldStart) / (oldEnd - oldStart)) * (t - oldStart);
    }
    next.chars[next.chars.length - 1].end = t;
  } else {
    return { ok: false, rec: null, error: `未知边界类型：${edge}` };
  }

  const check = validateCharRecord(word, next);
  if (!check.ok) {
    return { ok: false, rec: null, error: check.errors.join('；') };
  }
  return { ok: true, rec: next, error: null };
}

// Which grapheme slot (if any) is active at time t — the kernel source of
// truth for highlight ranges while correcting.
export function charIndexAt(rec, t) {
  if (!rec || !Array.isArray(rec.chars)) return -1;
  return rec.chars.findIndex(c => t >= c.start && t < c.end);
}
