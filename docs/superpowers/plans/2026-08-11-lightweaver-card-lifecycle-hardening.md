# Lightweaver Card Lifecycle Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make preserving firmware updates self-heal after reboot, make all card-facing Studio surfaces agree on one exact-card lifecycle, remove redundant physical-touch prompts from safe ordinary controls, and prove the release against the real GPIO18/41-pixel RGB card.

**Architecture:** Keep `cardLink` as the authoritative identity/transport store, add a pure lifecycle projection for product-facing states, and add single-flight transport acquisition plus a bounded firmware recovery coordinator. Ordinary reversible controls use fresh exact-card, boot, project, and readiness evidence; firmware, wiring, destructive, and visibly physical operations keep their narrow confirmation gates.

**Tech Stack:** React 18, Vite, JavaScript modules, Node test runner, Playwright, ESP32-S3 Lightweaver JSON API, ego-browser task space 35.

---

## File map

- Create `lightweaver/src/lib/cardLifecycle.js`: pure product-state projection shared by Setup, footer attention, update, and controls.
- Create `lightweaver/src/lib/cardLifecycle.test.js`: state-table tests for identity, transport, update, project, and readiness outcomes.
- Create `lightweaver/src/lib/firmwareUpdateRecovery.js`: bounded post-reboot reconnect coordinator with injected timing and transport functions.
- Create `lightweaver/src/lib/firmwareUpdateRecovery.test.js`: deterministic recovery, timeout, rollback, and mismatch tests.
- Modify `lightweaver/src/lib/cardTransport.js`: single-flight exact-card transport acquisition.
- Modify `lightweaver/src/lib/cardTransport.test.js`: concurrent acquisition and retained revocation-safety tests.
- Modify `lightweaver/src/lib/cardFirmwareUpdater.js`: accept exact known-good runtime evidence when update status has already returned to idle.
- Modify `lightweaver/src/lib/cardFirmwareUpdater.test.js`: cover valid, idle-known-good, provisional, rollback, and mismatch correlation.
- Modify `lightweaver/src/v3/lw-flash.jsx`: start bounded recovery for both Wi-Fi and USB after commit/reset; render the shared lifecycle result.
- Modify `lightweaver/src/v3/app.jsx`: derive one lifecycle projection and pass it to all card-facing surfaces.
- Modify `lightweaver/src/lib/setupJourney.js`: consume lifecycle diagnosis instead of reclassifying link failures independently.
- Modify `lightweaver/src/components/card/CardStatusControl.jsx`: render the shared lifecycle label.
- Modify `lightweaver/src/components/card/CardConnectionCenter.jsx`: stop interposing physical pairing for safe exact-card controls.
- Modify `lightweaver/src/components/card/CardControlDrawer.jsx`: use the shared lifecycle command gate and single shared transport authority.
- Modify `lightweaver/tests/preserving-firmware-update.spec.ts`: browser proof for automatic post-update reconnect.
- Modify `lightweaver/tests/card-control-drawer.spec.ts`: regression proof for concurrent control reads and software-only safe controls.
- Modify `lightweaver/tests/connection-center-quality.spec.ts`: shared state and no redundant live-control prompt.
- Modify `lightweaver/tests/card-workspace.spec.ts`: Setup/footer/attention agreement.
- Modify `lightweaver/scripts/real-card-commissioning.mjs`: read patterns, zones, wiring, updater, and exact hardware without mutation.
- Modify `lightweaver/tests/real-card-commissioning.test.mjs`: full readback contract for the acceptance card.

### Task 1: Make exact-card transport acquisition single-flight

**Files:**
- Modify: `lightweaver/src/lib/cardTransport.js`
- Modify: `lightweaver/src/lib/cardTransport.test.js`
- Test: `lightweaver/tests/card-control-drawer.spec.ts`

- [ ] **Step 1: Write the concurrent acquisition regression**

Add a test that holds the `/api/status` response, starts two calls for the same host/card, releases the response, and proves there was one probe and one authority:

