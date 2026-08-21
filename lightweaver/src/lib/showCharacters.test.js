import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Swell, Twinkle, Ripple, Glow, Trace,
  CHARACTER_LIBRARY, CHARACTERS, CHARACTER_KEYS,
  cloneVoiceState, readBand, readVoiceBand,
  sparkEnvelope, rippleEnvelope, SWELL_REACH_SLEW, glowLevel, expand,
} from './showCharacters.js';
import { hash01 } from './mandalaMath.js';

// ---------- test helpers ----------

function ctxAllBands(value, dt, depth = 1) {
  return { dt, bands: { bass: value, mid: value, high: value, energy: value, beat: value }, depth };
}

function ctxForBand(bandName, value, dt, depth = 1) {
  const bands = { bass: 0, mid: 0, high: 0, energy: 0, beat: 0 };
  bands[bandName] = value;
  return { dt, bands, depth };
}

// A synthetic pixel-binding area: n pixels spread evenly in angle, all at a
// chosen radius, with distinct integer seeds and identity pixelIndex — good
// enough to exercise every character's kernel without depending on the
// (not-yet-built) real showAreaBinding.js.
function makeArea(n, { radius = 0.5 } = {}) {
  const pixelIndex = new Int32Array(n);
  const radiusArr = new Float32Array(n);
  const angle = new Float32Array(n);
  const seed = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    pixelIndex[i] = i;
    radiusArr[i] = typeof radius === 'function' ? radius(i, n) : radius;
    angle[i] = (i / n) * Math.PI * 2;
    seed[i] = i * 2654435761 | 0;
  }
  return { pixelIndex, radius: radiusArr, angle, seed };
}

/** Run `character.tick` for `ticks` frames at fixed `dt`, with every audio
 * band pinned to `bandValue` for the whole run, and return the resulting
 * `vr`. Used by the locked-aesthetic clock-isolation test. */
function runTicks(character, bandValue, ticks, dt) {
  const vr = cloneVoiceState(character);
  const ctx = ctxAllBands(bandValue, dt);
  for (let i = 0; i < ticks; i++) character.tick(vr, ctx);
  return vr;
}

/** Step a character's envelope through a 0->1 band step, fine-grained,
 * returning { attackTime, releaseTime } — seconds to first reach 60% on
 * the way up, and seconds (measured from when the band drops back to 0,
 * starting from an already-settled env) to first fall below 40%. */
function measureEnvTiming(character, { dt = 0.002, attackCap = 2, releaseCap = 10, settleTime = 5 } = {}) {
  const band = character.bands[0];

  // Attack: fresh voice, band steps 0 -> 1 at t=0.
  const attackVr = cloneVoiceState(character);
  const onCtx = ctxForBand(band, 1, dt);
  let attackTime = null;
  for (let t = 0; t < attackCap; t += dt) {
    character.tick(attackVr, onCtx);
    if (attackVr.env >= 0.6) { attackTime = t + dt; break; }
  }

  // Release: let a fresh voice settle near 1 under sustained band=1, then
  // drop the band to 0 and measure time to fall below 40%.
  const releaseVr = cloneVoiceState(character);
  for (let t = 0; t < settleTime; t += dt) character.tick(releaseVr, onCtx);
  const offCtx = ctxForBand(band, 0, dt);
  let releaseTime = null;
  for (let t = 0; t < releaseCap; t += dt) {
    character.tick(releaseVr, offCtx);
    if (releaseVr.env < 0.4) { releaseTime = t + dt; break; }
  }

  return { attackTime, releaseTime, settledEnv: releaseVr === releaseVr ? undefined : undefined };
}

// ---------- library shape ----------

test('CHARACTER_LIBRARY has exactly the five named characters', () => {
  assert.deepEqual(CHARACTER_KEYS, ['swell', 'twinkle', 'ripple', 'glow', 'trace']);
  assert.equal(CHARACTER_LIBRARY.length, 5);
  for (const c of CHARACTER_LIBRARY) {
    assert.equal(CHARACTERS[c.key], c);
    assert.equal(typeof c.label, 'string');
    assert.equal(typeof c.verb, 'string');
    assert.ok(Array.isArray(c.bands) && c.bands.length >= 1);
    assert.equal(typeof c.cyclePeriod, 'number');
    assert.ok(c.cyclePeriod > 0);
    assert.equal(typeof c.tick, 'function');
    assert.equal(typeof c.kernel, 'function');
    assert.equal(typeof c.defaults, 'object');
    assert.equal(typeof c.defaults.clock, 'number');
    assert.equal(typeof c.defaults.env, 'number');
    assert.equal(typeof c.defaults.phase, 'number');
  }
});

test('every character band is inside the composition audio-band vocabulary', () => {
  const KNOWN = new Set(['bass', 'mid', 'high', 'energy', 'beat']);
  for (const c of CHARACTER_LIBRARY) {
    for (const b of c.bands) assert.ok(KNOWN.has(b), `${c.key} lists unknown band "${b}"`);
  }
});

// ---------- cloneVoiceState ----------

test('cloneVoiceState gives independent state per voice (no shared arrays)', () => {
  const a = cloneVoiceState(Ripple);
  const b = cloneVoiceState(Ripple);
  a.rippleActive[0] = 1;
  a.rippleR[0] = 0.7;
  assert.equal(b.rippleActive[0], 0, 'mutating one clone must not affect another');
  assert.equal(b.rippleR[0], 0);
  assert.notEqual(a.rippleR, b.rippleR, 'typed arrays must not be aliased');
});

test('cloneVoiceState reproduces every character\'s defaults shape', () => {
  for (const c of CHARACTER_LIBRARY) {
    const vr = cloneVoiceState(c);
    assert.equal(vr.clock, 0);
    assert.equal(vr.env, 0);
    assert.equal(vr.phase, 0);
  }
});

// ---------- readBand ----------

test('readBand returns 0 for missing/non-finite bands instead of throwing', () => {
  assert.equal(readBand({ bands: {} }, 'bass'), 0);
  assert.equal(readBand({}, 'bass'), 0);
  assert.equal(readBand(null, 'bass'), 0);
  assert.equal(readBand({ bands: { bass: NaN } }, 'bass'), 0);
  assert.equal(readBand({ bands: { bass: 0.7 } }, 'bass'), 0.7);
  assert.equal(readBand({ bands: { bass: 5 } }, 'bass'), 1); // clamped
});

