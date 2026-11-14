// Test-video export.
//
// The exported video is produced from the same canvas and the same
// renderAt(time) function used for on-screen preview. Frame timing comes from
// the audio element's currentTime via requestAnimationFrame: every captured
// frame is labeled with the real audio clock, and the same label drives
// highlight resolution. A canvas.captureStream(fps) supplies the video track
// while a MediaStreamDestination on the shared AudioContext supplies the
// audio track, so audio, frame clock and highlight clock cannot drift apart.
//
// An export runs from a frozen snapshot (part selection, view modes and layout
// version). Toggling parts or editing the layout while the recorder runs
// cannot change the output, and a result arriving after a newer export was
// started is rejected by the caller via the generation guard in app.js.

import { renderAt } from './renderer.js';
import { findOverlaps } from './model.js';

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

export function isExportSupported() {
  return typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    'captureStream' in HTMLCanvasElement.prototype;
}

// Pre-export validation. Intra-part timeline overlaps and unresolved layout
// conflicts block the export with the actual conflict data; cross-part
// overlaps are legitimate duet content and never block.
export function validateExport({ doc, timings, parts, layoutResult }) {
  const errors = [];
  const { intra, cross } = findOverlaps(doc, timings, parts.map(p => p.id));
  for (const c of intra) {
    errors.push(`声部 ${c.part} 时间重叠：“${c.a.text}”与“${c.b.text}”在 ${c.start.toFixed(2)}–${c.end.toFixed(2)}s 同时演唱`);
  }
  for (const c of (layoutResult?.conflicts || [])) {
    errors.push(c.message);
  }
  return {
    ok: errors.length === 0,
    errors,
    crossPartOverlaps: cross,
    intraPartOverlaps: intra,
    layoutConflicts: layoutResult?.conflicts || [],
  };
}

// Freeze everything that identifies the rendered output. The same object is
// passed to renderAt during export and can be saved as a sidecar manifest.
export function captureExportSnapshot({
  doc, timings, parts, partViews, focusPart,
  layoutResult, mode, title, font,
}) {
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    layoutVersion: layoutResult.layoutVersion,
    focusPart,
    partViews: JSON.parse(JSON.stringify(partViews)),
    parts: parts.map(p => ({ ...p })),
    mode,
    title,
    font: font ? { ...font } : null,
    wordCount: doc.words.length,
    timingIds: Object.keys(timings).sort(),
  };
}

export async function exportTestVideo({
  canvas, audio, layout, doc, timings,
  mode, title, fps = 30, onProgress,
  parts = null, partViews = null,
}) {
  if (!isExportSupported()) {
    throw new Error('当前浏览器不支持 MediaRecorder / captureStream，无法导出视频');
  }
  const ctx = canvas.getContext('2d');
  const audioCtx = audio.ensureGraph();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  const mimeType = pickMimeType();
  const videoStream = canvas.captureStream(fps);
  const combined = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...audio.streamDest.stream.getAudioTracks(),
  ]);
  const recorder = new MediaRecorder(
    combined,
    mimeType ? { mimeType, videoBitsPerSecond: 4_000_000 } : undefined
  );
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };

  const duration = audio.duration;
  // partViews/parts come from the frozen snapshot; live view toggles during
  // recording cannot reach the renderer.
  const paint = t => renderAt(ctx, {
    layout, doc, timings, time: t, mode, title, duration, parts, partViews,
  });

  return new Promise((resolve, reject) => {
    let rafId = 0;
    const stop = () => {
      cancelAnimationFrame(rafId);
      try { recorder.stop(); } catch { /* already stopped */ }
      audio.pause();
    };
    recorder.onerror = ev => { stop(); reject(ev.error || new Error('录制失败')); };
    recorder.onstop = () => {
      const type = mimeType || 'video/webm';
      resolve(new Blob(chunks, { type }));
    };

    audio.seek(0);
    // Paint the t=0 frame before recording starts so the first captured
    // frame already shows the correct state.
    paint(0);

    recorder.start(200);
    audio.play().then(() => {
      const tick = () => {
        const t = audio.currentTime;
        paint(t);
        if (onProgress) onProgress(duration ? Math.min(1, t / duration) : 0);
        if (audio.paused || (duration && t >= duration - 0.05)) {
          // Let the last frame flush, then stop.
          setTimeout(stop, 120);
          return;
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }).catch(err => { stop(); reject(err); });
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
