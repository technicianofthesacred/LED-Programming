# Lit Mandala — Lighting System Handoff

**Piece:** 4ft backlit multilayer laser-cut mandala, light reflected off wood, LEDs hidden
**Build target:** 5 concentric ring strips, WS2815 12V, 60 LED/m, 675 pixels total
**Controller:** ESP32-S3 (dual core, N16R8), single data line
**Effect model:** calm Journey (EQ + Interference crossfade) with shared breathing rest state, two presets
**This document:** everything needed to implement the effects in FastLED, a JS pattern layer, or TouchDesigner over ArtNet. No em dashes used anywhere by request.

---

## 1. Physical build

Diameter 122cm (4ft), outer usable radius 60cm. Five rings, roughly even radial spacing, dark open center.

| Ring | Radius (cm) | Circumference (cm) | LED count (60/m) | Global index range | rf (norm radius) |
|------|-------------|--------------------|------------------|--------------------|------------------|
| 1 (inner) | 12 | 75  | 45  | 0 to 44     | 0.20 |
| 2 | 24 | 151 | 90  | 45 to 134   | 0.40 |
| 3 | 36 | 226 | 135 | 135 to 269  | 0.60 |
| 4 | 48 | 302 | 180 | 270 to 449  | 0.80 |
| 5 (outer) | 60 | 377 | 225 | 450 to 674  | 1.00 |

**Total pixels: 675.** Counts are nominal. Wrap each ring, cut at the seam, and record the real per-ring count if it differs by a pixel or two, then update the index ranges below to match.

**Wiring**
- One continuous data line. Start at Ring 1 (index 0, innermost), run each ring, then jump outward to the next ring with a short 3-wire pigtail (12V, GND, DATA). Index 0 lives at the center so inner equals bass.
- Data direction follows the arrow on the strip. Keep it consistent across every ring.
- Use keyed 3-pin JST SM connectors between rings so field assembly cannot reverse power or data. Label them R1 to R5.

**Power**
- Supply: 12V, size for headroom. Full white is about 200W (roughly 17A). Use a genuine Meanwell 12V, 200 to 250W.
- Injection: feed 12V + GND at index 0, and add a second injection at the start of Ring 5 (index 450). If outer rings dim or color shift, add a third at Ring 4 (index 270). Common ground with the ESP32.
- At the first pixel put a 1000uF electrolytic capacitor across 12V and GND, and a 300 to 500 ohm resistor inline on the data line.

**Data logic**
- WS2815 expects 5V data. ESP32-S3 outputs 3.3V. Use a 74AHCT125 level shifter on the data line.
- Color order: GRB (verify on the reel).

**Audio input**
- Primary: I2S line-in from the source via CS5343, cleaner than a room mic.
- Fallback: I2S digital mic INMP441 or ICS-43434. Do not use analog mics.

---

## 2. Pixel coordinate model

Every effect is computed per pixel from three values: ring index `ri` (0 to 4), normalized radius `rf` (see table), and angle `ang` in radians (0 to 2pi).

For a global pixel index `g` in a ring with start `s` and count `n`:

```
local   = g - s
ang     = (local / n) * TWO_PI + ring_offset[ri]   // ring_offset optional, for seam alignment
rf      = ring_rf[ri]
xn      = cos(ang) * rf      // normalized -1..1, center origin
yn      = sin(ang) * rf
```

Ring definitions as data (paste into your mapper or firmware):

```json
{
  "rings": [
    { "ri": 0, "start": 0,   "count": 45,  "rf": 0.20, "radius_cm": 12 },
    { "ri": 1, "start": 45,  "count": 90,  "rf": 0.40, "radius_cm": 24 },
    { "ri": 2, "start": 135, "count": 135, "rf": 0.60, "radius_cm": 36 },
    { "ri": 3, "start": 270, "count": 180, "rf": 0.80, "radius_cm": 48 },
    { "ri": 4, "start": 450, "count": 225, "rf": 1.00, "radius_cm": 60 }
  ],
  "total": 675
}
```

**WLED / MoonModules segment layout** (start inclusive, stop exclusive):