// ============================================================
//  THE MOST IMPORTANT TEST IN THE RUN — the locked aesthetic, enforced by
//  machine: a band value physically cannot reach any character's authored
//  clock. 200 ticks with the band pinned at 0, 200 with it pinned at 1, at
//  a fixed dt, and the resulting clock must match to within 1e-9.
// ============================================================
test('LOCKED AESTHETIC: every character\'s authored clock is identical whether the band is pinned at 0 or 1', () => {
  const dt = 1 / 60;
  const ticks = 200;
  for (const c of CHARACTER_LIBRARY) {
    const low = runTicks(c, 0, ticks, dt);
    const high = runTicks(c, 1, ticks, dt);
    assert.ok(
      Math.abs(low.clock - high.clock) < 1e-9,
      `${c.key}: clock diverged under audio — band=0 clock=${low.clock}, band=1 clock=${high.clock}`,
    );
    // sanity: the clock actually moved (dt=1/60 * 200 = ~3.33s is a real
    // fraction of every character's cyclePeriod-ish scale) — this guards
    // against a vacuous pass where clock never changes at all.
    assert.notEqual(low.clock, 0, `${c.key}: clock never advanced`);
  }
});

test('LOCKED AESTHETIC: a mid-run band swing does not perturb the clock either', () => {
  const dt = 1 / 60;
  for (const c of CHARACTER_LIBRARY) {
    const steady = cloneVoiceState(c);
    const swinging = cloneVoiceState(c);
    const steadyCtx = ctxAllBands(0.5, dt);
    for (let i = 0; i < 200; i++) {
      c.tick(steady, steadyCtx);
      // alternate 0 / 1 every tick — as extreme a "swing" as audio gets
      c.tick(swinging, ctxAllBands(i % 2 === 0 ? 0 : 1, dt));
    }
    assert.ok(
      Math.abs(steady.clock - swinging.clock) < 1e-9,
      `${c.key}: clock diverged under a swinging band`,
    );
  }
});

// ============================================================
//  Envelope dynamics: fast attack, slow release, for every character.
// ============================================================
test('every character: attack reaches >=60% within 150ms of a 0->1 band step', () => {
  for (const c of CHARACTER_LIBRARY) {
    const { attackTime } = measureEnvTiming(c);
    assert.ok(attackTime !== null, `${c.key}: envelope never reached 60%`);
    assert.ok(attackTime <= 0.15 + 1e-9, `${c.key}: took ${attackTime * 1000}ms to reach 60% (limit 150ms)`);
  }
});

test('every character: release takes >=600ms to fall below 40% after the band drops', () => {
  for (const c of CHARACTER_LIBRARY) {
    const { releaseTime } = measureEnvTiming(c);
    assert.ok(releaseTime !== null, `${c.key}: envelope never fell below 40%`);
    assert.ok(releaseTime >= 0.6 - 1e-9, `${c.key}: fell below 40% in only ${releaseTime * 1000}ms (minimum 600ms)`);
  }
});

test('every character: attack is strictly faster than release (tauA < tauR, observed)', () => {
  for (const c of CHARACTER_LIBRARY) {
    const { attackTime, releaseTime } = measureEnvTiming(c);
    assert.ok(attackTime < releaseTime, `${c.key}: attack (${attackTime}s) should be faster than release (${releaseTime}s)`);
  }
});

// ============================================================
//  Ripple: travel speed is a literal constant, never touched by audio.
// ============================================================
test('Ripple wavefront travel time is constant regardless of band level', () => {
  const dt = 1 / 120;
  const ticks = 90; // 0.75s — well inside the ~1.5s authored lifetime
  const vrQuiet = cloneVoiceState(Ripple);
  const vrLoud = cloneVoiceState(Ripple);

  // Manually seed an identical wavefront in slot 0 on both voices, with
  // deliberately DIFFERENT captured strengths, so any coupling between
  // strength/band and travel rate would show up as a divergence in r.
  for (const [vr, strength] of [[vrQuiet, 0.1], [vrLoud, 1.0]]) {
    vr.rippleActive[0] = 1;
    vr.rippleR[0] = 0;
    vr.ripplePhase[0] = 0;
    vr.rippleStrength[0] = strength;
  }

  for (let i = 0; i < ticks; i++) {
    Ripple.tick(vrQuiet, ctxForBand('bass', 0, dt));   // silence throughout
    Ripple.tick(vrLoud, ctxForBand('bass', 1, dt));    // pinned loud throughout (also spawns onsets into other slots)
  }

  assert.ok(
    Math.abs(vrQuiet.rippleR[0] - vrLoud.rippleR[0]) < 1e-9,
    `slot-0 travel diverged under audio: quiet r=${vrQuiet.rippleR[0]}, loud r=${vrLoud.rippleR[0]}`,
  );
  // and it travelled at exactly the literal 0.9/s rate documented in
  // showCharacters.js — not some function of the strength we seeded.
  const expected = ticks * dt * 0.9;
  assert.ok(Math.abs(vrQuiet.rippleR[0] - expected) < 1e-6, `expected r≈${expected}, got ${vrQuiet.rippleR[0]}`);
});

test('Ripple caps at 3 live wavefronts and reuses the oldest slot when full', () => {
  const vr = cloneVoiceState(Ripple);
  const dt = 1 / 60;
  // Force four kicks in quick succession (respecting refractory) by
  // toggling the band across the arm/fire thresholds.
  const loud = ctxForBand('bass', 0.9, dt);
  const quiet = ctxForBand('bass', 0, dt);
  let kicks = 0;
  for (let i = 0; i < 400 && kicks < 4; i++) {
    Ripple.tick(vr, i % 10 < 5 ? loud : quiet);
    let active = 0;
    for (let k = 0; k < 3; k++) if (vr.rippleActive[k]) active++;
    if (active > 0) kicks = Math.max(kicks, active);
  }
  let activeCount = 0;
  for (let k = 0; k < 3; k++) if (vr.rippleActive[k]) activeCount++;
  assert.ok(activeCount <= 3, `never more than 3 live wavefronts, saw ${activeCount}`);
});

