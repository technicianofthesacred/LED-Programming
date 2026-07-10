# Lightweaver Quiet Card Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make section dependencies install automatically before zoned previews, make playlist loading a complete verified sync, and remove routine top-level notifications.

**Architecture:** Add one focused card-section synchronization module that probes card zones, pushes the existing complete runtime package only when dependencies are missing, waits for required zones, and preserves the existing project and output-layout guards. Patterns and Playlist call this module before zoned previews; expected progress and success are represented by existing control state, while only unrecoverable errors render notices.

**Tech Stack:** React 18, Vite, browser Fetch and postMessage card bridge, Node `assert` contract tests, Playwright browser smoke tests.

---

## File structure

- Create `lightweaver/src/lib/cardSectionSync.js`: zone comparison, bounded verification, dependency installation, and complete runtime-package sync.
- Modify `lightweaver/src/lib/cardLiveControl.js`: expose the existing card-zone read through the same direct/bridge transport already used by live previews.
- Create `lightweaver/tests/card-section-sync.mjs`: deterministic orchestration tests with injected card operations.
- Modify `lightweaver/src/v3/lw-pattern.jsx`: silently auto-install missing sections before zoned previews and remove routine status banners.
- Modify `lightweaver/src/v3/lw-playlist.jsx`: use complete verified sync, clear stale fallback state, and show status only on errors.
- Modify `lightweaver/src/lib/studioActionStatus.js`: make successful and pending playlist operations intentionally produce no notice.
- Modify `lightweaver/tests/studio-action-status.mjs`: lock the quiet feedback policy.
- Modify `lightweaver/tests/workflow.spec.ts`: smoke-test quiet Patterns and Playlist behavior.
- Modify `lightweaver/package.json`: include the new orchestration contract test in `test:core`.

### Task 1: Card section synchronization contract

**Files:**
- Create: `lightweaver/src/lib/cardSectionSync.js`
- Modify: `lightweaver/src/lib/cardLiveControl.js`
- Create: `lightweaver/tests/card-section-sync.mjs`
- Modify: `lightweaver/package.json`

- [ ] **Step 1: Write the failing zone and retry tests**

Create deterministic tests covering no-op when zones exist, one config push when zones are missing, bounded polling after reboot, failure when zones never appear, and propagation of `layout-mismatch` and `project-mismatch` errors. Use injected functions so the test performs no network I/O:

```js
const operations = [];
const result = await ensureCardSectionsForPreview({
  host: '192.168.4.1',
  requiredZoneIds: ['outer', 'inner'],
  runtimePackage: { config: { zones: [{ id: 'outer' }, { id: 'inner' }] } },
  readZones: async () => {
    operations.push('zones');
    return operations.filter(item => item === 'zones').length === 1
      ? { zones: [{ id: 'full-piece' }] }
      : { zones: [{ id: 'outer' }, { id: 'inner' }] };
  },
  pushConfig: async () => {
    operations.push('config');
    return { ok: true };
  },
  sleep: async () => {},
});

assert.equal(result.synced, true);
assert.deepEqual(operations, ['zones', 'config', 'zones']);
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd lightweaver && node tests/card-section-sync.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/lib/cardSectionSync.js`.

- [ ] **Step 3: Expose card zone reads**

Export the existing transport-aware read without duplicating direct-fetch or bridge behavior:

```js
export async function readCardZonesFromCard(options = {}) {
  const host = options.host || readStoredCardHost();
  return readCardZones(host, options.timeoutMs || 1200);
}
```

- [ ] **Step 4: Implement bounded dependency synchronization**

Implement these public functions in `cardSectionSync.js`:

```js
export function missingCardZoneIds(zonesPayload = {}, requiredZoneIds = []) {
  if (!Array.isArray(zonesPayload?.zones)) return [];
  const available = new Set(zonesPayload.zones.map(zone => String(zone?.id || '')).filter(Boolean));
  return [...new Set(requiredZoneIds.map(String).filter(Boolean))]
    .filter(zoneId => !available.has(zoneId));
}

export function runtimeZoneIds(runtimePackage = {}) {
  const zones = (runtimePackage.config || runtimePackage)?.zones;
  return Array.isArray(zones)
    ? zones.map(zone => String(zone?.id || '')).filter(Boolean)
    : [];
}

export async function waitForCardZones({
  host,
  requiredZoneIds,
  readZones = readCardZonesFromCard,
  sleep = delay,
  attempts = 12,
  intervalMs = 500,
} = {}) {
  let lastPayload = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(intervalMs);
    try {
      lastPayload = await readZones({ host, timeoutMs: 900 });
      if (Array.isArray(lastPayload?.zones) && missingCardZoneIds(lastPayload, requiredZoneIds).length === 0) {
        return lastPayload;
      }
    } catch {
      // A reboot temporarily removes both the direct endpoint and bridge.
    }
  }
  throw new CardPushError('zones-missing', 'Lightweaver saved the setup, but the card did not expose the required sections after reconnecting.');
}

export async function syncRuntimePackageToCard({
  host,
  runtimePackage,
  requiredZoneIds = runtimeZoneIds(runtimePackage),
  pushConfig = pushConfigToCard,
  readZones = readCardZonesFromCard,
  sleep = delay,
} = {}) {
  const response = await pushConfig(runtimePackage, { host, timeoutMs: 6000, reboot: 'if-needed' });
  if (requiredZoneIds.length) {
    await waitForCardZones({ host, requiredZoneIds, readZones, sleep });
  }
  return response;
}

export async function ensureCardSectionsForPreview(options = {}) {
  const zones = await (options.readZones || readCardZonesFromCard)({ host: options.host, timeoutMs: 900 });
  const missing = missingCardZoneIds(zones, options.requiredZoneIds);
  if (!missing.length) return { synced: false, zones };
  const response = await syncRuntimePackageToCard(options);
  return { synced: true, zones: response };
}
```

