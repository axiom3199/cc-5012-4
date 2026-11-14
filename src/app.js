import {
  buildMultiPartDocument, rebuildPartDocument, isPending,
  pendingIds, confirmedCount, stateForParts, findOverlaps,
  serializeProject, parseProject, PART_A, PART_B, PART_COLORS,
  defaultParts, wordsOfPart,
} from './model.js';
import { ScoreLayout } from './scorelayout.js';
import { renderAt } from './renderer.js';
import { AudioController } from './audio.js';
import {
  exportTestVideo, downloadBlob, isExportSupported,
  validateExport, captureExportSnapshot,
} from './exporter.js';
import {
  sampleDefinition, timingFromSchedule, buildSampleAudio,
  duetDefinition, timingFromPartSchedules, buildDuetAudio, skewCharSlots,
} from './sample.js';
import { graphemes } from './gcs.js';
import {
  VIEW_SOLO, VIEW_REFERENCE, VIEW_HIDDEN, VIEW_LABELS,
  defaultPartViews, normalizeSelection, reassignSelection,
} from './parts.js';
import {
  ensureCharTimings, validateCharRecord, dragCharBoundary, dragWordEdge,
} from './correction.js';

const $ = id => document.getElementById(id);

const canvas = $('stage');
const ctx = canvas.getContext('2d');
const audio = new AudioController($('audio'));
const score = new ScoreLayout({
  width: canvas.width,
  height: canvas.height,
  fontFamily: 'rounded',
  fontSize: 44,
});

const state = {
  parts: defaultParts(),
  partTexts: { [PART_A]: '', [PART_B]: '' },
  activePart: PART_A,
  splitCJK: false,
  doc: { words: [] },
  timings: {},
  selectedIds: [],
  expandedId: null,
  mode: 'word',
  title: '',
  audioName: '',
  audioUrl: null,
  partViews: defaultPartViews(defaultParts()),
  focusPart: 'all',
  correctingId: null,
  exportGeneration: 0,
};

// ---------- lyric / document ----------

function activePartWords() {
  return wordsOfPart(state.doc, state.activePart);
}

function applyLyrics() {
  const raw = $('lyricsInput').value;
  state.partTexts[state.activePart] = raw;
  const { doc, timings } = rebuildPartDocument(
    state.doc.words.length ? state.doc : null,
    state.timings, state.activePart, raw, { splitCJK: state.splitCJK }
  );
  state.doc = doc;
  // Drop timing records whose instances no longer exist, then keep the
  // surviving per-instance records untouched.
  const liveIds = new Set(state.doc.words.map(w => w.id));
  const merged = {};
  for (const [id, rec] of Object.entries(state.timings)) {
    if (liveIds.has(id)) merged[id] = rec;
  }
  Object.assign(merged, timings);
  state.timings = merged;
  state.selectedIds = state.selectedIds.filter(id => liveIds.has(id));
  relayout();
  renderTable();
  updateStats();
  paint();
}

function relayout() {
  score.update({
    fontFamily: $('selFont').value,
    fontSize: Number($('fontSize').value),
    ligaturePolicy: $('selLigature').value,
    parts: state.parts,
    focusPart: state.focusPart,
  });
  score.relayout(state.doc);
  updateLigatureInfo();
  renderConflicts();
  $('layoutInfo').textContent = `布局版本 v${score.layoutVersion}（导出时固定此版本）`;
}

if (document.fonts && document.fonts.addEventListener) {
  document.fonts.addEventListener('done', () => {
    if (state.doc.words.length) { relayout(); paint(); }
  });
}

function updateStats() {
  const total = state.doc.words.length;
  const confirmed = confirmedCount(state.doc, state.timings);
  const pending = total - confirmed;
  const perPart = state.parts.map(p => `${p.name} ${wordsOfPart(state.doc, p.id).length} 词`).join(' · ');
  $('docStats').textContent = total
    ? `${perPart} · 已确认 ${confirmed} · 待标 ${pending}`
    : '尚无歌词';
}

// ---------- timing table (grouped by part, drag-to-select) ----------

function occurrenceLabels(words) {
  const seen = new Map();
  const labels = new Map();
  for (const w of words) {
    const n = (seen.get(w.text) || 0) + 1;
    seen.set(w.text, n);
    labels.set(w.id, n);
  }
  return { labels, totals: seen };
}

