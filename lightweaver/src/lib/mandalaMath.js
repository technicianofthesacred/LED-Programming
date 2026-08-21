// mandalaMath.js — shared numeric helpers for the Lightweaver mandala/show
// engines. Lifted verbatim out of mandalaEngine.js (2026-08-20, music-
// responsive controller build) so mandalaEngine.js and the new
// showCharacters.js voice engine share ONE implementation instead of two
// copies that drift apart.
//
// Pure functions only: no React, no DOM, no module-level mutable state.
// (`createDensityHelpers` below is a FACTORY that returns closures over a
// caller-supplied getter — it holds no state of its own; each caller gets
// its own pair of closures reading ITS OWN `detail` signal.)
//
// mandalaEngine.js imports every name below and deletes its local copies —
// do not reintroduce local duplicates there. showCharacters.js imports
// smoothAR + hash01 + clamp01 for the same reason: one tuned implementation,
// not two that can silently diverge.

/** Linear interpolation: a at t=0, b at t=1. */
export function lerp(a, b, t) { return a + (b - a) * t; }

/** Clamp to [0, 1]. */
export function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

/** Clamp to [lo, hi]. */
export function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

/** Cubic ease: 0 at x<=0, 1 at x>=1, smooth (zero-slope) at both ends. */
export function smoothstep(x) { x = clamp01(x); return x * x * (3 - 2 * x); }

/** Deterministic 0..1 pseudo-random value from an (index, bucket) pair —
 * the same inputs always produce the same output (no Math.random, no
 * hidden state), so callers get a per-pixel "random" that is stable within
 * a frame and reproducible in tests. */
export function hash01(i, bucket) {
  let h = (Math.imul(i, 0x9E3779B1) ^ Math.imul(bucket, 0x85EBCA77)) | 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12;
  return (h >>> 0 & 0xFFFF) / 65536;
}

/** Per-pixel localized gate: lights only PART of a ring, chosen by angle —
 * `nLobes` arcs spaced evenly around the circle, each `width` wide (0..1
 * of the arc's half-period), rotated by `spin` (same 0..1-per-lobe units
 * as the angle term, not radians). Returns 1 at an arc's center, easing to
 * 0 at its edge — this is what makes a mode answer the audio in PLACES
 * instead of lighting the whole ring uniformly. */
export function arcGate(ang, nLobes, width, spin) {
  const u = (ang * nLobes / (Math.PI * 2) + spin); const f = u - Math.floor(u);
  const d = Math.min(f, 1 - f) * 2;                 // 0 at arc center, 1 at edge
  return clamp01(1 - d / width);
}

/** Largest dt (seconds) either smoothing law will act on in a single step.
 * A busy tab, a stall, or a Wi-Fi retry on the card can hand the render
 * loop a dt of several seconds; even though the exponential formulation
 * below is mathematically frame-rate independent, applying that much dt
 * in one step still reads as an instant snap to the eye (one visible frame
 * moving all the way to the target). Clamping forces a stall to still ease
 * over at least a few subsequent frames instead of teleporting. Comfortably
 * above any real frame time (60fps dt ≈ 0.0167s) so ordinary playback is
 * never affected. */
const MAX_SMOOTHING_DT = 0.5;

/** Sanitize a caller-supplied dt before it reaches the smoothing math:
 * non-finite or negative values (a broken timer, a clock going backwards)
 * become 0 — i.e. "no time passed, don't move" — rather than being able to
 * push env outside [x, env]'s span or drive a value negative. Also clamps
 * to MAX_SMOOTHING_DT (see above). */
function sanitizeDt(dt) {
  if (!Number.isFinite(dt) || dt < 0) return 0;
  return dt > MAX_SMOOTHING_DT ? MAX_SMOOTHING_DT : dt;
}

/** Asymmetric envelope: attacks toward a rising `x` on `tauA`, relaxes
 * toward a falling `x` on `tauR`. This is the no-strobing law in code —
 * every audio-reactive brightness in this codebase should ride through
 * smoothAR (or onePole, for a symmetric response) rather than jumping to
 * the raw value.
 *
 * Frame-rate independent by construction: the easing coefficient is
 * `1 - exp(-dt/tau)` rather than the naive linear `dt/tau`. The linear
 * form saturates at `min(1, dt/tau)` — once dt grows past tau it hits the
 * ceiling of 1 and the value SNAPS straight to the target in one step,
 * which is exactly the no-strobing law failing in the moment (a stutter)
 * it matters most. The exponential form has no such ceiling: it asymptotes
 * toward (but never jumps to) the target, and — the actual property this
 * fixes — one big dt and many small dts summing to the same elapsed time
 * land at the same place (see mandalaMath.test.js). dt is sanitized first
 * (see sanitizeDt) so a broken timer can't drive env past its bounds.
 *
 * Behavioural note for normal frame times: at dt=1/60s and tau=0.1s (a
 * representative fast attack), the old linear coefficient was
 * dt/tau ≈ 0.1667; the new exponential coefficient is
 * 1-exp(-0.1667) ≈ 0.1535 — about 8% smaller, i.e. very slightly slower
 * per-frame movement at 60fps, converging to the same steady-state target
 * either way. */
export function smoothAR(env, x, tauA, tauR, dt) {
  const tau = (x > env) ? tauA : tauR;
  const d = sanitizeDt(dt);
  const coef = 1 - Math.exp(-d / tau);
  return env + (x - env) * coef;
}

/** Symmetric one-pole low-pass: identical time constant rising and
 * falling. Used for slow, mood-scale drift (Hearth's energy trend, the
 * Temperature Field's slow energy) rather than a reactive envelope.
 * Same frame-rate-independent exponential formulation and dt sanitizing
 * as smoothAR — see its comment above. */
export function onePole(env, x, tau, dt) {
  const d = sanitizeDt(dt);
  const coef = 1 - Math.exp(-d / tau);
  return env + (x - env) * coef;
}

/**
 * Density-scaled feature-count/width helpers. Both mandalaEngine.js and
 * showCharacters.js carry their own notion of "how many active pixels does
 * this layout have" — a per-instance `detail` signal in 0..1 (1 at/above
 * the full-density threshold; rolling toward 0 as the piece gets sparse).
 * Because that signal is per-instance state, these two helpers can't be
 * plain pure functions the way the rest of this module is: they need to
 * read whichever engine instance's CURRENT `detail` on every call, not a
 * value captured once at module load.
 *
 * `createDensityHelpers(getDetail)` takes a zero-argument getter for the
 * caller's live `detail` value and returns two closures scoped to it — so
 * a caller can keep writing `dLobes(6, 2)` / `dWide(0.72, 0.95)` exactly as
 * it always has, just imported instead of locally defined:
 *
 *   const { dLobes, dWide } = createDensityHelpers(() => detail);
 */
export function createDensityHelpers(getDetail) {
  return {
    // integer spatial frequency (petals, arms, teeth), scaled to density:
    // authored at full detail, floored so a sparse piece keeps legible
    // fewer-but-clear features instead of vanishing into visual noise.
    dLobes(authored, floor) {
      const detail = getDetail();
      return Math.max(floor, Math.round(authored * (0.4 + 0.6 * detail)));
    },
    // feature width / fill: eased from a wider `sparse` value toward the
    // authored one as density rises, so a thin piece lights more of itself
    // at once instead of reading as mostly empty.
    dWide(authored, sparse) {
      const detail = getDetail();
      return sparse + (authored - sparse) * detail;
    },
  };
}
