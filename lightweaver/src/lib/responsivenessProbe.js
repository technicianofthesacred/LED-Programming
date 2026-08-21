// responsivenessProbe.js — a headless measuring instrument for "does the music
// visibly drive the piece?".
//
// WHY THIS EXISTS
//
// The owner's standard (2026-08-21): "I don't need you to retune them, it
// wasn't working great before. I need you to make sure they are responsive and
// we will get some cool effects based on a variety of music." The failure to
// fix is an effect whose light barely changes between a quiet passage and a
// loud one. The failure to avoid is strobing. Both of those are NUMBERS, and
// arguing about them from a canvas preview is how the previous tuning passes
// went in circles. This module turns them into numbers.
//
// It measures; it does not judge. Every function here returns raw quantities.
// The PASS/FAIL thresholds live in `responsiveness.test.js`, chosen from what
// this probe actually measured — never the other way round.
//
// ─────────────────────────────────────────────────────────────────────────────
// NO DOM, NO BROWSER, NO AUDIO HARDWARE
//
// Profiles are synthesised band envelopes, so a run is deterministic and takes
// seconds. Nothing here imports React, touches `window`, or opens an
// AudioContext. `node --test` runs it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT LAYER IS BEING MEASURED (read this before comparing numbers)
//
// The fourteen effects live in two engines with two different output contracts,
// so the probe pins one comparable quantity: PER-PIXEL NORMALISED INTENSITY in
// [0,1], the number that becomes brightness before palette, master and wire
// gamma.
//
//   - the nine legacy modes (mandalaEngine.js) → `engine.getIntensity(i)`,
//     i.e. `vals[i]`: post-mode, post-glow-floor, post-beat-substrate,
//     post-hit-bloom, post-silence-idle, post-envelope. Clamped to [0,1]
//     because that is what `colorFrame()` does at render time.
//   - the five characters (showCharacters.js) → the value their `kernel()`
//     writes into a zeroed `out[]` for one voice at full depth. Characters
//     have no envelope, master or coal-floor of their own — the ensemble
//     composites those — so this is the character's whole contribution.
//
// Consequence to keep in mind when reading the table: a character's
// `silenceFloor` is naturally near zero (it has no coal law to obey on its
// own), while a legacy mode's is pinned by the engine's `idle = 0.03` bed.
// Comparing those two columns across families is meaningless; comparing SWING
// across families is exactly the point.
//
// ─────────────────────────────────────────────────────────────────────────────
// FEATURES GO IN THE FRONT DOOR, NOT THROUGH THE AGC
//
// `setFeatures()` is used with `sensitivity = 1`, so the band numbers a profile
// synthesises are the band numbers the effect sees. The engine's `analyze()`
// path additionally runs a per-band auto-leveller (`level()`), which by design
// normalises a quiet passage UP toward a loud one. That is a real property of
// the live pipeline and it will compress whatever swing is measured here — but
// it is not the effects' behaviour, and the two agents tuning the effects do
// not own it. Measure the effect; flag the AGC separately.

import { createMandalaEngine, MODE_KEYS } from './mandalaEngine.js';
import { createMandalaSpatialTemplate } from './showSpatialTemplate.js';
import { CHARACTERS, CHARACTER_KEYS, cloneVoiceState } from './showCharacters.js';
import { clamp01 } from './mandalaMath.js';

const TAU = Math.PI * 2;

// ============================================================
//  0. Small numeric helpers
// ============================================================

/** Deterministic LCG — profiles must be byte-reproducible run to run. */
function createRandom(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return percentile(sorted, 0.5);
}

function mean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function round(x, places = 4) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x ?? null;
  const f = 10 ** places;
  return Math.round(x * f) / f;
}

/**
 * A percussive envelope evaluated at `t`: silent before `t0`, linear rise over
 * `attack`, exponential decay with time-constant `decay`. Overlapping hits take
 * the max (a drum does not sum with its own tail).
 *
 * Real band envelopes are not square waves; this is the cheapest shape that is
 * still honest about attack time and tail length, which is what onset
 * visibility and snap counting depend on.
 */
function hitEnvelope(t, times, attack, decay) {
  let v = 0;
  for (let k = 0; k < times.length; k += 1) {
    const d = t - times[k];
    if (d < 0) break;              // times are ascending
    if (d > attack + decay * 7) continue;
    const rise = attack > 0 ? Math.min(1, d / attack) : 1;
    const fall = Math.exp(-Math.max(0, d - attack) / decay);
    const e = rise * fall;
    if (e > v) v = e;
  }
  return v;
}

function evenTimes(from, to, spacing, offset = 0) {
  const out = [];
  for (let t = from + offset; t < to; t += spacing) out.push(t);
  return out;
}

function jitteredTimes(from, to, minGap, maxGap, rnd) {
  const out = [];
  let t = from + minGap * 0.5;
  while (t < to) {
    out.push(t);
    t += minGap + (maxGap - minGap) * rnd();
  }
  return out;
}

/** One-pole with separate attack/release time constants, frame-rate correct. */
function smoothAsym(env, x, tauA, tauR, dt) {
  const tau = x > env ? tauA : tauR;
  return env + (x - env) * (1 - Math.exp(-dt / Math.max(1e-6, tau)));
}

