# Lightweaver Pattern Lab Design

**Date:** 2026-07-20
**Status:** Approved for implementation planning

## Purpose

Add an isolated Pattern Lab to Lightweaver for creating rich, long-form LED looks by remixing existing patterns. The Lab makes five-to-fifteen-minute evolution easy through artistic controls while keeping precise controls available progressively.

Pattern Lab is a new top-level Studio section. It does not replace or refactor the current Patterns, Layout, Show, Playlist, or card-control sections. Those existing sections must remain usable throughout development.

## Approved product direction

- Primary workflow: remix an existing pattern rather than code or assemble a node graph.
- Primary canvas: the exact mapped sculpture, not a generic thumbnail.
- Control language: artistic macros first, technical controls on demand.
- Long-form target: a pattern should feel fresh across a tunable five-to-fifteen-minute arc.
- Runtime strategy: hybrid. Lightweight recipes run procedurally on the ESP32-S3; complex recipes bake to standalone sequence files.
- Deployment: ESP32-S3 only. A Raspberry Pi is not part of the runtime.
- Safety boundary: Pattern Lab is isolated until the user explicitly validates and sends a result into the current project.

## Goals

- Let a user create a long, non-obviously-repeating look without keyframes, code, a node graph, or a conventional timeline.
- Preserve all existing patterns as remixable starting points.
- Make the real sculpture geometry the visual source of truth while authoring.
- Expose useful creative depth without presenting engineering complexity by default.
- Support richer generators, spatial operations, color behavior, modulation, and bounded layering.
- Give every recipe an understandable path to the standalone card.
- Keep invalid, expensive, custom, or AI-generated work isolated from the active project and hardware output.
- Preserve source and license provenance for every adapted algorithm.

## Non-goals

- Do not replace or reorganize the current working Studio sections in the first release.
- Do not require a Raspberry Pi, desktop service, LEDFx, xLights, OpenRGB, or MADRIX at installation runtime.
- Do not build a full node editor, shader editor, show sequencer, or xLights equivalent.
- Do not require manual keyframes or timeline editing to make a long-form pattern.
- Do not allow unlimited layers, unbounded state, or arbitrary GPU features on the ESP32.
- Do not silently simplify or substitute unsupported features during export.
- Do not copy upstream code without a compatible license and recorded provenance.

## Isolation boundary

### Separate top-level section

Pattern Lab appears as a distinct Studio destination. Opening it lazy-loads its renderer, worker, recipe tools, and UI. Existing screens must not import the Pattern Lab runtime or pay its startup cost.

Pattern Lab may read a snapshot of:

- Current mapped geometry and section metadata.
- Current global and per-section pattern assignments.
- Current palette and tuning values.
- Connected card capabilities when available.

It works on a private draft. Reading this context does not give the Lab permission to mutate it.

### Explicit handoff

Pattern Lab has three persistence actions:

- **Save Draft** stores a private Pattern Lab recipe.
- **Export Recipe** downloads a portable, versioned recipe document.
- **Use in Project** validates the recipe, creates a new look or sequence asset, and deliberately hands it to the existing workflow.

Built-in patterns and existing saved looks are never overwritten. A Lab draft cannot change the active project, background stream, show, playlist, card configuration, or LEDs.

The only direct hardware action is **Preview on Lights**. It requires an explicit press, uses the existing output-ownership contract, shows a visible live state, and provides a single Stop action that restores the previous state.

### Storage and failure isolation

- Lab drafts use a separate, namespaced storage repository and schema version.
- Recipe parsing occurs before any state mutation.
- The renderer runs in a dedicated browser worker with frame deadlines and memory budgets.
- A failed render preserves the last valid preview.
- Crashes, invalid recipes, or abandoned drafts cannot corrupt the existing project document.
- The new route may remain behind an experimental flag until its browser and hardware gates pass.

## Everyday authoring workflow

