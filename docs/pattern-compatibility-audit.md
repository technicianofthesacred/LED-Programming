# Lightweaver Pattern Compatibility Audit

Date: 2026-05-25

This audit gates the current Lightweaver pattern library against the verified bench controller.

Bench controller snapshot:

- WLED `0.15.4`
- ESP32-S3
- Configured LED count: `30`
- WLED effects available: `187`
- WLED palettes available: `71`
- WLED max segments reported: `32`

The configured LED count is still a bench value. Any real artwork needs WLED LED Preferences updated to the final pixel count before exported presets are trusted.

See `docs/controller-compatibility-audit.md` for the live controller-state audit covering presets, LED map, segments, Art-Net readiness, clock sync, and identity.

## Gate Summary

- **WLED stock now:** 26 patterns
- **WLED custom-effect port:** 71 patterns
- **Audio-source runtime:** 15 patterns
- **Beat/timeline runtime:** 8 patterns
- **Computer/Pi render runtime:** 10 patterns

All 130 patterns remain usable through Advanced live rendering from a computer or Pi and through Art-Net. 115 patterns can also be pre-rendered into a standalone sequence. The 15 audio-source patterns need live audio capture unless a future recorder bakes audio bands into sequence data.

## Gate Meanings

**WLED stock now** means the pattern has a stock WLED approximation that can be exported as a preset/playlist entry and run from ESP32 flash.

**WLED custom-effect port** means the pattern can become Basic-compatible, but it needs a Lightweaver custom WLED effect implementation first.

**Audio-source runtime** means the pattern reads live audio bands. Gate it to computer/Pi live rendering or Art-Net unless a future audio-capture sequence exporter is added.

**Beat/timeline runtime** means the pattern depends on Lightweaver BPM/timeline timing. Gate it to computer/Pi live rendering, Art-Net, or standalone sequence export for exact playback.

**Computer/Pi render runtime** means the pattern is too layout/math-specific for the first WLED Basic pass. Gate it to Lightweaver rendering, Art-Net, or sequence export.

## Pattern Gates

### WLED stock now

rainbow, plasma, fire, chase, sparkle, breathe, gradient, twinkle, meteor, aurora, scanner, ripple, lava, ocean, candle, lightning, matrix, drift, sunrise-v2, waterfall, dna, sunrise, meteor-shower, plasma-ball, lissajous-v2, sunrise-horizon

### WLED custom-effect port

debug-xy, neon, stained, warp, glitch, inkdrop, blocks, binary-pulse, calm, bloom, ember, wave, smoke, ice, galaxy, vortex, comet, solar, prism, fluid, tide, hyperspace, zen, morse, ribbons, zodiac, constellation, pendulum, iceberg, soundwave, cityscape, lotus, northern, kaleido, watercolor, digitrain, fractal, thermal, jellyfish, pixelate, smoke-haze, lava-lamp, aurora-borealis, circuit-board, bioluminescence, prismatic, pixel-rain, hypnotic-spiral, neon-sign, oil-slick, starfield, lava-flow, aurora-curtain, digital-rain-v2, tie-dye, kaleidoscope-v2, particle-burst, interference, mirror-warp, sand-dune, retro-scan, deep-sea, paint-drip, snow-globe, thermal-cam, watercolor-wash, fiber-optic, bubble-wrap, lightning-storm, neon-grid, oil-painting

### Audio-source runtime

volt, bass-pulse, spectrum, snowfield, mandala, color-organ, lissajous, nova, glitter, bubble, kick-flash, pulse-expand, confetti-bpm, bass-bloom, spectrum-waterfall

### Beat/timeline runtime

heartbeat, confetti, pulse-ring, strobe, strobe-bpm, beat-grid, strobe-color, breathing-grid

### Computer/Pi render runtime

crystal, circuit, tesseract, mandelbrot, wormhole, crystallize, voronoi, pixel-sort, prism-split, mirror-tunnel

## Product Decision

For the entry-level controller, only **WLED stock now** should be exported as immediately runnable WLED presets. **WLED custom-effect port** patterns are the next Basic expansion backlog. Everything else stays gated to Advanced until the runtime requirement is intentionally solved.
