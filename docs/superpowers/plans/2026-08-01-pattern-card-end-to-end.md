# Pattern-to-Card End-to-End Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Studio pattern selection, physical preview, card installation, stored card playback, and card-to-Studio return navigation reliable and visibly recoverable.

**Architecture:** Preserve the HTTPS Studio → local card-page `postMessage` bridge as the sole public-to-local command path. Require every physical command and install step to return positive card evidence before the UI reports success, retain the card's internal renderer for installed chip-ready patterns, and keep Wi-Fi/wiring safety interlocks explicit rather than bypassing them.

**Tech Stack:** React 18, Vite, Playwright, Node test runner, ESP32-S3 Arduino/FastLED firmware, local HTTP/WebSocket bridge, Cloudflare Pages.

---

## Five-loop acceptance cadence

Run the complete workflow five times after integration. Every loop covers pattern tap, card acknowledgement, installation, reboot/stored playback, card-to-Studio return, reconnect, and visible error recovery; later loops deliberately vary pattern, navigation order, and failure injection instead of repeating the same happy path.

Track a friction score from: unnecessary clicks, manual reconnect actions, dead-end errors, false success states, and seconds from pattern tap to confirmed card acknowledgement. Each loop must eliminate or automate at least 30% of the friction points exposed by that loop (rounding up); actions already at the practical minimum of one tap must remain one tap and gain stronger confirmation rather than artificial click reduction.

1. **Loop 1 — happy path:** six distinct pattern taps, selected-state acknowledgement, install, reboot, stored selection, and return to Studio.
2. **Loop 2 — cold bridge:** begin with the card page absent, acquire it from one pattern tap, then complete the entire workflow.
3. **Loop 3 — interrupted connection:** close/reopen the card tab and interrupt Wi-Fi availability; require preserved intent plus a one-action reconnect/retry.
4. **Loop 4 — rejection and mismatch:** exercise command-not-ready, firmware-gap, configuration mismatch, install rejection, and stale identity; require preventive copy and one concrete recovery action with no false success.
5. **Loop 5 — production soak:** use the deployed site, rapid pattern changes, install a multi-pattern bank, reboot, cycle stored scenes from the card, return to Studio, and repeat pattern changes without accumulating stale tabs, messages, or state.

The task is not complete if any loop regresses a prior loop, leaves an unresolved error visible, or cannot show positive card-side evidence for a claimed success.

Across the five loops, also run these unattended durability probes:

- **Latest-intent race:** issue 20 rapid pattern selections and prove only the final selection is confirmed and rendered; superseded requests must not surface as errors.
- **Reboot persistence:** perform five software reboot/reconnect cycles and compare Wi-Fi configuration, card identity, GPIO/count, LED type/order, current limit, installed look bank, playlist, and startup selection before and after every cycle.
- **Known-good protection:** submit malformed, oversized, stale-identity, project-mismatch, and layout-mismatch packages and prove each is rejected without replacing or blacking out the acknowledged project.
- **Browser recovery:** refresh Studio and card pages, close/reopen the card tab, and exercise duplicate/multiple Studio tabs; require one controlling bridge, no popup loop, bounded tab count, and preserved latest intent.
- **Capacity edges:** exercise 32 looks, 10 zones, four outputs, and a near-3968-byte stored configuration without truncation or false success.
- **Timed soak:** repeatedly change patterns while sampling runtime phase, command readiness, output source, FPS, Wi-Fi state, errors, and browser tab count; fail on readiness loss, FPS collapse, stale state, or unbounded tabs/messages.
- **Delivery resilience:** verify a mobile viewport, cached/hard-refreshed production build, signed firmware/source identity, power-limit preservation, and rollback/convergence after an interrupted install.
- **Card/Hardware controls:** exercise every recovery, test, and install action that returns objective card evidence. Require an acknowledgement plus readback (or a verified reboot/convergence result), and leave purely visual LED/color-order checks explicitly pending for the owner's physical confirmation rather than recording a false unattended pass.

### Task 1: Reproduce and instrument every boundary

**Files:**
- Inspect: `lightweaver/src/v3/lw-pattern.jsx`
- Inspect: `lightweaver/src/lib/cardBridge.js`
- Inspect: `lightweaver/src/lib/cardLiveControl.js`
- Inspect: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Inspect: `firmware/lightweaver-controller/src/main.cpp`
- Test: `lightweaver/tests/patterns-v3.spec.ts`
- Test: `lightweaver/tests/card-bridge-handoff.mjs`

- [ ] **Step 1: Capture live baseline evidence**