```js
test('concurrent consumers share one exact-card transport acquisition', async () => {
  const status = readyStatus();
  const link = linkFor(status);
  let releaseStatus;
  const statusGate = new Promise(resolve => { releaseStatus = resolve; });
  let probes = 0;
  const fetchImpl = async () => {
    probes += 1;
    await statusGate;
    return response(status);
  };
  const options = { host: '192.168.18.70', expectedCardId: 'lw-card-a', link, fetchImpl };
  const first = connectCardTransport(options);
  const second = connectCardTransport(options);
  await Promise.resolve();
  releaseStatus();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(probes, 1);
  assert.equal(left.revoked, false);
});
```

- [ ] **Step 2: Run the regression and verify it fails**

Run: `cd lightweaver && node --test src/lib/cardTransport.test.js`

Expected: FAIL because two probes create two authorities and the later connection revokes the first.

- [ ] **Step 3: Add single-flight acquisition**

Wrap the existing connection body with a host/card keyed flight map; delete the flight only if the stored promise is still the completing promise:

```js
const transportAcquisitionFlights = new Map();

function transportAcquisitionKey(host, expectedCardId) {
  return `${normalizeCardHost(host)}\n${String(expectedCardId || '').trim()}`;
}

export function connectCardTransport(options = {}) {
  const host = normalizeCardHost(options.host);
  const expectedCardId = options.expectedCardId ?? readPersistedCardIdentity()?.id ?? '';
  const key = transportAcquisitionKey(host, expectedCardId);
  const existing = transportAcquisitionFlights.get(key);
  if (existing) return existing;
  const flight = connectCardTransportOnce({ ...options, host, expectedCardId })
    .finally(() => {
      if (transportAcquisitionFlights.get(key) === flight) transportAcquisitionFlights.delete(key);
    });
  transportAcquisitionFlights.set(key, flight);
  return flight;
}
```

Rename the current exported `connectCardTransport` implementation to the private `connectCardTransportOnce`; its existing exact status probe, identity classification, card-link dispatch, and authority construction remain byte-for-byte unchanged below the new wrapper.

- [ ] **Step 4: Run transport and control-drawer tests**

Run: `cd lightweaver && node --test src/lib/cardTransport.test.js && npx playwright test tests/card-control-drawer.spec.ts --project=chromium --workers=1`

Expected: all transport tests pass and the drawer reaches its Blackout control instead of showing “Could not reach”.

- [ ] **Step 5: Commit the transport fix**

```bash
git add lightweaver/src/lib/cardTransport.js lightweaver/src/lib/cardTransport.test.js
git commit -m "fix: share exact-card transport acquisition"
```

### Task 2: Add one pure card lifecycle projection

**Files:**
- Create: `lightweaver/src/lib/cardLifecycle.js`
- Create: `lightweaver/src/lib/cardLifecycle.test.js`

- [ ] **Step 1: Write the lifecycle state table**

Cover disconnected, reconnecting, verifying a new boot, wrong card, update rollback, project mismatch, setup-required, and command-ready:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCardLifecycle } from './cardLifecycle.js';

test('one lifecycle orders identity and update evidence ahead of generic connection copy', () => {
  assert.equal(deriveCardLifecycle({ link: { state: 'disconnected' } }).state, 'disconnected');
  assert.equal(deriveCardLifecycle({ link: { state: 'reconnecting' } }).state, 'reconnecting');
  assert.equal(deriveCardLifecycle({ link: { state: 'revalidating', reason: 'card-restarted' } }).state, 'verifying');
  assert.equal(deriveCardLifecycle({ link: { reason: 'wrong-card' } }).state, 'wrong-card');
  assert.equal(deriveCardLifecycle({ update: { phase: 'rolled-back', reason: 'boot-health-failed' } }).state, 'update-rolled-back');
});

