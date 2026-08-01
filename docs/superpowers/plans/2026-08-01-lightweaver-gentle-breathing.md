# Lightweaver Gentle Breathing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Lightweaver look an optional, smooth Breathe modifier with independently adjustable 0–100% lower/upper brightness and a true 4–30 second cycle, defaulting legacy and new enabled looks to 85–100% over 9 seconds, with matching Studio preview and standalone-card output.

**Architecture:** Add three optional canonical look fields—`breatheLowerPct`, `breatheUpperPct`, and `breatheCycleSeconds`—beside the existing `customBreathe` boolean, and normalize missing values to `85`, `100`, and `9`. The Breathe cycle is a wall-clock envelope and does not inherit the general pattern `speed`; this prevents a slow ambient look from turning a 9-second breath into a multi-minute dark-to-light transition, while existing speed continues to control pattern motion, Calm, and white-preset Drift. Use the same cosine-eased envelope equation in browser and firmware, carry the fields through section looks, production/runtime/storage/API boundaries, and retain the current 30 FPS render loop rather than simulating slowness by dropping frames.

**Tech Stack:** React 18, Vite, Node test runner, Playwright, ESP32-S3 Arduino/FastLED firmware, ArduinoJson, host-compiled C++ contract tests.

---

## Scope boundary

This plan implements only gentle breathing and the ambient-motion verification requested by the approved design. It does not create, modify, migrate, test, or capability-gate Layout Kaleidoscope reflection points.

## File map

- `lightweaver/src/lib/breatheEnvelope.js` owns browser defaults, normalization, and the deterministic envelope equation.
- `lightweaver/src/lib/cardVisualLook.js` owns canonical look migration, including legacy boolean-only looks.
- `lightweaver/src/lib/previewColorModifiers.js` applies the canonical envelope to preview pixels.
- `lightweaver/src/lib/sectionLookModel.js`, `cardRuntimeContract.js`, `cardRuntimeProject.js`, `cardStoragePayload.js`, and `productionJobPackage.js` transport the three fields without changing unrelated look semantics.
- `lightweaver/src/lib/cardLiveControl.js` and `patternLabPreviewSession.js` transport and restore live card state.
- `lightweaver/src/v3/lw-pattern.jsx` and `lightweaver/src/styles/v3-patterns-extra.css` expose compact Advanced controls.
- `firmware/lightweaver-controller/src/LightweaverBreathe.h` owns the firmware form of the shared equation without depending on Arduino or FastLED, so it can be host-tested.
- `firmware/lightweaver-controller/src/LightweaverTypes.h`, `LightweaverRuntimeApi.h`, `LightweaverStorage.cpp`, `LightweaverWeb.cpp`, and `main.cpp` own firmware persistence, API mutation/readback, and zone propagation.
- `firmware/lightweaver-controller/src/LightweaverPatterns.h/.cpp` apply the envelope and correct Calm/white timing.
- Focused unit, contract, browser, and host-C++ tests prove migration, validation, transport, persistence, parity, cadence, and ambient behavior.

### Task 1: Define the browser look contract and envelope math

**Files:**
- Create: `lightweaver/src/lib/breatheEnvelope.js`
- Create: `lightweaver/src/lib/breatheEnvelope.test.js`
- Modify: `lightweaver/src/lib/cardVisualLook.js:12-38`
- Modify: `lightweaver/src/lib/previewColorModifiers.js:1-18,151-188`

- [ ] **Step 1: Write the failing normalization and envelope tests**

Create `lightweaver/src/lib/breatheEnvelope.test.js` with these contract cases:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BREATHE_SETTINGS,
  normalizeBreatheSettings,
  resolveBreatheScale,
} from './breatheEnvelope.js';
import { normalizeCardVisualLook } from './cardVisualLook.js';

test('legacy enabled and disabled booleans receive gentle numeric defaults', () => {
  assert.deepEqual(DEFAULT_BREATHE_SETTINGS, {
    breatheLowerPct: 85,
    breatheUpperPct: 100,
    breatheCycleSeconds: 9,
  });
  for (const customBreathe of [true, false]) {
    const look = normalizeCardVisualLook({ customBreathe });
    assert.equal(look.customBreathe, customBreathe);
    assert.equal(look.breatheLowerPct, 85);
    assert.equal(look.breatheUpperPct, 100);
    assert.equal(look.breatheCycleSeconds, 9);
  }
});

test('normalization clamps ranges and never returns inverted bounds', () => {
  assert.deepEqual(normalizeBreatheSettings({
    breatheLowerPct: -12,
    breatheUpperPct: 140,
    breatheCycleSeconds: 80,
  }), {
    breatheLowerPct: 0,
    breatheUpperPct: 100,
    breatheCycleSeconds: 30,
  });
  assert.deepEqual(normalizeBreatheSettings({
    breatheLowerPct: 90,
    breatheUpperPct: 40,
    breatheCycleSeconds: 3,
  }), {
    breatheLowerPct: 40,
    breatheUpperPct: 40,
    breatheCycleSeconds: 4,
  });
});

test('85–100% over 9 seconds is smooth, periodic, and independent of look speed', () => {
  const look = {
    customBreathe: true,
    breatheLowerPct: 85,
    breatheUpperPct: 100,
    breatheCycleSeconds: 9,
  };
  assert.equal(resolveBreatheScale(0, look), 217);
  assert.equal(resolveBreatheScale(4500, look), 255);
  assert.equal(resolveBreatheScale(9000, look), 217);
  assert.equal(resolveBreatheScale(4500, { ...look, speed: 0.05 }), 255);

  const samples = Array.from({ length: 271 }, (_, frame) =>
    resolveBreatheScale(frame * (1000 / 30), look));
  assert.ok(samples.every(value => value >= 217 && value <= 255));
  assert.ok(Math.max(...samples.slice(1).map((value, index) =>
    Math.abs(value - samples[index]))) <= 1);
});

