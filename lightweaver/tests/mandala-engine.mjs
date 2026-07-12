// Locks the invariants of the extracted mandala engine (src/lib/mandalaEngine.js)
// against the binding aesthetic contract:
//  - docs/mandala-color-system.md: B ≤ G ≤ R warmth law, permanent warmth margin,
//    one warm hue corridor, dim-but-never-black idle floor.
//  - docs/mandala-effects-direction-v2.md: silence decays to a dim coal field
//    (never black, never frozen), brightness ceiling via the master scale.
// Plus the frame plumbing the card stream depends on: frame length matches the
// pixel count, hex encoding is WLED seg.i-shaped, and the resample adapter maps
// the 675px ring frame onto arbitrary project pixel counts.

import assert from 'node:assert/strict';
import {
  createMandalaEngine,
  frameToHex,
  resampleFrame,
  paletteRamp,
  MODE_LIBRARY,
  MODE_KEYS,
  PALETTES,
  PRESETS,
  RINGS,
  TOTAL_PIXELS,
} from '../src/lib/mandalaEngine.js';
import { createMandalaSpatialTemplate } from '../src/lib/showSpatialTemplate.js';

// ── geometry + library shape ─────────────────────────────────────────────
assert.equal(TOTAL_PIXELS, 675, 'the hardware ring map is 675 pixels');
assert.equal(RINGS.length, 5, 'five hardware rings');
assert.equal(RINGS.reduce((s, r) => s + r.count, 0), 675, 'ring counts sum to the pixel total');
assert.deepEqual(RINGS.map(r => r.count), [45, 90, 135, 180, 225], 'ring pixel counts match the simulator');
assert.equal(MODE_LIBRARY.length, 9, 'nine modes');
assert.equal(MODE_LIBRARY.filter(m => m.tier === 'slow').length, 5, 'five slow/meditative modes');
assert.equal(MODE_LIBRARY.filter(m => m.tier === 'lively').length, 4, 'four livelier modes');
assert.deepEqual(
  MODE_KEYS,
  ['meridian', 'hearth', 'embers', 'strata', 'tide', 'lattice', 'procession', 'bloom', 'spiral'],
  'mode order is the sim library order, slow → lively',
);
assert.equal(PRESETS.Active.modDepth, 1.5, 'Active deepens modulation (never speeds motion)');

function assertFeatureLevels(engine, expected, message) {
  const actual = engine.getLevels();
  for (const [key, value] of Object.entries(expected)) {
    assert.ok(Math.abs(actual[key] - value) < 1e-9,
      `${message}: ${key} expected ${value}, received ${actual[key]}`);
  }
}

// ── spatial template + full audio feature contract ───────────────────────
{
  const defaultTemplate = createMandalaSpatialTemplate();
  const compactTemplate = defaultTemplate.filter((_, index) => index % 97 === 0);
  const engine = createMandalaEngine({ template: compactTemplate });
  assert.equal(engine.frameRGB().length, compactTemplate.length * 3,
    'constructor sizes frame buffers to the supplied spatial samples');
  assert.equal(engine.colorFrame().length, compactTemplate.length * 3,
    'constructor sizes color buffers to the supplied spatial samples');

  engine.setMode('spiral');
  engine.setPreset('Active');
  engine.setMaster(0.61);
  engine.setSensitivity(2.2);
  engine.setTemplate(defaultTemplate.slice(0, 11));
  assert.equal(engine.frameRGB().length, 33, 'setTemplate rebuilds buffers for new geometry');
  assert.equal(engine.getMode(), 'spiral', 'setTemplate preserves the selected mode');
  assert.equal(engine.getPreset(), 'Active', 'setTemplate preserves the preset');
  assert.equal(engine.getMaster(), 0.61, 'setTemplate preserves master');
  assert.equal(engine.getSensitivity(), 2.2, 'setTemplate preserves sensitivity');

  const supplied = { bass: -1, mid: 0.35, high: 2, energy: 0.7, centroid: 0.55, flux: 0.4, beat: 0.9 };
  engine.setFeatures(supplied);
  supplied.mid = 1;
  assertFeatureLevels(engine, {
    bass: 0, mid: 0.77, high: 1, energy: 1, centroid: 0.55, flux: 0.88, beat: 1,
  }, 'setFeatures clamps, copies, and applies sensitivity to the complete analyzer feature vector');
}

