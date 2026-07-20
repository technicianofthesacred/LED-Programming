# Lightweaver Pattern Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete isolated Pattern Lab on top of the final clean `led-density-per-meter` baseline, making five-to-fifteen-minute evolving patterns easy while preserving every existing Studio section and standalone ESP32 workflow.

**Architecture:** Pattern Lab is a lazy-loaded top-level Studio route with its own recipe storage, deterministic evolution engine, worker renderer, and explicit handoff adapter. Existing patterns are wrapped as recipe sources; supported recipes compile to a bounded card-native subset, while complex recipes render deterministically into the existing `.lwseq` format. The active `milan-v1` worktree remains untouched; implementation occurs in a new worktree created from its final clean committed tip.

**Tech Stack:** React 18, Vite, browser Web Workers, existing Lightweaver frame engine and SVG preview, Node test runner, Playwright, ESP32-S3/PlatformIO, FastLED, microSD `.lwseq` playback.

---

## Baseline and file structure

Do not begin implementation while `/Users/adrianrasmussen/conductor/workspaces/led/milan-v1` is dirty. At execution time, re-read its HEAD and create a separate branch/worktree from that clean commit.

New browser modules live under `lightweaver/src/pattern-lab/` so current screens do not import the Lab runtime:

```text
lightweaver/src/pattern-lab/
  PatternLabScreen.jsx          route-level composition only
  PatternLabPreview.jsx         mapped sculpture preview and transport
  PatternLabControls.jsx        creative macros and progressive disclosure
  PatternLabEvolution.jsx       simple long-evolution controls
  PatternLabVariants.jsx        source/A-B/four-seed comparisons
  PatternLabLayers.jsx          optional three-layer inspector
  PatternLabExport.jsx          compatibility, bake, handoff, interop
  usePatternLabWorker.js        worker lifecycle and last-valid-frame state
  patternLab.worker.js          isolated renderer entry point
  pattern-lab.css               Lab-only responsive styles
```

Pure logic lives beside existing libraries but remains namespaced:

```text
lightweaver/src/lib/
  patternLabRecipe.js
  patternLabStorage.js
  patternLabPatternAdapter.js
  patternLabEvolution.js
  patternLabMacros.js
  patternLabCompositor.js
  patternLabTransforms.js
  patternLabGenerators.js
  patternLabWorkerProtocol.js
  patternLabCompatibility.js
  patternLabHandoff.js
  patternLabPreviewSession.js
  lwseqBake.js
  offlineAudioLanes.js
  xlightsExport.js
  madrixPatchExport.js
```

Firmware additions remain bounded:

```text
firmware/lightweaver-controller/src/
  LightweaverRecipe.h
  LightweaverRecipe.cpp
```

Existing firmware files modified only at their explicit integration seams:

- `LightweaverTypes.h`
- `LightweaverStorage.cpp`
- `LightweaverPatterns.h`
- `LightweaverPatterns.cpp`
- `LightweaverRuntimeApi.h`
- `LightweaverWeb.cpp`

## Task 1: Create the isolated route

**Files:**
- Create: `lightweaver/src/pattern-lab/PatternLabScreen.jsx`
- Create: `lightweaver/src/pattern-lab/pattern-lab.css`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/main.jsx`
- Test: `lightweaver/tests/pattern-lab-isolation.spec.ts`
- Modify: `lightweaver/tests/screen-smoke.spec.ts`

- [ ] **Step 1: Write route-isolation tests**

Assert `#screen=pattern-lab` renders `data-testid="pattern-lab-screen"`, existing routes still render, and Lab modules are absent from the initial Vite route chunk until opened.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `cd lightweaver && npx playwright test tests/pattern-lab-isolation.spec.ts tests/screen-smoke.spec.ts --project=chromium --workers=1`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Add the lazy route and rail entry**

Use the same lazy boundary as other Studio screens:

```jsx
const PatternLabScreen = lazy(() => import('../pattern-lab/PatternLabScreen.jsx'));
const SCREEN_KEYS = ['pattern', 'pattern-lab', 'playlist', 'layout', 'show', 'card'];

const Screen = {
  pattern: PatternScreen,
  'pattern-lab': PatternLabScreen,
  playlist: PlaylistScreen,
  layout: LayoutScreen,
  show: ShowScreen,
  card: CardScreen,
}[view];
```

