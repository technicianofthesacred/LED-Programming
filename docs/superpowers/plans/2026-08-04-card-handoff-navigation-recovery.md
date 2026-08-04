# Card Handoff Navigation Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the exact authorized card-tab navigation recoverable for the firmware's full five-minute Wi-Fi handoff window and retry immediately on browser connectivity/lifecycle recovery.

**Architecture:** Extend the existing private handoff-navigation work record in `cardBridge.js`; do not add a protocol or authority path. Capture the owner window, document, exact correlation, exact target, timer functions, and one wall-clock deadline, then route timer, online, focus, and visible events through one fail-closed retry function with unified cleanup.

**Tech Stack:** Browser JavaScript, Node.js `assert` contract tests, React/Vite repository tooling.

---

### Task 1: Exact handoff navigation lifecycle

**Files:**
- Modify: `lightweaver/tests/card-bridge-handoff.mjs:377-437,821-1087`
- Modify: `lightweaver/src/lib/cardBridge.js:45-51,116-131,287-338,812-901`

- [ ] **Step 1: Add deterministic browser lifecycle and clock seams to the existing harness**

Extend `bridgeWindowHarness()` without exporting any production test API. Add `clock = null` to its parameter list. Immediately after `eventListeners`, create `documentListeners` and `documentRef`:

```js
const documentListeners = new Map();
const documentRef = {
  visibilityState: 'visible',
  addEventListener(type, listener) {
    const listeners = documentListeners.get(type) || new Set();
    listeners.add(listener);
    documentListeners.set(type, listeners);
  },
  removeEventListener(type, listener) {
    documentListeners.get(type)?.delete(listener);
  },
  dispatchEvent(event) {
    for (const listener of documentListeners.get(event.type) || []) listener(event);
  },
};
```

Add these fields to the existing `win` object, before its event listener methods:

```js
document: documentRef,
...(clock ? {
  Date: { now: clock.now },
  setTimeout: clock.setTimeout,
  clearTimeout: clock.clearTimeout,
} : {}),
```

Add these fields to the existing return value after `win` and after `emitMessage` respectively:

```js
documentRef,
emitWindow(type) { win.dispatchEvent({ type }); },
emitVisibility(state) {
  documentRef.visibilityState = state;
  documentRef.dispatchEvent({ type: 'visibilitychange' });
},
listenerCount(target, type) {
  return (target === 'document' ? documentListeners : eventListeners).get(type)?.size || 0;
},
```

Add a chronological fake clock whose `advance(ms)` repeatedly runs every newly scheduled task due at or before the target time:

```js
function timerHarness() {
  let now = 0;
  let nextId = 0;
  const tasks = new Map();
  const setTimeout = (callback, delay = 0) => {
    const id = ++nextId;
    tasks.set(id, { at: now + Math.max(0, Number(delay) || 0), callback });
    return id;
  };
  const clearTimeout = id => tasks.delete(id);
  const advance = ms => {
    const target = now + ms;
    while (true) {
      const due = [...tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!due) break;
      tasks.delete(due[0]);
      now = due[1].at;
      due[1].callback();
    }
    now = target;
  };
  return { now: () => now, setTimeout, clearTimeout, advance, size: () => tasks.size };
}
```

- [ ] **Step 2: Write the failing recovery tests**

Before the existing successful handoff fixture, add focused cases that use the same exact AP tab, station URL, flow ID, and normalized correlation. Assertions must cover these behaviors:

