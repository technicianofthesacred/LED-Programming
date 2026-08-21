/* Built-in demo music for the Show screen.
 *
 * Three short pieces, SYNTHESISED live with WebAudio rather than shipped as
 * audio files: nothing to download, nothing to licence, no bytes in the repo,
 * and they loop for as long as the owner wants to sit and tune.
 *
 * They are not test tones. Each one is real material — a tonal centre, actual
 * chords, a sensible tempo, gentle stereo — chosen so that between them they
 * exercise every part of the analyser:
 *
 *   ember  — bass and low-mid, sustained, almost no transients
 *   heart  — a steady unmistakable pulse at a fixed tempo
 *   rain   — treble and upper-mid, sparse, almost no bass
 *
 * If the piece looks the same on all three, something upstream is listening
 * to overall loudness instead of the band it was told to listen to.
 *
 * Timing: notes are scheduled AHEAD on the AudioContext clock from a coarse
 * lookahead pump (the standard "A Tale of Two Clocks" pattern). setInterval
 * only decides *when we think about* the next notes; the notes themselves are
 * placed on the sample-accurate clock, so nothing drifts or stutters if the
 * main thread is busy painting the mandala.
 */

// ── pure helpers (tested headlessly) ──────────────────────────────────────

/** Equal-tempered MIDI note → Hz. */
export function midiHz(note) {
  return 440 * (2 ** ((note - 69) / 12));
}

/** Seconds per beat at a tempo. */
export function beatSeconds(bpm) {
  return 60 / bpm;
}

/** The times of `beats` beats at `bpm`, starting at 0. */
export function beatGrid(bpm, beats) {
  const spb = beatSeconds(bpm);
  const times = [];
  for (let i = 0; i < beats; i += 1) times.push(i * spb);
  return times;
}

/**
 * Every occurrence of a looping event list that falls in [from, to).
 *
 * `events` carry a `time` inside one loop; the loop repeats forever, so an
 * event at 2s in a 40s loop also happens at 42s, 82s… The window is
 * half-open at both ends of the pump's cursor, which is what makes the pump
 * emit each occurrence exactly once no matter where a loop boundary lands
 * inside a window.
 *
 * Returns fresh objects carrying absolute track-time in `time`, in order.
 */
