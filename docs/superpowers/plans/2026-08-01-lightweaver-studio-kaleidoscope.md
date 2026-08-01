# Lightweaver Studio Kaleidoscope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-strip Kaleidoscope reflection-point calibration to Studio and make every browser render, worker render, Show frame, and `.lwseq` bake consume identical source-local reflection semantics.

**Architecture:** Persist only `{ enabled, pointCount, startLed, offsets }` on each Layout strip. A pure `kaleidoscope.js` module validates and transforms that compact model; `renderGeometry.js` compiles it once per strip into per-pixel context shared by Layout, Patterns, Pattern Lab, workers, Show, and baking. Calibration uses the existing card frame stream and compiled wiring order, while a dedicated non-physical reducer action guarantees Kaleidoscope edits never unlock or invalidate verified wiring.

**Tech Stack:** React 18, Vite 6, JavaScript ES modules, Node test runner, Playwright, Web Workers, existing card frame-stream bridge.

---

## Exact file map

- Create `lightweaver/src/lib/kaleidoscope.js` and `kaleidoscope.test.js`: compact model, validation, transforms, point/context derivation.
- Create `lightweaver/src/lib/renderGeometry.js` and `renderGeometry.test.js`: one project-strip-to-render-strip normalization path.
- Create `lightweaver/src/lib/kaleidoscopeCalibration.js` and `.test.js`: physical-order red frames and transient stream lifecycle.
- Create `lightweaver/src/components/layout/hooks/useKaleidoscopeCalibration.js`: Layout calibration state, pulse loop, teardown, honest status.
- Create `lightweaver/tests/layout-kaleidoscope.spec.ts`: toolbar, panel, pick/drag/nudge, persistence, zoom/pan, wiring, teardown.
- Modify `lightweaver/src/lib/projectModel.js`, `.test.js`: optional v3 field migration, warnings, legacy export stripping; no project-version bump.
- Modify `lightweaver/src/state/layoutReducer.js`, `ProjectContext.jsx`, `lightweaver/tests/layout-reducer.mjs`: metadata action and wiring invariant.
- Modify `lightweaver/src/components/layout/hooks/useLayoutStrips.js`, `useLayoutSize.js`: duplicate/reverse/count transforms.
- Modify `lightweaver/src/components/LayoutScreen.jsx`, `layout/modes/DrawModePanel.jsx`, `layout/canvas/LayoutCanvas.jsx`, `styles/v3-layout-extra.css`: editor UI and canvas handles.
- Modify `lightweaver/src/lib/patterns.js`, `frameEngine.js`, `lightweaver/src/v3/PatternPreview.jsx`, `components/layout/hooks/useLayoutCanvasInteraction.js`: shared browser semantics.
- Modify `lightweaver/src/lib/patternLabPatternAdapter.js`, `patternLabWorkerProtocol.js`, `patternLabWorkerProtocol.test.js`, `lightweaver/src/pattern-lab/patternLab.worker.js`, `PatternLabScreen.jsx`, `PatternLabPreview.jsx`, `lightweaver/tests/pattern-lab-worker.spec.ts`: main-thread/worker parity.
- Modify `lightweaver/src/lib/showSpatialTemplate.js`, `lightweaver/tests/show-spatial-template.mjs`, `lightweaver/src/lib/lwseqBake.js`, `lwseqBake.test.js`: Show and bake parity.
- Modify `lightweaver/src/lib/export.test.js`, `madrixPatchExport.test.js`, `xlightsExport.test.js`, `lightweaver/package.json`: unchanged third-party exports and launch coverage.

### Task 1: Compact model, validation, migration, and wiring-safe state

**Files:** create `src/lib/kaleidoscope.js`, `src/lib/kaleidoscope.test.js`; modify `src/lib/projectModel.js`, `src/lib/projectModel.test.js`, `src/state/layoutReducer.js`, `src/state/ProjectContext.jsx`, `tests/layout-reducer.mjs`.