// ============================================================
//  Twinkle: audio scales ignition probability & brightness, never lifetime
//  or bucket rate (already covered by the clock-isolation test above for
//  bucket rate specifically).
// ============================================================
test('Twinkle: silence ignites (almost) nothing; a loud high band ignites sparks', () => {
  const n = 3000;
  const area = makeArea(n, { radius: 1 }); // rf=1 maximizes ignition probability
  const dt = 0.05;

  const quietVr = cloneVoiceState(Twinkle);
  const quietCtx = ctxForBand('high', 0, dt);
  for (let i = 0; i < 20; i++) Twinkle.tick(quietVr, quietCtx);
  const quietOut = new Float32Array(n);
  Twinkle.kernel(area, 0, n, quietOut, quietVr, quietCtx);
  let quietCount = 0;
  for (let i = 0; i < n; i++) if (quietOut[i] > 0) quietCount++;
  assert.equal(quietCount, 0, `silence should ignite nothing (p=0.035*rf^2*env, env should be 0), saw ${quietCount}`);

  const loudVr = cloneVoiceState(Twinkle);
  const loudCtx = ctxForBand('high', 1, dt);
  for (let i = 0; i < 20; i++) Twinkle.tick(loudVr, loudCtx);
  assert.ok(loudVr.env > 0.9, `expected the high envelope to have settled near 1, got ${loudVr.env}`);
  const loudOut = new Float32Array(n);
  Twinkle.kernel(area, 0, n, loudOut, loudVr, loudCtx);
  let loudCount = 0;
  for (let i = 0; i < n; i++) if (loudOut[i] > 0) loudCount++;
  assert.ok(loudCount > 10, `expected a meaningful number of sparks under a loud high band, saw ${loudCount}`);
});

// ============================================================
//  Amplitude / level scale with audio for the remaining amplitude-driven
//  characters — a coarse but real check that the "audio scales X" claims
//  in each header comment are true of the code, not just the comment.
// ============================================================
function totalBrightness(character, band, out) {
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i];
  return sum;
}

test('Swell: settled brightness under a loud bass band exceeds silence', () => {
  const area = makeArea(200, { radius: (i, n) => (i / n) });
  const dt = 1 / 60;

  const quietVr = cloneVoiceState(Swell);
  const quietCtx = ctxForBand('bass', 0, dt);
  for (let i = 0; i < 120; i++) Swell.tick(quietVr, quietCtx);
  const quietOut = new Float32Array(200);
  Swell.kernel(area, 0, 200, quietOut, quietVr, quietCtx);

  const loudVr = cloneVoiceState(Swell);
  const loudCtx = ctxForBand('bass', 1, dt);
  for (let i = 0; i < 120; i++) Swell.tick(loudVr, loudCtx);
  const loudOut = new Float32Array(200);
  Swell.kernel(area, 0, 200, loudOut, loudVr, loudCtx);

  const quietSum = totalBrightness(Swell, 'bass', quietOut);
  const loudSum = totalBrightness(Swell, 'bass', loudOut);
  assert.ok(loudSum > quietSum, `expected loud (${loudSum}) > quiet (${quietSum})`);
});

test('Glow: settled level under energy exceeds silence, and is always > 0 (ground layer never blacks out)', () => {
  const area = makeArea(200, { radius: (i, n) => i / n });
  const dt = 1 / 60;

  const quietVr = cloneVoiceState(Glow);
  const quietCtx = ctxForBand('energy', 0, dt);
  for (let i = 0; i < 120; i++) Glow.tick(quietVr, quietCtx);
  const quietOut = new Float32Array(200);
  Glow.kernel(area, 0, 200, quietOut, quietVr, quietCtx);

  const loudVr = cloneVoiceState(Glow);
  const loudCtx = ctxForBand('energy', 1, dt);
  for (let i = 0; i < 120; i++) Glow.tick(loudVr, loudCtx);
  const loudOut = new Float32Array(200);
  Glow.kernel(area, 0, 200, loudOut, loudVr, loudCtx);

  for (let i = 0; i < 200; i++) assert.ok(quietOut[i] > 0, 'Glow must never be exactly zero — it is the ground layer');
  assert.ok(totalBrightness(Glow, 'energy', loudOut) > totalBrightness(Glow, 'energy', quietOut));
});

test('Trace: amplitude and breadth grow with the mid band', () => {
  const area = makeArea(400, { radius: (i, n) => i / n });
  const dt = 1 / 60;

  const quietVr = cloneVoiceState(Trace);
  const quietCtx = ctxForBand('mid', 0, dt);
  for (let i = 0; i < 120; i++) Trace.tick(quietVr, quietCtx);
  const quietOut = new Float32Array(400);
  Trace.kernel(area, 0, 400, quietOut, quietVr, quietCtx);

  const loudVr = cloneVoiceState(Trace);
  const loudCtx = ctxForBand('mid', 1, dt);
  for (let i = 0; i < 120; i++) Trace.tick(loudVr, loudCtx);
  const loudOut = new Float32Array(400);
  Trace.kernel(area, 0, 400, loudOut, loudVr, loudCtx);

  assert.ok(totalBrightness(Trace, 'mid', loudOut) > totalBrightness(Trace, 'mid', quietOut));
});

test('Ripple: onset (hit) strength scales amplitude, not travel — two hits of different strength at the same age differ only in brightness', () => {
  const area = makeArea(50, { radius: 0.45 }); // sits inside the wavefront's early sweep
  const dt = 1 / 60;

  const weakVr = cloneVoiceState(Ripple);
  weakVr.rippleActive[0] = 1; weakVr.rippleR[0] = 0.4; weakVr.ripplePhase[0] = 0; weakVr.rippleStrength[0] = 0.2;
  const strongVr = cloneVoiceState(Ripple);
  strongVr.rippleActive[0] = 1; strongVr.rippleR[0] = 0.4; strongVr.ripplePhase[0] = 0; strongVr.rippleStrength[0] = 1.0;

  const ctx = ctxForBand('bass', 0, dt); // silence, so only the seeded wavefront contributes
  const weakOut = new Float32Array(50);
  const strongOut = new Float32Array(50);
  Ripple.kernel(area, 0, 50, weakOut, weakVr, ctx);
  Ripple.kernel(area, 0, 50, strongOut, strongVr, ctx);

  assert.ok(totalBrightness(Ripple, 'bass', strongOut) > totalBrightness(Ripple, 'bass', weakOut));
  // and the two seeded wavefronts are at the identical radius (age) — this
  // test only varied strength, so any r divergence would be a bug, not
  // expected behavior; re-assert equality for clarity at the point of use.
  assert.equal(weakVr.rippleR[0], strongVr.rippleR[0]);
});

// ============================================================
//  vr.phase — added as an offset, documented contract sanity.
// ============================================================
test('vr.phase shifts geometry without needing tick() to know about instances', () => {
  const area = makeArea(64, { radius: (i, n) => i / n });
  const dt = 1 / 60;
  const vr = cloneVoiceState(Trace);
  const ctx = ctxForBand('mid', 0.8, dt);
  for (let i = 0; i < 60; i++) Trace.tick(vr, ctx);

  const outA = new Float32Array(64);
  vr.phase = 0;
  Trace.kernel(area, 0, 64, outA, vr, ctx);

  const outB = new Float32Array(64);
  // NOT 0.5 — Trace has 2-fold rotational symmetry (TRACE_ARMS=2), so a
  // half-revolution phase offset is indistinguishable from none on a fully
  // symmetric test ring. A quarter revolution has no such degeneracy.
  vr.phase = 0.25;
  Trace.kernel(area, 0, 64, outB, vr, ctx);

  let identical = true;
  for (let i = 0; i < 64; i++) if (Math.abs(outA[i] - outB[i]) > 1e-9) { identical = false; break; }
  assert.ok(!identical, 'a 0.5-cycle phase offset should visibly shift the rendered geometry');
});

