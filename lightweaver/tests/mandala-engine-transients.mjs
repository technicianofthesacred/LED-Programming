// Locks the transient-response contract of the mandala engine
// (src/lib/mandalaEngine.js — engine.getTransients()):
//  - onset detector on the beat feature: fires on a ≥0.35 upward crossing,
//    re-arms only after beat < 0.18 AND 0.12s of engine time (hysteresis +
//    refractory), lastOnsetStrength records the firing beat value.
//  - onsetEnv jumps to max(env, strength) on fire and decays with tau 0.28s.
//  - band clocks attack fast (bass 0.06s / mid 0.07s / high 0.05s /
//    energy 0.08s) and release slow (~0.9s) — asymmetric.
//  - per-pixel envelope attacks at k=26 (tau ≈ 38ms) so loud passages land
//    within ~50ms instead of smearing in.
//  - onsets visibly expand geometry, scaled ×1.0 on 'Active', ×0.4 on 'Calm'.
//  - the dim-coal silence floor survives the new layer.

import assert from 'node:assert/strict';
import { createMandalaEngine } from '../src/lib/mandalaEngine.js';
import { createMandalaSpatialTemplate } from '../src/lib/showSpatialTemplate.js';

const DT = 1 / 60;
const TEMPLATE = createMandalaSpatialTemplate().filter((_, i) => i % 9 === 0);
const SILENCE = { bass: 0, mid: 0, high: 0, energy: 0, centroid: 0.5, flux: 0, beat: 0 };

function makeEngine({ mode = 'bloom', preset = 'Active' } = {}) {
  const engine = createMandalaEngine({ template: TEMPLATE });
  engine.setMode(mode);
  engine.setPreset(preset);
  engine.setSensitivity(1); // identity shaping — beat reaches the detector unshaped
  engine.setListening(true);
  return engine;
}

function step(engine, features, ticks) {
  for (let i = 0; i < ticks; i += 1) {
    engine.setFeatures({ ...SILENCE, ...features });
    engine.tick(DT);
  }
}

function meanBrightness(rgb) {
  let sum = 0;
  const n = rgb.length / 3;
  for (let i = 0; i < n; i += 1) sum += Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
  return sum / n;
}

// "Lit" must sit above the engine's never-black warm floor (~33–38 on the max
// channel while listening — the dim-coal law keeps every pixel permanently
// above trivial thresholds like 12), and below onset peaks, so the count can
// actually register geometry expanding.
const LIT_THRESHOLD = 45;

function litCount(rgb) {
  let lit = 0;
  const n = rgb.length / 3;
  for (let i = 0; i < n; i += 1) {
    const mx = Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    if (mx > LIT_THRESHOLD) lit += 1;
  }
  return lit;
}

// ── 1. onset fires once per pulse ─────────────────────────────────────────
{
  const engine = makeEngine();
  const shape = engine.getTransients();
  for (const key of ['onsetCount', 'onsetEnv', 'lastOnsetStrength']) {
    assert.equal(typeof shape[key], 'number', `getTransients exposes numeric ${key}`);
  }
  for (const band of ['bass', 'mid', 'high', 'energy']) {
    assert.equal(typeof shape.clocks[band], 'number', `getTransients exposes clocks.${band}`);
  }

  step(engine, { beat: 0 }, 10);
  assert.equal(engine.getTransients().onsetCount, 0, 'no onset before the pulse');

  step(engine, { beat: 0.8 }, 1); // the ≥0.35 upward crossing
  const atFire = engine.getTransients();
  assert.equal(atFire.onsetCount, 1, 'crossing 0.35 from below fires exactly one onset');
  assert.ok(Math.abs(atFire.lastOnsetStrength - 0.8) < 1e-3,
    `lastOnsetStrength is the firing beat value (${atFire.lastOnsetStrength})`);
  assert.ok(atFire.onsetEnv > 0.6, `onsetEnv jumps to the fire strength (${atFire.onsetEnv})`);

  step(engine, { beat: 0.8 }, 4); // rest of the high plateau
  assert.equal(engine.getTransients().onsetCount, 1, 'a held plateau counts once, not per tick');

  step(engine, { beat: 0 }, 20);
  assert.equal(engine.getTransients().onsetCount, 1, 'the release edge does not fire');
}

