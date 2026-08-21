// mandalaEngine.legacyParity.test.js — the post-refactor structural guard for
// the nine mandala modes.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY BYTE-IDENTITY WAS DROPPED (2026-08-21)
//
// This file used to assert that all nine modes rendered BYTE-FOR-BYTE the same
// wire frames as the pre-refactor engine, against golden digests captured from
// `git show 6bd56085:lightweaver/src/lib/mandalaEngine.js`. Thirty-six of its
// thirty-nine assertions had gone red, because the per-pixel smoothing was
// legitimately corrected from a linear coefficient to a true frame-rate
// independent exponential — a change we wanted.
//
// The owner then removed the premise entirely. Verbatim, 2026-08-21: "I don't
// need you to retune them, it wasn't working great before. I need you to make
// sure they are responsive and we will get some cool effects based on a variety
// of music." Preserving the old look is explicitly NOT a goal, so a guard whose
// whole job is to prevent the look from changing is a guard against the work.
//
// The goldens were NOT re-recorded against the new engine. Re-recording would
// have restored exactly that guard one commit later, and locked in a baseline
// the owner had just called not good enough. What replaced them is everything
// a refactor can still break that is NOT a matter of taste: the modes run, they
// produce valid renderable output, they paint structure, they are still nine
// different effects, and they do not share state between instances.
//
// Responsiveness — the thing the owner actually asked for — is measured and
// gated separately, in `responsiveness.test.js` against
// `responsivenessProbe.js`. This file deliberately says nothing about how
// bright or how lively a mode is; that is the tuning agents' territory and this
// file must never fight them for it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE RANGE-REFACTOR CHANGED, WHICH IS WHAT IS STILL BEING GUARDED
//
// Every `fx*` in `mandalaEngine.js` went from "loop over every pixel, write the
// shared `target` array" to `fx(ctx, area, from, to, out)` — a RANGE over an
// AreaBinding, writing `out[area.pixelIndex[j]]`. The failure modes that shape
// admits are: a kernel that throws on a template it did not expect, an index
// that escapes its range, geometry read from the wrong flattened array (which
// shows up as a flat or NaN field), and per-instance state that turns out to be
// module-scoped. All five tests below are aimed at those.
//
// ─────────────────────────────────────────────────────────────────────────────
// EIGHT ASSERTIONS BELOW ARE RED FOR ONE PRE-EXISTING BUG. READ THIS FIRST.
//
// Every red assertion in this file is a `*/tuned` run — the knob set that puts
// `freq: 0.35` on the Frequency-focus knob — and they all trace to a single
// defect in `mandalaEngine.js`, in `updateClocks()`:
//
//     if (freqTilt !== 0) {
//       const bassGain = Math.max(0, 1 - 0.7 * freqTilt);
//       const highGain = Math.max(0, 1 + 0.7 * freqTilt);
//       CLK.bass *= bassGain; CLK.high *= highGain;      // ← compounds
//     }
//
// `CLK.bass` / `CLK.high` are PERSISTENT smoothed state, not per-frame derived
// values. Multiplying them in place re-applies the gain every frame, so the
// gain compounds: at 40 fps the per-frame factor on the boosted band is about
// `0.99 × 1.245`, which diverges. Reproduced in isolation with a constant 0.4
// band held for 10 s (`freq` is the only variable):
//
//     freq   0     → CLK.high 4.000e-1   CLK.bass 4.000e-1
//     freq  +0.35  → CLK.high 3.370e+31  CLK.bass 2.049e-1
//     freq  -0.35  → CLK.high 2.192e-1   CLK.bass 4.801e+32
//     freq  +1     → CLK.high 3.021e+85
//
// It is symmetric: a positive tilt runs `CLK.high` away, a negative tilt runs
// `CLK.bass` away, and the intended attenuation on the other band also decays
// without bound instead of settling. The knob is user-facing (`KNOB_META`), so
// any owner who moves Frequency focus off centre saturates the field.
//
// This is NOT a consequence of the range-refactor. The retired golden table
// recorded it: `mandala/procession/tuned` had two IDENTICAL trailing
// checkpoints (`721271374,375300,244` twice) — a saturated, frozen field — and
// `mandala/meridian/tuned` plateaued the same way. Byte-identity to a
// pre-refactor engine that was already saturating is exactly the kind of thing
// a digest guard cannot tell you.
//
// The fix belongs to whoever owns `mandalaEngine.js`: tilt a DERIVED value, or
// apply the gain to `F.bass` / `F.high` before they are smoothed, so the
// multiplication happens once per frame instead of accumulating. These
// assertions are left failing on purpose — do not relax the bounds to hide it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createMandalaEngine, MODE_KEYS } from './mandalaEngine.js';
import { createMandalaSpatialTemplate } from './showSpatialTemplate.js';
// The sparse connected stand-in lives in responsivenessProbe.js so there is one
// definition of it in the repo rather than two that can drift apart. 102 active
// pixels puts `detail` well below 1, so every `dLobes` / `dWide` density branch
// in the nine effects runs at its sparse value — the Mandala template alone
// would leave all of them at their authored values.
import { createSparseProbeTemplate } from './responsivenessProbe.js';

