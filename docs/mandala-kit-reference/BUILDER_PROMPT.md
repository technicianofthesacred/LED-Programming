# Builder prompt (paste this into Claude Code, Cursor, or your builder)

Copy the block for your target. Attach or open the files it references first.

---

## Ground rules (always include these)

```
You are extending an existing, already-tuned lighting effect, not designing a new one.

Source of truth: previews/mandala-presets.html. Its effect math, constants, color
ramp, and envelope are correct and intentional. Reuse them verbatim. Do not
rewrite, re-derive, or "improve" the effect logic, the tuning values, or the
palette. If docs/mandala-lighting-handoff.md and the HTML ever disagree, the HTML
wins.

Before writing anything, read:
  - previews/mandala-presets.html   (the compute() function, the PRESETS object,
    warm(), and the render-loop follower are the parts that matter)
  - docs/mandala-lighting-handoff.md (physical spec, 675-pixel index map, audio
    feature contract, parameter tables)

Then port that exact behavior to the target below. Keep every constant. Match the
preview's look.
```

---

## Target A: FastLED sketch for ESP32-S3 (standalone hardware)

```
Port previews/mandala-presets.html to a FastLED sketch for an ESP32-S3 driving 675
WS2815 pixels on one data line, using the 5-ring index map in the handoff.

Requirements:
- Precompute ringOf[675], rfOf[675], angOf[675] at boot from the ring table in the
  handoff. Ring index ranges: R1 0-44, R2 45-134, R3 135-269, R4 270-449, R5 450-674.
- Read audio from an I2S line-in (CS5343) with an INMP441 fallback. Produce the six
  features (bass, mid, high, flux, energy, section) exactly as defined in the handoff,
  with the same smoothing constants.
- Implement compute() per pixel exactly as in the HTML: breathing floor, EQ band
  weights, interference, optional spiral, journey blend, accents (bloom, ripple,
  shimmer), then the fast-attack slow-decay per-pixel follower and the warm color ramp.
- Two presets, Solo and Gathering, with the exact parameter table values. A rotary
  encoder switches preset (push) and sets brightness (turn). No screen required.
- Set K (interference symmetry) to 6 for now, as a single #define I can change.
- Keep it well commented so I can read and tweak constants. No behavior changes from
  the preview.
```

---

## Target B: Your vector-to-ledmap web interface (JavaScript)

```
Integrate the effect engine from previews/mandala-presets.html into my existing
JavaScript pixel-preview interface. The effect code is already JS, so lift it, do not
rewrite it:
- Reuse compute(), warm(), the feature-smoothing code, and the PRESETS object as-is.
- Drive them from my pixel map instead of the demo geometry: each pixel provides
  ri (ring index 0-4), rf (normalized radius), and ang (radians), per the ring table
  in the handoff.
- Keep my UI and canvas; just swap in this engine as the pattern source.
- Preserve all constants and the color ramp so the preview matches mandala-presets.html.
```

---

## Target C: TouchDesigner network (ArtNet out)

```
Rebuild the effect from previews/mandala-presets.html as a TouchDesigner network that
outputs 675 pixels over ArtNet to an ESP32 in receive mode.
- Use previews/mandala-presets.html as the visual target: match its look exactly.
- Reproduce compute() per pixel using ri, rf, ang from the ring table in the handoff.
- Feed the six audio features from an Audio Analysis into the same math with the same
  constants.
- ArtNet: 675 x 3 = 2025 channels = 4 universes (170 px/universe) for RGB. Use 6
  universes (128 px/universe) if I move to RGBW.
- Expose Solo and Gathering as a preset switch using the handoff parameter table.
```

---

## Target D: WLED / MoonModules (fast approximate, then exact)

```
Two steps:
1. Fast path: import the segment JSON from docs/mandala-lighting-handoff.md into a
   WLED MoonModules build with audio reactive enabled, to test the strip and wiring
   with a good concentric reactive look.
2. Exact path: for the real Journey behavior, use Target A (the FastLED port) instead,
   since stock WLED effects cannot reproduce the crossfade, breathing floor, and
   reserved accents.
```