// ── 2. hysteresis + refractory ────────────────────────────────────────────
{
  const engine = makeEngine();
  step(engine, { beat: 0 }, 10);
  step(engine, { beat: 0.8 }, 3);
  assert.equal(engine.getTransients().onsetCount, 1, 'first pulse fires');

  // Dip into the hysteresis window (below ON=0.35, above OFF=0.18): the
  // detector never re-arms, so returning to 0.9 must NOT fire — even though
  // far more than the 0.12s refractory has elapsed.
  step(engine, { beat: 0.25 }, 20); // ≈0.33s — refractory long satisfied
  step(engine, { beat: 0.9 }, 5);
  assert.equal(engine.getTransients().onsetCount, 1, 'no re-fire without dropping below 0.18');

  // True release: below OFF for ≥0.15s, then a fresh crossing fires.
  step(engine, { beat: 0.05 }, 12); // 0.2s below the OFF threshold
  step(engine, { beat: 0.9 }, 1);
  assert.equal(engine.getTransients().onsetCount, 2, 'released + refractory elapsed → second onset');

  // Refractory alone: below OFF, but only ~0.05s since the fire — blocked.
  step(engine, { beat: 0.05 }, 2);
  step(engine, { beat: 0.9 }, 1);
  assert.equal(engine.getTransients().onsetCount, 2, '0.12s refractory blocks an immediate re-fire');
}

// ── 3. onsetEnv decays exponentially, tau = 0.28s ─────────────────────────
{
  const engine = makeEngine();
  step(engine, { beat: 0 }, 10);
  step(engine, { beat: 0.8 }, 1);
  const seeded = engine.getTransients().onsetEnv;
  assert.ok(seeded > 0.74 && seeded <= 0.8 + 1e-9,
    `fire strength seeds onsetEnv within one tick of decay (${seeded})`);

  const ticks = 17; // 17/60 ≈ 0.2833s ≈ one tau
  step(engine, { beat: 0 }, ticks);
  const decayed = engine.getTransients().onsetEnv;
  const expected = 0.8 / Math.E; // s·e⁻¹ after one tau
  assert.ok(Math.abs(decayed - expected) / expected < 0.15,
    `onsetEnv ≈ s·e⁻¹ after 0.28s of decay (${decayed} vs ${expected})`);
}

// ── 4. fast bass clock attack, slow release ───────────────────────────────
{
  const engine = makeEngine({ mode: 'strata' });
  step(engine, {}, 10);
  assert.ok(engine.getTransients().clocks.bass < 0.05, 'bass clock rests near zero');

  step(engine, { bass: 1 }, 8); // ≈0.133s at attack tau 0.06s
  const attacked = engine.getTransients().clocks.bass;
  assert.ok(attacked >= 0.75, `bass clock attacks fast, tau 0.06s (${attacked} after 0.13s)`);

  step(engine, { bass: 0 }, 18); // 0.3s of release at tau ≈ 0.9s
  const released = engine.getTransients().clocks.bass;
  assert.ok(released > 0.3, `bass clock releases slowly — asymmetry preserved (${released})`);
  assert.ok(released < attacked, 'release does decay, just slowly');
}

// ── 5 + 6. onsets expand geometry; the effect is preset-gated ─────────────
// Two engines share an identical feature stream; only B receives one beat
// pulse. Sample the ~0.15s window after the pulse and keep the peak deltas.
function bloomPulseDelta(preset) {
  const a = makeEngine({ mode: 'bloom', preset });
  const b = makeEngine({ mode: 'bloom', preset });
  const base = { bass: 0.4, mid: 0.2, high: 0.12, energy: 0.3, centroid: 0.5, flux: 0.08, beat: 0 };
  for (let i = 0; i < 60; i += 1) { // ~1s of moderate bass opens the flower partially
    a.setFeatures(base); a.tick(DT);
    b.setFeatures(base); b.tick(DT);
  }
  let meanDelta = -Infinity, litDelta = -Infinity, meanRatio = 0;
  for (let i = 0; i < 12; i += 1) { // 3-tick pulse + 9 ticks ≈ 0.15s of follow-through
    a.setFeatures(base); a.tick(DT);
    b.setFeatures({ ...base, beat: i < 3 ? 0.9 : 0 }); b.tick(DT);
    const fa = a.frameRGB();
    const fb = b.frameRGB();
    const meanA = meanBrightness(fa);
    const meanB = meanBrightness(fb);
    meanDelta = Math.max(meanDelta, meanB - meanA);
    litDelta = Math.max(litDelta, litCount(fb) - litCount(fa));
    meanRatio = Math.max(meanRatio, meanB / Math.max(meanA, 1e-6));
  }
  return { meanDelta, litDelta, meanRatio };
}