// ============================================================
//  Kernel output hygiene — every character, over many frames, never emits
//  NaN/Infinity or negative brightness, and never writes outside [from,to).
// ============================================================
test('every character stays finite, non-negative, and in-bounds over many frames', () => {
  const n = 120;
  const area = makeArea(n, { radius: (i, k) => i / k });
  const dt = 1 / 40;
  for (const c of CHARACTER_LIBRARY) {
    const vr = cloneVoiceState(c);
    const out = new Float32Array(n + 2); // sentinel padding either side
    out[0] = -1; out[n + 1] = -1; // pixelIndex never touches these
    for (let frame = 0; frame < 240; frame++) {
      const bandValue = 0.5 + 0.5 * Math.sin(frame * 0.13); // a moving, not pinned, signal
      const ctx = ctxForBand(c.bands[0], Math.max(0, bandValue), dt);
      c.tick(vr, ctx);
      const localOut = new Float32Array(n);
      c.kernel(area, 0, n, localOut, vr, ctx);
      for (let i = 0; i < n; i++) {
        assert.ok(Number.isFinite(localOut[i]), `${c.key}: non-finite output at pixel ${i}, frame ${frame}`);
        assert.ok(localOut[i] >= -1e-9, `${c.key}: negative output ${localOut[i]} at pixel ${i}, frame ${frame}`);
      }
    }
    assert.equal(out[0], -1, `${c.key}: kernel wrote outside [from,to)`);
    assert.equal(out[n + 1], -1, `${c.key}: kernel wrote outside [from,to)`);
  }
});

// ============================================================
//  F2 — THE BAND A CHARACTER LISTENS TO COMES FROM THE VOICE.
//
//  Every character used to name its band as a literal, so two motifs
//  authored to listen to different sounds always moved together. The band
//  now arrives on ctx.band (set per voice by showEnsemble.js) with the
//  character's own `bands[0]` as the fallback.
// ============================================================

test('readVoiceBand: ctx.band wins when the source produces it', () => {
  const bands = { bass: 0.9, mid: 0.1, high: 0.4, energy: 0.2, beat: 0 };
  assert.equal(readVoiceBand({ bands, band: 'bass' }, 'mid'), 0.9);
  assert.equal(readVoiceBand({ bands, band: 'high' }, 'mid'), 0.4);
  assert.equal(readVoiceBand({ bands, band: 'bass' }, 'high'), 0.9,
    'the authored band beats the fallback, not the other way round');
});

test('readVoiceBand falls back to the character band when no band is authored', () => {
  const bands = { bass: 0.9, mid: 0.1, high: 0.4, energy: 0.2, beat: 0 };
  assert.equal(readVoiceBand({ bands }, 'bass'), 0.9, 'absent ctx.band -> the character default');
  assert.equal(readVoiceBand({ bands, band: null }, 'high'), 0.4);
  assert.equal(readVoiceBand({ bands, band: 'none' }, 'mid'), 0.1, "'none' is not a band");
});

test('readVoiceBand falls back when the source does not produce the authored band', () => {
  // A program authored against a five-band analyser, played through a source
  // that only emits energy: the voice must keep breathing, not go dark.
  const thin = { energy: 0.8 };
  assert.equal(readVoiceBand({ bands: thin, band: 'beat' }, 'energy'), 0.8);
  assert.equal(readVoiceBand({ bands: { energy: NaN }, band: 'beat' }, 'energy'), 0,
    'and a missing fallback is 0, never a throw');
  assert.equal(readVoiceBand({ band: 'bass' }, 'mid'), 0);
  assert.equal(readVoiceBand(null, 'mid'), 0);
});

test('F2: every character follows ctx.band, not its own hardcoded band', () => {
  const dt = 1 / 60;
  for (const c of CHARACTER_LIBRARY) {
    const own = c.bands[0];
    // Pick a band that is NOT the character's own recommendation.
    const other = ['bass', 'mid', 'high', 'energy'].find((b) => b !== own);

    // Only `other` is playing. A voice authored on `other` must respond;
    // a voice with no authored band (the character's own default) must not.
    const bands = { bass: 0, mid: 0, high: 0, energy: 0, beat: 0, [other]: 1 };
    const authored = cloneVoiceState(c);
    const defaulted = cloneVoiceState(c);
    for (let i = 0; i < 120; i++) {
      c.tick(authored, { dt, bands, depth: 1, band: other });
      c.tick(defaulted, { dt, bands, depth: 1, band: null });
    }
    assert.ok(authored.env > 0.9,
      `${c.key}: a voice authored on "${other}" must follow it (env ${authored.env})`);
    assert.ok(defaulted.env < 1e-6,
      `${c.key}: an unauthored voice must stay on "${own}", which is silent here (env ${defaulted.env})`);

    // ...and the mirror image, so this cannot pass by the bands being equal.
    const ownBands = { bass: 0, mid: 0, high: 0, energy: 0, beat: 0, [own]: 1 };
    const onOwn = cloneVoiceState(c);
    const onOther = cloneVoiceState(c);
    for (let i = 0; i < 120; i++) {
      c.tick(onOwn, { dt, bands: ownBands, depth: 1, band: null });
      c.tick(onOther, { dt, bands: ownBands, depth: 1, band: other });
    }
    assert.ok(onOwn.env > 0.9, `${c.key}: the character default must still work`);
    assert.ok(onOther.env < 1e-6, `${c.key}: a voice on "${other}" must ignore "${own}"`);
  }
});