// ============================================================
//  1. MUSIC PROFILES
// ============================================================
//
// Each profile is a function of time producing raw bass/mid/high in [0,1] plus
// a `beat` impulse. `energy` and `centroid` are then derived with the SAME
// formulas `mandalaEngine.applyBands()` uses, so a profile cannot accidentally
// hand an effect an energy/centroid pair that the live analyser would never
// produce. `flux` is the positive frame-to-frame rise in energy.
//
// `drive` — the loudness classifier used to split "loud passages" from "quiet
// passages" — is a smoothed energy (0.15s attack / 0.8s release). The release
// is deliberately longer than a beat period: a four-on-the-floor track is one
// continuous loud passage, not an alternation of loud and quiet ones, and the
// probe must not report a kick as a "quiet-to-loud swing". Kick response is
// `onsetVisibility`'s job.

const PROFILE_BUILDERS = {
  silence: {
    label: 'silence',
    seconds: 16,
    notes: 'no source at all — exercises the coal decay and the never-frozen law',
    listening: false,
    build() { return { bass: 0, mid: 0, high: 0, beat: 0 }; },
  },

  ambient: {
    label: 'quiet ambient',
    // 48 s on purpose: Glow's and Hearth's mood beds are 20 s one-poles, so a
    // short profile measures their switch-on ramp instead of their answer to
    // the music. `tailMean` reads the settled last 15 s.
    seconds: 48,
    notes: 'low, slow, almost no transients — the "quiet passage" reference',
    build(t, rnd) {
      const a = 0.5 + 0.5 * Math.sin((TAU * t) / 11);
      const b = 0.5 + 0.5 * Math.sin((TAU * t) / 7.5 + 1.1);
      const c = 0.5 + 0.5 * Math.sin((TAU * t) / 9.3 + 2.4);
      return {
        bass: 0.055 + 0.070 * a + 0.020 * rnd(),
        mid: 0.085 + 0.090 * b + 0.025 * rnd(),
        high: 0.035 + 0.050 * c + 0.018 * rnd(),
        beat: 0,
      };
    },
  },

  fourOnFloor: {
    label: 'four-on-the-floor kick',
    seconds: 24,
    notes: '120 bpm kick, backbeat snare, straight hats — strong regular bass onsets',
    times(seconds) {
      return {
        kick: evenTimes(0, seconds, 0.5),
        snare: evenTimes(0, seconds, 1.0, 0.5),
        hat: evenTimes(0, seconds, 0.25, 0.125),
      };
    },
    onsets(times) { return times.kick; },
    build(t, rnd, times) {
      const kick = hitEnvelope(t, times.kick, 0.012, 0.13);
      const snare = hitEnvelope(t, times.snare, 0.010, 0.17);
      const hat = hitEnvelope(t, times.hat, 0.006, 0.045);
      return {
        bass: 0.120 + 0.820 * kick + 0.040 * rnd(),
        mid: 0.280 + 0.380 * snare + 0.090 * kick + 0.055 * rnd(),
        high: 0.090 + 0.560 * hat + 0.180 * snare + 0.045 * rnd(),
        beat: Math.min(1, 0.92 * kick + 0.35 * snare),
      };
    },
  },

  sparsePercussion: {
    label: 'sparse percussion',
    seconds: 32,
    notes: 'isolated hits, 2.2–3.8 s of near-silence between them',
    times(seconds, rnd) { return { hit: jitteredTimes(0, seconds, 2.2, 3.8, rnd) }; },
    onsets(times) { return times.hit; },
    build(t, rnd, times) {
      const body = hitEnvelope(t, times.hit, 0.010, 0.38);
      const crack = hitEnvelope(t, times.hit, 0.005, 0.075);
      return {
        bass: 0.025 + 0.860 * body + 0.012 * rnd(),
        mid: 0.035 + 0.520 * body + 0.220 * crack + 0.015 * rnd(),
        high: 0.018 + 0.720 * crack + 0.120 * body + 0.012 * rnd(),
        beat: Math.min(1, body * 0.95),
      };
    },
  },

  denseRock: {
    label: 'dense loud rock',
    seconds: 48,   // paired with `ambient` for crossProfileSwing — same length, same settling
    notes: 'everything high and sustained, transients blurred — the "loud passage" reference',
    times(seconds) { return { pulse: evenTimes(0, seconds, 0.545) }; },
    build(t, rnd, times) {
      const pulse = hitEnvelope(t, times.pulse, 0.030, 0.20);
      return {
        bass: 0.660 + 0.090 * Math.sin((TAU * t) / 2.1) + 0.080 * pulse + 0.050 * rnd(),
        mid: 0.790 + 0.070 * Math.sin((TAU * t) / 1.3 + 1.0) + 0.055 * rnd(),
        high: 0.600 + 0.090 * Math.sin((TAU * t) / 0.9 + 2.0) + 0.070 * rnd(),
        beat: 0.14 + 0.13 * pulse,
      };
    },
  },

  bassElectronic: {
    label: 'bass-heavy electronic',
    seconds: 24,
    notes: '128 bpm, bass dominant, highs almost absent — half of the band-discrimination pair',
    times(seconds) { return { kick: evenTimes(0, seconds, 60 / 128) }; },
    onsets(times) { return times.kick; },
    build(t, rnd, times) {
      const kick = hitEnvelope(t, times.kick, 0.015, 0.19);
      return {
        bass: 0.330 + 0.620 * kick + 0.045 * rnd(),
        mid: 0.190 + 0.090 * Math.sin((TAU * t) / 3.7) + 0.060 * kick + 0.035 * rnd(),
        high: 0.025 + 0.045 * rnd(),
        beat: Math.min(1, 0.95 * kick),
      };
    },
  },

  brightAcoustic: {
    label: 'bright acoustic',
    seconds: 24,
    notes: 'highs and mids dominant, little bass — the other half of the band-discrimination pair',
    times(seconds, rnd) { return { pluck: jitteredTimes(0, seconds, 0.26, 0.52, rnd) }; },
    onsets(times) { return times.pluck; },
    build(t, rnd, times) {
      const pluck = hitEnvelope(t, times.pluck, 0.006, 0.115);
      const body = hitEnvelope(t, times.pluck, 0.020, 0.310);
      return {
        bass: 0.050 + 0.060 * (0.5 + 0.5 * Math.sin((TAU * t) / 6.3)) + 0.020 * rnd(),
        mid: 0.380 + 0.300 * body + 0.055 * rnd(),
        high: 0.290 + 0.560 * pluck + 0.050 * rnd(),
        beat: Math.min(1, 0.45 * pluck),
      };
    },
  },

  dynamicBuild: {
    label: 'dynamic build',
    seconds: 40,
    notes: 'quiet → loud over 30 s, 6 s at full, then a hard drop to near-silence',
    times(seconds) {
      return { kick: evenTimes(0, seconds, 0.5), hat: evenTimes(0, seconds, 0.25, 0.125) };
    },
    onsets(times) { return times.kick.filter((t) => t > 20 && t < 36); },
    build(t, rnd, times) {
      let ramp;
      if (t < 30) ramp = 0.06 + 0.94 * (t / 30) ** 1.35;
      else if (t < 36) ramp = 1;
      else ramp = Math.max(0.04, Math.exp(-(t - 36) / 1.1));
      const kick = hitEnvelope(t, times.kick, 0.012, 0.14);
      const hat = hitEnvelope(t, times.hat, 0.006, 0.05);
      return {
        bass: ramp * (0.140 + 0.780 * kick) + 0.025 * rnd() * ramp,
        mid: ramp * (0.240 + 0.330 * (0.5 + 0.5 * Math.sin((TAU * t) / 1.7))) + 0.040 * rnd() * ramp,
        high: ramp * (0.130 + 0.500 * hat) + 0.030 * rnd() * ramp,
        beat: Math.min(1, ramp * 0.95 * kick),
      };
    },
  },
};

