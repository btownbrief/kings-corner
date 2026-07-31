// KINGS CORNER — tiny procedural WebAudio sounds, adapted from the fleet's
// four-in-a-rowboat audio module. No audio files; the context is created
// only after a player gesture.

const LS_MUTED = 'kings-corner-muted';
const MAX_VOICES = 10;

let ctx = null;
let master = null;
let activeVoices = 0;
let muted = readMuted();

function readMuted() {
  try {
    return localStorage.getItem(LS_MUTED) === '1';
  } catch (e) {
    return false;
  }
}

function saveMuted() {
  try {
    localStorage.setItem(LS_MUTED, muted ? '1' : '0');
  } catch (e) { /* private mode etc. — sound still works for this visit */ }
}

function unlock() {
  if (muted) return;
  if (!ctx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.34;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

function voice(start, dur, build) {
  if (muted || !ctx || !master || activeVoices >= MAX_VOICES) return;
  const t = ctx.currentTime + start;
  activeVoices++;
  const source = build(ctx, t, master);
  if (!source) {
    activeVoices--;
    return;
  }
  source.onended = () => {
    activeVoices = Math.max(0, activeVoices - 1);
    (source._nodes || [source]).forEach((node) => {
      try { node.disconnect(); } catch (e) { /* already disconnected */ }
    });
  };
  source.start(t);
  source.stop(t + dur + 0.04);
}

function tone(freq, start, dur, { type = 'sine', gain = 0.14, slide = 0 } = {}) {
  voice(start, dur, (audio, t, out) => {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(35, freq + slide), t + dur);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc._nodes = [osc, g];
    return osc;
  });
}

function noise(start, dur, { gain = 0.08, highpass = 500 } = {}) {
  voice(start, dur, (audio, t, out) => {
    const frames = Math.max(1, Math.floor(audio.sampleRate * dur));
    const buffer = audio.createBuffer(1, frames, audio.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const source = audio.createBufferSource();
    const filter = audio.createBiquadFilter();
    const g = audio.createGain();
    source.buffer = buffer;
    filter.type = 'highpass';
    filter.frequency.value = highpass;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    source.connect(filter).connect(g).connect(out);
    source._nodes = [source, filter, g];
    return source;
  });
}

export const sound = {
  get muted() {
    return muted;
  },
  unlock,
  toggleMuted() {
    muted = !muted;
    saveMuted();
    if (!muted) unlock();
    return muted;
  },
  slap() {
    if (muted) return;
    noise(0, 0.055, { gain: 0.09, highpass: 900 });
    tone(150, 0, 0.075, { type: 'triangle', gain: 0.09, slide: -45 });
  },
  slide() {
    if (muted) return;
    noise(0, 0.16, { gain: 0.055, highpass: 650 });
    tone(220, 0.03, 0.12, { type: 'sine', gain: 0.045, slide: -70 });
  },
  draw() {
    if (muted) return;
    noise(0, 0.075, { gain: 0.045, highpass: 1200 });
    tone(330, 0.015, 0.09, { type: 'triangle', gain: 0.05, slide: 60 });
  },
  nope() {
    if (muted) return;
    tone(190, 0, 0.09, { type: 'sine', gain: 0.045, slide: -30 });
  },
  corner() {
    if (muted) return;
    [392, 523, 659, 784].forEach((freq, i) => {
      tone(freq, i * 0.055, 0.28, { type: 'triangle', gain: 0.13 });
    });
    tone(1047, 0.21, 0.38, { type: 'sine', gain: 0.1 });
  },
  win() {
    if (muted) return;
    [392, 494, 587, 784].forEach((freq, i) => {
      tone(freq, i * 0.1, 0.25, { type: 'triangle', gain: 0.14 });
    });
    tone(1047, 0.4, 0.48, { type: 'triangle', gain: 0.12 });
  },
  lose() {
    if (muted) return;
    [330, 294, 247].forEach((freq, i) => {
      tone(freq, i * 0.13, 0.25, { type: 'triangle', gain: 0.1 });
    });
    tone(196, 0.38, 0.34, { type: 'sine', gain: 0.07 });
  },
};