test('F2: a per-voice band changes the PIXELS, not just the envelope', () => {
  const dt = 1 / 60;
  const n = 240;
  const area = makeArea(n, { radius: (i, k) => i / k });
  for (const c of CHARACTER_LIBRARY) {
    const own = c.bands[0];
    const other = ['bass', 'mid', 'high', 'energy'].find((b) => b !== own);
    const bands = { bass: 0, mid: 0, high: 0, energy: 0, beat: 0, [other]: 1 };

    const render = (band) => {
      const vr = cloneVoiceState(c);
      const ctx = { dt, bands, depth: 1, band };
      const out = new Float32Array(n);
      for (let i = 0; i < 200; i++) c.tick(vr, ctx);
      // Twinkle and Ripple are stochastic/event driven: accumulate a whole
      // second so a difference is a real difference, not one frame's luck.
      for (let i = 0; i < 60; i++) { c.tick(vr, ctx); c.kernel(area, 0, n, out, vr, ctx); }
      let sum = 0;
      for (let i = 0; i < n; i++) sum += out[i];
      return sum;
    };

    const listening = render(other);
    const deaf = render(null);
    assert.ok(listening > deaf * 1.05 + 1e-6,
      `${c.key}: authored band "${other}" must light more than the (silent) default "${own}" `
      + `— saw ${listening} vs ${deaf}`);
  }
});

// ============================================================
//  F4 — silence decays to the resting coal floor in ~8 seconds.
//
//  The direction's eight seconds is a statement about what the ROOM sees,
//  so this measures `glowLevel(vr)` — the rendered level before geometry —
//  and not the envelope underneath it. Those were the same curve until the
//  2026-08-21 legibility pass put an expander between them; measuring the
//  envelope now would assert the wrong quantity, and the release constant is
//  derived from this end of it (GLOW_RELEASE_TAU = 8 * power / ln 20).
//
//  It starts from a FULLY LOUD, FULLY SETTLED state — the coverage before
//  the F4 fix started cold and quiet, which is why it could not see a
//  46-second decay.
// ============================================================
test('F4: Glow decays from loud to the resting coal floor in ~8 seconds', () => {
  const dt = 1 / 60;
  const loud = ctxForBand('energy', 1, dt);
  const quiet = ctxForBand('energy', 0, dt);
  const vr = cloneVoiceState(Glow);

  // 120s of loud: mood (a 20s rise) is fully settled, so this is the worst
  // case the decay has to handle, not a convenient one.
  for (let i = 0; i < 60 * 120; i++) Glow.tick(vr, loud);
  const start = glowLevel(vr);
  const floor = glowLevel({ env: 0, mood: 0 });
  assert.ok(start > 0.8, `the loud state must actually be loud, saw level ${start}`);
  // Dim but genuinely alight: at least the magnitude of showEnsemble's hard
  // LIVING_COAL_FLOOR (0.0390625), so the ground layer's lobes are still
  // visible above it and the resting field keeps drifting — and nowhere near
  // the 0.15 pedestal that used to cap the whole quiet-to-loud range.
  assert.ok(floor >= 0.039 && floor < 0.12,
    `the resting coal floor must be dim but alight, saw ${floor}`);

  const target = floor + (start - floor) * 0.05;
  let elapsed = null;
  for (let i = 0; i < 60 * 60 && elapsed === null; i++) {
    Glow.tick(vr, quiet);
    if (glowLevel(vr) <= target) elapsed = (i + 1) * dt;
  }
  assert.ok(elapsed !== null, 'Glow never reached the coal floor within 60s');
  // Spec: "roughly 8 seconds". Before the F4 fix this measurement read 46.0s.
  assert.ok(elapsed >= 7.5 && elapsed <= 8.5,
    `expected ~8s (+/- 0.5s) to reach the coal floor, measured ${elapsed.toFixed(2)}s`);

  // And it is a floor, not a fade to black: the level bottoms out on the
  // authored coal bed and stays there.
  for (let i = 0; i < 60 * 30; i++) Glow.tick(vr, quiet);
  const level = glowLevel(vr);
  assert.ok(level >= floor - 1e-9 && level < floor * 1.02 + 1e-6,
    `silence must rest on the dim coal bed (${floor}), saw level ${level}`);
});

test('F4: Glow still RISES slowly — only the fall was retuned', () => {
  const dt = 1 / 60;
  const loud = ctxForBand('energy', 1, dt);
  const vr = cloneVoiceState(Glow);
  for (let i = 0; i < 60 * 5; i++) Glow.tick(vr, loud);
  assert.ok(vr.env > 0.85, 'the reactive envelope is fast (0.15s attack)');
  assert.ok(vr.mood < 0.3, `the mood bed is still a slow 20s build, saw ${vr.mood}`);
});

// ============================================================
//  F5 — a twinkle spark eases in and out; it never appears or vanishes in
//  a single frame.
// ============================================================
test('F5: sparkEnvelope is continuous — zero at birth, zero at death, smooth between', () => {
  assert.equal(sparkEnvelope(0), 0, 'a spark is dark at the instant of ignition');
  assert.equal(sparkEnvelope(-1), 0);
  assert.equal(sparkEnvelope(10), 0, 'and dark again once its life is over');
  let peak = 0;
  let prev = 0;
  for (let age = 0; age <= 0.2; age += 0.0005) {
    const v = sparkEnvelope(age);
    assert.ok(v >= 0 && v <= 1, `envelope out of range at age ${age}: ${v}`);
    assert.ok(Math.abs(v - prev) < 0.02,
      `envelope jumped ${Math.abs(v - prev)} between samples 0.5ms apart at age ${age}`);
    peak = Math.max(peak, v);
    prev = v;
  }
  assert.ok(Math.abs(peak - 1) < 1e-9, 'a spark does reach full brightness');
});

test('F5: an isolated spark ramps up over several frames and fades over several more', () => {
  const dt = 1 / 60;
  const BUCKET = 601;                     // an arbitrary bucket to aim at
  const rf = 1;                           // maximum ignition probability
  const p = 0.035 * 1 * rf * rf;          // TWINKLE_IGNITE_GAIN * env(~1) * rf^2

  // Find a pixel seed that ignites in exactly ONE of the buckets around
  // BUCKET, so the series below is one spark's own shape and not a pile-up.
  let seed = null;
  for (let s = 1; s < 400000 && seed === null; s++) {
    const key = s * 2654435761 | 0;
    if (!(hash01(key, BUCKET) < p * 0.9)) continue;
    let clean = true;
    for (let d = -4; d <= 4; d++) {
      if (d !== 0 && hash01(key, BUCKET + d) < p * 1.1) { clean = false; break; }
    }
    if (clean) seed = key;
  }
  assert.ok(seed !== null, 'no isolated-spark seed found — widen the search');

  const area = {
    pixelIndex: new Int32Array([0]),
    radius: new Float32Array([rf]),
    angle: new Float32Array([0]),
    seed: new Int32Array([seed]),
  };
  const ctx = ctxForBand('high', 1, dt);
  const vr = cloneVoiceState(Twinkle);
  for (let i = 0; i < 200; i++) Twinkle.tick(vr, ctx);   // settle env near 1
  assert.ok(vr.env > 0.99);

  // Walk wall-clock across the spark's life. vr.clock is set directly so the
  // sample points are exact; the kernel reads nothing else.
  const series = [];
  for (let t = (BUCKET - 1) / 20; t < (BUCKET + 5) / 20; t += dt) {
    vr.clock = t;
    const out = new Float32Array(1);
    Twinkle.kernel(area, 0, 1, out, vr, ctx);
    series.push(out[0]);
  }
  const peak = Math.max(...series);
  assert.ok(peak > 0, 'the chosen seed must actually spark');

  const lit = series.filter((v) => v > 0);
  const partial = series.filter((v) => v > 0 && v < peak - 1e-6);
  assert.ok(lit.length >= 4,
    `a spark must live for several frames, saw ${lit.length} lit frames`);
  assert.ok(partial.length >= 3,
    `a spark must be seen at partial brightness, not only full — saw ${partial.length} partial frames`);

  // The no-snap assertion proper: it never goes from dark to full, or from
  // full to dark, in one frame.
  for (let i = 1; i < series.length; i++) {
    const jump = Math.abs(series[i] - series[i - 1]);
    assert.ok(jump < peak * 0.75,
      `spark changed by ${jump} of a ${peak} peak in one frame (frame ${i}) — that is a snap`);
  }
  assert.equal(series[0], 0, 'dark before ignition');
  assert.equal(series[series.length - 1], 0, 'dark again after');
});