test('safe commands require the exact ready installed project', () => {
  const input = {
    link: {
      state: 'connected-direct', card: { id: 'lw-card-a' }, expectedCard: { id: 'lw-card-a' },
      readiness: { cardId: 'lw-card-a', bootId: 'boot-2', runtimePhase: 'ready', commandReady: true, outputReady: true, playbackReady: true, knownGoodProject: true, projectId: 'piece-a' },
    },
    project: { id: 'piece-a' },
  };
  const ready = deriveCardLifecycle(input);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.safeControlAccess, 'ready');
  assert.equal(deriveCardLifecycle({ ...input, project: { id: 'piece-b' } }).safeControlAccess, 'project-mismatch');
});
```

- [ ] **Step 2: Run the new test and verify the missing module failure**

Run: `cd lightweaver && node --test src/lib/cardLifecycle.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the projection**

Implement `deriveCardLifecycle({ link, update, project })` with this stable return shape:

```js
export function deriveCardLifecycle({ link = {}, update = null, project = null } = {}) {
  const observedId = String(link.card?.id || link.readiness?.cardId || '');
  const expectedId = String(link.expectedCard?.id || '');
  const exactCard = Boolean(observedId) && (!expectedId || observedId === expectedId);
  const studioFingerprint = String(project?.fingerprint || project?.projectFingerprint || '').toLowerCase();
  const cardFingerprint = String(link.readiness?.projectFingerprint || '').toLowerCase();
  const exactProject = Boolean(project?.id && link.readiness?.projectId === project.id)
    && (!studioFingerprint || studioFingerprint === cardFingerprint);
  const commandReady = exactCard
    && link.readiness?.runtimePhase === 'ready'
    && link.readiness?.commandReady === true
    && link.readiness?.outputReady === true;
  let state = 'disconnected';
  if (update?.phase === 'rolled-back') state = 'update-rolled-back';
  else if (link.reason === 'wrong-card' || (observedId && !exactCard)) state = 'wrong-card';
  else if (link.state === 'revalidating') state = 'verifying';
  else if (link.state === 'reconnecting' || link.state === 'reconnecting-bridge') state = 'reconnecting';
  else if (link.reason === 'firmware-too-old' || link.reason === 'identity-missing') state = 'update-required';
  else if (exactCard && link.cardBlank === true) state = 'setup-required';
  else if (commandReady && !exactProject) state = 'project-mismatch';
  else if (commandReady && exactProject) state = 'ready';
  else if (exactCard) state = 'attention-required';
  return Object.freeze({
    state,
    exactCard,
    exactProject,
    safeControlAccess: state === 'ready' ? 'ready' : state,
    label: lifecycleLabel(state),
    setupTaskId: lifecycleSetupTask(state),
  });
}
```

Define the product mappings in the same file:

```js
const LABELS = Object.freeze({
  disconnected: 'Not connected',
  reconnecting: 'Card stopped responding',
  verifying: 'Card restarted — verifying',
  'wrong-card': 'Wrong card',
  'update-rolled-back': 'Update rolled back',
  'update-required': 'Needs attention',
  'setup-required': 'Needs project',
  'project-mismatch': 'Needs attention',
  'attention-required': 'Needs attention',
  ready: 'Connected',
});

const SETUP_TASKS = Object.freeze({
  disconnected: 'connect-card', reconnecting: 'reconnect-card', verifying: 'reconnect-card',
  'wrong-card': 'connect-card', 'update-rolled-back': 'recover-operation',
  'update-required': 'update-firmware', 'setup-required': 'install-project',
  'project-mismatch': 'load-matching-project', 'attention-required': 'recover-operation',
  ready: 'open-patterns',
});

function lifecycleLabel(state) { return LABELS[state] || LABELS.disconnected; }
function lifecycleSetupTask(state) { return SETUP_TASKS[state] || SETUP_TASKS.disconnected; }
```

- [ ] **Step 4: Run the lifecycle tests**

Run: `cd lightweaver && node --test src/lib/cardLifecycle.test.js src/lib/cardLinkReadiness.test.js src/lib/setupJourney.test.js`

Expected: all tests pass.

- [ ] **Step 5: Commit the lifecycle module**

```bash
git add lightweaver/src/lib/cardLifecycle.js lightweaver/src/lib/cardLifecycle.test.js
git commit -m "feat: derive one card lifecycle state"
```

