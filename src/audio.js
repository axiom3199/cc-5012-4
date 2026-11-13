// Audio playback clock. The <audio> element's currentTime is the single time
// source used by the live preview; the exporter reads the exact same value via
// its AudioContext source node, so preview and rendered frames share one time
// mapping rather than two drifting clocks.

export class AudioController {
  constructor(audioEl) {
    this.el = audioEl;
    this.ctx = null;
    this.sourceNode = null;
    this.streamDest = null;
    this.monitorGain = null;
    this._onSeek = null;
    this.el.addEventListener('seeked', () => {
      if (this._onSeek) this._onSeek(this.el.currentTime);
    });
  }

  get currentTime() { return this.el.currentTime || 0; }
  get duration() {
    return Number.isFinite(this.el.duration) ? this.el.duration : 0;
  }
  get paused() { return this.el.paused; }

  onSeek(fn) { this._onSeek = fn; }

  async loadObjectUrl(url) {
    this.el.src = url;
    await new Promise((resolve, reject) => {
      this.el.onloadedmetadata = resolve;
      this.el.onerror = () => reject(new Error('音频加载失败'));
    });
  }

  // Lazily create the WebAudio graph used for export capture. The graph
  // passes audio both to the speakers (monitor) and to a MediaStreamDestination
  // (recorder), guaranteeing the recorded track is what was heard.
  ensureGraph() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.sourceNode = this.ctx.createMediaElementSource(this.el);
    this.monitorGain = this.ctx.createGain();
    this.streamDest = this.ctx.createMediaStreamDestination();
    this.sourceNode.connect(this.monitorGain);
    this.monitorGain.connect(this.ctx.destination);
    this.sourceNode.connect(this.streamDest);
    return this.ctx;
  }

  play() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    return this.el.play();
  }
  pause() { this.el.pause(); }
  seek(t) {
    this.el.currentTime = Math.max(0, Math.min(t, this.duration || t));
  }
}
