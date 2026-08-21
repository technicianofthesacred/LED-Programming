// showEnsemble.test.js — node:test coverage for the Show ensemble runtime.
//
// The five properties the task calls MUST HOLD each get a named test below:
//   1. two voices in the same field with DIFFERENT spreads produce different
//      phase vectors over the SAME instance ordering, neither leaking
//   2. multiple fields (4-fold + 6-fold + fold-1) coexist in one frame
//   3. instance-phase ripple stays STRICTLY within its own field, while the
//      ground layer crosses between fields naturally
//   4. a muted voice contributes exactly zero
//   5. N overlapping voices sum then clip
//
// Plus the locked-aesthetic law at ensemble level: no band value can reach an
// authored clock, asserted by pinning every voice's clock with bands at 0 vs 1.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEnsembleRuntime,
  instancePhase,
  normalizeDirection,
  softClip,
  zoneChallengeWins,
  CLIP_KNEE,
  ZONE_HYSTERESIS,
  GROUND_CHARACTER,
  LIVING_COAL_FLOOR,
} from './showEnsemble.js';

const TAU = Math.PI * 2;
const DT = 1 / 60;

// ─────────────────────────────────────────────────────────────────────────────
// A synthetic layout with THREE fields at once, plus one strip in no area.
//
//   f4  4-fold  arms a0..a3  at 0, 90, 180, 270 deg
//   f6  6-fold  arms b0..b5  at 0, 60, 120, 180, 240, 300 deg
//   f1  fold-1  arm  c0      at 30 deg
//   (none)      arm  z0      at 45 deg  — unvoiced, only the ground reaches it
//
// a0's innermost pixel and b0's innermost pixel are placed at the SAME
// (radius, angle) on purpose: it is how test 3 proves the ground layer is a
// function of real geometry and not of field membership.
// ─────────────────────────────────────────────────────────────────────────────

const A_RADII = [0.2, 0.4, 0.6, 0.8];
const B_RADII = [0.2, 0.5, 0.75];
const C_RADII = [0.3, 0.6];
const Z_RADII = [0.5];

function pushArm(out, stripId, stripIndex, angle, radii) {
  radii.forEach((r, i) => {
    out.push({
      outputIndex: out.length,
      stripId,
      stripIndex,
      stripProgress: radii.length > 1 ? i / (radii.length - 1) : 0,
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
      radius: r,
      angle,
    });
  });
}

function makeTemplate() {
  const out = [];
  let idx = 0;
  for (let i = 0; i < 4; i += 1) pushArm(out, `a${i}`, idx++, (i * TAU) / 4, A_RADII);
  for (let i = 0; i < 6; i += 1) pushArm(out, `b${i}`, idx++, (i * TAU) / 6, B_RADII);
  pushArm(out, 'c0', idx++, TAU / 12, C_RADII);
  pushArm(out, 'z0', idx++, TAU / 8, Z_RADII);
  return out;
}

const TEMPLATE = makeTemplate();

function pixelsOfStrips(stripIds) {
  const wanted = new Set(stripIds);
  const out = [];
  TEMPLATE.forEach((px, i) => { if (wanted.has(px.stripId)) out.push(i); });
  return out;
}

const A_PIXELS = pixelsOfStrips(['a0', 'a1', 'a2', 'a3']);
const B_PIXELS = pixelsOfStrips(['b0', 'b1', 'b2', 'b3', 'b4', 'b5']);
const C_PIXELS = pixelsOfStrips(['c0']);
const Z_PIXELS = pixelsOfStrips(['z0']);

function field(id, fold, order) {
  return {
    id, fold, centre: { x: 0, y: 0 }, rotationOffset: 0, mirror: false,
    scope: { kind: 'all' }, order,
  };
}

function armArea(id, fieldId, prefix, count) {
  return {
    id,
    name: id,
    fieldId,
    instances: Array.from({ length: count }, (_, i) => ({
      index: i, stripIds: [`${prefix}${i}`], mirrored: false,
    })),
  };
}

// `band: null` means UNAUTHORED — the voice keeps its character's own
// recommended band (Swell -> bass, Twinkle -> high, Glow -> energy, ...),
// which is what every test written before per-voice bands existed assumed.
// Tests that care about band selection pass an explicit `band` override.
function voice(id, areaId, character, extra = {}) {
  return {
    id,
    areaId,
    character,
    band: null,
    depth: 1,
    spread: 1,
    direction: 1,
    palette: null,
    muted: false,
    ...extra,
  };
}

function makeComposition(voices, groundOverrides = {}) {
  return {
    id: 'comp-test',
    name: 'ensemble test',
    projectId: 'proj-test',
    master: 1,
    sensitivity: 0.5,
    ground: { enabled: true, level: 0.5, band: 'none', palette: 'coal', ...groundOverrides },
    fields: [field('f4', 4, 0), field('f6', 6, 1), field('f1', 1, 2)],
    areas: [
      armArea('areaA', 'f4', 'a', 4),
      armArea('areaB', 'f6', 'b', 6),
      { id: 'areaC', name: 'areaC', fieldId: 'f1', instances: [{ index: 0, stripIds: ['c0'], mirrored: false }] },
    ],
    voices,
  };
}

function makeRuntime(voices, groundOverrides) {
  return createEnsembleRuntime({
    template: TEMPLATE,
    composition: makeComposition(voices, groundOverrides),
  });
}

const SILENT = { bass: 0, mid: 0, high: 0, energy: 0, beat: 0 };
const LOUD = { bass: 1, mid: 1, high: 1, energy: 1, beat: 1 };

function drive(rt, frames, bandsFor) {
  const target = new Float32Array(TEMPLATE.length);
  let stats = null;
  for (let f = 0; f < frames; f += 1) {
    stats = rt.tickVoices(target, { dt: DT, bands: typeof bandsFor === 'function' ? bandsFor(f) : bandsFor });
  }
  return { target, stats };
}

// ═════════════════════════════════════════════════════════════════════════════
// soft clip
// ═════════════════════════════════════════════════════════════════════════════

test('softClip is the identity at and below the knee, so a lone voice is untouched', () => {
  for (const x of [0, 1e-7, 0.1, 0.25, 0.5, 0.7499, CLIP_KNEE]) {
    assert.equal(softClip(x), x, `softClip(${x}) must pass through unchanged`);
  }
  assert.equal(softClip(CLIP_KNEE), CLIP_KNEE);
});

