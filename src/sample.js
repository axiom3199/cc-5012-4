// Built-in test material.
//
// The audio is synthesized offline (no external assets needed) so the whole
// pipeline — audio clock, highlighting, font fallback, export — is testable
// end to end. The lyric intentionally covers every tricky case:
//   nǎ / nǎ / nē     combining diacritics, repeated instances, long tone
//   fish             a word deliberately left pending (no note, no timing)
//   👨‍👩‍👧 / 🏳️‍🌈        ZWJ emoji and flag ZWJ sequences (one grapheme each)
//   twinkle | little cross-line phrase with continuous timing
//   flight / fluff   Latin ligatures fl, ffi, ffl
//   la la la ...     repeated chorus, each instance timed separately

// Decomposed pinyin ('a' + combining caron, 'e' + combining macron) forces
// the pipeline to handle base-mark clusters rather than precomposed letters.
const NA = 'n' + 'a' + '̌';
const NE = 'n' + 'e' + '̄';

const SAMPLE_RAW = [
  `${NA} ${NA} ${NE} fish`,
  'shine float 👨‍👩‍👧 🏳️‍🌈',
  'twinkle',
  'little star flight',
  'fluff la la la',
  'la la la',
].join('\n');

// One entry per word in document order. null means the word is left pending.
// start/end are authored against the synthesized notes below; a few entries
// also carry grapheme-level times to exercise char-by-char highlighting.
const SCHEDULE = [
  { start: 0.50, end: 0.90 },                 // nǎ
  { start: 1.00, end: 1.40 },                 // nǎ (separate instance)
  { start: 1.50, end: 2.70 },                 // nē long tone
  null,                                       // fish — pending, silence
  { start: 2.90, end: 3.40, chars: true },    // shine
  { start: 3.45, end: 3.95 },                 // float
  { start: 4.00, end: 4.60 },                 // 👨‍👩‍👧
  { start: 4.65, end: 5.25 },                 // 🏳️‍🌈
  { start: 5.40, end: 6.00, chars: true },    // twinkle (line ends here)
  { start: 6.05, end: 6.45 },                 // little — phrase continues
  { start: 6.50, end: 6.90 },                 // star
  { start: 7.00, end: 7.60, chars: true },    // flight (fl ligature)
  { start: 7.70, end: 8.30 },                 // fluff (ffl ligature)
  { start: 8.40, end: 8.70 },                 // la  (chorus A)
  { start: 8.75, end: 9.05 },                 // la
  { start: 9.10, end: 9.40 },                 // la
  { start: 9.80, end: 10.10 },                // la  (chorus B, new instance)
  { start: 10.15, end: 10.45 },               // la
  { start: 10.50, end: 10.80 },               // la
];

const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880.0]; // C5 D5 E5 G5 A5

export function sampleDefinition() {
  return {
    title: '跟唱测试曲',
    rawText: SAMPLE_RAW,
    splitCJK: false,
    schedule: SCHEDULE.map(s => s ? { ...s } : null),
    duration: 11.3,
  };
}

// ---------- duet / round sample ----------
//
// The duet sample deliberately contains every required overlap case:
//   t=0.6  both parts sing "echo" at the same instant (same word, same slot,
//          two independent instances with independent ids/timings)
//   t=2.0  part A holds one long note "hold~~~~" (2.0–4.6) while part B sings
//          two full phrases across it (a long tone spanning another part's
//          two sentences)
//   t=3.4  part B pauses briefly inside its lane; lane order must not swap
//   t=4.2  part B's "round" starts while part A is still holding (round entry)
// Grapheme-level timing is authored on a few words so the correction strip can
// be exercised against the synthesized audio.

