// responsiveness.test.js — the PASS BAR for "the music unmistakably drives the
// piece", asserted against every one of the fourteen effects.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS, AND WHY IT IS CURRENTLY RED
//
// Owner direction, 2026-08-21, verbatim: "I don't need you to retune them, it
// wasn't working great before. I need you to make sure they are responsive and
// we will get some cool effects based on a variety of music."
//
// So preserving today's look is explicitly NOT the goal. This file encodes what
// "responsive" has to mean numerically, measured by `responsivenessProbe.js`
// against eight synthesised music profiles. Nineteen assertions across eight
// effects FAIL at the 2026-08-21 baseline. That is deliberate and is the point:
// the failures are the tuning brief for the two agents who own
// `mandalaEngine.js` and `showCharacters.js`.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE FOR ANYONE EDITING THIS FILE
//
// A red assertion here is fixed by raising the EFFECT, never by lowering the
// NUMBER. Every threshold below carries the evidence it came from — the
// measured distribution it sits in, and the natural gap in that distribution it
// was placed in. Moving a threshold down to get a green run destroys the only
// record of what "good" meant. If a threshold is genuinely wrong, say so in the
// comment and cite the measurement that shows it, the way the ones below do.
//
// `KNOWN_GAPS` records what each failing effect measured on 2026-08-21. It is
// used only to make failure messages say "known gap, was X" versus "REGRESSION,
// this used to pass" — it never relaxes an assertion.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS NOT ASSERTED, AND WHY (so nobody thinks it was missed)
//
//  - `silenceMotion` — the "never frozen" half of the silence law. Measured for
//    all fourteen; every one sits between 0 and 8e-4 of full range over the
//    final second, i.e. all fourteen are effectively still at the coal floor.
//    The direction states "never frozen" but names no number, so asserting one
//    would invent a fourteen-way failure that is not the brief the owner gave.
//    It is measured and reported; if the owner asks for a living idle, this is
//    where the threshold goes.
//  - `decayTime` lower bound. The direction says silence decays "over roughly
//    eight seconds"; the measured spread is 0.48 s (embers) to 6.65 s (spiral),
//    so NOTHING currently reaches eight. A lower bound would fail nine modes on
//    a taste question while the owner is asking for MORE response, not slower
//    release. Only the upper bound (it does finish letting go) is asserted.
//  - The Calm preset. Every threshold below is measured at Active — the preset
//    that exists to listen more closely. Calm was measured too and tracks
//    Active within ±30% on the swing columns; a separate Calm bar would double
//    the surface without changing what needs raising.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  measureAll,
  measureEffectProfile,
  buildProfile,
  EFFECT_IDS,
  EFFECTS,
  PROFILE_KEYS,
  SUSTAINED_PROFILE_KEYS,
  SNAP_MEAN_DELTA,
} from './responsivenessProbe.js';

// One full sweep — 14 effects × 8 profiles + a silence tail each, on the
// 675-pixel mandala at the Active preset. ~9 s.
const PRESET = 'Active';
const RESULTS = measureAll({ preset: PRESET });

const LEGACY = EFFECTS.filter((e) => e.family === 'legacy').map((e) => e.id);
const CHARACTERS = EFFECTS.filter((e) => e.family === 'character').map((e) => e.id);

// ─────────────────────────────────────────────────────────────────────────────
//  THE THRESHOLDS, AND THE EVIDENCE FOR EACH
// ─────────────────────────────────────────────────────────────────────────────

/**
 * T1 — LOUD TRACK vs QUIET TRACK.
 *
 * `crossProfileSwing` = settled mean brightness on `denseRock` ÷ settled mean
 * on `ambient`. This is the owner's actual complaint stated as a number: put on
 * a loud record and a quiet record, and the piece must not look the same.
 *
 * EVIDENCE: `TODO.md` records the previous legibility pass as having measured
 * "quiet→loud swing 3–8× on most" and treated that as the standard of good.
 * 3.0 is the bottom of that recorded band. The measured 2026-08-21 population
 * splits cleanly around it: eleven effects land at 3.5–25×, three land at
 * 1.0–2.9×. No upper bound — strata at 25× is a quiet passage decaying almost
 * to the coal floor, which is the dark-to-bright contrast being asked for, not
 * a fault.
 */
const CROSS_PROFILE_SWING_MIN = 3.0;