export function eventsInWindow(events, loopSeconds, from, to) {
  if (!(loopSeconds > 0) || !(to > from)) return [];
  const out = [];
  const firstCycle = Math.floor(from / loopSeconds);
  const lastCycle = Math.floor((to - 1e-9) / loopSeconds);
  for (let cycle = firstCycle; cycle <= lastCycle; cycle += 1) {
    const base = cycle * loopSeconds;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      const at = base + event.time;
      if (at >= from && at < to) out.push({ ...event, time: at });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Gain for one voice of an `n`-voice stack.
 *
 * Incoherent voices sum by power, not amplitude, so dividing by `n` makes a
 * four-note chord half the loudness of a two-note one and the owner reads a
 * quieter track as a less responsive one. Square-root keeps perceived level
 * steady across chords of different sizes, which is the whole point of
 * level-matching the three tracks.
 */
export function voiceGain(peak, count) {
  const n = Math.max(1, Math.floor(count));
  return peak / Math.sqrt(n);
}

// How far ahead of the clock notes are placed, and how often we look.
// 250ms of lookahead survives a very stalled main thread; a 60ms pump means
// each note is decided several times over before it is due.
export const LOOKAHEAD_SECONDS = 0.25;
export const PUMP_MS = 60;

// ── the material ──────────────────────────────────────────────────────────

// 1. Slow Ember — D minor, four chords, ten seconds each, all overlapping.
// Every chord keeps D as a drone so the loop point is a colour change rather
// than an event. Nothing here is a transient: 4.5s in, 6s out.
const EMBER_CHORDS = [
  [26, 38, 45, 53], // D1  D2  A2  F3   — Dm
  [26, 34, 41, 50], // D1  Bb1 F2  D3   — Bb
  [26, 41, 48, 57], // D1  F2  C3  A3   — F(add9-ish over the drone)
  [26, 31, 38, 46], // D1  G1  D2  Bb2  — Gm
];
const EMBER_CHORD_SECONDS = 10;

const emberSpec = {
  loopSeconds: EMBER_CHORDS.length * EMBER_CHORD_SECONDS,
  level: 0.5,
  events: EMBER_CHORDS.map((notes, index) => ({
    time: index * EMBER_CHORD_SECONDS,
    kind: 'pad',
    notes,
    // Alternate the stereo placement chord to chord — a slow drift across the
    // room rather than a static image.
    pan: index % 2 === 0 ? -0.22 : 0.22,
  })),
};

// 2. Steady Heart — 84 BPM, one soft kick on every beat, forever.
// Twelve bars (three turns of a four-bar A-minor progression) so the loop is
// 34.3s and lands exactly on a bar line.
const HEART_BPM = 84;
const HEART_BARS = 12;
const HEART_ROOTS = [33, 29, 36, 31]; // A1  F1  C2  G1
const HEART_CHORDS = [
  [57, 60, 64], // Am
  [53, 57, 60], // F
  [48, 55, 60], // C
  [50, 55, 59], // G
];

function heartEvents() {
  const spb = beatSeconds(HEART_BPM);
  const events = [];
  for (let bar = 0; bar < HEART_BARS; bar += 1) {
    const barAt = bar * 4 * spb;
    const step = bar % HEART_ROOTS.length;
    for (let beat = 0; beat < 4; beat += 1) {
      // The pulse. Every beat, no exceptions — this is the track he watches
      // to prove nothing in the piece speeds up with the music.
      events.push({ time: barAt + beat * spb, kind: 'kick', accent: beat === 0 });
    }
    events.push({ time: barAt, kind: 'bass', note: HEART_ROOTS[step] });
    events.push({ time: barAt + 2 * spb, kind: 'bass', note: HEART_ROOTS[step] });
    // Chords sit off the pulse so they colour the mid band without smearing
    // the onsets the kick is there to make legible.
    events.push({ time: barAt + 1.5 * spb, kind: 'chord', notes: HEART_CHORDS[step], pan: -0.18 });
    events.push({ time: barAt + 3 * spb, kind: 'chord', notes: HEART_CHORDS[step], pan: 0.18 });
  }
  return events;
}

const heartSpec = {
  loopSeconds: HEART_BARS * 4 * beatSeconds(HEART_BPM),
  level: 0.44,
  events: heartEvents(),
};

// 3. Bright Rain — 96 BPM, high and airy, deliberately gutless below 400Hz.
const RAIN_BPM = 96;
const RAIN_BEATS = 48;
const RAIN_BELLS = [84, 91, 88, 96, 93, 88]; // C6 G6 E6 C7 A6 E6 — pentatonic
const RAIN_PLUCKS = [72, 76, 79, 83, 79, 76]; // C5 E5 G5 B5 G5 E5

function rainEvents() {
  const spb = beatSeconds(RAIN_BPM);
  const events = [];
  for (let beat = 0; beat < RAIN_BEATS; beat += 1) {
    const at = beat * spb;
    events.push({ time: at, kind: 'tick', gain: beat % 4 === 0 ? 1 : 0.55 });
    if (beat % 4 === 3) events.push({ time: at + spb * 0.5, kind: 'tick', gain: 0.35 });
    if (beat % 4 === 0) {
      const step = (beat / 4) % RAIN_BELLS.length;
      events.push({ time: at, kind: 'bell', note: RAIN_BELLS[step], pan: step % 2 === 0 ? -0.3 : 0.3 });
    }
    if (beat % 2 === 1) {
      const step = ((beat - 1) / 2) % RAIN_PLUCKS.length;
      events.push({ time: at + spb * 0.5, kind: 'pluck', note: RAIN_PLUCKS[step], pan: step % 2 === 0 ? 0.35 : -0.35 });
    }
  }
  return events;
}

const rainSpec = {
  // Louder on the dial than the other two on purpose. Sparse bell hits have a
  // far higher crest factor than a pad or a kick, so equal gain would leave
  // this one measurably quieter (5.5dB RMS, measured) even though its peaks
  // matched. The three are matched by measured RMS, not by equal numbers.
  loopSeconds: RAIN_BEATS * beatSeconds(RAIN_BPM),
  level: 0.68,
  events: rainEvents(),
};

// ── WebAudio rendering ────────────────────────────────────────────────────

function panned(ctx, pan) {
  if (typeof ctx.createStereoPanner === 'function') {
    const node = ctx.createStereoPanner();
    node.pan.value = pan;
    return node;
  }
  return ctx.createGain(); // Safari without StereoPanner: mono is fine.
}

function noiseBuffer(ctx, seconds) {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** Attack/decay envelope on a fresh gain node, freed when it has finished. */
function envelope(ctx, at, peak, attack, release) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + release);
  return gain;
}

function renderEmber(ctx, dest, event, at, kit) {
  const attack = 4.5;
  const release = 6;
  const peak = voiceGain(0.24, event.notes.length);
  const pan = panned(ctx, event.pan);
  pan.connect(dest);
  event.notes.forEach((note, index) => {
    const hz = midiHz(note);
    // Two saws a few cents apart: the slow beating between them is what makes
    // a pad breathe instead of sit.
    for (let d = 0; d < 2; d += 1) {
      const osc = ctx.createOscillator();
      osc.type = index === 0 ? 'sine' : 'sawtooth';
      osc.frequency.value = hz;
      osc.detune.value = d === 0 ? -5 : 5;
      const gain = envelope(ctx, at, peak * (index === 0 ? 1.3 : 0.7), attack, release);
      osc.connect(gain);
      gain.connect(pan);
      osc.start(at);
      osc.stop(at + attack + release + 0.2);
      osc.onended = () => { try { gain.disconnect(); } catch { /* closed */ } };
    }
  });
  kit.retire(pan, at + attack + release + 0.4);
}

function renderHeart(ctx, dest, event, at, kit) {
  if (event.kind === 'kick') {
    const peak = event.accent ? 0.52 : 0.4;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(124, at);
    osc.frequency.exponentialRampToValueAtTime(44, at + 0.09);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.38);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(at);
    osc.stop(at + 0.45);
    osc.onended = () => { try { gain.disconnect(); } catch { /* closed */ } };
    return;
  }
  if (event.kind === 'bass') {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = midiHz(event.note);
    const gain = envelope(ctx, at, 0.3, 0.03, 1.1);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(at);
    osc.stop(at + 1.2);
    osc.onended = () => { try { gain.disconnect(); } catch { /* closed */ } };
    return;
  }
  const peak = voiceGain(0.15, event.notes.length);
  const pan = panned(ctx, event.pan);
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 1500;
  tone.Q.value = 0.6;
  tone.connect(pan);
  pan.connect(dest);
  event.notes.forEach((note) => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = midiHz(note);
    const gain = envelope(ctx, at, peak, 0.12, 1.3);
    osc.connect(gain);
    gain.connect(tone);
    osc.start(at);
    osc.stop(at + 1.5);
    osc.onended = () => { try { gain.disconnect(); } catch { /* closed */ } };
  });
  kit.retire(pan, at + 1.8);
  kit.retire(tone, at + 1.8);
}