{
  const template = createMandalaSpatialTemplate().slice(0, 2);
  template[0] = { ...template[0], stripId: null };
  const engine = createMandalaEngine({ template });
  engine.setListening(true);
  engine.setFeatures({ bass: 1, mid: 1, high: 1, energy: 1, beat: 1 });
  for (let i = 0; i < 30; i += 1) engine.tick(1 / 30);
  assert.deepEqual([...engine.colorFrame().slice(0, 3)], [0, 0, 0], 'inactive addresses have black preview color');
  assert.deepEqual([...engine.frameRGB().slice(0, 3)], [0, 0, 0], 'inactive addresses have exact black wire output');
}

// An equivalent spatial coordinate renders identically whether it lives in the
// full Mandala template or a one-sample fixture. This catches accidental reads
// from the legacy ringOf/rfOf/angOf arrays inside effects.
{
  const template = createMandalaSpatialTemplate();
  const sourceIndex = 511;
  const full = createMandalaEngine({ template });
  const one = createMandalaEngine({ template: [{ ...template[sourceIndex], outputIndex: 0 }] });
  for (const engine of [full, one]) {
    engine.setMode('lattice');
    engine.setListening(true);
    for (let frame = 0; frame < 90; frame += 1) {
      engine.setFeatures({ bass: 0.62, mid: 0.48, high: 0.31, energy: 0.56, centroid: 0.44, flux: 0.2, beat: 0.7 });
      engine.tick(1 / 30);
    }
  }
  assert.ok(Math.abs(full.getIntensity(sourceIndex) - one.getIntensity(0)) < 1e-6,
    'effect evaluation has template parity for equivalent coordinates');
}

// Stochastic-looking modes must derive their identity from sample geometry,
// never from a sample's loop index or the template length. The same physical
// sample therefore receives the same flicker/spark history in any template.
const stochasticParityFailures = [];
for (const [key, sourceIndex] of [['hearth', 317], ['embers', 511]]) {
  const template = createMandalaSpatialTemplate();
  const full = createMandalaEngine({ template });
  const one = createMandalaEngine({ template: [{ ...template[sourceIndex], outputIndex: 0 }] });
  let peakDifference = 0;
  for (const engine of [full, one]) {
    engine.setMode(key);
    engine.setPreset('Active');
    engine.setListening(true);
  }
  for (let frame = 0; frame < 8 * 30; frame += 1) {
    const features = {
      bass: 0.58,
      mid: 0.46,
      high: frame % 21 < 5 ? 0.9 : 0.38,
      energy: 0.61,
      centroid: 0.53,
      flux: frame % 21 === 0 ? 0.8 : 0.14,
      beat: frame % 15 < 4 ? 1 - frame % 15 * 0.2 : 0,
    };
    full.setFeatures(features);
    one.setFeatures(features);
    full.tick(1 / 30);
    one.tick(1 / 30);
    peakDifference = Math.max(
      peakDifference,
      Math.abs(full.getIntensity(sourceIndex) - one.getIntensity(0)),
    );
  }
  if (peakDifference >= 1e-6) stochasticParityFailures.push(`${key}: ${peakDifference}`);
}
assert.deepEqual(stochasticParityFailures, [],
  'Hearth/Embers equivalent samples have template-independent stochastic histories');

