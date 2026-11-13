// Test-video export.
//
// The exported video is produced from the same canvas and the same
// renderAt(time) function used for on-screen preview. Frame timing comes from
// the audio element's currentTime via requestAnimationFrame: every captured
// frame is labeled with the real audio clock, and the same label drives
// highlight resolution. A canvas.captureStream(fps) supplies the video track
// while a MediaStreamDestination on the shared AudioContext supplies the
// audio track, so audio, frame clock and highlight clock cannot drift apart.

import { renderAt } from './renderer.js';

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

export async function exportTestVideo({
  canvas, audio, layout, doc, timings,
  mode, title, fps = 30, onProgress,
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
  const paint = t => renderAt(ctx, {
    layout, doc, timings, time: t, mode, title, duration,
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
    // frame already shows the correct (pending or first-word) state.
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