Keep `allowLayoutChange` and `allowProjectChange` absent so existing safety guards remain active.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run: `cd lightweaver && node tests/card-section-sync.mjs && node tests/card-live-preview.mjs && node tests/card-runtime-contract.mjs`

Expected: all three scripts exit 0.

- [ ] **Step 6: Add the new contract test to `test:core` and commit**

Run:

```bash
git add lightweaver/src/lib/cardSectionSync.js lightweaver/src/lib/cardLiveControl.js lightweaver/tests/card-section-sync.mjs lightweaver/package.json
git commit -m "feat(card): sync missing sections before preview"
```

### Task 2: Quiet feedback policy

**Files:**
- Modify: `lightweaver/src/lib/studioActionStatus.js`
- Modify: `lightweaver/tests/studio-action-status.mjs`

- [ ] **Step 1: Write failing quiet-status assertions**

Replace the expected pending and success notices with an explicit null notice contract while keeping all error states intact:

```js
assert.equal(makePlaylistPushPendingState(), null);
assert.equal(makePlaylistPushSuccessState(), null);
assert.equal(makePlaylistPushSuccessState({ rebooting: true }), null);
assert.equal(makePlaylistPushErrorState(bridgeTimeout, {
  host: 'lightweaver.local',
  buildHandoffUrl: handoffBuilder,
}).kind, 'err');
```

- [ ] **Step 2: Run the test and verify RED**

Run: `cd lightweaver && node tests/studio-action-status.mjs`

Expected: FAIL because pending and success currently return visible status objects.

- [ ] **Step 3: Implement the quiet notice contract**

Change the two routine state factories without weakening error messages:

```js
export function makePlaylistPushPendingState() {
  return null;
}

export function makePlaylistPushSuccessState() {
  return null;
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `cd lightweaver && node tests/studio-action-status.mjs`

Expected: `studio-action-status tests passed`.

- [ ] **Step 5: Commit**

```bash
git add lightweaver/src/lib/studioActionStatus.js lightweaver/tests/studio-action-status.mjs
git commit -m "fix(studio): keep routine card sync feedback quiet"
```

### Task 3: Patterns auto-installs sections and removes routine banners

**Files:**
- Modify: `lightweaver/src/v3/lw-pattern.jsx`
- Test: `lightweaver/tests/workflow.spec.ts`

- [ ] **Step 1: Add a failing browser assertion for quiet previews**

Add a `mockLocalCard(page)` helper that intercepts `http://lightweaver.local/api/status`, `/api/zones`, `/api/control`, `/api/firmware-info`, `/api/config`, and `/api/reboot`. Return a connected 44-pixel card with the default Outer and Inner zone IDs. Then open Patterns, tap `Aurora`, and assert the large status region does not contain routine feedback after the request settles:

```ts
await page.route('http://lightweaver.local/api/status', route => route.fulfill({
  json: { ok: true, led: { pixels: 44 }, wifi: { ip: 'lightweaver.local' } },
}));
await page.route('http://lightweaver.local/api/zones', route => route.fulfill({
  json: {
    syncZones: false,
    zones: [
      { id: 'patch-default-outer-circle', ranges: [{ start: 0, count: 22 }] },
      { id: 'patch-default-inner-circle', ranges: [{ start: 22, count: 22 }] },
    ],
  },
}));
await page.route('http://lightweaver.local/api/control', route => route.fulfill({ json: { ok: true } }));

await page.getByRole('button', { name: /Aurora/i }).first().click();
await expect(page.locator('.pmx-status')).not.toContainText(/Previewing|Not saved yet|Skipped an older preview|Card doesn't have sections yet/i);
```

- [ ] **Step 2: Run the focused browser test and verify RED**

Run: `cd lightweaver && npx playwright test tests/workflow.spec.ts --grep "quiet pattern preview"`

Expected: FAIL because `Previewing Aurora on All sections. Not saved yet.` is rendered.

- [ ] **Step 3: Install missing sections before a zoned preview**

Import `ensureCardSectionsForPreview`. In `scheduleLivePreview`, derive `requiredZoneIds` from the selected target, call the dependency synchronizer with the current `runtimePackage`, then send the preview without whole-piece fallback:

```js
const requiredZoneIds = zone ? [zone] : [];
if (requiredZoneIds.length) {
  await ensureCardSectionsForPreview({
    host: cardHost,
    requiredZoneIds,
    runtimePackage,
  });
}
await pushLivePreviewToCard(
  { ...nextLook, zone, syncZones: target?.kind !== 'section' },
  { host: cardHost, timeoutMs: 2200, fallbackMissingZoneToAll: false },
);
```

- [ ] **Step 4: Remove routine status mutations**

For live preview off, preview start, preview success, and superseded requests, leave `status` empty. Clear an earlier recoverable error after a successful preview. Keep only error branches that require operator action. Remove `zoneFallback` state and its manual `Send sections to card` banner; retain `Send split preview` inside Card tools as an explicit diagnostic action.

- [ ] **Step 5: Keep routine saves quiet**

Remove progress and success banner text from `savePreviewToCard`, `saveComboOnly`, and `sendSplitPreview`. Preserve their error branches and handoff actions. Use existing selected states and button actions as ordinary confirmation.

- [ ] **Step 6: Run focused tests and commit**

Run: `cd lightweaver && node tests/card-section-sync.mjs && npx playwright test tests/workflow.spec.ts --grep "quiet pattern preview"`

Expected: both commands exit 0.

```bash
git add lightweaver/src/v3/lw-pattern.jsx lightweaver/tests/workflow.spec.ts
git commit -m "fix(patterns): auto-sync sections without routine notices"
```

### Task 4: Playlist performs one complete quiet sync

**Files:**
- Modify: `lightweaver/src/v3/lw-playlist.jsx`
- Test: `lightweaver/tests/workflow.spec.ts`

- [ ] **Step 1: Add failing Playlist smoke assertions**

Reuse the local-card route helper. Capture the JSON body posted to `/api/config`, open the default two-section project's Playlist screen, press `Load playlist to card`, and assert the request contains the default Outer and Inner section zones while no success or stale fallback notice remains:

```ts
await page.getByRole('button', { name: /Load playlist to card/i }).click();
expect(savedConfig.zones.map(zone => zone.id)).toEqual([
  'patch-default-outer-circle',
  'patch-default-inner-circle',
]);
await expect(page.getByTestId('playlist-zone-fallback-note')).toHaveCount(0);
await expect(page.getByTestId('playlist-card-status')).toHaveCount(0);
```

- [ ] **Step 2: Run the focused browser test and verify RED**

Run: `cd lightweaver && npx playwright test tests/workflow.spec.ts --grep "quiet complete playlist sync"`

Expected: FAIL because the current screen renders pending/success status and does not verify zones.

- [ ] **Step 3: Wire complete runtime sync**

Replace the direct playlist config push with `syncRuntimePackageToCard({ host, runtimePackage })`. Track only a boolean `playlistSyncing` for disabling duplicate clicks. On success clear `playlistStatus`, `previewNote`, and `handoffUrl`; on failure continue using `makePlaylistPushErrorState`.

- [ ] **Step 4: Auto-install before saved-mix preview**

Before `pushSectionPreviewToCard`, derive section target IDs and call `ensureCardSectionsForPreview`. Do not set `ZONE_FALLBACK_NOTE`; a remaining `zones-missing` result is an actionable error routed through `makePlaylistPushErrorState`.

- [ ] **Step 5: Use button state instead of a notification**

Disable the load button while syncing and change its compact label only for the duration of the request:

```jsx
<button className="btn primary" disabled={!connected || playlistSyncing} onClick={loadPlaylistToCard}>
  {I.bolt}{playlistSyncing ? 'Loading…' : 'Load playlist to card'}
</button>
```

- [ ] **Step 6: Run focused tests and commit**

Run: `cd lightweaver && node tests/card-section-sync.mjs && node tests/studio-action-status.mjs && npx playwright test tests/workflow.spec.ts --grep "quiet complete playlist sync"`

Expected: all commands exit 0.

```bash
git add lightweaver/src/v3/lw-playlist.jsx lightweaver/tests/workflow.spec.ts
git commit -m "fix(playlist): load complete card setup automatically"
```

### Task 5: Full verification

**Files:**
- Verify: `lightweaver/`

- [ ] **Step 1: Run unit and contract tests**

Run: `cd lightweaver && npm run test:unit && npm run test:core`

Expected: both commands exit 0 with no failed assertions.

- [ ] **Step 2: Run browser workflow tests**

Run: `cd lightweaver && npx playwright test tests/workflow.spec.ts`

Expected: all workflow tests pass.

- [ ] **Step 3: Build production assets**

Run: `cd lightweaver && npm run build`

Expected: Vite exits 0 and writes `dist/`.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff origin/main...HEAD --check && git status --short`

Expected: no whitespace errors and only intentional source, test, spec, and plan changes.

- [ ] **Step 5: Commit any verification-only test adjustments**

If full verification requires changes to the workflow coverage, stage the known test file and commit it:

```bash
git add lightweaver/tests/workflow.spec.ts
git commit -m "test(lightweaver): cover quiet automatic card sync"
```
