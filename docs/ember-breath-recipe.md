# Lightweaver Mandala — Effect Recipe v1
**Effect name: "Ember Breath"**

*Design director: Fable model. This is the taste/feel spec every implementation follows — laptop simulator first, then ESP32-S3 port. Do not make taste calls this doc already made.*

---

## 1. Core visual concept

The mandala is a bed of living embers seen through carved wood: in silence it breathes like a sleeping fire, and when music plays, sound is wind on the coals — bass stokes the glowing core, and the glow *blooms outward* ring by ring until treble sets the rim shimmering gold. The single organizing metaphor is **breath and bloom**: everything moves radially, from center out, never in stripes, never in flashes. Nothing ever snaps; every change arrives the way heat spreads.

---

## 2. The rest state (silence)

A slow radial breath, 8 seconds per cycle, swelling from center to rim with a slight phase lag so the breath visibly *rolls outward*.

Per pixel (only `rf` and time `t` in seconds matter here — this is 5 per-ring computations per frame, since rf is constant per ring):

```
breathRaw(t, rf) = 0.5 - 0.5 * cos( 2π * t / T_breath  -  0.9 * rf )
breath(t, rf)    = breathRaw ^ 1.5              // shaping: dwells in the dim phase, ember-like
rest(t, rf)      = (0.20 + 0.25 * breath) * (1.0 - 0.35 * rf)
```

With `T_breath = 8.0 s`:
- Center (rf 0.20): oscillates ~0.19 → 0.42 brightness
- Rim (rf 1.00): oscillates ~0.13 → 0.29 brightness

The `0.9 * rf` phase lag means the rim peaks ~1.1 s after the center — the breath travels outward. The exponent 1.5 makes it linger dim and swell briefly, like coals. **No pixel is ever fully black.** Floor is the palette's deep-ember stop, not off.

---

## 3. The reactive layer

Three inputs, already smoothed fast-attack/slow-release upstream: `energy`, `bass`, `treble`, each 0..1.

**Ring response profiles** (fixed constant arrays, index by `ri`):

```
bassGain[5] = { 1.00, 0.70, 0.40, 0.15, 0.05 }   // bass owns the center
trebGain[5] = { 0.00, 0.10, 0.30, 0.70, 1.00 }   // treble owns the rim
```

**The outward-bloom trick (this is the signature move, do not skip it):** each ring keeps its *own* smoothed copy of bass, with attack time increasing outward. A bass hit lights ring 0 almost instantly and reaches ring 4 a quarter-second later — the mandala visibly blooms outward on every kick, using only 5 state variables and zero wave math.

```
bassAttack_ms[5] = { 60, 115, 170, 225, 280 }    // per-ring attack τ
bassRelease_ms   = 400                            // same for all rings

per frame, per ring:
  a = (bass > ringBass[ri]) ? attackCoef(ri) : releaseCoef
  ringBass[ri] += (bass - ringBass[ri]) * a
```

(`coef = 1 - exp(-dt/τ)`; precompute at your frame rate. At 40 fps these are ≈ {0.34, 0.20, 0.14, 0.11, 0.09} attack, 0.06 release.)

Treble gets **one** shared smoothing (attack 40 ms, release 250 ms — sparkle appears at the rim immediately) → call it `trebS`. Energy needs no extra smoothing.

**Per-ring music level** (5 computations per frame):

```
musicLevel[ri] = 0.30
               + Wb * ringBass[ri] * bassGain[ri]
               + Wt * trebS        * trebGain[ri]
               + 0.20 * energy
musicLevel[ri] = min(musicLevel[ri], 0.95)
```

`Wb` and `Wt` are the preset knobs (§7). The `0.30` floor guarantees the piece stays alive under music even in quiet passages.

---

## 4. How reactive blends into rest

One scalar, `P` (presence, 0..1), owns the crossfade. It follows a noise-gated energy target:

```
Ptarget = clamp01( (energy - 0.06) / 0.25 )      // 0.06 = mic noise floor gate
P += (Ptarget - P) * ( Ptarget > P ? aUp : aDown )
```

- Attack τ = **0.4 s** (music fades in over roughly half a second — noticeable but not a pop)
- Release τ = **3.5–4.5 s** (preset-dependent; when a song ends, the mandala exhales back into breathing over several seconds)

The blend, per ring:

```
base[ri] = lerp( rest(t, rf[ri]),  musicLevel[ri],  P )
```

Because both `rest` and `musicLevel` share the same brightness floor territory (~0.2–0.3), the crossfade is invisible; the piece never dips or jumps at song boundaries. **Never gate the reactive layer on/off with a threshold on brightness itself — only through P.**

---

## 5. Color

One intensity→RGB ramp, five anchors, linear interpolation between stops. This is the entire color system. RGB values are **pre-gamma** (apply gamma 2.2 at output — a 256-entry LUT on the ESP32).

| stop | RGB | name |
|---|---|---|
| 0.00 | (5, 1, 0) | dying coal (never pure black) |
| 0.30 | (96, 28, 4) | deep ember |
| 0.60 | (190, 92, 16) | amber |
| 0.85 | (247, 160, 52) | gold |
| 1.00 | (255, 214, 130) | sun-gold |

Note the ramp never reaches white — the hottest the piece ever gets is warm sun-gold. Blue channel stays ≤ 130 always.

**Audio color shift (the only one):** treble nudges the *lookup index* upward on outer rings, so cymbals/hi-hats make the rim run golder without a second palette:

```
palIdx = clamp01( v + 0.10 * trebS * trebGain[ri] )
color  = palette( palIdx )
```

Bass does not shift color. Bass shifts *brightness*, and the ramp itself turns brightness into deeper-ember vs gold. That's the point of a single ramp.