Label the rail item `Pattern Lab`; do not rename `Patterns`.

- [ ] **Step 4: Add a self-contained empty Lab screen**

Render a title, isolation explanation, and disabled workflow shell. Import `pattern-lab.css` from the lazy screen, not from `main.jsx`, so existing routes do not load Lab CSS.

- [ ] **Step 5: Verify route isolation and build**

Run the focused Playwright command, then `cd lightweaver && npm run build`.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/pattern-lab lightweaver/src/v3/app.jsx lightweaver/tests/pattern-lab-isolation.spec.ts lightweaver/tests/screen-smoke.spec.ts
git commit -m "feat(pattern-lab): add isolated studio route"
```

## Task 2: Define versioned recipes and private storage

**Files:**
- Create: `lightweaver/src/lib/patternLabRecipe.js`
- Create: `lightweaver/src/lib/patternLabRecipe.test.js`
- Create: `lightweaver/src/lib/patternLabStorage.js`
- Create: `lightweaver/src/lib/patternLabStorage.test.js`

- [ ] **Step 1: Write failing normalization and storage tests**

Cover schema version, stable ID, name, base generator, palette, macros, evolution, seed, layers, targets, capability requirements, provenance, unknown-field preservation, backup recovery, and rejection without mutation.

- [ ] **Step 2: Implement the v1 recipe contract**

```js
export const PATTERN_LAB_RECIPE_VERSION = 1;
export const PATTERN_LAB_MAX_LAYERS = 3;