const TEMPLATES = {
  mandala: createMandalaSpatialTemplate,
  connected: createSparseProbeTemplate,
};

// ─────────────────────────────────────────────────────────────────────────────
//  The deterministic drive script (unchanged — it was never the problem)
// ─────────────────────────────────────────────────────────────────────────────

const TICKS = 300;

/**
 * A fixed 300-frame script: silence → Calm music with sparse beats → Active
 * music with dense beats → silence. Purely a function of its seed (an LCG, no
 * Math.random). The phases matter: silence exercises the ~8s coal decay,
 * Active exercises the dark gate and the deeper hit blooms, and the beat spikes
 * fire the onset/hit layers that every mode rides through `evt`.
 */
function buildScript(seed) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const dts = [1 / 60, 0.02, 0.0125, 0.05, 0.008, 1 / 30];
  const frames = [];
  for (let n = 0; n < TICKS; n += 1) {
    const dt = dts[n % dts.length];
    let phase;
    if (n < 40) phase = 'silence-in';
    else if (n < 180) phase = 'calm';
    else if (n < 260) phase = 'active';
    else phase = 'silence-out';

    const listening = phase === 'calm' || phase === 'active';
    const preset = phase === 'active' ? 'Active' : 'Calm';
    const drive = phase === 'active' ? 1 : 0.62;
    const beatEvery = phase === 'active' ? 12 : 30;
    const onBeat = listening && ((n - 40) % beatEvery === 0);

    const wobble = (mul, off) => 0.5 + 0.5 * Math.sin(n * mul + off);
    frames.push({
      dt,
      listening,
      preset,
      features: {
        bass: listening ? Math.min(1, drive * (0.18 + 0.55 * wobble(0.11, 0.3) + 0.15 * rnd())) : 0,
        mid: listening ? Math.min(1, drive * (0.14 + 0.48 * wobble(0.07, 1.7) + 0.18 * rnd())) : 0,
        high: listening ? Math.min(1, drive * (0.09 + 0.42 * wobble(0.19, 2.9) + 0.22 * rnd())) : 0,
        energy: listening ? Math.min(1, drive * (0.20 + 0.50 * wobble(0.05, 0.9) + 0.14 * rnd())) : 0,
        centroid: 0.15 + 0.7 * wobble(0.031, 2.2),
        flux: listening ? 0.3 * rnd() : 0,
        beat: onBeat ? Math.min(1, 0.55 + 0.4 * rnd()) : (listening ? 0.08 * rnd() : 0),
      },
    });
  }
  return frames;
}

const SCRIPT = buildScript(0x5EED1234);

const KNOB_SETS = {
  neutral: null,
  tuned: {
    brightness: 1.25, drive: 1.4, freq: 0.35, attack: 1.6,
    fade: 0.7, fill: 0.4, hit: 1.3, speed: 1.7,
  },
};