function renderTable() {
  const host = $('timingTable');
  host.innerHTML = '';
  if (!state.doc.words.length) {
    host.innerHTML = '<p class="hint" style="padding:10px">先在上方输入歌词并点击“应用当前声部歌词”。</p>';
    return;
  }
  const t = audio.currentTime || 0;
  const allLabels = occurrenceLabels(state.doc.words);

  for (const part of state.parts) {
    const words = wordsOfPart(state.doc, part.id);
    if (!words.length) continue;
    const header = document.createElement('div');
    header.className = 'part-row-header';
    header.style.borderColor = part.color;
    header.innerHTML = `<span class="part-dot" style="background:${part.color}"></span>${part.name}`;
    host.appendChild(header);

    words.forEach((w, idx) => {
      const rec = state.timings[w.id];
      const pending = isPending(rec);
      const row = document.createElement('div');
      row.className = 'tword' +
        (pending ? ' pending' : '') +
        (state.selectedIds.includes(w.id) ? ' selected' : '');
      row.dataset.id = w.id;
      row.dataset.part = w.part;

      const repeat = allLabels.totals.get(w.text) > 1 ? `#${allLabels.labels.get(w.id)}` : '';
      const isActiveNow = !pending && t >= rec.start && t < rec.end;
      if (isActiveNow) row.classList.add('active');

      row.innerHTML = `
        <span class="idx">${idx + 1}</span>
        <span class="tok" title="${escapeHtml(w.text)}">${escapeHtml(w.text)}
          <span class="inst">${repeat}</span>
        </span>
        <input data-field="start" type="number" step="0.01" min="0"
          value="${pending ? '' : rec.start.toFixed(2)}" placeholder="起点" />
        <span class="badge ${pending ? 'pending-badge' : 'ok-badge'}">${pending ? '待标' : '已确认'}</span>
        <input data-field="end" type="number" step="0.01" min="0"
          value="${pending ? '' : rec.end.toFixed(2)}" placeholder="终点" />
        <button class="chars-toggle" type="button">逐字</button>
      `;
      attachRowEvents(row, w);
      host.appendChild(row);

      if (state.expandedId === w.id) host.appendChild(buildCharEditor(w, rec));
    });
  }
}

function attachRowEvents(row, w) {
  row.addEventListener('click', ev => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'BUTTON') return;
    state.selectedIds = [w.id];
    renderTable();
  });
  // Drag selection across rows (pointer based; works for mouse/touch).
  row.addEventListener('pointerdown', ev => {
    if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'BUTTON') return;
    ev.preventDefault();
    const dragIds = [w.id];
    const host = $('timingTable');
    const move = moveEv => {
      const el = document.elementFromPoint(moveEv.clientX, moveEv.clientY);
      const target = el?.closest?.('.tword');
      if (target && target.dataset.id && !dragIds.includes(target.dataset.id)) {
        dragIds.push(target.dataset.id);
        state.selectedIds = normalizeSelection(state.doc, dragIds);
        host.querySelectorAll('.tword').forEach(r =>
          r.classList.toggle('selected', state.selectedIds.includes(r.dataset.id)));
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (dragIds.length === 1) state.selectedIds = dragIds;
      renderTable();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  row.querySelectorAll('input[type=number]').forEach(inp => {
    inp.addEventListener('change', () => {
      const v = inp.value === '' ? null : Number(inp.value);
      setTimingField(w.id, inp.dataset.field, v);
    });
  });
  row.querySelector('.chars-toggle').addEventListener('click', ev => {
    ev.stopPropagation();
    state.expandedId = state.expandedId === w.id ? null : w.id;
    renderTable();
  });
}

function buildCharEditor(word, rec) {
  const wrap = document.createElement('div');
  wrap.className = 'char-rows';
  const clusters = graphemes(word.text);
  const chars = (rec && Array.isArray(rec.chars)) ? rec.chars : [];
  clusters.forEach((g, i) => {
    const c = chars[i] || {};
    const r = document.createElement('div');
    r.className = 'char-row';
    r.innerHTML = `
      <span class="g" title="字素簇 #${i + 1}">${escapeHtml(g)}</span>
      <input data-char-start="${i}" type="number" step="0.01" min="0"
        value="${c.start != null ? c.start.toFixed(2) : ''}" placeholder="字起点" />
      <input data-char-end="${i}" type="number" step="0.01" min="0"
        value="${c.end != null ? c.end.toFixed(2) : ''}" placeholder="字终点" />
    `;
    r.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('change', () => {
        const isStart = inp.hasAttribute('data-char-start');
        const ci = Number(isStart ? inp.dataset.charStart : inp.dataset.charEnd);
        setCharTiming(word.id, ci, isStart ? 'start' : 'end', inp.value === '' ? null : Number(inp.value));
      });
    });
    wrap.appendChild(r);
  });
  const note = document.createElement('p');
  note.className = 'hint';
  note.textContent = '字素簇为单位；未填写的字不参与逐字高亮。需要图形化拖动请使用下方校正条。';
  wrap.appendChild(note);
  return wrap;
}

