# Pattern Lab Direct Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Pattern Lab independent Brightness, Speed, and motion-character controls while preserving v1 recipes and identical preview, worker, bake, and handoff behavior.

**Architecture:** Normalize recipes to schema v2, then use one pure resolver for creative macros, motion weights, master controls, and bounded evolution factors. Every render path consumes that result; Pattern Lab brightness is applied once after rendering, while controller safety limits remain downstream.

**Tech Stack:** React 18, Vite 6, JavaScript ES modules, Node test runner, Playwright.

---

### Task 1: Migrate recipes to schema v2

**Files:**
- Modify/test: `lightweaver/src/lib/patternLabRecipe.js`, `lightweaver/src/lib/patternLabRecipe.test.js`, `lightweaver/src/lib/patternLabStorage.test.js`
- [ ] **Step 1: Write failing migration tests**

```js
test('migrates v1 controls without mutation and is idempotent', () => {
  const source = createV1Recipe({ macros: {
    color: .2, movement: .5, shape: .6, texture: .7, energy: .5,
  }, extension: { kept: true } });
  const before = structuredClone(source);
  const result = normalizePatternLabRecipe(source);
  assert.deepEqual(source, before);
  assert.deepEqual(result.macros, { color: .2, movement: .5, shape: .6, texture: .7 });
  assert.deepEqual(result.playback, { brightness: .575, speed: 1.125 });
  assert.deepEqual(result.evolution.dynamics, { dynamicRange: .55, rareEventStrength: .4 });
  assert.deepEqual(result.extension, { kept: true });
  assert.deepEqual(normalizePatternLabRecipe(result), result);
});
```
Also table-test `(movement, energy) = (0,0), (.5,.5), (1,1)` against speed `.25, 1.125, 2`, brightness `.15, .575, 1`, dynamic range `.1, .55, 1`, and rare-event strength `0, .4, .8`; assert version 3 throws a specific unsupported-version error.

- [ ] **Step 2: Verify failure**

Run: `cd lightweaver && node --test src/lib/patternLabRecipe.test.js src/lib/patternLabStorage.test.js`

Expected: FAIL because the implementation is v1-only.

- [ ] **Step 3: Implement non-mutating v1 migration and v2 normalization**

```js
export const PATTERN_LAB_RECIPE_VERSION = 2;
const DEFAULT_MACROS = { color: .5, movement: .5, shape: .5, texture: .5 };
const DEFAULT_PLAYBACK = { brightness: .575, speed: 1.125 };
const DEFAULT_DYNAMICS = { dynamicRange: .55, rareEventStrength: .4 };

const movement = bounded(source.macros?.movement, 0, 1, .5);
const energy = bounded(source.macros?.energy, 0, 1, .5);
playback.brightness = .15 + energy * .85;
playback.speed = .25 + movement * 1.75;
dynamics.dynamicRange = .1 + energy * .9;
dynamics.rareEventStrength = energy * .8;
```

Remove `macros.energy` from normalized v2, preserve safe unknown extensions, bound playback to `0–1`/`.25–2`, dynamics to `.1–1`/`0–.8`, and reject majors above 2.

- [ ] **Step 4: Run tests and commit**

Run: `cd lightweaver && node --test src/lib/patternLabRecipe.test.js src/lib/patternLabStorage.test.js`

Expected: PASS, including persisted v1 drafts reopening as v2.

```bash
git add lightweaver/src/lib/patternLabRecipe.js lightweaver/src/lib/patternLabRecipe.test.js lightweaver/src/lib/patternLabStorage.test.js
git commit -m "feat: migrate Pattern Lab recipes to direct controls"
```

### Task 2: Build the shared control resolver

**Files:**
- Create/modify: `lightweaver/src/lib/patternLabControls.js`, `lightweaver/src/lib/patternLabControls.test.js`, `lightweaver/src/lib/patternLabMacros.js`, `lightweaver/src/lib/patternLabMacros.test.js`, `lightweaver/src/lib/patternLabEvolution.js`, `lightweaver/src/lib/patternLabEvolution.test.js`
- [ ] **Step 1: Write failing independence tests**