function renderRain(ctx, dest, event, at, kit) {
  if (event.kind === 'tick') {
    const src = ctx.createBufferSource();
    src.buffer = kit.noise;
    src.playbackRate.value = 1;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6500;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.linearRampToValueAtTime(0.2 * event.gain, at + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
    src.connect(hp);
    hp.connect(gain);
    gain.connect(dest);
    src.start(at, Math.random() * 1.5, 0.12);
    src.onended = () => { try { hp.disconnect(); gain.disconnect(); } catch { /* closed */ } };
    return;
  }
  const pan = panned(ctx, event.pan);
  pan.connect(dest);
  const hz = midiHz(event.note);
  if (event.kind === 'bell') {
    // Two inharmonic partials over the fundamental: the cheapest thing that
    // reads as a struck bell rather than a beep.
    const partials = [[1, 0.16, 2.6], [2.76, 0.07, 1.5], [5.4, 0.03, 0.8]];
    partials.forEach(([ratio, peak, decay]) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = hz * ratio;
      const gain = envelope(ctx, at, peak, 0.004, decay);
      osc.connect(gain);
      gain.connect(pan);
      osc.start(at);
      osc.stop(at + decay + 0.1);
      osc.onended = () => { try { gain.disconnect(); } catch { /* closed */ } };
    });
    kit.retire(pan, at + 3);
    return;
  }
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = hz;
  const gain = envelope(ctx, at, 0.13, 0.005, 0.45);
  osc.connect(gain);
  gain.connect(pan);
  osc.start(at);
  osc.stop(at + 0.55);
  osc.onended = () => { try { gain.disconnect(); } catch { /* closed */ } };
  kit.retire(pan, at + 0.8);
}

