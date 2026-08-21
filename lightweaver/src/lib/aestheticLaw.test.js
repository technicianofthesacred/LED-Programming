// aestheticLaw.test.js — THE LOCKED AESTHETIC, MADE STRUCTURAL (finding F1).
//
// docs/mandala-effects-direction-v2.md: "Audio may modulate amplitude,
// breadth, contrast, position, texture. Audio may NEVER modulate an authored
// clock or rotation speed."
//
// Before this file, that rule was guarded only by a naming convention. Every
// existing test that touched it asserted on ONE named field (`vr.clock`), so
// an adversarial review was able to add a SECOND rotation rate to a character
// — one that spun the piece 16x faster when the music was loud — and watch
// the whole suite stay green. Nothing in the shipped code does this. The
// point of this file is that nothing can start doing it quietly either.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE MEASURES, AND WHY THAT IS THE RIGHT THING TO MEASURE
//
// The law is about what the EYE sees, so the primary probe is behavioural: it
// renders real pixel buffers, frame by frame, and measures how fast structure
// TRAVELS ACROSS THE PIECE. It does not read `vr.clock`, does not know what
// any accumulator is called, and does not care how many of them there are. A
// new audio-scaled rate is caught by the pixels moving faster, whatever it is
// named and wherever it is stored.
//
// The trick that makes this work is measuring travel as the PHASE of an
// angular Fourier harmonic of the rendered ring, not as "the brightest pixel".
//
//   - The harmonic's MAGNITUDE is how strong that structure is. Amplitude,
//     contrast, and per-pixel texture all live here, and audio is allowed to
//     move it as much as it likes. This probe ignores magnitude entirely
//     except as a sanity control (see below).
//   - The harmonic's PHASE is WHERE that structure sits around the ring. Its
//     rate of change is the rotation rate, in rad/s, of the thing you can see
//     turning. That is exactly the quantity the law forbids audio from moving.
//
// Because phase is scale-free, a Trace arm that is 23x brighter and 1.9x
// broader under a loud drive still reports the same phase rate to eight
// significant figures — while a rate change of a fraction of a percent shows
// up immediately. That separation is the whole reason this probe can tell
// "it got brighter" apart from "it sped up"; a brightest-pixel or centroid
// tracker cannot, because breadth changes drag a centroid around.
//
// Per-frame phase steps are accumulated SIGNED, not as absolute values. Signed
// accumulation cancels zero-mean jitter (Glow's per-pixel flicker is scaled by
// the audio band, so an absolute-value estimator would report the loud run as
// "faster" purely from noise — measured, that error was 15%). Signed
// accumulation over the same run reports 0.0800 vs 0.0801 rad/s.
//
// ─────────────────────────────────────────────────────────────────────────────
// HONEST STATEMENT OF WHAT THIS FILE DOES **NOT** COVER
//
// A test that gives false confidence about this law would be worse than no
// test, so the gaps are named here rather than buried:
//
//  1. TWINKLE HAS NO SPATIAL MOTION TO MEASURE. Its output is a field of
//     stochastic sparks; there is no coherent structure whose position can be
//     tracked, and the angular-phase estimator run against it returns a random
//     walk (measured: -0.92 rad/s quiet, +0.20 rad/s loud, both meaningless).
//     Asserting on that number would be theatre. Twinkle's only clocks are its
//     20Hz ignition-bucket rate and its 0.12s spark lifetime, so Twinkle gets
//     a TEMPORAL probe instead (`twinkleClock`), which measures both directly
//     off the rendered pixels. It is a genuinely different probe and it is
//     labelled as one.
//
//  2. THE RADIAL AXIS IS ONLY COVERED FOR RIPPLE. A rectified, mean-subtracted
//     radial-centroid travel rate was built and measured against all five
//     characters. It is clean and flat for Ripple (0.1% spread across a 2.5x
//     amplitude range) because Ripple's signature motion IS radial. For the
//     others it is either vacuous or amplitude-contaminated: Glow's radial
//     travel is 0.005 units/s of flicker noise, Trace's rectified centroid
//     moves 3.7% further under a loud drive purely because the arm got
//     broader, and Twinkle's is stochastic. Those are excluded and stay
//     excluded; adding them would be an assertion that fails or passes on
//     amplitude, i.e. exactly the confusion this file exists to avoid.
//
//  3. SWELL'S RADIAL POSITION IS AUDIO-DRIVEN BY DESIGN AND IS NOT BOUNDED
//     HERE. Finding F7 decided that audio MAY move the Swell crest's radius
//     and constrained only the rate of change, via the SWELL_REACH_SLEW slew
//     limiter. The radial probe was measured against a scratch Swell with that
//     limiter removed: 5.75x quiet-to-loud travel ratio with the limiter,
//     6.23x without. An 8% separation is not a guard, so this file does not
//     pretend to be one. SWELL_REACH_SLEW has its own dedicated coverage in
//     showCharacters.test.js. Swell's ANGULAR travel is covered here, and is
//     exact.
//
//  4. THE SOURCE SCAN IS A SUPPLEMENT, NOT A PROOF. It is line-oriented and
//     trivially evadable by computing an audio-scaled rate on one line and
//     using it on the next. It exists to catch the careless version cheaply;
//     the behavioural probe is what catches the careful one.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR LAYERS
//
//   A. BEHAVIOURAL (primary) — `structureTravelRate` over 5-7 audio drives per
//      character, spanning silence to full scale, steady and percussive and
//      swinging. Assert the spread of the rate is under 1%.
//   A'. TEMPORAL (Twinkle) — ignition-bucket period and spark lifetime, read
//      off rendered pixels, across the same drive range.
//   B. STATE SHAPE — a CLOSED INVENTORY of which `vr` fields are allowed to
//      differ between a silent run and a loud one. A new accumulator that
//      moves with audio fails until a human classifies it. Also asserts every
//      declared field really does still move, which is the F2 failure mode
//      (a setting that is recorded and then ignored) in reverse.
//   C. SOURCE SHAPE — no audio identifier on a line that scales `ctx.dt`,
//      outside the smoothAR/onePole envelope calls where a band belongs.
//
// Every layer carries its own NEGATIVE CONTROL: a synthetic violating
// character built in this file, which each probe must reject. A guard nobody
// has seen fail is not a guard, so these run in CI on every commit, and the
// day one of them stops failing, this file is broken and says so.
// ─────────────────────────────────────────────────────────────────────────────
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHARACTERS, CHARACTER_LIBRARY, CHARACTER_KEYS, cloneVoiceState, readVoiceBand,
} from './showCharacters.js';
import { smoothAR, clamp01 } from './mandalaMath.js';

