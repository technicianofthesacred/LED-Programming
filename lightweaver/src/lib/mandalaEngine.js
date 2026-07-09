// Mandala sound-reactive engine — the compute core of the listening-gallery
// visualizer, extracted from led-art-mapper/mandala-sim/index.html so the Show
// screen preview and the card frame stream share one implementation.
//
// AESTHETIC CONTRACT (binding — see docs/mandala-effects-direction-v2.md and
// docs/mandala-color-system.md): warm hue corridor only, B ≤ G ≤ R law, audio
// modulates amplitude/probability/position never velocity, min attack 250ms /
// release ~2s, brightness ceiling ~75%, silence decays over seconds to a dim
// coal field — never black, never frozen. The constants below were hand-tuned
// in the simulator; do NOT "improve" them.
//
// No DOM. Rendering (canvas halo look) stays in the Show screen; this module
// only computes per-pixel intensity + palette selection and converts that to
// RGB frames. `createMandalaEngine()` returns an isolated instance (all state
// per-instance so tests and preview never share clocks).

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

// Mode metadata for pickers (order = the sim's slow → lively library order).
export const MODE_LIBRARY = [
  { key: 'meridian', name: 'Meridian', tier: 'slow', desc: "A single crisp ring, chosen by the sound's brightness, with light arcs travelling around it that pulse with its band. Minimal, for solo listening.", tech: 'centroid → ring · live band brightness · arcs' },
  { key: 'hearth', name: 'Hearth', tier: 'slow', desc: 'A fireplace: a slow warm bed that visibly swells with the bass — you feel the beat lift the whole fire, then settle.', tech: '20s mood + live bass swell · Hearth' },
  { key: 'embers', name: 'Embers', tier: 'slow', desc: 'True darkness with sparks that ignite and die. Louder music makes more sparks AND brighter ones — quiet passages nearly go dark.', tech: 'high+bass → births · level → brightness · on black' },
  { key: 'strata', name: 'Strata', tier: 'slow', desc: 'The spectrum in the rings — bass at the heart, treble at the rim. Quiet bands go dark, loud bands blaze, so you read the music directly.', tech: 'per-band · live 200ms/0.8s · dark-to-bright' },
  { key: 'tide', name: 'Tide', tier: 'slow', desc: 'A swell of light rising from center to rim on the bass, in two broad lobes, dark between swells. A breath you can see arrive.', tech: 'bass ~1s · 2.5s travel · 2 lobes · Hearth→Candle' },
  { key: 'lattice', name: 'Lattice', tier: 'lively', desc: 'A six-fold standing star that breathes between soft glow and defined star over seconds, slowly turning. The sacred-geometry mode — no snapping.', tech: '6-fold · eased contrast · 25s precession' },
  { key: 'procession', name: 'Procession', tier: 'lively', desc: 'Broad brass arms turning like sun across a wall, one slow revolution a minute or so. Inevitable, like clockwork.', tech: '2 arms · 75s/rev · audio-free rotation · Patina' },
  { key: 'bloom', name: 'Bloom', tier: 'lively', desc: 'An eight-petalled flower opening and drawing back with the bass — the livelier, more articulate cousin of Tide.', tech: 'bass → radius · 3-6s cycle · 8 petals · Hearth' },
  { key: 'spiral', name: 'Spiral', tier: 'lively', desc: 'Arms turning at a watchable middle speed — clearly in motion, slow enough to follow a single arm around. The most active mode.', tech: '3 arms · 15s/rev · mids → brightness · Hearth/Patina' },
];
export const MODE_KEYS = MODE_LIBRARY.map(m => m.key);