export function duetDefinition() {
  const partA = [
    'echo hello hold',
    'star song end',
  ].join('\n');
  // Word order matches time order so per-part stamping stays monotonic.
  const partB = [
    'echo reply one two',
    'one two round done',
  ].join('\n');
  // Entries align with each part's word order; [start, end, chars?].
  const scheduleA = [
    { start: 0.60, end: 1.00, chars: true },  // echo — same word, same slot as B
    { start: 1.10, end: 1.70 },              // hello
    { start: 2.00, end: 4.60 },              // hold — long note spanning B's two phrases
    { start: 4.80, end: 5.30, chars: true }, // star (intentionally skewed per-char slots)
    { start: 5.40, end: 5.90 },              // song
    { start: 6.00, end: 6.50 },              // end
  ];
  const scheduleB = [
    { start: 0.60, end: 1.00, chars: true }, // echo — identical text/time, separate instance
    { start: 1.20, end: 1.80 },              // reply
    { start: 2.00, end: 2.50 },              // one  (phrase 1 under A's long note)
    { start: 2.55, end: 3.10 },              // two
    { start: 3.40, end: 3.80 },              // one  (short 300ms pause before this entry)
    { start: 3.85, end: 4.10 },              // two  (phrase 2, still under A's long note)
    { start: 4.20, end: 4.70, chars: true }, // round — round entry overlaps A's hold
    { start: 5.40, end: 6.00 },              // done
  ];
  return {
    title: '对唱轮唱测试曲',
    splitCJK: true,
    partTexts: { A: partA, B: partB },
    schedules: {
      A: scheduleA.map(s => ({ ...s })),
      B: scheduleB.map(s => ({ ...s })),
    },
    duration: 6.8,
  };
}

// Build a timing table for a multi-part document from per-part schedules.
export function timingFromPartSchedules(doc, def, parts) {
  const timings = {};
  for (const pid of parts) {
    const words = doc.words.filter(w => w.part === pid);
    const schedule = def.schedules[pid] || [];
    words.forEach((w, idx) => {
      const s = schedule[idx];
      if (!s) return;
      const rec = { start: s.start, end: s.end, chars: null };
      if (s.chars) rec.chars = evenCharSlots(w.text, s.start, s.end);
      timings[w.id] = rec;
    });
  }
  return timings;
}

function evenCharSlots(text, start, end) {
  const clusters = graphemeList(text);
  const span = end - start;
  let cursor = start;
  return clusters.map((c, i) => {
    const slot = { start: cursor, end: i === clusters.length - 1 ? end : cursor + span / clusters.length };
    cursor += span / clusters.length;
    return slot;
  });
}

// Intentionally skewed grapheme slots for the correction demo: the first
// grapheme gets 60% of the span, so dragging the boundary back to an even
// split produces an audible/visible highlight change against the audio.
export function skewCharSlots(text, start, end) {
  const clusters = graphemeList(text);
  if (clusters.length < 2) return evenCharSlots(text, start, end);
  const firstEnd = start + (end - start) * 0.6;
  const rest = (end - firstEnd) / (clusters.length - 1);
  let cursor = start;
  return clusters.map((c, i) => {
    if (i === 0) { cursor = firstEnd; return { start, end: firstEnd }; }
    const slot = { start: cursor, end: i === clusters.length - 1 ? end : cursor + rest };
    cursor += rest;
    return slot;
  });
}

// Expand word-level entries into grapheme-level timing when requested.
// Only the authored sample uses this helper; the editor never invents
// per-grapheme times on its own.
export function timingFromSchedule(doc, def) {
  const timings = {};
  doc.words.forEach((w, idx) => {
    const s = def.schedule[idx];
    if (!s) return; // stays pending — no averaging, no fabricated alignment
    const rec = { start: s.start, end: s.end, chars: null };
    if (s.chars) {
      // Decompose by grapheme clusters so combining marks never split.
      const clusters = graphemeList(w.text);
      const span = s.end - s.start;
      let cursor = s.start;
      rec.chars = clusters.map((c, i) => {
        const dur = span / clusters.length;
        const recC = { start: cursor, end: i === clusters.length - 1 ? s.end : cursor + dur };
        cursor += dur;
        return recC;
      });
    }
    timings[w.id] = rec;
  });
  return timings;
}

function graphemeList(text) {
  const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
  return [...seg.segment(text)].map(s => s.segment);
}