const TAU = Math.PI * 2;

// ============================================================
//  Audio drives — the same wall-clock frame sequence every time, so any
//  difference between two runs is caused by the BAND VALUE and nothing else.
// ============================================================

/** A steady band level, silence (0.02) through full scale (1.0). */
const pin = (v) => () => v;
/** Four-on-the-floor: a 90ms hit every 600ms. Percussive, and the only drive
 * shape that gets Ripple's onset detector to fire repeatedly. */
const kick = (peak) => (t) => ((t % 0.6) < 0.09 ? peak : 0.02);
/** A 3Hz swing between silence and `peak` — a band moving faster than most
 * of the authored clocks, which is where a band-scaled rate would show up
 * most violently. */
const wobble = (peak) => (t) => peak * (0.5 + 0.5 * Math.sin(t * TAU * 3));

/** The standard drive set: steady quiet -> steady loud, plus percussive and
 * swinging. Everything a real audio source does to a band. */
const STANDARD_DRIVES = [
  ['silence   ', pin(0.02)],
  ['steady 0.30', pin(0.30)],
  ['steady 0.65', pin(0.65)],
  ['steady 1.00', pin(1.00)],
  ['kick 0.45 ', kick(0.45)],
  ['kick 1.00 ', kick(1.00)],
  ['wobble 3Hz', wobble(1.00)],
];

/** Ripple only spawns a wavefront when the raw band crosses RIPPLE_ONSET_HIGH
 * (0.35), so a steady-quiet run produces literally nothing to watch move.
 * Its drive set is therefore identically-timed kicks of rising strength: same
 * spawn instants in every run, different hit amplitude. That is the precise
 * form of the law for a Ripple — a louder kick must not travel faster. */
const RIPPLE_DRIVES = [
  ['kick 0.40 ', kick(0.40)],
  ['kick 0.55 ', kick(0.55)],
  ['kick 0.70 ', kick(0.70)],
  ['kick 0.85 ', kick(0.85)],
  ['kick 1.00 ', kick(1.00)],
];

// ============================================================
//  The rendering harness — a real polar pixel field, driven through the real
//  tick()/kernel() contract. No character-specific knowledge lives here.
// ============================================================

const NA = 256;   // angular samples (must exceed 2x the highest harmonic read)
const NR = 6;     // radial rings
const N_ANG = NA * NR;

const ANGULAR_GRID = (() => {
  const pixelIndex = new Int32Array(N_ANG);
  const radius = new Float32Array(N_ANG);
  const angle = new Float32Array(N_ANG);
  const seed = new Int32Array(N_ANG);
  let k = 0;
  for (let r = 0; r < NR; r++) {
    for (let a = 0; a < NA; a++) {
      pixelIndex[k] = k;
      radius[k] = 0.14 + (0.84 * r) / (NR - 1);
      angle[k] = (a / NA) * TAU;
      seed[k] = (k * 2654435761) | 0;
      k++;
    }
  }
  return { pixelIndex, radius, angle, seed };
})();

const trigCache = new Map();
function trig(m) {
  if (!trigCache.has(m)) {
    const c = new Float64Array(NA); const s = new Float64Array(NA);
    for (let a = 0; a < NA; a++) { const th = (a / NA) * TAU * m; c[a] = Math.cos(th); s[a] = Math.sin(th); }
    trigCache.set(m, { c, s });
  }
  return trigCache.get(m);
}

/**
 * Render `character` for `seconds` at a fixed frame rate under `bandFn`, and
 * report how fast its m-th angular harmonic TURNS.
 *
 * Returns:
 *   rate      — rad/s of harmonic phase, signed. THE MOTION MEASURE.
 *   travel    — total signed phase swept, rad. Used as a positive control:
 *               a probe that watched something standing still would report
 *               "the rate matched" no matter what, so the quiet run has to
 *               prove real motion before the comparison means anything.
 *   meanMag   — mean harmonic magnitude. Used as the OTHER control: the loud
 *               run has to be provably, hugely different in the things audio
 *               IS allowed to change, or the probe is comparing two identical
 *               renders and its agreement is meaningless.
 *   meanTotal — mean total brightness over the field, reported for the same
 *               reason.
 */