{
  const active = bloomPulseDelta('Active');
  assert.ok(active.litDelta >= 5,
    `onset pulse lights meaningfully more pixels on Active (+${active.litDelta})`);
  assert.ok(active.meanRatio >= 1.03,
    `onset pulse lifts Active mean brightness ≥3% (×${active.meanRatio.toFixed(4)})`);

  const calm = bloomPulseDelta('Calm');
  assert.ok(calm.meanDelta < 0.6 * active.meanDelta,
    `Calm (×0.4) gates the onset response well below Active (calm Δ${calm.meanDelta.toFixed(2)} vs active Δ${active.meanDelta.toFixed(2)})`);
  assert.ok(calm.litDelta < active.litDelta,
    `Calm lights fewer onset pixels than Active (+${calm.litDelta} vs +${active.litDelta})`);
}

// ── 7. per-pixel attack speed (k=26, tau ≈ 38ms) ──────────────────────────
// A naive cold-start frame measurement cannot see the pixel envelope: the
// mode's *target* is itself ramped by the presence layer (tau 0.6s) and the
// band clocks, so the frame at 50ms is target-bound under any k. The beat
// substrate, however, steps target[] instantly from F.beat — so two lockstep
// engines whose streams differ only by a sustained sub-onset beat (0.3, below
// ON=0.35: no onset fires) isolate the envelope exactly. The mean-intensity
// delta must close ≥45% of its steady value within 3 ticks (~50ms): k=26
// predicts 1−e^(−26·0.05) ≈ 73%, the old k=9 only ≈ 36%.
{
  const a = makeEngine({ mode: 'strata' });
  const b = makeEngine({ mode: 'strata' });
  const loud = { bass: 0.9, mid: 0.9, high: 0.9, energy: 0.9, centroid: 0.5, flux: 0.2, beat: 0 };
  const meanIntensity = (engine) => {
    let sum = 0;
    for (let i = 0; i < TEMPLATE.length; i += 1) sum += engine.getIntensity(i);
    return sum / TEMPLATE.length;
  };
  for (let i = 0; i < 120; i += 1) { // 2s to full presence + steady strata
    a.setFeatures(loud); a.tick(DT);
    b.setFeatures(loud); b.tick(DT);
  }
  let early = 0;
  let steadySum = 0;
  for (let i = 0; i < 120; i += 1) { // 2s of the beat step; average the last 0.5s
    a.setFeatures(loud); a.tick(DT);
    b.setFeatures({ ...loud, beat: 0.3 }); b.tick(DT);
    const delta = meanIntensity(b) - meanIntensity(a);
    if (i === 2) early = delta; // 3 ticks ≈ 50ms
    if (i >= 90) steadySum += delta;
  }
  const steady = steadySum / 30;
  assert.equal(b.getTransients().onsetCount, 0, 'beat 0.3 stays below the onset threshold');
  assert.ok(steady > 0.003, `the beat substrate produces a measurable steady lift (${steady.toFixed(5)})`);
  assert.ok(early >= 0.45 * steady,
    `k=26 attack closes ≥45% of an instant target step in ~50ms (${(early / steady * 100).toFixed(1)}%)`);
}

// ── 8. silence invariants survive the transient layer ─────────────────────
{
  const engine = makeEngine({ mode: 'strata' });
  step(engine, { bass: 0.8, mid: 0.6, high: 0.5, energy: 0.7, flux: 0.3 }, 30);
  step(engine, { beat: 0.9 }, 3); // fire an onset on the way into silence
  for (let s = 0; s < 10; s += 1) { // 10s of listening-but-silent ticks
    step(engine, {}, 60);
    const rgb = engine.frameRGB();
    assert.ok(rgb.some((channel) => channel > 0),
      `dim coal idle never goes fully black (${s + 1}s of silence)`);
  }
}