export async function buildSampleAudio(def) {
  const sampleRate = 44100;
  const offline = new OfflineAudioContext(1, Math.ceil(def.duration * sampleRate), sampleRate);
  const master = offline.createGain();
  master.gain.value = 0.22;
  master.connect(offline.destination);

  def.schedule.forEach((s, i) => {
    if (!s) return; // pending word: intentionally silent
    const freq = PENTATONIC[i % PENTATONIC.length];
    const dur = s.end - s.start;
    const osc = offline.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const overtone = offline.createOscillator();
    overtone.type = 'triangle';
    overtone.frequency.value = freq * 2;
    const mix = offline.createGain();
    mix.gain.value = 0.25;
    const env = offline.createGain();
    env.gain.setValueAtTime(0.0001, s.start);
    env.gain.exponentialRampToValueAtTime(1, s.start + Math.min(0.05, dur * 0.2));
    env.gain.setValueAtTime(1, Math.max(s.start + 0.06, s.end - 0.12));
    env.gain.exponentialRampToValueAtTime(0.0001, s.end);
    osc.connect(env);
    overtone.connect(mix);
    mix.connect(env);
    env.connect(master);
    osc.start(s.start);
    overtone.start(s.start);
    osc.stop(s.end + 0.02);
    overtone.stop(s.end + 0.02);
  });

  const rendered = await offline.startRendering();
  return audioBufferToWavBlob(rendered);
}

// Stereo duet audio: each part is an independent oscillator schedule, panned
// hard left/right and transposed into different registers so the two truly
// simultaneous voices are distinguishable by ear.
export async function buildDuetAudio(def) {
  const sampleRate = 44100;
  const offline = new OfflineAudioContext(2, Math.ceil(def.duration * sampleRate), sampleRate);
  const master = offline.createGain();
  master.gain.value = 0.2;
  const merger = offline.createChannelMerger(2);
  merger.connect(master);
  master.connect(offline.destination);

  const partConfig = {
    A: { pan: 0, scale: PENTATONIC, octave: 1 },
    B: { pan: 1, scale: PENTATONIC.slice().reverse(), octave: 0.5 },
  };
  let noteIndex = 0;
  for (const pid of Object.keys(def.schedules)) {
    const cfg = partConfig[pid] || partConfig.A;
    def.schedules[pid].forEach(s => {
      if (!s) return;
      const base = cfg.scale[noteIndex % cfg.scale.length] * cfg.octave;
      noteIndex++;
      const dur = s.end - s.start;
      const osc = offline.createOscillator();
      osc.type = pid === 'A' ? 'sine' : 'triangle';
      osc.frequency.value = base;
      const env = offline.createGain();
      env.gain.setValueAtTime(0.0001, s.start);
      env.gain.exponentialRampToValueAtTime(1, s.start + Math.min(0.05, dur * 0.2));
      env.gain.setValueAtTime(1, Math.max(s.start + 0.06, s.end - 0.12));
      env.gain.exponentialRampToValueAtTime(0.0001, s.end);
      const panner = offline.createStereoPanner ? offline.createStereoPanner() : null;
      osc.connect(env);
      if (panner) {
        panner.pan.value = cfg.pan === 0 ? -0.85 : 0.85;
        env.connect(panner);
        panner.connect(merger, 0, cfg.pan);
      } else {
        env.connect(merger, 0, cfg.pan);
      }
      osc.start(s.start);
      osc.stop(s.end + 0.02);
    });
  }

  const rendered = await offline.startRendering();
  return audioBufferToWavBlob(rendered);
}

function audioBufferToWavBlob(buffer) {
  const numCh = buffer.numberOfChannels;
  const sr = buffer.sampleRate;
  const frames = buffer.length;
  const channels = [];
  for (let ch = 0; ch < numCh; ch++) channels.push(buffer.getChannelData(ch));
  const bytesPerSample = 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = frames * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(ab);
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };

  writeStr(0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * blockAlign, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, 16, true);
  writeStr(36, 'data');
  dv.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const v = Math.max(-1, Math.min(1, channels[ch][i]));
      dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}