function structureTravelRate(character, m, bandFn, { seconds = 30, dt = 1 / 60 } = {}) {
  const { c, s } = trig(m);
  const vr = cloneVoiceState(character);
  const out = new Float64Array(N_ANG);
  const W = new Float64Array(NA);
  const frames = Math.round(seconds / dt);
  let t = 0, prev = null, travel = 0, steps = 0, magSum = 0, totSum = 0;
  for (let f = 0; f < frames; f++) {
    const b = bandFn(t);
    const ctx = { dt, bands: { bass: b, mid: b, high: b, energy: b, beat: b }, depth: 1 };
    character.tick(vr, ctx);
    out.fill(0);
    W.fill(0);
    character.kernel(ANGULAR_GRID, 0, N_ANG, out, vr, ctx);
    let k = 0, tot = 0;
    for (let r = 0; r < NR; r++) for (let a = 0; a < NA; a++) { const v = out[k++]; W[a] += v; tot += v; }
    let re = 0, im = 0;
    for (let a = 0; a < NA; a++) { re += W[a] * c[a]; im -= W[a] * s[a]; }
    magSum += Math.hypot(re, im);
    totSum += tot;
    const ph = Math.atan2(im, re);
    if (prev !== null) {
      let d = ph - prev;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      travel += d;   // SIGNED — see the header note on why not |d|
      steps++;
    }
    prev = ph;
    t += dt;
  }
  return { rate: travel / (steps * dt), travel, meanMag: magSum / frames, meanTotal: totSum / frames };
}

// ============================================================
//  Layer A — the behavioural probe.
// ============================================================

/**
 * Which angular harmonic carries each character's visible structure, and how
 * much it is allowed to vary.
 *
 * `harmonic` is a property of the character's own authored geometry, not a
 * tuning knob: Trace has TRACE_ARMS = 2 arms, Glow's texture has GLOW_LOBES =
 * 3, Swell's arc gate has SWELL_LOBES = 2, Ripple's spokes are 9-fold.
 *
 * `minAmplitudeRatio` is the loud-vs-quiet ratio of harmonic magnitude that
 * the run must ACHIEVE. It is a floor on how differently the two runs must
 * behave in the permitted dimensions, so "the rates agreed" can never be a
 * consequence of the drives not mattering. Measured today: Swell 6.4x,
 * Glow 4.0x, Trace 23.1x, Ripple 2.5x.
 */
const MOTION_SPECS = {
  swell: { harmonic: 2, drives: STANDARD_DRIVES, minAmplitudeRatio: 2.0 },
  ripple: { harmonic: 9, drives: RIPPLE_DRIVES, minAmplitudeRatio: 2.0 },
  glow: { harmonic: 3, drives: STANDARD_DRIVES, minAmplitudeRatio: 2.0 },
  trace: { harmonic: 2, drives: STANDARD_DRIVES, minAmplitudeRatio: 2.0 },
};

/** Maximum permitted spread of the travel rate across every drive, as a
 * fraction of the quiet run's rate. Measured spread on the shipped code:
 * Swell 0.00000%, Ripple 0.00000%, Trace 0.00109%, Glow 0.15606% (Glow's is
 * residual flicker jitter). 1% leaves ~6x headroom over the worst honest
 * number while still failing a 5%-faster rotation. */
const RATE_TOLERANCE = 0.01;

/** The quiet run must sweep at least this much phase, in radians, before its
 * rate is treated as a measurement of anything. Measured: Swell 2.09,
 * Glow 2.40, Trace 6.28, Ripple 406. */
const MIN_QUIET_TRAVEL = 1.5;

function runMotionProbe(character, spec) {
  const rows = spec.drives.map(([label, fn]) => [label, structureTravelRate(character, spec.harmonic, fn)]);
  const rates = rows.map(([, r]) => r.rate);
  const base = rates[0];
  const spread = (Math.max(...rates) - Math.min(...rates)) / Math.abs(base);
  const mags = rows.map(([, r]) => r.meanMag);
  return { rows, rates, base, spread, amplitudeRatio: Math.max(...mags) / Math.min(...mags) };
}

function reportRows(rows) {
  return rows.map(([label, r]) => `    ${label}  rate=${r.rate.toFixed(8)} rad/s  mag=${r.meanMag.toExponential(3)}  total=${r.meanTotal.toFixed(2)}`).join('\n');
}

for (const key of Object.keys(MOTION_SPECS)) {
  const spec = MOTION_SPECS[key];
  test(`F1 behavioural: ${key} — rendered structure travels at the same speed however loud the music is`, () => {
    const character = CHARACTERS[key];
    const probe = runMotionProbe(character, spec);

    // Positive control 1: the thing we are watching actually moves. Without
    // this, a character that froze solid would sail through the comparison.
    assert.ok(
      Math.abs(probe.rows[0][1].travel) >= MIN_QUIET_TRAVEL,
      `${key}: the quiet run swept only ${probe.rows[0][1].travel.toFixed(3)} rad of m=${spec.harmonic} phase in 30s — under the ${MIN_QUIET_TRAVEL} rad floor, so this probe is not watching any motion and its agreement proves nothing. Either the authored clock stopped or the harmonic choice is wrong.`,
    );

    // Positive control 2: the drives really do drive. Without this, agreement
    // could simply mean the band never reached the kernel at all.
    assert.ok(
      probe.amplitudeRatio >= spec.minAmplitudeRatio,
      `${key}: loudest/quietest harmonic magnitude was only ${probe.amplitudeRatio.toFixed(2)}x (need >= ${spec.minAmplitudeRatio}x). The audio is barely changing the picture, so "the travel rate matched" is not evidence of anything.\n${reportRows(probe.rows)}`,
    );

    // THE LAW.
    assert.ok(
      probe.spread <= RATE_TOLERANCE,
      `${key}: AUDIO IS MOVING AN AUTHORED RATE.\n`
      + `  Structure travel rate varied by ${(probe.spread * 100).toFixed(4)}% across the audio drives (limit ${(RATE_TOLERANCE * 100).toFixed(2)}%).\n`
      + `  Amplitude/breadth/contrast may vary freely — this measurement deliberately ignores them (magnitude ratio across the same runs: ${probe.amplitudeRatio.toFixed(2)}x, and that is fine).\n`
      + `  What may NOT vary is how fast structure travels across the piece. See docs/mandala-effects-direction-v2.md.\n`
      + `  Per-drive m=${spec.harmonic} phase rates:\n${reportRows(probe.rows)}`,
    );
  });
}