export const PROFILE_KEYS = Object.keys(PROFILE_BUILDERS);

/**
 * The four profiles that are a track playing CONTINUOUSLY at a normal level.
 * `sparsePercussion` and `dynamicBuild` are excluded on purpose — they are
 * mostly quiet by construction, so a low average on them is correct restraint,
 * not deadness. `ambient` is excluded because being dim under quiet music is
 * the whole point. An effect that is barely lit on all four of THESE is an
 * effect the owner will describe as "it doesn't do anything".
 */
export const SUSTAINED_PROFILE_KEYS = ['fourOnFloor', 'denseRock', 'bassElectronic', 'brightAcoustic'];

/** How long, in seconds, a run is ticked before its statistics start. Every
 * effect starts from black; without this the mean of a steady profile is
 * dragged down by its own switch-on ramp. */
export const SETTLE_SECONDS = 6;

/** The settled window at the end of a steady profile. `tailMean` is read here,
 * and it is what the cross-profile loud-vs-quiet ratio compares — a 20 s mood
 * one-pole must not be judged on its first breath. */
export const TAIL_SECONDS = 15;

const DRIVE_ATTACK_TAU = 0.15;
const DRIVE_RELEASE_TAU = 0.80;

/**
 * Synthesise one music profile as an array of frames.
 *
 * Frame shape:
 *   { t, dt, listening, drive, bands: { bass, mid, high, energy, centroid, flux, beat } }
 *
 * `bands` is exactly the object `mandalaEngine.setFeatures()` and a character's
 * `ctx.bands` both consume, so one frame drives either family unchanged.
 */