function setTimingField(id, field, value) {
  if (value === null || !Number.isFinite(value) || value < 0) {
    delete state.timings[id];
  } else {
    if (!state.timings[id]) state.timings[id] = { start: value, end: value + 0.3, chars: null };
    state.timings[id][field] = value;
    if (state.timings[id].end <= state.timings[id].start) {
      if (field === 'start') state.timings[id].end = value + 0.3;
      else state.timings[id].start = Math.max(0, value - 0.3);
    }
  }
  afterTimingChange();
}

function setCharTiming(id, ci, field, value) {
  if (!state.timings[id]) return;
  const rec = state.timings[id];
  const word = state.doc.words.find(w => w.id === id);
  if (!Array.isArray(rec.chars)) {
    rec.chars = graphemes(word.text).map(() => ({ start: null, end: null }));
  }
  rec.chars[ci][field] = value;
  paint();
}

// ---------- marking from playback head (per active part) ----------

function defaultTargetId() {
  const t = audio.currentTime;
  const pending = pendingIds(
    { words: activePartWords() }, state.timings
  );
  const upcoming = pending
    .map(id => state.doc.words.find(w => w.id === id))
    .find(w => {
      const rec = state.timings[w.id];
      return !rec || rec.start == null || rec.start >= t;
    });
  const partWords = activePartWords();
  return (upcoming || partWords.find(w => isPending(state.timings[w.id])) || partWords[0])?.id || null;
}

function markStart() {
  const id = defaultTargetId();
  if (!id) return;
  const t = audio.currentTime;
  const prev = state.timings[id] || { start: t, end: t + 0.3, chars: null };
  prev.start = t;
  if (!Number.isFinite(prev.end) || prev.end <= t) prev.end = t + 0.3;
  state.timings[id] = prev;
  state.selectedIds = [id];
  afterTimingChange();
}

function markEnd() {
  const id = state.selectedIds[state.selectedIds.length - 1] || defaultTargetId();
  if (!id) return;
  const t = audio.currentTime;
  const prev = state.timings[id] || { start: Math.max(0, t - 0.3), end: t, chars: null };
  prev.end = t;
  if (!Number.isFinite(prev.start) || prev.start >= t) prev.start = Math.max(0, t - 0.3);
  state.timings[id] = prev;
  state.selectedIds = [id];
  afterTimingChange();
}

function stamp() {
  const t = audio.currentTime;
  const targetId = defaultTargetId();
  if (!targetId) return;
  const partWordIds = activePartWords().map(w => w.id);
  const targetIdx = partWordIds.indexOf(targetId);
  for (let i = targetIdx - 1; i >= 0; i--) {
    const rec = state.timings[partWordIds[i]];
    if (!rec || !Number.isFinite(rec.start)) continue;
    if (!Number.isFinite(rec.end) || rec.end < t) rec.end = t;
    break;
  }
  const existing = state.timings[targetId];
  state.timings[targetId] = {
    start: t,
    end: existing && Number.isFinite(existing.end) && existing.end > t ? existing.end : t + 0.3,
    chars: existing?.chars ?? null,
  };
  state.selectedIds = [targetId];
  afterTimingChange();
}

function clearTiming() {
  for (const id of state.selectedIds) delete state.timings[id];
  afterTimingChange();
}

function afterTimingChange() {
  updateStats();
  renderTable();
  renderConflicts();
  if (state.correctingId) renderCorrection();
  paint();
}

// ---------- part assignment from drag selection ----------

function assignSelection(targetPart) {
  const ids = normalizeSelection(state.doc, state.selectedIds);
  if (!ids.length) {
    $('assignHint').textContent = '请先在词表中拖选至少一个词实例。';
    return;
  }
  const result = reassignSelection(state.doc, ids, targetPart, state.parts.map(p => p.id));
  if (!result.ok) {
    $('assignHint').textContent = `切换失败：${result.error}`;
    return;
  }
  // Move raw text too so re-applying a part keeps the same membership.
  syncPartTexts();
  $('assignHint').textContent = result.moved.length
    ? `已将 ${result.moved.length} 个词实例移到${PART_COLORS[targetPart].name}，时间记录保持不变。`
    : '所选词本就属于该声部，未做改动。';
  relayout();
  renderTable();
  updateStats();
  renderConflicts();
  paint();
}