The main workflow is deliberately linear:

1. **Choose a pattern.** Start from an existing Lightweaver pattern, saved Lab recipe, or curated starter.
2. **Sculpt the look.** Adjust Color, Movement, Shape, Texture, and Energy.
3. **Add Long Evolution.** Select a character, duration, and amount of change.
4. **Save the variation.** Keep the source intact and create a new named draft.
5. **Use in Project.** Validate and hand off only when the result is ready.

Code, AI assistance, the internal layer stack, performance details, modulation routes, and any future graph view are advanced tools. They do not compete with this flow.

## Sculpture-first workspace

The mapped artwork is the dominant canvas. It renders the actual LED samples using the current layout, section directions, groups, symmetry, masks, transforms, and composited result.

The canvas provides:

- Play and pause.
- Frame step.
- Scrub across the complete five-to-fifteen-minute evolution.
- Beginning, middle, and end quick-preview points.
- Whole-piece and selected-target isolation.
- A/B comparison with the source recipe.
- Four seeded variation previews.
- Lock seed and New Variation.
- Browser-versus-card comparison mode.
- Frame-rate, power, storage, and runtime-compatibility indicators.

On desktop, controls appear in a side inspector. On mobile, the sculpture remains full-width and controls open in a lower drawer. Both surfaces use the same recipe and commands.

## Creative controls

Primary controls use artistic language:

- **Color:** temperature, intensity, range, contrast, palette family, and color movement.
- **Movement:** Calm to Alive, Drift to Pulse, direction, breadth, and flow.
- **Shape:** radial versus linear emphasis, symmetry, scale, focus, and spatial spread.
- **Texture:** Soft to Crisp, Sparse to Full, grain, turbulence, and trail character.
- **Energy:** ambient level, dynamic range, rare-event strength, and gathering versus releasing.

Opening Advanced reveals exact values such as frequency, amplitude, octaves, phase, easing, thresholds, blend mode, coordinate space, modulation depth, and clamps.

Each macro maps to a documented group of low-level parameters. Macro movement must be deterministic and reversible so returning a macro to its previous value returns the same recipe state.

## Long Evolution

Long Evolution must be easier than creating a timeline.

The default controls are:

- **Character:** Slow Bloom, Wandering, Tidal, Breathing, Gathering and Releasing, or Rare Surprises.
- **Duration:** five to fifteen minutes.
- **Change:** Subtle to Transformative.

The system generates several deterministic, non-matching clocks:

- A texture clock operating over seconds.
- A movement or spatial-emphasis clock operating over roughly one to three minutes.
- A palette and energy arc operating over the selected full duration.
- Seeded micro-variation that prevents exact short-loop repetition.

Clock periods must not share an obvious common reset inside the selected duration. Evolution presets constrain which parameters may move, their safe ranges, easing, and how the pattern returns gracefully.

**Edit Evolution** progressively reveals:

- Individual clocks and destinations.
- Range and phase.
- Curves and easing.
- Optional chapters.
- Rare-event frequency and recovery.
- Repeat, ping-pong, and seeded continuation behavior.

Manual keyframes remain optional and are not part of the initial release.

## Lightweaver Recipe model

A saved Lab look is a versioned JSON recipe. It contains:

- Recipe schema version and stable ID.
- Name, description, tags, thumbnail seed, and creation metadata.
- Base generator and its typed parameters.
- Creative macro values and their resolved technical values.
- Palette and color-processing configuration.
- Long Evolution character, duration, amount, seed, and resolved clocks.
- Up to three internal layers.
- Layer targets, masks, transforms, opacity, blend mode, and order.
- Geometry and coordinate requirements.
- Required inputs such as beat or audio features.
- Runtime capabilities and resource estimates.
- Upstream source, author, license, and adaptation notes when applicable.

Unknown fields are preserved when safe. Unknown required capabilities block activation and export with a specific explanation.