export function buildProfile(key, { fps = 40, seed = 0x1EDBEEF } = {}) {
  const spec = PROFILE_BUILDERS[key];
  if (!spec) throw new Error(`unknown music profile "${key}"`);
  const dt = 1 / fps;
  const seconds = spec.seconds;
  const rnd = createRandom(seed ^ (key.length * 2654435761));
  const times = spec.times ? spec.times(seconds, createRandom(seed ^ 0x9E3779B1)) : null;
  const onsets = spec.onsets ? spec.onsets(times) : [];

  const frames = [];
  let prevEnergy = 0;
  let drive = 0;
  for (let n = 0; n * dt < seconds; n += 1) {
    const t = n * dt;
    const raw = spec.build(t, rnd, times);
    const bass = clamp01(raw.bass);
    const mid = clamp01(raw.mid);
    const high = clamp01(raw.high);
    // Same derivations as mandalaEngine.applyBands(), so a profile can never
    // present an energy/centroid combination the live analyser would not.
    const energy = clamp01(bass * 0.5 + mid * 0.35 + high * 0.25);
    const centroid = clamp01((mid * 0.4 + high * 0.9) / (bass * 0.9 + 0.3));
    const flux = clamp01(Math.max(0, energy - prevEnergy) * 6);
    prevEnergy = energy;
    drive = smoothAsym(drive, energy, DRIVE_ATTACK_TAU, DRIVE_RELEASE_TAU, dt);
    frames.push({
      t,
      dt,
      listening: spec.listening !== false,
      drive,
      bands: { bass, mid, high, energy, centroid, flux, beat: clamp01(raw.beat) },
    });
  }

  // Loud/quiet split by the profile's own dynamic range. A profile whose drive
  // barely moves (ambient, dense rock, silence) has no loud-vs-quiet question
  // to ask, and reports `swing: null` rather than a meaningless ratio.
  const driveSorted = frames.filter((f) => f.t >= SETTLE_SECONDS).map((f) => f.drive).sort((a, b) => a - b);
  const quietCut = percentile(driveSorted, 0.25);
  const loudCut = percentile(driveSorted, 0.75);
  const hasContrast = loudCut - quietCut >= 0.15;

  return {
    key,
    label: spec.label,
    notes: spec.notes,
    fps,
    dt,
    seconds,
    frames,
    onsets,
    quietCut,
    loudCut,
    hasContrast,
  };
}

// ============================================================
//  2. EFFECT RUNNERS — one interface over the two engines
// ============================================================

export const LEGACY_KEYS = [...MODE_KEYS];
export const EFFECTS = [
  ...LEGACY_KEYS.map((key) => ({ id: key, family: 'legacy', key })),
  ...CHARACTER_KEYS.map((key) => ({ id: key, family: 'character', key })),
];
export const EFFECT_IDS = EFFECTS.map((e) => e.id);

function effectSpec(id) {
  const found = EFFECTS.find((e) => e.id === id);
  if (!found) throw new Error(`unknown effect "${id}"`);
  return found;
}

/**
 * A sparse, irregular connected layout — three curved arms of unequal length
 * with chain-inactive gaps between them, 102 active pixels. This is the same
 * shape `mandalaEngine.legacyParity.test.js` uses, and it exists here for the
 * same reason: 102 pixels puts the engine's `detail` well below 1, so every
 * density branch (`dLobes` / `dWide`) runs at its sparse value. Responsiveness
 * on a 675-pixel mandala is not evidence of responsiveness on a 100-light
 * commission.
 */
export function createSparseProbeTemplate() {
  const arms = [
    { id: 'arm-a', n: 34, cx: -0.55, cy: -0.35, dx: 0.95, dy: 0.35, k: 0.4 },
    { id: 'arm-b', n: 27, cx: 0.62, cy: -0.48, dx: -0.42, dy: 0.98, k: 1.9 },
    { id: 'arm-c', n: 41, cx: -0.12, cy: 0.78, dx: 0.66, dy: -0.83, k: 3.1 },
  ];
  const samples = [];
  const push = (stripId, stripIndex, stripProgress, x, y) => {
    samples.push({
      outputIndex: samples.length,
      stripId,
      stripIndex,
      stripProgress,
      x,
      y,
      radius: Math.hypot(x, y),
      angle: (() => { const a = Math.atan2(y, x); return a < 0 ? a + TAU : a; })(),
    });
  };
  arms.forEach((arm, stripIndex) => {
    for (let i = 0; i < 4; i += 1) push(null, -1, 0, 0, 0);
    for (let i = 0; i < arm.n; i += 1) {
      const u = arm.n > 1 ? i / (arm.n - 1) : 0;
      const x = arm.cx + arm.dx * u + 0.22 * Math.sin(u * Math.PI * 1.7 + arm.k);
      const y = arm.cy + arm.dy * u + 0.18 * Math.cos(u * Math.PI * 2.3 + arm.k);
      push(arm.id, stripIndex, u, x, y);
    }
  });
  return samples;
}

/** The character kernels' `area` contract: flattened per-pixel geometry with an
 * identity `pixelIndex`, built from the same spatial template the legacy modes
 * run on so the two families are measured on IDENTICAL geometry. */
export function areaFromTemplate(template) {
  const n = template.length;
  const pixelIndex = new Int32Array(n);
  const radius = new Float32Array(n);
  const angle = new Float32Array(n);
  const seed = new Int32Array(n);
  let maxRadius = 0;
  for (let i = 0; i < n; i += 1) {
    const r = Number.isFinite(template[i]?.radius) ? template[i].radius : 0;
    if (r > maxRadius) maxRadius = r;
  }
  const span = maxRadius > 1e-9 ? maxRadius : 1;
  for (let i = 0; i < n; i += 1) {
    const s = template[i];
    pixelIndex[i] = i;
    radius[i] = clamp01((Number.isFinite(s?.radius) ? s.radius : 0) / span);
    angle[i] = Number.isFinite(s?.angle) ? s.angle : 0;
    seed[i] = (Math.imul(i + 1, 2654435761) ^ Math.imul(i + 7, 40503)) | 0;
  }
  return { pixelIndex, radius, angle, seed, count: n, instanceStart: Int32Array.from([0, n]) };
}