export function createPatternLabRecipe(overrides = {}) {
  return normalizePatternLabRecipe({
    version: PATTERN_LAB_RECIPE_VERSION,
    id: overrides.id || cryptoSafeId(),
    name: overrides.name || 'Untitled evolution',
    base: { kind: 'lightweaver-pattern', patternId: 'aurora', params: {} },
    palette: ['#1a0c05', '#8f3f18', '#f0a04a', '#ffe1a3'],
    macros: { color: 0.5, movement: 0.5, shape: 0.5, texture: 0.5, energy: 0.5 },
    evolution: { enabled: true, character: 'slow-bloom', durationSeconds: 600, change: 0.35 },
    seed: 1,
    layers: [],
    targets: [{ kind: 'whole-piece', id: 'all' }],
    requirements: [],
    provenance: [],
    ...overrides,
  });
}
```

Clamp duration to 300–900 seconds, macros to 0–1, palettes to 2–8 colors, and layers to three. Reject unsupported major versions.

- [ ] **Step 3: Implement namespaced draft storage**

Use `lw_pattern_lab_drafts_v1` and `lw_pattern_lab_drafts_v1_backup`; do not use `ProjectContext`, `lw_autosave_*`, or project-library keys.

- [ ] **Step 4: Verify**

Run: `cd lightweaver && node --test src/lib/patternLabRecipe.test.js src/lib/patternLabStorage.test.js`

- [ ] **Step 5: Commit**

```bash
git add lightweaver/src/lib/patternLabRecipe* lightweaver/src/lib/patternLabStorage*
git commit -m "feat(pattern-lab): add recipe and draft contracts"
```

## Task 3: Wrap the existing pattern library without changing output

**Files:**
- Create: `lightweaver/src/lib/patternLabPatternAdapter.js`
- Create: `lightweaver/src/lib/patternLabPatternAdapter.test.js`
- Use: `lightweaver/src/lib/patternRegistry.js`
- Use: `lightweaver/src/lib/patternParams.js`
- Use: `lightweaver/src/lib/patterns-library.js`
- Use: `lightweaver/src/lib/frameEngine.js`

- [ ] **Step 1: Write deterministic adapter fixtures**

Cover palette-aware, fixed-color, spatial/polar, beat, audio, per-section, and custom-parameter patterns. Compare fixed seed/time/layout frames before and after wrapping.

- [ ] **Step 2: Implement the wrapper**

```js
export function recipeFromPattern(patternId, context = {}) {
  const pattern = getPatternById(patternId);
  if (!pattern) throw new RangeError(`Unknown pattern: ${patternId}`);
  return createPatternLabRecipe({
    name: pattern.name,
    base: {
      kind: 'lightweaver-pattern',
      patternId,
      params: Object.fromEntries(parseParamsFromCode(pattern.code).map(p => [p.name, p.value])),
    },
    palette: context.palette,
    provenance: [{ source: 'lightweaver', patternId }],
  });
}
```

- [ ] **Step 3: Verify representative pixel equality**

Run: `cd lightweaver && node --test src/lib/patternLabPatternAdapter.test.js`

- [ ] **Step 4: Commit**

## Task 4: Implement easy five-to-fifteen-minute evolution

**Files:**
- Create: `lightweaver/src/lib/patternLabEvolution.js`
- Create: `lightweaver/src/lib/patternLabEvolution.test.js`
- Create: `lightweaver/src/lib/patternLabMacros.js`
- Create: `lightweaver/src/lib/patternLabMacros.test.js`

- [ ] **Step 1: Test all six evolution characters**

Required IDs: `slow-bloom`, `wandering`, `tidal`, `breathing`, `gather-release`, `rare-surprises`. For fixed recipe/seed/time, results must be deterministic. The combined clocks must not all return to their initial state inside the configured duration.

- [ ] **Step 2: Implement stable seeded clocks**

```js
export function sampleEvolution(recipe, elapsedSeconds) {
  const duration = recipe.evolution.durationSeconds;
  const arc = smoothCycle(elapsedSeconds / duration, recipe.evolution.character);
  const spatial = seededNoise1D(recipe.seed + 11, elapsedSeconds / 137);
  const texture = seededNoise1D(recipe.seed + 23, elapsedSeconds / 17);
  const rare = sampleRareEvents(recipe.seed + 47, elapsedSeconds, recipe.evolution.change);
  return { arc, spatial, texture, rare };
}
```

Use preset-specific safe destination ranges; never modulate brightness above the recipe/card ceiling.

- [ ] **Step 3: Implement reversible macro resolution**

Macros resolve into a fresh technical-value object and never destructively rewrite the source recipe. Include exact mappings and unit tests for every endpoint and midpoint.

- [ ] **Step 4: Verify and commit**

Run: `cd lightweaver && node --test src/lib/patternLabEvolution.test.js src/lib/patternLabMacros.test.js`

## Task 5: Build the first mapped preview and simple workflow

**Files:**
- Create: `lightweaver/src/pattern-lab/PatternLabPreview.jsx`
- Create: `lightweaver/src/pattern-lab/PatternLabControls.jsx`
- Create: `lightweaver/src/pattern-lab/PatternLabEvolution.jsx`
- Create: `lightweaver/src/pattern-lab/PatternLabVariants.jsx`
- Modify: `lightweaver/src/pattern-lab/PatternLabScreen.jsx`
- Test: `lightweaver/tests/pattern-lab-authoring.spec.ts`

- [ ] **Step 1: Write the user-flow test**

Test: open Lab, choose existing pattern, change one creative macro, enable Long Evolution, choose Tidal, set ten minutes, scrub beginning/middle/end, create a seeded variation, save/reopen draft. Assert the active project serialization is byte-identical before and after.

- [ ] **Step 2: Reuse the real sculpture preview**

Use `src/v3/PatternPreview.jsx` and `renderPixelFrame()` with the current geometry snapshot. Do not use `LedStage` or a generic LED strand.

- [ ] **Step 3: Add the four-step surface**

```text
Choose pattern → Sculpt the look → Add long evolution → Save variation
```

Desktop uses a side inspector; mobile uses a lower drawer. Advanced controls are collapsed by default.

- [ ] **Step 4: Add scrub and A/B behavior**

Scrubbing changes preview time only. A/B retains an immutable source snapshot. Four variations use derived seeds and do not overwrite the working draft until selected.

- [ ] **Step 5: Add explicit recipe import/export**

Download canonical `.lwrecipe.json` documents and parse imports into a temporary value before storage. Invalid schema paths appear in a bounded error list and leave the working draft unchanged.

- [ ] **Step 6: Verify responsive behavior and commit**

Run: `cd lightweaver && npx playwright test tests/pattern-lab-authoring.spec.ts --project=chromium --workers=1`

## Task 6: Add spatial transforms, palettes, and the bounded compositor

**Files:**
- Create: `lightweaver/src/lib/patternLabTransforms.js`
- Create: `lightweaver/src/lib/patternLabTransforms.test.js`
- Create: `lightweaver/src/lib/patternLabCompositor.js`
- Create: `lightweaver/src/lib/patternLabCompositor.test.js`
- Create: `lightweaver/src/pattern-lab/PatternLabLayers.jsx`

- [ ] **Step 1: Write mathematical fixtures**

Cover mirror, repeat, fold, rotate, twist, kaleidoscope, radial/linear masks, center/anchor/path distance, local strip progress, global normalized x/y, polar radius/angle, and direction/phase offsets.

- [ ] **Step 2: Implement six blend modes**

```js
export const PATTERN_LAB_BLEND_MODES = ['normal', 'add', 'screen', 'multiply', 'lighten', 'mask'];
```

All channels are clamped; Mask uses source luminance as alpha. Reject layer four rather than silently dropping it.

- [ ] **Step 3: Add reorderable palette stops and interpolation**

Support smooth, stepped, and banded interpolation, palette rotation, slow migration, warmth/saturation bounds, and incandescent cooling.

- [ ] **Step 4: Add optional layer inspector and verify**

The default recipe remains usable without opening Layers. Run focused unit tests and the authoring Playwright test.

## Task 7: Move rendering into a bounded worker

**Files:**
- Create: `lightweaver/src/lib/patternLabWorkerProtocol.js`
- Create: `lightweaver/src/lib/patternLabWorkerProtocol.test.js`
- Create: `lightweaver/src/pattern-lab/patternLab.worker.js`
- Create: `lightweaver/src/pattern-lab/usePatternLabWorker.js`
- Modify: `lightweaver/src/pattern-lab/PatternLabPreview.jsx`
- Test: `lightweaver/tests/pattern-lab-worker.spec.ts`

- [ ] **Step 1: Define the protocol**

Messages: `initialize`, `render`, `cancel`, `dispose`; replies: `ready`, `frame`, `warning`, `error`, `stats`. Every request carries a monotonically increasing ID; older results are ignored.

- [ ] **Step 2: Test timeout, cancellation, and last-valid-frame behavior**

Use a test-only generator that loops or exceeds its allocation. Assert controls remain responsive and the prior frame remains visible.

- [ ] **Step 3: Implement worker budgets**

Start with explicit limits: three layers, 384 preview samples while dragging, 1024 final samples, 24 preview FPS, bounded typed-array allocations, and a per-request wall-time warning. Full export may run slower but remains cancellable.

- [ ] **Step 4: Verify and commit**

## Task 8: Add stateful generators

**Files:**
- Create: `lightweaver/src/lib/patternLabGenerators.js`
- Create: `lightweaver/src/lib/patternLabGenerators.test.js`
- Modify: `lightweaver/src/pattern-lab/patternLab.worker.js`
- Test: `lightweaver/tests/pattern-lab-stateful.spec.ts`

- [ ] **Step 1: Test the lifecycle contract**

Every generator implements `initialize(context)`, `update(delta, state, inputs)`, `render(pixel, coordinates, state)`, and `dispose(state)`.

- [ ] **Step 2: Implement the first pack**

Include particles, ripple simulation, random walkers, cellular fields, and bounded one-dimensional Gray–Scott reaction-diffusion. Use typed arrays sized from preview resolution, deterministic seeded randomness, and no browser globals.

- [ ] **Step 3: Add generator-specific creative controls**

Expose artistic macro mappings first; technical values appear under Advanced.

- [ ] **Step 4: Verify long-running stability**

Run a complete fifteen-minute simulated evolution with accelerated clock assertions and an unaccelerated memory/fps soak where practical.

## Task 9: Add diagnostics and compatibility classification

**Files:**
- Create: `lightweaver/src/lib/patternLabCompatibility.js`
- Create: `lightweaver/src/lib/patternLabCompatibility.test.js`
- Create: `lightweaver/src/pattern-lab/PatternLabExport.jsx`
- Create: `lightweaver/src/pattern-lab/PatternLabDiagnostics.jsx`

- [ ] **Step 1: Test all four classifications**

Required states: `live-on-card`, `bake-to-card`, `simplify-for-card`, `studio-only`.

- [ ] **Step 2: Report explicit budgets**

Return pixel count, fps, operations/frame estimate, state bytes, framebuffer bytes, native config bytes against the existing 3968-byte storage cap, `.lwseq` bytes, and required microSD capacity.

- [ ] **Step 3: Add actionable diagnostics**

Unsupported features offer Bake, Simplify, or Remove feature. Simplify creates a new variant and never mutates the source.

- [ ] **Step 4: Add creative debugging tools**

Add pause, frame-step, coordinate inspector, bounded state watcher, FPS/frame-time meter, state/framebuffer byte readouts, and a `Why is this dark?` explanation covering masks, brightness, gamma, power limiting, invalid output, and unsupported targets.

- [ ] **Step 5: Verify and commit**

## Task 10: Deterministically bake recipes to `.lwseq`

**Files:**
- Create: `lightweaver/src/lib/lwseqBake.js`
- Create: `lightweaver/src/lib/lwseqBake.test.js`
- Use: `lightweaver/src/lib/standaloneController.js`
- Use: `lightweaver/src/lib/export.js`
- Modify: `lightweaver/src/pattern-lab/PatternLabExport.jsx`
- Test: `lightweaver/tests/standalone-package-unpack.mjs`

- [ ] **Step 1: Write byte-equality and rejection tests**

Same recipe, layout, seed, fps, and duration must generate identical frame bytes and hashes. Reject wall clock, `Math.random`, network access, unknown physical ordering, or unresolved audio inputs.

- [ ] **Step 2: Implement canonical bake inputs**

```js
export async function bakePatternLabRecipe({ recipe, strips, patchBoard, fps = 24, signal }) {
  const physical = pixelsFromWiring(strips, patchBoard);
  const frameCount = Math.round(recipe.evolution.durationSeconds * fps);
  // Render frameIndex / fps through the worker and feed to toLwseqBytes().
}
```

Keep the `LWSEQ1` header unchanged. Add a canonical JSON sidecar containing recipe hash, layout/physical-order hash, audio-lane hash, fps, frame count, pixel count, seed, and SHA-256 of the `.lwseq` bytes.

- [ ] **Step 3: Add storage and render-time estimates**

Use `estimateLwseqBytes()` before rendering and prevent accidental multi-gigabyte exports.

- [ ] **Step 4: Verify package round-trip and commit**

Run: `cd lightweaver && node --test src/lib/lwseqBake.test.js && node tests/standalone-package-unpack.mjs`

## Task 11: Add explicit project handoff

**Files:**
- Create: `lightweaver/src/lib/patternLabHandoff.js`
- Create: `lightweaver/src/lib/patternLabHandoff.test.js`
- Modify: `lightweaver/src/pattern-lab/PatternLabScreen.jsx`
- Modify: `lightweaver/src/pattern-lab/PatternLabExport.jsx`
- Test: `lightweaver/tests/pattern-lab-handoff.spec.ts`

- [ ] **Step 1: Test no-mutation failure paths**

Invalid, canceled, unsupported, and failed exports leave both the current project serialization and Lab draft unchanged.

- [ ] **Step 2: Implement validated handoff results**

Return one of:

```js
{ kind: 'look', look: normalizedNewLook }
{ kind: 'sequence', package: standalonePackage, manifest }
{ kind: 'blocked', reasons }
```

Built-ins and existing looks are never overwritten. Successful handoff creates a new named look or sequence asset.

- [ ] **Step 3: Add confirmation and verify**

Use in Project shows exactly what will be added. Run the handoff Playwright and unit tests.

## Task 12: Add Preview on Lights with guaranteed rollback

**Files:**
- Create: `lightweaver/src/lib/patternLabPreviewSession.js`
- Create: `lightweaver/src/lib/patternLabPreviewSession.test.js`
- Use: `lightweaver/src/lib/cardFrameStream.js`
- Use: `lightweaver/src/lib/cardLiveControl.js`
- Modify: `lightweaver/src/pattern-lab/PatternLabPreview.jsx`
- Test: `lightweaver/tests/pattern-lab-live-preview.spec.ts`

- [ ] **Step 1: Test snapshot/stop/unmount/error/tab-supersession rollback**

Snapshot card zones and selected look, claim the existing frame stream, and assert Stop first cancels streaming then restores the snapshot. When snapshot is unavailable, use the existing safe reset/project fallback.

- [ ] **Step 2: Implement the session wrapper**

Do not add a new protocol. Reuse `createCardFrameStream()`, ownership coordination, `reclaimCardFrameStreams()`, `/api/zones`, `pushLivePreviewToCard()`, and `resetLiveOutputOnCard()`.

- [ ] **Step 3: Add one visible live state and one Stop action**

No automatic hardware output occurs when Pattern Lab opens or a control changes.

- [ ] **Step 4: Verify and commit**

## Task 13: Add the card-native bounded recipe subset

**Files:**
- Create: `firmware/lightweaver-controller/src/LightweaverRecipe.h`
- Create: `firmware/lightweaver-controller/src/LightweaverRecipe.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverTypes.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverPatterns.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverPatterns.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverRuntimeApi.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Create: `firmware/lightweaver-controller/tests/recipe-capabilities.mjs`
- Create: `firmware/lightweaver-controller/test/test_recipe/test_main.cpp`