/**
 * T2 — ALIVE ON EVERY GENRE.
 *
 * `sustainedMusicLift` = the WEAKEST of the four continuously-playing profiles
 * (four-on-the-floor, dense rock, bass electronic, bright acoustic) ÷ the
 * silence floor. T1 can be satisfied by an effect that is bright on exactly one
 * kind of music and dead on the rest; this closes that hole.
 *
 * EVIDENCE: measured population is 1.0, 2.4, 2.7, 2.8, 5.0, 5.7, 6.4, 6.4, 8.2,
 * 8.2, 9.0, 9.4. 2.5 is placed to sit under the two authored bass instruments
 * (tide 2.83, bloom 2.71) — failing those would be asking them to stop being
 * bass instruments — and above the two that are genuinely near their own
 * silence floor on some genre (ripple 1.005, glow 2.398).
 */
const SUSTAINED_MUSIC_LIFT_MIN = 2.5;

/**
 * T2b — the same question for the two SPARSE-BY-AUTHORSHIP effects.
 *
 * Embers and Twinkle are sparks over darkness (direction v2 §3 rows 3, and the
 * Sparkle overlay in `mandala-audio-mapping.md` §0.3). Mean brightness is the
 * wrong lens for them: twenty full-brightness sparks on 675 pixels average to
 * almost nothing, and judging them by T2 would push them into becoming fields.
 * They are judged on whether sparks EXIST and are BRIGHT instead.
 *
 * EVIDENCE: median-over-sustained-profiles `litFraction` measures 0.155
 * (embers) and 0.022 (twinkle); peak pixel reaches 0.95–1.00 for both. The bar
 * is set just under twinkle's measurement, because two pixels lit out of 675 is
 * where "sparse" stops being visible at all.
 */
const SPARK_LIT_FRACTION_MIN = 0.02;
const SPARK_PEAK_MIN = 0.6;
const SPARK_EFFECTS = new Set(['embers', 'twinkle']);

/**
 * T3 — THE BEAT SHOWS.
 *
 * `onsetVisibility` = median, over the hits in a profile, of the brightness
 * rise inside 200 ms of the hit relative to the level around it. 0.15 means a
 * kick lifts the piece 15% above where it was sitting — unmistakable in a dark
 * room, and far below anything that could read as a strobe (T5 fires at 25% in
 * a single 25 ms frame).
 *
 * EVIDENCE: measured population is bimodal — 0.02, 0.05, 0.06, 0.07, 0.13,
 * 0.14 in the lower group and 0.19, 0.25, 0.30, 0.32, 0.38, 0.38 in the upper.
 * 0.15 sits in the gap.
 *
 * GLOW IS EXEMPT, by authored identity, not by convenience:
 * `docs/mandala-audio-mapping.md` §6 defines the Temperature Field it derives
 * from as "No transient response (that IS its identity)". Forcing a transient
 * onto Glow would delete the one effect in the library that is pure mood. Glow
 * is instead held to T1/T2 like everything else — and fails both.
 */
const ONSET_VISIBILITY_MIN = 0.15;
const ONSET_EXEMPT = new Set(['glow']);

/**
 * T4 — IT IS ACTUALLY LISTENING TO A BAND.
 *
 * `bandDiscrimination` = the symmetric relative difference between settled mean
 * brightness on `bassElectronic` (bass dominant, highs almost absent) and on
 * `brightAcoustic` (highs and mids dominant, little bass). An effect that
 * answers those two identically is riding broadband energy and calling it a
 * band.
 *
 * EVIDENCE: the measured population has a real hole in it. Five effects sit at
 * 0.039–0.080; the next value up is 0.392, then 0.575, 0.605, 0.914, 1.06,
 * 1.33, 1.36, 1.65, 1.78. There is nothing at all between 0.08 and 0.39. 0.25
 * is placed in that empty band, so the threshold is a description of the data
 * rather than a number chosen in advance.
 */
const BAND_DISCRIMINATION_MIN = 0.25;

/**
 * T5 — STRUCTURE, NOT A UNIFORM WASH.
 *
 * `spatialVariance` = per-frame coefficient of variation across pixels
 * (std ÷ mean), median over the profiles. Direction v2 §4.1–4.2: a beat must
 * produce "a measurable, NON-UNIFORM change across the geometry"; the whole
 * point of the mandala is that light moves through it.
 *
 * EVIDENCE: twelve effects measure 0.208–6.46; two measure 0.157 and 0.053.
 * 0.20 is set at the observed floor of the healthy population — i.e. at
 * hearth's 0.244 minus the margin a full-field fire bed deserves — not above
 * it, so no currently-structured effect is asked to add texture it does not
 * want.
 */