// ── 9. density: the pattern shapes itself to the light count (2026-07-13) ──
// Full-density (the 675-pixel Mandala) reports detail 1 so the authored look is
// byte-identical (the locked measureWire contract in mandala-engine.mjs proves
// the pixels). A sparse piece reports low detail and must still light a real
// fraction of itself under music — a 48-light piece shouldn't read as a handful
// of scattered dots.
{
  const dense = createMandalaEngine({ template: createMandalaSpatialTemplate() });
  assert.equal(dense.getDensity().activeCount, 675, 'mandala reports its full light count');
  assert.equal(dense.getDensity().detail, 1, 'a dense piece uses full authored detail (contract unchanged)');

  const sparseTemplate = createMandalaSpatialTemplate().filter((_, i) => i % 14 === 0); // ~48 lights
  const sparse = createMandalaEngine({ template: sparseTemplate });
  assert.ok(sparse.getDensity().activeCount <= 50 && sparse.getDensity().activeCount >= 40,
    `sparse fixture is ~48 lights (${sparse.getDensity().activeCount})`);
  assert.ok(sparse.getDensity().detail < 0.15, `a sparse piece drops below full detail (${sparse.getDensity().detail.toFixed(3)})`);

  sparse.setMode('bloom');
  sparse.setPreset('Active');
  sparse.setSensitivity(1);
  sparse.setListening(true);
  let litPeak = 0;
  for (let s = 0; s < 4 * 60; s += 1) {
    const t = s / 60;
    const kick = (t % 0.5) < 0.09 ? 1 : 0;
    sparse.setFeatures({ bass: 0.3 + 0.5 * kick, mid: 0.4, high: 0.3, energy: 0.4 + 0.3 * kick, centroid: 0.4, flux: 0.3 * kick, beat: 0.8 * kick });
    sparse.tick(DT);
    if (t > 2) litPeak = Math.max(litPeak, litCount(sparse.frameRGB()) / sparseTemplate.length);
  }
  assert.ok(litPeak >= 0.4,
    `a sparse piece lights a real fraction of itself on the beat, not scattered dots (peak ${(litPeak * 100).toFixed(0)}%)`);
}

// ── 10. localized hit layer: beats land in places and fade slowly ─────────
// A single beat drops a bloom that stays visibly lit well after the beat is
// gone (slow ~0.7s fade), and several beats within that window are alive at
// once in different places (multi-hit). This is the "see the hit land and
// trail, in more than one place" ask — distinct from the whole-field substrate.
{
  const engine = makeEngine({ mode: 'strata' }); // strata has no petals of its own to confound the bloom
  step(engine, { bass: 0.3, mid: 0.3, high: 0.3, energy: 0.35 }, 60); // settle under quiet music
  assert.equal(engine.getTransients().liveHits, 0, 'no live hits before a beat');

  step(engine, { bass: 0.7, energy: 0.6, flux: 0.4, beat: 0.85 }, 1); // one beat
  step(engine, { bass: 0.3, energy: 0.35 }, 1); // let the field start collapsing
  const justAfter = litCount(engine.frameRGB());
  assert.ok(engine.getTransients().liveHits >= 1, 'a beat spawns a live hit');

  // 0.4s later — well past the fast background collapse — the hit is still lit.
  step(engine, { bass: 0.3, energy: 0.35 }, 24);
  const later = litCount(engine.frameRGB());
  assert.ok(engine.getTransients().liveHits >= 1, 'the hit is still alive ~0.4s later (slow fade)');
  assert.ok(later >= 0.25 * justAfter,
    `the hit still lights the field ~0.4s after the beat (${later}/${justAfter})`);

  // multi-hit: three beats inside one fade window stay alive together.
  const multi = makeEngine({ mode: 'strata' });
  step(multi, { bass: 0.3, energy: 0.35 }, 30);
  step(multi, { bass: 0.7, energy: 0.6, flux: 0.4, beat: 0.85 }, 1);
  step(multi, { bass: 0.2, energy: 0.3 }, 12); // 0.2s — drop below OFF + refractory
  step(multi, { bass: 0.7, energy: 0.6, flux: 0.4, beat: 0.85 }, 1);
  step(multi, { bass: 0.2, energy: 0.3 }, 12);
  step(multi, { bass: 0.7, energy: 0.6, flux: 0.4, beat: 0.85 }, 1);
  assert.ok(multi.getTransients().liveHits >= 2,
    `several beats within the fade window are alive at once (${multi.getTransients().liveHits})`);
}

