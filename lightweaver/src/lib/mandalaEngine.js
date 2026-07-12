// Mandala sound-reactive engine — the compute core of the listening-gallery
// visualizer, extracted from led-art-mapper/mandala-sim/index.html so the Show
// screen preview and the card frame stream share one implementation.
//
// AESTHETIC CONTRACT (binding — see docs/mandala-effects-direction-v2.md and
// docs/mandala-color-system.md, incl. the 2026-07-12 dynamics amendment):
// warm hue corridor only, B ≤ G ≤ R law, audio modulates amplitude/
// probability/position never velocity; attacks are fast (transients must
// survive — see the onset layer), releases stay eased except when a target
// collapses (the field may empty fast after a hit). The master ceiling is
// SUSTAINED: onset peaks may overdrive the wire to full brightness for the
// ~0.3s onset envelope. Under music in the Active preset the field may reach
// TRUE BLACK (the dark gate below); silence and the Calm preset keep the
// dim-coal never-black law exactly. frameRGB applies wire gamma 2.2 (the
// card firmware does NOT gamma-correct); the canvas preview stays linear.
// The constants below were hand-tuned; do NOT "improve" them.
//
// DENSITY (2026-07-13): the pattern shapes itself to the light COUNT via
// `detail` (1 at/above DENSITY_FULL active pixels → authored look byte-for-byte,
// so every dense layout incl. the 675-pixel Mandala is unchanged; → 0 sparse).
// Sparse pieces get fewer/wider geometry features and bigger sparks/hit-blooms
// so a 60-light piece reads as finished as a 600-light one. LOCALIZED HITS: a
// beat also drops a slowly-fading bloom at a PLACE (several alive at once in
// different places), added over the field — you watch each hit land and trail.
//
// No DOM. Rendering (canvas halo look) stays in the Show screen; this module
// only computes per-pixel intensity + palette selection and converts that to
// RGB frames. `createMandalaEngine()` returns an isolated instance (all state
// per-instance so tests and preview never share clocks).

import { createMandalaSpatialTemplate } from './showSpatialTemplate.js';

// ============================================================
//  HARDWARE RING MAP — the real 675-pixel / 5-ring strip.
//  Each pixel: ring index ri, normalized radius rf, angle ang.
// ============================================================
export const RINGS = [
  { start: 0, count: 45, rf: 0.20 },
  { start: 45, count: 90, rf: 0.40 },
  { start: 135, count: 135, rf: 0.60 },
  { start: 270, count: 180, rf: 0.80 },
  { start: 450, count: 225, rf: 1.00 },
];
const R = RINGS.length;
export const TOTAL_PIXELS = 675;
const TOTAL = TOTAL_PIXELS;

export const ringOf = new Int8Array(TOTAL);
export const rfOf = new Float32Array(TOTAL);
export const angOf = new Float32Array(TOTAL);
for (let r = 0; r < R; r++) {
  const Rg = RINGS[r], off = (r % 2) ? Math.PI / Rg.count : 0;
  for (let k = 0; k < Rg.count; k++) {
    const i = Rg.start + k;
    ringOf[i] = r; rfOf[i] = Rg.rf; angOf[i] = (k / Rg.count) * Math.PI * 2 + off;
  }
}

// ---------- helpers ----------
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
function smoothstep(x) { x = clamp01(x); return x * x * (3 - 2 * x); }
function hash01(i, bucket) {
  let h = (Math.imul(i, 0x9E3779B1) ^ Math.imul(bucket, 0x85EBCA77)) | 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12;
  return (h >>> 0 & 0xFFFF) / 65536;
}
function spatialKey(sample) {
  const values = [
    Math.round(sample.x * 4096),
    Math.round(sample.y * 4096),
    Math.round(sample.radius * 4096),
    Math.round(sample.angle * 4096),
    Math.round(sample.stripProgress * 4096),
    Math.round(sample.stripIndex),
  ];
  let h = 0x6D2B79F5;
  for (const value of values) {
    h ^= value;
    h = Math.imul(h ^ (h >>> 15), 0x2C1B3C6D);
  }
  return (h ^ (h >>> 12)) | 0;
}
// per-pixel localized gate: lights only PART of a ring, chosen by angle, so you
// SEE a specific region answer the audio instead of the whole row at once.
function arcGate(ang, nLobes, width, spin) {
  const u = (ang * nLobes / (Math.PI * 2) + spin); const f = u - Math.floor(u);
  const d = Math.min(f, 1 - f) * 2;                 // 0 at arc center, 1 at edge
  return clamp01(1 - d / width);
}
// asymmetric: fast attack, eased release.
function smoothAR(env, x, tauA, tauR, dt) {
  const tau = (x > env) ? tauA : tauR;
  return env + (x - env) * Math.min(1, dt / tau);
}
function onePole(env, x, tau, dt) { return env + (x - env) * Math.min(1, dt / tau); }

// Wire gamma 2.2 — the card streams frame bytes straight into FastLED with NO
// gamma of its own, so frameRGB applies it here (post master/overdrive) via a
// 256-entry LUT. The canvas preview (colorFrame) stays linear: the palettes
// were authored against the canvas, and gamma on the wire makes the LEDs match
// that authored look while the low end goes perceptually black on hardware.
// Endpoints 0→0 and 255→255; monotonic, so B ≤ G ≤ R survives byte-for-byte.
export const WIRE_GAMMA = new Uint8Array(256);
for (let i = 0; i < 256; i++) WIRE_GAMMA[i] = Math.round(255 * Math.pow(i / 255, 2.2));