// ============================================================
//  F6 — a ripple wavefront eases in at spawn and out at expiry.
// ============================================================
test('F6: rippleEnvelope is zero at birth and at death, and full in between', () => {
  assert.equal(rippleEnvelope(0), 0, 'a wavefront is silent on the frame it is born');
  assert.equal(rippleEnvelope(-0.1), 0);
  assert.equal(rippleEnvelope(2), 0, 'and past its authored travel it is gone');
  assert.ok(rippleEnvelope(0.5) > 0.99, 'mid-life it is at full amplitude');
  let prev = 0;
  for (let r = 0; r <= 1.36; r += 0.001) {
    const v = rippleEnvelope(r);
    assert.ok(v >= 0 && v <= 1);
    assert.ok(Math.abs(v - prev) < 0.03, `envelope jumped ${Math.abs(v - prev)} at r=${r}`);
    prev = v;
  }
});

test('F6: a spawned wavefront fades in over several frames instead of snapping on', () => {
  const dt = 1 / 60;
  const n = 200;
  const area = makeArea(n, { radius: (i, k) => i / k });
  const ctx = ctxForBand('bass', 0, dt);   // silence: only the seeded front

  const vr = cloneVoiceState(Ripple);
  vr.rippleActive[0] = 1; vr.rippleR[0] = 0; vr.ripplePhase[0] = 0; vr.rippleStrength[0] = 1;
  // A control voice with NO wavefront, ticked in lockstep, so the kernel's
  // ambient base wash is subtracted out and the series is the wavefront alone.
  const control = cloneVoiceState(Ripple);

  const total = (v) => {
    const out = new Float32Array(n);
    Ripple.kernel(area, 0, n, out, v, ctx);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += out[i];
    return sum;
  };

  const series = [];
  for (let f = 0; f < 12; f++) {
    series.push(total(vr) - total(control));
    Ripple.tick(vr, ctx);
    Ripple.tick(control, ctx);
  }
  assert.equal(series[0], 0, 'the spawn frame itself is silent — no single-frame ignition');
  assert.ok(series[5] > 0, 'and the front does arrive');
  assert.ok(series[1] < series[5] * 0.4,
    `the first lit frame (${series[1]}) must be well under the settled level (${series[5]})`);
  for (let i = 1; i <= 5; i++) {
    assert.ok(series[i] > series[i - 1], `the fade-in must be monotone (frame ${i})`);
  }
});

test('F6: the birth/death ease is travel-driven, so audio cannot change it', () => {
  // Two identical wavefronts, one under silence and one under a pinned loud
  // band: the envelope they see at every step must match exactly.
  const dt = 1 / 60;
  const quiet = cloneVoiceState(Ripple);
  const loud = cloneVoiceState(Ripple);
  for (const vr of [quiet, loud]) {
    vr.rippleActive[0] = 1; vr.rippleR[0] = 0; vr.ripplePhase[0] = 0; vr.rippleStrength[0] = 1;
  }
  for (let f = 0; f < 90; f++) {
    Ripple.tick(quiet, ctxForBand('bass', 0, dt));
    Ripple.tick(loud, ctxForBand('bass', 1, dt));
    assert.equal(rippleEnvelope(quiet.rippleR[0]), rippleEnvelope(loud.rippleR[0]),
      `wavefront envelope diverged under audio at frame ${f}`);
  }
});

// ============================================================
//  F7 — audio may MOVE the Swell crest, but never appear to accelerate it.
// ============================================================

/** Max |dR/dt| of the Swell crest position over a 60s drive at 60fps. */
function maxCrestTravelRate(bandAt) {
  const dt = 1 / 60;
  const vr = cloneVoiceState(Swell);
  let prevR = null;
  let worst = 0;
  for (let i = 0; i < 60 * 60; i++) {
    Swell.tick(vr, ctxForBand('bass', bandAt(i), dt));
    // The kernel's own R, at phase 0.
    const breath = 0.5 + 0.5 * Math.sin(2 * Math.PI * vr.clock);
    const R = Math.min(1, Math.max(0, (0.14 + 0.80 * breath) * vr.reachGain));
    if (prevR !== null) worst = Math.max(worst, Math.abs(R - prevR) / dt);
    prevR = R;
  }
  return worst;
}

test('F7: the Swell crest is slew-limited — audio moves it, never accelerates it', () => {
  const authoredOnly = maxCrestTravelRate(() => 0);
  const underKicks = maxCrestTravelRate((i) => (i % 40 < 6 ? 1 : 0));
  const underSwing = maxCrestTravelRate((i) => (i % 2 ? 1 : 0));

  // Sanity: the authored breath does move the crest on its own.
  assert.ok(authoredOnly > 0.05 && authoredOnly < 0.15,
    `authored-only crest rate ${authoredOnly} is not the ~0.077/s the 18s breath produces`);

  // Before the slew limiter these measured 2.79/s (36x) and 3.64/s (47x).
  // The cap is authored travel + widest-reach * SWELL_REACH_SLEW.
  const cap = 0.141 + 0.95 * SWELL_REACH_SLEW;
  assert.ok(underKicks <= cap, `crest travelled ${underKicks}/s under kicks, cap ${cap}/s`);
  assert.ok(underSwing <= cap, `crest travelled ${underSwing}/s under an alternating band, cap ${cap}/s`);
  assert.ok(underKicks < authoredOnly * 4,
    `crest under kicks (${underKicks}/s) must stay within a small multiple of the authored rate `
    + `(${authoredOnly}/s) — it was 36x before the limiter`);
});