test('F1 behavioural: every character in the library is covered by a probe', () => {
  // The reason this test exists: a NEW character added to the library must not
  // be able to arrive uncovered. If you add one, give it a MOTION_SPECS entry
  // — or, if like Twinkle it has no coherent spatial motion, add it to
  // NO_SPATIAL_MOTION together with the probe that covers it instead.
  const NO_SPATIAL_MOTION = { twinkle: 'covered by the temporal probe below (bucket rate + spark lifetime)' };
  const covered = new Set([...Object.keys(MOTION_SPECS), ...Object.keys(NO_SPATIAL_MOTION)]);
  const uncovered = CHARACTER_KEYS.filter((k) => !covered.has(k));
  assert.deepEqual(
    uncovered, [],
    `character(s) ${uncovered.join(', ')} have no aesthetic-law motion probe. Add a MOTION_SPECS entry (pick the angular harmonic its authored geometry actually carries), or document why it has no spatial motion and cover its clock another way.`,
  );
  // And nothing may be listed as covered that no longer exists.
  for (const k of covered) assert.ok(CHARACTER_KEYS.includes(k), `${k} is listed as covered but is not in CHARACTER_LIBRARY`);
});

// ============================================================
//  Layer A (radial) — Ripple's outward travel.
//
//  Ripple is the one character whose signature motion is radial rather than
//  angular, and the one whose source carries an explicit "audio must never
//  reach RIPPLE_SPEED" warning. It therefore gets a second, independent probe
//  on that axis. See the header for why the other four are excluded from it.
//
//  The measure: sum the frame into a fine radial profile, subtract the run's
//  own time-average profile (which removes the static ambient wash, whose
//  brightness IS audio-driven and would otherwise drag the centroid),
//  rectify, and take the centroid. Its total variation per second is how fast
//  the visible wavefront moves outward. Amplitude cancels in the centroid;
//  travel does not.
// ============================================================

const RAD_NA = 24, RAD_NR = 96, N_RAD = RAD_NA * RAD_NR;
const RAD_R = [];
const RADIAL_GRID = (() => {
  const pixelIndex = new Int32Array(N_RAD);
  const radius = new Float32Array(N_RAD);
  const angle = new Float32Array(N_RAD);
  const seed = new Int32Array(N_RAD);
  let k = 0;
  for (let r = 0; r < RAD_NR; r++) {
    const rr = 0.02 + (0.97 * r) / (RAD_NR - 1);
    RAD_R.push(rr);
    for (let a = 0; a < RAD_NA; a++) {
      pixelIndex[k] = k; radius[k] = rr; angle[k] = (a / RAD_NA) * TAU; seed[k] = (k * 2654435761) | 0; k++;
    }
  }
  return { pixelIndex, radius, angle, seed };
})();

function radialTravelRate(character, bandFn, { seconds = 30, dt = 1 / 60 } = {}) {
  const vr = cloneVoiceState(character);
  const out = new Float64Array(N_RAD);
  const frames = Math.round(seconds / dt);
  const profiles = [];
  let t = 0, totSum = 0;
  for (let f = 0; f < frames; f++) {
    const b = bandFn(t);
    const ctx = { dt, bands: { bass: b, mid: b, high: b, energy: b, beat: b }, depth: 1 };
    character.tick(vr, ctx);
    out.fill(0);
    character.kernel(RADIAL_GRID, 0, N_RAD, out, vr, ctx);
    const P = new Float64Array(RAD_NR);
    let k = 0;
    for (let r = 0; r < RAD_NR; r++) for (let a = 0; a < RAD_NA; a++) { const v = out[k++]; P[r] += v; totSum += v; }
    profiles.push(P);
    t += dt;
  }
  const mean = new Float64Array(RAD_NR);
  for (const P of profiles) for (let r = 0; r < RAD_NR; r++) mean[r] += P[r] / frames;
  let tv = 0, prev = null;
  for (const P of profiles) {
    let num = 0, den = 0;
    for (let r = 0; r < RAD_NR; r++) { const d = Math.abs(P[r] - mean[r]); num += RAD_R[r] * d; den += d; }
    if (den <= 1e-12) { prev = null; continue; }
    const cent = num / den;
    if (prev !== null) tv += Math.abs(cent - prev);
    prev = cent;
  }
  return { travelRate: tv / (frames * dt), meanTotal: totSum / frames };
}

test('F1 behavioural: ripple — a louder kick does not make the wavefront travel outward faster', () => {
  const rows = RIPPLE_DRIVES.map(([label, fn]) => [label, radialTravelRate(CHARACTERS.ripple, fn)]);
  const rates = rows.map(([, r]) => r.travelRate);
  const detail = rows.map(([label, r]) => `    ${label}: radial travel=${r.travelRate.toFixed(6)} units/s  total=${r.meanTotal.toFixed(2)}`).join('\n');

  // Positive control: the wavefront really is moving. Measured ~0.472 units/s.
  assert.ok(rates[0] >= 0.2, `ripple's quietest kick moved the radial centroid only ${rates[0].toFixed(6)} units/s — nothing is travelling, so this probe proves nothing:\n${detail}`);
  // Positive control: the drives really do differ in the permitted dimension.
  const bright = rows.map(([, r]) => r.meanTotal);
  assert.ok(Math.max(...bright) / Math.min(...bright) >= 1.3, `ripple's loud and quiet kicks are nearly the same brightness (${(Math.max(...bright) / Math.min(...bright)).toFixed(3)}x) — the hit strength is not reaching the pixels:\n${detail}`);

  const spread = (Math.max(...rates) - Math.min(...rates)) / rates[0];
  assert.ok(
    spread <= 0.02,
    `ripple: AUDIO IS MOVING THE WAVEFRONT SPEED. Outward travel rate varied by ${(spread * 100).toFixed(4)}% across a 2.5x range of hit strength (limit 2%). Hit strength may scale a wavefront's AMPLITUDE; RIPPLE_SPEED is a literal constant and must stay one.\n${detail}`,
  );
});

