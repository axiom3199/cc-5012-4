import {
  buildDocument, rebuildDocument, isPending, isConfirmed,
  pendingIds, confirmedCount, stateAt, serializeProject, parseProject,
} from './model.js';
import { CanvasLayout } from './layout.js';
import { renderAt } from './renderer.js';
import { AudioController } from './audio.js';
import { exportTestVideo, downloadBlob, isExportSupported } from './exporter.js';
import { sampleDefinition, timingFromSchedule, buildSampleAudio } from './sample.js';
import { graphemes } from './gcs.js';

const $ = id => document.getElementById(id);

const canvas = $('stage');
const ctx = canvas.getContext('2d');
const audio = new AudioController($('audio'));
const layout = new CanvasLayout({
  width: canvas.width,
  height: canvas.height,
  fontFamily: 'rounded',
  fontSize: 56,
});

const state = {
  rawText: '',
  splitCJK: false,
  doc: { words: [] },
  timings: {},
  selectedId: null,
  expandedId: null,
  mode: 'word',
  title: '',
  audioName: '',
  audioUrl: null,
};

// ---------- lyric / document ----------

function applyLyrics() {
  const prevDoc = state.doc.words.length ? state.doc : null;
  const { doc, timings } = rebuildDocument(
    prevDoc, state.timings, $('lyricsInput').value, { splitCJK: state.splitCJK }
  );
  state.rawText = $('lyricsInput').value;
  state.doc = doc;
  state.timings = timings;
  if (!state.doc.words.some(w => w.id === state.selectedId)) state.selectedId = null;
  relayout();
  renderTable();
  updateStats();
  paint();
}

function relayout() {
  layout.update({
    fontFamily: $('selFont').value,
    fontSize: Number($('fontSize').value),
    ligaturePolicy: $('selLigature').value,
  });
  layout.relayout(state.doc);
  updateLigatureInfo();
}

// Re-measure once webfonts finish arriving so fallback metrics never linger.
if (document.fonts && document.fonts.addEventListener) {
  document.fonts.addEventListener('done', () => {
    if (state.doc.words.length) { relayout(); paint(); }
  });
}

function updateStats() {
  const total = state.doc.words.length;
  const confirmed = confirmedCount(state.doc, state.timings);
  const pending = total - confirmed;
  $('docStats').textContent = total
    ? `共 ${total} 个词实例 · 已确认 ${confirmed} · 待标 ${pending}`
    : '尚无歌词';
}

// ---------- timing table ----------

function occurrenceLabels() {
  const seen = new Map();
  const labels = new Map();
  for (const w of state.doc.words) {
    const n = (seen.get(w.text) || 0) + 1;
    seen.set(w.text, n);
    labels.set(w.id, n);
  }
  const totals = new Map(seen);
  return { labels, totals };
}