test('equal bounds are steady and disabled Breathe leaves full scale', () => {
  assert.equal(resolveBreatheScale(1234, {
    customBreathe: true,
    breatheLowerPct: 92,
    breatheUpperPct: 92,
    breatheCycleSeconds: 9,
  }), 235);
  assert.equal(resolveBreatheScale(1234, { customBreathe: false }), 255);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
cd lightweaver
node --test src/lib/breatheEnvelope.test.js
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `breatheEnvelope.js`.

- [ ] **Step 3: Implement the canonical browser helper and look migration**

Create `lightweaver/src/lib/breatheEnvelope.js` with this complete public surface:

```js
export const DEFAULT_BREATHE_SETTINGS = Object.freeze({
  breatheLowerPct: 85,
  breatheUpperPct: 100,
  breatheCycleSeconds: 9,
});

function clampInt(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

export function normalizeBreatheSettings(look = {}) {
  const lower = clampInt(
    look.breatheLowerPct,
    DEFAULT_BREATHE_SETTINGS.breatheLowerPct,
    0,
    100,
  );
  const upper = clampInt(
    look.breatheUpperPct,
    DEFAULT_BREATHE_SETTINGS.breatheUpperPct,
    0,
    100,
  );
  return {
    breatheLowerPct: Math.min(lower, upper),
    breatheUpperPct: upper,
    breatheCycleSeconds: clampInt(
      look.breatheCycleSeconds,
      DEFAULT_BREATHE_SETTINGS.breatheCycleSeconds,
      4,
      30,
    ),
  };
}

export function resolveBreatheScale(tMs, look = {}) {
  if (!look.customBreathe) return 255;
  const settings = normalizeBreatheSettings(look);
  const periodMs = settings.breatheCycleSeconds * 1000;
  const wrappedMs = ((Number(tMs) % periodMs) + periodMs) % periodMs;
  const phase = wrappedMs / periodMs;
  const eased = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  const pct = settings.breatheLowerPct +
    (settings.breatheUpperPct - settings.breatheLowerPct) * eased;
  return Math.round((pct / 100) * 255);
}
```

Import `DEFAULT_BREATHE_SETTINGS` and `normalizeBreatheSettings` in `cardVisualLook.js`. Spread the defaults into `DEFAULT_CARD_VISUAL_LOOK` after `customBreathe`, and spread `normalizeBreatheSettings(look)` into `normalizeCardVisualLook()` after the boolean. This is the explicit legacy migration: `customBreathe: true` with no numeric fields becomes `85/100/9`; `false` stays disabled but has canonical defaults ready for the next enable.

Import `resolveBreatheScale` in `previewColorModifiers.js` and replace the old `86 + scale8(sin8(...), 169)` branch with:

```js
const breatheScale = resolveBreatheScale(tMs, look);
```

Do not multiply `tMs` by `look.speed`; the dedicated cycle slider is the actual cycle length.

- [ ] **Step 4: Run the focused tests to verify GREEN**

Run:

```bash
cd lightweaver
node --test src/lib/breatheEnvelope.test.js
```

Expected: 4 tests pass; the 30 FPS sample changes by no more than one byte per frame and never falls below 85%.

- [ ] **Step 5: Commit the contract and browser math**

```bash
git add lightweaver/src/lib/breatheEnvelope.js lightweaver/src/lib/breatheEnvelope.test.js lightweaver/src/lib/cardVisualLook.js lightweaver/src/lib/previewColorModifiers.js
git commit -m "feat: define gentle breathing envelope"
```

### Task 2: Preserve breathing settings through looks, jobs, runtime packages, and compact storage

**Files:**
- Modify: `lightweaver/src/lib/sectionLookModel.js:187-215`
- Modify: `lightweaver/src/lib/sectionLookModel.test.js:25-105`
- Modify: `lightweaver/src/lib/cardRuntimeContract.js:174-220,430-455`
- Modify: `lightweaver/src/lib/cardRuntimeProject.js:75-87,270-317`
- Modify: `lightweaver/tests/card-runtime-contract.mjs:430-560`
- Modify: `lightweaver/src/lib/productionJobPackage.js:40-66`
- Modify: `lightweaver/src/lib/productionJobPackage.test.js:480-540`
- Modify: `lightweaver/src/lib/cardStoragePayload.js:68-90`
- Modify: `lightweaver/src/lib/cardStoragePayload.test.js:70-155`

- [ ] **Step 1: Write failing section, runtime, production-job, and compaction assertions**

Extend the existing fixtures with a non-default section look:

```js
const gentleLook = {
  patternId: 'aurora',
  customBreathe: true,
  breatheLowerPct: 72,
  breatheUpperPct: 94,
  breatheCycleSeconds: 14,
};
```

Add these exact assertions at the corresponding boundaries:

```js
assert.equal(restoredLook.breatheLowerPct, 72);
assert.equal(restoredLook.breatheUpperPct, 94);
assert.equal(restoredLook.breatheCycleSeconds, 14);

assert.equal(runtimeZone.breatheLowerPct, 72);
assert.equal(runtimeZone.breatheUpperPct, 94);
assert.equal(runtimeZone.breatheCycleSeconds, 14);
```

In `productionJobPackage.test.js`, assert that a new job round-trips all three fields, then validate the unchanged legacy fixture that contains only `customBreathe: true`. In `cardStoragePayload.test.js`, assert that `85/100/9` is removed as firmware-default metadata while `72/94/14` remains.

- [ ] **Step 2: Run all four boundaries to verify RED**

Run:

```bash
cd lightweaver
node --test src/lib/sectionLookModel.test.js src/lib/productionJobPackage.test.js src/lib/cardStoragePayload.test.js
node tests/card-runtime-contract.mjs
```

Expected: FAIL because one or more boundaries omit `breatheLowerPct`, `breatheUpperPct`, or `breatheCycleSeconds`.

- [ ] **Step 3: Add the three fields at every existing look-copy boundary**

In `sectionLookModel.js`, add all three fields to both `lookFromPatchPlayback()` and `lookToPlayback()`:

```js
...(hasExplicit(playback.breatheLowerPct) ? { breatheLowerPct: playback.breatheLowerPct } : {}),
...(hasExplicit(playback.breatheUpperPct) ? { breatheUpperPct: playback.breatheUpperPct } : {}),
...(hasExplicit(playback.breatheCycleSeconds) ? { breatheCycleSeconds: playback.breatheCycleSeconds } : {}),
```

```js
breatheLowerPct: look.breatheLowerPct,
breatheUpperPct: look.breatheUpperPct,
breatheCycleSeconds: look.breatheCycleSeconds,
```

Add the same normalized fields beside `customBreathe` in all three zone builders in `cardRuntimeContract.js` and in `applyLookFieldsToZone()`, `zoneLooksFromZones()`, and `applyVisualLookDefaultsToZones()` in `cardRuntimeProject.js`. Preserve per-section precedence with `hasExplicit(...)`, exactly as the current `customBreathe` field does.

Append the names to `VISUAL_LOOK_KEYS` in `productionJobPackage.js`:

```js
const VISUAL_LOOK_KEYS = [
  'brightness',
  'breatheCycleSeconds',
  'breatheLowerPct',
  'breatheUpperPct',
  'customBreathe',
  'customDrift',
  'customHue',
  'customSaturation',
  'hueShift',
  'patternId',
  'speed',
];
```

The fields remain optional in imported production jobs; do not make legacy jobs include them. New job digests naturally include fields that are present.

Add these defaults to `compactZone()` in `cardStoragePayload.js`:

```js
breatheLowerPct: 85,
breatheUpperPct: 100,
breatheCycleSeconds: 9,
```

This keeps the flash-size budget stable for ordinary and legacy looks while retaining customized values.

- [ ] **Step 4: Run the boundary tests to verify GREEN**

Run:

```bash
cd lightweaver
node --test src/lib/sectionLookModel.test.js src/lib/productionJobPackage.test.js src/lib/cardStoragePayload.test.js
node tests/card-runtime-contract.mjs
```

Expected: all pass; a section-specific `72/94/14` look survives every boundary, legacy jobs remain valid, and default values compact away.

- [ ] **Step 5: Commit the persisted browser/runtime contract**

```bash
git add lightweaver/src/lib/sectionLookModel.js lightweaver/src/lib/sectionLookModel.test.js lightweaver/src/lib/cardRuntimeContract.js lightweaver/src/lib/cardRuntimeProject.js lightweaver/tests/card-runtime-contract.mjs lightweaver/src/lib/productionJobPackage.js lightweaver/src/lib/productionJobPackage.test.js lightweaver/src/lib/cardStoragePayload.js lightweaver/src/lib/cardStoragePayload.test.js
git commit -m "feat: carry breathing settings through card looks"
```

### Task 3: Carry breathing settings through live control and rollback

**Files:**
- Modify: `lightweaver/src/lib/cardLiveControl.js:230-257,570-598`
- Modify: `lightweaver/src/lib/patternLabPreviewSession.js:8-21`
- Modify: `lightweaver/tests/card-live-preview.mjs:20-130,730-780`
- Modify: `lightweaver/src/lib/patternLabPreviewSession.test.js`

- [ ] **Step 1: Write failing payload, zone-readback, and rollback tests**

Extend the `buildLivePreviewControlPayload()` fixture in `card-live-preview.mjs`:

```js
customBreathe: true,
breatheLowerPct: 72,
breatheUpperPct: 94,
breatheCycleSeconds: 14,
```

Require this API payload:

```js
breathe: true,
breatheLowerPct: 72,
breatheUpperPct: 94,
breatheCycleSeconds: 14,
```

Add a `/api/zones` fixture carrying the same values and assert the next section preview retains them. In `patternLabPreviewSession.test.js`, include the three fields in a captured zone snapshot and assert the rollback `restoreLook` call receives them unchanged.

- [ ] **Step 2: Run focused live-control tests to verify RED**

Run:

```bash
cd lightweaver
node tests/card-live-preview.mjs
node --test src/lib/patternLabPreviewSession.test.js
```

Expected: FAIL because the live payload and/or rollback snapshot omit the new fields.

- [ ] **Step 3: Implement live payload and restore propagation**

Add these fields to `buildLivePreviewControlPayload()` after `breathe`:

```js
breatheLowerPct: normalized.breatheLowerPct,
breatheUpperPct: normalized.breatheUpperPct,
breatheCycleSeconds: normalized.breatheCycleSeconds,
```

Add finite zone values to the object passed into `normalizeCardVisualLook()` in `liveLookFromZone()`:

```js
...(Number.isFinite(Number(zone.breatheLowerPct)) ? { breatheLowerPct: Number(zone.breatheLowerPct) } : {}),
...(Number.isFinite(Number(zone.breatheUpperPct)) ? { breatheUpperPct: Number(zone.breatheUpperPct) } : {}),
...(Number.isFinite(Number(zone.breatheCycleSeconds)) ? { breatheCycleSeconds: Number(zone.breatheCycleSeconds) } : {}),
```

Append the same three names to `RESTORE_FIELDS` in `patternLabPreviewSession.js`. Keep the existing boolean field for backward compatibility and do not change preview ownership or rollback ordering.

- [ ] **Step 4: Run focused live-control tests to verify GREEN**

Run:

```bash
cd lightweaver
node tests/card-live-preview.mjs
node --test src/lib/patternLabPreviewSession.test.js
```

Expected: both pass; targeted and global previews send the same three values and transient Pattern Lab streaming restores them.

- [ ] **Step 5: Commit live transport parity**

```bash
git add lightweaver/src/lib/cardLiveControl.js lightweaver/src/lib/patternLabPreviewSession.js lightweaver/tests/card-live-preview.mjs lightweaver/src/lib/patternLabPreviewSession.test.js
git commit -m "feat: sync breathing controls with live card preview"
```

### Task 4: Add compact Advanced controls and persisted summaries

**Files:**
- Modify: `lightweaver/src/v3/lw-pattern.jsx:91-100,1484-1520`
- Modify: `lightweaver/src/styles/v3-patterns-extra.css:31-48`
- Modify: `lightweaver/tests/patterns-v3.spec.ts:860-910`

- [ ] **Step 1: Write the failing browser test for default, validation, persistence, and collapsed copy**

Add this Playwright case to `patterns-v3.spec.ts`:

```ts
test('Advanced Breathe controls are compact, bounded, and persist per section', async ({ page }) => {
  await gotoFreshPatterns(page);

  const advanced = page.locator('.pmx-advanced');
  await expect(advanced.getByTestId('breathe-summary')).toHaveText('Breathe off');
  await advanced.locator('summary').click();
  await advanced.getByLabel('Breathe').check();

  await expect(advanced.getByTestId('breathe-lower-readout')).toHaveText('85%');
  await expect(advanced.getByTestId('breathe-upper-readout')).toHaveText('100%');
  await expect(advanced.getByTestId('breathe-cycle-readout')).toHaveText('9s');

  await setRangeValue(advanced.getByTestId('breathe-lower-slider'), '72');
  await setRangeValue(advanced.getByTestId('breathe-upper-slider'), '94');
  await setRangeValue(advanced.getByTestId('breathe-cycle-slider'), '14');
  await advanced.locator('summary').click();
  await expect(advanced.getByTestId('breathe-summary')).toHaveText('Breathe · 72–94% · 14s');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('breathe-summary')).toHaveText('Breathe · 72–94% · 14s');
});
```

Add a second assertion that the lower slider's `max` equals the current upper value and the upper slider's `min` equals the current lower value. Add an equal-bounds case (`92/92`) and assert the summary reads `Breathe · 92% steady`.

- [ ] **Step 2: Run the browser case to verify RED**

Run:

```bash
cd lightweaver
npx playwright test tests/patterns-v3.spec.ts --project=chromium --workers=1 --grep "Advanced Breathe"
```

Expected: FAIL because the summary and three sliders do not exist.

- [ ] **Step 3: Implement the compact disclosure controls**

In `lw-pattern.jsx`, derive the summary once per render:

```jsx
const breatheSummary = !look.customBreathe
  ? 'Breathe off'
  : look.breatheLowerPct === look.breatheUpperPct
    ? `Breathe · ${look.breatheLowerPct}% steady`
    : `Breathe · ${look.breatheLowerPct}–${look.breatheUpperPct}% · ${look.breatheCycleSeconds}s`;
```

Render it inside the existing Advanced summary:

```jsx
<summary>
  <span>Advanced</span>
  <span className="pmx-advanced-summary" data-testid="breathe-summary">
    {breatheSummary}
  </span>
</summary>
```

Keep the existing checkbox and render these controls only when enabled:

```jsx
{look.customBreathe && (
  <div className="pmx-breathe-controls" data-testid="breathe-controls">
    <Slider
      k="Lower brightness"
      v={`${look.breatheLowerPct}%`}
      value={look.breatheLowerPct}
      min={0}
      max={look.breatheUpperPct}
      step={1}
      testId="breathe-lower"
      onChange={(breatheLowerPct) => updatePreviewLook({ breatheLowerPct })}
    />
    <Slider
      k="Upper brightness"
      v={`${look.breatheUpperPct}%`}
      value={look.breatheUpperPct}
      min={look.breatheLowerPct}
      max={100}
      step={1}
      testId="breathe-upper"
      onChange={(breatheUpperPct) => updatePreviewLook({ breatheUpperPct })}
    />
    <Slider
      k="Cycle"
      v={`${look.breatheCycleSeconds}s`}
      value={look.breatheCycleSeconds}
      min={4}
      max={30}
      step={1}
      testId="breathe-cycle"
      onChange={(breatheCycleSeconds) => updatePreviewLook({ breatheCycleSeconds })}
    />
  </div>
)}
```

Extend the existing Reset payload with `...DEFAULT_BREATHE_SETTINGS`, importing it from `breatheEnvelope.js`. Enabling the legacy toggle must not reset customized values; it only changes `customBreathe`.

Add compact styling without creating another panel:

```css
.pmx-advanced-summary { margin-left: auto; letter-spacing: 0; text-transform: none; color: var(--text-mid); }
.pmx-breathe-controls { display: grid; gap: 10px; padding-left: 20px; border-left: 1px solid var(--border-soft); }
```

- [ ] **Step 4: Run the browser case and existing Patterns screen suite to verify GREEN**

Run:

```bash
cd lightweaver
npx playwright test tests/patterns-v3.spec.ts --project=chromium --workers=1
```

Expected: all Patterns tests pass; collapsed copy is concise, values persist after reload, equal bounds show a steady summary, and the Advanced surface remains a single disclosure.

- [ ] **Step 5: Commit the Advanced UI**

```bash
git add lightweaver/src/v3/lw-pattern.jsx lightweaver/src/styles/v3-patterns-extra.css lightweaver/tests/patterns-v3.spec.ts
git commit -m "feat: add gentle breathe controls to pattern looks"
```

### Task 5: Persist and mutate breathing settings in firmware

**Files:**
- Modify: `firmware/lightweaver-controller/src/LightweaverTypes.h:145-160,207-225`
- Modify: `firmware/lightweaver-controller/src/LightweaverRuntimeApi.h:18-42`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp:129-205,345-405,542-850,1210-1235`
- Modify: `firmware/lightweaver-controller/src/main.cpp:165-185,972-982,1058-1070,2150-2215,2400-2430,2498-2530`
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp:1785-1930`
- Create: `firmware/lightweaver-controller/tests/breathe-config-contract.mjs`
- Modify: `firmware/lightweaver-controller/tests/storage-config-clamps.mjs`

- [ ] **Step 1: Write failing firmware source/storage/API contract tests**

Create `breathe-config-contract.mjs` to load the five firmware sources and assert:

```js
assert.match(types, /uint8_t breatheLowerPct = 85;/);
assert.match(types, /uint8_t breatheUpperPct = 100;/);
assert.match(types, /uint8_t breatheCycleSeconds = 9;/);
assert.match(storage, /zone\.breatheLowerPct = zoneJson\["breatheLowerPct"\] \| 85;/);
assert.match(storage, /zone\.breatheUpperPct = zoneJson\["breatheUpperPct"\] \| 100;/);
assert.match(storage, /zone\.breatheCycleSeconds = zoneJson\["breatheCycleSeconds"\] \| 9;/);
assert.match(web, /hasControlField\(doc, "breatheLowerPct"\)/);
assert.match(web, /hasControlField\(doc, "breatheUpperPct"\)/);
assert.match(web, /hasControlField\(doc, "breatheCycleSeconds"\)/);
assert.match(runtime, /obj\["breatheLowerPct"\] = z\.breatheLowerPct;/);
assert.match(runtime, /obj\["breatheUpperPct"\] = z\.breatheUpperPct;/);
assert.match(runtime, /obj\["breatheCycleSeconds"\] = z\.breatheCycleSeconds;/);
```

Extend `storage-config-clamps.mjs` with strict-validation source assertions for `0..100`, `4..30`, and `lower <= upper` on both top-level zones and saved-look zones.

- [ ] **Step 2: Run firmware contracts to verify RED**

Run:

```bash
node firmware/lightweaver-controller/tests/breathe-config-contract.mjs
node firmware/lightweaver-controller/tests/storage-config-clamps.mjs
```

Expected: FAIL on the first missing struct field and missing strict-validation guard.

- [ ] **Step 3: Add firmware fields, defaults, strict storage validation, and zone propagation**

Add these members immediately after `customBreathe` in both `LookZoneConfig` and `ZoneConfig`:

```cpp
uint8_t breatheLowerPct = 85;
uint8_t breatheUpperPct = 100;
uint8_t breatheCycleSeconds = 9;
```

Set the same defaults in `resetLookZone()`, `resetZone()`, `ensureDefaultZone()`, recovery resets, and legacy global state. Parse the optional JSON fields in saved-look zones and runtime zones with the defaults shown in Step 1. Copy them in `applyLookZoneToRuntimeZone()` and into `PatternModifiers` in every renderer setup.

Add a focused strict validator in `LightweaverStorage.cpp`:

```cpp
bool validateBreatheJson(JsonObjectConst zone, String& message) {
  JsonVariantConst lowerValue = zone["breatheLowerPct"];
  JsonVariantConst upperValue = zone["breatheUpperPct"];
  JsonVariantConst cycleValue = zone["breatheCycleSeconds"];
  int lower = lowerValue | 85;
  int upper = upperValue | 100;
  int cycle = cycleValue | 9;
  if ((!lowerValue.isNull() && !lowerValue.is<uint8_t>()) || lower < 0 || lower > 100) {
    message = "breathe lower brightness must be an integer from 0 to 100";
    return false;
  }
  if ((!upperValue.isNull() && !upperValue.is<uint8_t>()) || upper < 0 || upper > 100) {
    message = "breathe upper brightness must be an integer from 0 to 100";
    return false;
  }
  if ((!cycleValue.isNull() && !cycleValue.is<uint8_t>()) || cycle < 4 || cycle > 30) {
    message = "breathe cycle must be an integer from 4 to 30 seconds";
    return false;
  }
  if (lower > upper) {
    message = "breathe lower brightness must not exceed upper brightness";
    return false;
  }
  return true;
}
```

Call it for every element of `doc["zones"]` and every element of each `doc["looks"][i]["zones"]` inside `validateRuntimeConfigJsonStrict()` before `applyJsonToConfig()` can mutate active state. Missing fields pass and load as `85/100/9`; malformed present fields reject the whole candidate config without replacing known-good storage.

- [ ] **Step 4: Add targeted runtime setters and API validation/readback**

Declare and implement:

```cpp
void runtimeSetBreatheSettingsZ(const String& targetId,
                                uint8_t lowerPct,
                                uint8_t upperPct,
                                uint8_t cycleSeconds);
uint8_t runtimeGetBreatheLowerPctZ(const String& targetId);
uint8_t runtimeGetBreatheUpperPctZ(const String& targetId);
uint8_t runtimeGetBreatheCycleSecondsZ(const String& targetId);
```

The setter updates the legacy globals when `targetId` is empty and uses the existing `applyToZones()` synchronization rules. The getters return the matched zone's value and fall back to the globals for an empty or unavailable target.

In `handleControl()`, treat any of the three fields as a selected-zone operation. Before entering `applyPreparedControlTransaction`, calculate missing fields from the targeted getters and reject with HTTP 422 unless all are integers in range and `lower <= upper`:

```cpp
int requestedLower = hasControlField(doc, "breatheLowerPct")
    ? controlInt(doc, "breatheLowerPct")
    : runtimeGetBreatheLowerPctZ(zoneTarget);
int requestedUpper = hasControlField(doc, "breatheUpperPct")
    ? controlInt(doc, "breatheUpperPct")
    : runtimeGetBreatheUpperPctZ(zoneTarget);
int requestedCycle = hasControlField(doc, "breatheCycleSeconds")
    ? controlInt(doc, "breatheCycleSeconds")
    : runtimeGetBreatheCycleSecondsZ(zoneTarget);
bool breatheSettingsValid = requestedLower >= 0 && requestedLower <= 100 &&
    requestedUpper >= 0 && requestedUpper <= 100 &&
    requestedLower <= requestedUpper && requestedCycle >= 4 && requestedCycle <= 30;
```

Apply the settings in the transaction only when at least one numeric field is present. Echo targeted values in the control response and include all three in every `/api/zones` object. Keep `{ breathe: true|false }` accepted so old Studio/card pages still toggle the migrated default.

- [ ] **Step 5: Run firmware contracts to verify GREEN, then commit**

Run:

```bash
node firmware/lightweaver-controller/tests/breathe-config-contract.mjs
node firmware/lightweaver-controller/tests/storage-config-clamps.mjs
node firmware/lightweaver-controller/tests/control-sync-order.mjs
```

Expected: all pass; invalid ranges reject before mutation, legacy JSON loads with defaults, API changes use normal zone synchronization, and `/api/zones` exposes readback.

```bash
git add firmware/lightweaver-controller/src/LightweaverTypes.h firmware/lightweaver-controller/src/LightweaverRuntimeApi.h firmware/lightweaver-controller/src/LightweaverStorage.cpp firmware/lightweaver-controller/src/main.cpp firmware/lightweaver-controller/src/LightweaverWeb.cpp firmware/lightweaver-controller/tests/breathe-config-contract.mjs firmware/lightweaver-controller/tests/storage-config-clamps.mjs
git commit -m "feat: persist breathing controls in card firmware"
```

### Task 6: Make firmware rendering match Studio and fix Calm/white timing

**Files:**
- Create: `firmware/lightweaver-controller/src/LightweaverBreathe.h`
- Create: `firmware/lightweaver-controller/tests/breathe-envelope.cpp`
- Create: `firmware/lightweaver-controller/tests/breathe-envelope.mjs`
- Modify: `firmware/lightweaver-controller/src/LightweaverPatterns.h:5-26`
- Modify: `firmware/lightweaver-controller/src/LightweaverPatterns.cpp:1-82,300-505`
- Modify: `firmware/lightweaver-controller/src/main.cpp:1088-1102,1175-1222`
- Modify: `lightweaver/src/lib/patterns-library.js:62-74`
- Modify: `firmware/lightweaver-controller/tests/pattern-color-modifiers.mjs`

- [ ] **Step 1: Write the failing cross-language parity and timing-defect tests**

Create `breathe-envelope.cpp` to print comma-separated scale bytes for times `0`, `2250`, `4500`, `6750`, and `9000` at `85/100/9`, plus a `92/92/9` sample. Create `breathe-envelope.mjs` to compile that fixture, import `resolveBreatheScale()` from the Studio module, and require exact equality:

```js
const times = [0, 2250, 4500, 6750, 9000];
const expected = times.map(tMs => resolveBreatheScale(tMs, {
  customBreathe: true,
  breatheLowerPct: 85,
  breatheUpperPct: 100,
  breatheCycleSeconds: 9,
}));
assert.deepEqual(firmwareValues.slice(0, 5), expected);
assert.equal(firmwareValues[5], resolveBreatheScale(1234, {
  customBreathe: true,
  breatheLowerPct: 92,
  breatheUpperPct: 92,
  breatheCycleSeconds: 9,
}));
```

Extend `pattern-color-modifiers.mjs` to reject the old deep range and timing defects:

```js
assert.doesNotMatch(source, /86 \+ scale8\(sin8/);
assert.doesNotMatch(source, /beatsin8\(5, 38, 150\)/);
assert.doesNotMatch(source, /applyGlobalColorModifiers\(leds, totalPixels, millis\(\), mods\)/);
assert.match(source, /resolveBreatheScale\(now, mods\.breatheLowerPct, mods\.breatheUpperPct, mods\.breatheCycleSeconds\)/);
assert.match(source, /scaleTime\(now, mods\.speed\)/);
```

- [ ] **Step 2: Run parity and source contracts to verify RED**

Run:

```bash
node firmware/lightweaver-controller/tests/breathe-envelope.mjs
node firmware/lightweaver-controller/tests/pattern-color-modifiers.mjs
```

Expected: FAIL because `LightweaverBreathe.h` is missing and the old hard-coded envelope, Calm BPM, and white `millis()` path remain.

- [ ] **Step 3: Implement the host-testable firmware envelope**

Create `LightweaverBreathe.h` with no Arduino/FastLED dependency:

```cpp
#pragma once

#include <cmath>
#include <cstdint>

inline uint8_t resolveBreatheScale(uint32_t nowMs,
                                   uint8_t lowerPct,
                                   uint8_t upperPct,
                                   uint8_t cycleSeconds) {
  const uint32_t periodMs = uint32_t(cycleSeconds) * 1000U;
  const float phase = float(nowMs % periodMs) / float(periodMs);
  const float eased = 0.5f - 0.5f * std::cos(phase * 6.28318530717958647692f);
  const float pct = float(lowerPct) + float(upperPct - lowerPct) * eased;
  return static_cast<uint8_t>(std::lround((pct / 100.0f) * 255.0f));
}
```

Add the three settings to `PatternModifiers` with `85/100/9` defaults. In `applyGlobalColorModifiers()`, calculate Breathe from raw `now` using this helper. Keep Drift speed-sensitive with its own scaled clock:

```cpp
const uint32_t driftNow = scaleTime(now, mods.speed);
if (mods.customDrift) {
  hueShift += int16_t(resolveDriftHue(driftNow, mods)) - int16_t(mods.customHue);
}
const uint8_t breatheScale = mods.customBreathe
    ? resolveBreatheScale(now, mods.breatheLowerPct,
                          mods.breatheUpperPct, mods.breatheCycleSeconds)
    : 255;
```

Pass the raw render `now` to this post-pass exactly once; do not pass the procedural pattern's already scaled `t`.

- [ ] **Step 4: Correct the built-in Breathe, Calm, and white-preset paths**

Change the Studio built-in Breathe code to a shallow 9-second default:

```js
`// @param hue float 0.45 0.0 1.0
// @param cycleSeconds float 9 4 30
// Gentle cosine-eased breathe; master speed still controls the pattern itself.
const phase = ((t % params.cycleSeconds) + params.cycleSeconds) % params.cycleSeconds / params.cycleSeconds;
const eased = 0.5 - 0.5 * cos(phase * TAU);
const v = lerp(0.85, 1.0, eased);
return hsv(params.hue, 0.9, v);`,
```

In firmware, render the built-in `breathe` pattern with `resolveBreatheScale(now, 85, 100, 9)` and retain its warm hue/saturation. Replace Calm's unscaled global FastLED clock with a deterministic speed-scaled phase derived from `scaleTime(now, mods.speed)`; preserve Calm's existing `38..150` depth and 12-second base cycle:

```cpp
uint8_t level = resolveBreatheScale(scaleTime(now, mods.speed), 15, 59, 12);
```

Change `renderPresetPattern()` to accept `uint32_t now` in its declaration, definition, and every call site. White presets call `applyGlobalColorModifiers(..., now, mods)`: Breathe uses its explicit wall-clock cycle, while Drift uses `scaleTime(now, mods.speed)`. This fixes white timing without allowing general speed to stretch Breathe beyond its selected 4–30 seconds.

- [ ] **Step 5: Run parity and firmware source tests to verify GREEN, then commit**

Run:

```bash
node firmware/lightweaver-controller/tests/breathe-envelope.mjs
node firmware/lightweaver-controller/tests/pattern-color-modifiers.mjs
node firmware/lightweaver-controller/tests/pattern-runtime-state.mjs
```

Expected: exact browser/firmware byte parity at all sampled points; no old deep envelope; Calm changes with speed; white Drift receives scaled time; all preset call sites pass deterministic `now`.

```bash
git add firmware/lightweaver-controller/src/LightweaverBreathe.h firmware/lightweaver-controller/tests/breathe-envelope.cpp firmware/lightweaver-controller/tests/breathe-envelope.mjs firmware/lightweaver-controller/src/LightweaverPatterns.h firmware/lightweaver-controller/src/LightweaverPatterns.cpp firmware/lightweaver-controller/src/main.cpp lightweaver/src/lib/patterns-library.js firmware/lightweaver-controller/tests/pattern-color-modifiers.mjs
git commit -m "fix: align gentle ambient timing across Studio and card"
```

### Task 7: Lock the ambient verification set and normal frame cadence

**Files:**
- Create: `lightweaver/src/lib/ambientMotion.test.js`
- Modify: `lightweaver/tests/preview-animation.mjs`
- Modify: `lightweaver/tests/project-frame-audit.mjs:1500-1585`

- [ ] **Step 1: Write a failing 30 FPS ambient sampling test**

Create `ambientMotion.test.js`. Use one 44-pixel synthetic strip and `renderPixelFrame()` to sample `breathe`, `calm`, `aurora`, `lava`, and `twinkle` at every `1 / 30` second for 12 seconds. Add helpers with these exact contracts:

```js
function frameMean(frame) {
  return frame.pixels.reduce((sum, px) => sum + px.r + px.g + px.b, 0) /
    Math.max(1, frame.pixels.length * 3 * 255);
}

function samplePattern(patternId, seconds = 12) {
  return Array.from({ length: seconds * 30 + 1 }, (_, frameIndex) =>
    renderPixelFrame({
      t: frameIndex / 30,
      strips: [strip],
      patternId,
      masterSpeed: 1,
      masterBrightness: 1,
    }));
}
```

For every ambient pattern, assert:

```js
assert.equal(frames.length, 361);
assert.ok(frames.every(frame => frame.pixels.length === 44));
assert.ok(frames.every(frame => frame.pixels.every(px =>
  Number.isFinite(px.r) && Number.isFinite(px.g) && Number.isFinite(px.b))));
assert.ok(new Set(frames.map(frame => frame.pixels.map(px => `${px.r},${px.g},${px.b}`).join('|'))).size > 30);
```

For Breathe, assert the 9-second frame is within one byte per channel of frame zero, the midpoint is brighter than the start, and no lit channel falls below the 85% envelope solely because of breathing. For a 3-second Aurora→Calm crossfade sampled at 30 FPS, assert exactly 91 blend frames and monotonically increasing `blendAmount`; do not require monotonic pixel values because both source patterns continue moving. For Twinkle, require normal frame count and finite output but do not impose a smooth-delta ceiling because it is intentionally random.

- [ ] **Step 2: Run the ambient tests to verify RED**

Run:

```bash
cd lightweaver
node --test src/lib/ambientMotion.test.js
node tests/preview-animation.mjs
node tests/project-frame-audit.mjs
```

Expected before the final adjustments: FAIL on Breathe floor/cycle and/or the newly required crossfade cadence evidence.

- [ ] **Step 3: Prove the renderer evaluates every requested timestamp**

Keep `renderPixelFrame()` frame-based and time-driven; do not add a frame-skipping branch. Exercise the existing crossfade equation at all 91 timestamps with this loop:

```js
const blendAmount = frameIndex / 90;
renderPixelFrame({
  t: frameIndex / 30,
  strips: [strip],
  patternId: 'aurora',
  blendPatternId: 'calm',
  blendAmount,
  blendType: 'crossfade',
});
```

Assert that the returned frame has 44 pixels on every iteration. Do not low-pass Twinkle or other intentionally sharp patterns. This step changes only the regression test because the current renderer already evaluates every supplied timestamp.

- [ ] **Step 4: Run the complete ambient verification set to verify GREEN**

Run:

```bash
cd lightweaver
node --test src/lib/breatheEnvelope.test.js src/lib/ambientMotion.test.js
node tests/preview-animation.mjs
node tests/project-frame-audit.mjs
node ../firmware/lightweaver-controller/tests/breathe-envelope.mjs
node ../firmware/lightweaver-controller/tests/pattern-color-modifiers.mjs
```

Expected: Breathe, Calm, Aurora, Lava, Twinkle, and the slow crossfade all render every requested frame; Breathe is shallow and periodic; Twinkle remains allowed to change sharply.

- [ ] **Step 5: Commit the ambient regression set**

```bash
git add lightweaver/src/lib/ambientMotion.test.js lightweaver/tests/preview-animation.mjs lightweaver/tests/project-frame-audit.mjs
git commit -m "test: verify gentle ambient motion cadence"
```

### Task 8: Run integrated verification and physical acceptance

**Files:**
- Verify: `lightweaver/src/lib/breatheEnvelope.js`
- Verify: `lightweaver/src/v3/lw-pattern.jsx`
- Verify: `lightweaver/src/lib/cardRuntimeProject.js`
- Verify: `firmware/lightweaver-controller/src/LightweaverPatterns.cpp`
- Verify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`

- [ ] **Step 1: Run the complete focused automated set**

```bash
cd lightweaver
node --test src/lib/breatheEnvelope.test.js src/lib/ambientMotion.test.js src/lib/sectionLookModel.test.js src/lib/productionJobPackage.test.js src/lib/cardStoragePayload.test.js src/lib/patternLabPreviewSession.test.js
node tests/card-runtime-contract.mjs
node tests/card-live-preview.mjs
npx playwright test tests/patterns-v3.spec.ts --project=chromium --workers=1
cd ..
node firmware/lightweaver-controller/tests/breathe-config-contract.mjs
node firmware/lightweaver-controller/tests/breathe-envelope.mjs
node firmware/lightweaver-controller/tests/pattern-color-modifiers.mjs
node firmware/lightweaver-controller/tests/pattern-runtime-state.mjs
node firmware/lightweaver-controller/tests/storage-config-clamps.mjs
node firmware/lightweaver-controller/tests/control-sync-order.mjs
```

Expected: every command exits zero.

- [ ] **Step 2: Run full relevant source verification and builds**

```bash
cd lightweaver
npm run test:unit
npm run test:core:source
npm run build
cd ../firmware/lightweaver-controller
pio run -e lightweaver-s3
```

Expected: unit/source suites pass, Vite produces the Studio bundle, and PlatformIO builds the ESP32-S3 firmware.

- [ ] **Step 3: Verify API validation and readback on a bench card**

With a paired local card, send:

```bash
curl -sS -X POST http://lightweaver.local/api/control \
  -H 'Content-Type: application/json' \
  --data '{"breathe":true,"breatheLowerPct":85,"breatheUpperPct":100,"breatheCycleSeconds":9}' | jq '{ok,breathe,breatheLowerPct,breatheUpperPct,breatheCycleSeconds}'
curl -sS http://lightweaver.local/api/zones | jq '.zones[] | {id,customBreathe,breatheLowerPct,breatheUpperPct,breatheCycleSeconds}'
curl -sS -o /tmp/lightweaver-invalid-breathe.json -w '%{http_code}\n' \
  -X POST http://lightweaver.local/api/control \
  -H 'Content-Type: application/json' \
  --data '{"breatheLowerPct":95,"breatheUpperPct":70,"breatheCycleSeconds":9}'
```

Expected: the valid command returns `true/85/100/9`, `/api/zones` reports the same values, and the invalid command returns HTTP 422 without changing the subsequent zone readback.

- [ ] **Step 4: Verify physical ambient behavior at normal frame cadence**

On a representative 400–453-pixel installation, run Breathe at `85–100% / 9s` for at least three cycles. Confirm the low point remains visibly lit, movement is obvious but shallow, midpoint occurs at approximately 4.5 seconds, and the browser preview reaches the same low/high phase within one rendered frame of the card. Repeat with `60–90% / 4s`, `92–92% / 30s`, Calm at `0.5x` and `2x`, warm-white with Drift at `0.5x` and `2x`, Aurora, Lava, Twinkle, and a 3-second Aurora→Calm crossfade.

Read the existing runtime FPS/status evidence during each case and require at least 28 FPS. A case fails if slowness comes from visible stepping, dropped frames, blackout at the low point, multi-minute breathing, or browser/card phase disagreement.

- [ ] **Step 5: Run the launch gate and record final evidence**

```bash
cd lightweaver
npm run launch:check
```

Expected: launch gate passes. Record the automated command results, firmware build identity, API readback, observed 28+ FPS, and physical pass/fail for each ambient case in the implementation session handoff; do not report physical success without observing the LEDs.
