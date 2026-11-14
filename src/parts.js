// Voice-part view state and selection helpers.
//
// View mode changes are display-only. They never touch the timing table, so
// toggling solo/reference/hidden cannot alter highlight ranges or the
// original time mapping used by playback and export.

export const VIEW_SOLO = 'solo';
export const VIEW_REFERENCE = 'reference';
export const VIEW_HIDDEN = 'hidden';

export const VIEW_LABELS = {
  [VIEW_SOLO]: '活动声部（高亮跟唱）',
  [VIEW_REFERENCE]: '参考声部（不高亮）',
  [VIEW_HIDDEN]: '临时隐藏',
};

export function defaultPartViews(parts) {
  return Object.fromEntries(parts.map(p => [p.id, VIEW_SOLO]));
}

// 'all' keeps every stable lane; a part id focuses the full stage on it.
export function isSoloFocus(focusPart) {
  return focusPart !== 'all';
}

// Normalize a drag/click selection of word ids against the document:
// duplicates removed, document order preserved.
export function normalizeSelection(doc, ids) {
  const wanted = new Set(ids);
  return doc.words.filter(w => wanted.has(w.id)).map(w => w.id);
}

// Apply a part assignment and return the affected ids. Unknown ids and words
// already on the target part are reported separately so the UI can explain
// why nothing changed.
export function reassignSelection(doc, ids, targetPart, knownPartIds) {
  if (!knownPartIds.includes(targetPart)) {
    return { ok: false, moved: [], error: `未知声部：${targetPart}` };
  }
  const moved = [];
  const skipped = [];
  for (const w of doc.words) {
    if (!ids.includes(w.id)) continue;
    if (w.part === targetPart) { skipped.push(w.id); continue; }
    w.part = targetPart;
    moved.push(w.id);
  }
  // Re-index document order after the move.
  doc.words.forEach((w, i) => { w.index = i; });
  return { ok: true, moved, skipped, error: null };
}
