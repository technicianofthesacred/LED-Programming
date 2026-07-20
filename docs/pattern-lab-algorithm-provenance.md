# Pattern Lab algorithm provenance

This ledger covers algorithms added specifically for Pattern Lab. It records
whether source code was adapted, not merely whether a familiar mathematical or
visual technique was used.

**Current result:** no Pixelblaze, WLED, Shadertoy, Processing, p5.js, LEDFx,
xLights, MADRIX, or other third-party effect implementation was copied into the
Pattern Lab source. The browser generators, evolution clocks, compositor,
transforms, audio analysis, compatibility compiler, and bake pipeline were
written in this repository. xLights and MADRIX modules generate interoperability
files; they do not embed code from those products.

| Lightweaver implementation | Background / original identifier | Source and author | License basis | Changes / notes |
| --- | --- | --- | --- | --- |
| `lightweaver/src/lib/patternLabGenerators.js` — Particle Drift | Particle system / point-sprite field | General computer-graphics technique; no upstream source code | Repository-authored | Fixed-capacity typed arrays, seeded positions/velocities, circular sculpture progress, bounded Gaussian falloff. |
| `lightweaver/src/lib/patternLabGenerators.js` — Living Ripples | Damped traveling waves | General wave equation visualization; no upstream source code | Repository-authored | Fixed 12-emitter state, seeded centers/phases, bounded damping and frequency. |
| `lightweaver/src/lib/patternLabGenerators.js` — Wandering Trails | Seeded one-dimensional random walk | General stochastic-process technique; no upstream source code | Repository-authored | Deterministic hash decisions, fixed 64-walker allocation, circular mapped progress. |
| `lightweaver/src/lib/patternLabGenerators.js` — Cellular Field | Elementary cellular automaton; default Rule 110 | General cellular-automata definition; no upstream source code | Repository-authored | Ring topology, two bounded byte buffers, configurable rule and capped simulation steps. |
| `lightweaver/src/lib/patternLabGenerators.js` — Reaction Diffusion | Gray–Scott reaction-diffusion model | John E. Pearson, “Complex Patterns in a Simple System,” 1993, [DOI 10.1126/science.261.5118.189](https://doi.org/10.1126/science.261.5118.189) | Mathematical publication cited for background; no paper or third-party source code copied | One-dimensional periodic discretization, fixed Float32 buffers, bounded feed/kill/diffusion ranges and capped steps. |
| `lightweaver/src/lib/patternLabEvolution.js` | Seeded multi-clock evolution and rare events | No upstream implementation | Repository-authored | Six Lightweaver-specific artistic characters, deterministic integer hash noise, non-shared clock periods, brightness ceiling. |
| `lightweaver/src/lib/patternLabTransforms.js` | Mirror, repeat, fold, rotate, twist, kaleidoscope and soft masks | Standard geometry operations; no upstream implementation | Repository-authored | Normalized sculpture coordinates, bounded slice counts, deterministic path/anchor/radial/linear masks. |
| `lightweaver/src/lib/patternLabCompositor.js` | Normal, add, screen, multiply, lighten and luminance-mask blending | Standard image-compositing operations; no upstream implementation | Repository-authored | Byte-clamped RGB, maximum three layers, explicit target/mask/opacity ordering. |
| `lightweaver/src/lib/offlineAudioLanes.js` | Hann-window FFT feature extraction | Standard DSP techniques; reuses Lightweaver's own `showAudioFeatures.js` feature contract | Repository-authored | Local WAV parser, bounded radix-2 FFT, bass/mid/high/level/centroid/flux/onset lanes, SHA-256 audio fingerprint; audio bytes are not retained. |
| `firmware/lightweaver-controller/src/LightweaverRecipe.*` | Bounded native recipe v1 | No upstream implementation | Repository-authored | Fixed allocations and validated JSON boundary for palette/solid, wave, FastLED noise, hash sparkle, spatial transforms, masks, blends, seeded LFO/noise clocks. |

## Existing dependencies and internal sources

- Pattern wrappers reference Lightweaver's existing pattern registry and record
  `{ source: "lightweaver", patternId }`; they do not duplicate upstream code.
- The firmware already pins `fastled/FastLED@3.10.3` in `platformio.ini`.
  Pattern Lab adds a bounded `fastled-noise` recipe node around that existing
  project dependency; it does not vendor FastLED code.
- `.lwseq` baking reuses Lightweaver's existing `LWSEQ1` writer and physical
  wiring compiler. xLights and MADRIX exports reuse the same internal physical
  ordering and DMX calculations.

## Rule for future additions

Before adapting an external effect, add a row with the exact repository URL,
commit or tag, author, license, original file/function identifier, adaptation
notes, and destination path. Do not ship code with an unknown or incompatible
license. General inspiration is not enough provenance when source code or a
distinctive implementation has been translated.