test('softClip is monotone and never overshoots 1', () => {
  let prev = -Infinity;
  for (let x = 0; x <= 12; x += 0.001) {
    const y = softClip(x);
    assert.ok(y >= prev, `softClip must be non-decreasing at x=${x}`);
    // Strictly increasing across the whole range a real frame can produce
    // (twelve voices at full depth would not reach x = 4).
    if (x < 4) assert.ok(y > prev, `softClip must be strictly increasing at x=${x}`);
    // Strictly below 1 until the remaining gap falls under a double's
    // resolution (x ~= 9.7); above that it rounds to exactly 1.0, which is
    // full brightness — a legal value, and never an overshoot.
    if (x <= 9) assert.ok(y < 1, `softClip(${x}) = ${y} must stay below 1`);
    assert.ok(y <= 1, `softClip(${x}) = ${y} must never exceed 1`);
    prev = y;
  }
  assert.ok(softClip(100) <= 1);
  assert.ok(softClip(100) > 0.999);
  assert.ok(softClip(3) < 1 && softClip(3) > 0.99);
});

test('softClip is continuous across the knee', () => {
  const below = softClip(CLIP_KNEE - 1e-9);
  const above = softClip(CLIP_KNEE + 1e-9);
  assert.ok(Math.abs(above - below) < 1e-8);
});

// ═════════════════════════════════════════════════════════════════════════════
// phase math — the audio-isolation boundary
// ═════════════════════════════════════════════════════════════════════════════

test('instancePhase takes no frame ctx, so no band value can reach a phase', () => {
  // Arity is the structural guarantee: (field, voice, k). There is no
  // parameter a band could arrive through.
  assert.equal(instancePhase.length, 3);
  const src = instancePhase.toString();
  for (const banned of ['ctx', 'bands', 'bass', 'mid', 'high', 'energy', 'beat', 'env']) {
    assert.ok(!new RegExp(`\\b${banned}\\b`).test(src),
      `instancePhase must not mention "${banned}"`);
  }
});

test('instancePhase returns 0 for no field, fold 1, or spread 0 (unison)', () => {
  const f4 = { fold: 4, angularOrder: [0, 1, 2, 3], radialRank: [0, 1, 2, 3] };
  assert.equal(instancePhase(null, { spread: 1, direction: 'cw' }, 2), 0);
  assert.equal(instancePhase({ fold: 1, angularOrder: [0], radialRank: [0] }, { spread: 1 }, 0), 0);
  for (let k = 0; k < 4; k += 1) {
    assert.equal(instancePhase(f4, { spread: 0, direction: 'cw' }, k), 0,
      'spread 0 is unison — one bloom, not a wave');
  }
});

test('instancePhase staggers instances evenly across one cycle at spread 1', () => {
  const f4 = { fold: 4, angularOrder: [0, 1, 2, 3], radialRank: [3, 2, 1, 0] };
  const v = { spread: 1, direction: 'cw' };
  assert.deepEqual([0, 1, 2, 3].map((k) => instancePhase(f4, v, k)), [0, 0.25, 0.5, 0.75]);

  const ccw = { spread: 1, direction: 'ccw' };
  assert.deepEqual([0, 1, 2, 3].map((k) => instancePhase(f4, ccw, k)), [0, 0.75, 0.5, 0.25]);

  const out = { spread: 1, direction: 'centre-out' };
  assert.deepEqual([0, 1, 2, 3].map((k) => instancePhase(f4, out, k)), [0.75, 0.5, 0.25, 0]);
});

test('instancePhase scales linearly with spread', () => {
  const f6 = { fold: 6, angularOrder: [0, 1, 2, 3, 4, 5], radialRank: [0, 1, 2, 3, 4, 5] };
  for (const spread of [0.25, 0.5, 0.75, 1]) {
    for (let k = 0; k < 6; k += 1) {
      assert.ok(Math.abs(instancePhase(f6, { spread, direction: 'cw' }, k) - (k / 6) * spread) < 1e-12);
    }
  }
});

test('normalizeDirection bridges the 1|-1 form showComposition stores', () => {
  assert.equal(normalizeDirection(1), 'cw');
  assert.equal(normalizeDirection(-1), 'ccw');
  assert.equal(normalizeDirection('ccw'), 'ccw');
  assert.equal(normalizeDirection('centre-out'), 'centre-out');
  assert.equal(normalizeDirection('center-out'), 'centre-out');
  assert.equal(normalizeDirection(undefined), 'cw');
  assert.equal(normalizeDirection('nonsense'), 'cw');
});

// ═════════════════════════════════════════════════════════════════════════════
// MUST HOLD 1 — two spreads, one field, no leakage
// ═════════════════════════════════════════════════════════════════════════════

test('two voices in the same field with different spreads get different phase vectors over the same instance ordering', () => {
  const rt = makeRuntime([
    voice('wide', 'areaA', 'trace', { spread: 1 }),
    voice('tight', 'areaA', 'trace', { spread: 0.5 }),
  ]);
  const wide = rt.getVoiceDebug('wide');
  const tight = rt.getVoiceDebug('tight');

  assert.equal(wide.fold, 4);
  assert.equal(tight.fold, 4);
  assert.equal(wide.fieldId, 'f4');
  assert.equal(tight.fieldId, 'f4');

  assert.deepEqual(wide.phases, [0, 0.25, 0.5, 0.75]);
  assert.deepEqual(tight.phases, [0, 0.125, 0.25, 0.375]);

  // SAME instance ordering: both are strictly ascending in the same order,
  // and each is the other scaled by the spread ratio.
  for (let k = 1; k < 4; k += 1) {
    assert.ok(wide.phases[k] > wide.phases[k - 1]);
    assert.ok(tight.phases[k] > tight.phases[k - 1]);
    assert.ok(Math.abs(tight.phases[k] * 2 - wide.phases[k]) < 1e-12);
  }
});

test('neither voice leaks its spread into the other, before or after a frame', () => {
  const rt = makeRuntime([
    voice('wide', 'areaA', 'swell', { spread: 1 }),
    voice('unison', 'areaA', 'swell', { spread: 0 }),
  ]);
  const before = [rt.getVoiceDebug('wide').phases, rt.getVoiceDebug('unison').phases];
  drive(rt, 120, LOUD);
  const after = [rt.getVoiceDebug('wide').phases, rt.getVoiceDebug('unison').phases];

  assert.deepEqual(before[0], [0, 0.25, 0.5, 0.75]);
  assert.deepEqual(before[1], [0, 0, 0, 0]);
  assert.deepEqual(after[0], before[0], 'a frame must not mutate a voice phase vector');
  assert.deepEqual(after[1], before[1]);

  // Their runtimes are independent objects — no shared clock or envelope.
  const w = rt.getVoiceDebug('wide');
  const u = rt.getVoiceDebug('unison');
  assert.ok(Number.isFinite(w.clock) && Number.isFinite(u.clock));
  assert.equal(w.characterKey, 'swell');
  assert.equal(u.characterKey, 'swell');
});