```bash
curl --max-time 3 -sS http://192.168.18.70/api/status | jq '{runtimePhase,commandReady,currentLookId,streaming,frameSource,wifi,outputs,led}'
curl --max-time 3 -sS http://192.168.18.70/api/patterns | jq .
```

Expected: `runtimePhase` is `ready`, `commandReady` is true, GPIO 18 has 44 WS2815/GRB pixels, and the stored pattern bank is enumerated.

- [ ] **Step 2: Exercise Studio through the actual two-tab bridge**

Use the controlled Studio and card tabs to select Aurora → Fire → Plasma. After each click, require both the Studio's confirmed state and a successful control reply; procedural controls may leave `streaming:false` because they run internally.

- [ ] **Step 3: Record every visible error state**

Inspect all `role="alert"`, `role="status"`, connection-center state, pattern install state, card visitor error surface, and browser tab-opening result. Classify each as prevention, retry, reconnect, update-card, or configuration correction.

### Task 2: Lock the bridge and pattern-tap regression

**Files:**
- Modify: `lightweaver/src/lib/cardBridge.js`
- Modify: `lightweaver/src/lib/cardBridge.openLocalCardPage.test.js`
- Modify: `lightweaver/tests/card-bridge-handoff.mjs`
- Modify: `lightweaver/tests/patterns-v3.spec.ts`

- [ ] **Step 1: Write/retain the failing bridge-launch assertions**

```js
const fragment = new URLSearchParams(new URL(opened[0].url).hash.slice(1));
assert.equal(fragment.get('studioBridge'), '1');
assert.equal(fragment.get('studioOrigin'), 'https://led.mandalacodes.com');
```

Add the external source-contract expectation that `openLocalCardPage` uses the bridge URL and that a blocked popup preserves an already verified same-card bridge.

- [ ] **Step 2: Verify RED against the pre-fix behavior**

Run:

```bash
cd lightweaver
node --test src/lib/cardBridge.openLocalCardPage.test.js
node tests/card-bridge-handoff.mjs
```

Expected before implementation: plain card-page launch lacks `studioBridge`, or popup failure revokes the working lifecycle.

- [ ] **Step 3: Implement the minimal bridge correction**

Keep the named card tab, add `studioBridge=1` and the exact allowed Studio origin, revoke the old lifecycle only after `window.open` returns a real target, and reuse a live same-card opener/parent when a repeat popup is blocked.

- [ ] **Step 4: Verify GREEN and physical selection**

```bash
cd lightweaver
node --test src/lib/cardBridge.openLocalCardPage.test.js
node tests/card-bridge-handoff.mjs
npx playwright test tests/patterns-v3.spec.ts --project=chromium --workers=1
```

Expected: all pass, and the pattern regression records a card `control` payload whose `patternId` changes to `fire`/`plasma`.

### Task 3: Make install-to-card and stored playback truthful

**Files:**
- Modify: `lightweaver/src/v3/lw-pattern.jsx`
- Modify: `lightweaver/src/lib/cardRuntimeProject.js`
- Modify: `lightweaver/src/lib/cardRuntimeContract.js`
- Modify: `lightweaver/src/lib/cardLiveControl.js`
- Modify: `lightweaver/tests/card-pattern-bank.mjs`
- Modify: `lightweaver/tests/card-installer-package.mjs`
- Modify: `lightweaver/tests/patterns-v3.spec.ts`

- [ ] **Step 1: Add a failing install acceptance test**

```ts
await page.getByRole('button', { name: 'Fire FAST' }).click();
await page.getByRole('button', { name: /Install on card/ }).click();
expect(installedRuntime.looks.some(look => look.preset === 'fire')).toBe(true);
expect(installedRuntime.startupPatternId).toBe('fire');
await expect(page.getByRole('status')).toContainText(/installed|saved/i);
```

The mocked card reply must include the installed project identity; a transport-only 200 without matching readback must not render success.

- [ ] **Step 2: Verify RED**

```bash
cd lightweaver
node tests/card-pattern-bank.mjs
node tests/card-installer-package.mjs
npx playwright test tests/patterns-v3.spec.ts --project=chromium --workers=1
```

Expected: the test fails at the first missing or falsely confirmed install guarantee.

- [ ] **Step 3: Implement the minimum source fix shown by the failing boundary**

Ensure the selected chip-ready pattern is present in the runtime look bank/startup selection, preserve `led.type`, GPIO/count/order/power settings, and require identity/readback confirmation before the UI reports installation success.

- [ ] **Step 4: Verify GREEN and reboot persistence**

Run the commands from Step 2, then reboot the physical card and verify `/api/patterns` and `/api/status` identify the installed selection and the LEDs render it without Studio.

