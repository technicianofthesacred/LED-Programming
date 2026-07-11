# Show Spatial Audio Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Show mode visibly and gently responsive across the full mandala or connected LED layout, with stable audio analysis and synchronized song pause/resume.

**Architecture:** Split audio feature extraction and spatial-template normalization into pure modules, then make the mandala engine evaluate reusable field samples rather than a hard-coded flat ring frame. Combine every mode with a restrained shared beat substrate. Keep the Show component responsible only for browser audio, UI state, preview placement, and frame streaming.

**Tech Stack:** React 18, Vite, Web Audio API, Canvas 2D, Node `assert`/ES modules, Playwright.

---

## File structure

- Create `lightweaver/src/lib/showAudioFeatures.js`: stable logarithmic-band energy, adaptive floor/headroom, centroid, spectral flux, and beat envelope.
- Create `lightweaver/tests/show-audio-features.mjs`: deterministic analyzer fixtures and long-duration stability contracts.
- Create `lightweaver/src/lib/showSpatialTemplate.js`: Mandala and connected-layout sample normalization, bounds, and output-order preservation.
- Create `lightweaver/tests/show-spatial-template.mjs`: geometry, hidden-strip, degenerate-layout, and parity contracts.
- Modify `lightweaver/src/lib/mandalaEngine.js`: accept template samples, consume feature objects, add shared beat substrate, and update all nine fields.
- Modify `lightweaver/tests/mandala-engine.mjs`: add coverage, response, outer-radius, preset, template parity, and pause-clock contracts.
- Modify `lightweaver/src/v3/lw-show.jsx`: use the feature analyzer, spatial samples, template switch, connected preview, and pause/resume transport.
- Create `lightweaver/tests/show-screen.spec.ts`: browser-level template-switch and pause/resume behavior.
- Modify `lightweaver/package.json`: include new deterministic scripts in `test:core`.

### Task 1: Stable audio feature extraction

**Files:**
- Create: `lightweaver/src/lib/showAudioFeatures.js`
- Create: `lightweaver/tests/show-audio-features.mjs`
- Modify: `lightweaver/package.json`

- [x] **Step 1: Write the failing feature tests**

Create fixtures for silence, steady broadband input, isolated bands, and 100 ms pulses. Lock the public API:

```js
const features = createShowAudioFeatures({ sampleRate: 44100, fftSize: 2048 });
features.updateBins(bins, 1 / 60);
const frame = features.getFeatures();
assert.deepEqual(Object.keys(frame), [
  'bass', 'mid', 'high', 'energy', 'centroid', 'flux', 'beat',
]);
```