- [ ] **Step 1: Write native parser, capability, and limit tests**

Reject unknown versions/nodes, more than three layers, oversized storage, excessive operations/state, invalid palette sizes, NaN/out-of-range params, and unsupported live inputs.

- [ ] **Step 2: Define the native v1 subset**

Supported sources/operators: palette/solid, wave, FastLED noise, hash sparkle, coordinate scale/offset/repeat/mirror, radial/linear masks, threshold, add/max/multiply/crossfade, seeded LFO/noise clocks, and bounded parameters. Stateful particles, reaction-diffusion, graphs, shaders, and live audio remain bake-only.

- [ ] **Step 3: Expose a versioned capability descriptor**

Include recipe schema versions, supported nodes/blends/modulators, max layers, max config bytes, estimated state bytes, and firmware build identity in the existing capability/status surface.

- [ ] **Step 4: Preserve legacy patterns**

Existing pattern IDs and aliases continue through `LightweaverPatterns.*`; recipe-native looks are additive.

- [ ] **Step 5: Verify firmware and hardware gate**

Run: `cd firmware/lightweaver-controller && pio test -e native && pio run`

Do not claim physical parity until a representative recipe is inspected on a real card and strip.

## Task 14: Add offline audio lanes

**Files:**
- Create: `lightweaver/src/lib/offlineAudioLanes.js`
- Create: `lightweaver/src/lib/offlineAudioLanes.test.js`
- Use: `lightweaver/src/lib/showAudioFeatures.js`
- Modify: `lightweaver/src/pattern-lab/PatternLabEvolution.jsx`
- Modify: `lightweaver/src/pattern-lab/PatternLabExport.jsx`