```js
const recoveryClock = timerHarness();
const recoveryNavigations = [];
const recoveryMessages = [];
const recoveryTab = {
  closed: false,
  location: {
    set href(value) {
      recoveryNavigations.push({ at: recoveryClock.now(), href: String(value) });
    },
  },
  postMessage(message) { recoveryMessages.push(message); },
  focus() {},
};
const recoveryHarness = bridgeWindowHarness({
  host: apHost,
  openResult: recoveryTab,
  clock: recoveryClock,
});
recoveryHarness.win.location.href = 'https://led.mandalacodes.com/#screen=production';
recoveryHarness.win.location.origin = 'https://led.mandalacodes.com';
globalThis.window = recoveryHarness.win;
assert.equal(openLocalCardPage(apHost).ok, true);
const recovery = retargetCardBridge(stationHost, handoffCorrelation, {
  flowId: commissioningFlowId,
});
assert.equal(recovery.ok, true);
assert.equal(recoveryNavigations.length, 1);

recoveryHarness.emitWindow('online');
recoveryHarness.emitWindow('focus');
recoveryHarness.emitVisibility('hidden');
assert.equal(recoveryNavigations.length, 3);
recoveryHarness.emitVisibility('visible');
assert.equal(recoveryNavigations.length, 4);
assert.ok(recoveryNavigations.every(entry => entry.href === recovery.url));
assert.equal(recoveryMessages.length, 0);

recoveryClock.advance(130001);
const countAfterOldWindow = recoveryNavigations.length;
recoveryClock.advance(120000);
assert.ok(recoveryNavigations.length > countAfterOldWindow,
  'the exact recovery remains active after the old 130-second cutoff');
assert.ok(recoveryNavigations.at(-1).at < 300000);

recoveryClock.advance(50000);
const countAtDeadline = recoveryNavigations.length;
recoveryClock.advance(60000);
recoveryHarness.emitWindow('online');
recoveryHarness.emitWindow('focus');
recoveryHarness.emitVisibility('visible');
assert.equal(recoveryNavigations.length, countAtDeadline);
assert.equal(recoveryClock.size(), 0);
assert.equal(recoveryHarness.listenerCount('window', 'online'), 0);
assert.equal(recoveryHarness.listenerCount('window', 'focus'), 0);
assert.equal(recoveryHarness.listenerCount('document', 'visibilitychange'), 0);
assert.equal(recoveryMessages.some(message => ['config', 'wifi-handoff-ack'].includes(message.type)), false);
```

Add a second fixture that emits the exact verified `ready` event before the deadline, then proves timer and lifecycle cleanup. Add cases for a verified request response, closed target, owner replacement, and an initially throwing `location.href` setter that becomes writable before a lifecycle signal. Add a stale-correlation assertion: after the rejected changed boot/generation, advancing the clock and invoking captured stale callbacks must not navigate either the old or successor URL.

- [ ] **Step 3: Run the new contract test and verify RED**

Run:

```bash
cd /Users/adrianrasmussen/.codex/worktrees/02d6/led/lightweaver
node tests/card-bridge-handoff.mjs
```

Expected: FAIL at the first `online` navigation assertion because current production code has no lifecycle listeners; after that is resolved, the old implementation must also fail because navigation retries stop at 130 seconds.

- [ ] **Step 4: Implement the five-minute, event-driven recovery work record**

Replace the finite 130-second schedule with a finite warm-up sequence followed by a 30-second cadence until one five-minute deadline:

```js
const WIFI_HANDOFF_NAVIGATION_RETRY_DELAYS_MS = Object.freeze([
  4000, 12000, 24000, 30000,
]);
const WIFI_HANDOFF_NAVIGATION_RETRY_INTERVAL_MS = 30000;
const WIFI_HANDOFF_NAVIGATION_RECOVERY_MS = 300000;
```

Make cleanup own every resource captured by the work record:

```js
function clearBridgeHandoffNavigationRetry(expectedWork = null) {
  const work = bridgeHandoffNavigationRetry;
  if (!work || (expectedWork && work !== expectedWork)) return;
  bridgeHandoffNavigationRetry = null;
  if (work.timer != null) work.clearTimer(work.timer);
  work.owner?.removeEventListener?.('online', work.onLifecycleSignal);
  work.owner?.removeEventListener?.('focus', work.onLifecycleSignal);
  work.document?.removeEventListener?.('visibilitychange', work.onVisibilityChange);
}
```

Replace `scheduleBridgeHandoffNavigationRetry()` with one owner-bound scheduler. Preserve an existing deadline only for the same owner/target/URL/flow/exact correlation so a repeated retarget cannot extend authority beyond five minutes:

```js
function scheduleBridgeHandoffNavigationRetry({ target, url, correlation, flowId }) {
  const previous = bridgeHandoffNavigationRetry;
  const owner = browserWindow();
  const documentRef = owner?.document || (typeof document !== 'undefined' ? document : null);
  const now = typeof owner?.Date?.now === 'function'
    ? owner.Date.now.bind(owner.Date)
    : Date.now;
  const setTimer = owner?.setTimeout?.bind(owner) || setTimeout;
  const clearTimer = owner?.clearTimeout?.bind(owner) || clearTimeout;
  const preserveDeadline = previous
    && previous.owner === owner
    && previous.target === target
    && previous.url === url
    && previous.flowId === flowId
    && sameHandoffCorrelation(previous.correlation, correlation);
  const deadlineAt = preserveDeadline
    ? previous.deadlineAt
    : now() + WIFI_HANDOFF_NAVIGATION_RECOVERY_MS;
  clearBridgeHandoffNavigationRetry();

  const work = {
    target, url, correlation, flowId, owner, document: documentRef,
    now, setTimer, clearTimer, deadlineAt,
    nextDelayIndex: 0, timer: null,
    onLifecycleSignal: null, onVisibilityChange: null,
  };
  const scheduleNext = () => {
    if (bridgeHandoffNavigationRetry !== work) return;
    const remaining = work.deadlineAt - work.now();
    if (remaining <= 0) return clearBridgeHandoffNavigationRetry();
    const configured = WIFI_HANDOFF_NAVIGATION_RETRY_DELAYS_MS[work.nextDelayIndex];
    const delay = Number.isFinite(configured)
      ? configured
      : WIFI_HANDOFF_NAVIGATION_RETRY_INTERVAL_MS;
    work.nextDelayIndex += 1;
    work.timer = work.setTimer(retry, Math.min(delay, remaining));
    work.timer?.unref?.();
  };
  const retry = () => {
    if (bridgeHandoffNavigationRetry !== work) return;
    if (work.timer != null) {
      work.clearTimer(work.timer);
      work.timer = null;
    }
    const currentOrigin = cardHostToUrl(correlation.host);
    if (work.now() >= work.deadlineAt
      || (bridgeReady && bridgeConnected && bridgeOrigin === currentOrigin)
      || browserWindow() !== owner
      || bridgeWindow !== target
      || bridgeTargetClosed(target)
      || bridgeHandoffFlowId !== flowId
      || normalizeCardHost(bridgeHost) !== correlation.host
      || bridgeOrigin !== currentOrigin
      || !sameHandoffCorrelation(bridgeHandoffCorrelation, correlation)) {
      clearBridgeHandoffNavigationRetry(work);
      return;
    }
    revokeBridgeForNavigation({
      host: correlation.host,
      origin: currentOrigin,
      preserveHandoff: true,
    });
    if (bridgeHandoffNavigationRetry !== work
      || browserWindow() !== owner
      || bridgeWindow !== target
      || bridgeTargetClosed(target)
      || bridgeHandoffFlowId !== flowId
      || !sameHandoffCorrelation(bridgeHandoffCorrelation, correlation)) {
      clearBridgeHandoffNavigationRetry(work);
      return;
    }
    try { target.location.href = url; } catch { /* keep bounded recovery alive */ }
    scheduleNext();
  };
  work.onLifecycleSignal = () => retry();
  work.onVisibilityChange = () => {
    if (work.document?.visibilityState === 'visible') retry();
  };
  bridgeHandoffNavigationRetry = work;
  owner?.addEventListener?.('online', work.onLifecycleSignal);
  owner?.addEventListener?.('focus', work.onLifecycleSignal);
  documentRef?.addEventListener?.('visibilitychange', work.onVisibilityChange);
  scheduleNext();
}
```

In `retargetCardBridge()`, clear the active recovery before returning `stale-correlation`, and arm recovery before the initial assignment so a thrown assignment remains recoverable:

```js
if (bridgeHandoffFlowId === flowId
  && (!sameCardBoot || correlation.handoffGeneration <= previous.handoffGeneration)) {
  clearBridgeHandoffNavigationRetry();
  return { ok: false, state: 'stale-correlation', reason: 'stale-correlation', retryable: false };
}

scheduleBridgeHandoffNavigationRetry({
  target,
  url: url.href,
  correlation,
  flowId,
});
try {
  target.location.href = url.href;
} catch (cause) {
  return {
    ok: false,
    state: 'navigation-failed',
    reason: 'bridge-navigation-failed',
    retryable: true,
    window: target,
    host,
    url: url.href,
    correlation,
    repeated,
    error: cause,
  };
}
```

Also make every exit release recovery immediately:

- `clearBridgeTarget()` always calls cleanup; `preserveHandoff` retains correlation data, not browser resources.
- Owner replacement in `attachCardBridgeListener()` clears the old work before detaching the old listener.
- A verified exact-origin request response clears recovery immediately after `setBridgeState()` establishes readiness.
- Keep validated `ready`, `clearCardBridgeHandoff()`, and identity-adoption cleanup intact.

Cleanup must be token-aware so a stale queued callback cannot clear a successor work record. Store and compare the derived `origin` as part of the exact work identity. After `revokeBridgeForNavigation()` dispatches synchronously, repeat the owner/target/flow/correlation checks before assigning `location.href`.

- [ ] **Step 5: Run the focused contract and verify GREEN**

Run:

```bash
cd /Users/adrianrasmussen/.codex/worktrees/02d6/led/lightweaver
node tests/card-bridge-handoff.mjs
```

Expected: `card-bridge-handoff tests passed` with zero failures.

- [ ] **Step 6: Run the focused safety set**

Run:

```bash
cd /Users/adrianrasmussen/.codex/worktrees/02d6/led/lightweaver
node --test src/lib/cardBridge.openLocalCardPage.test.js src/lib/cardBridge.originPolicy.test.js src/lib/cardWifiHandoff.test.js src/lib/cardLinkReadiness.test.js src/lib/cardConnection.test.js src/lib/cardConnectionFlow.test.js src/lib/cardReadiness.test.js
node tests/card-bridge-handoff.mjs
node tests/card-link-state.mjs
node tests/card-connection-mode.mjs
```

Expected: 73 Node tests pass, followed by three passing contract scripts. There must be no timeout, listener-leak, stale-correlation, origin-policy, identity, or mutation-authority failure.

- [ ] **Step 7: Self-review and commit the implementation**

Review:

```bash
git diff --check
git diff -- lightweaver/src/lib/cardBridge.js lightweaver/tests/card-bridge-handoff.mjs
```

Confirm that only navigation is retried, every retry rechecks the exact correlation, event listeners are removed on every exit, and no command/ack/config path was added. Then commit:

```bash
git add lightweaver/src/lib/cardBridge.js lightweaver/tests/card-bridge-handoff.mjs
git commit -m "fix: recover card handoff navigation"
```

### Task 2: Full relevant verification

**Files:**
- Verify only; no source changes expected.

- [ ] **Step 1: Restore workspace dependencies if missing**

Run only when `lightweaver/node_modules` is absent:

```bash
cd /Users/adrianrasmussen/.codex/worktrees/02d6/led/lightweaver
npm ci
```

Expected: dependency installation exits 0 without modifying committed manifests.

- [ ] **Step 2: Run source and unit verification**

```bash
cd /Users/adrianrasmussen/.codex/worktrees/02d6/led/lightweaver
npm run test:core:source
npm run test:unit
```

Expected: both commands exit 0; `test:unit` reports approximately 1,030 passing tests and zero failures.

- [ ] **Step 3: Build the production Studio**

```bash
cd /Users/adrianrasmussen/.codex/worktrees/02d6/led/lightweaver
npm run build
```

Expected: Vite production build exits 0 with generated assets in `dist/` and no compilation errors.

- [ ] **Step 4: Verify repository state**

```bash
cd /Users/adrianrasmussen/.codex/worktrees/02d6/led
git diff --check
git status --short --branch
```

Expected: branch `codex/fix-card-handoff-navigation`; no uncommitted source/test changes. Generated ignored artifacts may exist but must not be staged.

Hardware validation remains separate: delay the gallery-Wi-Fi switch beyond 130 seconds and background Studio, then prove the exact same card boot reaches verified station state without refreshing the card tab.
