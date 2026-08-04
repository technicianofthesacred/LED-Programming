# Lightweaver Project-Switch Save Barrier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save and verify the current Studio project before replacing it with a different exact project detected on a connected Lightweaver card.

**Architecture:** A small orchestration helper enforces the ordered browser-recovery, authoritative-save, and snapshot-current checks with typed failure reasons. `app.jsx` supplies real browser/cloud persistence callbacks, while `lw-card.jsx` invokes the barrier only after an exact non-current match and revalidates the card/project correlation before replacement. Cloud project opening accepts a narrowly scoped `currentProjectSaved` flag so the already-completed save barrier replaces the old discard confirmation without weakening ordinary library opens.

**Tech Stack:** React 18, JavaScript modules, Node test runner, Playwright, browser localStorage, Lightweaver cloud project client.

---

## File map

- Create `lightweaver/src/lib/projectSwitchSaveBarrier.js`: persistence orchestration and typed result contract.
- Create `lightweaver/src/lib/projectSwitchSaveBarrier.test.js`: fast red/green coverage for ordering, failures, and concurrent edits.
- Modify `lightweaver/src/v3/app.jsx`: capture the exact current snapshot and connect browser/cloud persistence to the barrier.
- Modify `lightweaver/src/v3/lw-card.jsx`: run the barrier before all non-current card-project replacements and show saving/failure states.
- Modify `lightweaver/src/state/CloudLibraryContext.jsx`: require an exact remote/marker for immediate saves and skip replacement confirmation only after a completed card-switch barrier.
- Modify `lightweaver/tests/card-workspace.spec.ts`: prove browser preservation, no discard prompt, failed-save blocking, and duplicate-click serialization.

### Task 1: Save-barrier orchestration helper

**Files:**
- Create: `lightweaver/src/lib/projectSwitchSaveBarrier.js`
- Create: `lightweaver/src/lib/projectSwitchSaveBarrier.test.js`

- [ ] **Step 1: Write failing ordering and failure tests**

Add tests that call the wished-for API and assert browser recovery precedes authoritative persistence:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { runProjectSwitchSaveBarrier } from './projectSwitchSaveBarrier.js';

const snapshot = {
  project: { id: 'current-project', name: 'Current' },
  marker: { generation: 4, revision: 9 },
  authoritative: { kind: 'browser', id: 'record-current' },
};

test('flushes browser recovery before the authoritative save', async () => {
  const calls = [];
  const result = await runProjectSwitchSaveBarrier({
    snapshot,
    flushBrowserRecovery: () => { calls.push('recovery'); return true; },
    saveAuthoritative: async captured => { calls.push(`save:${captured.project.id}`); return { ok: true, destination: 'browser' }; },
    isSnapshotCurrent: captured => captured === snapshot,
  });
  assert.deepEqual(calls, ['recovery', 'save:current-project']);
  assert.deepEqual(result, { ok: true, destination: 'browser', snapshot });
});

test('blocks before authoritative persistence when browser recovery fails', async () => {
  let authoritativeCalls = 0;
  const result = await runProjectSwitchSaveBarrier({
    snapshot,
    flushBrowserRecovery: () => false,
    saveAuthoritative: async () => { authoritativeCalls += 1; return { ok: true }; },
    isSnapshotCurrent: () => true,
  });
  assert.equal(result.reason, 'browser-recovery-failed');
  assert.equal(authoritativeCalls, 0);
});

test('preserves the authoritative failure reason and blocks switching', async () => {
  const result = await runProjectSwitchSaveBarrier({
    snapshot,
    flushBrowserRecovery: () => true,
    saveAuthoritative: async () => ({ ok: false, reason: 'offline' }),
    isSnapshotCurrent: () => true,
  });
  assert.deepEqual(result, { ok: false, reason: 'offline' });
});