## Existing pattern compatibility

Every current stateless Lightweaver pattern is exposed through a compatibility wrapper. The wrapper maps the existing inputs and `@param` declarations into the Recipe model without changing its visual output.

The first implementation must prove this with deterministic snapshots for a representative set of:

- Palette-aware patterns.
- Fixed-color patterns.
- Spatial and polar patterns.
- Beat and audio-dependent patterns.
- Per-section patterns.
- Patterns with custom parameters.

Selecting an existing pattern in Pattern Lab creates a new private recipe. It does not modify the source definition.

## Pattern engine

The new engine uses a bounded lifecycle:

```text
initialize(context) -> bounded state
update(delta, state, inputs) -> advance once per frame
render(pixel, coordinates, state) -> color
```

The lifecycle unlocks stateful particles, trails, ripples, cellular systems, and reaction-diffusion while keeping existing patterns valid through wrappers.

The browser worker enforces:

- Maximum frame execution time.
- Maximum state and framebuffer allocation.
- Deterministic random sources.
- Bounded typed-array state.
- Cancellation and latest-request-wins behavior.
- Reduced preview quality during continuous interaction.
- Full-quality rendering after release and during export.

The last valid frame remains visible when initialization, update, or render fails. Errors identify the failing stage and offer Reset change, Simplify, or Restore last valid draft.

## Creative vocabulary

### Base generators

- Current Lightweaver patterns.
- Gradients and color fields.
- Waves and interference.
- Perlin noise, fBm, and domain warping.
- Fire, ember, candle, and molten fields.
- Twinkles, comets, sparks, and lightning.
- Particles and drifting dust.
- Ripples and fluid motion.
- Cellular automata.
- Reaction-diffusion.
- Flow fields and random walkers.
- Metaballs and signed-distance shapes.

### Spatial shaping

- Mirror, repeat, fold, rotate, twist, and kaleidoscope.
- Radial rings, angular slices, linear sweeps, and soft masks.
- Distance from the center, a named anchor, a path, or a section.
- Whole-piece, group, section, and selected-pixel targets.
- Connected-path progress across independently wired sections.
- Local strip progress, normalized global coordinates, and polar coordinates.
- Direction and phase offsets.

### Color shaping

- Reorderable gradient stops.
- Smooth, stepped, and banded interpolation.
- Palette rotation and slow migration.
- Brightness curves and incandescent cooling.
- Warmth and saturation boundaries.
- Saved palette families and controlled variations.
- Gamma, white balance, RGB order, and power-aware preview.

### Movement and texture

- Drift, breathe, pulse, flow, orbit, rise, fall, scatter, and gather.
- Scale, softness, density, trail length, turbulence, and contrast.
- Deterministic seeds and lockable variations.
- Rare shimmers, flares, bursts, and directional sweeps.

## Layers and modulation

A recipe may contain no more than three layers in the initial design. Each layer has a generator, target, mask, transform, palette, opacity, speed, and blend mode.

Initial blend modes are Normal, Add, Screen, Multiply, Lighten, and Mask. Additional modes require a demonstrated visual need and measured browser and card cost.

Pattern Lab may choose and configure internal layers automatically. The user does not need to open the stack to create a complete look.

Reusable modulation sources include sine, triangle, pulse, smooth noise, random walk, sample-and-hold, envelope, beat phase, audio bands, MIDI, and rotary input. Each route has amount, offset, curve, clamp, and smoothing. Long Evolution uses the same routing system internally.

## Runtime compatibility compiler

Every recipe is classified before project handoff:

- **Live on card:** runs procedurally within the connected card's declared limits.
- **Bake to card:** renders in Studio and exports as a standalone `.lwseq` asset.
- **Simplify for card:** identifies specific expensive features and offers explicit substitutions.
- **Studio only:** no safe standalone representation is currently available.