- [ ] **Step 1: Test deterministic feature extraction**

Use a generated WAV fixture and fixed sample rate/window/hop. Assert stable bass, mid, high, level, centroid, flux, and onset lanes.

- [ ] **Step 2: Implement browser-side offline extraction**

Store numeric lanes plus audio fingerprint and analysis settings; do not store copyrighted audio in the recipe.

- [ ] **Step 3: Route audio only through bake in v1**

Any recipe using offline audio lanes classifies as Bake to card until a later measured firmware audio capability exists.

- [ ] **Step 4: Verify and commit**

## Task 15: Add xLights and MADRIX exports

**Files:**
- Create: `lightweaver/src/lib/xlightsExport.js`
- Create: `lightweaver/src/lib/xlightsExport.test.js`
- Create: `lightweaver/src/lib/madrixPatchExport.js`
- Create: `lightweaver/src/lib/madrixPatchExport.test.js`
- Modify: `lightweaver/src/pattern-lab/PatternLabExport.jsx`

- [ ] **Step 1: Create golden fixtures**

Use one multi-output mapped sculpture and assert exact pixel order, output, Art-Net universe, channel, x/y/z, group, and direction.

- [ ] **Step 2: Implement `.xmodel` and MADRIX fixture CSV**

Reuse `pixelsFromWiring()` and existing DMX calculations from `export.js`; do not add firmware format readers.