/**
 * Build a stepper for one effect. `step(frame)` advances the effect by one
 * frame and returns a Float32Array of per-pixel normalised intensity in [0,1].
 * The returned buffer is reused — read it before the next `step`.
 */
export function createRunner(effectId, { template, preset = 'Active', sensitivity = 1 } = {}) {
  const spec = effectSpec(effectId);
  const layout = template || createMandalaSpatialTemplate();
  const n = layout.length;
  const buf = new Float32Array(n);

  if (spec.family === 'legacy') {
    const engine = createMandalaEngine({ template: layout });
    engine.setSensitivity(sensitivity);
    engine.setPreset(preset);
    engine.setMode(spec.key);
    let listening = null;
    return {
      id: effectId,
      family: 'legacy',
      pixelCount: n,
      step(frame) {
        if (frame.listening !== listening) { listening = frame.listening; engine.setListening(listening); }
        engine.setFeatures(frame.bands);
        engine.tick(frame.dt);
        for (let i = 0; i < n; i += 1) buf[i] = clamp01(engine.getIntensity(i));
        return buf;
      },
      raw(i) { return engine.getIntensity(i); },
    };
  }

  const character = CHARACTERS[spec.key];
  const area = areaFromTemplate(layout);
  const vr = cloneVoiceState(character);
  const out = new Float32Array(n);
  const ctx = { dt: 0, bands: null, depth: 1 };
  return {
    id: effectId,
    family: 'character',
    pixelCount: n,
    step(frame) {
      ctx.dt = frame.dt;
      ctx.bands = frame.listening ? frame.bands : ZERO_BANDS;
      character.tick(vr, ctx);
      out.fill(0);
      character.kernel(area, 0, area.count, out, vr, ctx);
      for (let i = 0; i < n; i += 1) buf[i] = clamp01(out[i]);
      return buf;
    },
    raw(i) { return out[i]; },
  };
}

const ZERO_BANDS = { bass: 0, mid: 0, high: 0, energy: 0, centroid: 0, flux: 0, beat: 0 };

// ============================================================
//  3. MEASUREMENT
// ============================================================

/** A frame-to-frame rise in WHOLE-PIECE mean brightness larger than this is a
 * snap: the entire object changed level inside one frame. At 40 fps this is a
 * 0.25-of-full-range step in 25 ms. Fast attack is wanted and does not trip it
 * — a fast attack takes several frames; a strobe takes one. */
export const SNAP_MEAN_DELTA = 0.25;
/** The same test on a single pixel, where a spark legitimately ignites fast.
 * Reported separately; a high pixel-snap count with a low mean-snap count is a
 * texture, not a strobe. */
export const SNAP_PIXEL_DELTA = 0.55;

/** Divisor guard: below this a "quiet passage" mean is treated as this value,
 * so an effect that renders literal black in the quiet cannot report an
 * infinite swing. 0.004 of full scale is ~1 LSB after wire gamma. */
const SWING_FLOOR = 0.004;

/** A pixel counts as "lit" above this. Mean brightness alone is unfair to a
 * deliberately sparse effect (Twinkle, Embers): a hundred bright sparks over a
 * dark field average out to nearly nothing. `litFraction` is how much of the
 * piece is actually doing something. */
const LIT_THRESHOLD = 0.08;

/**
 * Run one effect against one profile and reduce it to numbers.
 *
 * Everything is derived from two per-frame series — the mean and the spread of
 * per-pixel intensity — plus the per-frame maximum single-pixel jump. Nothing
 * stores a full pixel history, so a full 14 × 8 sweep runs in seconds.
 */