// ============================================================
//  COLOR SYSTEM (Fable spec) — three warm palettes, one hue
//  corridor. Pre-gamma RGB ramps; incandescent warmth law.
// ============================================================
export const PALETTES = {
  hearth: [[0, 32, 10, 2], [0.18, 120, 38, 8], [0.40, 190, 84, 22], [0.62, 228, 138, 56], [0.82, 248, 190, 96], [1, 255, 224, 168]],
  patina: [[0, 30, 16, 8], [0.20, 92, 56, 26], [0.42, 150, 102, 48], [0.65, 198, 148, 76], [0.85, 232, 192, 120], [1, 250, 226, 178]],
  candle: [[0, 34, 20, 10], [0.20, 96, 66, 38], [0.45, 168, 128, 84], [0.70, 222, 184, 134], [0.88, 246, 218, 172], [1, 255, 238, 204]],
};
export function paletteRamp(stops, i) {
  i = clamp01(i);
  for (let k = 1; k < stops.length; k++) {
    if (i <= stops[k][0]) {
      const a = stops[k - 1], b = stops[k], f = (i - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  const l = stops[stops.length - 1]; return [l[1], l[2], l[3]];
}
function writePaletteRamp(stops, i, out, offset, scale = 1, rounded = false) {
  i = clamp01(i);
  let a = stops[stops.length - 1], b = a, f = 0;
  for (let k = 1; k < stops.length; k++) {
    if (i <= stops[k][0]) {
      a = stops[k - 1]; b = stops[k]; f = (i - a[0]) / (b[0] - a[0]);
      break;
    }
  }
  const r = (a[1] + (b[1] - a[1]) * f) * scale;
  const g = (a[2] + (b[2] - a[2]) * f) * scale;
  const blue = (a[3] + (b[3] - a[3]) * f) * scale;
  out[offset] = rounded ? Math.round(r) : r;
  out[offset + 1] = rounded ? Math.round(g) : g;
  out[offset + 2] = rounded ? Math.round(blue) : blue;
}
// blend two palettes' OUTPUTS at the same intensity (Fable §3b) — stays law-compliant
function palBlend(pa, pb, i, w) {
  const A = paletteRamp(pa, i), B = paletteRamp(pb, i);
  return [lerp(A[0], B[0], w), lerp(A[1], B[1], w), lerp(A[2], B[2], w)];
}

const Z_HEARTH = 0, Z_PATINA = 1, Z_CANDLE = 2;

// ---------- feel presets (Calm / Active) ----------
// Active listens MORE CLOSELY, never faster: deeper modulation, shorter release
// toward (never below) the 2s floor, more embers, fuller Tide. Never touches speed.
export const PRESETS = {
  Calm: { master: 0.75, modDepth: 1.0, relScale: 1.0, emberRate: 1.0, tideCrest: 1.0 },
  Active: { master: 0.82, modDepth: 1.5, relScale: 0.7, emberRate: 2.0, tideCrest: 1.35 },
};

// Per-mode tuning knobs, layered over the preset. Neutral = today's exact look.
// brightness/drive/attack/fade/hit/speed are multipliers (1 = unchanged);
// freq is a −1…+1 tilt (0 = balanced); fill is a 0…1 coverage lift (0 = none).
export const KNOB_DEFAULTS = { brightness: 1, drive: 1, freq: 0, attack: 1, fade: 1, fill: 0, hit: 1, speed: 1 };
export const KNOB_RANGES = {
  brightness: { min: 0.3, max: 1.6, step: 0.02 },
  drive: { min: 0, max: 2.5, step: 0.02 },
  freq: { min: -1, max: 1, step: 0.02 },
  attack: { min: 0.3, max: 3, step: 0.02 },
  fade: { min: 0.3, max: 3, step: 0.02 },
  fill: { min: 0, max: 1, step: 0.02 },
  hit: { min: 0, max: 2.5, step: 0.02 },
  speed: { min: 0.25, max: 3, step: 0.02 },
};
export const KNOB_META = [
  { key: 'brightness', label: 'Brightness', hint: 'Overall level' },
  { key: 'drive', label: 'Drive', hint: 'How hard the music pushes it' },
  { key: 'freq', label: 'Frequency focus', hint: 'Deep bass ↔ bright treble' },
  { key: 'attack', label: 'Attack', hint: 'How instantly it reacts to a hit' },
  { key: 'fade', label: 'Fade', hint: 'How long light lingers after a hit' },
  { key: 'fill', label: 'Fill', hint: 'How much lights up at once' },
  { key: 'hit', label: 'Hit punch', hint: 'Strength of beats landing in places' },
  { key: 'speed', label: 'Motion speed', hint: 'How fast it turns/drifts' },
];

// 2026-07-12 dynamics amendment tunables.
const OVERDRIVE = 0.7;        // wire scale = min(1, master·(1 + OVERDRIVE·evt)) — onset peaks reach full
const GATE_KNEE = 0.015;      // dark gate: true black below this intensity…
const GATE_RAMP = 1 / 0.165;  // …ramping smoothly to unmodified by ≈ knee + 0.165

// 2026-07-13 density amendment: the pattern shapes itself to the pixel COUNT so
// a 60-light piece reads as finished as a 600-light one — coarser geometry,
// wider features (more lights on at once), bigger sparks/hit-blooms. At/above
// DENSITY_FULL active pixels the authored constants are used unchanged (so the
// 675-pixel Mandala — and every dense layout — is byte-identical to before and
// the locked contract holds); below DENSITY_MIN the pattern is at its coarsest.
const DENSITY_FULL = 360;
const DENSITY_MIN = 24;

// Mode metadata for pickers (order = the sim's slow → lively library order).
export const MODE_LIBRARY = [
  { key: 'meridian', name: 'Meridian', tier: 'slow', desc: "A single crisp ring, chosen by the sound's brightness, with light arcs travelling around it that pulse with its band. Minimal, for solo listening.", tech: 'centroid → ring · live band brightness · arcs' },
  { key: 'hearth', name: 'Hearth', tier: 'slow', desc: 'A fireplace: a slow warm bed that visibly swells with the bass — you feel the beat lift the whole fire, then settle.', tech: '20s mood + live bass swell · Hearth' },
  { key: 'embers', name: 'Embers', tier: 'slow', desc: 'True darkness with sparks that ignite and die. Louder music makes more sparks AND brighter ones — quiet passages nearly go dark.', tech: 'high+bass → births · level → brightness · on black' },
  { key: 'strata', name: 'Strata', tier: 'slow', desc: 'The spectrum in the rings — bass at the heart, treble at the rim. Quiet bands go dark, loud bands blaze, so you read the music directly.', tech: 'per-band · live 100ms/0.8s · dark-to-bright' },
  { key: 'tide', name: 'Tide', tier: 'slow', desc: 'A swell of light rising from center to rim on the bass, in two broad lobes, dark between swells. A breath you can see arrive.', tech: 'live bass · 1.2s travel · 2 lobes · Hearth→Candle' },
  { key: 'lattice', name: 'Lattice', tier: 'lively', desc: 'A six-fold standing star that breathes between soft glow and defined star over seconds, slowly turning. The sacred-geometry mode — no snapping.', tech: '6-fold · eased contrast · 25s precession' },
  { key: 'procession', name: 'Procession', tier: 'lively', desc: 'Broad brass arms turning like sun across a wall, one slow revolution a minute or so. Inevitable, like clockwork.', tech: '2 arms · 75s/rev · audio-free rotation · Patina' },
  { key: 'bloom', name: 'Bloom', tier: 'lively', desc: 'An eight-petalled flower opening and drawing back with the bass — the livelier, more articulate cousin of Tide.', tech: 'bass → radius · 3-6s cycle · 8 petals · Hearth' },
  { key: 'spiral', name: 'Spiral', tier: 'lively', desc: 'Arms turning at a watchable middle speed — clearly in motion, slow enough to follow a single arm around. The most active mode.', tech: '3 arms · 15s/rev · mids → brightness · Hearth/Patina' },
];
export const MODE_KEYS = MODE_LIBRARY.map(m => m.key);

export function createMandalaEngine({ template = createMandalaSpatialTemplate() } = {}) {
  // ---------- per-pixel state ----------
  let samples;
  let total;
  let vals;
  let target;
  let zoneOf;
  let crestOf;
  const colorScratchA = new Float32Array(3);
  const colorScratchB = new Float32Array(3);

  // ---------- density (how many lights the pattern has to work with) ----------
  // `detail` is 1 at/above DENSITY_FULL active pixels (authored look preserved
  // exactly) and rolls toward 0 as the piece gets sparse.
  let activeCount = 0;
  let detail = 1;
  // ---------- rings: the program knows how many concentric rings/strips it has,
  // so modes can span the sound across them deliberately (5 on the Mandala).
  let ringCount = 5;
  // integer spatial frequency (petals, arms, teeth) scaled to density: authored
  // at full detail, floored so a sparse piece gets fewer-but-legible features.
  function dLobes(authored, floor) {
    return Math.max(floor, Math.round(authored * (0.4 + 0.6 * detail)));
  }
  // feature width / fill: eased from a wider `sparse` value toward the authored
  // one as density rises, so a thin piece lights more of itself at once.
  function dWide(authored, sparse) { return sparse + (authored - sparse) * detail; }

  function installTemplate(next) {
    const source = Array.isArray(next) ? next : [];
    let minRadius = Infinity;
    let maxRadius = -Infinity;
    samples = source.map((sample, outputIndex) => {
      const hasFiniteRadius = Number.isFinite(sample?.radius);
      const radius = hasFiniteRadius ? Math.max(0, sample.radius) : 0;
      if (hasFiniteRadius) {
        minRadius = Math.min(minRadius, radius);
        maxRadius = Math.max(maxRadius, radius);
      }
      const angle = Number.isFinite(sample?.angle) ? sample.angle : 0;
      const normalized = {
        outputIndex,
        stripId: sample?.stripId === null ? null : (sample?.stripId ?? `strip-${sample?.stripIndex ?? 0}`),
        stripIndex: Number.isFinite(sample?.stripIndex) ? sample.stripIndex : 0,
        stripProgress: clamp01(Number(sample?.stripProgress) || 0),
        x: Number.isFinite(sample?.x) ? sample.x : Math.cos(angle) * radius,
        y: Number.isFinite(sample?.y) ? sample.y : Math.sin(angle) * radius,
        radius,
        angle,
        hasFiniteRadius,
      };
      return { ...normalized, spatialKey: spatialKey(normalized) };
    });
    const radialSpan = maxRadius - minRadius;
    for (const sample of samples) {
      if (sample.hasFiniteRadius && Number.isFinite(radialSpan) && radialSpan > 1e-9) {
        sample.radialProgress = clamp01((sample.radius - minRadius) / radialSpan);
      } else if (sample.stripIndex >= 0 && sample.stripIndex < R) {
        sample.radialProgress = sample.stripIndex / Math.max(1, R - 1);
      } else {
        sample.radialProgress = clamp01(sample.radius);
      }
      delete sample.hasFiniteRadius;
    }
    total = samples.length;
    activeCount = 0;
    const ringSet = new Set();
    for (const sample of samples) {
      if (sample.stripId === null) continue;
      activeCount += 1;
      ringSet.add(sample.stripIndex);
    }
    detail = clamp01((activeCount - DENSITY_MIN) / (DENSITY_FULL - DENSITY_MIN));
    // Rank the distinct strips/rings so each sample carries a contiguous ring
    // index (0…ringCount-1) and modes can spread across the real ring count.
    const ringList = [...ringSet].sort((a, b) => a - b);
    ringCount = Math.max(1, ringList.length);
    const ringRank = new Map(ringList.map((value, index) => [value, index]));
    for (const sample of samples) {
      sample.ringIndex = sample.stripId === null ? 0 : (ringRank.get(sample.stripIndex) ?? 0);
    }
    vals = new Float32Array(total);
    target = new Float32Array(total);
    zoneOf = new Uint8Array(total);
    crestOf = new Float32Array(total);
  }

  installTemplate(template);

  // ---------- per-mode tuning knobs (user-owned, saved as defaults) ----------
  // Eight knobs per mode, layered ON TOP of the Calm/Active preset. Neutral
  // values (1.0 multipliers, 0 offsets) reproduce the preset exactly — so until
  // the user tunes, every mode is byte-identical to today and the locked
  // contract holds. These knobs are now the sanctioned way to change a mode's
  // feel; the hand-tuned constants above stay fixed.
  const modeParams = {};
  for (const key of MODE_KEYS) modeParams[key] = { ...KNOB_DEFAULTS };

  let presetName = 'Calm';
  let P = { ...PRESETS.Calm };   // effective preset = base × knobs (recomputed by applyKnobs)
  let master = PRESETS.Calm.master;
  // live knob-derived scalars (neutral = no change)
  let brightMul = 1, attackMul = 1, freqTilt = 0, fillLift = 0, hitMul = 1, speedMul = 1;
  function applyKnobs() {
    const base = PRESETS[presetName] || PRESETS.Calm;
    const kb = modeParams[mode] || KNOB_DEFAULTS;
    P = {
      master: base.master,
      modDepth: base.modDepth * kb.drive,     // Drive: how hard the music modulates
      relScale: base.relScale * kb.fade,      // Fade: how slowly light lets go
      emberRate: base.emberRate,
      tideCrest: base.tideCrest,
    };
    brightMul = kb.brightness;                // Brightness: output level
    attackMul = kb.attack;                    // Attack: how instantly it reacts
    freqTilt = kb.freq;                       // Frequency focus: deep(−1) ↔ bright(+1)
    fillLift = kb.fill;                       // Fill: how much lights up at once
    hitMul = kb.hit;                          // Hit punch: beat-bloom strength
    speedMul = kb.speed;                      // Motion speed
  }

  // ---------- audio scalars (already smoothed by analyzer) ----------
  const F = { bass: 0, mid: 0, high: 0, energy: 0, centroid: 0.4, flux: 0, beat: 0 };
  const rawFeatures = { ...F };
  let directFeaturesActive = false;
  let listening = false;   // sim's sourceMode!=="rest"
  let sensitivity = 1.0;

  // ---------- onset event layer ----------
  // F.beat crossing detector with hysteresis + refractory. Kicks live in the
  // analyzer arrive fast-attack / ~230ms release; smoothing alone flattens
  // them, so onsets fire a discrete envelope (onsetEnv) that modes ride as
  // geometry pulses. Fires when F.beat crosses ≥0.35 from below; re-arms only
  // after F.beat drops below 0.18 AND 0.12s has passed since the last fire.
  let onsetCount = 0, onsetEnv = 0, lastOnsetStrength = 0, onsetArmed = true, lastOnsetAt = -1;
  let evt = 0;   // per-tick geometry pulse — onsetEnv, preset-gated (Active 1.0 / Calm 0.4)
  let gateEnv = 0, darkGate = 0;   // music-dark gate (Active only — see tick)

  // ---------- localized hit layer (2026-07-13) ----------
  // A beat shouldn't just brighten the whole field — it should land in a PLACE
  // and fade slowly, so you watch the hit arrive and trail off. Several stay
  // alive at once (a fresh beat every ~0.5s, each fading over ~0.7s → overlap),
  // landing in different places. Bloom SIZE scales with density (sparse pieces
  // get bigger blooms); anchor radius follows the sound's brightness (deep hits
  // sit inner, bright hits at the rim). Applied additively in tick — the field
  // still collapses to dark between hits, so the dark-to-bright contract holds.
  const HIT_MAX = 6;
  const hitEnv = new Float32Array(HIT_MAX);  // per-hit fade envelope (1 → 0 over ~0.7s)
  const hitStr = new Float32Array(HIT_MAX);  // onset strength at birth
  const hitAng = new Float32Array(HIT_MAX);  // anchor angle
  const hitRad = new Float32Array(HIT_MAX);  // anchor radius
  let hitCursor = 0;
  function resetHits() { hitEnv.fill(0); hitStr.fill(0); hitAng.fill(0); hitRad.fill(0); hitCursor = 0; }
  function spawnHit(strength) {
    let slot = 0, min = Infinity;             // reuse the faintest slot, never stomp a bright one
    for (let k = 0; k < HIT_MAX; k++) { if (hitEnv[k] < min) { min = hitEnv[k]; slot = k; } }
    hitCursor = (hitCursor + 1) % 4096;
    const jitter = hash01(hitCursor, onsetCount);
    hitAng[slot] = jitter * Math.PI * 2;      // a different place each beat
    hitRad[slot] = clamp01(0.15 + 0.75 * F.centroid + (jitter - 0.5) * 0.25);
    hitStr[slot] = strength;
    hitEnv[slot] = 1;
  }
  function updateHits(dt) {
    for (let k = 0; k < HIT_MAX; k++) {
      if (hitEnv[k] <= 0) continue;
      hitEnv[k] *= Math.exp(-dt / 0.7);       // slow visible fade
      if (hitEnv[k] < 0.003) hitEnv[k] = 0;
    }
  }
  function liveHitCount() {
    let n = 0;
    for (let k = 0; k < HIT_MAX; k++) if (hitEnv[k] > 0.003) n += 1;
    return n;
  }

  function resetTransients() {
    onsetCount = 0; onsetEnv = 0; lastOnsetStrength = 0; onsetArmed = true; lastOnsetAt = -1; evt = 0;
    gateEnv = 0; darkGate = 0;
    resetHits();
  }
  function updateOnsets(t, dt) {
    onsetEnv *= Math.exp(-dt / 0.28);                 // exponential decay, tau 0.28s
    updateHits(dt);
    if (!onsetArmed && F.beat < 0.18 && (t - lastOnsetAt) >= 0.12) onsetArmed = true;
    if (listening && onsetArmed && F.beat >= 0.35) {  // stale F.beat after stop must not fire a phantom
      onsetArmed = false; lastOnsetAt = t;
      lastOnsetStrength = F.beat; onsetCount += 1;
      onsetEnv = Math.max(onsetEnv, lastOnsetStrength);
      spawnHit(lastOnsetStrength);                    // drop a bloom where this beat lands
    }
  }

  // ============================================================
  //  SHARED CLOCKS — the listening time-scales (Fable §2).
  //  FAST attack (~0.05-0.08s — transients survive; the analyzer already
  //  smooths), eased release (~0.6-1.2s); slow *motion* stays slow,
  //  but *reaction* is direct.
  // ============================================================
  const CLK = { bass: 0, mid: 0, high: 0, energy: 0, centroid: 0.4, energyTrend: 0, highTex: 0, highAvg: 0 };
  function updateClocks(t, dt) {
    const rel = 0.9 * P.relScale;                     // release ~0.9s — legible, still eased
    const aA = 1 / attackMul;                         // Attack knob: >1 shortens the attack tau
    CLK.bass = smoothAR(CLK.bass, F.bass, 0.06 * aA, rel, dt);   // LIVE band response
    CLK.mid = smoothAR(CLK.mid, F.mid, 0.07 * aA, rel, dt);
    CLK.high = smoothAR(CLK.high, F.high, 0.05 * aA, rel * 0.8, dt);
    CLK.energy = smoothAR(CLK.energy, F.energy, 0.08 * aA, rel, dt);
    CLK.centroid = smoothAR(CLK.centroid, F.centroid, 0.4, 1.2, dt); // a bit slower — picks the "color" of the sound
    CLK.energyTrend = onePole(CLK.energyTrend, F.energy, 20.0, dt);  // Hearth's slow mood (20s)
    CLK.highAvg = onePole(CLK.highAvg, F.high, 0.6, dt);
    CLK.highTex = clamp01(2.2 * (F.high - CLK.highAvg));             // texture (Embers births)
    if (freqTilt !== 0) {                             // Frequency focus: tilt what the modes hear
      const bassGain = Math.max(0, 1 - 0.7 * freqTilt);
      const highGain = Math.max(0, 1 + 0.7 * freqTilt);
      CLK.bass *= bassGain; CLK.high *= highGain;
      CLK.energy *= 1 + 0.3 * freqTilt * (F.high - F.bass);
    }
  }

  // ============================================================
  //  THE NINE MODES (verbatim from the simulator).
  //  Each fills target[] (intensity), zoneOf[] (palette), crestOf[]
  //  (candle blend). All rotations obey the restraint budget.
  // ============================================================
  // rotation phases (all SLOW — see per-effect periods)
  let strataScallop = 0, meridianRing = 4, meridianTarget = 4, meridianMix = 0, meridianPhase = 0;
  let processTheta = 0, spiralTheta = 0, latticePhase = 0, latticeC = 0.3, tideR = 0.15, tideVal = 0, driftPhase = 0, bloomWob = 0;
  let bloomR = 0.15;
  // ---- 1. Strata (EQ flagship) — the spectrum, real dark-to-bright swing ----
  const strataBand = [0, 0, 0, 0, 0];
  function fxStrata(t, dt) {
    strataScallop += dt * speedMul * 0.20;
    const teeth = dLobes(6, 2);                                    // fewer scallops when sparse
    const fb = freqTilt !== 0 ? F.bass * Math.max(0, 1 - 0.7 * freqTilt) : F.bass;
    const fh = freqTilt !== 0 ? F.high * Math.max(0, 1 + 0.7 * freqTilt) : F.high;
    const band = [fb, 0.5 * fb + 0.5 * F.mid, F.mid, 0.5 * F.mid + 0.5 * fh, fh];
    for (let r = 0; r < strataBand.length; r++) {
      // subtractive quiet floor: a band idling near its noise floor reads as
      // silent and goes dark, instead of the floor being amplified into a glow.
      // Release mirrors the pixel envelope: collapsed band → fast empty, so
      // 120bpm hits land on darkness instead of the last hit's smear.
      const bandTarget = clamp01((band[r] - 0.12) * P.modDepth * 1.42);
      const rel = (bandTarget < 0.35 * strataBand[r] ? 0.28 : 0.8) * P.relScale;
      strataBand[r] = smoothAR(strataBand[r], bandTarget, 0.10, rel, dt);
    }
    for (let i = 0; i < total; i++) {
      const { radialProgress, angle, stripProgress } = samples[i];
      const bandPosition = radialProgress * (strataBand.length - 1);
      const lo = Math.floor(bandPosition), hi = Math.min(strataBand.length - 1, lo + 1);
      let L = lerp(strataBand[lo], strataBand[hi], bandPosition - lo); L *= L;
      L *= 1 + 1.8 * evt;                                            // onsets blaze the loud bands to full
      const ang = angle + stripProgress * 0.01;
      const scallop = 0.75 + 0.25 * Math.sin(teeth * ang + strataScallop); // density-scaled teeth so parts of the ring lead
      target[i] = Math.max(L * scallop, 0.0);                       // no floor — silent band = dark
      zoneOf[i] = radialProgress < 0.375 ? Z_HEARTH : radialProgress < 0.625 ? Z_PATINA : Z_CANDLE;
      crestOf[i] = 0;
    }
    return 'spectrum';
  }

  // ---- 2. Hearth — fireplace mood over ~20s, PLUS a live bass swell ----
  function fxHearth(t, dt) {
    driftPhase += dt * speedMul * 0.06;
    const mood = 0.10 + 0.35 * CLK.energyTrend;    // slow bed (20s)
    const swell = 0.55 * CLK.bass + 0.3 * evt;     // onset kicks the swell, decays with onsetEnv
    const lobes = dLobes(3, 2), width = dWide(0.72, 0.95);          // sparse: fewer, wider swells
    for (let i = 0; i < total; i++) {
      const { radialProgress: rf, angle: ang, spatialKey: seed } = samples[i];
      const local = 0.25 + 0.75 * Math.pow(arcGate(ang, lobes, width, driftPhase + rf * 0.1), 2);
      const base = (mood + swell * local) * (0.85 + 0.15 * Math.sin(lobes * ang + driftPhase + 1.5 * rf));
      // embers of brightness wander with a live hash so it reads as a living fire, not a flat glow
      const flick = 0.85 + 0.15 * hash01(seed, Math.floor(t * 2));
      target[i] = Math.min(1, Math.max(base * flick, 0.015)); // onset-kicked swell must not park pixels above ceiling
      zoneOf[i] = Z_HEARTH; crestOf[i] = clamp01(CLK.centroid - 0.4) * 0.3;
    }
    return 'fireplace';
  }

  // ---- 3. Embers — sparks on true darkness; louder = more AND brighter sparks ----
  function fxEmbers(t, dt) {
    const rate = (0.05 + 1.6 * CLK.highTex + 1.0 * CLK.energy + 1.0 * evt) * P.emberRate; // hits birth extra sparks
    const db = dWide(1, 2.8);                                       // sparse: light a comparable fraction, not fewer sparks
    const ignitionChance = clamp((0.001 + rate * 0.0028) * db, 0.001, 0.05);
    const epochDuration = 0.5;
    const currentEpoch = Math.floor(t / epochDuration);
    let sparkCount = 0;
    for (let i = 0; i < total; i++) {
      const { angle, radialProgress, spatialKey: seed } = samples[i];
      const field = (0.008 + 0.045 * (0.3 * CLK.energy + 0.7 * CLK.highTex)
        * (0.35 + 0.65 * hash01(seed, Math.floor(t * 4)))
        * (0.75 + 0.25 * Math.sin(angle * 5 + radialProgress * 3))) * db;
      target[i] = field; zoneOf[i] = Z_HEARTH; crestOf[i] = 0;

      // Each physical sample owns its ignition history. Looking back across
      // deterministic epochs preserves long spark envelopes without storing a
      // template-relative pixel index or depending on the template's size.
      let spark = 0;
      for (let epoch = currentEpoch - 15; epoch <= currentEpoch; epoch++) {
        if (hash01(seed ^ 0x51ED270B, epoch) >= ignitionChance) continue;
        const born = epoch * epochDuration;
        const life = 3 + hash01(seed ^ 0x27D4EB2D, epoch) * 5;
        const age = (t - born) / life;
        if (age < 0 || age >= 1) continue;
        const env = age < 0.12 ? smoothstep(age / 0.12) : 1 - smoothstep((age - 0.12) / 0.88);
        spark = Math.max(spark, Math.min(1, (0.35 + 0.65 * F.energy) * (1 + 1.2 * evt) * env)); // hits flare live sparks
      }
      if (spark > 0.01) {
        sparkCount += 1;
        target[i] = Math.max(target[i], spark);
        crestOf[i] = clamp01(CLK.centroid - 0.35) * 0.5;
      }
    }
    return sparkCount + ' sparks';
  }

  // ---- 4. Meridian — one crisp ring that BREATHES live with the band it sits on ----
  function fxMeridian(t, dt) {
    meridianPhase += dt * speedMul * 0.04;            // authored 25s cycle; audio never changes velocity
    const ringMax = ringCount - 1;                    // pick among the piece's real rings
    const wantRing = Math.round(clamp(CLK.centroid * ringMax, 0, ringMax));
    if (wantRing !== meridianTarget) { meridianTarget = wantRing; meridianMix = 0; }
    meridianMix = Math.min(1, meridianMix + dt / 6);     // 6s migrate — you can see it move
    // the lit ring's brightness tracks the band it represents, LIVE, with arc detail.
    const bandOfRing = [CLK.bass, CLK.bass, CLK.mid, CLK.high, CLK.high];
    const spin = meridianPhase;
    for (let i = 0; i < total; i++) {
      const { radialProgress, angle } = samples[i];
      const ringPosition = radialProgress * ringMax;
      const distanceToTarget = Math.abs(ringPosition - meridianTarget);
      const distanceToPrior = Math.abs(ringPosition - meridianRing);
      const on = Math.exp(-distanceToTarget * distanceToTarget * 22) * meridianMix
        + Math.exp(-distanceToPrior * distanceToPrior * 22) * (1 - meridianMix);
      const echo = 0.055 * Math.max(0, 1 - distanceToTarget / Math.max(1, ringMax)) * (0.4 + 0.6 * CLK.energy);
      const band = bandOfRing[Math.min(4, Math.round(radialProgress * 4))]; // spectrum slice, ring-count-independent
      const level = 0.03 + 0.97 * band + 2.2 * evt; // near-black when its band is quiet; onsets saturate the ramp top
      const arcW = Math.min(0.9, dWide(0.35, 0.6) + 0.5 * band + 0.25 * evt); // widen with band + onsets + sparseness
      const arc = 0.12 + 0.88 * arcGate(angle, dLobes(3, 2), arcW, spin);
      const neigh = distanceToTarget < 1.4 ? 0.11 * band * (1 - distanceToTarget / 1.4) : 0;
      target[i] = Math.max(0.0, on * level * arc + neigh + echo);
      zoneOf[i] = Z_PATINA; crestOf[i] = 0;
    }
    if (meridianMix >= 1) meridianRing = meridianTarget;
    return 'ring ' + (meridianTarget + 1);
  }

  // ---- 5. Procession — slow brass arms (motion), brightness LIVE with mids ----
  function fxProcession(t, dt) {
    processTheta += dt * speedMul * (2 * Math.PI / 60); // 60s/rev at neutral speed
    const broadband = 0.45 * CLK.energy + 0.30 * CLK.bass + 0.25 * CLK.high;
    const bright = 0.04 + 0.80 * Math.max(CLK.mid, broadband * 0.5, F.beat * 0.35) * P.modDepth + 2.0 * evt; // onsets blaze the arms
    const breadth = dWide(0.38, 0.62) + 0.18 * Math.max(CLK.mid, broadband) + 0.12 * evt; // wider on onsets + sparseness
    const armN = dLobes(2, 1), arm2N = dLobes(3, 2);               // fewer arms when sparse
    for (let i = 0; i < total; i++) {
      const { radialProgress: rf, angle: ang } = samples[i];
      const a = ang - processTheta - 0.9 * rf; const u = a * (armN / (2 * Math.PI)); const f = u - Math.floor(u);
      const dA = Math.min(f, 1 - f) * (2 * Math.PI / armN); let arm = clamp01(1 - dA / breadth); arm = arm * arm;
      const a2 = ang + processTheta * 0.6 - 1.4 * rf; const u2 = a2 * (arm2N / (2 * Math.PI)); const f2 = u2 - Math.floor(u2);
      const dA2 = Math.min(f2, 1 - f2) * (2 * Math.PI / arm2N); let arm2 = clamp01(1 - dA2 / (breadth * 1.3)); arm2 = arm2 * arm2;
      target[i] = Math.max(0.0, bright * Math.max(arm, arm2 * 0.6));   // dark between arms
      zoneOf[i] = Z_PATINA; crestOf[i] = 0;
    }
    return 'procession';
  }

  // ---- 6. Tide — a swell rising center→rim, LIVE and dark between swells ----
  function fxTide(t, dt) {
    tideVal = smoothAR(tideVal, CLK.bass, 0.06, 1.2, dt);  // rides CLK.bass directly; graceful ~1.2s release
    const drive = tideVal * P.tideCrest;
    const targetR = 0.1 + 0.95 * drive; tideR += (targetR - tideR) * Math.min(1, dt / 1.2); // 1.2s travel — visible
    const spin = t * 0.04;
    for (let i = 0; i < total; i++) {
      const { radialProgress: rf, angle } = samples[i];
      const inside = clamp01((tideR - rf) / 0.16 + 1);
      const crest = clamp01(1 - Math.abs(rf - tideR) / 0.14);
      const arc = 0.55 + 0.45 * arcGate(angle, dLobes(2, 1), dWide(0.8, 0.95), spin);  // broad lobes; wider/fewer when sparse
      target[i] = Math.max(0.0, inside * (0.06 + 0.94 * drive) * arc + crest * (drive * 0.4 + 0.25 * evt)); // onsets lift the crest
      zoneOf[i] = Z_HEARTH; crestOf[i] = Math.min(0.85, crest * drive);
    }
    return 'tide';
  }

  // ---- 7. Lattice — 6-fold star, contrast LIVE with bass, dark nodes real ----
  function fxLattice(t, dt) {
    latticePhase += dt * speedMul * (2 * Math.PI / 30); // 30s precession at neutral speed
    latticeC = smoothAR(latticeC, clamp01(0.20 + 0.80 * CLK.bass * P.modDepth + 0.35 * evt), 0.06, 1.0 * P.relScale, dt); // LIVE contrast; onsets sharpen the star
    const level = 0.05 + 0.75 * CLK.energy + 0.8 * evt; // whole star brightens with energy, blazes on hits, near-black when quiet
    const fold = dLobes(6, 3);                                     // fewer star points when sparse
    for (let i = 0; i < total; i++) {
      const { radialProgress: rf, angle: ang, x, y } = samples[i];
      const cartesianPhase = (x * 0.7 + y * 0.3) * F.beat;
      const p = 0.5 + 0.5 * Math.sin(fold * ang + latticePhase + 2.0 * rf + cartesianPhase); const p2 = p * p * p;
      let B = level * ((1 - latticeC) + latticeC * p2);
      const q = 0.5 + 0.5 * Math.sin(2 * fold * ang - 2 * latticePhase);
      B += level * (0.30 * CLK.mid + 0.10 * F.beat) * q * q * q;
      target[i] = Math.max(0.0, Math.min(1, B));         // dark nodes go to zero
      zoneOf[i] = Z_HEARTH; crestOf[i] = 0;
    }
    return '6-fold star';
  }

  // ---- 8. Bloom — 8-petal flower, LIVE bass, dark between petals ----
  function fxBloom(t, dt) {
    bloomWob = 0.6 * Math.sin(0.4 * t);
    bloomR = smoothAR(bloomR, CLK.bass, 0.06, 1.0 * P.relScale, dt);  // LIVE: opens with the bass hit itself
    // flagship: petals expand a little on the bass hit — evt kicks the radius instantly, rides the envelope down
    const Rrad = 0.15 + 0.90 * bloomR * P.modDepth + 0.18 * evt, open = 0.2 + 0.8 * bloomR + 0.15 * evt;
    const petalsN = dLobes(8, 3), sharp = dWide(2, 1.15);          // sparse: fewer, softer/wider petals
    for (let i = 0; i < total; i++) {
      const { radialProgress: rf, angle: ang } = samples[i];
      const radial = clamp01((Rrad - rf) / 0.18 + 1);
      const fr = clamp01(1 - Math.abs(rf - Rrad) / 0.15);
      const trail = clamp01(1 - Math.abs(rf - (Rrad - 0.16)) / 0.24);
      const petal = Math.pow(0.5 + 0.5 * Math.sin(petalsN * ang + bloomWob), sharp); // density-scaled petals with dark gaps
      let B = radial * (0.04 + 0.96 * petal) * open;                        // petals clearly separated, near-black between
      B += fr * petal * 0.4 + trail * petal * (0.08 + 0.12 * CLK.energy);
      target[i] = Math.max(0.0, Math.min(1, B));
      zoneOf[i] = Z_HEARTH; crestOf[i] = fr * 0.3;
    }
    return 'flower';
  }

  // ---- 9. Spiral (gallery-grade, middle speed) — 1 rev / 15s ----
  function fxSpiral(t, dt) {
    spiralTheta += dt * speedMul * (2 * Math.PI / 15);  // 15s/rev at neutral speed — watchable
    const broadband = 0.45 * CLK.energy + 0.30 * CLK.bass + 0.25 * CLK.high;
    const bright = 0.05 + 0.85 * Math.max(CLK.mid, broadband * 0.55, F.beat * 0.4) * P.modDepth + 1.2 * evt, halfW = dWide(0.35, 0.6) + 0.12 * evt; // blaze + widen on onsets + sparseness
    const armN = dLobes(3, 2);                                      // fewer arms when sparse
    for (let i = 0; i < total; i++) {
      const { radialProgress: rf, angle: ang, stripProgress } = samples[i];
      const beatTravel = F.beat * (0.15 + 0.2 * rf) * Math.sin(Math.PI * 2 * stripProgress + 3 * rf);
      const a = ang - spiralTheta - 1.4 * rf - beatTravel;
      const u = a * (armN / (2 * Math.PI)); const f = u - Math.floor(u);
      const dA = Math.min(f, 1 - f) * (2 * Math.PI / armN);
      let arm = clamp01(1 - dA / halfW); arm = arm * arm;
      target[i] = Math.max(0.0, arm * bright);          // dark between arms — real contrast
      zoneOf[i] = arm > 0.3 ? Z_HEARTH : Z_PATINA; crestOf[i] = arm * rf * 0.25;
    }
    return 'spiral';
  }

  const STEPS = {
    meridian: fxMeridian, hearth: fxHearth, embers: fxEmbers, strata: fxStrata, tide: fxTide,
    lattice: fxLattice, procession: fxProcession, bloom: fxBloom, spiral: fxSpiral,
  };
  let mode = 'strata';
  applyKnobs();   // now that `mode` exists, resolve the effective preset

  // ---- silence: decay to a dim idle of the mode's own character ----
  let presence = 0;
  let time = 0;

  // ============================================================
  //  AUDIO — band analysis + per-band auto-leveler (AGC).
  //  Accepts an AnalyserNode (reads bins itself) or raw Uint8Array
  //  bins + sampleRate (tests, non-DOM callers).
  // ============================================================
  const AGC = { bass: { lo: 0.02, hi: 0.25 }, mid: { lo: 0.02, hi: 0.25 }, high: { lo: 0.01, hi: 0.15 } };
  let binScratch = null;
  function level(name, raw) {
    const g = AGC[name];
    if (raw < g.lo) g.lo += (raw - g.lo) * 0.20; else g.lo += (raw - g.lo) * 0.004;
    if (raw > g.hi) g.hi += (raw - g.hi) * 0.30; else g.hi += (raw - g.hi) * 0.010;
    const span = Math.max(0.04, g.hi - g.lo);
    return clamp01(((raw - g.lo) / span) * sensitivity);
  }
  function applyBands(bass, mid, high) {
    directFeaturesActive = false;
    const energy = clamp01(bass * 0.5 + mid * 0.35 + high * 0.25);
    const centroid = clamp01((mid * 0.4 + high * 0.9) / (bass * 0.9 + 0.3));
    const up = (o, v, ua, da) => o + (v - o) * (v > o ? ua : da);
    F.bass = up(F.bass, bass, 0.60, 0.14); F.mid = up(F.mid, mid, 0.55, 0.16); F.high = up(F.high, high, 0.70, 0.20);
    F.energy = up(F.energy, energy, 0.5, 0.10); F.centroid = up(F.centroid, centroid, 0.2, 0.05);
    F.flux = 0;
    F.beat = 0;
  }
  function applyDirectFeatures() {
    const shape = (value) => value <= 0 ? 0 : value >= 1 ? 1 : Math.pow(value, 1 / sensitivity);
    F.bass = shape(rawFeatures.bass);
    F.mid = shape(rawFeatures.mid);
    F.high = shape(rawFeatures.high);
    F.energy = shape(rawFeatures.energy);
    F.centroid = rawFeatures.centroid;
    F.flux = shape(rawFeatures.flux);
    F.beat = shape(rawFeatures.beat);
  }
  function setFeatures(features = {}) {
    rawFeatures.bass = clamp01(Number(features.bass) || 0);
    rawFeatures.mid = clamp01(Number(features.mid) || 0);
    rawFeatures.high = clamp01(Number(features.high) || 0);
    rawFeatures.energy = clamp01(Number(features.energy) || 0);
    rawFeatures.centroid = clamp01(Number(features.centroid) || 0);
    rawFeatures.flux = clamp01(Number(features.flux) || 0);
    rawFeatures.beat = clamp01(Number(features.beat) || 0);
    directFeaturesActive = true;
    applyDirectFeatures();
  }
  function analyze(analyserOrBins, sampleRate = 44100) {
    if (!listening) return false;
    let freqData, rate;
    if (analyserOrBins && typeof analyserOrBins.getByteFrequencyData === 'function') {
      const analyser = analyserOrBins;
      if (!binScratch || binScratch.length !== analyser.frequencyBinCount) {
        binScratch = new Uint8Array(analyser.frequencyBinCount);
      }
      analyser.getByteFrequencyData(binScratch);
      freqData = binScratch;
      rate = analyser.context?.sampleRate || sampleRate;
    } else if (analyserOrBins && analyserOrBins.length) {
      freqData = analyserOrBins;
      rate = sampleRate;
    } else {
      return false;
    }
    const binHz = (rate / 2) / freqData.length;
    const band = (lo, hi) => {
      let mx = 0;
      const a = Math.floor(lo / binHz), b = Math.min(freqData.length - 1, Math.floor(hi / binHz));
      for (let i = a; i <= b; i++) { if (freqData[i] > mx) mx = freqData[i]; }
      return mx / 255;
    };
    applyBands(level('bass', band(30, 140)), level('mid', band(150, 1800)), level('high', band(2000, 9000)));
    return true;
  }

  // ============================================================
  //  FRAME STEP — clocks, mode step, silence handling, envelope.
  // ============================================================
  function tick(dt) {
    dt = Math.min(0.05, Math.max(0, Number(dt) || 0));
    time += dt;
    const t = time;

    const Ptarget = !listening ? 0 : clamp01((F.energy - 0.05) / 0.30);
    presence += (Ptarget - presence) * (Ptarget > presence ? (1 - Math.exp(-dt / 0.6)) : (1 - Math.exp(-dt / 8))); // silence eases over ~8s

    // Music-dark gate (2026-07-12 amendment): under music in Active the field
    // may reach TRUE BLACK. The gate rides its own quick envelope, not the
    // ~8s presence decay — it must close ahead of the field's fast collapse
    // (release k=7 below) or the returning coal idle would be crushed to
    // black mid-transition. Silence → gate 0 → the coal law holds untouched.
    // fxHearth is exempt (its fireplace bed is the mode's identity); the
    // check is on the MODE, not the Hearth palette other modes borrow.
    gateEnv = smoothAR(gateEnv, Ptarget, 0.5, 0.25, dt);
    darkGate = (presetName === 'Active' && listening && mode !== 'hearth') ? gateEnv : 0;

    updateOnsets(t, dt);
    evt = onsetEnv * (presetName === 'Active' ? 1.0 : 0.4);   // preset-gated geometry pulse
    updateClocks(t, dt);
    const lead = (STEPS[mode] || fxStrata)(t, dt);

    // Fill knob: raise how much of the piece is lit at once, lifting the dark
    // toward mid without over-brightening what's already lit. Scaled by presence
    // so silence still hands off to the coal idle; Embers keeps its dark canvas.
    if (fillLift > 0 && mode !== 'embers') {
      const lift = fillLift * 0.35 * presence;
      for (let i = 0; i < total; i++) target[i] += lift * (1 - clamp01(target[i]));
    }

    // Ungated coal-glow floor: wire gamma crushes intensities below ~0.08 to
    // 1–3 LSB, so the never-black law needs a working floor on the LEDs where
    // it still applies. Scaled by presence (silence hands off to the 0.03 idle
    // below, byte-identical to before) and faded by the dark gate (Active
    // music crushes it to true black — the knee sits just above this floor).
    // Embers is exempt: its authored canvas IS the darkness. Applied BEFORE
    // the substrate so beats ripple through the glow field, not under it.
    const glow = 0.15 * presence * (1 - darkGate);
    if (glow > 0.001 && mode !== 'embers') {
      for (let i = 0; i < total; i++) {
        if (target[i] < glow) target[i] = glow;
      }
    }

    // A restrained, spatially phased beat substrate belongs to every mode.
    // The lift is weighted by the pixel's EXISTING light — 4·b·(1−b) peaks at
    // mid-intensity and vanishes at black and at full — so beats sharpen the
    // lit structure instead of graying the darkness (2026-07-12 amendment).
    const beatDepth = (presetName === 'Active' ? 0.22 : 0.08) * F.beat;
    if (beatDepth > 0) {
      for (let i = 0; i < total; i++) {
        const { x, y, radialProgress, angle, stripIndex, stripProgress } = samples[i];
        const phase = angle * 2 + radialProgress * 4.5 + stripIndex * 0.37
          + stripProgress * Math.PI * 2 + x * 0.6 - y * 0.4;
        const spatial = 0.28 + 0.72 * (0.5 + 0.5 * Math.sin(phase - t * 1.1));
        const base = clamp01(target[i]);
        target[i] = base + beatDepth * spatial * (4 * base * (1 - base));
      }
    }

    // Localized hit blooms: each live hit adds a slowly-fading glow at its own
    // place, so a beat is a visible event you can watch land and trail — and
    // several overlap in different places. Additive over the (already dark
    // between beats) field. Active gets the full event; Calm a gentle echo.
    if (liveHitCount() > 0) {
      const hitGain = (presetName === 'Active' ? 1.6 : 0.5) * hitMul;
      const angSpread = dWide(0.55, 1.15);   // sparse pieces: wider blooms cover more lights
      const radSpread = dWide(0.18, 0.42);
      for (let i = 0; i < total; i++) {
        const { radialProgress: rf, angle: ang } = samples[i];
        let add = 0;
        for (let k = 0; k < HIT_MAX; k++) {
          const e = hitEnv[k];
          if (e <= 0.003) continue;
          let da = Math.abs(ang - hitAng[k]);
          if (da > Math.PI) da = Math.PI * 2 - da;
          const af = 1 - da / angSpread;
          if (af <= 0) continue;
          const rff = 1 - Math.abs(rf - hitRad[k]) / radSpread;
          if (rff <= 0) continue;
          add += e * hitStr[k] * af * af * rff;
        }
        if (add > 0) target[i] += hitGain * add;
      }
    }

    // silence handling: fade toward a very dim coal idle over ~8s (barely-there, not a glow).
    if (presence < 0.99) {
      const idle = 0.03;
      for (let i = 0; i < total; i++) {
        target[i] = Math.max(idle * (1 - samples[i].radialProgress * 0.5), target[i] * presence + idle * (1 - presence));
      }
    }

    // per-pixel eased envelope (anti-flicker, never snaps). Release is
    // adaptive: k=2.2 eases small modulations gracefully, but when the target
    // has COLLAPSED (fallen below 35% of the pixel) k=7 empties the field fast
    // enough that 120bpm hits land on darkness instead of last hit's afterglow.
    for (let i = 0; i < total; i++) {
      const k = target[i] > vals[i] ? 26 * attackMul : (target[i] < 0.35 * vals[i] ? 7 : 2.2);
      vals[i] += (target[i] - vals[i]) * (1 - Math.exp(-k * dt));
    }
    return lead;
  }

  // dark-gate factor: with the gate fully on, intensity below GATE_KNEE
  // renders true black, ramping smoothly to unmodified by v ≈ 0.09. Uniform
  // per-pixel RGB scaling preserves B ≤ G ≤ R by construction. One smoothstep
  // per pixel, no pow, no allocation — hot-path safe.
  function gateScale(v) {
    return darkGate > 0 ? 1 - darkGate * (1 - smoothstep((v - GATE_KNEE) * GATE_RAMP)) : 1;
  }

  // per-pixel palette + incandescent color. These values are PRE-gamma and
  // pre-master (the canvas preview's linear space); frameRGB owns the wire
  // gamma 2.2 — the card firmware applies NO gamma of its own.
  function colorFor(i, v) {
    const z = zoneOf[i], crest = crestOf[i];
    const g = gateScale(v);
    let c;
    if (z === Z_HEARTH) {
      c = crest > 0.001 ? palBlend(PALETTES.hearth, PALETTES.candle, v, crest) : paletteRamp(PALETTES.hearth, v);
    } else {
      c = paletteRamp(z === Z_PATINA ? PALETTES.patina : PALETTES.candle, v);
    }
    if (g < 1) { c[0] *= g; c[1] *= g; c[2] *= g; }
    return c;
  }

  function writeColorFor(i, v, out, offset, scale = 1, rounded = false) {
    scale *= gateScale(v);
    const z = zoneOf[i], crest = crestOf[i];
    if (z === Z_HEARTH && crest > 0.001) {
      writePaletteRamp(PALETTES.hearth, v, colorScratchA, 0);
      writePaletteRamp(PALETTES.candle, v, colorScratchB, 0);
      const r = lerp(colorScratchA[0], colorScratchB[0], crest) * scale;
      const g = lerp(colorScratchA[1], colorScratchB[1], crest) * scale;
      const b = lerp(colorScratchA[2], colorScratchB[2], crest) * scale;
      out[offset] = rounded ? Math.round(r) : r;
      out[offset + 1] = rounded ? Math.round(g) : g;
      out[offset + 2] = rounded ? Math.round(b) : b;
      return;
    }
    const palette = z === Z_HEARTH ? PALETTES.hearth : z === Z_PATINA ? PALETTES.patina : PALETTES.candle;
    writePaletteRamp(palette, v, out, offset, scale, rounded);
  }

  // Buffer-reuse API: compute every pixel's pre-master color ONCE into `out`
  // (Float32Array, sample-count*3 — same values colorAt returns, no allocation when
  // the buffer is reused). The Show screen shares this buffer between the
  // canvas paint and frameRGB so the palette walk runs once per frame instead
  // of twice per pixel.
  function colorFrame(out) {
    const buf = (out && out.length === total * 3) ? out : new Float32Array(total * 3);
    for (let i = 0; i < total; i++) {
      if (samples[i].stripId === null) {
        buf[i * 3] = 0; buf[i * 3 + 1] = 0; buf[i * 3 + 2] = 0;
        continue;
      }
      writeColorFor(i, clamp01(vals[i]), buf, i * 3);
    }
    return buf;
  }

  // The LED frame: ramp output scaled by the wire scale, then gamma 2.2 via
  // the precomputed WIRE_GAMMA LUT (linear scale + monotonic LUT, so the
  // B≤G≤R warmth law survives — see color spec §2 corollary). The SUSTAINED
  // ceiling stays `master`; onset peaks overdrive toward full for the ~0.3s
  // onset envelope. min(1,·) means only palette tops can reach 255 — channels
  // are never boosted, so the corridor holds. evt is preset-gated: Calm's
  // ×0.4 keeps its overdrive negligible.
  // Pass a colorFrame() buffer as `colors` to skip recomputing the palette
  // walk when the colors were already computed for the preview paint.
  function frameRGB(out, colors) {
    const buf = (out && out.length === total * 3) ? out : new Uint8Array(total * 3);
    const scale = Math.min(1, master * brightMul * (1 + OVERDRIVE * evt));
    if (colors && colors.length === total * 3) {
      for (let i = 0; i < total; i++) {
        if (samples[i].stripId === null) {
          buf[i * 3] = 0; buf[i * 3 + 1] = 0; buf[i * 3 + 2] = 0;
        } else {
          buf[i * 3] = WIRE_GAMMA[Math.round(colors[i * 3] * scale)];
          buf[i * 3 + 1] = WIRE_GAMMA[Math.round(colors[i * 3 + 1] * scale)];
          buf[i * 3 + 2] = WIRE_GAMMA[Math.round(colors[i * 3 + 2] * scale)];
        }
      }
      return buf;
    }
    for (let i = 0; i < total; i++) {
      const o = i * 3;
      if (samples[i].stripId === null) {
        buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0;
        continue;
      }
      writeColorFor(i, clamp01(vals[i]), buf, o, scale, true);
      buf[o] = WIRE_GAMMA[buf[o]]; buf[o + 1] = WIRE_GAMMA[buf[o + 1]]; buf[o + 2] = WIRE_GAMMA[buf[o + 2]];
    }
    return buf;
  }

  return {
    // frame step
    tick,
    frameRGB,
    colorFrame,
    // audio in
    analyze,
    setFeatures,
    setBands(bands = {}) {
      applyBands(clamp01(Number(bands.bass) || 0), clamp01(Number(bands.mid) || 0), clamp01(Number(bands.high) || 0));
    },
    setListening(on) {
      listening = Boolean(on);
      if (!listening) resetTransients();   // feature state clears with the source
    },
    isListening() { return listening; },
    setSensitivity(x) {
      sensitivity = clamp(Number(x) || 1, 0.3, 3);
      if (directFeaturesActive) applyDirectFeatures();
    },
    getSensitivity() { return sensitivity; },
    // mode / preset / master
    setMode(key) { if (STEPS[key]) { mode = key; applyKnobs(); } },
    getMode() { return mode; },
    setPreset(name) {
      if (!PRESETS[name]) return;
      presetName = name; master = PRESETS[name].master; applyKnobs();
    },
    getPreset() { return presetName; },
    setMaster(x) { master = clamp(Number(x) || 0.75, 0.2, 0.85); },
    getMaster() { return master; },
    getRenderMaster() { return master * brightMul; },   // canvas preview honors the Brightness knob
    // ---- per-mode tuning knobs ----
    setModeParam(modeKey, knob, value) {
      const target = modeParams[modeKey];
      if (!target || !(knob in KNOB_DEFAULTS)) return;
      const range = KNOB_RANGES[knob];
      target[knob] = clamp(Number(value), range.min, range.max);
      if (modeKey === mode) applyKnobs();
    },
    setModeParams(modeKey, values = {}) {
      const target = modeParams[modeKey];
      if (!target) return;
      for (const knob of Object.keys(KNOB_DEFAULTS)) {
        if (values[knob] === undefined) continue;
        const range = KNOB_RANGES[knob];
        target[knob] = clamp(Number(values[knob]), range.min, range.max);
      }
      if (modeKey === mode) applyKnobs();
    },
    getModeParams(modeKey) { return { ...(modeParams[modeKey] || KNOB_DEFAULTS) }; },
    getAllModeParams() {
      const out = {};
      for (const key of MODE_KEYS) out[key] = { ...modeParams[key] };
      return out;
    },
    resetModeParams(modeKey) {
      if (modeParams[modeKey]) modeParams[modeKey] = { ...KNOB_DEFAULTS };
      if (modeKey === mode) applyKnobs();
    },
    setTemplate(next) {
      installTemplate(next);
    },
    // introspection (meters, status line, preview render)
    getLevels() { return { ...F }; },
    getTransients() {
      return {
        onsetCount,
        onsetEnv,
        lastOnsetStrength,
        liveHits: liveHitCount(),
        clocks: { bass: CLK.bass, mid: CLK.mid, high: CLK.high, energy: CLK.energy },
      };
    },
    getDensity() { return { activeCount, detail, ringCount }; },
    getPresence() { return presence; },
    getIntensity(i) { return vals[i]; },
    colorAt(i) { return colorFor(i, clamp01(vals[i])); },
  };
}

// ============================================================
//  ADAPTERS — resample + hex encode, shared by stream and tests.
// ============================================================

// Map the 675-pixel / 5-ring frame onto an arbitrary project pixel count.
// The source layout is ring-major (ring 1 pixels first, then ring 2, ...), so
// nearest-index resampling over the flat array IS nearest-ring-position:
// each target pixel lands on the source pixel occupying the same fractional
// place in the ring walk. Cards with fewer LEDs get a faithful thinned frame.
export function resampleFrame(rgb, targetCount, out) {
  const srcCount = Math.floor(rgb.length / 3);
  const n = Math.max(1, Math.floor(Number(targetCount) || 0));
  if (n === srcCount) return rgb;
  const buf = (out && out.length === n * 3) ? out : new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    const src = Math.min(srcCount - 1, Math.floor(((i + 0.5) * srcCount) / n)) * 3;
    buf[i * 3] = rgb[src];
    buf[i * 3 + 1] = rgb[src + 1];
    buf[i * 3 + 2] = rgb[src + 2];
  }
  return buf;
}

const HEX = '0123456789ABCDEF';
function byteHex(b) { return HEX[(b >> 4) & 0xF] + HEX[b & 0xF]; }

// Uint8Array RGB triples → ["RRGGBB", ...] (the WLED seg.i wire format).
export function frameToHex(rgb, out) {
  const n = Math.floor(rgb.length / 3);
  const arr = (Array.isArray(out) && out.length === n) ? out : new Array(n);
  for (let i = 0; i < n; i++) {
    arr[i] = byteHex(rgb[i * 3]) + byteHex(rgb[i * 3 + 1]) + byteHex(rgb[i * 3 + 2]);
  }
  return arr;
}
