import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lerp, clamp01, clamp, smoothstep, hash01, arcGate, smoothAR, onePole,
  createDensityHelpers,
} from './mandalaMath.js';

test('lerp interpolates linearly, including outside 0..1', () => {
  assert.equal(lerp(0, 10, 0), 0);
  assert.equal(lerp(0, 10, 1), 10);
  assert.equal(lerp(0, 10, 0.5), 5);
  assert.equal(lerp(10, 0, 0.25), 7.5);
  assert.equal(lerp(0, 10, 2), 20); // not clamped — caller's job
});

test('clamp01 clamps to [0,1]', () => {
  assert.equal(clamp01(-5), 0);
  assert.equal(clamp01(5), 1);
  assert.equal(clamp01(0.42), 0.42);
  assert.equal(clamp01(0), 0);
  assert.equal(clamp01(1), 1);
});

test('clamp clamps to an arbitrary range', () => {
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(15, 0, 10), 10);
  assert.equal(clamp(4, 0, 10), 4);
});

test('smoothstep eases with zero-slope endpoints and is monotonic', () => {
  assert.equal(smoothstep(-1), 0);
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(1), 1);
  assert.equal(smoothstep(2), 1);
  assert.equal(smoothstep(0.5), 0.5);
  let prev = -1;
  for (let x = 0; x <= 1.0001; x += 0.05) {
    const v = smoothstep(x);
    assert.ok(v >= prev - 1e-12, `smoothstep should be monotonic near x=${x}`);
    prev = v;
  }
});

test('hash01 is deterministic and stays in [0,1)', () => {
  const a = hash01(17, 4);
  const b = hash01(17, 4);
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 1);
  // different inputs are (almost always) different outputs
  const c = hash01(18, 4);
  assert.notEqual(a, c);
});

test('hash01 covers a spread of values, not a constant', () => {
  const seen = new Set();
  for (let i = 0; i < 64; i++) seen.add(Math.round(hash01(i, 1) * 1000));
  assert.ok(seen.size > 40, `expected a spread of hash values, got ${seen.size} distinct buckets`);
});

test('arcGate is 1 at a lobe center and fades toward its edge', () => {
  // 4 lobes, spin 0: lobe centers sit at angle = k * (2π/4)
  const center = arcGate(0, 4, 0.5, 0);
  assert.ok(center > 0.9, `expected near-1 at lobe center, got ${center}`);
  const edge = arcGate(Math.PI / 4, 4, 0.5, 0); // halfway between two lobe centers
  assert.ok(edge < center, 'edge should be dimmer than center');
});

test('arcGate output always stays within [0,1]', () => {
  for (let a = 0; a < Math.PI * 2; a += 0.3) {
    for (const nLobes of [1, 2, 3, 6, 8]) {
      for (const width of [0.1, 0.5, 1, 2]) {
        const v = arcGate(a, nLobes, width, 0.37);
        assert.ok(v >= 0 && v <= 1, `arcGate(${a},${nLobes},${width}) = ${v} out of range`);
      }
    }
  }
});

test('smoothAR: attack uses tauA when rising, release uses tauR when falling', () => {
  // rising: env starts below x -> should move using tauA (fast)
  let envFast = smoothAR(0, 1, 0.1, 10, 0.05);
  let envSlowAttack = smoothAR(0, 1, 10, 10, 0.05);
  assert.ok(envFast > envSlowAttack, 'a short attack tau should move faster toward a rising target');

  // falling: env starts above x -> should move using tauR
  let fallFast = smoothAR(1, 0, 10, 0.1, 0.05);
  let fallSlowRelease = smoothAR(1, 0, 10, 10, 0.05);
  assert.ok(fallFast < fallSlowRelease, 'a short release tau should fall faster toward a dropping target');
});

test('smoothAR converges to the target over many ticks and never overshoots', () => {
  let env = 0;
  for (let i = 0; i < 500; i++) env = smoothAR(env, 1, 0.05, 1, 0.016);
  assert.ok(Math.abs(env - 1) < 1e-6, `expected convergence to 1, got ${env}`);
  assert.ok(env <= 1 + 1e-9, 'smoothAR should not overshoot its target');
});