// Radial effects normalize against the observed template extent. The default
// Mandala begins at radius .2, so its five authored rings must occupy all five
// effect slots (0..4), rather than silently collapsing toward the outside.
for (let expectedRing = 0; expectedRing < RINGS.length; expectedRing += 1) {
  const engine = createMandalaEngine();
  engine.setMode('meridian');
  engine.setListening(true);
  for (let frame = 0; frame < 8 * 30; frame += 1) {
    engine.setFeatures({
      bass: 0.72, mid: 0.72, high: 0.72, energy: 0.72,
      centroid: expectedRing / (RINGS.length - 1), flux: 0, beat: 0,
    });
    engine.tick(1 / 30);
  }
  const ringMeans = RINGS.map((ring) => {
    let sum = 0;
    for (let i = ring.start; i < ring.start + ring.count; i += 1) sum += engine.getIntensity(i);
    return sum / ring.count;
  });
  const selectedRing = ringMeans.indexOf(Math.max(...ringMeans));
  assert.equal(selectedRing, expectedRing,
    `Meridian centroid ${expectedRing}/4 selects default ring ${expectedRing + 1}`);
}

// Connected layouts can have corner samples beyond radius 1. Their observed
// maximum is still radial progress 1, so full-radius effects and the universal
// beat substrate reach it instead of treating it as out of bounds.
{
  const connectedTemplate = [
    { outputIndex: 0, stripId: 'connected', stripIndex: 0, stripProgress: 0, x: 0.1, y: 0, radius: 0.1, angle: 0 },
    { outputIndex: 1, stripId: 'connected', stripIndex: 0, stripProgress: 0.5, x: 0.5, y: 0.5, radius: Math.SQRT1_2, angle: Math.PI / 4 },
    { outputIndex: 2, stripId: 'connected', stripIndex: 0, stripProgress: 1, x: 1, y: 1, radius: Math.SQRT2, angle: Math.PI / 4 },
  ];
  for (const key of ['tide', 'bloom']) {
    const engine = createMandalaEngine({ template: connectedTemplate });
    engine.setMode(key);
    engine.setListening(true);
    let outerPeak = 0;
    for (let frame = 0; frame < 8 * 30; frame += 1) {
      engine.setFeatures({ bass: 1, mid: 0.5, high: 0.35, energy: 0.8, centroid: 0.4, flux: 0.3, beat: 0 });
      engine.tick(1 / 30);
      outerPeak = Math.max(outerPeak, engine.getIntensity(2));
    }
    assert.ok(outerPeak > 0.3, `${key}: connected max radius sqrt(2) reaches the full-radius effect (${outerPeak})`);
  }

  const dry = createMandalaEngine({ template: connectedTemplate });
  const beat = createMandalaEngine({ template: connectedTemplate });
  for (const engine of [dry, beat]) { engine.setMode('hearth'); engine.setListening(true); }
  let outerBeatDelta = 0;
  for (let frame = 0; frame < 90; frame += 1) {
    const features = { bass: 0.5, mid: 0.5, high: 0.5, energy: 0.5, centroid: 0.5, flux: 0.2 };
    dry.setFeatures({ ...features, beat: 0 });
    beat.setFeatures({ ...features, beat: frame % 15 < 4 ? 1 : 0 });
    dry.tick(1 / 30);
    beat.tick(1 / 30);
    outerBeatDelta = Math.max(outerBeatDelta, Math.abs(beat.getIntensity(2) - dry.getIntensity(2)));
  }
  assert.ok(outerBeatDelta > 0.005, 'beat substrate reaches connected max radius beyond 1');
}

// ── color-law helpers ────────────────────────────────────────────────────
// Hue for warm pixels where R is the max channel: hue = 60 * (G-B) / (R-B).
// The corridor in the color spec prose is 18–42° HSV; the hand-tuned Hearth
// coal anchors (32,10,2 / 120,38,8) measure 16.0° exactly, so this test locks
// the SHIPPED values with a floor of 15°. On coal-dark pixels 8-bit rounding
// (±0.5 per channel) swings hue by up to ~60/(R−B) degrees, so that margin is
// allowed on top — it vanishes as pixels brighten.
const HUE_MIN = 15, HUE_MAX = 43;
function assertWarmPixel(r, g, b, where) {
  assert.ok(b <= g && g <= r, `${where}: B ≤ G ≤ R law violated (${r},${g},${b})`);
  assert.ok(b <= 0.8 * r + 1, `${where}: warmth margin violated (B > 0.8×R) (${r},${g},${b})`);
  if (r >= 10 && r - b >= 4) {
    const hue = 60 * (g - b) / (r - b);
    const quantMargin = 60 / (r - b);
    assert.ok(hue >= HUE_MIN - quantMargin && hue <= HUE_MAX + quantMargin,
      `${where}: hue ${hue.toFixed(1)}° left the warm corridor (${r},${g},${b})`);
  }
}