Test that steady input retains at least 70% of its stabilized energy after five simulated minutes, a pulse raises `beat` within 300 ms, silence does not trigger beats, and isolated band fixtures produce the expected dominant band.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node lightweaver/tests/show-audio-features.mjs`  
Expected: FAIL because `showAudioFeatures.js` does not exist.

- [x] **Step 3: Implement logarithmic RMS bands and stable normalization**

Implement `createShowAudioFeatures({ sampleRate, fftSize })` with:

```js
export function createShowAudioFeatures({ sampleRate = 44100, fftSize = 2048 } = {}) {
  const state = {
    floor: { bass: 0.002, mid: 0.002, high: 0.002 },
    peak: { bass: 0.12, mid: 0.12, high: 0.12 },
    previousSpectrum: new Float32Array(fftSize / 2),
    features: { bass: 0, mid: 0, high: 0, energy: 0, centroid: 0, flux: 0, beat: 0 },
  };

  return {
    updateBins(byteBins, dt = 1 / 60) { /* RMS, floor/peak, flux, beat */ },
    updateAnalyser(analyser, dt = 1 / 60) { /* reuse one Uint8Array and call updateBins */ },
    reset() { /* clear transient state without reallocating */ },
    getFeatures() { return { ...state.features }; },
  };
}
```

Use RMS across 30–140 Hz, 150–1800 Hz, and 2000–9000 Hz. Let the floor rise slowly and fall moderately; let headroom rise quickly and decay very slowly so a steady signal cannot be normalized away. Compute positive spectral flux from normalized bin increases. Drive `beat` from flux plus positive broadband-energy change with eased attack and roughly 350–650 ms release.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `node lightweaver/tests/show-audio-features.mjs`  
Expected: `show-audio-features tests passed`.

- [x] **Step 5: Add the test to `test:core` and commit**

Add `node tests/show-audio-features.mjs` immediately before `node tests/mandala-engine.mjs`.

```bash
git add lightweaver/src/lib/showAudioFeatures.js lightweaver/tests/show-audio-features.mjs lightweaver/package.json
git commit -m "feat(show): add stable musical feature analysis"
```

### Task 2: Spatial template normalization

**Files:**
- Create: `lightweaver/src/lib/showSpatialTemplate.js`
- Create: `lightweaver/tests/show-spatial-template.mjs`
- Modify: `lightweaver/package.json`

- [x] **Step 1: Write failing geometry tests**

Lock the sample shape and both constructors:

```js
const template = createConnectedSpatialTemplate({
  strips: [{ id: 'a', pixels: [{ x: 0, y: 0 }, { x: 100, y: 50 }] }],
  hidden: {},
});
assert.equal(template.kind, 'connected');
assert.equal(template.samples.length, 2);
assert.deepEqual(Object.keys(template.samples[0]), [
  'outputIndex', 'stripId', 'stripIndex', 'stripProgress', 'x', 'y', 'radius', 'angle',
]);
```

Test centered aspect-preserving normalization, stable strip/output order, exclusion of hidden/empty strips, zero-width/height safety, and `createMandalaSpatialTemplate()` parity with the exported 675-pixel ring coordinates.

- [x] **Step 2: Run focused test and verify RED**

Run: `node lightweaver/tests/show-spatial-template.mjs`  
Expected: FAIL because `showSpatialTemplate.js` does not exist.

- [x] **Step 3: Implement cached pure template constructors**

Export:

```js
export function createMandalaSpatialTemplate() { /* 675 samples from ring map */ }
export function createConnectedSpatialTemplate({ strips = [], hidden = {} } = {}) { /* normalized samples */ }
export function hasUsableConnectedLayout(strips = [], hidden = {}) {
  return strips.some(strip => !hidden[strip.id] && strip.pixels?.some(validPoint));
}
```

Normalize the longer layout dimension to `[-1, 1]`, center the shorter dimension, derive `radius` and `angle`, and retain `stripId`, `stripIndex`, `stripProgress`, and contiguous `outputIndex`.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `node lightweaver/tests/show-spatial-template.mjs`  
Expected: `show-spatial-template tests passed`.

- [x] **Step 5: Add to `test:core` and commit**

```bash
git add lightweaver/src/lib/showSpatialTemplate.js lightweaver/tests/show-spatial-template.mjs lightweaver/package.json
git commit -m "feat(show): normalize connected layout geometry"
```

### Task 3: Whole-piece substrate and spatial mode fields

**Files:**
- Modify: `lightweaver/src/lib/mandalaEngine.js`
- Modify: `lightweaver/tests/mandala-engine.mjs`

- [x] **Step 1: Write failing coverage and response contracts**

Add deterministic fixtures that call `engine.setFeatures(features)` and assert:

```js
for (const { key } of MODE_LIBRARY) {
  const engine = createMandalaEngine({ template: createMandalaSpatialTemplate() });
  engine.setMode(key);
  driveRepeatedBeat(engine, 8);
  assertEveryLayerMoves(engine.getFrameHistory(), key);
  assert.ok(changedPixelRatio(engine.getFrameHistory()) >= 0.80, `${key}: Calm whole-field motion`);
}
```

Also require Tide and Bloom to change outer-radius samples, lively modes to exceed a beat-delta threshold, Active to exceed Calm modulation without exceeding the brightness ceiling, and equivalent coordinates across template kinds to receive equivalent field values.

- [x] **Step 2: Run the mandala test and verify RED**

Run: `node lightweaver/tests/mandala-engine.mjs`  
Expected: FAIL on whole-layer coverage for Meridian/Embers/Procession/Spiral and outer-radius coverage for Tide/Bloom.

- [x] **Step 3: Generalize engine buffers to the active template**

Change construction and template updates to:

```js
export function createMandalaEngine({ template = createMandalaSpatialTemplate() } = {}) {
  let spatial = template;
  let vals = new Float32Array(spatial.samples.length);
  // target, zoneOf, crestOf follow the active sample count
  function setTemplate(next) { /* replace buffers while preserving mode/settings */ }
  function setFeatures(next) { /* clamp and copy bass/mid/high/energy/centroid/flux/beat */ }
}
```

Keep `analyze()` as a compatibility wrapper only if existing non-Show callers require it; the Show screen should use the new analyzer in Task 4.

- [x] **Step 4: Add the shared beat substrate**

After the mode field fills `target[]`, combine a restrained per-sample substrate:

```js
const depth = presetName === 'Active' ? 0.14 : 0.08;
const phase = sample.radius * radialWeight + sample.stripIndex * 0.17 + sample.stripProgress * 0.25;
const travellingBeat = features.beat * (0.55 + 0.45 * Math.cos(phase - beatPhase));
target[i] = clamp01(target[i] + depth * travellingBeat);
```

Use mode-specific radial/angular/strip phase weights. Do not apply one uniform flash.

- [x] **Step 5: Rework all nine modes as spatial fields**

Use `sample.radius`, `sample.angle`, `sample.stripIndex`, and `sample.stripProgress` rather than `ringOf`, `rfOf`, and `angOf` inside effect kernels. Preserve palette identities while meeting the spec expectations:

- Meridian adds quiet echoes outside the primary layer.
- Hearth localizes bass warmth movement.
- Embers adds a low-level full-field shimmer beneath sparse sparks.
- Strata interpolates bands continuously by radius.
- Tide guarantees traversal through radius `1`.
- Lattice articulates nodes with beat plus energy.
- Procession widens its whole-field path and adds broadband fallback.
- Bloom reaches radius `1` and leaves a soft trail.
- Spiral adds beat travel and broadband fallback along authored arms.

- [x] **Step 6: Verify engine tests GREEN**

Run: `node lightweaver/tests/mandala-engine.mjs`  
Expected: `mandala-engine tests passed` with all coverage contracts.

- [x] **Step 7: Commit the engine slice**

```bash
git add lightweaver/src/lib/mandalaEngine.js lightweaver/tests/mandala-engine.mjs
git commit -m "feat(show): spread musical motion across every layer"
```

### Task 4: Show template switch and synchronized pause

**Files:**
- Modify: `lightweaver/src/v3/lw-show.jsx`
- Create: `lightweaver/tests/show-screen.spec.ts`

- [x] **Step 1: Write failing browser tests**

Add stable `data-testid` hooks and tests for:

```ts
await expect(page.getByTestId('show-template-mandala')).toBeVisible();
await expect(page.getByTestId('show-template-connected')).toBeVisible();
await page.getByTestId('show-template-connected').click();
await expect(page.getByTestId('show-stage')).toHaveAttribute('data-template', 'connected');