### Task 4: Make card-to-Studio pattern return deterministic

**Files:**
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify: `firmware/lightweaver-controller/tests/web-pattern-thumbnails.mjs`
- Modify: `firmware/lightweaver-controller/tests/bridge-frame-protocol.mjs`
- Modify: `lightweaver/tests/card-bridge-handoff.mjs`

- [ ] **Step 1: Add a failing URL correlation test**

```js
assert.match(source, /cardBridge=1/);
assert.match(source, /cardHost=/);
assert.match(source, /pattern=/);
assert.match(source, /#screen=patterns/);
```

Require the card's Open/Edit in Studio action to preserve card host and selected stored pattern, use the stable Studio named tab, and retain the card page as its opener bridge.

- [ ] **Step 2: Verify RED**

```bash
node firmware/lightweaver-controller/tests/web-pattern-thumbnails.mjs
node firmware/lightweaver-controller/tests/bridge-frame-protocol.mjs
node lightweaver/tests/card-bridge-handoff.mjs
```

- [ ] **Step 3: Implement only missing correlation/navigation behavior**

Keep the current card UI and stored scene controls. Correct only missing query/hash parameters, opener handling, or selected-pattern hydration exposed by the failing tests.

- [ ] **Step 4: Verify GREEN on the physical card page**

Select a stored scene on the card, tap Edit/Open Studio, confirm Studio opens Patterns with the same card host and pattern, then select another pattern and confirm the LEDs change.

### Task 5: Turn visible failures into actionable recovery

**Files:**
- Modify: `lightweaver/src/lib/cardAction.js`
- Modify: `lightweaver/src/lib/cardConnectionFlow.js`
- Modify: `lightweaver/src/v3/lw-pattern.jsx`
- Modify: `lightweaver/tests/studio-action-status.mjs`
- Modify: `lightweaver/tests/connection-center-quality.spec.ts`
- Modify: `lightweaver/tests/patterns-v3.spec.ts`

- [ ] **Step 1: Add one failing assertion per observed dead-end error**

```ts
await expect(page.getByRole('alert')).toContainText(/what happened/i);
await expect(page.getByRole('button', { name: /Retry|Reconnect|Open card page|Update card|Fix setup/ })).toBeVisible();
```

Each error must name the failed action, preserve the user's selected pattern/install intent, and expose one concrete next action.

- [ ] **Step 2: Verify RED**

```bash
cd lightweaver
node tests/studio-action-status.mjs
npx playwright test tests/connection-center-quality.spec.ts tests/patterns-v3.spec.ts --project=chromium --workers=1
```

- [ ] **Step 3: Implement the smallest recovery mapping for each reproduced failure**

Use existing `classifyCardActionFailure` action IDs; do not invent backend architecture or bypass safety gates. Remove stale/duplicate messages only when the same state is already represented by the connection center.

- [ ] **Step 4: Verify GREEN**

Run the commands from Step 2 and manually trigger popup-blocked, bridge-timeout, command-not-ready, firmware-gap, configuration-mismatch, install rejection, and reconnect states.

### Task 6: Integrate, ship, and prove production

**Files:**
- Verify: `lightweaver/package.json`
- Verify: `.github/workflows/build-firmware.yml`
- Verify: `.github/workflows/deploy-site.yml`
- Verify: `docs/deployment-checklist.md`

- [ ] **Step 1: Run full source verification**

```bash
npm ci --prefix lightweaver
npm ci --prefix led-art-mapper/app
cd lightweaver
npx playwright install chromium
npm run launch:source
cd ..
```

- [ ] **Step 2: Commit the integrated source**

```bash
git add firmware lightweaver release scripts docs
git commit -m "Fix Lightweaver pattern-to-card workflow"
```

- [ ] **Step 3: Verify firmware with the source commit identity**

```bash
LW_BUILD_ID="$(git rev-parse HEAD)" pio run -d firmware/lightweaver-controller -e esp32-s3-n16r8
node firmware/lightweaver-controller/tests/card-identity-capabilities.mjs
```

- [ ] **Step 4: Fast-forward main and monitor release/deploy**

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git push origin HEAD:main
```

Wait for the signed firmware release commit and Cloudflare Pages deployment; never force-push.

- [ ] **Step 5: Run production and physical acceptance**

```bash
cd lightweaver
npm run launch:check
PROD_CHECK_REQUIRED=1 npm run check:prod
```

On the physical card: click at least six distinct Studio patterns, install a multi-pattern bank, reboot, select stored scenes from the card page, return to Studio, change the pattern again, and confirm no unresolved visible error remains.