function syncPartTexts() {
  for (const pid of state.parts.map(p => p.id)) {
    const lines = [];
    let currentLine = -1;
    for (const w of wordsOfPart(state.doc, pid)) {
      if (w.line !== currentLine) { lines.push([]); currentLine = w.line; }
      lines[lines.length - 1].push(w.text);
    }
    state.partTexts[pid] = lines.map(l => l.join(' ')).join('\n');
  }
  $('lyricsInput').value = state.partTexts[state.activePart];
}

// ---------- part view panel ----------

function renderPartViewPanel() {
  const host = $('partViewPanel');
  host.innerHTML = '';
  for (const part of state.parts) {
    const row = document.createElement('div');
    row.className = 'part-view-row';
    const view = state.partViews[part.id] || VIEW_SOLO;
    row.innerHTML = `
      <span class="part-name"><span class="part-dot" style="background:${part.color}"></span>${part.name}</span>
      <label>显示模式
        <select data-part-view="${part.id}">
          <option value="${VIEW_SOLO}" ${view === VIEW_SOLO ? 'selected' : ''}>${VIEW_LABELS[VIEW_SOLO]}</option>
          <option value="${VIEW_REFERENCE}" ${view === VIEW_REFERENCE ? 'selected' : ''}>${VIEW_LABELS[VIEW_REFERENCE]}</option>
          <option value="${VIEW_HIDDEN}" ${view === VIEW_HIDDEN ? 'selected' : ''}>${VIEW_LABELS[VIEW_HIDDEN]}</option>
        </select>
      </label>
      <label class="check"><input type="radio" name="focusPart" value="${part.id}"
        ${state.focusPart === part.id ? 'checked' : ''} /> 只看此声部</label>
    `;
    host.appendChild(row);
  }
  const allRow = document.createElement('div');
  allRow.className = 'part-view-row';
  allRow.innerHTML = `<span></span><label class="check"><input type="radio" name="focusPart" value="all"
    ${state.focusPart === 'all' ? 'checked' : ''} /> 同时查看全部声部（稳定泳道）</label>`;
  host.appendChild(allRow);

  host.querySelectorAll('select[data-part-view]').forEach(sel => {
    sel.addEventListener('change', () => {
      state.partViews[sel.dataset.partView] = sel.value;
      paint();
    });
  });
  host.querySelectorAll('input[name=focusPart]').forEach(radio => {
    radio.addEventListener('change', () => {
      state.focusPart = radio.value;
      relayout();
      paint();
    });
  });
}

// ---------- conflict reporting ----------