### Task 3: Accept exact known-good post-update evidence after updater status expires

**Files:**
- Modify: `lightweaver/src/lib/cardFirmwareUpdater.js`
- Modify: `lightweaver/src/lib/cardFirmwareUpdater.test.js`

- [ ] **Step 1: Add idle-status recovery tests**

Add assertions proving that an exact new boot on the target build with unchanged project and known-good command/output readiness succeeds even when `/api/update/status` has returned to idle; provisional or non-ready evidence remains rejected:

```js
const idleKnownGood = {
  ...readiness,
  runtimePhase: 'ready', knownGoodProject: true,
  commandReady: true, outputReady: true, playbackReady: true,
};
assert.deepEqual(
  correlateFirmwareUpdateRecovery(session, { phase: 'idle' }, idleKnownGood),
  { ok: true, terminal: true, phase: 'valid', reason: '', evidence: 'runtime-known-good' },
);
assert.equal(correlateFirmwareUpdateRecovery(session, { phase: 'idle' }, {
  ...idleKnownGood, provisionalSetup: true,
}).reason, 'runtime-not-known-good');
```

- [ ] **Step 2: Run the updater tests and verify failure**

Run: `cd lightweaver && npm run test:firmware-update:unit`

Expected: FAIL because idle update status currently returns `update-not-valid`.

- [ ] **Step 3: Implement the exact runtime fallback**

After target firmware and project correlation, accept idle/missing update status only when all known-good runtime fields are affirmative:

```js
const runtimeKnownGood = readiness.runtimePhase === 'ready'
  && readiness.knownGoodProject === true
  && readiness.commandReady === true
  && readiness.outputReady === true
  && readiness.playbackReady === true
  && readiness.provisionalSetup !== true;
if (['', 'idle'].includes(phase) && runtimeKnownGood) {
  return { ok: true, terminal: true, phase: 'valid', reason: '', evidence: 'runtime-known-good' };
}
if (['', 'idle'].includes(phase)) {
  return { ok: false, terminal: false, phase, reason: 'runtime-not-known-good' };
}
```

Keep rollback handling before target-build comparison so a reported rollback retains its restored build and reason.

- [ ] **Step 4: Run unit and firmware contracts**

Run: `cd lightweaver && npm run test:firmware-update:unit && npm run test:firmware-update:firmware`

Expected: all tests pass.

- [ ] **Step 5: Commit the recovery correlation**

```bash
git add lightweaver/src/lib/cardFirmwareUpdater.js lightweaver/src/lib/cardFirmwareUpdater.test.js
git commit -m "fix: accept exact known-good update recovery"
```

### Task 4: Add the bounded post-update recovery coordinator

**Files:**
- Create: `lightweaver/src/lib/firmwareUpdateRecovery.js`
- Create: `lightweaver/src/lib/firmwareUpdateRecovery.test.js`

- [ ] **Step 1: Write deterministic coordinator tests**

Use injected `connect`, `readSnapshot`, `wait`, and `now` functions. Prove retries use only the saved host candidates, exact correlation finishes, wrong-card never succeeds, rollback is terminal, and timeout retains the session.

```js
test('recovery retries the expected card and finishes on a correlated new boot', async () => {
  const attempts = [];
  const result = await recoverFirmwareUpdate({
    session,
    hosts: ['lightweaver.local'],
    connect: async host => { attempts.push(host); },
    readSnapshot: async () => attempts.length === 1
      ? null
      : { readiness: idleKnownGood, updateStatus: { phase: 'idle' } },
    wait: async () => {},
    now: (() => { let value = 0; return () => value += 100; })(),
    timeoutMs: 1000,
  });
  assert.equal(result.state, 'reconnected');
  assert.deepEqual(attempts, ['lightweaver.local', 'lightweaver.local']);
});
```

- [ ] **Step 2: Run the missing-module test**