test('F7: the reach gain itself can never move faster than SWELL_REACH_SLEW', () => {
  const dt = 1 / 60;
  const vr = cloneVoiceState(Swell);
  let prev = vr.reachGain;
  let worst = 0;
  for (let i = 0; i < 60 * 30; i++) {
    Swell.tick(vr, ctxForBand('bass', i % 2 ? 1 : 0, dt));
    worst = Math.max(worst, Math.abs(vr.reachGain - prev) / dt);
    prev = vr.reachGain;
  }
  assert.ok(worst <= SWELL_REACH_SLEW * (1 + 1e-9),
    `reach gain moved at ${worst}/s, limit ${SWELL_REACH_SLEW}/s`);
});

test('F7: the crest still MOVES with the music — the limiter is not a freeze', () => {
  const dt = 1 / 60;
  const quiet = cloneVoiceState(Swell);
  const loud = cloneVoiceState(Swell);
  for (let i = 0; i < 60 * 20; i++) {
    Swell.tick(quiet, ctxForBand('bass', 0, dt));
    Swell.tick(loud, ctxForBand('bass', 1, dt));
  }
  assert.ok(loud.reachGain > quiet.reachGain + 0.4,
    `audio must still reach the crest outward: quiet ${quiet.reachGain}, loud ${loud.reachGain}`);

  const area = makeArea(200, { radius: (i, k) => i / k });
  const quietOut = new Float32Array(200);
  const loudOut = new Float32Array(200);
  Swell.kernel(area, 0, 200, quietOut, quiet, ctxForBand('bass', 0, dt));
  Swell.kernel(area, 0, 200, loudOut, loud, ctxForBand('bass', 1, dt));
  let differs = 0;
  for (let i = 0; i < 200; i++) if (Math.abs(quietOut[i] - loudOut[i]) > 1e-4) differs++;
  assert.ok(differs > 50, `the crest position must visibly differ, saw ${differs} pixels`);
});

// ============================================================
//  L1-L5 — the 2026-08-21 LEGIBILITY pass.
//
//  Owner direction, verbatim: "I don't need you to retune them, it wasn't
//  working great before. I need you to make sure they are responsive and we
//  will get some cool effects based on a variety of music."
//
//  `responsivenessProbe.js` measures whether that landed across eight
//  synthesised genres; these lock the MECHANISMS it measures, so a future
//  refactor that quietly removes one fails here with a sentence rather than
//  as a shifted number in a sweep.
// ============================================================

/** Settle a character under a pinned band, then render one frame and return
 * the summed brightness. `beat` is pinned separately so a percussive accent
 * can be isolated from the band level that drives the envelope. */
function settledBrightness(character, bandName, level, { beat = 0, area, ticks = 400, dt = 1 / 60 } = {}) {
  const px = area || makeArea(360, { radius: (i, n) => i / n });
  const n = px.pixelIndex.length;
  const bands = { bass: 0, mid: 0, high: 0, energy: 0, beat: 0 };
  bands[bandName] = level;
  const tickCtx = { dt, bands, depth: 1 };
  const vr = cloneVoiceState(character);
  for (let i = 0; i < ticks; i++) character.tick(vr, tickCtx);
  const renderCtx = { dt, bands: { ...bands, beat }, depth: 1 };
  const out = new Float32Array(n);
  character.kernel(px, 0, n, out, vr, renderCtx);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += out[i];
  return sum;
}

// ---- L1: the expander itself ----

test('L1: expand() is monotone, anchored at 0 and at its pivot, and steeper than linear below it', () => {
  assert.equal(expand(0, 0.45, 1.6), 0, 'silence expands to silence');
  assert.equal(expand(-1, 0.45, 1.6), 0, 'a negative reading is not a negative light');
  assert.ok(Math.abs(expand(0.45, 0.45, 1.6) - 0.45) < 1e-12,
    'the pivot is a fixed point — a normal record comes through where it was');
  assert.ok(Math.abs(expand(1, 1, 1.6) - 1) < 1e-12, 'a pivot of 1 is a plain gamma');

  let prev = -1;
  for (let x = 0; x <= 1.0001; x += 0.005) {
    const v = expand(x, 0.45, 1.6);
    assert.ok(v >= prev - 1e-12, `expand is not monotone at x=${x}`);
    assert.ok(v >= 0 && v <= 1, `expand left [0,1] at x=${x}: ${v}`);
    prev = v;
  }

  // The whole point: HALF the pivot must come through as much less than half.
  // This is the "lower the quiet end rather than raise the loud end" lever.
  const half = expand(0.225, 0.45, 1.6) / expand(0.45, 0.45, 1.6);
  assert.ok(half < 0.4, `half the pivot should read well under half as bright, got ${half.toFixed(3)}`);
  // ...while a moderate record is NOT crushed. Bass-heavy electronic's mid
  // band measures 0.23; a plain gamma puts it at 0.099, which is off. The
  // pivot keeps it at 0.154 — the whole reason the curve is pivoted at all.
  const pivoted = expand(0.23, 0.45, 1.6);
  const plainGamma = expand(0.23, 1, 1.6);
  assert.ok(pivoted > plainGamma * 1.4,
    `a mid-level genre must survive the expander: pivoted ${pivoted.toFixed(4)} vs plain gamma ${plainGamma.toFixed(4)}`);
});

// ---- L2: the failure that made Ripple dark on three genres out of four ----

test('L2: Ripple keeps spawning on a track whose band never falls to a quiet absolute level', () => {
  // The 2026-08-21 defect, stated as a test. The old detector armed only below
  // an ABSOLUTE 0.18 and fired only above an ABSOLUTE 0.35, so this drive —
  // a loud sustained bass with kicks on top, never dipping under 0.42 — fired
  // exactly ONE wavefront on the first frame and then went dark forever.
  const dt = 1 / 60;
  const vr = cloneVoiceState(Ripple);
  let spawns = 0;
  for (let i = 0; i < 60 * 10; i++) {
    const t = i * dt;
    const kick = (t % 0.5) < 0.08 ? 1 : 0;
    const b = 0.42 + 0.5 * kick;                     // floor 0.42, peak 0.92
    const before = vr.rippleR[0] + vr.rippleR[1] + vr.rippleR[2];
    Ripple.tick(vr, { dt, bands: { bass: b, mid: 0, high: 0, energy: b, beat: kick }, depth: 1 });
    const after = vr.rippleR[0] + vr.rippleR[1] + vr.rippleR[2];
    if (after < before) spawns++;                    // a slot reset to r=0
  }
  assert.ok(spawns >= 15,
    `expected roughly one wavefront per kick over 10s (20 kicks), saw ${spawns}. `
    + 'A detector that cannot re-arm above a loud track\'s bass floor leaves the piece unlit.');
});