test('NEGATIVE CONTROL — the radial probe rejects an audio-scaled wavefront speed', () => {
  // The real Ripple, with one extra line: live wavefronts get an additional
  // advance proportional to the band. This is the exact shape the character's
  // own source comment warns against ("DO NOT let audio touch this").
  const FastRipple = {
    ...CHARACTERS.ripple,
    key: 'ripple-violator',
    tick(vr, ctx) {
      CHARACTERS.ripple.tick(vr, ctx);
      const band = ctx.bands.bass;
      for (let k = 0; k < vr.rippleR.length; k++) if (vr.rippleActive[k]) vr.rippleR[k] += ctx.dt * 0.9 * 3 * band;
    },
  };
  const rates = RIPPLE_DRIVES.map(([, fn]) => radialTravelRate(FastRipple, fn).travelRate);
  const spread = (Math.max(...rates) - Math.min(...rates)) / rates[0];
  assert.ok(
    spread > 0.02,
    `the radial probe FAILED TO CATCH an audio-scaled wavefront speed: spread ${(spread * 100).toFixed(4)}%. Rates: ${rates.map((r) => r.toFixed(6)).join(', ')}`,
  );
});

// ============================================================
//  Layer A' — Twinkle's temporal clock, measured off rendered pixels.
//
//  Twinkle has no travelling structure (see the header). What it does have is
//  two wall-clock rates that audio must not touch: the 20Hz rate at which
//  ignition is drawn, and the 0.12s life of a spark once drawn. Both are
//  measured here from the pixel buffer alone — the test never reads
//  TWINKLE_BUCKET_HZ or TWINKLE_SPARK_LIFE, so retuning them is fine and
//  scaling them with audio is not.
// ============================================================

const N_SPARK = 1024;
const SPARK_GRID = (() => {
  const pixelIndex = new Int32Array(N_SPARK);
  const radius = new Float32Array(N_SPARK);
  const angle = new Float32Array(N_SPARK);
  const seed = new Int32Array(N_SPARK);
  for (let i = 0; i < N_SPARK; i++) {
    pixelIndex[i] = i;
    radius[i] = 0.35 + 0.6 * ((i % 16) / 15);
    angle[i] = (i / N_SPARK) * TAU;
    seed[i] = (i * 2654435761) | 0;
  }
  return { pixelIndex, radius, angle, seed };
})();

function median(sorted) { return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0; }

/**
 * Render Twinkle and report, purely from the pixels:
 *   onsetGap   — median wall-clock gap between the instants at which any
 *                pixel newly lights. That is the ignition-bucket period.
 *   sparkLife  — median duration a pixel stays lit. That is the spark
 *                lifetime. The MEDIAN, not the mean: at loud levels some
 *                sparks land on top of each other and merge into longer
 *                episodes (measured max 0.32s), which drags a mean but not a
 *                median (0.11666666666666667 at every drive, exactly).
 */
function twinkleClock(bandFn, { seconds = 20, dt = 1 / 240 } = {}) {
  const vr = cloneVoiceState(CHARACTERS.twinkle);
  const out = new Float64Array(N_SPARK);
  const wasLit = new Uint8Array(N_SPARK);
  const litFor = new Int32Array(N_SPARK);
  const onsetFrames = new Set();
  const lives = [];
  const frames = Math.round(seconds / dt);
  let t = 0, totalSum = 0;
  for (let f = 0; f < frames; f++) {
    const b = bandFn(t);
    const ctx = { dt, bands: { bass: b, mid: b, high: b, energy: b, beat: b }, depth: 1 };
    CHARACTERS.twinkle.tick(vr, ctx);
    out.fill(0);
    CHARACTERS.twinkle.kernel(SPARK_GRID, 0, N_SPARK, out, vr, ctx);
    for (let i = 0; i < N_SPARK; i++) {
      const lit = out[i] > 1e-9 ? 1 : 0;
      totalSum += out[i];
      if (lit && !wasLit[i]) { onsetFrames.add(f); litFor[i] = 1; }
      else if (lit) litFor[i]++;
      else if (wasLit[i]) { lives.push(litFor[i] * dt); litFor[i] = 0; }
      wasLit[i] = lit;
    }
    t += dt;
  }
  const onsets = [...onsetFrames].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < onsets.length; i++) gaps.push((onsets[i] - onsets[i - 1]) * dt);
  gaps.sort((a, b) => a - b);
  lives.sort((a, b) => a - b);
  return { onsetGap: median(gaps), sparkLife: median(lives), onsets: onsets.length, episodes: lives.length, meanTotal: totalSum / frames };
}