Run: `cd lightweaver && node --test src/lib/firmwareUpdateRecovery.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the coordinator**

Export `recoverFirmwareUpdate({ session, hosts, connect, readSnapshot, wait, now, timeoutMs, onState })`. Normalize and deduplicate local hosts, iterate until deadline, call `correlateFirmwareUpdateRecovery`, and return only the terminal shapes below:

```js
{ state: 'reconnected', correlation, snapshot }
{ state: 'rolled-back', correlation, snapshot }
{ state: 'blocked', reason: 'wrong-card' | 'target-mismatch' | 'project-changed', correlation }
{ state: 'timeout', reason: 'reconnect-timeout' }
```

Use this implementation; it keeps session storage outside the module so only the React owner clears a successful session:

```js
import { correlateFirmwareUpdateRecovery } from './cardFirmwareUpdater.js';
import { normalizeCardHost } from './cardConnection.js';

const TERMINAL_BLOCKERS = new Set(['wrong-card', 'target-mismatch', 'project-changed']);

export async function recoverFirmwareUpdate({
  session,
  hosts = [],
  connect,
  readSnapshot,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
  timeoutMs = 45_000,
  onState = () => {},
} = {}) {
  if (!session?.cardId || typeof connect !== 'function' || typeof readSnapshot !== 'function') {
    throw new TypeError('Exact firmware recovery inputs are required.');
  }
  const candidates = [...new Set(hosts.map(normalizeCardHost).filter(Boolean))];
  if (!candidates.length) throw new TypeError('At least one local recovery host is required.');
  const deadline = now() + timeoutMs;
  let intervalMs = 400;
  let attempt = 0;
  while (now() < deadline) {
    const host = candidates[attempt % candidates.length];
    attempt += 1;
    onState({ state: 'reconnecting', host, attempt });
    try { await connect(host, { expectedCardId: session.cardId }); } catch { /* fresh snapshot decides */ }
    const snapshot = await readSnapshot(host).catch(() => null);
    if (snapshot?.readiness) {
      const correlation = correlateFirmwareUpdateRecovery(
        session,
        snapshot.updateStatus || {},
        snapshot.readiness,
      );
      if (correlation.ok) return { state: 'reconnected', correlation, snapshot };
      if (correlation.phase === 'rolled-back') return { state: 'rolled-back', correlation, snapshot };
      if (TERMINAL_BLOCKERS.has(correlation.reason)) {
        return { state: 'blocked', reason: correlation.reason, correlation };
      }
    }
    await wait(intervalMs);
    intervalMs = Math.min(2_000, intervalMs * 2);
  }
  return { state: 'timeout', reason: 'reconnect-timeout' };
}
```

- [ ] **Step 4: Run coordinator and updater tests**

Run: `cd lightweaver && node --test src/lib/firmwareUpdateRecovery.test.js src/lib/cardFirmwareUpdater.test.js`

Expected: all tests pass with no real timer delay.

- [ ] **Step 5: Commit the coordinator**

```bash
git add lightweaver/src/lib/firmwareUpdateRecovery.js lightweaver/src/lib/firmwareUpdateRecovery.test.js
git commit -m "feat: coordinate preserving update recovery"
```

### Task 5: Integrate recovery and lifecycle into Studio surfaces

**Files:**
- Modify: `lightweaver/src/v3/lw-flash.jsx`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/lib/setupJourney.js`
- Modify: `lightweaver/src/components/card/CardStatusControl.jsx`
- Modify: `lightweaver/src/components/card/CardControlDrawer.jsx`
- Modify: `lightweaver/tests/preserving-firmware-update.spec.ts`
- Modify: `lightweaver/tests/card-workspace.spec.ts`

- [ ] **Step 1: Replace the disconnected-recovery browser expectation**

Change the preserving fixture so `onReconnectCard` publishes an exact new-boot target snapshot on the second attempt. Assert the panel reaches “Reconnected” before the short timeout and never renders the stale timeout alert.

```ts
await expect(panel).toContainText(`Reconnected to Card ${CARD_ID}`);
await expect(panel.getByRole('alert')).toHaveCount(0);
expect(await page.evaluate(() => sessionStorage.getItem('lw_firmware_update_session_v1'))).toBeNull();
```

