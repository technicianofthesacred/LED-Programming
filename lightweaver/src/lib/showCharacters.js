// showCharacters.js — the five audio-reactive VOICE CHARACTERS for the Show
// music-responsive ensemble (Phase D of docs/music-reactive-build-plan.md).
// Pure ESM: no React, no DOM, no module-level mutable state — every
// character's state lives in the `vr` (voice runtime) object a caller owns
// and passes in, so N simultaneous voices of the SAME character (e.g. two
// Twinkle voices on different areas) never share a clock or an envelope.
//
// Each character is DERIVED from tuned math already in this codebase — see
// the per-character header comment below for its exact source. Nothing here
// invents a new visual effect; this module reshapes existing hand-tuned
// formulas from mandalaEngine.js's fx* functions and
// docs/mandala-audio-mapping.md into the { tick, kernel } shape the ensemble
// needs to run one instrument per named area instead of one mode for the
// whole piece.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE LOCKED AESTHETIC, ENFORCED STRUCTURALLY (see CLAUDE.md "LOCKED
// AESTHETIC" and showComposition.js's VOICE_CHARACTERS comment)
//
// Audio may modulate amplitude, breadth, contrast, position, texture. Audio
// may NEVER modulate an authored clock or rotation speed. This module makes
// that a structural fact, not a discipline:
//
//   - Every character's `tick(vr, ctx)` advances `vr.clock` by a literal
//     constant times `ctx.dt` ONLY — e.g. `vr.clock += ctx.dt / SWELL_PERIOD`.
//     No band, no envelope, no `vr.env` ever appears on the right-hand side
//     of a `vr.clock` (or per-voice rotation/travel-rate) assignment,
//     anywhere in this file. `mandalaMathAudioIsolation.test.js`-style
//     coverage for this lives in showCharacters.test.js: it pins the exact
//     wall-clock deltas each character's clock takes, band pinned at 0 vs 1,
//     for 200 ticks each, and asserts they match to within 1e-9.
//   - `vr.phase` (a 0..1 fraction of one authored cycle, assigned by the
//     ensemble from `deriveInstancePhases()` in symmetryFields.js — one
//     value per symmetry instance, mutated on `vr` between per-instance
//     `kernel()` calls) is always ADDED to a clock reading or used as an
//     angular offset. It is never multiplied against a rate.
//   - `tick()` runs ONCE PER VOICE PER FRAME (not once per instance) and
//     owns both the authored clock and the audio envelope. `kernel()` may
//     then be called once per symmetry instance, each time with `vr.phase`
//     set to that instance's own phase — see the wiring note at the bottom
//     of this file.
//
// Every envelope in this file is fast-attack / slow-release via
// `smoothAR()` (imported from mandalaMath.js — the SAME implementation
// mandalaEngine.js uses, not a second copy). This is the no-strobing law:
// a band can never cause the light to snap, only to ease.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE `vr` (VOICE RUNTIME) / `ctx` (FRAME CONTEXT) / `area` (PIXEL BINDING)
// CONTRACT
//
// This module is built ahead of showAreaBinding.js / showEnsemble.js
// (neither exists yet — both are later Phase D work, out of scope here).
// The shapes below are this module's half of that future contract; whoever
// builds the ensemble owns matching them, not the reverse.
//
//   vr (voice runtime — one per VOICE, mutable, owned by the caller):
//     Created via `cloneVoiceState(character)` (exported below), which deep-
//     clones `character.defaults` so independent voices of the same
//     character never share array/typed-array state. Every character's
//     defaults include at minimum `{ clock: 0, env: 0, phase: 0 }`; some add
//     their own extra fields (documented per character below).
//
//   ctx (frame context — one per FRAME, shared by every voice ticked/
//        rendered that frame):
//     {
//       dt: number,                 // seconds since the last tick
//       bands: { bass, mid, high, energy, beat, ... },  // 0..1 each,
//                                    // matching showComposition.js's
//                                    // AUDIO_BANDS vocabulary (minus 'none')
//       depth: number,               // 0..1 authored voice depth/gain,
//                                    // OPTIONAL — treated as 1 if absent
//     }
//       band: string|null,           // the band THIS VOICE listens to,
//                                    // resolved by the ensemble from the
//                                    // voice's authored `band` field —
//                                    // OPTIONAL; null/absent means "use the
//                                    // character's own recommended band"
//     }
//     Characters read bands via `readVoiceBand(ctx, fallback)` (exported
//     below), NOT via a hardcoded band name. Each character passes its own
//     `bands[0]` as the fallback, so:
//       - `ctx.band` names a band this frame's source produces -> that band
//         wins, which is what makes two voices of the SAME character on
//         different bands move differently (the entire point of an ensemble);
//       - `ctx.band` is absent, 'none', or names a band the current audio
//         source does NOT produce -> the character's own recommended band is
//         used, which is exactly the behavior this module had before voices
//         could choose;
//       - the fallback band is missing too -> `readBand()` returns 0 rather
//         than throwing, so a voice degrades to silent, never to an error.
//     A character's `bands:` array is therefore the RECOMMENDED default for
//     the picker and the fallback for the runtime — never a hard wiring.
//
//   area (pixel binding — one instance's worth of a symmetry group's
//         pixels, flattened typed arrays, SORTED BY INSTANCE so a kernel
//         call's [from, to) range belongs to exactly one instance):
//     {
//       pixelIndex: Int32Array | number[],  // out[] write target per j
//       radius:     Float32Array,           // normalized 0..1 radial
//                                            // position (rf, "radialProgress"
//                                            // in mandalaEngine's samples)
//       angle:      Float32Array,           // radians
//       seed:       Int32Array,             // per-pixel deterministic hash
//                                            // seed (mandalaEngine's
//                                            // `spatialKey`, or equivalent)
//     }
//     `kernel(area, from, to, out, vr, ctx)` loops `for (let j = from; j <
//     to; j++)` and writes/accumulates into `out[area.pixelIndex[j]]`. It
//     never reads or writes outside `[from, to)`, so the ensemble can slice
//     one call per instance without a character needing to know instances
//     exist.
//
// ─────────────────────────────────────────────────────────────────────────────
// WIRING NOTE for the future showEnsemble.js (not built here, not editable
// here — this is the same kind of forward note symmetryFields.js leaves for
// src/v3/lw-show.jsx):
//
//   per frame, per voice:
//     tick(vr, ctx)                                   // once
//     for each symmetry instance i of the voice's area:
//       vr.phase = plan.phases[i]                     // from
//                                                      // deriveInstancePhases()
//       kernel(area, instanceRanges[i].from, instanceRanges[i].to, out, vr, ctx)
//
// ─────────────────────────────────────────────────────────────────────────────
import { smoothAR, hash01, clamp01, arcGate, smoothstep } from './mandalaMath.js';

