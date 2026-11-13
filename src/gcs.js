// Grapheme cluster segmentation.
// A "grapheme" here is an extended grapheme cluster as defined by UAX #29.
// We never split on UTF-16 code units, so combining marks, variation
// selectors, ZWJ emoji sequences and regional-indicator pairs stay intact.

let segmenter = null;
try {
  segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
} catch {
  segmenter = null;
}

// Fallback used when Intl.Segmenter is unavailable. It groups:
//  - regional indicator symbols in pairs (flag emoji)
//  - emoji ZWJ / variation-selector sequences
//  - everything that is a combining mark or zero-width continuation
const ZWJ = 0x200d;
const VS_MIN = 0xfe00, VS_MAX = 0xfe0f;
const SKIN_MIN = 0x1f3fb, SKIN_MAX = 0x1f3ff;

function isRegionalIndicator(cp) {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}
function isExtend(cp) {
  if (cp === ZWJ) return true;
  if (cp >= VS_MIN && cp <= VS_MAX) return true;
  if (cp >= SKIN_MIN && cp <= SKIN_MAX) return true;
  // Common combining marks: Combining Diacritical Marks, Supplement, Extended.
  if (cp >= 0x0300 && cp <= 0x036f) return true;
  if (cp >= 0x1ab0 && cp <= 0x1aff) return true;
  if (cp >= 0x1dc0 && cp <= 0x1dff) return true;
  if (cp >= 0x20d0 && cp <= 0x20ff) return true;
  if (cp >= 0xfe20 && cp <= 0xfe2f) return true;
  // Keycap combining mark and tag characters.
  if (cp === 0x20e3) return true;
  if (cp >= 0xe0020 && cp <= 0xe007f) return true;
  return false;
}

export function graphemes(text) {
  if (segmenter) {
    const out = [];
    for (const seg of segmenter.segment(text)) out.push(seg.segment);
    return out;
  }
  const out = [];
  let cluster = '';
  let riCount = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (isRegionalIndicator(cp)) {
      if (riCount % 2 === 1) {
        cluster += ch;
        riCount++;
        continue;
      }
      if (cluster) { out.push(cluster); cluster = ''; }
      cluster = ch;
      riCount = 1;
      continue;
    }
    riCount = 0;
    if (cluster && isExtend(cp)) {
      cluster += ch;
    } else {
      if (cluster) out.push(cluster);
      cluster = ch;
    }
  }
  if (cluster) out.push(cluster);
  return out;
}

export function graphemeCount(text) {
  return graphemes(text).length;
}

// True when a cluster cannot be rendered on its own without breaking a
// combining sequence (leading combining marks are unusual but supported).
export function isContinuationCluster(cluster) {
  const first = cluster.codePointAt(0);
  return isExtend(first) || isRegionalIndicator(first);
}