function renderConflicts() {
  const box = $('conflictBox');
  const { intra, cross } = findOverlaps(state.doc, state.timings, state.parts.map(p => p.id));
  const layoutConflicts = score.result.conflicts || [];
  const lines = [];
  for (const c of intra) {
    lines.push(`[冲突] 同声部时间冲突：声部 ${c.part} 的“${c.a.text}”与“${c.b.text}”在 ${c.start.toFixed(2)}–${c.end.toFixed(2)}s 重叠（单声部不能同时唱两个词）`);
  }
  for (const c of layoutConflicts) lines.push(`[冲突] 布局冲突：${c.message}`);
  for (const c of cross) {
    lines.push(`[正常] 跨声部重叠（对唱/轮唱）：${c.a.part}“${c.a.text}” × ${c.b.part}“${c.b.text}” 在 ${c.start.toFixed(2)}–${c.end.toFixed(2)}s`);
  }
  if (!lines.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = lines.map(l => `<div>${escapeHtml(l)}</div>`).join('');
}

// ---------- correction strip (driven by the char sing-along kernel) ----------

function startCorrection() {
  const id = state.selectedIds[state.selectedIds.length - 1];
  const word = state.doc.words.find(w => w.id === id);
  if (!word) {
    setCorrectStatus('请先在词表点选一个词实例。', true);
    return;
  }
  if (isPending(state.timings[word.id])) {
    setCorrectStatus(`“${word.text}”还没有整词时间，先标记起点/终点后再校正音节。`, true);
    return;
  }
  state.correctingId = word.id;
  // Materialize editable grapheme slots on the real record (pending slots are
  // seeded once, explicitly, when correction starts).
  state.timings[word.id] = ensureCharTimings(word, state.timings[word.id]);
  // Enter char mode so the canvas highlight proves the corrected ranges.
  state.mode = 'char';
  $('chkCharMode').checked = true;
  renderCorrection();
  paint();
}

function renderCorrection() {
  const strip = $('correctionStrip');
  const word = state.doc.words.find(w => w.id === state.correctingId);
  if (!word) {
    strip.innerHTML = '<p class="hint">未选择校正词。</p>';
    $('correctWord').textContent = '';
    return;
  }
  const rec = ensureCharTimings(word, state.timings[word.id]);
  const clusters = graphemes(word.text);
  $('correctWord').textContent = `校正词：${word.text}（${rec.start.toFixed(2)}–${rec.end.toFixed(2)}s，${clusters.length} 个音节）`;

  const span = rec.end - rec.start;
  strip.innerHTML = '';
  const bar = document.createElement('div');
  bar.className = 'syllable-bar';

  const head = document.createElement('div');
  head.className = 'play-head';
  bar.appendChild(head);

  rec.chars.forEach((c, i) => {
    const leftPct = ((c.start - rec.start) / span) * 100;
    const widthPct = ((c.end - c.start) / span) * 100;
    const slot = document.createElement('div');
    slot.className = 'syllable-slot';
    slot.style.left = `${leftPct}%`;
    slot.style.width = `${widthPct}%`;
    slot.innerHTML = `<span class="syllable-glyph">${escapeHtml(clusters[i])}</span>
      <span class="syllable-time">${c.start.toFixed(2)}–${c.end.toFixed(2)}</span>`;
    bar.appendChild(slot);

    if (i > 0) {
      const boundary = document.createElement('div');
      boundary.className = 'syllable-boundary';
      boundary.style.left = `${leftPct}%`;
      boundary.title = `拖动调整第 ${i} / ${i + 1} 个音节边界（${c.start.toFixed(2)}s）`;
      attachBoundaryDrag(boundary, word, rec, i, bar, span);
      bar.appendChild(boundary);
    }
  });
  strip.appendChild(bar);

  const edgeRow = document.createElement('div');
  edgeRow.className = 'row';
  edgeRow.innerHTML = `
    <button type="button" id="btnDragWordStart">拖到播放头：整词起点</button>
    <button type="button" id="btnDragWordEnd">拖到播放头：整词终点</button>
    <button type="button" id="btnSeekCorrection">播放头跳到所选边界时间</button>
  `;
  strip.appendChild(edgeRow);
  edgeRow.querySelector('#btnDragWordStart').addEventListener('click', () => applyWordEdge('start'));
  edgeRow.querySelector('#btnDragWordEnd').addEventListener('click', () => applyWordEdge('end'));
  edgeRow.querySelector('#btnSeekCorrection').addEventListener('click', () => {
    const t = audio.currentTime;
    audio.seek(t);
    paint();
  });

  const check = validateCharRecord(word, state.timings[word.id]);
  setCorrectStatus(check.ok ? '音节区间有效，可播放核对高亮字形与声音是否对应。' : check.errors.join('；'), !check.ok);
  updatePlayHead(head, rec, span, bar);
}

function attachBoundaryDrag(boundary, word, rec, index, bar, span) {
  boundary.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    const rect = bar.getBoundingClientRect();
    const move = moveEv => {
      const live = state.timings[word.id];
      const liveSpan = live.end - live.start;
      const ratio = Math.max(0, Math.min(1, (moveEv.clientX - rect.left) / rect.width));
      const newTime = live.start + ratio * liveSpan;
      const result = dragCharBoundary(word, live, index, newTime, 'both');
      if (!result.ok) {
        setCorrectStatus(`边界未移动：${result.error}`, true);
        return;
      }
      state.timings[word.id] = result.rec;
      setCorrectStatus(`边界已更新到 ${newTime.toFixed(2)}s，高亮区间已同步。`, false);
      renderCorrection();
      paint();
      renderTable();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function applyWordEdge(edge) {
  const word = state.doc.words.find(w => w.id === state.correctingId);
  if (!word) return;
  const result = dragWordEdge(word, state.timings[word.id], edge, audio.currentTime);
  if (!result.ok) {
    setCorrectStatus(`调整失败：${result.error}`, true);
    return;
  }
  state.timings[word.id] = result.rec;
  setCorrectStatus(`整词${edge === 'start' ? '起点' : '终点'}已对齐播放头 ${audio.currentTime.toFixed(2)}s。`, false);
  renderCorrection();
  renderTable();
  paint();
}

function updatePlayHead(headEl, rec, span) {
  const t = audio.currentTime;
  if (t < rec.start || t > rec.end) { headEl.style.display = 'none'; return; }
  headEl.style.display = '';
  headEl.style.left = `${((t - rec.start) / span) * 100}%`;
}

function setCorrectStatus(msg, isError) {
  const el = $('correctStatus');
  el.textContent = msg;
  el.classList.toggle('error', Boolean(isError));
}

// ---------- rendering / playback loop ----------

function paint() {
  renderAt(ctx, {
    layout: score,
    doc: state.doc,
    timings: state.timings,
    time: audio.currentTime || 0,
    mode: state.mode,
    title: state.title,
    duration: audio.duration,
    parts: visibleParts(),
    partViews: state.partViews,
  });
}

function visibleParts() {
  if (state.focusPart === 'all') return state.parts;
  return state.parts.filter(p => p.id === state.focusPart);
}

function tick() {
  const t = audio.currentTime;
  if (audio.duration) $('seek').value = String(Math.round((t / audio.duration) * 1000));
  $('clock').textContent = `${fmt(t)} / ${fmt(audio.duration)}`;
  paint();
  syncActiveRows(t);
  if (state.correctingId) {
    const head = document.querySelector('.correction-strip .play-head');
    const word = state.doc.words.find(w => w.id === state.correctingId);
    if (head && word) {
      const rec = state.timings[word.id];
      if (rec) updatePlayHead(head, rec, rec.end - rec.start);
    }
  }
  requestAnimationFrame(tick);
}

const lastActive = new Map();
function syncActiveRows(t) {
  const states = stateForParts(state.doc, state.timings, t, state.parts.map(p => p.id));
  const activeIds = new Set(Object.values(states).map(s => s.activeId).filter(Boolean));
  let changed = false;
  for (const [pid, s] of Object.entries(states)) {
    if (lastActive.get(pid) !== s.activeId) { lastActive.set(pid, s.activeId); changed = true; }
  }
  if (!changed) return;
  $('timingTable').querySelectorAll('.tword').forEach(el => {
    el.classList.toggle('active', activeIds.has(el.dataset.id));
  });
}

audio.onSeek(() => {
  // Scrubbing must immediately restore the correct per-part highlights.
  paint();
  renderTable();
});

function fmt(sec) {
  if (!Number.isFinite(sec)) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// ---------- ligature diagnostics ----------

function updateLigatureInfo() {
  const merged = score.result.words.filter(w => w.hasMergedRuns);
  if (!merged.length) {
    $('ligatureInfo').textContent = '未检测到合并字形（连字/ZWJ/复杂塑形）。';
    return;
  }
  const detail = merged.slice(0, 6).map(w => {
    const n = w.runs.filter(r => r.atomic).length;
    return `“${w.word.text}”含 ${n} 个原子塑形段`;
  }).join('；');
  const policy = $('selLigature').value === 'atomic-if-merged'
    ? '整段原子高亮，绝不切开单个字形'
    : '按测量前缀切割（仅未合并簇逐字，合并段仍整段）';
  $('ligatureInfo').textContent = `${detail}${merged.length > 6 ? ' 等' : ''}。策略：${policy}。`;
}

// ---------- samples / audio / project / export ----------

async function loadSoloSample() {
  resetToParts(defaultParts());
  const def = sampleDefinition();
  state.title = def.title;
  state.splitCJK = false;
  $('chkSplitCJK').checked = false;
  state.partTexts = { [PART_A]: def.rawText, [PART_B]: '' };
  $('lyricsInput').value = def.rawText;

  state.doc = buildMultiPartDocument(
    { [PART_A]: def.rawText, [PART_B]: '' },
    { splitCJK: false, parts: [PART_A, PART_B] }
  );
  state.timings = timingFromSchedule(
    { words: wordsOfPart(state.doc, PART_A) }, def
  );
  finishSampleLoad('内置独唱测试曲（合成）.wav', await buildSampleAudio(def));
}

async function loadDuetSample() {
  resetToParts(defaultParts());
  const def = duetDefinition();
  state.title = def.title;
  state.splitCJK = def.splitCJK;
  $('chkSplitCJK').checked = def.splitCJK;
  state.partTexts = { ...def.partTexts };
  $('lyricsInput').value = def.partTexts[state.activePart];

  state.doc = buildMultiPartDocument(def.partTexts, {
    splitCJK: def.splitCJK, parts: [PART_A, PART_B],
  });
  state.timings = timingFromPartSchedules(state.doc, def, [PART_A, PART_B]);
  // Correction demo: skew the per-grapheme slots of part A's "star" so the
  // user has an obvious boundary to drag while hearing the even synth notes.
  const star = wordsOfPart(state.doc, PART_A).find(w => w.text === 'star');
  if (star) {
    const rec = state.timings[star.id];
    rec.chars = skewCharSlots(star.text, rec.start, rec.end);
  }
  finishSampleLoad('对唱轮唱测试曲（立体声合成）.wav', await buildDuetAudio(def));
}

function resetToParts(parts) {
  state.parts = parts;
  state.partViews = defaultPartViews(parts);
  state.focusPart = 'all';
  state.selectedIds = [];
  state.expandedId = null;
  state.correctingId = null;
  state.activePart = PART_A;
  document.querySelectorAll('.part-tab').forEach(b =>
    b.classList.toggle('on', b.dataset.part === PART_A));
  renderPartViewPanel();
}

async function finishSampleLoad(name, blob) {
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioUrl = URL.createObjectURL(blob);
  state.audioName = name;
  $('audioName').textContent = name;
  await audio.loadObjectUrl(state.audioUrl);
  relayout();
  renderTable();
  updateStats();
  renderConflicts();
  paint();
}

async function loadUserAudio(file) {
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioUrl = URL.createObjectURL(file);
  state.audioName = file.name;
  $('audioName').textContent = file.name;
  await audio.loadObjectUrl(state.audioUrl);
  paint();
}

function saveProject() {
  syncPartTexts();
  const blob = new Blob([serializeProject({
    version: 2,
    rawText: state.partTexts[PART_A],
    splitCJK: state.splitCJK,
    font: { family: $('selFont').value, size: Number($('fontSize').value), policy: $('selLigature').value },
    timings: state.timings,
    audioName: state.audioName,
    parts: state.parts,
    partTexts: state.partTexts,
    layoutVersion: score.layoutVersion,
  })], { type: 'application/json' });
  downloadBlob(blob, 'karaoke-project-v2.json');
}

function loadProject(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const { project: p, migrated } = parseProject(reader.result);
      state.splitCJK = p.splitCJK;
      state.timings = p.timings;
      state.parts = p.parts;
      state.partTexts = p.partTexts;
      state.partViews = defaultPartViews(p.parts);
      state.focusPart = 'all';
      state.selectedIds = [];
      state.correctingId = null;
      $('lyricsInput').value = state.partTexts[state.activePart] ?? '';
      $('chkSplitCJK').checked = p.splitCJK;
      if (p.font) {
        $('selFont').value = p.font.family || 'rounded';
        $('fontSize').value = p.font.size || 44;
        $('fontSizeVal').textContent = `${$('fontSize').value}px`;
        $('selLigature').value = p.font.policy || 'atomic-if-merged';
      }
      if (p.audioName) {
        state.audioName = p.audioName;
        $('audioName').textContent = p.audioName;
      }
      state.doc = buildMultiPartDocument(state.partTexts, {
        splitCJK: state.splitCJK, parts: state.parts.map(x => x.id),
      });
      if (p.layoutVersion > 1) score.layoutVersion = p.layoutVersion;
      renderPartViewPanel();
      relayout();
      renderTable();
      updateStats();
      renderConflicts();
      paint();
      if (migrated) alert('已将初版独唱工程自动作为单声部（声部 A）载入，声部 B 留空，原始时间不变。');
    } catch (err) {
      alert(err.message);
    }
  };
  reader.readAsText(file);
}

async function doExport() {
  if (!state.doc.words.length) { alert('请先输入歌词。'); return; }
  if (!audio.duration) { alert('请先载入音频。'); return; }
  if (!isExportSupported()) { alert('当前浏览器不支持视频导出（需要 MediaRecorder 与 canvas.captureStream）。'); return; }

  const validation = validateExport({
    doc: state.doc, timings: state.timings,
    parts: visibleParts(), layoutResult: score.result,
  });
  if (!validation.ok) {
    alert(`导出校验未通过：\n${validation.errors.join('\n')}`);
    return;
  }

  // Freeze the part selection, view modes and layout version. Everything
  // after this point renders from the snapshot, not from live UI state.
  const snapshot = captureExportSnapshot({
    doc: state.doc, timings: state.timings,
    parts: visibleParts(), partViews: state.partViews,
    focusPart: state.focusPart, layoutResult: score.result,
    mode: state.mode, title: state.title,
    font: { family: $('selFont').value, size: Number($('fontSize').value), policy: $('selLigature').value },
  });
  const generation = ++state.exportGeneration;
  $('btnExport').disabled = true;
  $('exportProgress').textContent = `导出中 0%（布局 v${snapshot.layoutVersion}）`;

  try {
    const blob = await exportTestVideo({
      canvas, audio, layout: score,
      doc: state.doc, timings: state.timings,
      mode: snapshot.mode, title: snapshot.title, fps: 30,
      parts: snapshot.parts, partViews: snapshot.partViews,
      onProgress: p => {
        if (generation !== state.exportGeneration) return;
        $('exportProgress').textContent = `导出中 ${Math.round(p * 100)}%（布局 v${snapshot.layoutVersion}）`;
      },
    });
    // Late result from a superseded export run must not touch the preview.
    if (generation !== state.exportGeneration) {
      $('exportProgress').textContent = '该导出结果已过期，已丢弃（预览已被更新）。';
      return;
    }
    downloadBlob(blob, `karaoke-duet-v${snapshot.layoutVersion}-${Date.now()}.webm`);
    downloadBlob(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }),
      `karaoke-export-manifest-v${snapshot.layoutVersion}.json`);
    $('exportProgress').textContent =
      `导出完成：声部 ${snapshot.parts.map(p => p.id).join('/')} · 布局 v${snapshot.layoutVersion}（含清单文件）`;
  } catch (err) {
    console.error(err);
    if (generation === state.exportGeneration) {
      $('exportProgress').textContent = '导出失败';
      alert(`导出失败：${err.message}`);
    }
  } finally {
    if (generation === state.exportGeneration) $('btnExport').disabled = false;
    audio.seek(0);
    paint();
  }
}