const TAU = Math.PI * 2;

/** Read a 0..1 audio band off a frame ctx; missing/non-finite -> 0. Never
 * throws — a voice authored against a band this audio source doesn't
 * produce simply reads as silent. */
export function readBand(ctx, name) {
  const bands = ctx && ctx.bands;
  if (!bands) return 0;
  const v = bands[name];
  return typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : 0;
}

/**
 * Read the band THIS VOICE was authored to listen to, falling back to the
 * character's own recommended band.
 *
 * `ctx.band` is set once per voice per frame by showEnsemble.js from the
 * voice's authored `band` field. This is the one function that makes
 * per-voice band selection real: a character calls it with its own
 * recommended band as the fallback and never names a band any other way.
 *
 * The fallback fires in two cases, both deliberate:
 *   - the voice named no band (or 'none') — nothing was authored, so the
 *     character's recommendation stands;
 *   - the voice named a band the CURRENT audio source does not produce —
 *     a program authored against a five-band analyser then played through a
 *     source that only emits `energy` should still breathe, not go dark.
 * Never throws; a completely missing bands object reads as 0.
 */
export function readVoiceBand(ctx, fallbackName) {
  const name = ctx && typeof ctx.band === 'string' ? ctx.band : null;
  if (name && name !== 'none') {
    const bands = ctx && ctx.bands;
    const v = bands ? bands[name] : undefined;
    if (typeof v === 'number' && Number.isFinite(v)) return clamp01(v);
  }
  return readBand(ctx, fallbackName);
}

/** Frame delta in seconds, guarded: a missing/non-finite/negative dt reads
 * as 0 (a frozen frame), never as NaN. */