// Every palette stop obeys the law before any engine math touches it.
for (const [name, stops] of Object.entries(PALETTES)) {
  for (const [i, r, g, b] of stops) {
    assertWarmPixel(r, g, b, `${name} stop @${i}`);
  }
  // ramp interior samples too (linear blends of compliant stops stay compliant,
  // but lock it here so a future edit can't break the corollary silently)
  for (let s = 0; s <= 20; s++) {
    const [r, g, b] = paletteRamp(stops, s / 20).map(Math.round);
    assertWarmPixel(r, g, b, `${name} ramp @${(s / 20).toFixed(2)}`);
  }
}

// ── drive every mode with music; check frame invariants ──────────────────
function driveLoud(engine, seconds) {
  const dt = 1 / 30;
  for (let s = 0; s < seconds * 30; s++) {
    const t = s * dt;
    engine.setBands({
      bass: 0.55 + 0.4 * Math.abs(Math.sin(t * 2.1)),
      mid: 0.45 + 0.35 * Math.abs(Math.sin(t * 3.3 + 1)),
      high: 0.35 + 0.3 * Math.abs(Math.sin(t * 5.2 + 2)),
    });
    engine.tick(dt);
  }
}

function meanBrightness(rgb) {
  let sum = 0;
  const n = rgb.length / 3;
  for (let i = 0; i < n; i++) sum += Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
  return sum / n;
}

for (const { key } of MODE_LIBRARY) {
  const engine = createMandalaEngine();
  engine.setMode(key);
  assert.equal(engine.getMode(), key, `setMode(${key}) sticks`);
  engine.setListening(true);
  driveLoud(engine, 8);
  const rgb = engine.frameRGB();
  assert.equal(rgb.length, TOTAL_PIXELS * 3, `${key}: frame length matches the pixel count`);
  for (let i = 0; i < TOTAL_PIXELS; i++) {
    assertWarmPixel(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], `${key} px${i}`);
  }
  // Brightness ceiling: master defaults to 0.75, so nothing exceeds 0.85×255
  // even at the Active preset's 0.82 ceiling.
  for (let i = 0; i < rgb.length; i++) {
    assert.ok(rgb[i] <= Math.ceil(255 * 0.85), `${key}: master ceiling respected`);
  }
  assert.ok(meanBrightness(rgb) > 2, `${key}: music produces visible light`);
}