---

## 6. Motion & smoothing

**Angular shimmer — counter-rotating petal lobes.** A gentle sine around each ring, alternating direction per ring (this is what makes it read as a mandala rather than a bullseye). This is the only true per-pixel math: one LUT sine.

```
lobes[5]   = { 4, 6, 8, 10, 12 }        // angular petals per ring
dirSign[5] = { +1, -1, +1, -1, +1 }     // adjacent rings counter-rotate

rotPhase += (2π / T_rot) * dt * (1 + 1.2 * energy)   // rotation breathes with the music
shimAmp[ri] = 0.05 + ShimMax * trebS * trebGain[ri]  // computed per ring per frame

per pixel:
  target = clamp01( base[ri] * (1 + shimAmp[ri] * sin( lobes[ri] * ang + dirSign[ri] * rotPhase )) )
```

`T_rot = 45 s` baseline — at rest the rotation is barely perceptible, subliminal. Use a 256-entry sine LUT; never call `sinf()` per pixel on the ESP32.

**Per-pixel envelope (anti-flicker).** One brightness state per pixel (675 floats, ~2.7 KB — acceptable and worth it):

```
b[i] += (target - b[i]) * ( target > b[i] ? 0.25 : 0.07 )    // coefficients at 40 fps
```

That is attack τ ≈ 90 ms, release τ ≈ 350 ms. Light arrives quickly, leaves like cooling metal. This envelope is the last defense against mic jitter — with it in place, moderate noise in the audio scalars is invisible.

**Master output:** `out = gamma22( b[i] * MasterBrightness )` then palette. Cap `MasterBrightness ≤ 0.85` — 675 WS2815 pixels at full drive is a power problem, and the warm palette looks *better* below max anyway.

**Per-frame cost summary:** 5 ring smoothers + P + rotPhase (once per frame), 5 per-ring base levels, then per pixel: 1 LUT sine, 1 multiply, 1 envelope lerp, 1 palette lerp. Comfortably 60 fps on an S3.

---

## 7. Presets

Exactly two. Same effect, different temperament.

| Parameter | **Hearth** (calm — default) | **Bloom** (active) |
|---|---|---|
| MasterBrightness | 0.60 | 0.85 |
| T_breath | 9.0 s | 7.0 s |
| Wb (bass weight) | 0.45 | 0.65 |
| Wt (treble weight) | 0.30 | 0.50 |
| P release τ | 4.5 s | 2.5 s |
| ShimMax | 0.10 | 0.20 |
| T_rot | 60 s | 35 s |

Hearth is for the meditation room and the gallery at rest: music influences it like weather. Bloom is for when the piece is the centerpiece of a listening session: it dances, but through the same ember vocabulary — Bloom must never read as a party mode, only as a deeper breath.

---

## 8. Parameter quick-reference

| Constant | Value | Meaning |
|---|---|---|
| `T_breath` | 8.0 s (preset) | rest breath period |
| breath phase lag | 0.9 rad × rf | outward roll of the breath |
| breath exponent | 1.5 | dwell-dim shaping |
| rest base / span | 0.20 / 0.25 | rest brightness floor & swing |
| radial fade | 1 − 0.35·rf | center brighter at rest |
| `bassGain[]` | 1.00, 0.70, 0.40, 0.15, 0.05 | bass→ring mapping |
| `trebGain[]` | 0.00, 0.10, 0.30, 0.70, 1.00 | treble→ring mapping |
| `bassAttack_ms[]` | 60, 115, 170, 225, 280 | outward bloom cascade |
| bass release | 400 ms | per-ring bass decay |
| treble attack / release | 40 / 250 ms | shared treble smoother |
| music floor / cap | 0.30 / 0.95 | reactive brightness bounds |
| energy term | 0.20 × energy | overall lift |
| `Wb`, `Wt` | preset (§7) | bass/treble weights |
| noise gate | energy 0.06, knee 0.25 | P target mapping |
| P attack / release | 0.4 s / preset | rest↔music crossfade |
| `lobes[]` | 4, 6, 8, 10, 12 | petals per ring |
| `dirSign[]` | +,−,+,−,+ | counter-rotation |
| `T_rot` | preset | rotation period |
| rotation energy boost | ×(1 + 1.2·energy) | music speeds rotation |
| shimmer base / max | 0.05 / preset | angular modulation depth |
| pixel envelope | attack 90 ms, release 350 ms (0.25 / 0.07 @ 40 fps) | anti-flicker |
| palette stops | §5 table | intensity→RGB |
| treble palette tilt | 0.10 × trebS × trebGain[ri] | rim golds up |
| gamma | 2.2 (LUT) | output correction |
| MasterBrightness cap | 0.85 absolute | power + aesthetics |
| target frame rate | 40 fps | all coefficients assume this |

---

## 9. Laptop-simulator note

Build first: a single-page canvas app drawing 675 dots at their true polar positions (5 rings at rf 0.2/0.4/0.6/0.8/1.0, correct pixel counts), running this exact recipe at 40 fps, fed by either the laptop mic or a music file through a trivial 2-band split (low-pass ~200 Hz → bass, high-pass ~2 kHz → treble, RMS → energy, each with fast-attack/slow-release smoothing). Add three manual sliders that can override the audio scalars for isolated tuning. **"It looks right" means three tests pass:** (1) with silence, you would hang it on a wall as-is — the breath alone is a complete artwork; (2) with a bass-heavy track, every kick visibly blooms center→rim as one motion, and you cannot perceive any strobe or flicker at any point; (3) when you pause the music mid-song, you cannot name the moment the piece returned to breathing. When all three hold, stop tuning and port.