const SPATIAL_VARIANCE_MIN = 0.20;

/**
 * T6 — NO STROBING.
 *
 * Zero frames anywhere in the sweep may move the WHOLE-PIECE mean by more than
 * `SNAP_MEAN_DELTA` (0.25 of full range) inside one 25 ms frame.
 *
 * EVIDENCE: the largest single-frame whole-piece move measured across all 14 ×
 * 8 runs is 0.198 (lattice, dynamic build). Every effect passes today with room
 * to spare, which is exactly what this guard is for: the two tuning agents are
 * about to add attack, and this is the line they must not cross while doing it.
 * Per-pixel snaps are counted separately and NOT asserted — a spark igniting in
 * 40 ms is a texture, and Twinkle's 21–60 per run are its authored identity.
 */

/**
 * T7 — SILENCE STAYS BEAUTIFUL (the nine legacy modes only).
 *
 * Direction v2 §4.9 and the engine's own coal law: never black, never a glow,
 * and it does finish letting go. Characters are exempt — they have no coal bed
 * of their own; `showEnsemble` composites one, so a character measured alone
 * settling near zero is correct, not a defect.
 *
 * EVIDENCE: all nine legacy modes measure a silence floor of 0.0286–0.0358 and
 * a decay of 0.48–6.65 s. The window is set wide enough to hold all nine.
 */
const LEGACY_SILENCE_FLOOR_MIN = 0.010;
const LEGACY_SILENCE_FLOOR_MAX = 0.080;
const DECAY_TIME_MAX = 12;

// ─────────────────────────────────────────────────────────────────────────────
//  KNOWN GAPS — the 2026-08-21 baseline. Documentation, never a relaxation.
//
//  A failing assertion looks up its effect here. If the effect is listed, the
//  message says "KNOWN GAP (baseline X)" and names the diagnosis, so the tuning
//  agent gets a brief instead of a number. If it is NOT listed, the message
//  says REGRESSION — something that used to clear the bar has stopped.
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_GAPS = {
  crossProfileSwing: {
    ripple: [1.035, 'never re-arms: RIPPLE_ONSET_LOW=0.18 means any track whose bass floor stays above 0.18 (most of them) fires ONE wavefront and then nothing. Measured litFraction is 0.000 on dense rock, bass electronic AND bright acoustic — the piece is literally unlit.'],
    embers: [1.943, 'spark birth rate barely moves with level; loud and quiet produce almost the same field.'],
    glow: [2.932, 'level = 0.15 + 0.65·(mood/env) — the 0.15 pedestal is 46% of its own loud level, so the quiet end can never get dark. Lower the pedestal or widen the span.'],
  },
  sustainedMusicLift: {
    ripple: [1.005, 'same root cause as its swing failure — dark on three of the four sustained genres.'],
    glow: [2.398, 'same 0.15 pedestal: its silence floor is 0.1375, 4.8× the legacy coal floor.'],
  },
  onsetVisibility: {
    trace: [0.023, 'TRACE_ATTACK_TAU 0.08 s feeds only amplitude and breadth of a 60 s arm; a hit never lands anywhere in particular.'],
    swell: [0.045, 'reach is slew-limited to 0.15 gain/s (SWELL_REACH_SLEW), which by construction cannot answer a 200 ms window.'],
    tide: [0.064, 'crest amplitude answers the bass envelope, but nothing in the mode is articulated BY the onset.'],
    bloom: [0.069, 'bass opens the flower on an eased envelope; the kick itself leaves no mark.'],
    hearth: [0.125, 'the localized bass warmth is real but sits under a slow mood bed that dominates the mean.'],
    strata: [0.135, 'radial band interpolation is a level readout — stable by design, which is also why a hit does not show.'],
    meridian: [0.145, 'just under the bar; the ring moves on centroid, and its amplitude barely answers the hit.'],
  },
  bandDiscrimination: {
    ripple: [0.039, 'reads bass but produces the same near-dark output either way, so the band never reaches the light.'],
    procession: [0.047, 'authored for mids/broadband; measures as pure broadband energy.'],
    glow: [0.065, 'energy only, and the mood bed averages the difference away.'],
    embers: [0.071, 'spark births ride energy/treble texture but end up genre-blind.'],
    spiral: [0.080, 'authored for mids; measures as broadband.'],
  },
  spatialVariance: {
    ripple: [0.157, 'three wavefronts that mostly never spawn leave a flat 0.04 ambient wash.'],
    glow: [0.053, 'a 3-lobe ±7% texture over a full-field level — very nearly a uniform brighten.'],
  },
};