Add a card-workspace table asserting Setup and footer labels for reconnecting, verifying, wrong-card, project-mismatch, and ready states are derived from the same lifecycle object.

- [ ] **Step 2: Run the browser tests and verify failure**

Run: `cd lightweaver && npx playwright test tests/preserving-firmware-update.spec.ts tests/card-workspace.spec.ts --project=chromium --workers=1`

Expected: preserving disconnected recovery still times out and at least one surface disagrees with the lifecycle table.

- [ ] **Step 3: Wire the shared lifecycle through the app**

In `app.jsx`, derive once:

```js
const cardLifecycle = useMemo(() => deriveCardLifecycle({
  link: cardLink,
  update: firmwareUpdateRecoveryState,
  project: serializeProject(),
}), [cardLink, firmwareUpdateRecoveryState, projectLifecycle.generation, serializeProject]);
```

Pass `lifecycle={cardLifecycle}` to `CardStatusControl`, `CardConnectionCenter`, `CardControlDrawer`, `CardScreen`, and the preserving update screen. Update `deriveSetupJourney` to accept `cardLifecycle` and use `cardLifecycle.setupTaskId` for connection blockers. Keep Layout’s visible-light verification logic unchanged.

In `lw-flash.jsx`, start `recoverFirmwareUpdate` immediately after both Wi-Fi commit and USB reset. Feed state changes into the shared recovery state, call `onReconnectCard` with the saved stable host, clear the firmware session only on `reconnected`, and leave it intact on timeout or mismatch.

- [ ] **Step 4: Run focused browser and unit tests**

Run: `cd lightweaver && node --test src/lib/cardLifecycle.test.js src/lib/setupJourney.test.js src/lib/firmwareUpdateRecovery.test.js && npx playwright test tests/preserving-firmware-update.spec.ts tests/card-workspace.spec.ts --project=chromium --workers=1`

Expected: all tests pass; Wi-Fi and USB recovery both self-heal from exact evidence.

- [ ] **Step 5: Commit the integrated lifecycle**

```bash
git add lightweaver/src/v3/lw-flash.jsx lightweaver/src/v3/app.jsx lightweaver/src/lib/setupJourney.js lightweaver/src/components/card/CardStatusControl.jsx lightweaver/src/components/card/CardControlDrawer.jsx lightweaver/tests/preserving-firmware-update.spec.ts lightweaver/tests/card-workspace.spec.ts
git commit -m "feat: unify card lifecycle recovery"
```

### Task 6: Remove the redundant physical-touch gate from safe controls

**Files:**
- Modify: `lightweaver/src/components/card/CardConnectionCenter.jsx`
- Modify: `lightweaver/src/components/card/CardControlDrawer.jsx`
- Modify: `lightweaver/src/lib/cardTransport.test.js`
- Modify: `lightweaver/tests/connection-center-quality.spec.ts`
- Modify: `lightweaver/tests/card-control-drawer.spec.ts`

- [ ] **Step 1: Replace the physical-prompt contract test**

Replace the source-text assertion with product behavior:

```js
test('ordinary safe controls do not require a physical owner capability', async () => {
  const source = await readFile(new URL('../components/card/CardConnectionCenter.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Touch a physical card control/);
  assert.doesNotMatch(source, /Enable live control/);
  assert.match(source, /safeControlAccess/);
});
```

In Playwright, connect an exact command-ready matching-project card and assert Connection Center closes or offers Done without a live-control permission interstitial. Open the customer drawer and execute Previous, Next, brightness, custom hue, zone sync, and Blackout using mocked exact acknowledgements.

- [ ] **Step 2: Run the tests and verify failure**

Run: `cd lightweaver && node --test src/lib/cardTransport.test.js && npx playwright test tests/connection-center-quality.spec.ts tests/card-control-drawer.spec.ts --project=chromium --workers=1`

Expected: FAIL on the existing “Touch a physical card control” interstitial.

- [ ] **Step 3: Remove only the ordinary-control interstitial**

