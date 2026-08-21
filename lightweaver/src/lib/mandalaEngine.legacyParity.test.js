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