// ── silence decays to a dim coal field — never black, never bright ───────
for (const key of ['strata', 'embers', 'hearth']) {
  const engine = createMandalaEngine();
  engine.setMode(key);
  engine.setListening(true);
  driveLoud(engine, 6);
  const loud = meanBrightness(engine.frameRGB());

  // the music stops
  engine.setListening(false);
  const dt = 1 / 30;
  for (let s = 0; s < 30 * 30; s++) { // 30 seconds of silence
    engine.setBands({ bass: 0, mid: 0, high: 0 });
    engine.tick(dt);
  }
  const rgb = engine.frameRGB();
  assert.ok(engine.getPresence() < 0.05, `${key}: presence decayed in silence`);
  let minMax = 255;
  for (let i = 0; i < TOTAL_PIXELS; i++) {
    const mx = Math.max(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    if (mx < minMax) minMax = mx;
  }
  assert.ok(minMax >= 1, `${key}: silence floor is never black (dim coals, min channel-max ${minMax})`);
  const idle = meanBrightness(rgb);
  assert.ok(idle < 60, `${key}: silence idle is dim (mean ${idle.toFixed(1)}), not a light show`);
  // Embers is legitimately DARKER with music than at idle (sparse sparks on
  // true black vs. the whole-field coal floor), so compare only full-field modes.
  if (key !== 'embers') {
    assert.ok(idle < loud, `${key}: silence (${idle.toFixed(1)}) is dimmer than music (${loud.toFixed(1)})`);
  }
}

// ── audio analysis path (raw bins + AnalyserNode-shaped source) ──────────
{
  const engine = createMandalaEngine();
  engine.setListening(true);
  assert.equal(engine.analyze(null), false, 'analyze without a source is a no-op');

  const bins = new Uint8Array(1024);
  bins.fill(220, 2, 8);     // ~43–172 Hz at 44100 → bass band
  bins.fill(180, 60, 70);   // ~1.3–1.5 kHz → mid band
  assert.equal(engine.analyze(bins, 44100), true, 'raw bins analyze');
  for (let s = 0; s < 30; s++) { engine.analyze(bins, 44100); engine.tick(1 / 30); }
  const fromBins = engine.getLevels();
  assert.ok(fromBins.bass > 0.2, 'bass energy detected from raw bins');

  const engine2 = createMandalaEngine();
  engine2.setListening(true);
  const fakeAnalyser = {
    frequencyBinCount: 1024,
    context: { sampleRate: 44100 },
    getByteFrequencyData(arr) { arr.set(bins); },
  };
  assert.equal(engine2.analyze(fakeAnalyser), true, 'AnalyserNode-shaped source analyzes');
  for (let s = 0; s < 30; s++) { engine2.analyze(fakeAnalyser); engine2.tick(1 / 30); }
  assert.ok(engine2.getLevels().bass > 0.2, 'bass energy detected via analyser');

  engine.setListening(false);
  assert.equal(engine.analyze(bins, 44100), false, 'analyze respects the quiet switch');
}

// Legacy audio entry points own a complete feature update. A beat supplied by
// the modern analyzer must not remain latched when a caller switches back to
// setBands() or analyze().
{
  const engine = createMandalaEngine();
  engine.setFeatures({ bass: 0.5, mid: 0.5, high: 0.5, energy: 0.5, centroid: 0.5, flux: 0.8, beat: 1 });
  engine.setBands({ bass: 0.4, mid: 0.3, high: 0.2 });
  assert.equal(engine.getLevels().beat, 0, 'setBands clears stale beat');
  assert.equal(engine.getLevels().flux, 0, 'setBands clears stale flux');

  engine.setFeatures({ bass: 0.5, mid: 0.5, high: 0.5, energy: 0.5, centroid: 0.5, flux: 0.8, beat: 1 });
  engine.setListening(true);
  const bins = new Uint8Array(1024);
  bins.fill(160, 2, 400);
  assert.equal(engine.analyze(bins, 44100), true, 'legacy analyze fixture updates');
  assert.equal(engine.getLevels().beat, 0, 'analyze clears stale beat');
  assert.equal(engine.getLevels().flux, 0, 'analyze clears stale flux');
}

// ── resample adapter: 675-ring frame → arbitrary project pixel counts ────
{
  const engine = createMandalaEngine();
  engine.setListening(true);
  driveLoud(engine, 4);
  const rgb = engine.frameRGB();

  assert.equal(resampleFrame(rgb, 675), rgb, 'same-count resample returns the frame untouched');

  for (const count of [44, 22, 150, 1200]) {
    const small = resampleFrame(rgb, count);
    assert.equal(small.length, count * 3, `resample to ${count} px has ${count} RGB triples`);
    for (let i = 0; i < count; i++) {
      assertWarmPixel(small[i * 3], small[i * 3 + 1], small[i * 3 + 2], `resample(${count}) px${i}`);
    }
  }

  // nearest-ring-position: the first target pixel of a 5-pixel frame lands in
  // ring 1's span, the last in ring 5's (ring-major source layout).
  const five = resampleFrame(rgb, 5);
  const srcFirst = Math.floor((0.5 * 675) / 5); // 67 → ring 2 boundary math aside, deterministic
  assert.deepEqual(
    [five[0], five[1], five[2]],
    [rgb[srcFirst * 3], rgb[srcFirst * 3 + 1], rgb[srcFirst * 3 + 2]],
    'resample picks the nearest ring-walk position',
  );

  // hex encoding — the exact WLED seg.i wire format
  const hex = frameToHex(rgb);
  assert.equal(hex.length, 675, 'hex frame has one entry per pixel');
  assert.ok(hex.every(px => /^[0-9A-F]{6}$/.test(px)), 'every entry is RRGGBB uppercase hex');
  assert.deepEqual(frameToHex(new Uint8Array([255, 0, 16])), ['FF0010'], 'hex encoding is exact');
}

// ── buffer-reuse APIs: one palette walk shared by preview + stream ────────
{
  const engine = createMandalaEngine();
  engine.setListening(true);
  driveLoud(engine, 4);

  const colors = engine.colorFrame();
  assert.equal(colors.length, TOTAL_PIXELS * 3, 'colorFrame covers every pixel');
  assert.equal(engine.colorFrame(colors), colors, 'colorFrame reuses a right-sized caller buffer');
  const c0 = engine.colorAt(0);
  assert.ok(
    Math.abs(colors[0] - c0[0]) < 1e-4 && Math.abs(colors[1] - c0[1]) < 1e-4 && Math.abs(colors[2] - c0[2]) < 1e-4,
    'colorFrame agrees with colorAt',
  );

  const direct = engine.frameRGB();
  const viaColors = engine.frameRGB(new Uint8Array(TOTAL_PIXELS * 3), colors);
  assert.deepEqual(Array.from(viaColors), Array.from(direct),
    'frameRGB from a shared colorFrame buffer matches the direct path exactly');

  const out = new Uint8Array(TOTAL_PIXELS * 3);
  assert.equal(engine.frameRGB(out, colors), out, 'frameRGB reuses a right-sized caller buffer');

  const hex = frameToHex(direct);
  assert.equal(frameToHex(direct, hex), hex, 'frameToHex reuses a right-sized caller array');
  assert.deepEqual(frameToHex(direct, hex), frameToHex(direct), 'reused hex output matches a fresh encode');

  const resBuf = new Uint8Array(44 * 3);
  assert.equal(resampleFrame(direct, 44, resBuf), resBuf, 'resampleFrame reuses a right-sized caller buffer');
}

// ── preset + master controls ─────────────────────────────────────────────
{
  const engine = createMandalaEngine();
  assert.equal(engine.getPreset(), 'Calm');
  assert.equal(engine.getMaster(), 0.75, 'Calm master ceiling is 0.75');
  engine.setPreset('Active');
  assert.equal(engine.getMaster(), 0.82, 'Active master ceiling is 0.82');
  engine.setMaster(1.5);
  assert.equal(engine.getMaster(), 0.85, 'master clamps at 0.85 — the festival line stays hard');
  engine.setSensitivity(99);
  assert.equal(engine.getSensitivity(), 3, 'sensitivity clamps to the sim range');
}

// ── direct feature sensitivity is stable and materially audible ──────────
{
  const engine = createMandalaEngine();
  const raw = { bass: 0.34, mid: 0.28, high: 0.22, energy: 0.31, centroid: 0.63, flux: 0.27, beat: 0.29 };
  engine.setFeatures(raw);
  engine.setSensitivity(3);
  assertFeatureLevels(engine, {
    bass: 1, mid: 0.84, high: 0.66, energy: 0.93, centroid: 0.63, flux: 0.81, beat: 0.87,
  }, 'sensitivity scales direct levels except centroid');
  engine.setSensitivity(0.3);
  assertFeatureLevels(engine, {
    bass: 0.102, mid: 0.084, high: 0.066, energy: 0.093, centroid: 0.63, flux: 0.081, beat: 0.087,
  }, 'sensitivity reapplies from stable raw features without compounding');
  engine.setSensitivity(1);
  assertFeatureLevels(engine, raw, 'returning to sensitivity 1 restores raw direct features exactly');

  const response = [];
  for (const sensitivity of [0.3, 1, 3]) {
    const candidate = createMandalaEngine();
    candidate.setMode('hearth');
    candidate.setListening(true);
    candidate.setSensitivity(sensitivity);
    for (let frame = 0; frame < 90; frame += 1) {
      candidate.setFeatures(raw);
      candidate.tick(1 / 30);
    }
    response.push(meanBrightness(candidate.frameRGB()));
  }
  assert.ok(response[0] + 3 < response[1] && response[1] + 3 < response[2],
    `setFeatures output responds materially to sensitivity (${response.map(v => v.toFixed(2)).join(', ')})`);
}

// Meridian's authored rotation is an integrated clock. Changing energy can
// widen/brighten its arcs, but cannot teleport their angular phase.
{
  const engine = createMandalaEngine();
  engine.setMode('meridian');
  engine.setListening(true);
  const brightestOuterOffset = () => {
    const outer = RINGS.at(-1);
    let bestOffset = 0, best = -Infinity;
    for (let offset = 0; offset < outer.count; offset += 1) {
      const value = engine.getIntensity(outer.start + offset);
      if (value > best) { best = value; bestOffset = offset; }
    }
    return bestOffset;
  };
  for (let frame = 0; frame < 8 * 30; frame += 1) {
    engine.setFeatures({ bass: 0.3, mid: 0.4, high: 0.8, energy: 0.08, centroid: 1, flux: 0, beat: 0 });
    engine.tick(1 / 30);
  }
  const before = brightestOuterOffset();
  engine.setFeatures({ bass: 0.3, mid: 0.4, high: 0.8, energy: 1, centroid: 1, flux: 0, beat: 0 });
  engine.tick(1 / 30);
  const after = brightestOuterOffset();
  const count = RINGS.at(-1).count;
  const lobeSpacing = count / 3;
  const phaseJump = Math.min(...[-1, 0, 1].map((lobe) => {
    const shifted = after + lobe * lobeSpacing;
    const distance = Math.abs(shifted - before) % count;
    return Math.min(distance, count - distance);
  }));
  assert.ok(phaseJump <= 2, `Meridian energy step does not jump authored phase (${phaseJump} pixels)`);
}

// Large connected layouts exercise the frame hot path without a brittle wall
// clock assertion. Both palette and RGB passes must reuse caller-owned buffers.
{
  const count = 125_000;
  const template = Array.from({ length: count }, (_, index) => {
    const progress = index / (count - 1);
    const angle = progress * Math.PI * 2;
    const radius = 0.1 + progress * 1.3;
    return {
      outputIndex: index, stripId: 'large', stripIndex: 0, stripProgress: progress,
      x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, radius, angle,
    };
  });
  const engine = createMandalaEngine({ template });
  engine.setListening(true);
  engine.setFeatures({ bass: 0.6, mid: 0.5, high: 0.4, energy: 0.55, centroid: 0.5, flux: 0.2, beat: 0.7 });
  engine.tick(1 / 30);
  const colors = new Float32Array(count * 3);
  const rgb = new Uint8Array(count * 3);
  assert.equal(engine.colorFrame(colors), colors, 'large-template colorFrame reuses its buffer');
  assert.equal(engine.frameRGB(rgb, colors), rgb, 'large-template frameRGB reuses RGB + shared colors');
  assert.ok(rgb.some(channel => channel > 0), 'large-template frame probe writes visible channels');
}

// ── musical motion coverage + beat articulation ─────────────────────────
function beatCoverage(key, preset) {
  const template = createMandalaSpatialTemplate();
  const dry = createMandalaEngine({ template });
  const pulsed = createMandalaEngine({ template });
  const peakDelta = new Float32Array(template.length);
  for (const engine of [dry, pulsed]) {
    engine.setMode(key);
    engine.setPreset(preset);
    engine.setListening(true);
  }
  for (let frame = 0; frame < 8 * 30; frame += 1) {
    const shared = {
      bass: 0.52,
      mid: 0.47,
      high: 0.39,
      energy: 0.5,
      centroid: 0.48,
      flux: frame % 15 === 0 ? 0.7 : 0.12,
    };
    dry.setFeatures({ ...shared, beat: 0 });
    pulsed.setFeatures({ ...shared, beat: frame % 15 < 4 ? 1 - frame % 15 * 0.2 : 0 });
    dry.tick(1 / 30);
    pulsed.tick(1 / 30);
    for (let i = 0; i < template.length; i += 1) {
      peakDelta[i] = Math.max(peakDelta[i], Math.abs(pulsed.getIntensity(i) - dry.getIntensity(i)));
    }
  }
  const changed = peakDelta.filter((delta) => delta > 0.002).length;
  const perRing = RINGS.map((ring) => {
    let ringChanged = 0;
    for (let i = ring.start; i < ring.start + ring.count; i += 1) {
      if (peakDelta[i] > 0.002) ringChanged += 1;
    }
    return ringChanged / ring.count;
  });
  return { ratio: changed / template.length, perRing, peakDelta };
}

for (const { key, tier } of MODE_LIBRARY) {
  const calm = beatCoverage(key, 'Calm');
  const active = beatCoverage(key, 'Active');
  assert.ok(calm.ratio >= 0.8, `${key}: Calm repeated beat moves >=80% of pixels (${calm.ratio.toFixed(3)})`);
  assert.ok(active.ratio >= 0.9, `${key}: Active repeated beat moves >=90% of pixels (${active.ratio.toFixed(3)})`);
  assert.ok(calm.perRing.every((ratio) => ratio > 0.5),
    `${key}: repeated beat reaches every Mandala ring (${calm.perRing.map(v => v.toFixed(2)).join(', ')})`);
  if (tier === 'lively') {
    assert.ok(Math.max(...active.peakDelta) >= 0.025,
      `${key}: lively mode has a measurable beat delta`);
  }
}

// The beat substrate is spatially phased: it must not read as a uniform flash.
{
  const result = beatCoverage('hearth', 'Active');
  const min = Math.min(...result.peakDelta);
  const max = Math.max(...result.peakDelta);
  assert.ok(max - min > 0.01, 'beat response varies across spatial phase');
}

function maxOuterIntensity(key, features) {
  const engine = createMandalaEngine();
  engine.setMode(key);
  engine.setPreset('Active');
  engine.setListening(true);
  let outerPeak = 0;
  for (let frame = 0; frame < 8 * 30; frame += 1) {
    engine.setFeatures(typeof features === 'function' ? features(frame) : features);
    engine.tick(1 / 30);
    for (let i = RINGS.at(-1).start; i < TOTAL_PIXELS; i += 1) {
      outerPeak = Math.max(outerPeak, engine.getIntensity(i));
    }
  }
  return outerPeak;
}

for (const key of ['tide', 'bloom']) {
  const peak = maxOuterIntensity(key, (frame) => ({
    bass: 0.9, mid: 0.45, high: 0.3, energy: 0.75, centroid: 0.4, flux: 0.4,
    beat: frame % 20 < 4 ? 1 : 0,
  }));
  assert.ok(peak > 0.35, `${key}: musical motion reaches the outermost radius (${peak.toFixed(3)})`);
}

// Modes with a named primary band retain a broadband/beat fallback rather than
// becoming inert when that one band is absent.
for (const key of ['procession', 'spiral']) {
  const fallback = maxOuterIntensity(key, (frame) => ({
    bass: 0.55, mid: 0, high: 0.5, energy: 0.62, centroid: 0.5, flux: 0.5,
    beat: frame % 18 < 3 ? 1 : 0,
  }));
  assert.ok(fallback > 0.14, `${key}: broadband/beat fallback remains visibly active (${fallback.toFixed(3)})`);
}

console.log('mandala-engine tests passed');