function emberChain(ctx) {
  const head = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 620;
  tone.Q.value = 0.7;
  // A very slow filter sweep — the "evolving" in evolving pad. 0.04Hz is one
  // full breath every 25 seconds, which is deliberately not the loop length.
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.04;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 240;
  lfo.connect(lfoDepth);
  lfoDepth.connect(tone.frequency);
  lfo.start();
  head.connect(tone);
  return { head, tail: tone, nodes: [head, tone, lfoDepth], oscillators: [lfo] };
}

function heartChain(ctx) {
  const head = ctx.createGain();
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 3200;
  head.connect(tone);
  return { head, tail: tone, nodes: [head, tone], oscillators: [] };
}

function rainChain(ctx) {
  const head = ctx.createGain();
  // Everything below 400Hz is thrown away on purpose. This is the track that
  // has to leave the "deep" meter alone while it lights up "sparkle".
  const cut = ctx.createBiquadFilter();
  cut.type = 'highpass';
  cut.frequency.value = 400;
  const cut2 = ctx.createBiquadFilter();
  cut2.type = 'highpass';
  cut2.frequency.value = 400;
  head.connect(cut);
  cut.connect(cut2);
  // A short feedback delay is what turns sparse hits into rain.
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.27;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.42;
  const wet = ctx.createGain();
  wet.gain.value = 0.5;
  const out = ctx.createGain();
  cut2.connect(out);
  cut2.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(wet);
  wet.connect(out);
  return { head, tail: out, nodes: [head, cut, cut2, delay, feedback, wet, out], oscillators: [] };
}