const RUNS = [];
for (const templateKey of Object.keys(TEMPLATES)) {
  for (const modeKey of MODE_KEYS) {
    for (const knobKey of Object.keys(KNOB_SETS)) {
      RUNS.push({ templateKey, modeKey, knobKey, id: `${templateKey}/${modeKey}/${knobKey}` });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Capture
// ─────────────────────────────────────────────────────────────────────────────

function makeEngine(templateKey, modeKey, knobKey, template) {
  const layout = template || TEMPLATES[templateKey]();
  const engine = createMandalaEngine({ template: layout });
  engine.setSensitivity(1.4);
  engine.setMode(modeKey);
  if (KNOB_SETS[knobKey]) engine.setModeParams(modeKey, KNOB_SETS[knobKey]);
  return { engine, layout };
}

/**
 * Drive one (template, mode, knob set) for the 300 scripted ticks, collecting
 * everything the assertions below need.
 *
 * `intensity` — `getIntensity(i)`, the pre-render field. NOTE: this is NOT
 *   bounded above by 1. Hit blooms and the beat substrate are ADDITIVE over the
 *   mode's own output and the render layer clamps; the measured ceiling across
 *   all nine modes and both templates is ~2.6. So the [0,1] claim belongs to
 *   the RENDERED value, not to this one — which is why `rendered` exists.
 * `rendered` — `colorFrame()`, the pre-master/pre-gamma palette walk in 0..255,
 *   divided by 255. This is the number that becomes light.
 */
function captureRun(templateKey, modeKey, knobKey, sharedTemplate) {
  const { engine, layout } = makeEngine(templateKey, modeKey, knobKey, sharedTemplate);
  const total = layout.length;
  const colors = new Float32Array(total * 3);

  let preset = null;
  let listening = null;

  let minIntensity = Infinity;
  let maxIntensity = -Infinity;
  let nonFinite = 0;
  let minRendered = Infinity;
  let maxRendered = -Infinity;
  let maxCov = 0;
  const covs = [];
  const leads = [];
  const sampledFrames = [];   // one intensity snapshot every 20 ticks

  for (let n = 0; n < TICKS; n += 1) {
    const frame = SCRIPT[n];
    if (frame.preset !== preset) { preset = frame.preset; engine.setPreset(preset); }
    if (frame.listening !== listening) { listening = frame.listening; engine.setListening(listening); }
    engine.setFeatures(frame.features);
    leads.push(String(engine.tick(frame.dt)));
    engine.colorFrame(colors);

    let sum = 0;
    let sumSq = 0;
    let counted = 0;
    const snapshot = (n % 20 === 19) ? new Float32Array(total) : null;
    for (let i = 0; i < total; i += 1) {
      const v = engine.getIntensity(i);
      if (!Number.isFinite(v)) { nonFinite += 1; continue; }
      if (v < minIntensity) minIntensity = v;
      if (v > maxIntensity) maxIntensity = v;
      if (snapshot) snapshot[i] = Math.min(1, Math.max(0, v));
      // Chain-inactive pixels are blanked at output time; they carry no claim
      // about structure, so they are excluded from the spread.
      if (layout[i].stripId === null) continue;
      const clamped = Math.min(1, Math.max(0, v));
      sum += clamped;
      sumSq += clamped * clamped;
      counted += 1;
    }
    for (let k = 0; k < colors.length; k += 1) {
      const c = colors[k] / 255;
      if (!Number.isFinite(c)) { nonFinite += 1; continue; }
      if (c < minRendered) minRendered = c;
      if (c > maxRendered) maxRendered = c;
    }
    if (counted > 0) {
      const m = sum / counted;
      if (m > 0.01) {
        const cov = Math.sqrt(Math.max(0, sumSq / counted - m * m)) / m;
        covs.push(cov);
        if (cov > maxCov) maxCov = cov;
      }
    }
    if (snapshot) sampledFrames.push(snapshot);
  }

  covs.sort((a, b) => a - b);
  return {
    total,
    minIntensity,
    maxIntensity,
    nonFinite,
    minRendered,
    maxRendered,
    maxCov,
    medianCov: covs.length ? covs[Math.floor(covs.length / 2)] : 0,
    litFrames: covs.length,
    leads,
    sampledFrames,
  };
}

const CAPTURES = new Map();
for (const run of RUNS) CAPTURES.set(run.id, captureRun(run.templateKey, run.modeKey, run.knobKey));

// ─────────────────────────────────────────────────────────────────────────────
//  1. Every mode runs, on both templates, under both knob sets
// ─────────────────────────────────────────────────────────────────────────────

test('the run matrix is nine modes × two templates × two knob sets', () => {
  assert.equal(MODE_KEYS.length, 9);
  assert.equal(RUNS.length, 36);
  for (const run of RUNS) assert.ok(CAPTURES.has(run.id), `${run.id} produced no capture`);
});

test('the drive script is deterministic and exercises every phase', () => {
  assert.deepEqual(buildScript(0x5EED1234), SCRIPT);
  assert.equal(SCRIPT.length, 300);
  assert.ok(SCRIPT.some((f) => !f.listening), 'script must include silence');
  assert.ok(SCRIPT.some((f) => f.preset === 'Active'), 'script must include the Active preset');
  assert.ok(SCRIPT.filter((f) => f.features.beat > 0.5).length >= 10, 'script must fire onsets');
});

test('the connected template is sparse enough to drive the density branches', () => {
  const template = createSparseProbeTemplate();
  const engine = createMandalaEngine({ template });
  const density = engine.getDensity();
  assert.equal(density.activeCount, 102);
  assert.ok(density.detail > 0 && density.detail < 0.5, `expected a sparse detail, got ${density.detail}`);
  assert.ok(template.some((s) => s.stripId === null), 'must include chain-inactive pixels');
});

for (const run of RUNS) {
  test(`${run.id} — runs 300 ticks without throwing and reports a status line every tick`, () => {
    // Construction + the whole 300-tick drive already happened at module load;
    // a throw would have failed collection. This asserts the run was COMPLETE,
    // which a kernel that silently short-circuits its range would not be.
    const cap = CAPTURES.get(run.id);
    assert.equal(cap.leads.length, TICKS);
    for (const lead of cap.leads) assert.equal(typeof lead, 'string');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  2. Valid output: finite, non-negative, and renderable inside [0,1]
// ─────────────────────────────────────────────────────────────────────────────

for (const run of RUNS) {
  test(`${run.id} — no NaN, no negative intensity, rendered output stays inside [0,1]`, () => {
    const cap = CAPTURES.get(run.id);
    assert.equal(cap.nonFinite, 0, `${run.id}: ${cap.nonFinite} non-finite values across 300 frames`);
    assert.ok(
      cap.minIntensity >= 0,
      `${run.id}: intensity went negative (${cap.minIntensity}). A negative target is not "dark" — it survives the envelope and inverts the next frame's response.`,
    );
    assert.ok(
      cap.minRendered >= 0 && cap.maxRendered <= 1,
      `${run.id}: rendered brightness left [0,1] (${cap.minRendered} … ${cap.maxRendered}). colorFrame() walks a 0..255 palette ramp; leaving that range means the palette index or the dark gate escaped.`,
    );
    // Documented, not a bug: the intensity field is deliberately unbounded
    // above (hit blooms and the beat substrate add over the mode's own output;
    // render clamps). Measured ceiling on 2026-08-21 was ~2.6. This guards
    // against a runaway, not against the headroom.
    assert.ok(
      cap.maxIntensity < 8,
      `${run.id}: intensity reached ${cap.maxIntensity}. The field is additive and normally tops out near 2.6; anything past 8 means a feedback path, not headroom.`,
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  3. It actually paints structure — not a flat wash
// ─────────────────────────────────────────────────────────────────────────────
//
// EVIDENCE for the numbers: measured across all 36 runs on 2026-08-21, the peak
// per-frame coefficient of variation ranges from 0.30 (hearth's full-field fire
// bed, the flattest mode by authorship) to 3.6 (embers). The bars are set an
// order of magnitude below the flattest authored mode, so no mode is being
// asked to add texture — they exist to catch a kernel that has stopped reading
// geometry at all, which renders a uniform field and would score ~0.

const MIN_PEAK_COV = 0.05;
const MIN_MEDIAN_COV = 0.01;

for (const run of RUNS) {
  test(`${run.id} — produces a non-uniform frame (it paints structure, not a flat wash)`, () => {
    const cap = CAPTURES.get(run.id);
    assert.ok(cap.litFrames > 50, `${run.id}: only ${cap.litFrames} of 300 frames were lit at all`);
    assert.ok(
      cap.maxCov >= MIN_PEAK_COV,
      `${run.id}: peak spatial variation was ${cap.maxCov.toFixed(4)}, under ${MIN_PEAK_COV}. Every lit frame is essentially uniform — the kernel is no longer reading radius/angle/strip geometry.`,
    );
    assert.ok(
      cap.medianCov >= MIN_MEDIAN_COV,
      `${run.id}: median spatial variation across lit frames was ${cap.medianCov.toFixed(4)}, under ${MIN_MEDIAN_COV}.`,
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  4. The nine are still nine — no two modes have collapsed into one effect
// ─────────────────────────────────────────────────────────────────────────────
//
// Distance is the mean absolute per-pixel difference between two modes' frames
// at the same ticks, normalised by their common mean level — so it compares the
// PICTURE, not the brightness, and two modes that differ only in gain still
// register as close. Identical code paths would score exactly 0.
//
// EVIDENCE: measured on 2026-08-21, the closest pair is strata/tide at 0.176 on
// the sparse connected layout (both become near-full-field there) and 0.359 on
// the mandala. The bar is 0.10 — below every observed pair and far above the 0
// a genuine collapse would produce.

const MIN_MODE_DISTANCE = 0.10;

function modeDistance(a, b) {
  let diff = 0;
  let level = 0;
  for (let f = 0; f < a.sampledFrames.length; f += 1) {
    const A = a.sampledFrames[f];
    const B = b.sampledFrames[f];
    for (let i = 0; i < A.length; i += 1) {
      diff += Math.abs(A[i] - B[i]);
      level += (A[i] + B[i]) / 2;
    }
  }
  return diff / Math.max(1e-9, level);
}

for (const templateKey of Object.keys(TEMPLATES)) {
  test(`${templateKey} — all nine modes remain distinguishable from each other`, () => {
    let closest = Infinity;
    let closestPair = '';
    for (let i = 0; i < MODE_KEYS.length; i += 1) {
      for (let j = i + 1; j < MODE_KEYS.length; j += 1) {
        const a = CAPTURES.get(`${templateKey}/${MODE_KEYS[i]}/neutral`);
        const b = CAPTURES.get(`${templateKey}/${MODE_KEYS[j]}/neutral`);
        const d = modeDistance(a, b);
        if (d < closest) { closest = d; closestPair = `${MODE_KEYS[i]}/${MODE_KEYS[j]}`; }
        assert.ok(
          d >= MIN_MODE_DISTANCE,
          `${templateKey}: ${MODE_KEYS[i]} and ${MODE_KEYS[j]} render the same picture (normalised distance ${d.toFixed(4)} < ${MIN_MODE_DISTANCE}). Two library entries have collapsed into one effect.`,
        );
      }
    }
    assert.ok(closest > 0, `${templateKey}: closest pair ${closestPair} at ${closest.toFixed(4)}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  5. No module-scoped state leaks between engine instances
// ─────────────────────────────────────────────────────────────────────────────
//
// `createMandalaEngine()` promises an ISOLATED instance — "all state per-
// instance so tests and preview never share clocks" (module header). The Show
// screen runs a preview engine and a card frame-stream engine at once, so a
// clock, ember array or hit ring shared at module scope would make each one's
// output depend on how many others exist and in what order they were ticked.

test('an engine driven alone and the same engine driven alongside others agree exactly', () => {
  const template = createMandalaSpatialTemplate();

  const solo = captureRun('mandala', 'embers', 'neutral', template);

  // Now drive three engines interleaved, frame by frame, in a different order,
  // with a fourth constructed mid-run. Embers is the hardest case: it owns the
  // spark array whose live count appears in the status line.
  const rigs = ['embers', 'spiral', 'bloom'].map((mode) => {
    const { engine } = makeEngine('mandala', mode, 'neutral', template);
    return { mode, engine, preset: null, listening: null, leads: [] };
  });
  let late = null;
  for (let n = 0; n < TICKS; n += 1) {
    const frame = SCRIPT[n];
    if (n === 150) {
      late = makeEngine('mandala', 'lattice', 'tuned', template).engine;
      late.setPreset(frame.preset);
      late.setListening(frame.listening);
    }
    for (const rig of [...rigs].reverse()) {
      if (frame.preset !== rig.preset) { rig.preset = frame.preset; rig.engine.setPreset(frame.preset); }
      if (frame.listening !== rig.listening) { rig.listening = frame.listening; rig.engine.setListening(frame.listening); }
      rig.engine.setFeatures(frame.features);
      rig.leads.push(String(rig.engine.tick(frame.dt)));
    }
    if (late) { late.setFeatures(frame.features); late.tick(frame.dt); }
  }

  const embers = rigs.find((r) => r.mode === 'embers');
  assert.deepEqual(
    embers.leads, solo.leads,
    'embers produced different status lines when other engines were alive alongside it — some state that should be per-instance is module-scoped.',
  );
});

test('two engines of the same mode on the same template stay independent', () => {
  const template = createMandalaSpatialTemplate();
  const a = makeEngine('mandala', 'lattice', 'neutral', template).engine;
  const b = makeEngine('mandala', 'lattice', 'neutral', template).engine;
  a.setListening(true);
  b.setListening(true);

  // Run `a` 120 ticks ahead, then run both together. Their clocks must stay
  // apart: if `b` snapped to `a`'s phase, the clocks are shared.
  for (let n = 0; n < 120; n += 1) {
    a.setFeatures(SCRIPT[n].features);
    a.tick(SCRIPT[n].dt);
  }
  let differed = false;
  for (let n = 0; n < 60; n += 1) {
    const frame = SCRIPT[120 + n];
    a.setFeatures(frame.features); a.tick(frame.dt);
    b.setFeatures(frame.features); b.tick(frame.dt);
    for (let i = 0; i < 40; i += 1) {
      if (Math.abs(a.getIntensity(i) - b.getIntensity(i)) > 1e-6) { differed = true; break; }
    }
    if (differed) break;
  }
  assert.ok(differed, 'two independently-aged engines produced identical output — their clocks are shared at module scope.');
});

// ─────────────────────────────────────────────────────────────────────────────
//  Ensemble fixtures, shared by sections 6 and 7
// ─────────────────────────────────────────────────────────────────────────────

/** Two rings driven by the bass, two by the highs, over a live ground wash. */
const RING_COMPOSITION = {
  id: 'comp-parity',
  name: 'rings',
  fields: [{ id: 'f1', fold: 1 }],
  areas: [
    { id: 'inner', name: 'inner', fieldId: 'f1', instances: [{ index: 0, stripIds: ['ring-1', 'ring-2'], mirrored: false }] },
    { id: 'outer', name: 'outer', fieldId: 'f1', instances: [{ index: 0, stripIds: ['ring-4', 'ring-5'], mirrored: false }] },
  ],
  voices: [
    { id: 'low', areaId: 'inner', character: 'swell', band: 'bass', depth: 1, spread: 0, direction: 1, palette: 'hearth', muted: false },
    { id: 'high', areaId: 'outer', character: 'twinkle', band: 'high', depth: 1, spread: 1, direction: 1, palette: 'candle', muted: false },
  ],
  ground: { enabled: true, level: 0.12, band: 'energy' },
};

/** A composition with nothing in it: no ground, no voices. `tickVoices` then
 * hands the engine a field that is EXACTLY LIVING_COAL_FLOOR at every pixel
 * (showEnsemble F7) — a known constant, which is what makes the arithmetic
 * assertion below possible at all. */
const EMPTY_COMPOSITION = { fields: [], areas: [], voices: [], ground: { enabled: false } };

/** showEnsemble's LIVING_COAL_FLOOR. 5/128, exact in a float32. */
const LIVING_COAL_FLOOR = 0.0390625;

// ─────────────────────────────────────────────────────────────────────────────
//  6. THE NINE-MODE FALLBACK IS BYTE-IDENTICAL — the one place a digest belongs
// ─────────────────────────────────────────────────────────────────────────────
//
// Read the header of this file first: byte-identity was RETIRED as a guard on
// how the nine modes look, because the owner asked for them to be improved and
// a digest of the old look is a guard against exactly that work.
//
// This is the other thing a digest is for, and it is the right tool for it.
// `tick()` now branches: with no composition set it runs the nine modes as it
// always has, and with one set it delegates the paint step to
// `showEnsemble`'s `tickVoices`. The nine modes are what ships live today and
// `clearComposition()` is the owner's instant fallback to them, so the claim
// under test is NOT "the modes still look good" (taste, deliberately unguarded)
// but "adding the second path moved nothing on the first one" — a refactor
// claim, which is exactly what byte-identity can settle and nothing else can.
//
// The digests below were captured on 2026-08-21 from the PRE-ENSEMBLE engine,
// `git show 6ccad1c8:lightweaver/src/lib/mandalaEngine.js`, extracted to a
// scratch tree outside the repo and driven through the same 300-frame SCRIPT
// used above. Each is the first 16 bytes of a SHA-256 over, per tick, the
// status line and the full `frameRGB()` wire buffer — the very bytes that
// reach the card, downstream of the envelope, the palette walk, the dark gate,
// the master ceiling and the wire gamma.
//
// IF ONE OF THESE GOES RED: it means the nine-mode path changed. That is only
// legitimate when a mode's arithmetic was deliberately retuned — in which case
// re-record the affected entries and say so in the commit. It is NOT legitimate
// as a side effect of ensemble work; if an ensemble change turned these red,
// the branch is leaking.

const PRE_ENSEMBLE_DIGESTS = {
  'mandala/meridian/neutral': 'd87a8fc2231cc570568c36b8d740c5c1',
  'mandala/meridian/tuned': '4d1ef44cae011bec84f451d1346de0ff',
  'mandala/hearth/neutral': '27ecc79e72c28ea67d2e3847d0a72b4f',
  'mandala/hearth/tuned': '73318a5b22689f8a971f14956a6f5ae3',
  'mandala/embers/neutral': '4d611bd6e1fe0319839871bf7d6f94bf',
  'mandala/embers/tuned': 'c77eedfd9195037b27d62a0c1f2bbb1c',
  'mandala/strata/neutral': '7cc13f89d630929c78ab5bbe6d52acd8',
  'mandala/strata/tuned': '6c052659be80c9f102004c5b1f3f9c32',
  'mandala/tide/neutral': '086533e44d427f7852076fa6e9f8facc',
  'mandala/tide/tuned': '92ac116d59a0027b12bad34490917d8a',
  'mandala/lattice/neutral': '78590afec7b7e26dc006e68c0a2461a4',
  'mandala/lattice/tuned': '7e1695fce505f69e116c5e343461553b',
  'mandala/procession/neutral': 'b16c148c23ced22b90465a40b880964d',
  'mandala/procession/tuned': '6f4917551f933e0f726867a11ce82c3e',
  'mandala/bloom/neutral': '0c6df13849172f832332ef25b7130013',
  'mandala/bloom/tuned': 'e7755b360d6e5d1028cea93429bc4a26',
  'mandala/spiral/neutral': '918d8c41d336b2f326103fa2f2f3f2c1',
  'mandala/spiral/tuned': 'b183219bfafde06a4ec0beb758cb3025',
  'connected/meridian/neutral': '09cd08e70becf535790a703c95de5675',
  'connected/meridian/tuned': 'e9c8794ccdff1ec59e26bdab93e1fbad',
  'connected/hearth/neutral': '94aa36331c17f77570a465a103958475',
  'connected/hearth/tuned': 'f647fe13923b1a816b0672909d0bad81',
  'connected/embers/neutral': 'fc99b85b8db41b60e23401daa08c3527',
  'connected/embers/tuned': '8e4bdbb50af60e06e5d8e3a6d8f20c4c',
  'connected/strata/neutral': 'f5d6e93a6ee6b1d3633a2a98d9fe28e3',
  'connected/strata/tuned': '4a241ab7f79cac4b5d60627c336c46b4',
  'connected/tide/neutral': '3533bb685543226cf01be55e23e3bae4',
  'connected/tide/tuned': 'efada1d0d6aeb416347db1425354ef32',
  'connected/lattice/neutral': 'c4de692af8c50ed34868d05606add6dd',
  'connected/lattice/tuned': '4dbd3f64a0d1b0d2f3b0df12c6812636',
  'connected/procession/neutral': '0b489532b9358002fae7cbf4ddff087f',
  'connected/procession/tuned': '3799572df5ab3a88d9c0d5e4b92b2a05',
  'connected/bloom/neutral': '2826c6cc11feca42dbaf22c4a37ffe98',
  'connected/bloom/tuned': 'c23b6dcb4ff7b5a195fb03515b517683',
  'connected/spiral/neutral': '3be91a53bd09f6dff69c7335a7e96d6a',
  'connected/spiral/tuned': 'ef8585f55a344bb4858493542f67012a',
};

/**
 * Drive one (template, mode, knob set) through the 300-frame SCRIPT and digest
 * every tick's status line plus its full wire frame.
 *
 * `prepare(engine)` runs after construction and before the first tick — the
 * round-trip test uses it to set and then clear a composition, which must leave
 * the engine indistinguishable from one that never saw a composition at all.
 */
function digestRun(templateKey, modeKey, knobKey, prepare) {
  const { engine, layout } = makeEngine(templateKey, modeKey, knobKey);
  if (prepare) prepare(engine);
  const hash = createHash('sha256');
  const rgb = new Uint8Array(layout.length * 3);
  let preset = null;
  let listening = null;
  for (let n = 0; n < TICKS; n += 1) {
    const frame = SCRIPT[n];
    if (frame.preset !== preset) { preset = frame.preset; engine.setPreset(preset); }
    if (frame.listening !== listening) { listening = frame.listening; engine.setListening(listening); }
    engine.setFeatures(frame.features);
    hash.update(String(engine.tick(frame.dt)));
    hash.update(engine.frameRGB(rgb));
  }
  return hash.digest('hex').slice(0, 32);
}

for (const run of RUNS) {
  test(`${run.id} — with no composition set, byte-identical to the pre-ensemble engine`, () => {
    assert.equal(
      digestRun(run.templateKey, run.modeKey, run.knobKey),
      PRE_ENSEMBLE_DIGESTS[run.id],
      `${run.id}: the nine-mode path no longer renders the bytes it rendered at 6ccad1c8. `
      + 'This path is what ships live and what clearComposition() falls back to; it must not move '
      + 'as a side effect of ensemble work.',
    );
  });
}

test('a composition set and then cleared leaves the nine modes byte-identical', () => {
  // The fallback has to be instant AND complete. Building the ensemble runtime
  // rebinds geometry and allocates zone state; clearing it must leave no trace
  // in the mode path — not a stale zone, not a moved clock, not a knob.
  const roundTrip = (engine) => {
    engine.setComposition(RING_COMPOSITION);
    assert.equal(engine.hasComposition(), true);
    engine.clearComposition();
    assert.equal(engine.hasComposition(), false);
    assert.equal(engine.getComposition(), null);
  };
  for (const modeKey of MODE_KEYS) {
    const id = `mandala/${modeKey}/neutral`;
    assert.equal(
      digestRun('mandala', modeKey, 'neutral', roundTrip),
      PRE_ENSEMBLE_DIGESTS[id],
      `${id}: a composition round-trip left residue in the nine-mode path.`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  7. THE ENSEMBLE PATH — it engages, and it does not double-apply the tail
// ─────────────────────────────────────────────────────────────────────────────

test('setComposition swaps the paint step, clearComposition hands it straight back', () => {
  const template = createMandalaSpatialTemplate();
  const engine = createMandalaEngine({ template });
  engine.setListening(true);
  engine.setMode('strata');

  const drive = (n) => {
    let lead = '';
    for (let k = 0; k < n; k += 1) {
      engine.setFeatures({ bass: 0.7, mid: 0.5, high: 0.6, energy: 0.8, centroid: 0.4, flux: 0, beat: 0 });
      lead = String(engine.tick(0.02));
    }
    return lead;
  };

  // fxStrata's status line is its authored name, 'spectrum', not its mode key.
  assert.equal(drive(60), 'spectrum', 'the default engine runs the nine modes');
  assert.equal(engine.hasComposition(), false);
  assert.equal(engine.getEnsembleResolved(), null);

  engine.setComposition(RING_COMPOSITION);
  const ensembleLead = drive(60);
  assert.match(ensembleLead, /^ensemble 2\/2$/, `expected the ensemble status line, got "${ensembleLead}"`);
  const resolved = engine.getEnsembleResolved();
  assert.equal(resolved.voices.length, 2);
  assert.deepEqual(resolved.voices.map((v) => v.characterKey), ['swell', 'twinkle']);
  assert.deepEqual(resolved.voices.map((v) => v.listensTo), ['bass', 'high']);
  assert.ok(engine.getVoiceDebug('low'), 'per-voice debug is readable while an ensemble runs');
  assert.equal(engine.getVoiceDebug('nope'), null);

  engine.clearComposition();
  assert.equal(drive(60), 'spectrum', 'clearing the composition returns the engine to its mode');
  assert.equal(engine.getVoiceDebug('low'), null);
});

test('the ensemble reaches the wire — different areas light differently', () => {
  const template = createMandalaSpatialTemplate();
  const engine = createMandalaEngine({ template });
  engine.setListening(true);
  engine.setComposition(RING_COMPOSITION);
  // Bass loud, highs silent: the inner rings (the Swell voice) must outrun the
  // outer rings (the Twinkle voice). One accumulator, two different sounds —
  // this is the whole point of an ensemble, so it is worth asserting directly.
  for (let k = 0; k < 200; k += 1) {
    engine.setFeatures({ bass: 1, mid: 0, high: 0, energy: 1, centroid: 0.2, flux: 0, beat: 0 });
    engine.tick(0.02);
  }
  const mean = (from, to) => {
    let s = 0;
    for (let i = from; i < to; i += 1) s += engine.getIntensity(i);
    return s / (to - from);
  };
  const inner = mean(0, 135);     // ring-1 + ring-2
  const outer = mean(270, 675);   // ring-4 + ring-5
  assert.ok(
    inner > outer * 1.2,
    `the bass area (${inner.toFixed(4)}) did not outrun the treble area (${outer.toFixed(4)}) on a bass-only signal — `
    + 'either the per-voice band is not reaching the characters or the area binding is not being honoured.',
  );
});

test('the post-effect chain is applied EXACTLY ONCE on the ensemble path', () => {
  // Fill lift, coal floor, beat substrate, hit blooms, silence decay and the
  // per-pixel envelope are whole-piece passes that must run once per tick, not
  // once per voice or once per area range. Applied twice, the piece is too
  // bright and stops decaying — which is easy to mistake for a tuning problem
  // and very hard to find by eye.
  //
  // So this pins the arithmetic instead of eyeballing it. With EMPTY_COMPOSITION
  // the ensemble hands the tail a known constant (LIVING_COAL_FLOOR at every
  // pixel), beat is held at 0 so the substrate and the hit blooms are inert,
  // and the Fill knob is at full so the one pass that COMPOUNDS when repeated
  // actually has something to compound. Everything left is a closed form of
  // `presence`, which the engine reports.
  const template = createMandalaSpatialTemplate();
  const engine = createMandalaEngine({ template });
  engine.setComposition(EMPTY_COMPOSITION);
  engine.setListening(true);
  engine.setPreset('Calm');
  engine.setModeParam(engine.getMode(), 'fill', 1);   // fillLift = 1

  const DT = 0.02;
  const FILL = 1;
  const ATTACK = 1;
  const IDLE = 0.03;
  let reference = 0;   // the reference `vals[i]`, identical for every pixel here

  for (let n = 0; n < 400; n += 1) {
    engine.setFeatures({ bass: 0.5, mid: 0.5, high: 0.5, energy: 1, centroid: 0.4, flux: 0, beat: 0 });
    engine.tick(DT);
    const presence = engine.getPresence();

    // 1. the ensemble's output
    let x = Math.fround(LIVING_COAL_FLOOR);
    // 2. fill lift — the pass that compounds if it runs twice
    x = Math.fround(x + FILL * 0.35 * presence * (1 - x));
    // 3. coal glow floor (dark gate is off under a composition)
    const glow = 0.15 * presence;
    if (glow > 0.001 && x < glow) x = Math.fround(glow);
    // 4. beat substrate and 5. hit blooms: inert, beat is 0 throughout
    // 6. silence decay. The engine takes max(IDLE*(1 - rf*0.5), blend); this
    //    asserts the blend wins for every radius, so the result is uniform.
    if (presence < 0.99) {
      const blend = x * presence + IDLE * (1 - presence);
      assert.ok(blend >= IDLE, `tick ${n}: the radial idle term would win; the closed form below is not valid`);
      x = Math.fround(blend);
    }
    // 7. per-pixel eased envelope
    const k = x > reference ? 26 * ATTACK : (x < 0.35 * reference ? 7 : 2.2);
    reference = Math.fround(reference + (x - reference) * (1 - Math.exp(-k * DT)));
  }

  // A doubled fill lift lands near 0.55 instead of ~0.39; a doubled silence
  // blend or a doubled envelope misses by more than a whole LED step. The
  // tolerance is float32 noise, not slack.
  for (let i = 0; i < template.length; i += 1) {
    assert.ok(
      Math.abs(engine.getIntensity(i) - reference) < 1e-6,
      `pixel ${i}: ensemble tail produced ${engine.getIntensity(i)}, the once-only chain predicts ${reference}. `
      + 'One of the post-effect passes is running more than once per tick.',
    );
  }
  assert.ok(reference > LIVING_COAL_FLOOR, 'sanity: the tail should have lifted the floor, not flattened it');
});

test('an ensemble piece decays to the coal idle in silence and never goes black', () => {
  // The other face of the same bug: a tail applied per-area also stops the
  // piece letting go. Drive it loud, cut the sound, and watch it come down.
  const template = createMandalaSpatialTemplate();
  const engine = createMandalaEngine({ template });
  engine.setComposition(RING_COMPOSITION);
  engine.setListening(true);
  engine.setPreset('Active');
  for (let n = 0; n < 300; n += 1) {
    engine.setFeatures({ bass: 1, mid: 0.9, high: 0.9, energy: 1, centroid: 0.5, flux: 0.4, beat: n % 20 === 0 ? 0.9 : 0.05 });
    engine.tick(0.02);
  }
  const peak = Math.max(...Array.from({ length: template.length }, (_, i) => engine.getIntensity(i)));
  assert.ok(peak > 0.2, `the ensemble never lit up under music (peak ${peak.toFixed(4)})`);

  engine.setListening(false);
  const meanNow = () => {
    let s = 0;
    for (let i = 0; i < template.length; i += 1) s += engine.getIntensity(i);
    return s / template.length;
  };
  const before = meanNow();
  // 40 s of silence. The presence envelope eases over ~8 s, so the last of the
  // music is still draining out of the field well past the 20 s mark.
  for (let n = 0; n < 2000; n += 1) {
    engine.setFeatures({ bass: 0, mid: 0, high: 0, energy: 0, centroid: 0.4, flux: 0, beat: 0 });
    engine.tick(0.02);
  }
  const after = meanNow();
  assert.ok(after < before * 0.2, `silence did not bring the piece down (${before.toFixed(4)} -> ${after.toFixed(4)})`);

  // It settles on the 0.03 coal idle — measured 0.0301 at 40 s and 0.030000 by
  // 80 s. Never black, and never stuck bright. The lower bound is the engine's
  // own radial idle floor (0.015 at the rim), which nothing may go under.
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < template.length; i += 1) {
    const v = engine.getIntensity(i);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  assert.ok(max <= 0.0305, `silence left the piece at ${max.toFixed(4)}, above the 0.03 coal idle`);
  assert.ok(min >= 0.0149, `silence took a pixel down to ${min.toFixed(5)} — the never-black law was broken`);

  // And the wire agrees: every chain-connected pixel is still emitting.
  const rgb = engine.frameRGB();
  let lit = 0;
  for (let i = 0; i < template.length; i += 1) {
    if (rgb[i * 3] > 0 || rgb[i * 3 + 1] > 0 || rgb[i * 3 + 2] > 0) lit += 1;
  }
  assert.equal(lit, template.length, 'a chain-connected pixel went to true black in silence');
});