- [ ] **Step 3: Add generated Art-Net setup notes and verify**

## Task 16: Add experimental graph, shader bake, and Art-Net recording gates

**Files:**
- Create: `lightweaver/src/pattern-lab/PatternLabExperimental.jsx`
- Create: `lightweaver/src/lib/patternLabExperimental.js`
- Create: `lightweaver/src/lib/patternLabExperimental.test.js`
- Modify only after hardware approval: `firmware/lightweaver-controller/src/LightweaverArtnet.cpp`

- [ ] **Step 1: Add explicit disabled-by-default flags**

Flags: `advancedGraph`, `shaderBake`, `cardArtnetRecord`. No flag is enabled in production by default.

- [ ] **Step 2: Make graph and shader sources bake-only**

They must lower into the bounded Recipe model or render to `.lwseq`; arbitrary graph/GLSL/JavaScript never executes on the ESP32.

- [ ] **Step 3: Prefer Studio-side frame recording**

Implement recording from known Studio render frames first. Card-side Art-Net-to-SD capture proceeds only after sustained SD write, dropped-frame, power-loss, and filesystem-recovery tests on hardware.

- [ ] **Step 4: Verify that disabled flags add no runtime path**

## Task 17: Full verification, provenance, and release

**Files:**
- Create: `docs/pattern-lab-user-guide.md`
- Create: `docs/pattern-lab-algorithm-provenance.md`
- Modify: `docs/roadmap.md`
- Modify: `docs/deployment-checklist.md`
- Modify: `lightweaver/package.json` scripts only if a focused Pattern Lab test command is useful