- [ ] **Write RED tests** for exact `400/4 → [0,100,200,300]`, `400/6 → [0,67,133,200,267,333]`, `400/8`, start wrap, whole-set start nudge, independent offsets, collision/crossing rejection, reversal preserving physical LEDs, proportional `400→453` reprojection, `<2` rejection, malformed/fractional/out-of-range migration warnings, old projects loading unchanged, legacy export omitting the field, and a locked/verified wiring object remaining byte-identical after metadata edits.
- [ ] **Run RED:** `cd lightweaver && node --test src/lib/kaleidoscope.test.js src/lib/projectModel.test.js && node tests/layout-reducer.mjs` — expect missing exports/action failures.
- [ ] **Implement these exact public contracts** (card/runtime work imports the same names):

```js
export const KALEIDOSCOPE_REFLECTION_POINTS_VERSION = 1;
export function createDefaultKaleidoscope(pixelCount, startLed = 0) {}
export function deriveReflectionPointIndices(mapping, pixelCount) {}
export function validateKaleidoscope(mapping, pixelCount) {} // {ok,value,errors}; missing/disabled => {ok:true,value:null,errors:[]}
export function normalizeKaleidoscope(mapping, pixelCount) {} // {enabled,value,points,errors}; never guesses malformed enabled data
export function setKaleidoscopePointCount(mapping, pixelCount, pointCount) {}
export function nudgeKaleidoscopeStart(mapping, pixelCount, delta) {}
export function nudgeKaleidoscopePoint(mapping, pixelCount, pointIndex, delta) {} // {ok,value,error}
export function reverseKaleidoscope(mapping, pixelCount) {}
export function reprojectKaleidoscope(mapping, oldPixelCount, newPixelCount) {} // {value,resetPointIndices}
export function deriveReflectionPixelContext(compiledContext, sourceLed) {}
```

Use `mod(S + Math.round(k * N / C), N)`. At an exact point, assign the outgoing interval; even intervals fold `p`, odd intervals fold `1-p`. Normalize nearest distance so points are `0` and an interval midpoint is `1`; an exact midpoint has `reflectionPoint: null`. Store actionable warnings as `{scope:'kaleidoscope',stripId,code,message}` and disable only that mapping. Keep `PROJECT_VERSION = 3`; `toLegacyProject()` removes `strip.kaleidoscope` and Kaleidoscope warnings.
- [ ] Add `layout/updateKaleidoscope` and `updateStripKaleidoscope(id, value, {recordHistory=true})`. Do not add it to `physicalChangeKinds`; prove locked wiring is unchanged. Clear that strip's warning on a valid edit.
- [ ] **Run GREEN and commit:** same command; then `git add ... && git commit -m "feat(layout): add kaleidoscope strip metadata"`.

### Task 2: Preserve mappings through strip operations

**Files:** modify `src/components/layout/hooks/useLayoutStrips.js`, `useLayoutSize.js`, `src/state/layoutReducer.js`, `src/lib/kaleidoscope.test.js`, `tests/layout-reducer.mjs`.

- [ ] **Write RED tests** proving duplicate deep-copies offsets; reverse maps every old physical LED to `N-1-index`; move/scale/color leave indices unchanged; all count paths call reprojection; irreconcilable offsets alone reset and report indices; remove deletes with strip; merge does not inherit the first strip's unrelated mapping.
- [ ] **Run RED:** `cd lightweaver && node --test src/lib/kaleidoscope.test.js && node tests/layout-reducer.mjs`.
- [ ] Apply `reverseKaleidoscope()` in both reducer and hook paths, `reprojectKaleidoscope()` wherever `pixelCount` changes (`setStripCount`, batch counts, density/scale/calibration recount, physical size, scale), and clone `offsets` on duplicate. Return reset notices through Layout state; never route metadata-only edits through `setStrips`/`compat/set`.
- [ ] **Run GREEN and commit:** same command; `git commit -m "feat(layout): preserve kaleidoscope calibration through edits"`.

### Task 3: Shared browser renderer and authored-pattern semantics

**Files:** create `src/lib/renderGeometry.js`, `.test.js`; modify `src/lib/patterns.js`, `frameEngine.js`, `src/v3/PatternPreview.jsx`, `components/layout/hooks/useLayoutCanvasInteraction.js`.

- [ ] **Write RED tests** for this contract and exact boundary/tie behavior:

```js
export function normalizeProjectRenderStrips(strips, { hidden = {}, includeHidden = false } = {}) {}
// each pt: {x,y,i,sourceProgress,p,reflectionProgress,kaleidoscopeProgress,
// reflectionDistance,reflectionSegment,reflectionPoint,isReflectionPoint}
```

Assert context is compiled once per strip, enabled `stripProgress === kaleidoscopeProgress`, disabled progress is unchanged, and `x/y` remain byte-identical. Compile an authored pattern using all six new reflection names.
- [ ] **Run RED:** `cd lightweaver && node --test src/lib/renderGeometry.test.js`.
- [ ] Route PatternPreview and Layout light-preview strip construction through `normalizeProjectRenderStrips`. Extend `compile()`/`evalPixel()` with trailing parameters `reflectionProgress, kaleidoscopeProgress, reflectionDistance, reflectionSegment, reflectionPoint, isReflectionPoint` after `hi`; update the wrapper slice count. In `frameEngine`, pass folded progress only as `stripProgress`; never replace `x`, `y`, radius, angle, or global index.
- [ ] **Run GREEN and commit:** same command; `git commit -m "feat(render): share kaleidoscope pixel semantics"`.

### Task 4: Layout toolbar, panel, and canvas editing

**Files:** modify `src/components/LayoutScreen.jsx`, `layout/modes/DrawModePanel.jsx`, `layout/canvas/LayoutCanvas.jsx`, `styles/v3-layout-extra.css`; create `tests/layout-kaleidoscope.spec.ts`.

- [ ] **Write RED browser tests** that create a 12-LED strip and assert left group `Flip path · Data direction · First LED · Kaleidoscope`, right group `Duplicate · Visibility · Delete`; accessible name `Edit Kaleidoscope reflection points`; closed summary `4 points · start LED 1`; arbitrary count `2…12`; nonzero-offset confirmation; canvas start pick; whole-set start arrows; one-point fine-tune arrows; invalid neighbor limit message; drag snapping after zoom and pan; save/reload; duplicate; and locked verified wiring staying locked/verified.
- [ ] **Run RED:** `cd lightweaver && npx playwright test tests/layout-kaleidoscope.spec.ts --project=chromium --workers=1`.
- [ ] Implement one open editor per expanded strip. Default count is `min(4,pixelCount)` only when `pixelCount>=2`; LEDs display one-based while state stays zero-based. Fine-tune lists all points, selects canvas/list bidirectionally, and uses reducer results for inline errors. Canvas markers use `strip.pixels[finalIndex]`; pointer coordinates use `getScreenCTM().inverse()`, pointer capture, and nearest source LED, so zoom/pan cannot change selection. Push one undo snapshot at drag start, then update without extra history entries.
- [ ] Move the existing visibility button only; do not change its handler, Duplicate, Delete, first LED, path direction, or data direction behavior. Kaleidoscope metadata must never enter wiring cuts/runs.
- [ ] **Run GREEN and commit:** same command; `git commit -m "feat(layout): add kaleidoscope calibration editor"`.

### Task 5: Live red calibration with safe ownership and restoration

**Files:** create `src/lib/kaleidoscopeCalibration.js`, `.test.js`, `src/components/layout/hooks/useKaleidoscopeCalibration.js`; modify `src/components/LayoutScreen.jsx`, `layout/modes/DrawModePanel.jsx`, `layout/canvas/LayoutCanvas.jsx`.

- [ ] **Write RED unit tests** for:

```js
export function buildKaleidoscopeCalibrationFrame({ compiledWiring, stripId, pointIndices, selectedPointIndex, pulse }) {}
export function createKaleidoscopeCalibrationSession({ host, readSnapshot, createStream, restoreLook, resetOutput, onStateChange }) {}
```