export function createMandalaEngine() {
  // ---------- per-pixel state ----------
  const vals = new Float32Array(TOTAL);      // eased displayed intensity
  const target = new Float32Array(TOTAL);    // per-frame target intensity
  const zoneOf = new Uint8Array(TOTAL);      // 0=hearth 1=patina 2=candle
  const crestOf = new Float32Array(TOTAL);   // 0..1 blend toward candle (for Tide etc)

  let P = PRESETS.Calm;
  let presetName = 'Calm';
  let master = P.master;

  // ---------- audio scalars (already smoothed by analyzer) ----------
  const F = { bass: 0, mid: 0, high: 0, energy: 0, centroid: 0.4 };
  let listening = false;   // sim's sourceMode!=="rest"
  let sensitivity = 1.0;

  // ============================================================
  //  SHARED CLOCKS — the listening time-scales (Fable §2).
  //  LIVE reaction (attack ~0.2-0.4s, release ~0.6-1.2s); slow
  //  *motion* stays slow, but *reaction* is direct.
  // ============================================================
  const CLK = { bass: 0, mid: 0, high: 0, energy: 0, centroid: 0.4, energyTrend: 0, highTex: 0, highAvg: 0 };
  function updateClocks(t, dt) {
    const rel = 0.9 * P.relScale;                     // release ~0.9s — legible, still eased
    CLK.bass = smoothAR(CLK.bass, F.bass, 0.20, rel, dt);   // LIVE band response
    CLK.mid = smoothAR(CLK.mid, F.mid, 0.22, rel, dt);
    CLK.high = smoothAR(CLK.high, F.high, 0.18, rel * 0.8, dt);
    CLK.energy = smoothAR(CLK.energy, F.energy, 0.20, rel, dt);
    CLK.centroid = smoothAR(CLK.centroid, F.centroid, 0.4, 1.2, dt); // a bit slower — picks the "color" of the sound
    CLK.energyTrend = onePole(CLK.energyTrend, F.energy, 20.0, dt);  // Hearth's slow mood (20s)
    CLK.highAvg = onePole(CLK.highAvg, F.high, 0.6, dt);
    CLK.highTex = clamp01(2.2 * (F.high - CLK.highAvg));             // texture (Embers births)
  }

  // ============================================================
  //  THE NINE MODES (verbatim from the simulator).
  //  Each fills target[] (intensity), zoneOf[] (palette), crestOf[]
  //  (candle blend). All rotations obey the restraint budget.
  // ============================================================
  // rotation phases (all SLOW — see per-effect periods)
  let strataScallop = 0, meridianRing = 4, meridianTarget = 4, meridianMix = 0;
  let processTheta = 0, spiralTheta = 0, latticePhase = 0, latticeC = 0.3, tideR = 0.15, tideVal = 0, driftPhase = 0, bloomWob = 0;
  let bloomR = 0.15;
  const embers = []; // {i, born, life, peak}

  // ---- 1. Strata (EQ flagship) — the spectrum, real dark-to-bright swing ----
  const strataRing = [0, 0, 0, 0, 0];
  function fxStrata(t, dt) {
    strataScallop += dt * 0.20;
    const band = [F.bass, 0.5 * F.bass + 0.5 * F.mid, F.mid, 0.5 * F.mid + 0.5 * F.high, F.high];
    for (let r = 0; r < R; r++) { // LIVE: attack ~200ms, release ~0.8s — the ring answers within a beat
      strataRing[r] = smoothAR(strataRing[r], clamp01(band[r] * P.modDepth * 1.2), 0.20, 0.8 * P.relScale, dt);
    }
    for (let i = 0; i < TOTAL; i++) {
      const ri = ringOf[i], ang = angOf[i];
      let L = strataRing[ri]; L = L * L;                            // strong gamma: quiet bands go DARK
      const scallop = 0.75 + 0.25 * Math.sin(6 * ang + strataScallop); // deeper 6-tooth so parts of the ring lead
      target[i] = Math.max(L * scallop, 0.0);                       // no floor — silent band = dark
      zoneOf[i] = ri <= 1 ? Z_HEARTH : ri === 2 ? Z_PATINA : Z_CANDLE;
      crestOf[i] = 0;
    }
    return 'spectrum';
  }

  // ---- 2. Hearth — fireplace mood over ~20s, PLUS a live bass swell ----
  function fxHearth(t, dt) {
    driftPhase += dt * 0.06;
    const mood = 0.10 + 0.35 * CLK.energyTrend;    // slow bed (20s)
    const swell = 0.55 * CLK.bass;                  // LIVE: bass visibly brightens the whole hearth
    for (let i = 0; i < TOTAL; i++) {
      const rf = rfOf[i], ang = angOf[i];
      const base = (mood + swell) * (0.85 + 0.15 * Math.sin(3 * ang + driftPhase + 1.5 * rf));
      // embers of brightness wander with a live hash so it reads as a living fire, not a flat glow
      const flick = 0.85 + 0.15 * hash01(i, Math.floor(t * 2));
      target[i] = Math.max(base * flick, 0.015);
      zoneOf[i] = Z_HEARTH; crestOf[i] = clamp01(CLK.centroid - 0.4) * 0.3;
    }
    return 'fireplace';
  }

  // ---- 3. Embers — sparks on true darkness; louder = more AND brighter sparks ----
  function fxEmbers(t, dt) {
    // rate AND count scale with the music so loud passages are visibly a field of embers,
    // quiet ones just a few. Bigger multiplier so the difference is obvious.
    const rate = (0.05 + 1.6 * CLK.highTex + 1.0 * CLK.energy) * P.emberRate;
    const cap = Math.round(6 + 44 * CLK.energy);      // few sparks when quiet, many when loud
    if (embers.length < cap && hash01(Math.floor(t * 111), embers.length) < rate * dt * 10) {
      const i = (hash01(Math.floor(t * 137), embers.length * 7) * TOTAL) | 0;
      embers.push({ i, born: t, life: 3 + hash01(i, 3) * 5, peak: 0.35 + 0.65 * F.energy }); // peak scales with level
    }
    for (let i = 0; i < TOTAL; i++) { target[i] = 0.0; zoneOf[i] = Z_HEARTH; crestOf[i] = 0; } // truly dark canvas
    for (let e = embers.length - 1; e >= 0; e--) {
      const em = embers[e]; const a = (t - em.born) / em.life;
      if (a >= 1) { embers.splice(e, 1); continue; }
      const env = a < 0.12 ? smoothstep(a / 0.12) : (1 - smoothstep((a - 0.12) / 0.88));
      target[em.i] = Math.max(target[em.i], em.peak * env);
      crestOf[em.i] = clamp01(CLK.centroid - 0.35) * 0.5;
    }
    return embers.length + ' sparks';
  }

  // ---- 4. Meridian — one crisp ring that BREATHES live with the band it sits on ----
  function fxMeridian(t, dt) {
    const wantRing = Math.round(clamp(CLK.centroid * 4, 0, 4));
    if (wantRing !== meridianTarget) { meridianTarget = wantRing; meridianMix = 0; }
    meridianMix = Math.min(1, meridianMix + dt / 6);     // 6s migrate — you can see it move
    // the lit ring's brightness tracks the band it represents, LIVE, with arc detail.
    const bandOfRing = [CLK.bass, CLK.bass, CLK.mid, CLK.high, CLK.high];
    const spin = t * (0.04 + 0.4 * CLK.energy);          // arcs sweep faster when louder
    for (let i = 0; i < TOTAL; i++) {
      const ri = ringOf[i];
      const on = ri === meridianTarget ? meridianMix : (ri === meridianRing ? 1 - meridianMix : 0);
      const band = bandOfRing[ri];
      const level = 0.08 + 0.92 * band;                  // near-dark when its band is quiet, blazing when loud
      const arcW = 0.35 + 0.5 * band;                    // arcs widen with the band
      const arc = 0.25 + 0.75 * arcGate(angOf[i], 3, arcW, spin);
      const neigh = Math.abs(ri - meridianTarget) === 1 ? 0.14 * band : 0;
      target[i] = Math.max(0.0, on * level * arc + neigh);
      zoneOf[i] = Z_PATINA; crestOf[i] = 0;
    }
    if (meridianMix >= 1) meridianRing = meridianTarget;
    return 'ring ' + (meridianTarget + 1);
  }

  // ---- 5. Procession — slow brass arms (motion), brightness LIVE with mids ----
  function fxProcession(t, dt) {
    processTheta += dt * (2 * Math.PI / 60);            // 60s/rev motion stays slow
    const bright = 0.10 + 0.80 * CLK.mid * P.modDepth;  // LIVE mids drive brightness — obvious
    const breadth = 0.30 + 0.15 * CLK.mid;
    for (let i = 0; i < TOTAL; i++) {
      const rf = rfOf[i], ang = angOf[i];
      const a = ang - processTheta - 0.9 * rf; const u = a * (2 / (2 * Math.PI)); const f = u - Math.floor(u);
      const dA = Math.min(f, 1 - f) * (Math.PI); let arm = clamp01(1 - dA / breadth); arm = arm * arm;
      const a2 = ang + processTheta * 0.6 - 1.4 * rf; const u2 = a2 * (3 / (2 * Math.PI)); const f2 = u2 - Math.floor(u2);
      const dA2 = Math.min(f2, 1 - f2) * (Math.PI * 2 / 3); let arm2 = clamp01(1 - dA2 / (breadth * 1.3)); arm2 = arm2 * arm2;
      target[i] = Math.max(0.0, bright * Math.max(arm, arm2 * 0.6));   // dark between arms
      zoneOf[i] = Z_PATINA; crestOf[i] = 0;
    }
    return 'procession';
  }

  // ---- 6. Tide — a swell rising center→rim, LIVE and dark between swells ----
  function fxTide(t, dt) {
    tideVal = smoothAR(tideVal, CLK.bass, 0.3, 1.2, dt);   // LIVE-ish: ~1s
    const drive = tideVal * P.tideCrest;
    const targetR = 0.1 + 0.95 * drive; tideR += (targetR - tideR) * Math.min(1, dt / 2.5); // 2.5s travel — visible
    const spin = t * 0.04;
    for (let i = 0; i < TOTAL; i++) {
      const rf = rfOf[i];
      const inside = clamp01((tideR - rf) / 0.16 + 1);
      const crest = clamp01(1 - Math.abs(rf - tideR) / 0.14);
      const arc = 0.55 + 0.45 * arcGate(angOf[i], 2, 0.8, spin);  // the swell has 2 broad lobes, not a solid ring
      target[i] = Math.max(0.0, inside * (0.15 + 0.85 * drive) * arc + crest * drive * 0.4);
      zoneOf[i] = Z_HEARTH; crestOf[i] = Math.min(0.85, crest * drive);
    }
    return 'tide';
  }

  // ---- 7. Lattice — 6-fold star, contrast LIVE with bass, dark nodes real ----
  function fxLattice(t, dt) {
    latticePhase += dt * (2 * Math.PI / 30);            // 30s precession (motion slow)
    latticeC = smoothAR(latticeC, clamp01(0.20 + 0.80 * CLK.bass * P.modDepth), 0.25, 1.0 * P.relScale, dt); // LIVE contrast
    const level = 0.12 + 0.75 * CLK.energy;             // whole star brightens with energy, dark when quiet
    for (let i = 0; i < TOTAL; i++) {
      const rf = rfOf[i], ang = angOf[i];
      const p = 0.5 + 0.5 * Math.sin(6 * ang + latticePhase + 2.0 * rf); const p2 = p * p * p;
      let B = level * ((1 - latticeC) + latticeC * p2);
      const q = 0.5 + 0.5 * Math.sin(12 * ang - 2 * latticePhase);
      B += level * 0.30 * CLK.mid * q * q * q;           // mids light the 12-star between petals — visible
      target[i] = Math.max(0.0, Math.min(1, B));         // dark nodes go to zero
      zoneOf[i] = Z_HEARTH; crestOf[i] = 0;
    }
    return '6-fold star';
  }

  // ---- 8. Bloom — 8-petal flower, LIVE bass, dark between petals ----
  function fxBloom(t, dt) {
    bloomWob = 0.6 * Math.sin(0.4 * t);
    bloomR = smoothAR(bloomR, CLK.bass, 0.25, 1.0 * P.relScale, dt);  // LIVE: opens within a second of bass
    const Rrad = 0.15 + 0.90 * bloomR * P.modDepth, open = 0.2 + 0.8 * bloomR;
    for (let i = 0; i < TOTAL; i++) {
      const rf = rfOf[i], ang = angOf[i];
      const radial = clamp01((Rrad - rf) / 0.18 + 1);
      const fr = clamp01(1 - Math.abs(rf - Rrad) / 0.15);
      const petal = Math.pow(0.5 + 0.5 * Math.sin(8 * ang + bloomWob), 2); // sharper petals: dark gaps between them
      let B = radial * (0.15 + 0.85 * petal) * open;                        // petals clearly separated, dark between
      B += fr * petal * 0.4;
      target[i] = Math.max(0.0, Math.min(1, B));
      zoneOf[i] = Z_HEARTH; crestOf[i] = fr * 0.3;
    }
    return 'flower';
  }

  // ---- 9. Spiral (gallery-grade, middle speed) — 1 rev / 15s ----
  function fxSpiral(t, dt) {
    spiralTheta += dt * (2 * Math.PI / 15);             // 15s per revolution — watchable, not fast
    const bright = 0.12 + 0.85 * CLK.mid * P.modDepth, halfW = 0.35;  // LIVE mids drive brightness
    for (let i = 0; i < TOTAL; i++) {
      const rf = rfOf[i], ang = angOf[i];
      const a = ang - spiralTheta - 1.4 * rf;
      const u = a * (3 / (2 * Math.PI)); const f = u - Math.floor(u);
      const dA = Math.min(f, 1 - f) * (Math.PI * 2 / 3);
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
    const energy = clamp01(bass * 0.5 + mid * 0.35 + high * 0.25);
    const centroid = clamp01((mid * 0.4 + high * 0.9) / (bass * 0.9 + 0.3));
    const up = (o, v, ua, da) => o + (v - o) * (v > o ? ua : da);
    F.bass = up(F.bass, bass, 0.60, 0.14); F.mid = up(F.mid, mid, 0.55, 0.16); F.high = up(F.high, high, 0.70, 0.20);
    F.energy = up(F.energy, energy, 0.5, 0.10); F.centroid = up(F.centroid, centroid, 0.2, 0.05);
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

    updateClocks(t, dt);
    const lead = (STEPS[mode] || fxStrata)(t, dt);

    // silence handling: fade toward a very dim coal idle over ~8s (barely-there, not a glow).
    if (presence < 0.99) {
      const idle = 0.03;
      for (let i = 0; i < TOTAL; i++) {
        target[i] = Math.max(idle * (1 - rfOf[i] * 0.5), target[i] * presence + idle * (1 - presence));
      }
    }

    // per-pixel eased envelope (anti-flicker, never snaps)
    for (let i = 0; i < TOTAL; i++) {
      const k = target[i] > vals[i] ? 9 : 2.2;
      vals[i] += (target[i] - vals[i]) * (1 - Math.exp(-k * dt));
    }
    return lead;
  }

  // per-pixel palette + incandescent color (pre-gamma; card applies gamma).
  function colorFor(i, v) {
    const z = zoneOf[i], crest = crestOf[i];
    if (z === Z_HEARTH) {
      return crest > 0.001 ? palBlend(PALETTES.hearth, PALETTES.candle, v, crest) : paletteRamp(PALETTES.hearth, v);
    }
    if (z === Z_PATINA) return paletteRamp(PALETTES.patina, v);
    return paletteRamp(PALETTES.candle, v);
  }

  // Buffer-reuse API: compute every pixel's pre-master color ONCE into `out`
  // (Float32Array, TOTAL*3 — same values colorAt returns, no allocation when
  // the buffer is reused). The Show screen shares this buffer between the
  // canvas paint and frameRGB so the palette walk runs once per frame instead
  // of twice per pixel.
  function colorFrame(out) {
    const buf = (out && out.length === TOTAL * 3) ? out : new Float32Array(TOTAL * 3);
    for (let i = 0; i < TOTAL; i++) {
      const c = colorFor(i, clamp01(vals[i]));
      buf[i * 3] = c[0];
      buf[i * 3 + 1] = c[1];
      buf[i * 3 + 2] = c[2];
    }
    return buf;
  }

  // The LED frame: ramp output scaled by the master ceiling (a linear scale,
  // so the B≤G≤R warmth law survives — see color spec §2 corollary).
  // Pass a colorFrame() buffer as `colors` to skip recomputing the palette
  // walk when the colors were already computed for the preview paint.
  function frameRGB(out, colors) {
    const buf = (out && out.length === TOTAL * 3) ? out : new Uint8Array(TOTAL * 3);
    if (colors && colors.length === TOTAL * 3) {
      for (let k = 0; k < TOTAL * 3; k++) buf[k] = Math.round(colors[k] * master);
      return buf;
    }
    for (let i = 0; i < TOTAL; i++) {
      const c = colorFor(i, clamp01(vals[i]));
      buf[i * 3] = Math.round(c[0] * master);
      buf[i * 3 + 1] = Math.round(c[1] * master);
      buf[i * 3 + 2] = Math.round(c[2] * master);
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
    setBands(bands = {}) {
      applyBands(clamp01(Number(bands.bass) || 0), clamp01(Number(bands.mid) || 0), clamp01(Number(bands.high) || 0));
    },
    setListening(on) { listening = Boolean(on); },
    isListening() { return listening; },
    setSensitivity(x) { sensitivity = clamp(Number(x) || 1, 0.3, 3); },
    getSensitivity() { return sensitivity; },
    // mode / preset / master
    setMode(key) { if (STEPS[key]) mode = key; },
    getMode() { return mode; },
    setPreset(name) {
      if (!PRESETS[name]) return;
      P = PRESETS[name]; presetName = name; master = P.master;
    },
    getPreset() { return presetName; },
    setMaster(x) { master = clamp(Number(x) || 0.75, 0.2, 0.85); },
    getMaster() { return master; },
    // introspection (meters, status line, preview render)
    getLevels() { return { bass: F.bass, mid: F.mid, high: F.high, energy: F.energy, centroid: F.centroid }; },
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