When `lifecycle.safeControlAccess === 'ready'`, do not render `Live control permission` and do not call `issueOwnerCapability`. The customer drawer remains disabled for every other lifecycle state. Preserve `issueOwnerCapability` for the older physical firmware-update fallback and settings operations that already call it explicitly.

Keep this command gate in `CardControlDrawer`:

```js
const mutationDisabled = lifecycle?.safeControlAccess !== 'ready' || Boolean(controls?.pending);
```

Do not alter wiring discovery, staged configuration, firmware authorization, reboot confirmation, erase, reset, or recover-lights confirmation.

- [ ] **Step 4: Run the full safe-control regression set**

Run: `cd lightweaver && node --test src/lib/cardTransport.test.js src/lib/cardLiveControl.authority.test.js src/lib/cardCustomerControls.test.js && npx playwright test tests/connection-center-quality.spec.ts tests/card-control-drawer.spec.ts --project=chromium --workers=1`

Expected: all tests pass; exact-card and project safety assertions remain green.

- [ ] **Step 5: Commit the safe-control policy**

```bash
git add lightweaver/src/components/card/CardConnectionCenter.jsx lightweaver/src/components/card/CardControlDrawer.jsx lightweaver/src/lib/cardTransport.test.js lightweaver/tests/connection-center-quality.spec.ts lightweaver/tests/card-control-drawer.spec.ts
git commit -m "fix: allow verified ordinary card controls"
```

### Task 7: Expand machine-readable real-card acceptance

**Files:**
- Modify: `lightweaver/scripts/real-card-commissioning.mjs`
- Modify: `lightweaver/tests/real-card-commissioning.test.mjs`

- [ ] **Step 1: Extend the mock card and expected snapshot**

Add JSON fixtures for `/api/wiring/status`, `/api/patterns`, `/api/zones`, and `/api/update/status`. Assert the harness issues GET only and returns:

```js
assert.deepEqual(result.hardware, {
  outputPin: 18,
  pixels: 41,
  chipset: 'WS2815',
  colorOrder: 'RGB',
});
assert.deepEqual(result.patterns.map(pattern => pattern.label), ['Aurora', 'Fire', 'Ocean']);
assert.equal(result.zones[0].pixelCount, 41);
assert.equal(result.update.phase, 'idle');
```

- [ ] **Step 2: Run the harness tests and verify failure**

Run: `cd lightweaver && npm run test:real-card-harness`

Expected: FAIL because the current harness reads only firmware-info and status.

- [ ] **Step 3: Implement bounded read-only endpoint collection**

Reuse `readCardJson` for the four new routes, call `assertIdentity` when an endpoint reports `cardId` or `buildId`, and add `assertExpectedHardware`:

```js
function assertExpectedHardware(status, expected) {
  const output = status.outputs?.[0] || status.led || {};
  const actual = {
    outputPin: Number(output.pin ?? status.outputPin),
    pixels: Number(output.pixelCount ?? status.pixels ?? status.led?.pixels),
    chipset: String(output.type ?? status.led?.type ?? ''),
    colorOrder: String(output.colorOrder ?? status.colorOrder ?? status.led?.colorOrder ?? ''),
  };
  if (actual.outputPin !== expected.outputPin || actual.pixels !== expected.pixels
    || actual.chipset !== expected.chipset || actual.colorOrder !== expected.colorOrder) {
    throw new Error(`Card hardware read-back changed: ${JSON.stringify(actual)}`);
  }
  return actual;
}
```

Add CLI environment inputs `EXPECTED_OUTPUT_PIN`, `EXPECTED_PIXELS`, `EXPECTED_CHIPSET`, and `EXPECTED_COLOR_ORDER`; validate them before the first request.

- [ ] **Step 4: Run the harness and current real card readback**

Run tests: `cd lightweaver && npm run test:real-card-harness`

Run readback with the currently released build identity:

```bash
CARD_HOST=lightweaver.local \
EXPECTED_CARD_ID=lw-b0fe81f61b44 \
EXPECTED_BUILD_ID=6805b1f9861bde9a76f0d91f7b12939ad06e0543 \
EXPECTED_OUTPUT_PIN=18 EXPECTED_PIXELS=41 \
EXPECTED_CHIPSET=WS2815 EXPECTED_COLOR_ORDER=RGB \
npm run commission:real-card
```

Expected: `verified: true`, GET-only request list, three installed looks, one 41-pixel zone, updater idle, and exact GPIO18/41/WS2815/RGB hardware.

- [ ] **Step 5: Commit the expanded harness**

```bash
git add lightweaver/scripts/real-card-commissioning.mjs lightweaver/tests/real-card-commissioning.test.mjs
git commit -m "test: expand real card acceptance readback"
```

### Task 8: Run the end-to-end release loop and prove the deployed revision

**Files:**
- Verify: `docs/deployment-checklist.md`
- Verify: `lightweaver/package.json`
- Verify: signed release artifacts under `firmware/lightweaver-controller/release/`

- [ ] **Step 1: Run focused hardening suites**

```bash
cd lightweaver
node --test src/lib/cardTransport.test.js src/lib/cardLifecycle.test.js src/lib/cardFirmwareUpdater.test.js src/lib/firmwareUpdateRecovery.test.js src/lib/setupJourney.test.js src/lib/cardLiveControl.authority.test.js src/lib/cardCustomerControls.test.js
npx playwright test tests/preserving-firmware-update.spec.ts tests/card-control-drawer.spec.ts tests/connection-center-quality.spec.ts tests/card-workspace.spec.ts --project=chromium --workers=1
npm run test:real-card-harness
```

Expected: every focused test passes with zero retries required.

- [ ] **Step 2: Run the full launch gate**

Run: `cd lightweaver && npm run launch:check`

Expected: all source, browser, firmware, production, build, staged-pages, and signed-binary checks pass.

- [ ] **Step 3: Verify live controls and navigation in ego-browser task space 35**

Reuse task 35. From the Studio tab, visit Setup, Playlist, Patterns, and the footer card controls. Execute Aurora → Fire → Ocean → Previous → Next; change brightness, hue, and zone targeting; toggle Blackout and Restore. After every action, read `/api/patterns`, `/api/zones`, and `/api/status` from the card and require exact applied-state acknowledgement. Restore Aurora and the original zone values before leaving the step.

From the card page, open Studio and return to the card page using the existing named window/bridge route. Require one Studio task/tab and no duplicate navigation surface. No visual confirmation is required because card API readback proves every value in this step.

- [ ] **Step 4: Prove reboot persistence and recovery**

Use the card page’s Reboot action, then poll the read-only acceptance harness until it reports a new boot ID. Require the same card ID, released firmware build, project fingerprint, GPIO18, 41 pixels, WS2815, RGB, installed looks, zones, and restored Aurora. Reopen card controls and repeat one Previous/Next round-trip to prove recovery.

If the card reports rollback, provisional state, a changed project, or different hardware, stop without deployment and attach the exact machine readback to the active LoopX todo.

- [ ] **Step 5: Integrate, deploy, and independently prove production**

Follow the repository’s standing shipment flow: push the reviewed branch, open the integration PR, merge to `origin/main`, wait for any protected signer commit, run the production deployment workflow with real production credentials, then fetch `https://led.mandalacodes.com/studio-release.json` with no-store semantics.

Require the live Studio revision to equal terminal `origin/main`, require every file in the staged build graph to match the deployed artifact, and run the real-card acceptance harness against the signed firmware build that the card reports. Record both repository first-parent build numbers in the final shipment report.

- [ ] **Step 6: Complete LoopX todos with evidence**

Complete the reconnect, unified lifecycle, real-card matrix, and release todos only after their authoritative tests/readbacks exist. Link the final build numbers, commit IDs, production workflow result, live release JSON revision, card boot ID, project fingerprint, and GPIO18/41/WS2815/RGB readback. Leave a user visual-check todo only for any physical light property that machine evidence cannot establish.