function gapNote(metric, effect, measured, threshold, comparison = 'below') {
  const known = KNOWN_GAPS[metric]?.[effect];
  const head = `${effect}: ${metric} = ${measured} (${comparison} the ${threshold} bar)`;
  if (!known) {
    return `${head} — REGRESSION. This effect was NOT a known gap on 2026-08-21; something that passed has stopped passing. Do not add it to KNOWN_GAPS — find what changed.`;
  }
  const [baseline, diagnosis] = known;
  const drift = measured === baseline ? 'unchanged from baseline' : `baseline was ${baseline}`;
  return `${head} — KNOWN GAP, ${drift}. ${diagnosis} RAISE THE EFFECT; do not lower the threshold.`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Harness sanity — a probe that lies is worse than no probe
// ─────────────────────────────────────────────────────────────────────────────

test('the sweep covers all fourteen effects on all eight profiles', () => {
  assert.equal(EFFECT_IDS.length, 14, 'nine legacy modes + five characters');
  assert.equal(LEGACY.length, 9);
  assert.equal(CHARACTERS.length, 5);
  assert.equal(PROFILE_KEYS.length, 8);
  for (const id of EFFECT_IDS) {
    assert.ok(RESULTS[id], `no measurement for ${id}`);
    for (const p of PROFILE_KEYS) {
      assert.ok(RESULTS[id].perProfile[p], `no ${p} row for ${id}`);
      assert.ok(RESULTS[id].perProfile[p].frames > 100, `${id}/${p} ran only ${RESULTS[id].perProfile[p].frames} frames`);
    }
  }
});

test('the profiles are genuinely different music, not the same envelope relabelled', () => {
  const built = PROFILE_KEYS.map((k) => buildProfile(k));
  const signature = (p) => {
    const lit = p.frames.filter((f) => f.t > 3);
    const avg = (fn) => lit.reduce((a, f) => a + fn(f), 0) / Math.max(1, lit.length);
    return [avg((f) => f.bands.bass), avg((f) => f.bands.mid), avg((f) => f.bands.high)];
  };
  const sigs = built.map(signature);
  // Bass-heavy electronic must actually be bass-heavy versus bright acoustic.
  const be = sigs[PROFILE_KEYS.indexOf('bassElectronic')];
  const ba = sigs[PROFILE_KEYS.indexOf('brightAcoustic')];
  assert.ok(be[0] > ba[0] * 3, `bassElectronic bass ${be[0]} should dwarf brightAcoustic's ${ba[0]}`);
  assert.ok(ba[2] > be[2] * 3, `brightAcoustic high ${ba[2]} should dwarf bassElectronic's ${be[2]}`);
  // Nobody is a copy of anybody.
  for (let i = 0; i < sigs.length; i += 1) {
    for (let j = i + 1; j < sigs.length; j += 1) {
      const d = Math.abs(sigs[i][0] - sigs[j][0]) + Math.abs(sigs[i][1] - sigs[j][1]) + Math.abs(sigs[i][2] - sigs[j][2]);
      assert.ok(d > 0.02, `profiles ${PROFILE_KEYS[i]} and ${PROFILE_KEYS[j]} are indistinguishable (band distance ${d})`);
    }
  }
  // Transient content is what separates sparse percussion from dense rock.
  const sparse = built[PROFILE_KEYS.indexOf('sparsePercussion')];
  const dense = built[PROFILE_KEYS.indexOf('denseRock')];
  assert.ok(sparse.hasContrast, 'sparse percussion must have loud and quiet passages');
  assert.ok(!dense.hasContrast, 'dense rock is one continuous loud passage by construction');
});

test('measurement is deterministic — the same effect and profile measure identically twice', () => {
  const a = measureEffectProfile('lattice', 'fourOnFloor', { preset: PRESET });
  const b = measureEffectProfile('lattice', 'fourOnFloor', { preset: PRESET });
  assert.deepEqual(a, b);
  // And a fresh engine per run: no module-scoped state carries between them.
  const c = measureEffectProfile('lattice', 'fourOnFloor', { preset: PRESET });
  assert.deepEqual(a, c);
});

// ─────────────────────────────────────────────────────────────────────────────
//  Hard invariants — these are not taste, and none of them may ever fail
// ─────────────────────────────────────────────────────────────────────────────

for (const id of EFFECT_IDS) {
  test(`${id} — output is finite, non-negative and inside [0,1] on every profile`, () => {
    const s = RESULTS[id].summary;
    assert.equal(s.nonFinite, 0, `${id} produced ${s.nonFinite} non-finite pixel values`);
    assert.equal(s.negative, 0, `${id} produced ${s.negative} negative pixel values`);
    for (const p of PROFILE_KEYS) {
      const row = RESULTS[id].perProfile[p];
      assert.ok(row.peakPixel <= 1 + 1e-6, `${id}/${p} peak pixel ${row.peakPixel} exceeds 1`);
      assert.ok(row.floor >= 0, `${id}/${p} floor ${row.floor} is negative`);
    }
  });
}

for (const id of EFFECT_IDS) {
  test(`${id} — no strobing: zero whole-piece jumps above ${SNAP_MEAN_DELTA} in one frame`, () => {
    const s = RESULTS[id].summary;
    assert.equal(
      s.totalSnapCount, 0,
      `${id} snapped the whole piece ${s.totalSnapCount} times. The largest single-frame whole-piece move measured across all fourteen effects on 2026-08-21 was 0.198 (lattice); anything over ${SNAP_MEAN_DELTA} reads as a strobe in a listening gallery. Fast attack is allowed and does not trip this — a fast attack takes several frames.`,
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  T1 — loud track vs quiet track
// ─────────────────────────────────────────────────────────────────────────────

for (const id of EFFECT_IDS) {
  test(`${id} — a loud track is at least ${CROSS_PROFILE_SWING_MIN}× a quiet track`, () => {
    const v = RESULTS[id].summary.crossProfileSwing;
    assert.ok(
      v >= CROSS_PROFILE_SWING_MIN,
      gapNote('crossProfileSwing', id, v, CROSS_PROFILE_SWING_MIN),
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  T2 — visibly alive on every kind of continuously-playing music
// ─────────────────────────────────────────────────────────────────────────────

for (const id of EFFECT_IDS) {
  if (SPARK_EFFECTS.has(id)) continue;
  test(`${id} — the weakest genre still lifts it ${SUSTAINED_MUSIC_LIFT_MIN}× above its silence floor`, () => {
    const s = RESULTS[id].summary;
    assert.ok(
      s.sustainedMusicLift >= SUSTAINED_MUSIC_LIFT_MIN,
      `${gapNote('sustainedMusicLift', id, s.sustainedMusicLift, SUSTAINED_MUSIC_LIFT_MIN)} `
      + `Weakest genre was "${s.worstSustainedProfile}" at mean ${s.worstSustainedMean} against a silence floor of ${s.silenceFloor}.`,
    );
  });
}

for (const id of SPARK_EFFECTS) {
  test(`${id} — sparse by authorship, so it is judged on sparks existing and being bright`, () => {
    const lit = SUSTAINED_PROFILE_KEYS
      .map((p) => RESULTS[id].perProfile[p].litFraction)
      .sort((a, b) => a - b);
    const medianLit = (lit[1] + lit[2]) / 2;
    const peak = Math.max(...SUSTAINED_PROFILE_KEYS.map((p) => RESULTS[id].perProfile[p].peakPixel));
    assert.ok(
      medianLit >= SPARK_LIT_FRACTION_MIN,
      `${id}: median lit fraction across the four sustained genres is ${medianLit.toFixed(4)}, under the ${SPARK_LIT_FRACTION_MIN} bar. Per-genre: ${SUSTAINED_PROFILE_KEYS.map((p) => `${p} ${RESULTS[id].perProfile[p].litFraction}`).join(', ')}. Raise the spark rate, not the bar.`,
    );
    assert.ok(
      peak >= SPARK_PEAK_MIN,
      `${id}: brightest spark reaches only ${peak}, under the ${SPARK_PEAK_MIN} bar — sparse only reads if the sparks are bright.`,
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  T3 — the beat shows
// ─────────────────────────────────────────────────────────────────────────────

for (const id of EFFECT_IDS) {
  if (ONSET_EXEMPT.has(id)) continue;
  test(`${id} — a hit lifts the piece at least ${ONSET_VISIBILITY_MIN * 100}% within 200 ms`, () => {
    const v = RESULTS[id].summary.medianOnsetVisibility;
    assert.notEqual(v, null, `${id}: no onset measurement at all — the probe found fewer than three usable hits, which means this effect never moved on any percussive profile.`);
    assert.ok(
      v >= ONSET_VISIBILITY_MIN,
      gapNote('onsetVisibility', id, v, ONSET_VISIBILITY_MIN),
    );
  });
}

test('glow is the only effect exempt from the onset bar, and only by authored identity', () => {
  assert.deepEqual([...ONSET_EXEMPT], ['glow']);
  // docs/mandala-audio-mapping.md §6, Temperature Field: "No transient response
  // (that IS its identity)". The exemption costs nothing, because Glow is held
  // to T1, T2, T4 and T5 like everything else — and currently fails all four.
  const s = RESULTS.glow.summary;
  assert.ok(typeof s.medianOnsetVisibility === 'number', 'glow onset response is still measured, just not gated');
});

// ─────────────────────────────────────────────────────────────────────────────
//  T4 — it is actually listening to a band
// ─────────────────────────────────────────────────────────────────────────────

for (const id of EFFECT_IDS) {
  test(`${id} — answers bass-heavy and bright-acoustic music differently (≥ ${BAND_DISCRIMINATION_MIN})`, () => {
    const v = RESULTS[id].summary.bandDiscrimination;
    const be = RESULTS[id].perProfile.bassElectronic.tailMean;
    const ba = RESULTS[id].perProfile.brightAcoustic.tailMean;
    assert.ok(
      v >= BAND_DISCRIMINATION_MIN,
      `${gapNote('bandDiscrimination', id, v, BAND_DISCRIMINATION_MIN)} `
      + `Settled means were ${be} (bass electronic) and ${ba} (bright acoustic).`,
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  T5 — structure, not a uniform wash
// ─────────────────────────────────────────────────────────────────────────────

for (const id of EFFECT_IDS) {
  test(`${id} — the light has spatial structure (CoV ≥ ${SPATIAL_VARIANCE_MIN})`, () => {
    const v = RESULTS[id].summary.spatialVariance;
    assert.ok(
      v >= SPATIAL_VARIANCE_MIN,
      gapNote('spatialVariance', id, v, SPATIAL_VARIANCE_MIN),
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  T7 — silence stays beautiful (legacy modes; characters have no coal bed)
// ─────────────────────────────────────────────────────────────────────────────

for (const id of LEGACY) {
  test(`${id} — silence settles to a dim coal field, never black, and finishes letting go`, () => {
    const s = RESULTS[id].summary;
    assert.ok(
      s.silenceFloor > LEGACY_SILENCE_FLOOR_MIN,
      `${id}: silence floor ${s.silenceFloor} is at or below ${LEGACY_SILENCE_FLOOR_MIN} — the never-black law (direction v2 §4.9) is broken.`,
    );
    assert.ok(
      s.silenceFloor <= LEGACY_SILENCE_FLOOR_MAX,
      `${id}: silence floor ${s.silenceFloor} is above ${LEGACY_SILENCE_FLOOR_MAX} — that is a glow, not a coal field, and it is what caps the loud-vs-quiet swing.`,
    );
    assert.notEqual(s.decayTime, null, `${id}: never finished decaying inside the 20 s tail.`);
    assert.ok(
      s.decayTime <= DECAY_TIME_MAX,
      `${id}: took ${s.decayTime}s to let go of 90% of its level — over the ${DECAY_TIME_MAX}s bound.`,
    );
  });
}

test('every character is measured in silence too, even though none is gated on it', () => {
  // Recorded, not asserted: a character alone has no coal bed — showEnsemble
  // composites one. This test exists so the numbers are never quietly dropped.
  for (const id of CHARACTERS) {
    const s = RESULTS[id].summary;
    assert.equal(typeof s.silenceFloor, 'number', `${id} has no silence measurement`);
    assert.equal(typeof s.decayTime === 'number' || s.decayTime === null, true);
  }
});