The compiler considers generator support, layer count, inputs, pixel count, target frame rate, state memory, framebuffer memory, estimated operations, sequence duration, and microSD capacity.

It never silently removes a layer, changes a blend mode, substitutes a generator, or reduces evolution. Simplification is previewed and accepted as a new variant.

The card runtime remains focused on curated efficient primitives, a bounded recipe interpreter, and the existing sequence player. Complex browser renders are baked; a Pi or permanent computer is not added.

## Integration sources and boundaries

- **[FastLED](https://github.com/FastLED/FastLED):** primary MIT-compatible source for efficient palettes, noise, blur, trails, particles, layered FX, transitions, and ESP32 output techniques.
- **[WLED](https://kno.wled.ge/interfaces/json-api/):** model for self-describing effect metadata, segments, palettes, presets, playlists, and capability discovery. Prefer protocol integration; direct source reuse requires a deliberate EUPL compliance decision.
- **[Pixelblaze](https://electromage.com/docs/language-reference/):** interaction reference for frame lifecycle, normalized mapping, live controls, and variable watching. Its runtime is proprietary; community patterns require explicit compatible licenses.
- **[xLights](https://manual.xlights.org/xlights/chapters/chapter-four-sequencer/value-curves):** workflow reference for value curves, effect presets, dual previews, and timing concepts. Its GPL code is not copied into Lightweaver.
- **[LEDFx](https://docs.ledfx.app/en/latest/howto/virtuals.html):** reference for virtual targets, scenes, perceptual audio bands, automatic gain, and attack/release smoothing. Its GPL runtime is not embedded.
- **[MADRIX](https://help.madrix.com/m5/html/madrix/hidd_effect_parameter_chaser.html):** reference for parameter chasers, scene storage, fixture export, and future Art-Net recording. Proprietary formats are not parsed into the card runtime.
- **[Adafruit NeoPixel](https://learn.adafruit.com/adafruit-neopixel-uberguide/arduino-library-use):** calibration and perceptual-color reference. FastLED remains the output library.
- **[Processing](https://github.com/processing/processing-examples), [openFrameworks](https://openframeworks.cc/ofBook/chapters/how_of_works.html), [Coding Train](https://github.com/CodingTrain/Coding-Challenges), and [SDF-LED](https://github.com/zranger1/SDF-LED):** algorithm and lifecycle references used only when the specific source license permits adaptation.
- **[LiteGraph](https://github.com/jagenjo/litegraph.js):** possible future advanced view over the Recipe model, never the primary authoring interface.
- **[OpenRGB](https://gitlab.com/CalcProgrammer1/OpenRGB/-/blob/master/Documentation/OpenRGBSDK.md):** reference for device capabilities and visual maps, not a runtime dependency.

Every adapted algorithm records source URL, author, license, original identifier, material changes, and the Lightweaver files containing the adaptation.

## Delivery phases

### Phase 1: Isolated Lab and easy Long Evolution

- Add the lazy-loaded Pattern Lab route and private draft repository.
- Read mapped geometry and existing patterns through explicit adapters.
- Build the sculpture-first preview and mobile control drawer.
- Add Choose, Sculpt, Long Evolution, Save Draft, and A/B comparison.
- Add the six evolution characters, five-to-fifteen-minute duration, change amount, seed lock, variations, and scrub preview.
- Add compatibility status without enabling project handoff or hardware preview.

**Release gate:** a user can create and reopen a visibly evolving draft from an existing pattern without affecting the active project.

### Phase 2: Versioned Recipes and controlled handoff

- Finalize the Recipe schema, typed controls, palette tools, targets, masks, and up-to-three-layer compositor.
- Wrap the current pattern library and lock deterministic compatibility fixtures.
- Add recipe import/export, provenance, validation, and resource estimates.
- Add Use in Project for recipes that translate safely into the current look model.

**Release gate:** activating a valid recipe creates a new look while existing patterns, shows, playlists, and card settings remain unchanged.

### Phase 3: Stateful engine

- Add the worker lifecycle, bounded state, frame budgets, and cancellation.
- Ship particles, ripples, random walkers, cellular fields, and reaction-diffusion.
- Add pause, frame step, coordinate inspector, state watcher, performance meter, and dark-output diagnosis.

**Release gate:** stateful effects remain responsive at representative layouts and invalid code cannot freeze the Studio.

### Phase 4: Standalone card delivery

- Implement the supported card-native recipe primitives and capability reporting.
- Add deterministic `.lwseq` baking for complex recipes.
- Add sequence storage, frame-rate, memory, power, and duration estimates.
- Add explicit Preview on Lights with output ownership and rollback.
- Verify exact palette, geometry, timing, seed, and evolution on hardware.

**Release gate:** supported recipes run procedurally or as baked standalone sequences on the ESP32-S3 without a Pi.

### Phase 5: Optional expansion

- Add offline audio analysis lanes and music-shaped evolution.
- Add xLights model and MADRIX fixture exports.
- Add card-side recording of final Art-Net frames to `.lwseq` if hardware profiling supports it.
- Add the optional advanced graph over the same Recipe model.
- Add shader or video sources only as Studio-rendered, baked inputs.

Phase 5 items require separate approval and are not prerequisites for the core Pattern Lab.

## Failure handling

- Invalid edits do not replace the last valid recipe or preview.
- Unsupported card features offer Bake, Simplify, or Remove feature.
- Simplification creates a new previewable variant and never mutates the source.
- Heavy recipes reduce interactive preview quality before missing input or freezing.
- Worker timeouts stop the offending frame and preserve controls.
- Missing geometry, audio, or capability inputs identify the exact requirement.
- Import errors list schema paths and do not mutate Lab storage.
- Handoff errors leave both the Lab draft and current project untouched.
- Hardware preview failure releases output ownership and restores the previous card state when acknowledgement permits.

## Testing and release gates

Each phase requires:

- Unit tests for recipe parsing, normalization, macro mapping, evolution clocks, targets, compatibility classification, and estimates.
- Deterministic render fixtures using fixed layout, seed, time, and input values.
- Browser tests for desktop and mobile authoring, save/reopen, A/B, variations, scrubbing, import errors, handoff confirmation, and recovery.
- Isolation tests proving that opening, editing, failing, and abandoning Pattern Lab do not mutate current project state or background output.
- Worker tests for timeouts, cancellation, memory limits, and last-valid-frame behavior.
- Firmware contract and compile tests for card-native recipes and sequence manifests.
- Round-trip tests for recipe and `.lwseq` export/import.
- Long-running tests covering at least one complete fifteen-minute evolution.
- `npm run launch:check` before deployment.

Physical hardware verification is required for claims about color, smoothness, frame rate, memory headroom, power limiting, timing, browser-versus-card parity, or standalone playback.

## Success criteria

Pattern Lab is successful when:

- A first-time user can create and save a five-to-fifteen-minute evolving pattern without opening Advanced controls.
- The result shows no obvious short repeated loop during its configured arc.
- Scrubbing reveals meaningful beginning, middle, and end differences.
- Existing Lightweaver sections and saved projects behave as before.
- The mapped preview represents the actual sculpture geometry and section behavior.
- Every recipe clearly communicates Live on card, Bake to card, Simplify for card, or Studio only.
- A deliberate handoff creates a new look or sequence without overwriting its source.
- Supported preview and physical output agree on palette order, geometry, seed, and timing.
- A broken or oversized recipe cannot freeze the Studio, corrupt the project, or seize hardware output.

## Implementation-order decision

Implementation planning begins with Phase 1 only. Later phases remain architectural context so the first release does not create incompatible data or UI. Phase 1 must prove that the separate Pattern Lab makes long-form remixing substantially easier before stateful effects or card compilation expand the scope.