test('F1 temporal: twinkle — the ignition-bucket rate does not move with the music', () => {
  // Steady levels only. Under a percussive or swinging drive the envelope
  // itself crosses individual pixels' ignition thresholds mid-bucket, which
  // adds real extra onsets between bucket boundaries and makes the median gap
  // a measure of the drive rather than of the clock. Spark lifetime (next
  // test) is the observable that survives every drive shape.
  const levels = [0.10, 0.25, 0.50, 0.75, 1.00];
  const runs = levels.map((v) => [v, twinkleClock(pin(v))]);
  const gaps = runs.map(([, r]) => r.onsetGap);
  const detail = runs.map(([v, r]) => `    band ${v.toFixed(2)}: gap=${r.onsetGap.toFixed(6)}s onsets=${r.onsets} meanTotal=${r.meanTotal.toFixed(3)}`).join('\n');

  // Positive control: there has to be a bucket structure to measure at all.
  assert.ok(gaps.every((g) => g > 0), `twinkle produced no ignition onsets to time:\n${detail}`);
  // Positive control: quiet and loud really are different pictures.
  const brightness = runs.map(([, r]) => r.meanTotal);
  assert.ok(
    Math.max(...brightness) / Math.min(...brightness) >= 5,
    `twinkle's loud run is only ${(Math.max(...brightness) / Math.min(...brightness)).toFixed(2)}x the quiet run's brightness — the band is barely reaching the kernel, so agreement proves nothing:\n${detail}`,
  );

  const spread = (Math.max(...gaps) - Math.min(...gaps)) / gaps[0];
  assert.ok(
    spread <= 0.02,
    `twinkle: AUDIO IS MOVING THE IGNITION CLOCK. Median gap between ignition instants varied by ${(spread * 100).toFixed(3)}% across the band range (limit 2%).\n${detail}`,
  );
});

test('F1 temporal: twinkle — a spark lives the same length of time however loud the music is', () => {
  const drives = [
    ['band 0.10 ', pin(0.10)],
    ['band 0.50 ', pin(0.50)],
    ['band 1.00 ', pin(1.00)],
    ['kick 0.50 ', kick(0.50)],
    ['kick 1.00 ', kick(1.00)],
    ['wobble 3Hz', wobble(1.00)],
  ];
  const runs = drives.map(([label, fn]) => [label, twinkleClock(fn)]);
  const lives = runs.map(([, r]) => r.sparkLife);
  const detail = runs.map(([label, r]) => `    ${label}: life=${r.sparkLife.toFixed(6)}s episodes=${r.episodes} meanTotal=${r.meanTotal.toFixed(3)}`).join('\n');

  assert.ok(lives.every((l) => l > 0), `twinkle produced no spark episodes to measure:\n${detail}`);
  const spread = (Math.max(...lives) - Math.min(...lives)) / lives[0];
  assert.ok(
    spread <= 0.02,
    `twinkle: AUDIO IS MOVING A SPARK'S LIFETIME. Median lit-episode duration varied by ${(spread * 100).toFixed(3)}% across the drives (limit 2%). A spark's life is wall clock; only how MANY sparks and how BRIGHT they are may follow the music.\n${detail}`,
  );
});

// ============================================================
//  Layer B — the closed state inventory.
//
//  Behavioural coverage is the strong layer, but it can only see what reaches
//  the pixels through the harmonic it watches. This layer is cheap and
//  complementary: it enumerates EVERY numeric field on a character's runtime
//  after a long run and asserts that the set which moved with the audio is
//  exactly the set a human declared. A new accumulator cannot arrive quietly
//  — it either matches between a silent run and a loud one (so it is not
//  audio-driven, and is fine), or the test fails until someone writes down
//  what it is.
// ============================================================

/**
 * The fields each character is ALLOWED to move with the audio. Envelopes,
 * onset state, and the F7 slew-limited reach gain. Nothing that advances on
 * its own is in here — `clock` is deliberately absent from every entry.
 *
 * Array-valued names cover every element of that array.
 */
const AUDIO_REACTIVE_FIELDS = {
  swell: ['env', 'reachGain'],
  twinkle: ['env'],
  ripple: ['env', 'armed', 'lastKickAt', 'rippleActive', 'rippleR', 'rippleStrength', 'ripplePhase'],
  glow: ['env', 'mood'],
  trace: ['env'],
};