Assert compiled physical order handles reverse, seams, splits, inactive gaps, and outputs; non-points are `000000`, points steady red, selection pulses brighter; start/stop restore prior output; unmount, strip switch, Layout exit, cancel, delivery failure, and ownership loss stop exactly once; superseded ownership does not cancel the new owner.
- [ ] **Run RED:** `cd lightweaver && node --test src/lib/kaleidoscopeCalibration.test.js`.
- [ ] Start streaming only while Pick/Fine-tune is active. Rebuild/push immediately on every accepted edit and animate only selected brightness at the existing 18 FPS cap. Separate `canvasUpdated` from `physicalDelivered`; failures say `Canvas updated · physical preview unavailable`, never claim the light moved. Use `onConnectCard`/`onOpenConnectionCenter` already passed by the app as recovery actions. Cleanup awaits `stream.stop()` plus snapshot restore, except ownership transfer where restoring would cancel the new stream.
- [ ] **Run GREEN plus browser teardown cases:** unit command, then the Task 4 Playwright command; commit `git commit -m "feat(layout): stream kaleidoscope calibration frames"`.

### Task 6: Pattern Lab, worker, Show, and `.lwseq` parity

**Files:** modify `src/lib/patternLabPatternAdapter.js`, `patternLabWorkerProtocol.js`, `.test.js`, `src/pattern-lab/patternLab.worker.js`, `PatternLabScreen.jsx`, `PatternLabPreview.jsx`, `src/lib/showSpatialTemplate.js`, `tests/show-spatial-template.mjs`, `src/lib/lwseqBake.js`, `lwseqBake.test.js`, `tests/pattern-lab-worker.spec.ts`.

- [ ] **Write RED tests** comparing the same recipe/time across main thread, worker samples, PatternPreview callback, Show connected template, direct bake, worker bake, and physical remap. Include multiple visual layers targeting one strip and prove each receives identical reflection values. Assert `.lwseq` hashes change when mapping changes and remain deterministic when unchanged.
- [ ] **Run RED:** `cd lightweaver && node --test src/lib/patternLabWorkerProtocol.test.js src/lib/lwseqBake.test.js && node tests/show-spatial-template.mjs && npx playwright test tests/pattern-lab-worker.spec.ts --project=chromium --workers=1`.
- [ ] Bump worker geometry to version 2 and transfer typed arrays for folded/reflection progress and distance (`Float64Array`), segment/nearest point (`Int32Array`, `-1` for null), and point flag (`Uint8Array`); include all buffers in byte budgets and clone transfers. `sampledStrips()` restores these fields before every base/layer render. Use `normalizeProjectRenderStrips()` in Pattern Lab main-thread and bake paths. In Show, precompile a context map once per strip, preserve `x/y/radius/angle`, set only compatible `stripProgress` to folded progress, and attach reflection fields to samples.
- [ ] Keep RGB card streaming and final `remapFrameToWiring()` unchanged; they consume fully rendered frames. Run GREEN with the same command and commit `git commit -m "feat(render): carry kaleidoscope through workers and baking"`.

### Task 7: Migration/export regressions and full Studio verification

**Files:** modify `src/lib/export.test.js`, `madrixPatchExport.test.js`, `xlightsExport.test.js`, `package.json`.

- [ ] Add tests proving WLED `ledmap.json`, coordinate-map/CSV/FastLED, Madrix, and xLights output contain no Kaleidoscope metadata and remain byte-identical for otherwise identical projects. Add `tests/layout-kaleidoscope.spec.ts` to `test:release-ui`; do not change exporter implementations.
- [ ] Run focused suites: `cd lightweaver && node --test src/lib/kaleidoscope.test.js src/lib/renderGeometry.test.js src/lib/kaleidoscopeCalibration.test.js src/lib/projectModel.test.js src/lib/patternLabWorkerProtocol.test.js src/lib/lwseqBake.test.js src/lib/export.test.js src/lib/madrixPatchExport.test.js src/lib/xlightsExport.test.js && node tests/layout-reducer.mjs tests/show-spatial-template.mjs`.
- [ ] Run browser suites: `cd lightweaver && npx playwright test tests/layout-kaleidoscope.spec.ts tests/layout-hardening.spec.ts tests/layout-zoom.spec.ts tests/pattern-lab-worker.spec.ts tests/show-screen.spec.ts --project=chromium --workers=1`.
- [ ] Run final Studio gate: `cd lightweaver && npm run test:unit && npm run build`. Expected: all tests pass and Vite builds. Standalone firmware persistence/capability gating and all breathing work are explicitly excluded from this plan.
- [ ] Commit only after verification: `git add lightweaver/package.json lightweaver/src lightweaver/tests && git commit -m "test: verify studio kaleidoscope end to end"`.