```json
{"seg":[
 {"id":0,"start":0,"stop":45,"n":"Ring1 bass"},
 {"id":1,"start":45,"stop":135,"n":"Ring2"},
 {"id":2,"start":135,"stop":270,"n":"Ring3 mid"},
 {"id":3,"start":270,"stop":450,"n":"Ring4"},
 {"id":4,"start":450,"stop":675,"n":"Ring5 high"}
]}
```

For a ledmap.json or a FastLED XY array, generate one entry per global index using `xn, yn` above (scale to your mapper's coordinate space). The polar form (`ri, ang`) is what the effects actually use, so prefer passing that through if your pattern layer allows.

---

## 3. Audio feature contract

The effects consume six smoothed scalars in 0..1. Produce them from an FFT of the audio input, then smooth.

| Feature | Source | Meaning |
|---------|--------|---------|
| `bass` | FFT 30 to 150 Hz, averaged | low end, the tide |
| `mid` | FFT 150 to 1800 Hz | body, melody |
| `high` | FFT 1800 to 8000 Hz | air, transients |
| `flux` | sum of positive bin deltas frame to frame, normalized | busyness, motion |
| `energy` | bass*0.5 + mid*0.35 + high*0.25 | overall level |
| `section` | very slow smoothing of energy (about 5s) | build vs breakdown |
| `centroid` | (mid*0.4 + high*0.9) / (bass*0.9 + 0.3) | brightness of the sound |

**Smoothing** (fast attack, slow release), per feature per frame at dt seconds:

```
smooth(prev, raw, k_up, k_down):
    k = (raw > prev) ? k_up : k_down
    return prev + (raw - prev) * k

bass:    k_up 0.5,  k_down 0.12
mid:     k_up 0.45, k_down 0.12
high:    k_up 0.6,  k_down 0.16
flux:    k_up 0.4,  k_down 0.10
energy:  instantaneous from smoothed bands
section: k_up 0.02, k_down 0.012
centroid:k_up 0.2,  k_down 0.05
```

---

## 4. Effect definitions

All effects return a per-pixel scalar target in 0..1. They are summed and blended, then passed through a per-pixel envelope and a color map. Inputs per pixel: `ri, rf, ang`. Global: `t` (seconds), `dt`, the audio features.

### 4.1 Breathing floor (shared rest state)

A slow global pulse that never lets the piece die. Present under everything, and the whole show when the room is quiet.

```
breath      = 0.5 + 0.5 * sin(t * TWO_PI / 7.0)       // 7s cycle
floor_base  = quiet ? 0.16 : 0.08
floor_swing = quiet ? 0.10 : 0.045
floorGlow   = (floor_base + breath * floor_swing) * (0.9 + rf * 0.1)
```

`quiet` is true when no audio is playing (between tracks) or `energy` sits below about 0.10 for a few seconds.

### 4.2 EQ (ring to band)

Each ring follows a slice of the spectrum. Per-ring band weights give a smooth radial spectrum from bass at center to highs at rim.

| Ring (ri) | bass w | mid w | high w |
|-----------|--------|-------|--------|
| 0 | 1.0 | 0.0 | 0.0 |
| 1 | 0.6 | 0.4 | 0.0 |
| 2 | 0.0 | 1.0 | 0.0 |
| 3 | 0.0 | 0.4 | 0.6 |
| 4 | 0.0 | 0.0 | 1.0 |

```
bandV = bassW[ri]*bass + midW[ri]*mid + highW[ri]*high
eqv   = (0.04 + bandV * openness) * (0.9 + 0.1 * sin(ang*3))   // tiny angular life
openness = lerp(0.55, 1.0, section)
```

### 4.3 Interference (standing wave)

Two counter-running waves lock into fixed nodes. `K` must equal your cut pattern base symmetry (6 or 12) so bright nodes land on real motifs.

```
wavePhase += dt * (0.35 + energy * 0.35)     // integrate once, global
iv = 0.04 + abs( sin(K * ang) * cos(wavePhase + ri * 0.4) ) * (0.3 + bass * 0.7)
```

### 4.4 Spiral (optional, Gathering only)

The only rotating layer. Off in Solo. In Gathering its weight only rises with busy, bright passages.

```
rot += dt * (0.1 + mid * 0.25) * (W_spiral * 2.0)   // integrate once, global
sv = 0.04 + angGauss(ang - (rot + ri * 0.6), 0.5) * (0.4 + mid * 0.5) * openness

angGauss(d, s): wrap d to -pi..pi, return exp(-(d*d)/(2*s*s))
```

### 4.5 Journey blend

Crossfade the effect layers. Weights come from a slow macro clock plus the music's character, then are heavily smoothed so transitions are gentle.

```
cyc = t * TWO_PI / JOURNEY_PERIOD

// Solo: EQ + Interference only, no spiral
tq = max(0, cos(cyc))        + bass * 0.5
ti = max(0, cos(cyc - PI))   + mid  * 0.5
ts = 0

// Gathering: add spiral, weighted to busy/bright sections
// tq = max(0, cos(cyc))          + bass * 0.5
// ti = max(0, cos(cyc - 2.094))  + mid * (1 - flux) * 0.55
// ts = max(0, cos(cyc - 4.188))  + (flux * 0.7 + high * 0.35)

normalize(tq, ti, ts)                 // divide by sum
W_eq  += (tq - W_eq)  * (1 - exp(-0.6 * dt))    // smooth the weights
W_int += (ti - W_int) * (1 - exp(-0.6 * dt))
W_spiral += (ts - W_spiral) * (1 - exp(-0.6 * dt))

journeyV = W_eq * eqv + W_int * iv + W_spiral * sv
```

### 4.6 Accents

Sparse events on top of the journey. Spawn on audio onsets, decay slowly.

**Center bloom** (rare, on strong bass onsets). Spawn `{born:t, amp}` when a bass onset exceeds threshold and a probability check passes (see preset table). Contribution per pixel:

```
for each bloom:
    a = t - bloom.born
    if a < 1.5:
        front = a * 1.0                          // expands outward in rf
        acc = max(acc, bloom.amp * exp(-((rf - front)/0.14)^2) * exp(-a/0.9))
```

**Radial ripple** (Gathering only, on strong beats). Same shape, faster and thinner:

```
for each ripple:
    a = t - ripple.born
    if a < 1.1:
        front = a * 1.6
        acc = max(acc, ripple.amp * exp(-((rf - front)/0.09)^2) * exp(-a/0.6))
```

**Shimmer** (on high transients, outer rings). Spawn `{born:t, ri: 3 or 4, ang: random, amp}`:

```
for each shimmer where shimmer.ri == ri:
    a = t - shimmer.born
    if a < 1.2:
        acc = max(acc, shimmer.amp * angGauss(ang - shimmer.ang, 0.4) * exp(-a/0.7))
```

### 4.7 Combine, envelope, color

```
target = quiet ? floorGlow : min(1, max(floorGlow, journeyV + acc * 0.95))

// per-pixel envelope: fast attack, slow decay (this is what stops glitch)
k = (target > val) ? ATK : DEC
val += (target - val) * (1 - exp(-k * dt))

// brightness ceiling per preset
v = min(1, val * CEILING)
```

**Color map (warm ramp).** Map intensity `v` (biased by `temp`) to RGB. `temp = baseTemp * (0.85 + rf*0.35)`, `baseTemp = (0.9 + 0.22*breathSlow + centroid*0.28) * TEMP_BIAS`.

| stop | R | G | B |
|------|---|---|---|
| 0.00 | 30  | 12  | 6   |
| 0.32 | 150 | 52  | 20  |
| 0.62 | 202 | 112 | 42  |
| 0.85 | 244 | 200 | 105 |
| 1.00 | 255 | 232 | 196 |

```
color = warmRamp( clamp(0.3 + v*0.62, 0, 1) * temp )
```

If you move to WS2814 RGBW (see section 8), send the warm base on the W channel and use RGB only for ember peaks and color drift.

---

## 5. Presets

Both share the breathing floor and the EQ + Interference core. Solo is calm and never rotates. Gathering lifts brightness, quickens response, wakes the accents, and lets a little spiral in.

| Parameter | Solo (calm) | Gathering (active) |
|-----------|-------------|--------------------|
| `JOURNEY_PERIOD` (s) | 125 | 75 |
| spiral in blend | no | yes |
| `CEILING` | 0.82 | 1.0 |
| `ATK` (attack k) | 12 | 14 |
| `DEC` (decay k) | 2.0 | 3.4 |
| bloom probability (per strong bass onset) | 0.15 | 0.5 |
| bloom amp | 0.5 | 0.7 |
| shimmer probability (per high onset) | 0.25 | 0.55 |
| shimmer amp | 0.5 | 0.7 |
| ripple enabled | no | yes |
| `TEMP_BIAS` (palette) | 0.92 | 1.06 |

Onset detection: a bass onset is the leading edge of a bass hit (bass crosses up through a moving threshold). A high onset is a positive spike in `high`. Scale spawn probabilities by an arrangement factor if you want quieter and busier passages to feel different, but with real audio the music already provides that.

`K` (interference symmetry) and the cut pattern base symmetry must match: choose 6 or 12.

---

## 6. Parameter quick reference

```
GLOBAL
  TWO_PI            6.28318
  breath period     7.0 s
  wavePhase rate    0.35 + energy*0.35  (integrated)
  rot rate          (0.1 + mid*0.25) * W_spiral * 2.0  (integrated, Gathering)
  weight smoothing  1 - exp(-0.6 * dt)
  openness          lerp(0.55, 1.0, section)

BANDS (Hz)          bass 30-150, mid 150-1800, high 1800-8000

FLOOR
  quiet base/swing  0.16 / 0.10
  active base/swing 0.08 / 0.045

COLOR
  warm ramp         see table
  temp per pixel    baseTemp * (0.85 + rf*0.35)
```

---

## 7. Integration notes

**FastLED (standalone on ESP32-S3, recommended for the finished piece)**
- One `CRGB leds[675]`. Precompute a `ringOf[675]`, `rfOf[675]`, `angOf[675]` lookup at boot from the ring table.
- Run the audio via the I2S mic or line-in, compute the six features, run section 4 per pixel each frame, write `leds`, `FastLED.show()`.
- Preset switch and brightness on a rotary encoder or IR remote. No screen needed.

**WLED MoonModules (fast path, approximate)**
- Import the segment JSON from section 2. Use the audio-reactive build. This gets a good concentric reactive mandala out of the box but not the exact Journey. Use for testing the strip and wiring before flashing the custom sketch.

**TouchDesigner over ArtNet (design and preview, or live shows)**
- Compute the effects in a TOP or CHOP network, output pixels over ArtNet or sACN to the ESP32 in receive mode.
- Channel math: RGB is 675 x 3 = 2025 channels = 4 universes at 170 pixels per universe. RGBW is 675 x 4 = 2700 = 6 universes at 128 pixels per universe.
- Prefer wired Ethernet (an ESP32 with an Ethernet port) for a steady stream.

**Your vector-to-ledmap interface**
- Feed it the ring table so each ring becomes a path with its pixel count. Export the ledmap and the `xn, yn` coordinates. Keep the polar values (`ri, ang`) available to the pattern layer, since the effects are polar.

---

## 8. Optional upgrade: WS2814 RGBW

Adds a dedicated warm-white die per pixel. This is the quiet quality jump for a reflected-wood piece, because the warm base can live on the W channel instead of being faked by mixing R and G, giving silky low-brightness ambers.

Changes if you adopt it:
- Data width becomes 4 bytes per pixel. Update ArtNet universe math (section 7) and the FastLED type to RGBW.
- Color map: drive the warm base intensity on W, reserve R for ember peaks near `v = 1.0`, and let a little G ride the gold end. Keep B near zero for this palette.
- Everything else (index map, effects, presets) is unchanged.

---

## 9. Build checklist

- [ ] Cut 5 rings, wire inner to outer as one data line, arrows consistent
- [ ] Keyed JST between rings, labeled R1 to R5
- [ ] 74AHCT125 on data, 1000uF cap and 300-500 ohm resistor at first pixel
- [ ] 12V Meanwell 200-250W, inject at index 0 and index 450, common ground
- [ ] ESP32-S3 flashed with the custom sketch, I2S line-in or mic wired
- [ ] Rotary encoder or IR remote for preset and brightness
- [ ] Confirm real per-ring counts, update index ranges if needed
- [ ] Set `K` to match cut pattern symmetry (6 or 12)
- [ ] Diffuser 2-3cm behind the cut layer for smooth glow
```