test('rejects a save acknowledgement when the captured workspace changed', async () => {
  const result = await runProjectSwitchSaveBarrier({
    snapshot,
    flushBrowserRecovery: () => true,
    saveAuthoritative: async () => ({ ok: true, destination: 'cloud' }),
    isSnapshotCurrent: () => false,
  });
  assert.deepEqual(result, { ok: false, reason: 'workspace-changed' });
});
```

- [ ] **Step 2: Run the helper tests and verify RED**

Run:

```bash
cd lightweaver
node --test src/lib/projectSwitchSaveBarrier.test.js
```

Expected: FAIL because `projectSwitchSaveBarrier.js` does not exist.

- [ ] **Step 3: Implement the minimal orchestration helper**

Create the module with this public contract:

```js
export async function runProjectSwitchSaveBarrier({
  snapshot,
  flushBrowserRecovery,
  saveAuthoritative,
  isSnapshotCurrent,
} = {}) {
  if (!snapshot?.project?.id || !snapshot?.marker) return { ok: false, reason: 'snapshot-invalid' };
  try {
    if (flushBrowserRecovery?.(snapshot) !== true) {
      return { ok: false, reason: 'browser-recovery-failed' };
    }
    const saved = await saveAuthoritative?.(snapshot);
    if (!saved?.ok) return { ok: false, reason: saved?.reason || 'authoritative-save-failed' };
    if (isSnapshotCurrent?.(snapshot) !== true) return { ok: false, reason: 'workspace-changed' };
    return { ok: true, destination: saved.destination, snapshot };
  } catch (error) {
    return { ok: false, reason: error?.reason || 'authoritative-save-failed', error };
  }
}
```

- [ ] **Step 4: Run the helper tests and verify GREEN**

Run `node --test src/lib/projectSwitchSaveBarrier.test.js` and expect all four tests to pass.

### Task 2: Exact cloud-save contract

**Files:**
- Modify: `lightweaver/src/state/CloudLibraryContext.jsx:1299-1362,1365-1384`
- Test: `lightweaver/tests/card-workspace.spec.ts`

- [ ] **Step 1: Add a failing integration assertion for saved-current cloud opens**

Extend the matched-project test harness so `openMatchingCardProject` records its options. Assert the card workflow passes all three fields:

```js
expect(openOptions).toMatchObject({
  expectedRevision: matchedRevision,
  currentProjectSaved: true,
});
expect(typeof openOptions.beforeMutation).toBe('function');
```

Expected RED: the current call has no `currentProjectSaved` flag.

- [ ] **Step 2: Extend `saveNow` with exact expectations**

Accept an optional object and refuse mismatches before creating the save operation:

```js
const saveNow = useCallback(async ({ expectedRemoteId = '', expectedMarker = null } = {}) => {
  const marker = projectMarker(lifecycleRef.current);
  const remote = activeRemoteRef.current;
  if (expectedRemoteId && remote?.id !== expectedRemoteId) return { ok: false, reason: 'workspace-changed' };
  if (expectedMarker && markerKey(expectedMarker) !== markerKey(marker)) return { ok: false, reason: 'workspace-changed' };
  // Existing unchanged and performSave paths continue with this exact marker.
}, [captureAuthenticatedSession, performSave]);
```

The existing `offline`, `conflict`, `queued`, `stale-session`, `replaced`, and error results remain failures; do not convert them into success.

- [ ] **Step 3: Skip cloud replacement confirmation only after the barrier**

Add `currentProjectSaved = false` to `openMatchingCardProject` options and calculate:

```js
const confirmed = currentProjectSaved || await requestReplacementConfirmation({
  currentName: documentRef.current?.name,
  incomingName: activeMetadata.title,
});
```

Keep the fresh active/archive listing, exact revision/document checks, `beforeMutation`, authentication checks, and forced association unchanged.

- [ ] **Step 4: Run focused cloud/card tests**

Run the new Playwright test with an isolated safe port and expect PASS:

```bash
LIGHTWEAVER_TEST_PORT=9987 npx playwright test tests/card-workspace.spec.ts --project=chromium --workers=1 -g "saved current project"
```

### Task 3: Write the end-to-end RED tests

**Files:**
- Modify: `lightweaver/tests/card-workspace.spec.ts:692-822`

- [ ] **Step 1: Replace the old discard-confirmation expectation**

For the verified production-project load test, dirty and name the current workspace before clicking the match. Then assert:

```ts
await matchButton.click();
await expect(page.getByRole('dialog', { name: 'Replace current project?' })).toHaveCount(0);
await expect(page).toHaveURL(/#screen=pattern$/);
const preserved = await page.evaluate(() => {
  const library = JSON.parse(localStorage.getItem('lw_project_library_v1') || '{}');
  return library.records?.find((record: any) => record.project?.name === 'Work in progress');
});
expect(preserved?.project?.id).toBe(currentProjectId);
```

- [ ] **Step 2: Add save-failure and duplicate-click tests through direct CardScreen rendering**

Pass a controllable `saveBeforeCardProjectSwitch` prop. Assert a `{ ok:false, reason:'offline' }` result leaves `replaceProject` untouched and displays a retryable online-save message. In a second test, hold the save promise, dispatch two clicks, and assert the save callback is called once and replacement remains pending.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
LIGHTWEAVER_TEST_PORT=9988 npx playwright test tests/card-workspace.spec.ts --project=chromium --workers=1 -g "saves current work|save failure|duplicate project switch"
```

Expected: FAIL because CardScreen has no save-barrier prop and the production path still opens the discard dialog.

### Task 4: Wire real persistence into the card-project switch

**Files:**
- Modify: `lightweaver/src/v3/app.jsx:390-430,650-705,800-822`
- Modify: `lightweaver/src/v3/lw-card.jsx:35-80,252-495,550-590,682-715`
- Modify: `lightweaver/src/state/CloudLibraryContext.jsx`

- [ ] **Step 1: Build `saveBeforeCardProjectSwitch` in `app.jsx`**

Capture one immutable project/marker/association snapshot, then call the helper:

```js
const latestProjectSaveStateRef = useRef(null);
latestProjectSaveStateRef.current = {
  project: serializeProject(),
  marker: {
    generation: projectLifecycle.generation,
    revision: projectLifecycle.editedRevision,
  },
  remoteId: cloudLibrary.activeRemoteProject?.id || '',
};

const saveBeforeCardProjectSwitch = useCallback(async () => {
  const source = latestProjectSaveStateRef.current;
  const snapshot = structuredClone(source);
  return runProjectSwitchSaveBarrier({
    snapshot,
    flushBrowserRecovery: () => flushProjectAutosave(),
    saveAuthoritative: async captured => {
      if (captured.remoteId) {
        const result = await cloudLibrary.saveNow({
          expectedRemoteId: captured.remoteId,
          expectedMarker: captured.marker,
        });
        return result.ok ? { ok: true, destination: 'cloud' } : result;
      }
      const record = saveCurrentProjectToLibrary(captured.project);
      if (record?.project?.id !== captured.project.id) return { ok: false, reason: 'browser-library-mismatch' };
      markProjectPersisted('browser', captured.marker);
      return { ok: true, destination: 'browser' };
    },
    isSnapshotCurrent: captured => {
      const latest = latestProjectSaveStateRef.current;
      return latest.project.id === captured.project.id
        && latest.marker.generation === captured.marker.generation
        && latest.marker.revision === captured.marker.revision
        && latest.remoteId === captured.remoteId;
    },
  });
}, [cloudLibrary, flushProjectAutosave, markProjectPersisted]);
```

Pass this callback through `CardScreen` to `CardOverview`.

- [ ] **Step 2: Invoke the barrier exactly once for non-current matches**

After exact resolution and before the cloud/browser/production branch:

```js
setMatchingProjectState(current => ({ ...current, status: 'saving', message: 'Saving current project…' }));
const savedCurrent = await saveBeforeCardProjectSwitch?.();
if (!savedCurrent?.ok) {
  throw new Error(projectSwitchSaveFailureMessage(savedCurrent?.reason));
}
await readExactCardSnapshot(evidence);
```

Do not invoke it in the `resolved.source === 'current'` branch. Treat `saving` like `loading` for click suppression and render `Saving current project…` on the action.

- [ ] **Step 3: Remove the discard path only for barrier-protected replacement**

For cloud matches pass `currentProjectSaved: true`. For browser/production, remove `confirmProjectReplacement` and retain `replaceProject(studioProject, { confirmDiscard: () => true })` only after successful saving and final exact revalidation. Keep every card host/id/fw/build/boot/project-evidence and selected-match check already present.

- [ ] **Step 4: Map typed failure reasons to actionable copy**

Implement exact messages:

```js
const SAVE_FAILURE_MESSAGES = {
  'browser-recovery-failed': 'Studio could not create a browser recovery copy. Your current project is still open; free browser storage and retry.',
  offline: 'The current online project has not been saved because Studio is offline. Reconnect, then retry.',
  queued: 'The current online save is still pending. Wait for Saved online, then retry.',
  conflict: 'The current online project has a save conflict. Resolve it in Preferences before switching.',
  'stale-session': 'Your session changed before the current project was saved. Sign in again, then retry.',
  'workspace-changed': 'The current project changed while Studio was saving it. Your edits are still open; retry to save the newest version.',
};
```

- [ ] **Step 5: Run focused unit and Playwright tests**

Run Tasks 1–3 test commands and expect all selected tests to pass.

### Task 5: Full verification and integration review

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run unit tests**

Run `npm run test:unit` from `lightweaver/`. Expected: zero failures.

- [ ] **Step 2: Run the complete affected browser suites**

Run in parallel on safe isolated ports:

```bash
LIGHTWEAVER_TEST_PORT=9989 npx playwright test tests/card-workspace.spec.ts --project=chromium --workers=1
LIGHTWEAVER_TEST_PORT=9990 npx playwright test tests/patterns-v3.spec.ts --project=chromium --workers=1
```

Expected: both suites finish with zero failures.

- [ ] **Step 3: Build and inspect the diff**

Run:

```bash
npm run build
cd ..
git diff --check
git status --short
```

Expected: build exit 0, no whitespace errors, and only intentional Lightweaver save-barrier/card-workflow files changed.

- [ ] **Step 4: Independent safety review**

Review these invariants directly in the integrated diff: no replacement before acknowledged persistence; cloud queued/offline is not success; concurrent edits cancel switching; current exact projects skip the barrier; and card/project correlation is rechecked after the save await.