function readDt(ctx) {
  const v = ctx && ctx.dt;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Authored per-voice depth/gain, 0..1; defaults to 1 (full) when the frame
 * ctx doesn't carry one. */
function readDepth(ctx) {
  const v = ctx && ctx.depth;
  return typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : 1;
}

/** Deep-clone a character's `defaults` into a fresh, independent `vr`
 * object — plain values copy directly, arrays/typed arrays are copied
 * element-wise so two voices of the same character never alias each
 * other's ripple slots, spark state, etc. */
export function cloneVoiceState(character) {
  return cloneValue(character.defaults);
}
function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return value.slice();
  if (Array.isArray(value)) return value.map(cloneValue);
  const out = {};
  for (const key of Object.keys(value)) out[key] = cloneValue(value[key]);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  THE EXPANDER, AND THE PERCUSSIVE FLARE (2026-08-21 legibility pass)
//
//  Owner direction, verbatim: "I don't need you to retune them, it wasn't
//  working great before. I need you to make sure they are responsive and we
//  will get some cool effects based on a variety of music."
//
//  `responsivenessProbe.js` turned that into numbers and found the same two
//  shapes missing from every character here, so both fixes are shared rather
//  than re-derived five times.
//
//  1. `expand()` — a PIVOTED power curve, `pivot * (x/pivot)^power`. A plain
//     `x^power` would have crushed genres that simply sit at a moderate level
//     (bass-heavy electronic measured a mid band of 0.23; `0.23^3` is 0.012,
//     i.e. off). The pivot fixes one operating point and only steepens the
//     curve THROUGH it: quiet gets quieter, loud gets louder, and a normal
//     record stays where it was. This is the "raise swing by lowering the
//     quiet end" lever, and it is why the quiet-to-loud ratios below moved
//     without the loud end getting brighter.
//
//  2. `flare()` — the beat accent. Measured cause of the two onset failures:
//     a fast-attack/SLOW-release envelope is a peak follower, so between two
//     kicks half a second apart it barely falls, and the next kick lifts it by
//     almost nothing. Trace's own band (mid) rose only 0.4% at a kick on
//     bass-heavy electronic and 3.1% on bright acoustic — no curve shaping can
//     turn 0.4% into a visible event without destroying every other genre.
//     The `beat` band (part of showComposition's AUDIO_BANDS vocabulary) is
//     the one channel that is percussive on EVERY profile, so a hit now
//     flares a NARROW part of the motif — Swell's crest ring, Trace's arm
//     core — rather than lifting the whole field.
//
//     It is squared on purpose: `beat` is already an attack/decay envelope
//     from the analyser, and squaring it makes the flare's own first frame a
//     small fraction of its peak, so the accent grows into place over several
//     frames instead of appearing. Measured largest single-frame whole-piece
//     move afterwards: 0.137 (Swell), against the 0.25 the no-strobing gate
//     fires at. The flare fades on the beat envelope's own decay, which is
//     wall clock — no authored rate is touched by any of this.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Soft-knee expander. BELOW the pivot it is a power curve anchored so that
 * `pivot -> pivot`; ABOVE the pivot it is the identity, continued from that
 * same point. So the quiet end falls away, a normal record comes through where
 * it was, and the loud end keeps its full range.
 *
 * The "above the pivot" half is not decoration. A single pivoted power,
 * `pivot * (x/pivot)^power`, reaches 1 well before x does — at pivot 0.45 and
 * power 1.5 it saturates at x = 0.766 — so the loudest quarter of the input
 * range would all render identically, and a loud record and a very loud record
 * would look the same. That is the owner's original complaint pushed to the
 * other end of the scale. It also mattered for Glow's silence decay: a flat
 * top means the first second of a fade produces no visible change at all.
 *
 * A pivot of 1 degenerates to a plain gamma (`x^power`), which is what Glow
 * uses so that its eight-second decay is exact from the first frame.
 */
export function expand(x, pivot, power) {
  const v = clamp01(x);
  if (!(v > 0)) return 0;
  if (v >= pivot) return clamp01(pivot + (v - pivot));
  return clamp01(pivot * Math.pow(v / pivot, power));
}

/** The percussive accent, read straight off the `beat` band. Squared so the
 * accent eases in over several frames rather than landing whole. Stateless by
 * design: it carries no clock and no memory, so it cannot drift or accumulate. */
function flare(ctx) {
  const b = readBand(ctx, 'beat');
  return b * b;
}

// ============================================================
//  1. SWELL — derived from fxTide (mandalaEngine.js ~:577-591) + the
//     fxHearth swell term (~:476). Audio scales REACH (how far the breath
//     travels outward) and AMPLITUDE (its brightness). The breath's own
//     18s authored cycle is a literal constant divide of `ctx.dt` — no band
//     ever touches SWELL_PERIOD.
// ============================================================
const SWELL_PERIOD = 18;          // seconds per authored breath — LITERAL, never scaled by audio
const SWELL_ATTACK_TAU = 0.07;    // fast attack (was 0.06)
// Release was 1.2s, which made the envelope a peak follower: on a 120bpm kick
// it fell only ~34% between beats, so each new kick lifted it by almost
// nothing. 0.80s falls ~54% in the same gap, and is still comfortably a slow
// release (it takes 0.73s to drop below 40%, against the 0.6s floor the
// no-strobing timing test asserts).
const SWELL_RELEASE_TAU = 0.80;
const SWELL_LOBES = 2;
const SWELL_ARC_WIDTH = 0.85;
const SWELL_REACH_BASE = 0.55;    // reach gain at silence
const SWELL_REACH_SPAN = 0.45;    // how much of the gain audio owns (0.55..1.00)
// Amplitude curve. The old `0.25 + 0.75*env` pedestal was 25% of full at
// literal silence, which is what capped the quiet-to-loud ratio at 4.98x.
const SWELL_AMP_FLOOR = 0.10;
const SWELL_AMP_SPAN = 0.90;
const SWELL_EXPAND_PIVOT = 0.45;  // a normal record's settled bass envelope
const SWELL_EXPAND_POWER = 1.5;
const SWELL_FLARE = 0.30;         // how hard a beat lights the crest ring

/**
 * THE CREST-TRAVEL SPEED LIMIT (F7).
 *
 * Audio is allowed to move the crest's POSITION — that permission is what
 * makes Swell work, and it is not being withdrawn here. What audio is NOT
 * allowed to do is make the crest look like it ACCELERATED, because a
 * position that snaps to a new place reads to the eye as a travel rate that
 * sped up, which is the one thing the locked aesthetic forbids.
 *
 * So `vr.reachGain` chases its audio-driven target through a SLEW LIMITER
 * rather than jumping to it: it may change by at most SWELL_REACH_SLEW per
 * second. The crest still travels wherever the music sends it; it simply can
 * never appear to accelerate getting there.
 *
 * The number: the authored breath alone moves the crest at up to
 * `0.80 * (pi / SWELL_PERIOD)` ~= 0.140 units/s. At the widest reach (~0.94)
 * a gain slew of 0.15/s adds at most ~0.141 units/s on top, so the crest's
 * total travel rate is capped at ~2x the authored breath's own maximum —
 * measured, not asserted: see showCharacters.test.js. Before this limiter the
 * same measurement read 2.79 units/s under repeated kicks (36x the
 * authored-only rate) and 3.64 units/s under an alternating band (47x).
 */
export const SWELL_REACH_SLEW = 0.15;   // gain units per second — the crest speed limit

export const Swell = {
  key: 'swell',
  label: 'Swell',
  verb: 'breathes',
  bands: ['bass'],
  cyclePeriod: SWELL_PERIOD,
  defaults: { clock: 0, env: 0, phase: 0, reachGain: SWELL_REACH_BASE },
  tick(vr, ctx) {
    // Authored breath clock — dt-only, band NEVER appears here.
    vr.clock = (vr.clock + ctx.dt / SWELL_PERIOD) % 1;
    vr.env = smoothAR(vr.env, readVoiceBand(ctx, 'bass'), SWELL_ATTACK_TAU, SWELL_RELEASE_TAU, ctx.dt);
    // Slew-limited reach gain — see SWELL_REACH_SLEW. Position may go
    // anywhere the music asks; it may not get there at a speed the eye
    // reads as acceleration.
    const step = SWELL_REACH_SLEW * readDt(ctx);
    const delta = (SWELL_REACH_BASE + SWELL_REACH_SPAN * vr.env) - vr.reachGain;
    vr.reachGain += delta > step ? step : (delta < -step ? -step : delta);
  },
  kernel(area, from, to, out, vr, ctx) {
    const depth = readDepth(ctx);
    const cyclePos = vr.clock + (vr.phase || 0);
    const breath = 0.5 + 0.5 * Math.sin(TAU * cyclePos);      // 0..1, purely time-driven — the authored breath shape
    const reach = 0.14 + 0.80 * breath;                        // authored radial reach envelope (never touched by audio)
    const reachGain = Number.isFinite(vr.reachGain) ? vr.reachGain : SWELL_REACH_BASE;   // AUDIO SCALES REACH (slew-limited in tick)
    const R = clamp01(reach * reachGain);
    // AUDIO SCALES AMPLITUDE — through the expander, so a quiet passage drops
    // away instead of sitting at a quarter brightness.
    const ampGain = SWELL_AMP_FLOOR
      + SWELL_AMP_SPAN * expand(vr.env, SWELL_EXPAND_PIVOT, SWELL_EXPAND_POWER);
    // The beat accent rides the CREST RING only (crest², so it is the leading
    // edge of the breath that answers the hit, never the whole field), and it
    // is gated by the same authored arc as the body, so the structure's
    // angular position is exactly where it already was.
    const flareGain = SWELL_FLARE * flare(ctx);
    for (let j = from; j < to; j++) {
      const rf = area.radius[j];
      const ang = area.angle[j];
      const inside = clamp01((R - rf) / 0.18 + 1);
      const crest = clamp01(1 - Math.abs(rf - R) / 0.16);
      const arc = 0.55 + 0.45 * arcGate(ang, SWELL_LOBES, SWELL_ARC_WIDTH, cyclePos * 0.5);
      const v = (inside * (0.10 + 0.85 * breath) * arc + crest * (breath * 0.35)) * ampGain;
      out[area.pixelIndex[j]] += (v + flareGain * crest * crest * arc) * depth;
    }
  },
};

// ============================================================
//  2. TWINKLE — derived from mandala-audio-mapping.md §0.3 Sparkle + the
//     ignition shape of fxEmbers (mandalaEngine.js ~:491), DELIBERATELY
//     DROPPING Embers' 16-epoch lookback: a Twinkle spark is a single-
//     bucket stochastic event with no remembered lifetime, so Twinkle reads
//     as fast rim-shimmer rather than Embers' slow-lived coals. Audio
//     scales IGNITION PROBABILITY and SPARK BRIGHTNESS only — never spark
//     lifetime (there isn't one) and never the bucket rate (TWINKLE_BUCKET_HZ
//     is a literal constant).
// ============================================================
const TWINKLE_BUCKET_HZ = 20;              // == Sparkle spec's `floor(t*20)` — LITERAL, never scaled by audio
const TWINKLE_PERIOD = 1 / TWINKLE_BUCKET_HZ;
const TWINKLE_ATTACK_TAU = 0.05;
const TWINKLE_RELEASE_TAU = 0.75;          // was 0.9 — crisper between hits, still a slow release
// Ignition coefficient. The Sparkle spec's 0.035 left the median lit fraction
// across the four continuously-playing genres at 0.0219, i.e. fourteen pixels
// of a 675-pixel mandala — barely over the "sparse stops being visible" line,
// and only 0.0025 on bass-heavy electronic. 0.055 lifts the median to roughly
// 0.034 without touching WHICH pixels spark or how long a spark lives.
const TWINKLE_IGNITE_GAIN = 0.055;
// Brightness curve. Mildly expanded so a bright record's sparks are hotter
// than a dim one's; the floor stays high enough that a spark is always a
// spark (peak pixel must stay above 0.6 for the sparse-effect bar).
const TWINKLE_BRIGHT_FLOOR = 0.40;
const TWINKLE_BRIGHT_SPAN = 0.60;
const TWINKLE_EXPAND_PIVOT = 0.5;
const TWINKLE_EXPAND_POWER = 1.3;

/**
 * THE SPARK ENVELOPE (F5).
 *
 * A spark used to be a 50ms square pulse: full brightness for one whole
 * bucket, then nothing, both edges landing inside a single frame. That
 * contradicted this file's own no-strobing law.
 *
 * A spark now IGNITES over TWINKLE_SPARK_ATTACK and FADES over
 * TWINKLE_SPARK_DECAY, so at 60fps it rises across ~2.4 frames and falls
 * across ~4.8 — still a spark, not a swell, but nothing appears or vanishes
 * in one frame. The envelope is a pure function of the spark's AGE, and age
 * is (bucket phase + whole buckets elapsed) — all wall clock, so no band
 * value can reach it.
 *
 * Because a spark now outlives its own bucket, the kernel looks back
 * TWINKLE_SPARK_BUCKETS buckets and sums whichever are still alight. The
 * ignition draw for a given (pixel, bucket) is unchanged, so WHICH pixels
 * spark is identical to before; only the temporal shape changed.
 */
const TWINKLE_SPARK_ATTACK = 0.04;         // seconds, dark -> full
const TWINKLE_SPARK_DECAY = 0.08;          // seconds, full -> dark
const TWINKLE_SPARK_LIFE = TWINKLE_SPARK_ATTACK + TWINKLE_SPARK_DECAY;   // 0.12s
// How many past buckets can still be alight: ceil(life / bucket period).
const TWINKLE_SPARK_BUCKETS = Math.ceil(TWINKLE_SPARK_LIFE * TWINKLE_BUCKET_HZ);

/** 0 at birth, 1 at TWINKLE_SPARK_ATTACK, 0 again at TWINKLE_SPARK_LIFE.
 * Continuous at both ends — that continuity IS the no-snap guarantee. */
export function sparkEnvelope(age) {
  if (!(age > 0) || age >= TWINKLE_SPARK_LIFE) return 0;
  if (age < TWINKLE_SPARK_ATTACK) return age / TWINKLE_SPARK_ATTACK;
  return (TWINKLE_SPARK_LIFE - age) / TWINKLE_SPARK_DECAY;
}

export const Twinkle = {
  key: 'twinkle',
  label: 'Twinkle',
  verb: 'sparkles',
  bands: ['high'],
  cyclePeriod: TWINKLE_PERIOD,
  defaults: { clock: 0, env: 0, phase: 0 },
  tick(vr, ctx) {
    // Plain wall-clock accumulation — band never touches this, so the
    // bucket rate a Twinkle voice samples at is fixed regardless of volume.
    vr.clock += ctx.dt;
    vr.env = smoothAR(vr.env, readVoiceBand(ctx, 'high'), TWINKLE_ATTACK_TAU, TWINKLE_RELEASE_TAU, ctx.dt);
  },
  kernel(area, from, to, out, vr, ctx) {
    const depth = readDepth(ctx);
    // vr.phase ADDS a fraction of one bucket-period to the clock reading —
    // never multiplies the bucket rate.
    const buckets = (vr.clock + (vr.phase || 0) * TWINKLE_PERIOD) * TWINKLE_BUCKET_HZ;
    const bucket = Math.floor(buckets);
    const bucketFrac = buckets - bucket;                 // 0..1 through the current bucket
    // AUDIO SCALES SPARK BRIGHTNESS
    const brightnessGain = TWINKLE_BRIGHT_FLOOR
      + TWINKLE_BRIGHT_SPAN * expand(vr.env, TWINKLE_EXPAND_PIVOT, TWINKLE_EXPAND_POWER);
    // The buckets whose sparks are still alight, with each one's envelope
    // weight. Pure wall clock — TWINKLE_BUCKET_HZ and the spark envelope are
    // both literal constants, so a spark's lifetime never moves with music.
    const liveBuckets = [];
    const liveWeights = [];
    for (let k = 0; k < TWINKLE_SPARK_BUCKETS; k++) {
      const e = sparkEnvelope((bucketFrac + k) * TWINKLE_PERIOD);
      if (e > 0) { liveBuckets.push(bucket - k); liveWeights.push(e); }
    }
    const live = liveBuckets.length;
    if (!live) return;
    for (let j = from; j < to; j++) {
      const rf = area.radius[j];
      const seed = area.seed[j];
      const p = TWINKLE_IGNITE_GAIN * vr.env * rf * rf;   // AUDIO SCALES IGNITION PROBABILITY
      if (!(p > 0)) continue;
      let lit = 0;
      for (let a = 0; a < live; a++) {
        if (hash01(seed, liveBuckets[a]) < p) lit += liveWeights[a];
      }
      if (lit > 0) out[area.pixelIndex[j]] += brightnessGain * lit * depth;
    }
  },
};

// ============================================================
//  3. RIPPLE — derived verbatim from mandala-audio-mapping.md §3 "Radial
//     Ripple". Max 3 live wavefronts. Travel speed (RIPPLE_SPEED) is a
//     LITERAL CONSTANT (0.9/s) — audio (hit strength) scales AMPLITUDE
//     ONLY and must NEVER reach RIPPLE_SPEED or the r += ctx.dt * ... line
//     below. Onset/kick detection reuses the exact hysteresis shape
//     mandalaEngine.js's onset layer uses (arm below a low threshold +
//     refractory, fire above a high threshold).
// ============================================================
const RIPPLE_SPEED = 0.9;              // literal units/s — DO NOT let audio touch this
const RIPPLE_MAX_R = 1.35;
const RIPPLE_SLOTS = 3;

/**
 * THE DETECTOR THAT COULD NEVER RE-ARM (2026-08-21).
 *
 * The onset layer used two ABSOLUTE thresholds: fire above 0.35, re-arm below
 * 0.18. Any track whose bass floor never dips under 0.18 — which is most
 * tracks, and all three of dense rock, bass-heavy electronic and bright
 * acoustic in `responsivenessProbe.js` — fired ONE wavefront on the first
 * frame of playback and then nothing, ever. Measured lit fraction on those
 * three genres: 0.000. The piece was literally unlit while music played, and
 * that is what produced the worst single result in the sweep (a quiet-to-loud
 * ratio of 1.035 against a 3.0 bar).
 *
 * The detector is now RELATIVE: a wavefront is born when the raw band rises
 * meaningfully ABOVE its own smoothed envelope — the classic flux test —
 * and re-arms once the band has fallen back below that envelope. Both halves
 * are differences between two audio values, so the detector has no absolute
 * floor to be stranded above, and it fires on the same musical event whether
 * the record is mastered quiet or loud.
 *
 * `RIPPLE_ONSET_FLOOR` is not a second hysteresis threshold — it is a
 * noise gate, low enough that any real bass instrument clears it, present so
 * that dither on a silent input cannot spawn wavefronts.
 */
const RIPPLE_ONSET_RISE = 0.055;       // how far above its own envelope a band must jump
const RIPPLE_ONSET_DROP = 0.005;       // how far back below it the band must fall to re-arm
const RIPPLE_ONSET_FLOOR = 0.05;       // noise gate, not a hysteresis threshold
const RIPPLE_REFRACTORY = 0.10;        // seconds

const RIPPLE_PERIOD = RIPPLE_MAX_R / RIPPLE_SPEED;   // ~1.5s, one wavefront's authored lifetime
const RIPPLE_ENV_ATTACK_TAU = 0.06;    // ambient-base envelope — same shape as Swell's
// 0.75s rather than 1.2s: the envelope is also the detector's reference now,
// and a reference that barely falls between two kicks cannot see the second
// one. Still a slow release (0.69s to fall below 40%).
const RIPPLE_ENV_RELEASE_TAU = 0.75;

/**
 * THE AMBIENT BED.
 *
 * It used to be `0.04 + 0.10*env*(inner 30% only)` — a flat, constant 0.04
 * wash over the whole piece with a small centre brightening. That constant is
 * why Ripple's silence floor measured 0.040 (the highest of any character,
 * ten times Trace's) while its music level measured 0.042: the bed WAS the
 * output, and it did not move. It now has no constant term at all — it is a
 * concentric standing-ripple field whose brightness is entirely the expanded
 * bass envelope, so silence is dark and a bass line is a visibly breathing
 * ring pattern even between wavefronts. The ring geometry is a pure function
 * of radius, so it adds structure without adding motion of its own.
 */
const RIPPLE_BED_GAIN = 0.85;
const RIPPLE_BED_PIVOT = 0.45;
// Deliberately LINEAR, where the other four characters expand. A wavefront's
// amplitude is linear in the hit strength that spawned it, and the radial
// aesthetic-law probe measures the centroid of (frame - time-average): if the
// bed and the wavefronts answered the same music with different curves, the
// mix between them would shift with loudness, the centroid would be dragged by
// a different amount at each level, and the probe would read a wavefront
// speed that moves with volume (measured at power 1.25: 2.44% spread against a
// 2% limit). Matching the curves keeps the bed a bed. The quiet end is dark
// enough already — the bed has no constant term at all.
const RIPPLE_BED_POWER = 1.0;
const RIPPLE_BED_RINGS = 2.6;          // concentric rings across the radius
const RIPPLE_BED_RING_DEPTH = 0.5;     // how deep the ring troughs cut

/**
 * THE WAVEFRONT BIRTH/DEATH ENVELOPE (F6).
 *
 * A wavefront used to appear at full amplitude on its spawn frame and be
 * switched off the instant r passed RIPPLE_MAX_R — both single-frame edges,
 * in a file whose header claims every envelope eases.
 *
 * It now fades IN over its first RIPPLE_ATTACK_R units of travel and OUT
 * over its last RIPPLE_FADE_R. Both are measured in TRAVEL, and travel is
 * `r += dt * RIPPLE_SPEED` with RIPPLE_SPEED a literal constant — so the
 * envelope is a pure function of wall clock since spawn, and no band value
 * can shorten or lengthen it. At RIPPLE_SPEED = 0.9/s an attack of 0.06
 * units is ~67ms (~4 frames at 60fps): still a kick, never a snap.
 */
const RIPPLE_ATTACK_R = 0.06;          // units of travel spent easing in
const RIPPLE_FADE_R = 0.18;            // units of travel spent easing out

/** Smooth 0 -> 1 -> 0 across one wavefront's authored travel. */
export function rippleEnvelope(r) {
  if (!(r >= 0) || r > RIPPLE_MAX_R) return 0;
  return smoothstep(r / RIPPLE_ATTACK_R) * smoothstep((RIPPLE_MAX_R - r) / RIPPLE_FADE_R);
}

function spawnRipple(vr, strength) {
  let slot = -1;
  for (let k = 0; k < RIPPLE_SLOTS; k++) {
    if (!vr.rippleActive[k]) { slot = k; break; }
  }
  if (slot < 0) {
    // all three live — replace the oldest (largest r = closest to dying)
    let maxR = -1;
    for (let k = 0; k < RIPPLE_SLOTS; k++) {
      if (vr.rippleR[k] > maxR) { maxR = vr.rippleR[k]; slot = k; }
    }
  }
  vr.rippleActive[slot] = 1;
  vr.rippleR[slot] = 0;
  vr.rippleStrength[slot] = clamp01(strength);
  // phase = frac(birthTime * 1.113) * 2π — seeded from TIME, never from the
  // strength/band value, so a louder hit never travels or spokes differently.
  const frac = (vr.clock * 1.113) % 1;
  vr.ripplePhase[slot] = frac * TAU;
}

export const Ripple = {
  key: 'ripple',
  label: 'Ripple',
  verb: 'ripples',
  bands: ['bass'],
  cyclePeriod: RIPPLE_PERIOD,
  defaults: {
    clock: 0, env: 0, phase: 0,
    armed: true, lastKickAt: -Infinity,
    rippleActive: new Uint8Array(RIPPLE_SLOTS),
    rippleR: new Float32Array(RIPPLE_SLOTS),
    rippleStrength: new Float32Array(RIPPLE_SLOTS),
    ripplePhase: new Float32Array(RIPPLE_SLOTS),
  },
  tick(vr, ctx) {
    vr.clock += ctx.dt;   // plain wall clock — never derived from band
    const band = readVoiceBand(ctx, 'bass');
    // Ambient-base envelope (fast attack / slow release) — the kernel's
    // background term rides this instead of the raw band, so the "no
    // strobing" law holds even between kicks. Onset detection below still
    // reads the raw band directly, exactly like the source spec's kick
    // detector (a threshold crossing needs the fast signal, not the eased
    // one) — only the ambient wash is smoothed.
    const reference = vr.env;   // the envelope BEFORE this frame's update
    vr.env = smoothAR(vr.env, band, RIPPLE_ENV_ATTACK_TAU, RIPPLE_ENV_RELEASE_TAU, ctx.dt);

    // Relative onset detection — see the RIPPLE_ONSET_RISE comment above.
    // `rise` is the difference between two audio values, so it carries no
    // absolute level and cannot strand the detector above a loud track's floor.
    const rise = band - reference;
    if (!vr.armed && rise < -RIPPLE_ONSET_DROP && (vr.clock - vr.lastKickAt) >= RIPPLE_REFRACTORY) {
      vr.armed = true;
    }
    if (vr.armed && rise >= RIPPLE_ONSET_RISE && band >= RIPPLE_ONSET_FLOOR) {
      vr.armed = false;
      vr.lastKickAt = vr.clock;
      spawnRipple(vr, band);
    }

    // Advance every LIVE wavefront at the literal constant rate. This loop
    // is the one place a "no strobing" style rule is actually a hard
    // physical rule: RIPPLE_SPEED is a number, not a function of `band`.
    for (let k = 0; k < RIPPLE_SLOTS; k++) {
      if (!vr.rippleActive[k]) continue;
      vr.rippleR[k] += ctx.dt * RIPPLE_SPEED;
      if (vr.rippleR[k] > RIPPLE_MAX_R) vr.rippleActive[k] = 0;
    }
  },
  kernel(area, from, to, out, vr, ctx) {
    const depth = readDepth(ctx);
    const phaseOffset = (vr.phase || 0) * TAU;   // angular offset only — never touches r or RIPPLE_SPEED
    // The ambient bed's brightness — expanded, and with no constant term, so
    // silence is dark and a bass line breathes.
    const bed = RIPPLE_BED_GAIN * expand(vr.env, RIPPLE_BED_PIVOT, RIPPLE_BED_POWER);
    for (let j = from; j < to; j++) {
      const rf = area.radius[j];
      const ang = area.angle[j] + phaseOffset;
      let sum = 0;
      for (let k = 0; k < RIPPLE_SLOTS; k++) {
        if (!vr.rippleActive[k]) continue;
        const r = vr.rippleR[k];
        const rEff = r + 0.05 * Math.sin(9 * ang + vr.ripplePhase[k]);
        const d = rf - rEff;
        let w = clamp01(1 - Math.abs(d) / 0.12);
        w *= w;
        const spoke = 0.7 + 0.3 * Math.sin(9 * ang - 2 * r);
        // rippleEnvelope(r) is the birth/death ease — a function of travel,
        // therefore of wall clock, therefore never of the band.
        sum += vr.rippleStrength[k] * rippleEnvelope(r) * (1 - 0.55 * r) * w * spoke;   // AUDIO (hit strength) SCALES AMPLITUDE ONLY
      }
      // Concentric standing ripples, brightest at the centre. Geometry only —
      // a pure function of radius, so the bed adds structure without adding
      // any motion that could be mistaken for a travel rate.
      const rings = (1 - RIPPLE_BED_RING_DEPTH)
        + RIPPLE_BED_RING_DEPTH * (0.5 + 0.5 * Math.cos(TAU * RIPPLE_BED_RINGS * rf));
      const base = bed * (0.18 + 0.82 * clamp01(1.15 - rf)) * rings;
      // NOTE: no per-character ceiling here, deliberately. Ripple used to
      // write `Math.min(1, base + sum)`, and with the old near-dark bed that
      // ceiling was almost never reached. With a bed that actually answers the
      // bass it is reached often — and a clip is an amplitude nonlinearity,
      // which bends the 9-fold spoke harmonic's phase by an amount that
      // depends on how loud the hit was. `aestheticLaw.test.js` reads that as
      // the wavefront travelling at a different speed under a louder kick
      // (measured: 8.27% spread across a 2.5x hit range, against a 2% limit),
      // and it is right to — a structure whose apparent position moves with
      // volume is the thing the locked aesthetic forbids. Every other
      // character accumulates unclamped and lets the ensemble composite and
      // clamp once; Ripple now does the same.
      out[area.pixelIndex[j]] += (base + sum) * depth;
    }
  },
};

// ============================================================
//  4. GLOW — derived from fxHearth's mood bed (mandalaEngine.js ~:475-486,
//     `mood = 0.10 + 0.35*CLK.energyTrend`, a genuine 20s one-pole) plus
//     mandala-audio-mapping.md §6 "Temperature Field". Audio scales LEVEL
//     ONLY. Doubles as the ensemble's ground-layer kernel (the dim
//     living-coal field the piece never goes darker than). Two time
//     constants, both faithful to their sources and both audio-safe:
//       - `vr.mood`: a TRUE one-pole (20s, via mandalaMath's onePole —
//         wait, this file imports smoothAR not onePole; mood is
//         implemented with smoothAR at equal attack/release tau, which
//         IS a one-pole — see GLOW_MOOD_TAU below) — the slow drifting
//         backdrop fxHearth's `mood` term is.
//       - `vr.env`: a normal fast-attack/slow-release envelope on `energy`
//         (matching §0.1's `energySlow` role for the Temperature Field) —
//         this is what the required attack/release timing test measures.
//     Both feed brightness LEVEL only; neither touches the authored drift
//     angle below, which advances at a literal constant rate.
// ============================================================
const GLOW_DRIFT_RATE = 0.08;                          // rad/s — == fxHearth's driftPhase, Temperature's driftPhase
const GLOW_DRIFT_PERIOD = TAU / GLOW_DRIFT_RATE;        // ~78.5s for one full drift revolution
const GLOW_MOOD_TAU = 20;                               // == fxHearth's CLK.energyTrend one-pole (RISE only — see below)
const GLOW_ENV_ATTACK_TAU = 0.15;
const GLOW_LOBES = 3;

/**
 * WHY GLOW LISTENS TO A SECOND BAND (2026-08-21).
 *
 * `mandala-audio-mapping.md` §6 calls this the Temperature Field, and
 * temperature is a SPECTRAL question, not a loudness one. Glow was reading
 * `energy` alone — and `energy` is `0.5*bass + 0.35*mid + 0.25*high`, which
 * for the probe's two band-discrimination references measures 0.34 (bass-heavy
 * electronic) and 0.338 (bright acoustic). Those two records are as different
 * as two records get, and by that definition they are the same number. Glow
 * could not tell them apart because there was nothing in its input to tell
 * apart, which is exactly what its 0.065 discrimination score was reporting.
 *
 * The level source is now `energy + GLOW_HIGH_TILT * high`, clamped. A bright
 * record runs hot, a bass record runs deep and dim, and the voice's own
 * authored band still leads (with `high` silent the target IS the voice band,
 * which is what keeps per-voice band selection honest). Loudness still moves
 * it; the tilt only decides how hot the same loudness reads.
 */
const GLOW_HIGH_TILT = 1.6;

/**
 * THE LEVEL CURVE.
 *
 * `level = 0.15 + 0.65*drive` put a 0.15 pedestal under everything — 46% of
 * Glow's own loud level, and 4.8x the legacy coal floor. That single constant
 * is what held its quiet-to-loud ratio to 2.93 and its silence floor to
 * 0.1375: the quiet end structurally could not get dark.
 *
 * The replacement is deliberately NOT "as low as possible", because of the
 * OTHER half of the silence law: "never black, NEVER FROZEN". Glow is
 * showEnsemble's ground layer, and the ensemble applies a hard
 * LIVING_COAL_FLOOR of 0.0390625 to every pixel after everything else. A Glow
 * bed dimmer than that floor is not merely dim — it is invisible, because the
 * floor overwrites it, and the resting piece becomes a perfectly flat field
 * with no drift in it at all. 0.08 puts the bed's lobe peaks at about twice
 * the hard floor while the troughs rest on it, so the idle coal field keeps
 * slowly turning instead of only being non-black.
 *
 * Measured consequence of Glow's whole rework, at the Active preset:
 * quiet-to-loud 7.65x (was 2.93x), weakest-genre lift 4.51x (was 2.40x), band
 * discrimination 0.645 (was 0.065), spatial variation 0.288 (was 0.053).
 *
 * The number is bounded from ABOVE too, and by the same aesthetic rather than
 * by a test: at 0.23 — the pedestal that would keep a half-level ground layer
 * entirely above the hard floor — the weakest genre lifts only 2.24x, i.e.
 * bass-heavy music becomes indistinguishable from silence again.
 */
const GLOW_FLOOR = 0.08;
const GLOW_SPAN = 0.85;
// Glow is the one character whose expander pivots at 1.0 rather than at a
// typical record's level, i.e. it is a plain gamma. Two reasons, and both
// matter: a pivot below 1 saturates before the drive reaches full, which would
// put a flat second at the top of the silence decay and stop the eight seconds
// below from being exact; and Glow (unlike Trace) never sees a genre whose
// input sits so low that a plain gamma would put it out.
const GLOW_EXPAND_PIVOT = 1;
const GLOW_EXPAND_POWER = 1.6;
const GLOW_ENV_WEIGHT = 0.80;   // the reactive envelope LEADS; the 20s mood bed only colours it

/**
 * THE TEXTURE.
 *
 * A 3-lobe ±7% ripple over a full-field level is, measured across pixels, a
 * uniform brighten: coefficient of variation 0.053 against a 0.20 bar, the
 * lowest of all fourteen effects. The lobes now cut to a tenth of full at
 * their troughs, plus a slow concentric breath, so the field has real warm
 * and cool regions the way a bed of coals does. Both are pure functions of
 * geometry and the authored drift clock.
 */
const GLOW_TEX_BASE = 0.72;
const GLOW_TEX_SPAN = 0.28;
const GLOW_RADIAL_RINGS = 1.35;
const GLOW_RADIAL_DEPTH = 0.22;

/**
 * THE ~8s SILENCE DECAY (F4).
 *
 * docs/mandala-effects-direction-v2.md: "Silence decays to a dim living-coal
 * field over roughly 8 seconds." That is a statement about what the room SEES,
 * so the eight seconds belongs to the RENDERED level, not to the raw envelope
 * underneath it.
 *
 * Both of Glow's DESCENDING time constants are therefore derived from the
 * spec's number rather than guessed. Since the rendered excursion is the drive
 * raised to GLOW_EXPAND_POWER, a drive falling with time constant
 * `8 * power / ln(1/0.05)` leaves the LIGHT at 5% of its starting excursion
 * after exactly 8 seconds. (Before the expander existed this reduced to the
 * `8 / ln(1/0.05)` ~= 2.671s the same comment used to name; the light and the
 * envelope were then the same curve.)
 *
 * Measured before this change (band 1 -> 0, dt = 1/60, fully settled):
 *   50% left after 4.2s, 20% after 18.4s, 10% after 32.2s, 5% after 46.0s.
 * That is the 30-60s the review measured, not the 8s the spec asks for.
 *
 * The RISING constants are untouched: mood still builds over a 20s one-pole
 * (fxHearth's slow bed) and env still attacks in 0.15s. Only the fall was
 * wrong. Note this makes mood's release faster than its attack, the opposite
 * of an envelope's usual shape, and that is deliberate: mood is a slow
 * BACKDROP that must not strand the piece in a lit state a minute after the
 * music stopped. The reactive envelope (`vr.env`) still obeys the
 * fast-attack / slow-release law, and it is the one the universal timing
 * tests measure.
 */
const GLOW_SILENCE_DECAY = 8;                           // seconds, from docs/mandala-effects-direction-v2.md
const GLOW_DECAY_RESIDUAL = 0.05;                       // what "reached the coal floor" means
const GLOW_RELEASE_TAU = (GLOW_SILENCE_DECAY * GLOW_EXPAND_POWER) / Math.log(1 / GLOW_DECAY_RESIDUAL);   // ~4.273s
const GLOW_ENV_RELEASE_TAU = GLOW_RELEASE_TAU;
const GLOW_MOOD_RELEASE_TAU = GLOW_RELEASE_TAU;

/**
 * Glow's rendered LEVEL before geometry — the quantity the ~8s silence decay
 * is a statement about. Exported because that is the contract worth testing:
 * the light, not the envelope underneath it. Rests at exactly GLOW_FLOOR, the
 * dim living coal the piece never goes below. */
export function glowLevel(vr) {
  const env = Number.isFinite(vr && vr.env) ? vr.env : 0;
  const mood = Number.isFinite(vr && vr.mood) ? vr.mood : 0;
  const drive = GLOW_ENV_WEIGHT * env + (1 - GLOW_ENV_WEIGHT) * mood;
  return GLOW_FLOOR + GLOW_SPAN * expand(drive, GLOW_EXPAND_PIVOT, GLOW_EXPAND_POWER);
}

export const Glow = {
  key: 'glow',
  label: 'Glow',
  verb: 'glows',
  bands: ['energy'],
  cyclePeriod: GLOW_DRIFT_PERIOD,
  defaults: { clock: 0, env: 0, mood: 0, phase: 0 },
  tick(vr, ctx) {
    // Authored drift — dt times a literal rate, never a band.
    vr.clock = (vr.clock + ctx.dt * GLOW_DRIFT_RATE) % TAU;
    // The Temperature Field's input: the voice's own band sets HOW MUCH, the
    // treble tilt sets HOW HOT. With no highs present this is exactly the
    // voice's band, so per-voice band selection still leads. See GLOW_HIGH_TILT.
    const band = clamp01(readVoiceBand(ctx, 'energy') * (1 + GLOW_HIGH_TILT * readBand(ctx, 'high')));
    // fxHearth's slow mood bed: still a 20s rise, but its fall is bounded by
    // the spec's ~8s silence decay — see GLOW_RELEASE_TAU.
    vr.mood = smoothAR(vr.mood, band, GLOW_MOOD_TAU, GLOW_MOOD_RELEASE_TAU, ctx.dt);
    // A normal fast-attack/slow-release envelope — the Temperature Field's
    // live-enough response, and what the universal timing test measures.
    vr.env = smoothAR(vr.env, band, GLOW_ENV_ATTACK_TAU, GLOW_ENV_RELEASE_TAU, ctx.dt);
  },
  kernel(area, from, to, out, vr, ctx) {
    const depth = readDepth(ctx);
    const angOffset = (vr.phase || 0) * TAU;
    // AUDIO SCALES LEVEL ONLY. The reactive envelope now leads the slow mood
    // bed rather than splitting it 50/50 — a multi-second average was the
    // measured reason the music did not read.
    const level = glowLevel(vr);
    const bucket = Math.floor(vr.clock * 4 / GLOW_DRIFT_RATE);    // slow texture flicker bucket — time-driven only
    for (let j = from; j < to; j++) {
      const rf = area.radius[j];
      const ang = area.angle[j] + angOffset;
      const seed = area.seed[j];
      const texture = GLOW_TEX_BASE + GLOW_TEX_SPAN * Math.sin(GLOW_LOBES * ang + vr.clock + 1.5 * rf);
      const radial = (1 - GLOW_RADIAL_DEPTH)
        + GLOW_RADIAL_DEPTH * (0.5 + 0.5 * Math.cos(TAU * GLOW_RADIAL_RINGS * rf - vr.clock * 1.4));
      const flicker = 0.985 + 0.03 * hash01(seed, bucket) * vr.env;
      out[area.pixelIndex[j]] += level * texture * radial * flicker * depth;
    }
  },
};

// ============================================================
//  5. TRACE — derived from fxProcession (mandalaEngine.js ~:558-574).
//     Authored 60s/revolution — a literal constant divide of ctx.dt, never
//     touched by audio. Audio scales AMPLITUDE and BREADTH (arm width),
//     never theta (the rotation angle) or its velocity.
// ============================================================
const TRACE_PERIOD = 60;               // seconds/revolution — LITERAL, never scaled by audio
const TRACE_ARMS = 2;
const TRACE_ATTACK_TAU = 0.06;         // was 0.08
const TRACE_RELEASE_TAU = 0.75;        // was 1.0 — see the peak-follower note on the expander above
const TRACE_BRIGHT_FLOOR = 0.02;       // was 0.05
const TRACE_BRIGHT_SPAN = 0.90;
const TRACE_BREADTH_FLOOR = 0.22;      // was 0.35 — a quiet passage narrows to a thread
const TRACE_BREADTH_SPAN = 0.40;       // was 0.30
const TRACE_EXPAND_PIVOT = 0.45;
const TRACE_EXPAND_POWER = 1.6;
/**
 * The beat accent, on the ARM CORE only (`arm²`, i.e. the inner half of an
 * already narrow arm). Trace's own band is the reason it needs one: measured
 * against `responsivenessProbe.js`, the mid band rises 0.4% at a kick on
 * bass-heavy electronic and 3.1% on bright acoustic, because a mid band on
 * most records is a sustained wash with the percussion buried in it. No
 * amount of curve shaping turns 0.4% into a visible event without making
 * every mid-level record dark, so the hit is read off `beat` instead and
 * lands somewhere specific rather than lifting the whole arm.
 */
const TRACE_FLARE = 0.25;

export const Trace = {
  key: 'trace',
  label: 'Trace',
  verb: 'traces',
  bands: ['mid'],
  cyclePeriod: TRACE_PERIOD,
  defaults: { clock: 0, env: 0, phase: 0 },
  tick(vr, ctx) {
    // Authored revolution clock — dt-only division by a literal period.
    vr.clock = (vr.clock + ctx.dt / TRACE_PERIOD) % 1;
    vr.env = smoothAR(vr.env, readVoiceBand(ctx, 'mid'), TRACE_ATTACK_TAU, TRACE_RELEASE_TAU, ctx.dt);
  },
  kernel(area, from, to, out, vr, ctx) {
    const depth = readDepth(ctx);
    const theta = (vr.clock + (vr.phase || 0)) * TAU;    // vr.phase ADDS an angular offset, never scales theta's rate
    const drive = expand(vr.env, TRACE_EXPAND_PIVOT, TRACE_EXPAND_POWER);
    const bright = TRACE_BRIGHT_FLOOR + TRACE_BRIGHT_SPAN * drive;     // AUDIO SCALES AMPLITUDE
    const breadth = TRACE_BREADTH_FLOOR + TRACE_BREADTH_SPAN * drive;  // AUDIO SCALES BREADTH
    const flareGain = TRACE_FLARE * flare(ctx);
    for (let j = from; j < to; j++) {
      const rf = area.radius[j];
      const ang = area.angle[j];
      const a = ang - theta - 0.9 * rf;
      const u = a * (TRACE_ARMS / TAU);
      const f = u - Math.floor(u);
      const dA = Math.min(f, 1 - f) * (TAU / TRACE_ARMS);
      let arm = clamp01(1 - dA / breadth);
      arm *= arm;
      out[area.pixelIndex[j]] += (bright * arm + flareGain * arm * arm) * depth;
    }
  },
};

/** Every character, keyed for lookup (`CHARACTERS.swell`, etc.) and listed
 * in library order for pickers. */
export const CHARACTERS = { swell: Swell, twinkle: Twinkle, ripple: Ripple, glow: Glow, trace: Trace };
export const CHARACTER_LIBRARY = [Swell, Twinkle, Ripple, Glow, Trace];
export const CHARACTER_KEYS = CHARACTER_LIBRARY.map((c) => c.key);