function buildTrack(ctx, spec, chainOf, render) {
  const chain = chainOf(ctx);
  // A gentle compressor on every track so that peaks stay clear of clipping
  // and the three sit at the same apparent loudness. Switching tracks must
  // not change the level, or one effect looks more responsive than another
  // for a reason that has nothing to do with the effect.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.006;
  comp.release.value = 0.2;
  const out = ctx.createGain();
  out.gain.value = 0.0001;
  chain.tail.connect(comp);
  comp.connect(out);

  const kit = {
    noise: null,
    retire(node, when) {
      const delay = Math.max(0, (when - ctx.currentTime) * 1000) + 250;
      setTimeout(() => { try { node.disconnect(); } catch { /* closed */ } }, delay);
    },
  };

  let timer = 0;
  let startedAt = 0;
  let cursor = 0;
  let running = false;
  let disposed = false;

  const pump = () => {
    if (!running || disposed) return;
    const ahead = (ctx.currentTime - startedAt) + LOOKAHEAD_SECONDS;
    if (ahead <= cursor) return;
    const due = eventsInWindow(spec.events, spec.loopSeconds, cursor, ahead);
    for (let i = 0; i < due.length; i += 1) {
      const event = due[i];
      const at = startedAt + event.time;
      // A note whose slot already passed (tab was backgrounded, clock jumped)
      // is dropped rather than crammed onto "now" as a burst.
      if (at < ctx.currentTime - 0.02) continue;
      try { render(ctx, chain.head, event, at, kit); } catch { /* context closing */ }
    }
    cursor = ahead;
  };

  return {
    node: out,
    get running() { return running; },
    start() {
      if (disposed || running) return;
      if (!kit.noise) kit.noise = noiseBuffer(ctx, 2);
      running = true;
      const now = ctx.currentTime;
      startedAt = now + 0.15;
      cursor = 0;
      out.gain.cancelScheduledValues(now);
      out.gain.setValueAtTime(0.0001, now);
      out.gain.exponentialRampToValueAtTime(spec.level, now + 0.5);
      pump();
      timer = setInterval(pump, PUMP_MS);
    },
    stop() {
      if (!running) return;
      running = false;
      clearInterval(timer);
      timer = 0;
      const now = ctx.currentTime;
      out.gain.cancelScheduledValues(now);
      out.gain.setValueAtTime(Math.max(1e-4, out.gain.value), now);
      out.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    },
    dispose() {
      if (disposed) return;
      this.stop();
      disposed = true;
      chain.oscillators.forEach((osc) => { try { osc.stop(); } catch { /* already */ } });
      setTimeout(() => {
        [...chain.nodes, comp, out].forEach((node) => {
          try { node.disconnect(); } catch { /* closed */ }
        });
      }, 500);
    },
  };
}

// ── the registry ──────────────────────────────────────────────────────────

export const DEMO_TRACKS = [
  {
    id: 'ember',
    name: 'Slow Ember',
    description: 'Deep, sustained, no beat — shows whether the piece breathes with the music.',
    bpm: 0,
    loopSeconds: emberSpec.loopSeconds,
    build: (ctx) => buildTrack(ctx, emberSpec, emberChain, renderEmber),
  },
  {
    id: 'heart',
    name: 'Steady Heart',
    description: `A firm pulse at ${HEART_BPM} BPM — shows the onsets, and that nothing speeds up.`,
    bpm: HEART_BPM,
    loopSeconds: heartSpec.loopSeconds,
    build: (ctx) => buildTrack(ctx, heartSpec, heartChain, renderHeart),
  },
  {
    id: 'rain',
    name: 'Bright Rain',
    description: 'Bells and air, almost no bass — shows that each area hears its own band.',
    bpm: RAIN_BPM,
    loopSeconds: rainSpec.loopSeconds,
    build: (ctx) => buildTrack(ctx, rainSpec, rainChain, renderRain),
  },
];

export const DEMO_TRACK_IDS = DEMO_TRACKS.map((track) => track.id);

export function findDemoTrack(id) {
  return DEMO_TRACKS.find((track) => track.id === id) || null;
}

/**
 * Build one demo track against an existing AudioContext.
 *
 * The returned `node` is an ordinary AudioNode: connect it wherever the mic
 * and file sources already connect, and the analyser cannot tell the
 * difference.
 */
export function createDemoTrack(audioCtx, id) {
  const track = findDemoTrack(id);
  if (!track) throw new Error(`Unknown demo track: ${id}`);
  return track.build(audioCtx);
}

// Exported for tests: the raw specs, so the scheduling maths can be checked
// against the actual material rather than a fixture that can drift from it.
export const DEMO_TRACK_SPECS = { ember: emberSpec, heart: heartSpec, rain: rainSpec };