function flattenNumeric(value, prefix, out) {
  if (typeof value === 'number') { out[prefix] = value; return out; }
  if (typeof value === 'boolean') { out[prefix] = value ? 1 : 0; return out; }
  if (value == null || typeof value !== 'object') return out;
  if (ArrayBuffer.isView(value) || Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) flattenNumeric(value[i], `${prefix}[${i}]`, out);
    return out;
  }
  for (const k of Object.keys(value)) flattenNumeric(value[k], prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function tickOnly(character, bandFn, { ticks = 900, dt = 1 / 60 } = {}) {
  const vr = cloneVoiceState(character);
  let t = 0;
  for (let i = 0; i < ticks; i++) {
    const b = bandFn(t);
    character.tick(vr, { dt, bands: { bass: b, mid: b, high: b, energy: b, beat: b }, depth: 1 });
    t += dt;
  }
  return flattenNumeric(vr, '', {});
}

/** Field path -> declared name, i.e. `rippleR[2]` -> `rippleR`. */
const rootOf = (path) => path.replace(/\[\d+\]$/, '');

function stateInventory(character, declared) {
  const silent = tickOnly(character, pin(0));
  const loud = tickOnly(character, pin(1));
  const percussive = tickOnly(character, kick(1));
  const moved = Object.keys(silent).filter((k) => !(Object.is(silent[k], loud[k]) && Object.is(silent[k], percussive[k])));
  const allowed = new Set(declared);
  return {
    undeclared: moved.filter((k) => !allowed.has(rootOf(k))),
    inert: declared.filter((name) => !moved.some((k) => rootOf(k) === name)),
    moved,
  };
}

for (const character of CHARACTER_LIBRARY) {
  test(`F1 state shape: ${character.key} — only the declared fields move with the audio`, () => {
    const declared = AUDIO_REACTIVE_FIELDS[character.key];
    assert.ok(declared, `${character.key} has no AUDIO_REACTIVE_FIELDS entry — every character needs one, even if it is just ['env'].`);
    const inv = stateInventory(character, declared);

    assert.deepEqual(
      inv.undeclared, [],
      `${character.key}: UNDECLARED AUDIO-DRIVEN STATE — ${inv.undeclared.join(', ')}.\n`
      + `  These vr fields end up at different values after 15 seconds of silence vs 15 seconds of loud audio, and nobody has declared them audio-reactive.\n`
      + `  If they are envelopes or onset state, add them to AUDIO_REACTIVE_FIELDS.${character.key}.\n`
      + `  If any of them is a clock, a phase, a rotation or a travel distance, this is the F1 violation itself: audio may not move an authored rate.`,
    );

    assert.deepEqual(
      inv.inert, [],
      `${character.key}: DECLARED-BUT-INERT STATE — ${inv.inert.join(', ')}.\n`
      + `  These are declared audio-reactive but hold identical values whether the music is silent or loud, i.e. the audio no longer reaches them.\n`
      + `  That is the F2 failure mode (a setting recorded, displayed, and then ignored). Either the wiring broke, or the field is dead and its declaration should go.`,
    );

    // And the clock specifically, stated as its own claim so the failure reads
    // plainly rather than as a set difference.
    const silent = tickOnly(character, pin(0));
    const loud = tickOnly(character, pin(1));
    assert.equal(
      silent.clock, loud.clock,
      `${character.key}: vr.clock advanced to a different place under silence (${silent.clock}) than under loud audio (${loud.clock}). The authored clock must be a pure function of wall clock.`,
    );
  });
}

// ============================================================
//  Layer C — the source scan (supplement; see the header's caveat).
// ============================================================

/** Words that name an audio value. Deliberately includes the band names
 * themselves, so `ctx.bands.bass` on a dt line is caught as well as `band`. */
const AUDIO_WORDS = ['band', 'bands', 'e' + 'nv', 'mood', 'energy', 'bass', 'mid', 'high', 'beat', 'readBand', 'readVoiceBand'];
const AUDIO_WORD_RE = new RegExp(`\\b(${AUDIO_WORDS.join('|')})\\b`);
/** The one legitimate place a band and a dt meet: the envelope smoothers,
 * whose entire job is to ease a band value over time. */
const ENVELOPE_CALL_RE = /\b(smoothAR|onePole)\s*\(/;
const DT_RE = /\bctx\.dt\b|\breadDt\s*\(/;

function scanForAudioScaledTime(source) {
  const hits = [];
  let scanned = 0;
  source.split('\n').forEach((raw, i) => {
    const code = raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    if (!DT_RE.test(code)) return;
    scanned++;
    if (ENVELOPE_CALL_RE.test(code)) return;
    if (AUDIO_WORD_RE.test(code)) hits.push({ line: i + 1, code: code.trim() });
  });
  return { hits, scanned };
}

test('F1 source shape: no audio value scales a dt term in showCharacters.js', () => {
  const source = readFileSync(new URL('./showCharacters.js', import.meta.url), 'utf8');
  const { hits, scanned } = scanForAudioScaledTime(source);

  // Positive control: the scan found the dt lines at all. If a refactor moves
  // the timing math somewhere this cannot see, that is worth knowing.
  assert.ok(
    scanned >= 8,
    `the dt-line scan found only ${scanned} lines using ctx.dt/readDt in showCharacters.js. Every character advances a clock and an envelope, so there should be at least 8. The scan has lost its grip on the file and is no longer proving anything.`,
  );

  assert.deepEqual(
    hits, [],
    `AUDIO VALUE ON A TIME-SCALING LINE:\n${hits.map((h) => `  showCharacters.js:${h.line}  ${h.code}`).join('\n')}\n`
    + `  A line that multiplies or divides ctx.dt is advancing a clock, and an authored clock may not be scaled by audio.\n`
    + `  The only exempt form is a smoothAR()/onePole() call, where the band is the TARGET being eased, not a rate.`,
  );
});

// ============================================================
//  NEGATIVE CONTROLS — the guards, seen failing.
//
//  `SpinViolator` is the exact defect the F1 review demonstrated: a second
//  rotation rate, added alongside the authored one, that turns the piece
//  faster when the music is loud. Everything else about it is Trace. Each
//  probe above is pointed at it here and must reject it; a compliant twin
//  with the same second rate held CONSTANT must pass, so the probes are shown
//  to be discriminating rather than merely strict.
// ============================================================

/** Trace's kernel, reading whatever total rotation the caller's tick built. */
function tracelikeKernel(area, from, to, out, vr, ctx) {
  const theta = (vr.clock + (vr.spin || 0) + (vr.phase || 0)) * TAU;
  const bright = 0.05 + 0.85 * vr.env;
  const breadth = 0.35 + 0.30 * vr.env;
  for (let j = from; j < to; j++) {
    const a = area.angle[j] - theta - 0.9 * area.radius[j];
    const u = a * (2 / TAU);
    const f = u - Math.floor(u);
    const dA = Math.min(f, 1 - f) * (TAU / 2);
    let arm = clamp01(1 - dA / breadth);
    arm *= arm;
    out[area.pixelIndex[j]] += bright * arm;
  }
}

/**
 * @param extraTurnsPerSecond how fast the SECOND rotation rate spins.
 * @param audioScaled         true = the violation (rate rides the envelope);
 *                            false = the compliant twin (rate is a constant).
 */
function makeSpinCharacter(extraTurnsPerSecond, audioScaled) {
  return {
    key: audioScaled ? 'spin-violator' : 'spin-compliant',
    label: 'Spin', verb: 'spins', bands: ['mid'], cyclePeriod: 60,
    defaults: { clock: 0, spin: 0, env: 0, phase: 0 },
    tick(vr, ctx) {
      vr.clock = (vr.clock + ctx.dt / 60) % 1;            // the authored rate — legitimate
      vr.env = smoothAR(vr.env, readVoiceBand(ctx, 'mid'), 0.08, 1.0, ctx.dt);
      const rate = audioScaled ? extraTurnsPerSecond * vr.env : extraTurnsPerSecond;
      vr.spin = (vr.spin + ctx.dt * rate) % 1;            // the second rate
    },
    kernel: tracelikeKernel,
  };
}

// 16x the authored rotation under a loud band, which is the magnitude the F1
// review used, expressed as turns/second on top of Trace's 1/60.
const SIXTEEN_X = 15 / 60;
// And a deliberately subtle one: 5% faster at full scale. If the probe only
// caught the blatant version it would be a poor guard.
const FIVE_PERCENT = 0.05 / 60;

test('NEGATIVE CONTROL — the behavioural probe rejects a second, audio-scaled rotation rate (16x)', () => {
  const probe = runMotionProbe(makeSpinCharacter(SIXTEEN_X, true), MOTION_SPECS.trace);
  assert.ok(
    probe.spread > RATE_TOLERANCE,
    `the motion probe FAILED TO CATCH a 16x audio-scaled rotation: measured spread ${(probe.spread * 100).toFixed(4)}%, tolerance ${(RATE_TOLERANCE * 100).toFixed(2)}%.\n`
    + `This file's primary guard is broken — every "passes" above is now worthless.\n${reportRows(probe.rows)}`,
  );
});

test('NEGATIVE CONTROL — the behavioural probe rejects even a 5% audio-scaled rotation', () => {
  const probe = runMotionProbe(makeSpinCharacter(FIVE_PERCENT, true), MOTION_SPECS.trace);
  assert.ok(
    probe.spread > RATE_TOLERANCE,
    `the motion probe failed to catch a 5% audio-scaled rotation: measured spread ${(probe.spread * 100).toFixed(4)}%, tolerance ${(RATE_TOLERANCE * 100).toFixed(2)}%. The probe is less sensitive than this file claims.\n${reportRows(probe.rows)}`,
  );
});

test('POSITIVE CONTROL — the behavioural probe accepts a second rotation rate that is NOT audio-scaled', () => {
  // Same extra rotation, same second accumulator, same everything — except the
  // rate is a constant. The law is about audio touching a rate, not about how
  // many rates a character has, and the probe must not confuse the two.
  const probe = runMotionProbe(makeSpinCharacter(SIXTEEN_X, false), MOTION_SPECS.trace);
  assert.ok(
    probe.spread <= RATE_TOLERANCE,
    `the motion probe wrongly rejected a compliant character whose second rotation rate is a literal constant: spread ${(probe.spread * 100).toFixed(4)}%.\n${reportRows(probe.rows)}`,
  );
  assert.ok(Math.abs(probe.rows[0][1].travel) >= MIN_QUIET_TRAVEL, 'compliant control produced no motion to measure');
});

test('NEGATIVE CONTROL — the state inventory rejects an undeclared audio-driven accumulator', () => {
  const violator = makeSpinCharacter(SIXTEEN_X, true);
  const inv = stateInventory(violator, ['env']);   // declares only the envelope, as a real author would
  assert.deepEqual(
    inv.undeclared, ['spin'],
    `the state inventory failed to surface the smuggled 'spin' accumulator; it reported ${JSON.stringify(inv.undeclared)} instead.`,
  );
});

test('POSITIVE CONTROL — the state inventory accepts a constant-rate second accumulator', () => {
  const compliant = makeSpinCharacter(SIXTEEN_X, false);
  const inv = stateInventory(compliant, ['env']);
  assert.deepEqual(inv.undeclared, [], 'the state inventory wrongly flagged a second rotation rate that does not move with audio');
});

test('NEGATIVE CONTROL — the state inventory rejects a declared-but-inert field (the F2 shape)', () => {
  const inv = stateInventory(CHARACTERS.trace, ['env', 'somethingNobodyDrives']);
  assert.deepEqual(inv.inert, ['somethingNobodyDrives'], 'the inventory failed to notice a declared field that the audio never reaches');
});

test('NEGATIVE CONTROL — the source scan rejects a band value on a dt line', () => {
  const violating = [
    'export const Bad = {',
    '  tick(vr, ctx) {',
    '    vr.clock = (vr.clock + ctx.dt / TRACE_PERIOD) % 1;',
    '    vr.env = smoothAR(vr.env, readVoiceBand(ctx, "mid"), A, R, ctx.dt);',
    '    vr.spin += ctx.dt * (1 + 16 * vr.env);',
    '    vr.drift += ctx.dt * ctx.bands.bass;',
    '  },',
    '};',
  ].join('\n');
  const { hits } = scanForAudioScaledTime(violating);
  assert.deepEqual(hits.map((h) => h.line), [5, 6], `the source scan missed an audio-scaled dt term; it reported ${JSON.stringify(hits)}`);
});

test('POSITIVE CONTROL — the source scan does not flag a legitimate envelope or a constant rate', () => {
  const clean = [
    '    vr.clock = (vr.clock + ctx.dt / TRACE_PERIOD) % 1;',
    '    vr.env = smoothAR(vr.env, readVoiceBand(ctx, "mid"), A, R, ctx.dt);',
    '    vr.mood = onePole(vr.mood, band, GLOW_MOOD_TAU, ctx.dt);',
    '    vr.rippleR[k] += ctx.dt * RIPPLE_SPEED;',
    '    const step = SWELL_REACH_SLEW * readDt(ctx);   // slew cap, band never appears',
  ].join('\n');
  const { hits, scanned } = scanForAudioScaledTime(clean);
  assert.equal(scanned, 5, 'the scan did not see all five dt lines');
  assert.deepEqual(hits, [], `the source scan wrongly flagged legitimate code: ${JSON.stringify(hits)}`);
});