export function measureEffectProfile(effectId, profileKey, options = {}) {
  const { fps = 40, preset = 'Active', sensitivity = 1, template, seed } = options;
  const profile = options.profile && options.profile.key === profileKey
    ? options.profile
    : buildProfile(profileKey, { fps, seed });
  const layout = template || createMandalaSpatialTemplate();
  const runner = createRunner(effectId, { template: layout, preset, sensitivity });
  const n = runner.pixelCount;

  const times = [];
  const means = [];
  const spreads = [];      // std across pixels, per frame
  const maxima = [];
  const lit = [];          // fraction of pixels above LIT_THRESHOLD, per frame
  let prevFrame = null;
  let meanSnaps = 0;
  let pixelSnaps = 0;
  let maxMeanJump = 0;
  let peakPixel = 0;
  let nonFinite = 0;
  let negative = 0;

  for (const frame of profile.frames) {
    const px = runner.step(frame);
    let sum = 0;
    let sumSq = 0;
    let frameMax = 0;
    let frameMaxJump = 0;
    let litCount = 0;
    for (let i = 0; i < n; i += 1) {
      const v = px[i];
      if (!Number.isFinite(v)) { nonFinite += 1; continue; }
      if (v < 0) negative += 1;
      sum += v;
      sumSq += v * v;
      if (v > LIT_THRESHOLD) litCount += 1;
      if (v > frameMax) frameMax = v;
      if (prevFrame) {
        const jump = Math.abs(v - prevFrame[i]);
        if (jump > frameMaxJump) frameMaxJump = jump;
      }
    }
    const m = sum / n;
    const variance = Math.max(0, sumSq / n - m * m);
    if (frame.t >= SETTLE_SECONDS) {
      if (means.length) {
        const d = Math.abs(m - means[means.length - 1]);
        if (d > maxMeanJump) maxMeanJump = d;
        if (d > SNAP_MEAN_DELTA) meanSnaps += 1;
      }
      if (frameMaxJump > SNAP_PIXEL_DELTA) pixelSnaps += 1;
      times.push(frame.t);
      means.push(m);
      spreads.push(Math.sqrt(variance));
      maxima.push(frameMax);
      lit.push(litCount / n);
      if (frameMax > peakPixel) peakPixel = frameMax;
    }
    prevFrame = prevFrame || new Float32Array(n);
    prevFrame.set(px);
  }

  // --- swing: loud-passage mean ÷ quiet-passage mean ---
  let swing = null;
  let loudMean = null;
  let quietMean = null;
  if (profile.hasContrast) {
    const loud = [];
    const quiet = [];
    let idx = 0;
    for (const frame of profile.frames) {
      if (frame.t < SETTLE_SECONDS) continue;
      const m = means[idx];
      idx += 1;
      if (frame.drive >= profile.loudCut) loud.push(m);
      else if (frame.drive <= profile.quietCut) quiet.push(m);
    }
    loudMean = mean(loud);
    quietMean = mean(quiet);
    swing = loudMean / Math.max(SWING_FLOOR, quietMean);
  }

  // --- onset visibility: rise inside 200 ms of a hit, over the level around it ---
  const onsetRises = [];
  if (profile.onsets && profile.onsets.length >= 3) {
    for (const onsetAt of profile.onsets) {
      if (onsetAt < SETTLE_SECONDS + 0.35) continue;
      let before = 0;
      let beforeCount = 0;
      let peak = 0;
      let sawWindow = false;
      for (let i = 0; i < times.length; i += 1) {
        const t = times[i];
        if (t >= onsetAt - 0.30 && t < onsetAt - 0.02) { before += means[i]; beforeCount += 1; }
        if (t >= onsetAt && t <= onsetAt + 0.20) { sawWindow = true; if (means[i] > peak) peak = means[i]; }
      }
      if (!beforeCount || !sawWindow) continue;
      const base = before / beforeCount;
      onsetRises.push((peak - base) / Math.max(SWING_FLOOR, base));
    }
  }

  // --- spatial variance: how much structure is in the frame, not over time ---
  // Coefficient of variation across pixels, averaged over frames that are lit
  // at all. A uniform brighten scores ~0; a moving structure scores high.
  const cov = [];
  for (let i = 0; i < means.length; i += 1) {
    if (means[i] < 0.01) continue;
    cov.push(spreads[i] / means[i]);
  }

  const meansSorted = [...means].sort((a, b) => a - b);

  // --- rangeSwing: the same question asked purely of the OUTPUT ---
  // p90 ÷ p20 of the whole-piece mean over this profile. No audio model, no
  // alignment window, defined for every profile including silence, and immune
  // to the lag between a band peak and the light that answers it. This is the
  // cell that fills the effect × profile table: "while this music plays, how
  // far does this effect's light travel?" A flat effect reports ~1.0.
  const rangeSwing = meansSorted.length
    ? percentile(meansSorted, 0.90) / Math.max(SWING_FLOOR, percentile(meansSorted, 0.20))
    : null;

  // --- tailMean: the settled last TAIL_SECONDS ---
  // Mood beds are 20 s one-poles. On a steady profile the settled tail is the
  // effect's answer to the music; the whole-run mean is half switch-on ramp.
  const tailFrom = Math.max(SETTLE_SECONDS, profile.seconds - TAIL_SECONDS);
  const tailMeans = [];
  for (let i = 0; i < times.length; i += 1) if (times[i] >= tailFrom) tailMeans.push(means[i]);

  return {
    effect: effectId,
    profile: profileKey,
    frames: means.length,
    swing: swing === null ? null : round(swing, 3),
    rangeSwing: rangeSwing === null ? null : round(rangeSwing, 3),
    tailMean: round(mean(tailMeans)),
    litFraction: round(mean(lit), 4),
    loudMean: loudMean === null ? null : round(loudMean),
    quietMean: quietMean === null ? null : round(quietMean),
    meanBrightness: round(mean(means)),
    floor: round(meansSorted.length ? meansSorted[0] : 0),
    ceiling: round(meansSorted.length ? meansSorted[meansSorted.length - 1] : 0),
    p05: round(percentile(meansSorted, 0.05)),
    p95: round(percentile(meansSorted, 0.95)),
    peakPixel: round(peakPixel),
    onsetVisibility: onsetRises.length >= 3 ? round(median(onsetRises), 3) : null,
    onsetSamples: onsetRises.length,
    spatialVariance: cov.length ? round(mean(cov), 3) : null,
    snapCount: meanSnaps,
    pixelSnapCount: pixelSnaps,
    maxMeanJump: round(maxMeanJump),
    nonFinite,
    negative,
  };
}