test('smoothAR is frame-rate independent: one big dt matches many small dts summing to the same elapsed time', () => {
  const tauA = 0.1, tauR = 0.1;
  const elapsed = 0.1; // total seconds simulated both ways
  const bigStep = smoothAR(0, 1, tauA, tauR, elapsed);

  let small = 0;
  const n = 50;
  for (let i = 0; i < n; i++) small = smoothAR(small, 1, tauA, tauR, elapsed / n);

  assert.ok(
    Math.abs(bigStep - small) < 1e-3,
    `expected one big dt (${bigStep}) to land near many small dts summing to the same time (${small})`,
  );
});

test('smoothAR never snaps the full distance in a single step, however large dt is', () => {
  // Before the fix, dt far larger than tau saturated the linear
  // coefficient at 1 and jumped straight to the target. The exponential
  // formulation (plus the MAX_SMOOTHING_DT clamp) must never reach exactly
  // the target in one step, even for a multi-second stall.
  for (const dt of [1, 5, 60, 1e6]) {
    const env = smoothAR(0, 1, 0.1, 0.1, dt);
    assert.ok(env < 1, `a single step with dt=${dt} should not fully snap to the target, got ${env}`);
  }
});

test('smoothAR: dt sanitizing guards against a broken timer driving the envelope out of range', () => {
  // Non-finite, negative, or absurd dt must never push env past the
  // span between its current value and the target (e.g. negative
  // brightness), and never throw.
  assert.equal(smoothAR(0.5, 1, 0.1, 0.1, NaN), 0.5, 'NaN dt should not move env');
  assert.equal(smoothAR(0.5, 1, 0.1, 0.1, -1), 0.5, 'negative dt should not move env');
  assert.equal(smoothAR(0.5, 1, 0.1, 0.1, Infinity) <= 1, true, 'Infinity dt should still clamp to at most the target');
  assert.ok(smoothAR(0.5, 1, 0.1, 0.1, Infinity) >= 0.5, 'Infinity dt should not undershoot below the starting env');
});

test('onePole uses the same tau rising and falling', () => {
  const up = onePole(0, 1, 2, 0.1);
  const down = onePole(1, 0, 2, 0.1);
  // symmetric: distance traveled toward the target should be identical
  assert.ok(Math.abs(up - (1 - down)) < 1e-9, 'onePole should move the same fraction toward its target either direction');
});

test('createDensityHelpers reads the live detail value, not a snapshot', () => {
  let detail = 1;
  const { dLobes, dWide } = createDensityHelpers(() => detail);

  assert.equal(dLobes(6, 2), 6); // full detail -> authored value
  assert.equal(dWide(0.8, 0.2), 0.8);

  detail = 0; // sparsest
  assert.equal(dLobes(6, 2), Math.max(2, Math.round(6 * 0.4))); // floored, not zero
  assert.equal(dWide(0.8, 0.2), 0.2); // eases all the way to `sparse`

  detail = 0.5;
  assert.equal(dLobes(6, 2), Math.max(2, Math.round(6 * 0.7)));
  assert.ok(Math.abs(dWide(0.8, 0.2) - (0.2 + 0.6 * 0.5)) < 1e-9);
});

test('createDensityHelpers dLobes never drops below the floor', () => {
  let detail = 0;
  const { dLobes } = createDensityHelpers(() => detail);
  assert.equal(dLobes(1, 3), 3); // authored value tiny, floor wins
});

test('createDensityHelpers instances are independent (two engines, two detail signals)', () => {
  let detailA = 1, detailB = 0;
  const helpersA = createDensityHelpers(() => detailA);
  const helpersB = createDensityHelpers(() => detailB);
  assert.equal(helpersA.dLobes(6, 2), 6);
  assert.equal(helpersB.dLobes(6, 2), Math.max(2, Math.round(6 * 0.4)));
});