// ═════════════════════════════════════════════════════════════════════════════
// MUST HOLD 2 — three folds in one frame
// ═════════════════════════════════════════════════════════════════════════════

test('a 4-fold, a 6-fold and a fold-1 field coexist in one frame', () => {
  const rt = makeRuntime([
    voice('vA', 'areaA', 'trace', { spread: 1 }),
    voice('vB', 'areaB', 'swell', { spread: 1 }),
    voice('vC', 'areaC', 'glow', { spread: 1 }),
  ], { enabled: false });

  const resolvedFieldIds = rt.getResolved().fieldIds;
  assert.deepEqual(resolvedFieldIds.slice().sort(), ['f1', 'f4', 'f6']);

  const dA = rt.getVoiceDebug('vA');
  const dB = rt.getVoiceDebug('vB');
  const dC = rt.getVoiceDebug('vC');
  assert.equal(dA.fold, 4);
  assert.equal(dB.fold, 6);
  assert.equal(dC.fold, 1);
  assert.equal(dA.phases.length, 4);
  assert.equal(dB.phases.length, 6);
  assert.deepEqual(dC.phases, [0], 'fold 1 is structural: one body, no spread can separate it');

  assert.deepEqual(dB.phases.map((p) => Math.round(p * 600) / 100), [0, 1, 2, 3, 4, 5].map((k) => Math.round((k / 6) * 600) / 100));

  const { target, stats } = drive(rt, 90, LOUD);
  assert.equal(stats.painted, 3, 'all three voices painted in the same frame');
  assert.ok(A_PIXELS.some((i) => target[i] > 0), '4-fold area lit');
  assert.ok(B_PIXELS.some((i) => target[i] > 0), '6-fold area lit');
  assert.ok(C_PIXELS.some((i) => target[i] > 0), 'fold-1 area lit');
  for (const i of Z_PIXELS) {
    assert.equal(target[i], LIVING_COAL_FLOOR,
      'ground disabled — an unvoiced strip sits on the living-coal floor, never black');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MUST HOLD 3 — phase ripple is field-local; ground crosses fields
// ═════════════════════════════════════════════════════════════════════════════

test('instance-phase ripple stays strictly inside its own field', () => {
  const build = (spread) => makeRuntime([
    voice('rip', 'areaA', 'ripple', { spread }),
    voice('other', 'areaB', 'glow', { spread: 1 }),
    voice('solo', 'areaC', 'trace', { spread: 1 }),
  ]);

  const unison = drive(build(0), 40, LOUD).target;
  const wave = drive(build(1), 40, LOUD).target;

  // Inside the rippling field the phase visibly changes the picture...
  assert.ok(A_PIXELS.some((i) => Math.abs(unison[i] - wave[i]) > 1e-6),
    'spread must change the picture inside its own field');

  // ...and NOWHERE else. Not the 6-fold field, not the fold-1 field, not the
  // unvoiced strip. Exact equality, not a tolerance.
  for (const i of [...B_PIXELS, ...C_PIXELS, ...Z_PIXELS]) {
    assert.equal(wave[i], unison[i],
      `pixel ${i} is outside field f4 and must be byte-identical`);
  }
});

test('the ground layer crosses field boundaries: it is a function of geometry, not membership', () => {
  const rt = makeRuntime([], { enabled: true, level: 0.6, band: 'none' });
  const { target } = drive(rt, 30, SILENT);

  for (const group of [A_PIXELS, B_PIXELS, C_PIXELS, Z_PIXELS]) {
    assert.ok(group.every((i) => target[i] > 0),
      'the ground reaches every pixel — including the strip in no area at all');
  }

  // a0's innermost pixel (field f4) and b0's innermost pixel (field f6) share
  // one (radius, angle). Different fields, identical geometry -> identical
  // ground value. Nothing about instance index reached the ground layer.
  const a0first = TEMPLATE.findIndex((px) => px.stripId === 'a0');
  const b0first = TEMPLATE.findIndex((px) => px.stripId === 'b0');
  assert.equal(TEMPLATE[a0first].radius, TEMPLATE[b0first].radius);
  assert.equal(TEMPLATE[a0first].angle, TEMPLATE[b0first].angle);
  assert.equal(target[a0first], target[b0first]);
});

// F4. The version of this test that shipped first drove 600 frames of silence
// from a COLD runtime and asserted only "dim, and not zero" — which a 46-second
// decay passes just as easily as an 8-second one, because it never saw a loud
// state at all. It now starts fully LOUD and fully settled and measures the
// time to fall back to the coal floor.
//
// The measurement runs TWO runtimes in lockstep, frame for frame: one that
// goes loud then silent, and a cold control that is silent throughout. Their
// authored clocks therefore match exactly at every frame, so subtracting the
// control removes Glow's slow drift/texture/flicker and leaves the AUDIO
// EXCURSION alone. Comparing raw pixel values instead would be measuring a
// 78-second drift cycle as well as the decay.
test('F4: a loud piece decays to the living-coal ground in ~8 seconds', () => {
  // Ground only, and on a real band: this measures the living-coal field
  // itself. (makeComposition's default ground band is 'none', i.e. a ground
  // that never reacts at all — it has to be given a band to have a decay.)
  const build = () => makeRuntime([], { enabled: true, level: 0.5, band: 'energy' });
  const hot = build();
  const cold = build();
  const hotTarget = new Float32Array(TEMPLATE.length);
  const coldTarget = new Float32Array(TEMPLATE.length);

  const excursion = () => {
    let worst = 0;
    for (let i = 0; i < hotTarget.length; i += 1) {
      worst = Math.max(worst, Math.abs(hotTarget[i] - coldTarget[i]));
    }
    return worst;
  };

  // 120s loud: Glow's 20s mood bed is fully settled, the worst case for a decay.
  for (let f = 0; f < 60 * 120; f += 1) {
    hot.tickVoices(hotTarget, { dt: DT, bands: LOUD });
    cold.tickVoices(coldTarget, { dt: DT, bands: SILENT });
  }
  const lit = excursion();
  assert.ok(lit > 0.1, `the loud state must be visibly lit above the floor, saw ${lit}`);

  let elapsed = null;
  for (let f = 0; f < 60 * 60 && elapsed === null; f += 1) {
    hot.tickVoices(hotTarget, { dt: DT, bands: SILENT });
    cold.tickVoices(coldTarget, { dt: DT, bands: SILENT });
    if (excursion() <= lit * 0.05) elapsed = (f + 1) * DT;
  }
  assert.ok(elapsed !== null, 'the piece never settled back to the ground within 60s');
  // The spec says "roughly 8 seconds"; before this fix the same measurement
  // was 30-60s. Tolerance is +/- 1.5s.
  assert.ok(elapsed >= 6.5 && elapsed <= 9.5,
    `expected ~8s to decay to the living-coal ground, measured ${elapsed.toFixed(2)}s`);
});

test('silence leaves a dim living-coal ground — never black, never full', () => {
  const rt = makeRuntime([voice('v', 'areaA', 'swell')], { enabled: true, level: 0.5 });
  const { target } = drive(rt, 600, SILENT);   // 10s of silence
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < target.length; i += 1) {
    min = Math.min(min, target[i]);
    max = Math.max(max, target[i]);
  }
  assert.ok(min >= LIVING_COAL_FLOOR, 'the piece never decays to black');
  assert.ok(max < 0.35, 'silence is dim, not a lit piece');
});

// ═════════════════════════════════════════════════════════════════════════════
// MUST HOLD 4 — a muted voice contributes exactly zero
// ═════════════════════════════════════════════════════════════════════════════

test('a muted voice contributes exactly zero — byte-identical to not being there', () => {
  const withMuted = makeRuntime([
    voice('loud', 'areaB', 'glow'),
    voice('quiet', 'areaA', 'ripple', { muted: true }),
  ]);
  const withoutIt = makeRuntime([
    voice('loud', 'areaB', 'glow'),
  ]);
  const unmuted = makeRuntime([
    voice('loud', 'areaB', 'glow'),
    voice('quiet', 'areaA', 'ripple', { muted: false }),
  ]);

  const a = drive(withMuted, 60, LOUD).target;
  const b = drive(withoutIt, 60, LOUD).target;
  const c = drive(unmuted, 60, LOUD).target;

  for (let i = 0; i < a.length; i += 1) {
    assert.equal(a[i], b[i], `muted voice changed pixel ${i}`);
  }
  assert.ok(A_PIXELS.some((i) => c[i] !== a[i]),
    'the same voice unmuted must actually paint — otherwise the test proves nothing');
});

test('a muted voice still advances its authored clock, so unmuting rejoins in phase', () => {
  const muted = makeRuntime([voice('v', 'areaA', 'trace', { muted: true })]);
  const live = makeRuntime([voice('v', 'areaA', 'trace', { muted: false })]);
  drive(muted, 120, LOUD);
  drive(live, 120, LOUD);
  assert.ok(Math.abs(muted.getVoiceDebug('v').clock - live.getVoiceDebug('v').clock) < 1e-12);
});

test('a voice whose area no longer exists is kept, renders nothing, and never throws', () => {
  const rt = makeRuntime([
    voice('orphan', 'areaGone', 'ripple'),
    voice('ok', 'areaA', 'glow'),
  ], { enabled: false });
  const resolved = rt.getResolved();
  assert.ok(resolved.warnings.some((w) => w.kind === 'missing-area'));
  const orphan = rt.getVoiceDebug('orphan');
  assert.equal(orphan.pixelCount, 0);
  assert.deepEqual(orphan.phases, []);

  const { target, stats } = drive(rt, 30, LOUD);
  assert.equal(stats.painted, 1);
  for (const i of [...B_PIXELS, ...C_PIXELS, ...Z_PIXELS]) {
    assert.equal(target[i], LIVING_COAL_FLOOR);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MUST HOLD 5 — N overlapping voices sum, then clip
// ═════════════════════════════════════════════════════════════════════════════

// Depth 0.4 is chosen so every voice ALONE stays under the knee (asserted
// below via stats.clipped === 0) — that is what makes each solo run a faithful
// record of that voice's RAW contribution, so summing them is a real reference
// for "sum, then clip". At depth 1 the solo outputs are themselves clipped and
// summing them measures nothing.
const OVERLAP_VOICES = [
  voice('o1', 'areaA', 'swell', { depth: 0.4 }),
  voice('o2', 'areaA', 'trace', { depth: 0.4 }),
  voice('o3', 'areaA', 'glow', { depth: 0.4 }),
  voice('o4', 'areaA', 'ripple', { depth: 0.4 }),
  voice('o5', 'areaA', 'swell', { depth: 0.4, spread: 0 }),
  voice('o6', 'areaA', 'trace', { depth: 0.4, spread: 0.5 }),
];

// The GROUND IS ON for this one, at a level that keeps every pixel clear of
// LIVING_COAL_FLOOR. That matters: the floor is a max(), so it is not
// invertible — at any pixel a solo run left sitting on the floor, that solo's
// raw contribution is unrecoverable and no raw-sum reference could be built
// from it. Keeping every run above the floor (asserted: stats.floored === 0)
// makes each solo target exactly `ground + that voice`, so subtracting the
// ground-only run recovers each voice's raw contribution exactly.
const OVERLAP_GROUND = { enabled: true, level: 0.5, band: 'energy' };

test('N overlapping voices sum into one accumulator, then clip', () => {
  const FRAMES = 45;
  const all = makeRuntime(OVERLAP_VOICES, OVERLAP_GROUND);
  const combined = drive(all, FRAMES, LOUD);

  const groundRun = drive(makeRuntime([], OVERLAP_GROUND), FRAMES, LOUD);
  assert.equal(groundRun.stats.floored, 0,
    'the ground must hold every pixel above the floor, or the reference is not invertible');
  const groundOnly = groundRun.target;

  // Reference: each voice alone over the same ground, in the same order, with
  // that ground subtracted back out so what is summed is the voice itself.
  const reference = Float32Array.from(groundOnly);
  for (const v of OVERLAP_VOICES) {
    const run = drive(makeRuntime([v], OVERLAP_GROUND), FRAMES, LOUD);
    assert.equal(run.stats.clipped, 0,
      `voice ${v.id} must stay under the knee alone, or the reference is not a raw sum`);
    assert.equal(run.stats.floored, 0,
      `voice ${v.id} must stay above the floor, or its raw contribution is unrecoverable`);
    for (let i = 0; i < reference.length; i += 1) reference[i] += run.target[i] - groundOnly[i];
  }

  let sawClip = false;
  for (let i = 0; i < reference.length; i += 1) {
    if (reference[i] > CLIP_KNEE) sawClip = true;
    assert.ok(Math.abs(combined.target[i] - softClip(reference[i])) < 1e-5,
      `pixel ${i}: ensemble ${combined.target[i]} vs softClip(sum) ${softClip(reference[i])}`);
  }
  assert.ok(sawClip, 'the overlap must actually exceed the knee, or this proves nothing');
  assert.equal(combined.stats.floored, 0, 'nothing here needed the floor');
  assert.ok(combined.stats.clipped > 0);
  assert.ok(combined.stats.maxRaw > CLIP_KNEE);

  for (let i = 0; i < combined.target.length; i += 1) {
    assert.ok(combined.target[i] < 1, `pixel ${i} must stay below 1 after clipping`);
  }
});

test('with the ground off, pixels no voice reaches rest on the living-coal floor', () => {
  const combined = drive(makeRuntime(OVERLAP_VOICES, { enabled: false }), 45, LOUD);
  for (const i of [...B_PIXELS, ...C_PIXELS, ...Z_PIXELS]) {
    assert.equal(combined.target[i], LIVING_COAL_FLOOR,
      'no voice reaches these pixels, and with the ground off the floor is all that holds them');
  }
});

test('one quiet voice never reaches the knee, so the authored look is untouched', () => {
  const rt = makeRuntime([voice('v', 'areaA', 'glow', { depth: 0.2 })], { enabled: false });
  const { stats } = drive(rt, 60, LOUD);
  assert.ok(stats.maxRaw <= CLIP_KNEE);
  assert.equal(stats.clipped, 0, 'below the knee nothing is touched at all');
});

// ═════════════════════════════════════════════════════════════════════════════
// palette zones + hysteresis
// ═════════════════════════════════════════════════════════════════════════════

test('zoneChallengeWins requires the challenger to beat the incumbent by the hysteresis margin', () => {
  assert.equal(ZONE_HYSTERESIS, 0.15);
  assert.equal(zoneChallengeWins(1, 1.1), false, 'a 10% lead is not enough');
  assert.equal(zoneChallengeWins(1, 1.15), false, 'exactly the margin is not enough');
  assert.equal(zoneChallengeWins(1, 1.1500001), true);
  assert.equal(zoneChallengeWins(1, 2), true);
  assert.equal(zoneChallengeWins(0, 1e-9), true, 'an unlit incumbent yields immediately');
  assert.equal(zoneChallengeWins(1, 0.5), false);
});

test('a pixel gets its zone from the voice contributing the most there', () => {
  const rt = makeRuntime([
    voice('dim', 'areaA', 'glow', { depth: 0.05, palette: 'dim' }),
    voice('bright', 'areaA', 'glow', { depth: 1, palette: 'bright' }),
  ], { enabled: false });
  drive(rt, 30, LOUD);
  const zones = rt.getVoiceZones();
  const brightZone = zones.zoneNames.indexOf('bright');
  assert.ok(brightZone >= 0);
  for (const i of A_PIXELS) {
    assert.equal(zones.zoneOf[i], brightZone, `pixel ${i} should belong to the brighter voice`);
  }
});

test('pixels no voice owns report the ground zone', () => {
  const rt = makeRuntime([voice('v', 'areaA', 'glow', { palette: 'petal' })], { enabled: true });
  drive(rt, 20, LOUD);
  const zones = rt.getVoiceZones();
  const groundIdx = zones.zoneNames.indexOf('coal');
  assert.ok(groundIdx >= 0);
  for (const i of [...B_PIXELS, ...C_PIXELS, ...Z_PIXELS]) {
    assert.equal(zones.zoneOf[i], groundIdx);
  }
});

// Two voices on the SAME pixels, one riding `energy` and one riding `bass`,
// with the two bands wobbling past each other. Depth 0.6 on the bass voice
// puts the pair close enough in magnitude that a plain argmax crosses often —
// which is exactly the case hysteresis exists for.
const CHURN_A = voice('jade', 'areaA', 'glow', { palette: 'jade' });
const CHURN_B = voice('ember', 'areaA', 'swell', { palette: 'ember', depth: 0.6 });
const CHURN_FRAMES = 1200;
const churnBands = (f) => ({
  bass: 0.5 + 0.45 * Math.sin(f * 0.37),
  mid: 0,
  high: 0,
  energy: 0.5 + 0.45 * Math.sin(f * 0.41 + 1),
  beat: 0,
});

test('hysteresis suppresses the zone churn a plain argmax would produce', () => {
  const probe = A_PIXELS[1];

  // A voice's contribution in the mix is exactly its contribution alone (every
  // kernel only ADDs), so a solo run is a faithful per-frame record of it —
  // provided it never clips, which is asserted.
  const soloSeries = (v) => {
    const rt = makeRuntime([v], { enabled: false });
    const target = new Float32Array(TEMPLATE.length);
    const series = [];
    for (let f = 0; f < CHURN_FRAMES; f += 1) {
      const stats = rt.tickVoices(target, { dt: DT, bands: churnBands(f) });
      assert.equal(stats.clipped, 0, 'solo reference must stay under the knee');
      series.push(target[probe]);
    }
    return series;
  };
  const aSeries = soloSeries(CHURN_A);
  const bSeries = soloSeries(CHURN_B);

  // What a no-hysteresis "whoever is loudest right now" rule would have done.
  let argmaxFlips = 0;
  let previousArgmax = null;
  for (let f = 0; f < CHURN_FRAMES; f += 1) {
    const leader = aSeries[f] >= bSeries[f] ? 0 : 1;
    if (f > 5 && previousArgmax !== null && leader !== previousArgmax) argmaxFlips += 1;
    previousArgmax = leader;
  }

  const rt = makeRuntime([CHURN_A, CHURN_B], { enabled: false });
  const target = new Float32Array(TEMPLATE.length);
  let actualFlips = 0;
  let heldAgainstLeader = 0;
  let previousOwner = null;
  for (let f = 0; f < CHURN_FRAMES; f += 1) {
    rt.tickVoices(target, { dt: DT, bands: churnBands(f) });
    const owner = rt.getVoiceZones().zoneOwner[probe];
    const leader = aSeries[f] >= bSeries[f] ? 0 : 1;
    if (f > 5) {
      if (previousOwner !== null && owner !== previousOwner) actualFlips += 1;
      if (owner !== leader) heldAgainstLeader += 1;
    }
    previousOwner = owner;
  }

  assert.ok(argmaxFlips >= 10,
    `the drive must actually churn a plain argmax, or this proves nothing (saw ${argmaxFlips})`);
  assert.ok(actualFlips <= 2,
    `hysteresis must suppress the churn; saw ${actualFlips} flips against ${argmaxFlips}`);
  assert.ok(heldAgainstLeader >= 20,
    'the incumbent must be observed holding pixels against a marginal leader');
});

test('hysteresis is not a freeze: a decisive change of loudest voice moves the zone', () => {
  const probe = A_PIXELS[1];
  const rt = makeRuntime([CHURN_A, CHURN_B], { enabled: false });
  const target = new Float32Array(TEMPLATE.length);

  for (let f = 0; f < 300; f += 1) {
    rt.tickVoices(target, { dt: DT, bands: { ...SILENT, energy: 1 } });
  }
  const settled = rt.getVoiceZones().zoneOwner[probe];
  assert.equal(settled, 0, 'the energy voice owns the pixel while only energy plays');

  let handedOver = false;
  for (let f = 0; f < 900; f += 1) {
    rt.tickVoices(target, { dt: DT, bands: { ...SILENT, bass: 1 } });
    if (rt.getVoiceZones().zoneOwner[probe] === 1) handedOver = true;
  }
  assert.ok(handedOver, 'the bass voice must take the zone once it is decisively loudest');
});

// ═════════════════════════════════════════════════════════════════════════════
// the locked aesthetic, at ensemble level
// ═════════════════════════════════════════════════════════════════════════════

test('no band value can reach an authored clock through the ensemble', () => {
  const build = () => makeRuntime([
    voice('s', 'areaA', 'swell'),
    voice('t', 'areaB', 'trace'),
    voice('g', 'areaC', 'glow'),
    voice('k', 'areaA', 'twinkle'),
    voice('r', 'areaB', 'ripple'),
  ]);

  const silent = build();
  const loud = build();
  drive(silent, 300, SILENT);
  drive(loud, 300, LOUD);

  for (const id of ['s', 't', 'g', 'k', 'r']) {
    const a = silent.getVoiceDebug(id).clock;
    const b = loud.getVoiceDebug(id).clock;
    assert.ok(Math.abs(a - b) < 1e-9,
      `voice ${id} clock diverged with audio: ${a} vs ${b}`);
  }
});

test('the ensemble source contains no band-to-phase path', () => {
  // The phase a voice hands a kernel is written in exactly one place. If a
  // future edit ever computes it from ctx, this fails.
  const src = createEnsembleRuntime.toString();
  const assignments = src.match(/runtime\.phase\s*=\s*[^;]+/g) || [];
  assert.ok(assignments.length > 0, 'the phase assignment must exist to be checked');
  for (const line of assignments) {
    assert.ok(/instancePhase\(|=\s*0\b/.test(line), `unexpected phase source: ${line}`);
    for (const banned of ['ctx', 'bands', 'bass', 'mid', 'high', 'energy', 'beat', 'env']) {
      assert.ok(!new RegExp(`\\b${banned}\\b`).test(line),
        `phase assignment must not read "${banned}": ${line}`);
    }
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// composition bridging + lifecycle
// ═════════════════════════════════════════════════════════════════════════════

test('a voice naming a character this runtime does not have falls back to the ground character with a warning', () => {
  // showComposition.js's VOICE_CHARACTERS is a modulation-target vocabulary
  // ('amplitude'...), not the instrument vocabulary. See the module header.
  const rt = makeRuntime([voice('v', 'areaA', 'amplitude')]);
  const debug = rt.getVoiceDebug('v');
  assert.equal(debug.characterKey, GROUND_CHARACTER);
  assert.ok(rt.getResolved().warnings.some((w) => w.kind === 'unknown-character' && w.voiceId === 'v'));
});

test('characterKey is honoured ahead of the colliding character field', () => {
  const rt = makeRuntime([voice('v', 'areaA', 'amplitude', { characterKey: 'ripple' })]);
  assert.equal(rt.getVoiceDebug('v').characterKey, 'ripple');
  assert.ok(!rt.getResolved().warnings.some((w) => w.kind === 'unknown-character'));
});

test('setComposition rebuilds voices, bindings and zone state', () => {
  const rt = makeRuntime([voice('v', 'areaA', 'glow', { palette: 'one' })]);
  drive(rt, 20, LOUD);
  assert.equal(rt.getResolved().voices.length, 1);

  rt.setComposition(makeComposition([
    voice('x', 'areaB', 'trace', { palette: 'two' }),
    voice('y', 'areaC', 'swell', { palette: 'three' }),
  ]));
  const resolved = rt.getResolved();
  assert.deepEqual(resolved.voices.map((v) => v.id), ['x', 'y']);
  assert.equal(rt.getVoiceDebug('v'), null);
  assert.equal(rt.getVoiceDebug('x').fold, 6);

  const zones = rt.getVoiceZones();
  assert.ok(zones.zoneOwner.every((o) => o === -1), 'zone ownership resets with the composition');
});

test('setTemplate rebinds against a new layout without throwing', () => {
  const rt = makeRuntime([voice('v', 'areaA', 'glow')]);
  rt.setTemplate([]);
  assert.equal(rt.getResolved().pixelCount, 0);
  const stats = rt.tickVoices(new Float32Array(0), { dt: DT, bands: LOUD });
  assert.equal(stats.pixels, 0);

  rt.setTemplate(TEMPLATE);
  assert.equal(rt.getResolved().pixelCount, TEMPLATE.length);
  const { target } = drive(rt, 20, LOUD);
  assert.ok(A_PIXELS.some((i) => target[i] > 0));
});

test('tickVoices zeroes the accumulator and never mutates the caller ctx', () => {
  const rt = makeRuntime([voice('v', 'areaA', 'glow')], { enabled: false });
  const target = new Float32Array(TEMPLATE.length).fill(0.9);
  const ctx = Object.freeze({ dt: DT, bands: Object.freeze({ ...LOUD }) });
  rt.tickVoices(target, ctx);          // frozen ctx: any write would throw in strict mode
  for (const i of [...B_PIXELS, ...C_PIXELS, ...Z_PIXELS]) {
    assert.equal(target[i], LIVING_COAL_FLOOR,
      'the ground pass FILLS the accumulator; it does not composite (0.9 was overwritten)');
  }
  assert.equal(ctx.dt, DT);
});

test('a runtime built with no composition at all still ticks', () => {
  const rt = createEnsembleRuntime({ template: TEMPLATE });
  const target = new Float32Array(TEMPLATE.length);
  const stats = rt.tickVoices(target, { dt: DT, bands: LOUD });
  assert.equal(stats.voices, 0);
  assert.equal(stats.painted, 0);
  assert.equal(stats.pixels, TEMPLATE.length);
  assert.ok(stats.ground, 'ground defaults to on — the piece is never black');
});

test('a partially-resolved area keeps its authored fold, so surviving instances keep their phase', () => {
  const comp = makeComposition([voice('v', 'areaA', 'trace', { spread: 1 })]);
  // Break two of the four arms by pointing them at strips that do not exist.
  comp.areas[0].instances[1].stripIds = ['gone-1'];
  comp.areas[0].instances[3].stripIds = ['gone-3'];
  const rt = createEnsembleRuntime({ template: TEMPLATE, composition: comp });

  const debug = rt.getVoiceDebug('v');
  assert.equal(debug.fold, 4, 'the authored fold survives a missing copy');
  assert.deepEqual(debug.phases, [0, 0.25, 0.5, 0.75],
    'a gap in the wave, not a re-timed wave');
  assert.ok(rt.getResolved().warnings.some((w) => w.kind === 'partial-area'));

  const { target } = drive(rt, 40, LOUD);
  const lit = pixelsOfStrips(['a0', 'a2']);
  const dark = pixelsOfStrips(['a1', 'a3']);
  assert.ok(lit.some((i) => target[i] > 0));
  const groundOnly = drive(makeRuntime([]), 40, LOUD).target;
  for (const i of dark) {
    assert.ok(Math.abs(target[i] - groundOnly[i]) < 1e-6, 'a missing copy is a silent gap');
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// F2 — PER-VOICE BAND SELECTION
//
// The headline finding: a voice's authored `band` was recorded, displayed and
// then ignored, so two motifs authored to listen to different sounds always
// moved together. These tests assert PIXELS, not plumbing.
// ═════════════════════════════════════════════════════════════════════════════

const sumOver = (target, indices) => indices.reduce((a, i) => a + target[i], 0);

test('F2: two voices of the same character on different bands react to different sounds', () => {
  // Same instrument (glow) on two areas. areaA listens to bass, areaB to high.
  const build = () => makeRuntime([
    voice('lowVoice', 'areaA', 'glow', { band: 'bass', palette: 'low' }),
    voice('highVoice', 'areaB', 'glow', { band: 'high', palette: 'high' }),
  ], { enabled: false });

  const FRAMES = 600;   // 10s: past both envelopes' attack, well inside mood's rise
  const bassPlaying = drive(build(), FRAMES, { ...SILENT, bass: 1 }).target;
  const highPlaying = drive(build(), FRAMES, { ...SILENT, high: 1 }).target;

  const aBass = sumOver(bassPlaying, A_PIXELS);
  const aHigh = sumOver(highPlaying, A_PIXELS);
  const bBass = sumOver(bassPlaying, B_PIXELS);
  const bHigh = sumOver(highPlaying, B_PIXELS);

  // The bass voice's own area is brighter when bass plays than when high does.
  assert.ok(aBass > aHigh * 1.2,
    `areaA is authored on bass: bass-playing ${aBass} must beat high-playing ${aHigh}`);
  // ...and the difference FLIPS for the area authored on high.
  assert.ok(bHigh > bBass * 1.2,
    `areaB is authored on high: high-playing ${bHigh} must beat bass-playing ${bBass}`);

  // Pixels, not sums: individual pixels in each area really do differ.
  assert.ok(A_PIXELS.every((i) => bassPlaying[i] > highPlaying[i] + 1e-4),
    'every pixel of the bass-authored area is brighter under bass');
  assert.ok(B_PIXELS.every((i) => highPlaying[i] > bassPlaying[i] + 1e-4),
    'every pixel of the high-authored area is brighter under high');
});

test('F2: swapping only the band field swaps which area lights, nothing else', () => {
  const run = (bandA, bandB) => drive(makeRuntime([
    voice('one', 'areaA', 'glow', { band: bandA }),
    voice('two', 'areaB', 'glow', { band: bandB }),
  ], { enabled: false }), 600, { ...SILENT, bass: 1 }).target;

  const aOnBass = run('bass', 'high');
  const aOnHigh = run('high', 'bass');

  const dA = sumOver(aOnBass, A_PIXELS) - sumOver(aOnHigh, A_PIXELS);
  const dB = sumOver(aOnBass, B_PIXELS) - sumOver(aOnHigh, B_PIXELS);
  assert.ok(dA > 0, `areaA must be brighter when IT is the bass listener (delta ${dA})`);
  assert.ok(dB < 0, `and areaB must be brighter when the bands are swapped (delta ${dB})`);
});

test('F2: a voice that authors no band keeps its character\'s recommended band', () => {
  // Two glow voices, one on 'bass', one unauthored. Under energy-only audio
  // the unauthored one lights (glow recommends energy) and the bass one does not.
  const rt = makeRuntime([
    voice('authored', 'areaA', 'glow', { band: 'bass' }),
    voice('unauthored', 'areaB', 'glow'),
  ], { enabled: false });
  assert.equal(rt.getVoiceDebug('authored').listensTo, 'bass');
  assert.equal(rt.getVoiceDebug('unauthored').listensTo, null,
    'null means "use the character\'s own recommendation"');

  const { target } = drive(rt, 600, { ...SILENT, energy: 1 });
  const perA = sumOver(target, A_PIXELS) / A_PIXELS.length;
  const perB = sumOver(target, B_PIXELS) / B_PIXELS.length;
  assert.ok(perB > perA * 1.2,
    `the unauthored voice follows glow's own 'energy' band (${perB}) while the `
    + `bass-authored one stays dark (${perA})`);
});

test('F2: band "none" is not a band — it falls back to the character default', () => {
  const rt = makeRuntime([voice('v', 'areaA', 'glow', { band: 'none' })], { enabled: false });
  assert.equal(rt.getVoiceDebug('v').listensTo, null);
  const { target } = drive(rt, 300, { ...SILENT, energy: 1 });
  assert.ok(sumOver(target, A_PIXELS) / A_PIXELS.length > LIVING_COAL_FLOOR * 2,
    'a voice authored to "none" still plays on its character band, it does not go silent');
});

test('F2: a band this audio source does not produce falls back instead of going silent', () => {
  const rt = makeRuntime([voice('v', 'areaA', 'glow', { band: 'beat' })], { enabled: false });
  assert.equal(rt.getVoiceDebug('v').listensTo, 'beat');
  // A source that only emits `energy` — no beat key at all.
  const target = new Float32Array(TEMPLATE.length);
  for (let f = 0; f < 300; f += 1) rt.tickVoices(target, { dt: DT, bands: { energy: 1 } });
  assert.ok(sumOver(target, A_PIXELS) / A_PIXELS.length > LIVING_COAL_FLOOR * 2,
    'the voice degrades to its character band, not to darkness');
});

test('F2: the resolved band is reported, so a picker can show what a voice hears', () => {
  const rt = makeRuntime([
    voice('a', 'areaA', 'swell', { band: 'high' }),
    voice('b', 'areaB', 'trace'),
  ], { enabled: false });
  const listed = rt.getResolved().voices;
  assert.equal(listed.find((v) => v.id === 'a').listensTo, 'high');
  assert.equal(listed.find((v) => v.id === 'b').listensTo, null);
});

// ═════════════════════════════════════════════════════════════════════════════
// F8 — "NEVER BLACK" IS ENFORCED, NOT AUTHORED
//
// Turning the ground layer off used to allow hard zero, and even with the
// ground on at its default, silence landed near 0.017 (~4/255) — visually
// black. The floor is applied last, every frame, and no setting defeats it.
// ═════════════════════════════════════════════════════════════════════════════

test('F8: the living-coal floor is a real, visible value', () => {
  assert.equal(LIVING_COAL_FLOOR, 0.0390625, '5/128 — exact in a float32 accumulator');
  assert.equal(Math.fround(LIVING_COAL_FLOOR), LIVING_COAL_FLOOR,
    'the floor must survive the Float32Array accumulator unchanged');
  assert.ok(Math.round(LIVING_COAL_FLOOR * 255) >= 10,
    'the floor must be a visible ember, not a technically-non-zero black');
});

test('F8: silence never goes below the floor — with the ground ON', () => {
  const rt = makeRuntime([voice('v', 'areaA', 'swell')], { enabled: true, level: 0.12 });
  const { target } = drive(rt, 1200, SILENT);   // 20s of silence
  let min = Infinity;
  for (let i = 0; i < target.length; i += 1) min = Math.min(min, target[i]);
  assert.ok(min >= LIVING_COAL_FLOOR,
    `the dimmest pixel was ${min}, below the floor ${LIVING_COAL_FLOOR}`);
  // The default ground level alone would have landed near 0.017 here — the
  // floor is doing real work, not decorating a value that already cleared it.
  assert.ok(min < 0.08, 'and it is still a dim coal bed, not a lit piece');
});

test('F8: silence never goes below the floor — with the ground OFF', () => {
  // ground.enabled: false is a legitimate authoring choice. It is not a way
  // to make the piece go black.
  const rt = makeRuntime([voice('v', 'areaA', 'swell')], { enabled: false });
  const { target, stats } = drive(rt, 1200, SILENT);
  let min = Infinity;
  for (let i = 0; i < target.length; i += 1) min = Math.min(min, target[i]);
  assert.equal(stats.ground, false, 'the ground really is off');
  assert.equal(min, LIVING_COAL_FLOOR,
    `with no ground at all the floor must hold every pixel, saw ${min}`);
  assert.ok(stats.floored > 0, 'and the runtime reports that it floored pixels');
});

test('F8: the floor holds with no composition, no template pixels lit, nothing at all', () => {
  const rt = createEnsembleRuntime({
    template: TEMPLATE,
    composition: { ground: { enabled: false }, fields: [], areas: [], voices: [] },
  });
  const target = new Float32Array(TEMPLATE.length);
  rt.tickVoices(target, { dt: DT, bands: SILENT });
  for (let i = 0; i < target.length; i += 1) {
    assert.equal(target[i], LIVING_COAL_FLOOR, `pixel ${i} went black`);
  }
});

test('F8: the floor never dims a pixel that is already brighter', () => {
  const rt = makeRuntime([voice('v', 'areaA', 'glow')], { enabled: true, level: 0.5 });
  const { target } = drive(rt, 120, LOUD);
  assert.ok(A_PIXELS.every((i) => target[i] > LIVING_COAL_FLOOR * 3),
    'a lit voice is far above the floor and untouched by it');
  assert.ok(target.every((v) => v <= 1), 'and the floor never pushes anything past full');
});

// --- Live-edit continuity -------------------------------------------------
// Dragging a slider in the Show screen calls setComposition() on every frame.
// If that handed each voice a fresh runtime, its authored clock would restart
// and its envelope drop to zero mid-drag, so the piece would visibly dip while
// the owner was still dragging. These assert it does not.
test('editing a voice mid-drag preserves its clock and envelope', () => {
  const rt = makeRuntime(OVERLAP_VOICES, OVERLAP_GROUND);
  drive(rt, 60, LOUD);

  const before = OVERLAP_VOICES.map((v) => {
    const d = rt.getVoiceDebug(v.id);
    return { id: v.id, clock: d.clock, level: d.env };
  });
  assert.ok(before.some((b) => b.clock > 0), 'the clocks really did advance first');

  // Exactly the call a depth drag makes: same voices, same instruments, new depth.
  rt.setComposition(makeComposition(
    OVERLAP_VOICES.map((v) => ({ ...v, depth: 0.42 })),
    OVERLAP_GROUND,
  ));

  for (const prev of before) {
    const now = rt.getVoiceDebug(prev.id);
    assert.ok(now, `voice ${prev.id} survived the edit`);
    assert.equal(now.clock, prev.clock, `voice ${prev.id} kept its authored clock`);
    assert.equal(now.env, prev.level, `voice ${prev.id} kept its smoothed level`);
    assert.equal(now.depth, 0.42, `voice ${prev.id} did take the new depth`);
  }
});

test('the piece does not dip on the frame a live edit lands', () => {
  const rt = makeRuntime(OVERLAP_VOICES, OVERLAP_GROUND);
  drive(rt, 60, LOUD);
  const settled = drive(rt, 1, LOUD).target.reduce((a, b) => a + b, 0);

  rt.setComposition(makeComposition(OVERLAP_VOICES, OVERLAP_GROUND));
  const afterEdit = drive(rt, 1, LOUD).target.reduce((a, b) => a + b, 0);

  // The same composition re-applied: the very next frame must look the same.
  assert.ok(Math.abs(afterEdit - settled) < settled * 0.02,
    `re-applying an identical composition dipped the piece: ${settled.toFixed(2)} -> ${afterEdit.toFixed(2)}`);
});

test('changing a voice instrument does start that voice fresh', () => {
  const rt = makeRuntime(OVERLAP_VOICES, OVERLAP_GROUND);
  drive(rt, 60, LOUD);

  const first = OVERLAP_VOICES[0];
  const swapped = first.character === 'glow' ? 'trace' : 'glow';
  rt.setComposition(makeComposition(
    OVERLAP_VOICES.map((v) => (v.id === first.id ? { ...v, character: swapped } : v)),
    OVERLAP_GROUND,
  ));

  const now = rt.getVoiceDebug(first.id);
  assert.ok(now, 'the retyped voice still exists');
  assert.equal(now.clock, 0, 'a genuinely different instrument starts from zero');
});