await page.setInputFiles('[data-testid="show-song-input"]', fixtureSong);
await page.getByTestId('show-pause').click();
await expect(page.getByTestId('show-transport-state')).toHaveText('paused');
```

Use an in-test browser stub for `AudioContext`, `HTMLMediaElement.play/pause`, RAF, and the frame stream. Assert that the rendered/staged frame remains stable while paused and changes again after resume.

- [x] **Step 2: Run focused Playwright test and verify RED**

Run: `cd lightweaver && npx playwright test tests/show-screen.spec.ts`  
Expected: FAIL because the template and pause controls do not exist.

- [x] **Step 3: Integrate the analyzer and templates**

In `ShowScreen`, memoize Mandala and connected templates from `strips` and `hidden`, instantiate `createShowAudioFeatures()`, and call:

```js
featureRef.current.updateAnalyser(audio.analyser, dt);
engine.setFeatures(featureRef.current.getFeatures());
engine.setTemplate(activeTemplate);
```

Connected layout defaults on when usable; otherwise Mandala is selected with an inline explanation. Render canvas pixels from active sample x/y coordinates instead of the fixed ring arrays.

- [x] **Step 4: Add synchronized pause/resume**

Track `songPaused` in React state and a mutable `pausedRef` for RAF. Pause the media element, stop engine ticks and new frame encodes, and keep the last encoded frame available to the stream keepalive. On resume, call `play()`, resume the audio context, set `prev = performance.now()`, and continue without applying elapsed pause time.

- [x] **Step 5: Verify focused Playwright GREEN**

Run: `cd lightweaver && npx playwright test tests/show-screen.spec.ts`  
Expected: all Show screen tests pass.

- [x] **Step 6: Commit the Show UI slice**

```bash
git add lightweaver/src/v3/lw-show.jsx lightweaver/tests/show-screen.spec.ts
git commit -m "feat(show): add connected template and song pause"
```

### Task 5: Integrated verification and documentation alignment

**Files:**
- Modify: `docs/mandala-effects-direction-v2.md`
- Modify: `docs/mandala-color-system.md` only if implementation changes a documented invariant
- Modify: `docs/superpowers/plans/2026-07-11-show-spatial-audio-engine.md`

- [x] **Step 1: Update the effect direction to the new approved contract**

Replace claims that sparse/partial-field output may leave layers inert with the foreground-plus-substrate model. Define “livelier” as stronger musical articulation and spatial propagation, while retaining the no-strobe and warm-palette constraints.

- [x] **Step 2: Run focused deterministic tests**

Run:

```bash
node lightweaver/tests/show-audio-features.mjs
node lightweaver/tests/show-spatial-template.mjs
node lightweaver/tests/mandala-engine.mjs
```

Expected: all three print their passed message and exit 0.

- [x] **Step 3: Run browser integration tests**

Run: `cd lightweaver && npx playwright test tests/show-screen.spec.ts`  
Expected: all tests pass.

- [x] **Step 4: Run the complete launch gate**

Run: `cd lightweaver && npm run launch:check`  
Expected: `test:core` and Vite production build exit 0.

- [x] **Step 5: Inspect the final diff and commit documentation**

Run `git diff --check` and review `git diff origin/main...HEAD` for unrelated changes, placeholder comments, duplicate analyzer paths, and accidental changes to deferred Pi runtime files.

```bash
git add docs/mandala-effects-direction-v2.md docs/mandala-color-system.md docs/superpowers/plans/2026-07-11-show-spatial-audio-engine.md
git commit -m "docs(show): align effects contract with spatial response"
```