/**
 * Silence behaviour, measured on its own script: 10 s of four-on-the-floor,
 * then the source is cut and the piece is watched for 20 s.
 *
 * `decayTime` is the time from the cut until the whole-piece mean has fallen
 * 90% of the way from where it was at the cut to where it eventually settles —
 * "how long until it has finished letting go", which is the ~8 s the direction
 * asks for. Measured as a fall THROUGH a level rather than as proximity to the
 * settled value, because several modes undershoot the coal floor and creep
 * back up over the following 15 s; a proximity test reports the undershoot
 * crossing and reads as a much faster decay than the eye sees.
 * `silenceFloor` is where it settles (mean of the last second).
 * `silenceMotion` is the peak-to-trough movement over that last second: the
 * never-frozen half of the law.
 */
export function measureSilenceTail(effectId, options = {}) {
  const { fps = 40, preset = 'Active', sensitivity = 1, template, seed } = options;
  const dt = 1 / fps;
  const music = buildProfile('fourOnFloor', { fps, seed });
  const layout = template || createMandalaSpatialTemplate();
  const runner = createRunner(effectId, { template: layout, preset, sensitivity });
  const n = runner.pixelCount;

  const frameMean = (px) => { let s = 0; for (let i = 0; i < n; i += 1) s += px[i]; return s / n; };

  let levelAtCut = 0;
  for (const frame of music.frames) {
    if (frame.t > 10) break;
    levelAtCut = frameMean(runner.step(frame));
  }

  const tail = [];
  const silentFrame = { t: 0, dt, listening: false, drive: 0, bands: ZERO_BANDS };
  for (let k = 0; k * dt < 20; k += 1) {
    silentFrame.t = k * dt;
    tail.push({ t: k * dt, m: frameMean(runner.step(silentFrame)) });
  }

  const lastSecond = tail.filter((s) => s.t >= 19);
  const settled = mean(lastSecond.map((s) => s.m));
  const motion = lastSecond.length
    ? Math.max(...lastSecond.map((s) => s.m)) - Math.min(...lastSecond.map((s) => s.m))
    : 0;
  const crossing = settled + (levelAtCut - settled) * 0.10;
  let decayTime = null;
  for (const s of tail) {
    if (levelAtCut >= settled ? s.m <= crossing : s.m >= crossing) { decayTime = round(s.t, 2); break; }
  }

  return {
    effect: effectId,
    levelAtCut: round(levelAtCut),
    silenceFloor: round(settled),
    silenceMotion: round(motion, 5),
    decayTime,
  };
}

/**
 * Band discrimination: does this effect respond DIFFERENTLY to bass-heavy
 * electronic than to bright acoustic? Symmetric relative difference of the two
 * mean brightnesses, 0 = identical (the effect is not really listening to a
 * band at all), 1 = one of the two is dark.
 */
export function bandDiscrimination(perProfile) {
  const a = perProfile.bassElectronic?.tailMean ?? 0;
  const b = perProfile.brightAcoustic?.tailMean ?? 0;
  const denom = (a + b) / 2;
  if (denom < 1e-6) return 0;
  return round(Math.abs(a - b) / denom, 3);
}

/** Cross-profile loud-vs-quiet: the reference "loud music" profile's mean over
 * the reference "quiet music" profile's mean. This is the number that answers
 * the owner's actual complaint — a quiet track and a loud track must not look
 * the same — for effects whose within-profile dynamics are flat. */
export function crossProfileSwing(perProfile) {
  const loud = perProfile.denseRock?.tailMean ?? 0;
  const quiet = perProfile.ambient?.tailMean ?? 0;
  return round(loud / Math.max(SWING_FLOOR, quiet), 3);
}

/** Everything about one effect: per-profile rows plus the cross-profile
 * summary the thresholds are actually written against. */