- [ ] **Step 1: Run all focused tests**

```bash
cd lightweaver
node --test src/lib/patternLab*.test.js src/lib/lwseqBake.test.js src/lib/offlineAudioLanes.test.js src/lib/xlightsExport.test.js src/lib/madrixPatchExport.test.js
npx playwright test tests/pattern-lab-*.spec.ts --project=chromium --workers=1
node tests/standalone-package-unpack.mjs
node tests/card-frame-stream.mjs
node tests/card-live-preview.mjs
```

- [ ] **Step 2: Run full Studio verification**

Run: `cd lightweaver && npm run test:core && npm run build`

- [ ] **Step 3: Run firmware verification**

Run: `cd firmware/lightweaver-controller && pio test -e native && pio run`

- [ ] **Step 4: Run the launch gate**

Run: `cd lightweaver && npm run launch:check`

- [ ] **Step 5: Perform physical acceptance**

On a real ESP32-S3 and mapped strip/artwork, verify:

- Existing Patterns, Layout, Playlist, Show, Card, and installation flows still work.
- A ten-minute Slow Bloom recipe scrubs meaningfully and has no obvious short loop.
- A native recipe matches mapped preview color, geometry, seed, and timing.
- A complex baked recipe loops from microSD with the same physical order.
- Preview on Lights always stops and restores the previous state.
- Power limiting, RGB order, gamma, and brightness remain correct.

- [ ] **Step 6: Record provenance**

For every adapted algorithm, record source URL, author, license, original identifier, changes, and Lightweaver file path. Do not ship unverified Pixelblaze, WLED, Shadertoy, Processing, p5.js, LEDFx, or xLights code.

- [ ] **Step 7: Commit the verified documentation and release notes**

## Integration checkpoints

After Tasks 5, 8, 13, and 17, rebase or merge the latest clean `led-density-per-meter` baseline into the Pattern Lab branch and rerun the focused isolation tests. Never merge uncommitted work from the active `milan-v1` worktree.

The first deployable checkpoint is Task 5: isolated Pattern Lab, current pattern wrappers, easy Long Evolution, private drafts, and no project/hardware mutation. Tasks 6–17 expand power while preserving that safe fallback.