function renderTable() {
  const host = $('timingTable');
  host.innerHTML = '';
  if (!state.doc.words.length) {
    host.innerHTML = '<p class="hint" style="padding:10px">先在上方输入歌词并点击“应用歌词”。</p>';
    return;
  }
  const { labels, totals } = occurrenceLabels();
  const t = audio.currentTime || 0;

  state.doc.words.forEach((w, idx) => {
    const rec = state.timings[w.id];
    const pending = isPending(rec);
    const row = document.createElement('div');
    row.className = 'tword' + (pending ? ' pending' : '') + (state.selectedId === w.id ? ' active' : '');
    row.dataset.id = w.id;

    const repeat = totals.get(w.text) > 1 ? `#${labels.get(w.id)}` : '';
    const isActiveNow = !pending && t >= rec.start && t < rec.end;

    row.innerHTML = `
      <span class="idx">${idx + 1}</span>
      <span class="tok" title="${w.text}">${escapeHtml(w.text)}
        <span class="inst">${repeat}</span>
      </span>
      <input data-field="start" type="number" step="0.01" min="0"
        value="${pending ? '' : rec.start.toFixed(2)}" placeholder="起点" />
      <span class="badge ${pending ? 'pending-badge' : 'ok-badge'}">${pending ? '待标' : '已确认'}</span>
      <input data-field="end" type="number" step="0.01" min="0"
        value="${pending ? '' : rec.end.toFixed(2)}" placeholder="终点" />
      <button class="chars-toggle" type="button">逐字</button>
    `;
    if (isActiveNow) row.classList.add('active');

    row.addEventListener('click', ev => {
      if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'BUTTON') return;
      state.selectedId = w.id;
      renderTable();
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
    host.appendChild(row);

    if (state.expandedId === w.id) {
      host.appendChild(buildCharEditor(w, rec));
    }
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
  note.textContent = '逐字时间以字素簇为单位；未填写的字不参与逐字高亮，只显示整词高亮。';
  wrap.appendChild(note);
  return wrap;
}

function setTimingField(id, field, value) {
  if (value === null || !Number.isFinite(value) || value < 0) {
    delete state.timings[id];
  } else {
    if (!state.timings[id]) state.timings[id] = { start: value, end: value + 0.3, chars: null };
    state.timings[id][field] = value;
    // Keep the interval well-formed instead of painting an inverted range.
    if (state.timings[id].end <= state.timings[id].start) {
      if (field === 'start') state.timings[id].end = value + 0.3;
      else state.timings[id].start = Math.max(0, value - 0.3);
    }
  }
  updateStats();
  paint();
  renderTable();
}

function setCharTiming(id, ci, field, value) {
  if (!state.timings[id]) return;
  const rec = state.timings[id];
  if (!Array.isArray(rec.chars)) {
    rec.chars = graphemes(state.doc.words.find(w => w.id === id).text)
      .map(() => ({ start: null, end: null }));
  }
  if (value === null) {
    rec.chars[ci][field] = null;
  } else {
    rec.chars[ci][field] = value;
  }
  paint();
}

// ---------- marking from playback head ----------

function defaultTargetId() {
  if (state.selectedId) return state.selectedId;
  const t = audio.currentTime;
  const pending = pendingIds(state.doc, state.timings);
  const upcoming = pending
    .map(id => state.doc.words.find(w => w.id === id))
    .find(w => {
      const rec = state.timings[w.id];
      return !rec || rec.start == null || rec.start >= t;
    });
  return (upcoming || state.doc.words.find(w => isPending(state.timings[w.id])) || state.doc.words[0])?.id || null;
}

function markStart() {
  const id = defaultTargetId();
  if (!id) return;
  const t = audio.currentTime;
  const prev = state.timings[id] || { start: t, end: t + 0.3, chars: null };
  prev.start = t;
  if (!Number.isFinite(prev.end) || prev.end <= t) prev.end = t + 0.3;
  state.timings[id] = prev;
  state.selectedId = id;
  afterTimingChange();
}

function markEnd() {
  const id = state.selectedId || defaultTargetId();
  if (!id) return;
  const t = audio.currentTime;
  const prev = state.timings[id] || { start: Math.max(0, t - 0.3), end: t, chars: null };
  prev.end = t;
  if (!Number.isFinite(prev.start) || prev.start >= t) prev.start = Math.max(0, t - 0.3);
  state.timings[id] = prev;
  state.selectedId = id;
  afterTimingChange();
}

// One-tap stamping: closes the previous confirmed word at t and opens the
// target word at the same t — natural for singing along.
function stamp() {
  const t = audio.currentTime;
  const targetId = defaultTargetId();
  if (!targetId) return;
  const targetIdx = state.doc.words.findIndex(w => w.id === targetId);
  for (let i = targetIdx - 1; i >= 0; i--) {
    const rec = state.timings[state.doc.words[i].id];
    if (!rec || !Number.isFinite(rec.start)) continue;
    if (!Number.isFinite(rec.end) || rec.end < t) {
      rec.end = t;
    }
    break;
  }
  const existing = state.timings[targetId];
  state.timings[targetId] = {
    start: t,
    end: existing && Number.isFinite(existing.end) && existing.end > t
      ? existing.end
      : t + 0.3,
    chars: existing?.chars ?? null,
  };
  state.selectedId = targetId;
  afterTimingChange();
}

function clearTiming() {
  if (!state.selectedId) return;
  delete state.timings[state.selectedId];
  afterTimingChange();
}

function afterTimingChange() {
  updateStats();
  renderTable();
  paint();
}

// ---------- rendering / playback loop ----------

function paint() {
  renderAt(ctx, {
    layout,
    doc: state.doc,
    timings: state.timings,
    time: audio.currentTime || 0,
    mode: state.mode,
    title: state.title,
    duration: audio.duration,
  });
}

function tick() {
  const t = audio.currentTime;
  if (audio.duration) {
    $('seek').value = String(Math.round((t / audio.duration) * 1000));
  }
  $('clock').textContent = `${fmt(t)} / ${fmt(audio.duration)}`;
  paint();
  syncActiveRow(t);
  requestAnimationFrame(tick);
}

let lastActiveId = null;
function syncActiveRow(t) {
  const { activeId } = stateAt(state.doc, state.timings, t);
  if (activeId === lastActiveId) return;
  lastActiveId = activeId;
  const host = $('timingTable');
  host.querySelectorAll('.tword').forEach(el => {
    el.classList.toggle('active', el.dataset.id === activeId || el.dataset.id === state.selectedId);
  });
}

audio.onSeek(() => {
  // Scrubbing must immediately restore the correct highlight — paint() runs
  // every frame, and we force one synchronously here as well.
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
  const merged = layout.result.words.filter(w => w.hasMergedRuns);
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

// ---------- sample / audio / project / export ----------

async function loadSample() {
  const def = sampleDefinition();
  state.title = def.title;
  state.rawText = def.rawText;
  state.splitCJK = false;
  $('lyricsInput').value = def.rawText;
  $('chkSplitCJK').checked = false;

  const doc = buildDocument(def.rawText, { splitCJK: false });
  state.doc = doc;
  state.timings = timingFromSchedule(doc, def);
  state.selectedId = null;
  state.expandedId = null;

  const blob = await buildSampleAudio(def);
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.audioUrl = URL.createObjectURL(blob);
  state.audioName = '内置测试曲（合成）.wav';
  $('audioName').textContent = state.audioName;
  await audio.loadObjectUrl(state.audioUrl);

  relayout();
  renderTable();
  updateStats();
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
  const blob = new Blob([serializeProject({
    rawText: state.rawText,
    splitCJK: state.splitCJK,
    font: { family: $('selFont').value, size: Number($('fontSize').value), policy: $('selLigature').value },
    timings: state.timings,
    audioName: state.audioName,
  })], { type: 'application/json' });
  downloadBlob(blob, 'karaoke-project.json');
}

function loadProject(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const p = parseProject(reader.result);
      state.rawText = p.rawText;
      state.splitCJK = p.splitCJK;
      state.timings = p.timings;
      $('lyricsInput').value = p.rawText;
      $('chkSplitCJK').checked = p.splitCJK;
      if (p.font) {
        $('selFont').value = p.font.family || 'rounded';
        $('fontSize').value = p.font.size || 56;
        $('fontSizeVal').textContent = `${$('fontSize').value}px`;
        $('selLigature').value = p.font.policy || 'atomic-if-merged';
      }
      if (p.audioName) {
        state.audioName = p.audioName;
        $('audioName').textContent = p.audioName;
      }
      applyLyrics();
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
  $('btnExport').disabled = true;
  $('exportProgress').textContent = '导出中 0%';
  try {
    const blob = await exportTestVideo({
      canvas, audio, layout,
      doc: state.doc,
      timings: state.timings,
      mode: state.mode,
      title: state.title,
      fps: 30,
      onProgress: p => {
        $('exportProgress').textContent = `导出中 ${Math.round(p * 100)}%`;
      },
    });
    downloadBlob(blob, `karaoke-${Date.now()}.webm`);
    $('exportProgress').textContent = '导出完成';
  } catch (err) {
    console.error(err);
    $('exportProgress').textContent = '导出失败';
    alert(`导出失败：${err.message}`);
  } finally {
    $('btnExport').disabled = false;
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

$('btnSample').addEventListener('click', loadSample);
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
  if (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA') return;
  if (ev.key === 'i' || ev.key === 'I') markStart();
  if (ev.key === 'o' || ev.key === 'O') markEnd();
  if (ev.key === ' ') { ev.preventDefault(); $('btnPlay').click(); }
});

// ---------- boot ----------

applyLyrics();
requestAnimationFrame(tick);