export function measureEffect(effectId, options = {}) {
  const perProfile = {};
  for (const key of PROFILE_KEYS) {
    perProfile[key] = measureEffectProfile(effectId, key, options);
  }
  const tail = measureSilenceTail(effectId, options);
  const swings = PROFILE_KEYS
    .map((k) => perProfile[k].swing)
    .filter((s) => typeof s === 'number');
  const spatial = PROFILE_KEYS
    .map((k) => perProfile[k].spatialVariance)
    .filter((s) => typeof s === 'number');
  const onsets = PROFILE_KEYS
    .map((k) => perProfile[k].onsetVisibility)
    .filter((s) => typeof s === 'number');
  // Musical profiles only: `silence` has no music to travel with, and reading
  // its rangeSwing as a responsiveness score would reward an idle wobble.
  const musicalRange = PROFILE_KEYS
    .filter((k) => k !== 'silence')
    .map((k) => perProfile[k].rangeSwing)
    .filter((s) => typeof s === 'number');

  let worstSustained = Infinity;
  let worstSustainedProfile = null;
  for (const k of SUSTAINED_PROFILE_KEYS) {
    const v = perProfile[k].tailMean;
    if (v < worstSustained) { worstSustained = v; worstSustainedProfile = k; }
  }

  return {
    effect: effectId,
    family: effectSpec(effectId).family,
    perProfile,
    summary: {
      dynamicSwing: perProfile.dynamicBuild.swing,
      sparseSwing: perProfile.sparsePercussion.swing,
      worstSwing: swings.length ? round(Math.min(...swings), 3) : null,
      crossProfileSwing: crossProfileSwing(perProfile),
      medianRangeSwing: musicalRange.length ? round(median(musicalRange), 3) : null,
      worstRangeSwing: musicalRange.length ? round(Math.min(...musicalRange), 3) : null,
      silenceRangeSwing: perProfile.silence.rangeSwing,
      bandDiscrimination: bandDiscrimination(perProfile),
      bestOnsetVisibility: onsets.length ? round(Math.max(...onsets), 3) : null,
      medianOnsetVisibility: onsets.length ? round(median(onsets), 3) : null,
      spatialVariance: spatial.length ? round(median(spatial), 3) : null,
      // "Is it visibly alive on EVERY kind of continuously-playing music?"
      // The weakest of the four sustained profiles, and how far above the
      // silence floor that weakest showing sits. 1.0 means: on at least one
      // real genre this effect is indistinguishable from the piece being off.
      worstSustainedMean: round(worstSustained),
      worstSustainedProfile,
      sustainedMusicLift: round(worstSustained / Math.max(SWING_FLOOR, tail.silenceFloor), 3),
      loudCeiling: round(perProfile.denseRock.ceiling),
      loudMean: round(perProfile.denseRock.tailMean),
      quietMean: round(perProfile.ambient.tailMean),
      loudLitFraction: round(perProfile.denseRock.litFraction, 3),
      totalSnapCount: PROFILE_KEYS.reduce((acc, k) => acc + perProfile[k].snapCount, 0),
      totalPixelSnapCount: PROFILE_KEYS.reduce((acc, k) => acc + perProfile[k].pixelSnapCount, 0),
      nonFinite: PROFILE_KEYS.reduce((acc, k) => acc + perProfile[k].nonFinite, 0),
      negative: PROFILE_KEYS.reduce((acc, k) => acc + perProfile[k].negative, 0),
      silenceFloor: tail.silenceFloor,
      silenceMotion: tail.silenceMotion,
      decayTime: tail.decayTime,
    },
    tail,
  };
}

/** The full sweep: every effect against every profile. */
export function measureAll(options = {}) {
  const ids = options.effects || EFFECT_IDS;
  const results = {};
  for (const id of ids) results[id] = measureEffect(id, options);
  return results;
}

// ============================================================
//  4. REPORTING
// ============================================================

function pad(s, w, right = false) {
  const str = s === null || s === undefined ? '—' : String(s);
  return right ? str.padStart(w) : str.padEnd(w);
}

/** effect × profile table for any per-profile metric. Plain text so it can be
 * pasted straight into a handoff. */
export function formatProfileTable(results, metric = 'swing', places = 2) {
  const ids = Object.keys(results);
  const head = [pad('effect', 12), ...PROFILE_KEYS.map((k) => pad(k.slice(0, 10), 11, true))].join(' ');
  const rows = ids.map((id) => {
    const cells = PROFILE_KEYS.map((k) => {
      const s = results[id].perProfile[k][metric];
      return pad(typeof s === 'number' ? s.toFixed(places) : '—', 11, true);
    });
    return [pad(id, 12), ...cells].join(' ');
  });
  return [`[${metric}]`, head, ...rows].join('\n');
}

export function formatSwingTable(results) { return formatProfileTable(results, 'swing', 2); }

export function formatSummaryTable(results) {
  const cols = [
    ['crossProfileSwing', 9], ['medianRangeSwing', 9], ['worstRangeSwing', 9], ['dynamicSwing', 8],
    ['sparseSwing', 8], ['bandDiscrimination', 7], ['medianOnsetVisibility', 8], ['spatialVariance', 8],
    ['sustainedMusicLift', 9], ['worstSustainedMean', 9],
    ['loudMean', 8], ['quietMean', 8], ['silenceFloor', 8], ['decayTime', 7],
    ['totalSnapCount', 6],
  ];
  const head = [pad('effect', 12), ...cols.map(([name, w]) => pad(name.slice(0, w), w, true))].join(' ');
  const rows = Object.keys(results).map((id) => {
    const s = results[id].summary;
    return [pad(id, 12), ...cols.map(([name, w]) => {
      const v = s[name];
      return pad(typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(3)) : v, w, true);
    })].join(' ');
  });
  return [head, ...rows].join('\n');
}

/** Machine-readable dump for a follow-up agent. */
export function toJSON(results) {
  const out = {};
  for (const [id, r] of Object.entries(results)) {
    out[id] = { family: r.family, summary: r.summary, perProfile: r.perProfile };
  }
  return out;
}