// ---------- helpers ----------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- events ----------

$('btnSample').addEventListener('click', loadSoloSample);
$('btnDuet').addEventListener('click', loadDuetSample);
$('btnAudio').addEventListener('click', () => {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'audio/*';
  inp.onchange = () => inp.files[0] && loadUserAudio(inp.files[0]);
  inp.click();
});
$('btnApplyLyrics').addEventListener('click', applyLyrics);
$('chkSplitCJK').addEventListener('change', ev => {
  state.splitCJK = ev.target.checked;
  applyLyrics();
});
document.querySelectorAll('.part-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    state.activePart = tab.dataset.part;
    document.querySelectorAll('.part-tab').forEach(b => b.classList.toggle('on', b === tab));
    $('lyricsInput').value = state.partTexts[state.activePart] ?? '';
  });
});
$('btnPlay').addEventListener('click', () => {
  if (audio.paused) { audio.play(); $('btnPlay').textContent = '⏸ 暂停'; }
  else { audio.pause(); $('btnPlay').textContent = '▶ 播放'; }
});
$('audio').addEventListener('play', () => { $('btnPlay').textContent = '⏸ 暂停'; });
$('audio').addEventListener('pause', () => { $('btnPlay').textContent = '▶ 播放'; });
$('seek').addEventListener('input', ev => {
  if (!audio.duration) return;
  audio.seek((Number(ev.target.value) / 1000) * audio.duration);
});
$('btnMarkStart').addEventListener('click', markStart);
$('btnMarkEnd').addEventListener('click', markEnd);
$('btnStamp').addEventListener('click', stamp);
$('btnClearTiming').addEventListener('click', clearTiming);
$('chkCharMode').addEventListener('change', ev => {
  state.mode = ev.target.checked ? 'char' : 'word';
  paint();
});
$('btnAssignA').addEventListener('click', () => assignSelection(PART_A));
$('btnAssignB').addEventListener('click', () => assignSelection(PART_B));
$('btnStartCorrect').addEventListener('click', startCorrection);
$('selFont').addEventListener('change', () => { relayout(); paint(); });
$('fontSize').addEventListener('input', ev => {
  $('fontSizeVal').textContent = `${ev.target.value}px`;
  relayout();
  paint();
});
$('selLigature').addEventListener('change', () => { relayout(); paint(); });
$('btnSave').addEventListener('click', saveProject);
$('btnLoadProj').addEventListener('click', () => $('fileProject').click());
$('fileProject').addEventListener('change', ev => ev.target.files[0] && loadProject(ev.target.files[0]));
$('btnExport').addEventListener('click', doExport);

document.addEventListener('keydown', ev => {
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'SELECT') return;
  if (ev.key === 'i' || ev.key === 'I') markStart();
  if (ev.key === 'o' || ev.key === 'O') markEnd();
  if (ev.key === ' ') { ev.preventDefault(); $('btnPlay').click(); }
});

// ---------- boot ----------

renderPartViewPanel();
document.querySelector('.part-tab[data-part="A"]').classList.add('on');
applyLyrics();
requestAnimationFrame(tick);