```js
test('movement changes weights without changing speed', () => {
  const drift = resolvePatternLabControls(recipe({ movement: 0 }), 120);
  const flow = resolvePatternLabControls(recipe({ movement: 1 / 3 }), 120);
  assert.deepEqual(drift.motionWeights, { drift: 1, flow: 0, pulse: 0, surge: 0 });
  assert.deepEqual(flow.motionWeights, { drift: 0, flow: 1, pulse: 0, surge: 0 });
  assert.equal(drift.masterSpeed, flow.masterSpeed);
});
test('brightness is monotonic at fixed recipe time', () => {
  const output = [0, .25, .5, .75, 1].map(brightness =>
    resolvePatternLabControls(recipe({ brightness }), 237).effectiveBrightness);
  assert.equal(output[0], 0);
  assert.ok(output.every((value, index) => index === 0 || value >= output[index - 1]));
});
```
Also assert Speed changes only `masterSpeed`/`effectiveSpeed`; evolution factors remain bounded; beginning/middle/end of a 900-second recipe differ.

- [ ] **Step 2: Verify missing module**

Run: `cd lightweaver && node --test src/lib/patternLabControls.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement pure control resolution**

```js
export function movementWeights(value) {
  const position = clamp(value, 0, 1) * 3;
  const lower = Math.min(2, Math.floor(position));
  const amount = position - lower;
  return Object.fromEntries(['drift', 'flow', 'pulse', 'surge'].map((name, index) => [
    name, index === lower ? 1 - amount : index === lower + 1 ? amount : 0,
  ]));
}
```

`resolvePatternLabControls(recipe, elapsedSeconds)` must normalize and sample once, then return technical creative values, weights, master brightness/speed, evolution brightness/rate factors, effective brightness, and effective speed clamped `.1–3`. Remove speed from Movement and Energy from macros. Use `evolution.dynamics` to bound variation and rare events.

- [ ] **Step 4: Run tests and commit**

Run: `cd lightweaver && node --test src/lib/patternLabControls.test.js src/lib/patternLabMacros.test.js src/lib/patternLabEvolution.test.js`

Expected: PASS with no Energy or Movement-owned speed expectations.

```bash
git add lightweaver/src/lib/patternLabControls* lightweaver/src/lib/patternLabMacros* lightweaver/src/lib/patternLabEvolution*
git commit -m "feat: centralize Pattern Lab control resolution"
```

### Task 3: Enforce preview, generator, worker, bake, and handoff parity

**Files:**
- Modify/test: `lightweaver/src/pattern-lab/PatternLabPreview.jsx`, `lightweaver/src/pattern-lab/PatternLabScreen.jsx`, `lightweaver/src/pattern-lab/patternLab.worker.js`, `lightweaver/src/lib/patternLabGenerators.js`, `lightweaver/src/lib/patternLabGenerators.test.js`, `lightweaver/src/lib/patternLabWorkerProtocol.js`, `lightweaver/src/lib/patternLabWorkerProtocol.test.js`, `lightweaver/src/lib/lwseqBake.js`, `lightweaver/src/lib/lwseqBake.test.js`, `lightweaver/src/lib/patternLabHandoff.js`, `lightweaver/src/lib/patternLabHandoff.test.js`
- [ ] **Step 1: Write failing parity tests**

```js
test('procedural handoff copies direct playback values', async () => {
  const result = await createPatternLabHandoff({
    recipe: recipe({ playback: { brightness: .42, speed: 1.7 } }),
    compatibility: compatibility('live-on-card'),
  });
  assert.equal(result.look.defaultLook.brightness, .42);
  assert.equal(result.look.defaultLook.speed, 1.7);
});
test('worker frame declares final controls applied', () => {
  const frame = validatePatternLabWorkerFrameReply(
    frameReply({ patternLabControlsApplied: true }), pendingFrame());
  assert.equal(frame.patternLabControlsApplied, true);
});
```
Add generator tests proving equal elapsed time and Movement changes do not alter generator clock rate, Speed does; add bake tests proving `.5` brightness is applied once rather than zero or twice.

- [ ] **Step 2: Verify failures**

Run: `cd lightweaver && node --test src/lib/patternLabGenerators.test.js src/lib/patternLabWorkerProtocol.test.js src/lib/lwseqBake.test.js src/lib/patternLabHandoff.test.js`

Expected: FAIL because generators and paths still derive speed/intensity from Movement/Energy.

- [ ] **Step 3: Route every path through the resolver**

```js
const controls = resolvePatternLabControls(recipe, renderTime);
const renderOptions = {
  masterSpeed: controls.effectiveSpeed,
  masterBrightness: controls.effectiveBrightness,
  masterSaturation: controls.masterSaturation,
  masterHueShift: controls.masterHueShift,
};
```

Generators receive motion weights separately from time rate and final brightness; remove their Movement/Energy-derived speed/intensity. Delete local `Math.min` and interpolation. Worker replies require `patternLabControlsApplied: true`; the worker is authoritative for built-in and stateful previews, which show “Preparing accurate preview…” until a validated frame arrives and then display it with speed/brightness `1`. Physical preview uses validated bytes. Bake records normalized v2/effective settings without sequence-look rescaling. Handoff reads `recipe.playback`.

- [ ] **Step 4: Run tests and commit**

Run: `cd lightweaver && node --test src/lib/patternLabControls.test.js src/lib/patternLabGenerators.test.js src/lib/patternLabWorkerProtocol.test.js src/lib/lwseqBake.test.js src/lib/patternLabHandoff.test.js`

Expected: PASS with stateful and ordinary paths applying controls once.

```bash
git add lightweaver/src/pattern-lab/PatternLabPreview.jsx lightweaver/src/pattern-lab/PatternLabScreen.jsx lightweaver/src/pattern-lab/patternLab.worker.js lightweaver/src/lib/patternLabGenerators* lightweaver/src/lib/patternLabWorkerProtocol* lightweaver/src/lib/lwseqBake* lightweaver/src/lib/patternLabHandoff*
git commit -m "fix: keep Pattern Lab render paths in control parity"
```

### Task 4: Build the six-control authoring UI

**Files:**
- Modify/test: `lightweaver/src/pattern-lab/PatternLabControls.jsx`, `lightweaver/src/pattern-lab/PatternLabScreen.jsx`, `lightweaver/src/pattern-lab/pattern-lab.css`, `lightweaver/tests/pattern-lab-authoring.spec.ts`
- [ ] **Step 1: Write a failing browser test**

```ts
test('shows six direct controls in order with no Energy', async ({ page }) => {
  await openPatternLabWithRecipe(page);
  const labels = await page.locator('.plab-macros input[type=range]')
    .evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
  expect(labels).toEqual(['Color', 'Brightness', 'Movement', 'Speed', 'Shape', 'Texture']);
  await expect(page.getByLabel('Energy')).toHaveCount(0);
  await page.getByLabel('Brightness').fill('25');
  await expect(page.getByLabel('Brightness value')).toHaveText('25%');
});
```

- [ ] **Step 2: Verify failure**

Run: `cd lightweaver && npx playwright test tests/pattern-lab-authoring.spec.ts --project=chromium --workers=1`

Expected: FAIL with five controls and no direct Brightness/Speed.

- [ ] **Step 3: Implement ordered descriptors and update handlers**

```js
const CONTROLS = [
  ['color', 'macros', 0, 100], ['brightness', 'playback', 0, 100],
  ['movement', 'macros', 0, 100], ['speed', 'playback', 25, 200],
  ['shape', 'macros', 0, 100], ['texture', 'macros', 0, 100],
];
```

Add `onPlaybackChange` in `PatternLabScreen.jsx`. Display percent Brightness, two-decimal Speed multiplier, and nearest Movement name plus percent as `aria-valuetext`. Remove Advanced’s duplicate Speed/Brightness source of truth.

- [ ] **Step 4: Run tests and commit**

Run: `cd lightweaver && npx playwright test tests/pattern-lab-authoring.spec.ts tests/pattern-lab-isolation.spec.ts --project=chromium --workers=1`

Expected: PASS without changing other Studio sections.

```bash
git add lightweaver/src/pattern-lab/PatternLabControls.jsx lightweaver/src/pattern-lab/PatternLabScreen.jsx lightweaver/src/pattern-lab/pattern-lab.css lightweaver/tests/pattern-lab-authoring.spec.ts
git commit -m "feat: add direct Pattern Lab brightness and speed controls"
```

### Task 5: Finish mobile accessibility and user guidance

**Files:**
- Modify/test: `lightweaver/tests/pattern-lab-authoring.spec.ts`, `lightweaver/src/pattern-lab/pattern-lab.css`, `docs/pattern-lab-user-guide.md`
- [ ] **Step 1: Add failing mobile/keyboard assertions**

```ts
await page.setViewportSize({ width: 390, height: 844 });
const movement = page.getByLabel('Movement');
await movement.focus();
await page.keyboard.press('Home');
await expect(movement).toHaveAttribute('aria-valuetext', 'Drift, 0%');
await page.keyboard.press('End');
await expect(movement).toHaveAttribute('aria-valuetext', 'Surge, 100%');
expect((await page.getByLabel('Brightness').boundingBox())?.height).toBeGreaterThanOrEqual(44);
```

- [ ] **Step 2: Verify failure**

Run: `cd lightweaver && npx playwright test tests/pattern-lab-authoring.spec.ts --project=chromium --workers=1`

Expected: FAIL until semantic values and touch targets are complete.

- [ ] **Step 3: Implement and document**

Give range inputs a `44px` block-size with a centered visual track, retain `:focus-visible`, and use mobile drawer padding `calc(16px + env(safe-area-inset-bottom))`. Document Brightness `0–100%`, Speed `.25–2×`, Movement’s four anchors, v1 Energy migration, and downstream electrical/current limits.

- [ ] **Step 4: Run tests and commit**

Run: `cd lightweaver && npx playwright test tests/pattern-lab-authoring.spec.ts --project=chromium --workers=1`

Expected: PASS at desktop and 390×844.

```bash
git add lightweaver/tests/pattern-lab-authoring.spec.ts lightweaver/src/pattern-lab/pattern-lab.css docs/pattern-lab-user-guide.md
git commit -m "docs: explain accessible Pattern Lab direct controls"
```

### Task 6: Run focused, full, and launch verification

**Files:**
- Verify: `lightweaver/src/lib/*.test.js`, `lightweaver/tests/pattern-lab-*.spec.ts`, `docs/deployment-checklist.md`
- [ ] **Step 1: Run Pattern Lab contracts**

Run: `cd lightweaver && node --test src/lib/patternLab*.test.js src/lib/lwseqBake.test.js`

Expected: PASS for migration, independence, monotonic brightness, generator clocks, worker parity, bake, and handoff.

- [ ] **Step 2: Run Pattern Lab browser tests**

Run: `cd lightweaver && npx playwright test tests/pattern-lab-*.spec.ts --project=chromium --workers=1`

Expected: PASS for authoring, compatibility, handoff, isolation, live preview, stateful, and worker suites.

- [ ] **Step 3: Run full verification**

Run: `cd lightweaver && npm run test:unit && npm run build && npm run launch:check`

Expected: all tests PASS, Vite builds `dist/`, and the launch gate exits `0`.

- [ ] **Step 4: Complete hardware acceptance**

Follow `docs/deployment-checklist.md` on a known non-black fixture: at fixed recipe/seed/time, verify monotonic Brightness to the configured cap; distinguish all Movement anchors at fixed Speed; compare browser, Preview on Lights, procedural handoff, and baked playback.

- [ ] **Step 5: Commit only deterministic fixture changes**

If expected v2 sidecar bytes changed:

```bash
git add lightweaver/src/lib/lwseqBake.test.js
git commit -m "test: lock Pattern Lab direct-control bake fixtures"
```
If no fixture changed, do not create an empty commit.