// ── 11. hits stay localized — the field is not just globally brighter ─────
// The bloom is a PLACE, not a wash: right after a beat, some pixels are far
// brighter than others (real spatial contrast), not a uniform lift.
{
  const engine = makeEngine({ mode: 'strata' });
  step(engine, { bass: 0.3, mid: 0.3, high: 0.3, energy: 0.35 }, 60);
  step(engine, { bass: 0.75, energy: 0.6, flux: 0.4, beat: 0.9 }, 2);
  const rgb = engine.frameRGB();
  let mn = 255, mx = 0;
  for (let i = 0; i < TEMPLATE.length; i += 1) {
    const v = Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  assert.ok(mx - mn > 80, `a hit creates real spatial contrast, not a uniform wash (spread ${mx - mn})`);
}

// ── 12. per-mode tuning knobs move the output; neutral = unchanged ────────
{
  const defaults = makeEngine({ mode: 'strata' }).getModeParams('strata');
  assert.equal(defaults.brightness, 1, 'knobs default to neutral (brightness 1)');
  assert.equal(defaults.fill, 0, 'knobs default to neutral (fill 0)');
  assert.equal(defaults.freq, 0, 'knobs default to neutral (freq 0)');

  // clamp to range
  const clampEngine = makeEngine({ mode: 'strata' });
  clampEngine.setModeParam('strata', 'drive', 999);
  assert.ok(clampEngine.getModeParams('strata').drive <= 2.5, 'setModeParam clamps to range');

  const music = { bass: 0.6, mid: 0.5, high: 0.4, energy: 0.55, centroid: 0.45, flux: 0.3, beat: 0 };
  const runMean = (tune) => {
    const engine = makeEngine({ mode: 'strata' });
    if (tune) engine.setModeParams('strata', tune);
    for (let i = 0; i < 180; i += 1) { engine.setFeatures(music); engine.tick(DT); }
    return meanBrightness(engine.frameRGB());
  };
  const neutral = runMean(null);
  assert.ok(runMean({ brightness: 1.5 }) > neutral + 3, 'Brightness knob brightens the wire');
  assert.ok(runMean({ fill: 0.8 }) > neutral + 3, 'Fill knob lights more of the piece');
  assert.ok(runMean({ brightness: 0.5 }) < neutral - 3, 'Brightness knob can dim it');

  // Hit punch scales the beat blooms.
  const hitPeak = (mul) => {
    const engine = makeEngine({ mode: 'strata' });
    engine.setModeParam('strata', 'hit', mul);
    step(engine, { bass: 0.3, energy: 0.35 }, 30);
    step(engine, { bass: 0.75, energy: 0.6, flux: 0.4, beat: 0.9 }, 2);
    return meanBrightness(engine.frameRGB());
  };
  assert.ok(hitPeak(2.2) > hitPeak(0) + 2, 'Hit punch knob controls the beat-bloom strength');

  // round-trip through getAllModeParams / setModeParams (the save/restore path).
  const src = makeEngine({ mode: 'bloom' });
  src.setModeParams('bloom', { drive: 1.8, fade: 2.0, freq: -0.5 });
  const saved = src.getAllModeParams();
  const dst = makeEngine({ mode: 'bloom' });
  dst.setModeParams('bloom', saved.bloom);
  assert.deepEqual(dst.getModeParams('bloom'), saved.bloom, 'mode params round-trip through save/restore');
}

// ── 13. the program knows its ring count ──────────────────────────────────
{
  const mandala = createMandalaEngine({ template: createMandalaSpatialTemplate() });
  assert.equal(mandala.getDensity().ringCount, 5, 'the Mandala reports its five rings');
}

console.log('mandala engine transients: all assertions passed');
