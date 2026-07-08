# Lit Mandala Kit

This bundle is the working code for a sound-reactive backlit laser-cut mandala, plus the build spec. It exists so you can feed real, already-tuned code into a builder (Claude Code, Cursor, your own web interface, WLED, or TouchDesigner) and have it extend that code, rather than re-implement from a description and lose the feel.

## The important rule

The previews in `previews/` are the source of truth for how this looks and feels. The math, the constants, the color ramp, and the fast-attack slow-decay envelope are already dialed in inside them. Any builder should read and reuse that code, not rewrite it from scratch. The spec in `docs/` is documentation, not the reference. When they disagree, the working preview wins.

## Files

### previews/  (working, runnable HTML, this is the real code)

- **mandala-presets.html** — PRIMARY REFERENCE. The calm two-preset mandala (Solo and Gathering) with the shared breathing rest state, the EQ + Interference journey crossfade, the accents (bloom, ripple, shimmer), the warm color ramp, and the per-pixel envelope. This is the look to match. The effect engine lives in the `compute()` function, the tuning lives in the `PRESETS` object, the color in `warm()`, and the smoothing in the render loop's follower.
- **the-lit-mandala-journey.html** — the same engine with a focus selector (Journey, Journey + spiral, EQ, Interference, Spiral) for isolating one effect.
- **the-lit-mandala-audio.html** — the version wired for real audio in a browser (Web Audio analyser). Use this as the reference for how the six audio features are produced from an FFT.
- **the-lit-mandala.html** — the catalog of the six ring effects (Radial Ripple, Center Bloom, Concentric EQ, Orbiting Spiral, Standing Interference, Temperature Field), each defined cleanly.
- **the-array-instrument.html** — the multi-strip distribution concepts (Spectral Geography, Propagation, Voice Assignment, Phase Array, Counterpoint), for future multi-panel work.

### docs/

- **mandala-lighting-handoff.md** — the full build spec: physical ring layout, 675-pixel index map, audio feature contract, every effect as pseudocode, the two-preset parameter table, and integration notes for FastLED, WLED, and TouchDesigner. Use it as the map, not the terrain.

## How to feed this into each target

See `BUILDER_PROMPT.md` for a paste-ready instruction. In short:

- **Claude Code or Cursor (FastLED sketch for ESP32-S3):** point it at `mandala-presets.html` and `docs/mandala-lighting-handoff.md`, tell it to port the exact `compute()` math and `PRESETS` constants to C++ against the 675-pixel index map. Do not let it invent new effect math.
- **Your vector-to-ledmap web interface:** reuse `compute()`, `warm()`, and the feature code from the HTML directly, since it is already JavaScript. Feed the ring table from the handoff as the pixel map.
- **WLED / MoonModules:** import the segment JSON from the handoff for a fast approximate version, then flash the FastLED port for the exact one.
- **TouchDesigner:** rebuild `compute()` as a network and output 675 pixels over ArtNet (universe math is in the handoff). The preview is your visual target.
