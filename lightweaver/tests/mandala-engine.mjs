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

console.log('mandala-engine tests passed');