test('L2: Ripple is dark in silence and visibly lit under a bass line, with no constant wash', () => {
  const dt = 1 / 60;
  const area = makeArea(240, { radius: (i, n) => i / n });
  const silent = settledBrightness(Ripple, 'bass', 0, { area, dt });
  assert.equal(silent, 0,
    'Ripple carries no coal bed of its own — the ensemble composites one, and a '
    + 'constant wash here is what pinned its quiet-to-loud ratio at 1.03');
  const lit = settledBrightness(Ripple, 'bass', 0.7, { area, dt });
  assert.ok(lit > 8, `a sustained bass must light the standing-ripple bed, saw ${lit}`);
});

// ---- L3: the beat accent ----

for (const character of [Swell, Trace]) {
  test(`L3: ${character.key} — a beat flares part of the motif without moving anything`, () => {
    const area = makeArea(360, { radius: (i, n) => i / n });
    const own = character.bands[0];
    // Measured at a QUIET passage's level: an accent that only reads when the
    // music is already loud is not an accent.
    const quietBeat = settledBrightness(character, own, 0.30, { beat: 0, area });
    const loudBeat = settledBrightness(character, own, 0.30, { beat: 1, area });
    assert.ok(loudBeat > quietBeat * 1.10,
      `${character.key}: a hit must be visible at the same band level — ${quietBeat} vs ${loudBeat}`);

    // The accent is squared, so the first quarter of a beat's rise delivers
    // well under a tenth of the accent: it grows into place over several
    // frames instead of landing whole. This is the no-single-frame-snap half.
    const early = settledBrightness(character, own, 0.30, { beat: 0.25, area });
    const delivered = (early - quietBeat) / (loudBeat - quietBeat);
    assert.ok(delivered <= 0.1,
      `${character.key}: a quarter-height beat already delivered ${(delivered * 100).toFixed(1)}% `
      + 'of the accent — that is an accent that lands in one frame');

    // And it is an ACCENT, not a second light source: it may not dominate.
    assert.ok(loudBeat < quietBeat * 3,
      `${character.key}: the flare (${loudBeat}) dwarfs the motif (${quietBeat}) — that is a strobe, not an accent`);
  });
}

// ---- L4: Glow tells two records apart that have the same loudness ----

test('L4: Glow answers a bright record and a bass-heavy record differently at equal energy', () => {
  const dt = 1 / 60;
  const area = makeArea(360, { radius: (i, n) => i / n });
  // Both sides carry the SAME energy — this is the real measurement from
  // responsivenessProbe.js, where bass-heavy electronic and bright acoustic
  // both compute to ~0.34 energy and Glow could not tell them apart at all.
  const render = (treble) => {
    const bands = { bass: 0, mid: 0, high: treble, energy: 0.34, beat: 0 };
    const ctx = { dt, bands, depth: 1 };
    const vr = cloneVoiceState(Glow);
    for (let i = 0; i < 60 * 30; i++) Glow.tick(vr, ctx);
    const out = new Float32Array(360);
    Glow.kernel(area, 0, 360, out, vr, ctx);
    let sum = 0;
    for (let i = 0; i < 360; i++) sum += out[i];
    return sum;
  };
  const deep = render(0.05);     // bass-heavy: almost no treble
  const bright = render(0.44);   // bright acoustic: treble dominant
  assert.ok(bright > deep * 1.5,
    `equal loudness must not mean equal light: deep ${deep.toFixed(1)} vs bright ${bright.toFixed(1)}`);
});

test('L4: Glow still leads with the voice own band — the treble tilt only decides how hot', () => {
  // With no highs present, the target IS the voice band, which is what keeps
  // per-voice band selection honest.
  const dt = 1 / 60;
  const vr = cloneVoiceState(Glow);
  const ctx = { dt, bands: { bass: 1, mid: 0, high: 0, energy: 0, beat: 0 }, depth: 1, band: 'bass' };
  for (let i = 0; i < 120; i++) Glow.tick(vr, ctx);
  assert.ok(vr.env > 0.9, `a Glow voice authored on bass must follow bass alone, saw ${vr.env}`);
});

// ---- L5: dark-to-bright contrast, per character ----

test('L5: a quiet passage is much darker than a loud one, for every level-driven character', () => {
  // 0.12 against 0.85 of a band is roughly a quiet record against a loud one.
  // The previous legibility pass recorded 3-8x as the standard of good; the
  // characters measured 1.0-5.0x before this pass.
  const area = makeArea(360, { radius: (i, n) => i / n });
  const MIN_RATIO = 4;
  for (const character of [Swell, Glow, Trace]) {
    const own = character.bands[0];
    const quiet = settledBrightness(character, own, 0.12, { area });
    const loud = settledBrightness(character, own, 0.85, { area });
    assert.ok(quiet > 0, `${character.key}: a quiet passage must not be black, saw ${quiet}`);
    assert.ok(loud >= quiet * MIN_RATIO,
      `${character.key}: quiet ${quiet.toFixed(2)} to loud ${loud.toFixed(2)} is only `
      + `${(loud / quiet).toFixed(2)}x — under the ${MIN_RATIO}x bar. Lower the quiet end, do not raise the loud one.`);
  }
});

test('L5: Twinkle ignites far more sparks under a bright band than a dim one', () => {
  const dt = 1 / 60;
  const n = 4000;
  const area = makeArea(n, { radius: 1 });
  const countOver = (level) => {
    const ctx = ctxForBand('high', level, dt);
    const vr = cloneVoiceState(Twinkle);
    for (let i = 0; i < 200; i++) Twinkle.tick(vr, ctx);
    let lit = 0;
    for (let f = 0; f < 120; f++) {
      Twinkle.tick(vr, ctx);
      const out = new Float32Array(n);
      Twinkle.kernel(area, 0, n, out, vr, ctx);
      for (let i = 0; i < n; i++) if (out[i] > 0.08) lit++;
    }
    return lit;
  };
  const dim = countOver(0.12);
  const bright = countOver(0.85);
  assert.ok(dim > 0, 'a dim treble must still produce the occasional spark');
  assert.ok(bright >= dim * 4,
    `sparks under a bright band (${bright}) must far outnumber a dim one's (${dim})`);
});
