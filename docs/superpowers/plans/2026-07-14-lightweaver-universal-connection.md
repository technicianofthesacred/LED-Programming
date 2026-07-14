# Lightweaver Universal Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `led.mandalacodes.com` truthfully detect the current device, connect to an already-flashed card, route blank-card installation to a supported USB path, and distinguish browser preview from acknowledged physical output.

**Architecture:** Keep `cardLink.js` as the single transport truth and add two pure layers: platform capability detection and a connection-flow decision engine. A global Card Connection Center renders those decisions and uses the existing card-page bridge, direct local probes, and Web Serial installer. Card identity from `/api/firmware-info` is required before mutating operations, while existing `cardAction` semantics remain the confirmation contract.

**Tech Stack:** React 18, Vite, browser Web Serial, ESP32 card-page `postMessage` bridge, Node test runner, Playwright.

---

## File structure

- `lightweaver/src/lib/platformCapabilities.js` — normalize browser/device hardware capabilities without browser-name assumptions.
- `lightweaver/src/lib/cardConnectionFlow.js` — pure next-action decision engine and user-facing state labels.
- `lightweaver/src/lib/cardIdentity.js` — normalize, persist, and compare stable card identity separately from network location.
- `lightweaver/src/components/card/CardConnectionCenter.jsx` — the only routine connect/install/recovery chooser.
- `lightweaver/src/components/card/CardStatusControl.jsx` — compact global status and entry button.
- `lightweaver/src/lib/cardLink.js` — retain transport state, add verified card summary and acknowledgement time.
- `lightweaver/src/v3/lw-flash.jsx` — keep the flash engine but expose a simple automatic production-install mode.
- `lightweaver/src/v3/app.jsx` — mount the status control and connection center once for every screen.

## Task 1: Add runtime capability detection

**Files:**
- Create: `lightweaver/src/lib/platformCapabilities.js`
- Create: `lightweaver/src/lib/platformCapabilities.test.js`

- [x] **Step 1: Write failing tests for supported desktop, unsupported Safari/Firefox, Android capability-probed, and insecure contexts.**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatformCapabilities } from './platformCapabilities.js';

test('enables website USB only from a secure context with Web Serial', () => {
  assert.equal(detectPlatformCapabilities({ secureContext: true, serial: {} }).canWebSerialInstall, true);
  assert.equal(detectPlatformCapabilities({ secureContext: false, serial: {} }).canWebSerialInstall, false);
  assert.equal(detectPlatformCapabilities({ secureContext: true, serial: null }).canWebSerialInstall, false);
});

test('never infers USB support from a browser name', () => {
  const result = detectPlatformCapabilities({ secureContext: true, serial: null, userAgent: 'Chrome Safari' });
  assert.equal(result.canWebSerialInstall, false);
  assert.equal(result.canControlInstalledCard, true);
});
```

- [x] **Step 2: Run `cd lightweaver && node --test src/lib/platformCapabilities.test.js`.** Expected: FAIL because the module does not exist.
- [x] **Step 3: Implement `detectPlatformCapabilities({ secureContext, serial, userAgent, maxTouchPoints })` returning `canWebSerialInstall`, `canControlInstalledCard`, `isMobile`, `platform`, and `handoffKind`.** Use capability presence for authorization; use the user agent only for explanatory platform copy.
- [x] **Step 4: Run the focused test.** Expected: PASS.
- [x] **Step 5: Commit:** `git add lightweaver/src/lib/platformCapabilities.js lightweaver/src/lib/platformCapabilities.test.js && git commit -m "feat: detect Lightweaver hardware capabilities"`.

## Task 2: Add stable card identity and verified link state

**Files:**
- Create: `lightweaver/src/lib/cardIdentity.js`
- Create: `lightweaver/src/lib/cardIdentity.test.js`
- Modify: `lightweaver/src/lib/cardLink.js`
- Modify: `lightweaver/tests/card-link-state.mjs`
- Modify: `lightweaver/src/lib/cardBridge.js`
- Modify: `firmware/lightweaver-controller/platformio.ini`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Create: `firmware/lightweaver-controller/tests/card-identity-capabilities.mjs`

- [x] **Step 1: Write failing tests that normalize `/api/firmware-info` into a stable identity, reject a different card before mutation, and require verified identity before `isCardLinkConnected` returns true.**

```js
const identity = normalizeCardIdentity({ pieceId: 'mandala-01', pieceName: 'Front Mandala', build: 'abc123', bridgeVersion: 1 }, '192.168.18.70');
assert.deepEqual(identity, {
  id: 'mandala-01', name: 'Front Mandala', firmwareBuild: 'abc123',
  bridgeVersion: 1, host: '192.168.18.70',
});
assert.deepEqual(compareCardIdentity({ id: 'mandala-01' }, { id: 'other' }), { ok: false, reason: 'wrong-card' });
```

- [x] **Step 2: Add a failing firmware contract requiring `/api/firmware-info` and `/api/status` to expose `cardId`, semantic `firmwareVersion`, `buildId`, `configSchemaVersion`, `capabilitiesVersion`, output GPIO/counts, declared limits, runtime source, reset reason, and current wiring probation.**
- [x] **Step 3: Run `node firmware/lightweaver-controller/tests/card-identity-capabilities.mjs` and `cd lightweaver && node --test src/lib/cardIdentity.test.js && node tests/card-link-state.mjs`.** Expected: the new firmware and identity tests FAIL.
- [x] **Step 4: Pin `LW_FIRMWARE_VERSION`, `LW_BUILD_ID`, `LW_CONFIG_SCHEMA_VERSION`, and `LW_CAPABILITIES_VERSION` through build flags.** Derive `cardId` from the ESP32-S3 eFuse chip ID with a `lw-` prefix; treat it as stable non-secret identity, not an authentication secret.
- [x] **Step 5: Extend the two firmware status payloads with the required bounded fields and the existing compile-time limits from `LightweaverTypes.h`.** Do not expose Wi-Fi credentials or raw NVS values.
- [x] **Step 6: Implement identity normalization and `compareCardIdentity(expected, actual)`.** Persist only the stable ID, name, unique hostname, last successful address, firmware version/build, and last acknowledgement timestamp under versioned local-storage keys.
- [x] **Step 7: Extend card-link state with `card`, `acknowledgedAt`, and `activity`.** `activity` is one of `idle`, `pending`, `recovering`, or `failed` and changes only through `operation-started`, `operation-recovering`, `operation-confirmed`, and `operation-failed` events. A popup opening or unverified `ready` event remains `connecting`; only an acknowledged `firmware-info` response carrying the expected bridge origin and normalized identity dispatches `card-verified` and becomes connected.
- [x] **Step 8: Extend the bridge ready path to request `firmware-info` immediately and include the normalized identity in `CARD_BRIDGE_CHANGED_EVENT`.** Preserve bridge-version gating and origin validation.
- [x] **Step 9: Run the focused firmware and Studio suites.** Expected: PASS, including stale-host and wrong-card cases.
- [x] **Step 10: Commit:** `git add firmware/lightweaver-controller lightweaver/src/lib/cardIdentity.js lightweaver/src/lib/cardIdentity.test.js lightweaver/src/lib/cardLink.js lightweaver/src/lib/cardBridge.js lightweaver/tests/card-link-state.mjs && git commit -m "feat: verify card identity before connection"`.

## Task 3: Build the pure connection-flow decision engine

**Files:**
- Create: `lightweaver/src/lib/cardConnectionFlow.js`
- Create: `lightweaver/src/lib/cardConnectionFlow.test.js`

- [x] **Step 1: Write table-driven failing tests for every supported state.**

```js
const cases = [
  [{ link: { state: 'connected-bridge', card: { id: 'a' } } }, 'connected'],
  [{ link: { state: 'disconnected', reason: 'popup-blocked' }, intent: 'working-card' }, 'retry-card-page'],
  [{ intent: 'blank-card', capabilities: { canWebSerialInstall: true } }, 'web-serial-install'],
  [{ intent: 'blank-card', capabilities: { canWebSerialInstall: false, platform: 'ios' } }, 'supported-device-handoff'],
  [{ intent: 'deep-recovery', capabilities: { canWebSerialInstall: false, platform: 'macos' } }, 'connector-fallback'],
];
for (const [input, expected] of cases) assert.equal(nextCardConnectionAction(input).id, expected);
```

- [x] **Step 2: Run `cd lightweaver && node --test src/lib/cardConnectionFlow.test.js`.** Expected: FAIL because the module does not exist.
- [x] **Step 3: Implement a closed action vocabulary:** `connected`, `reconnect-known-card`, `choose-card-condition`, `open-setup-network`, `open-card-page`, `retry-card-page`, `web-serial-install`, `supported-browser-handoff`, `supported-device-handoff`, and `connector-fallback`.
- [x] **Step 4: Give every action one title, one short explanation, one primary button label, and an optional secondary help action.** Do not emit browser-security terminology in routine copy.
- [x] **Step 5: Run the focused suite.** Expected: PASS and every table fixture produces exactly one primary action.
- [x] **Step 6: Commit:** `git add lightweaver/src/lib/cardConnectionFlow.js lightweaver/src/lib/cardConnectionFlow.test.js && git commit -m "feat: route universal card connection flow"`.

## Task 4: Replace the footer-only connection affordance with a global Connection Center

**Files:**
- Create: `lightweaver/src/components/card/CardStatusControl.jsx`
- Create: `lightweaver/src/components/card/CardConnectionCenter.jsx`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/v3/v3-styles.css`
- Modify: `lightweaver/tests/screen-smoke.spec.ts`

- [x] **Step 1: Add failing Playwright assertions that every Studio screen exposes one `Connect Lightweaver` control, opens the connection panel, and offers `My card already lights up` and `Blank or not responding`.**
- [x] **Step 2: Run `cd lightweaver && npx playwright test tests/screen-smoke.spec.ts --grep "Connect Lightweaver"`.** Expected: FAIL against the current footer button.
- [x] **Step 3: Implement `CardStatusControl` with the five visual states from the design:** Not connected, Connecting, Connected, Needs attention, Recovering. Connected copy includes card name, pixel total, GPIO summary, and firmware build only when supplied by acknowledged card status.
- [x] **Step 4: Implement `CardConnectionCenter` as a non-blocking anchored panel that becomes a bottom sheet on narrow screens, driven only by `nextCardConnectionAction`.** It uses dialog semantics, closes with Escape/outside click, and does not obscure the whole workspace. The working-card path calls `connectCardLink`; the blank-card path navigates to `#screen=flash&mode=install`; unsupported paths show the correct handoff. Keep IP/hostname editing inside a collapsed diagnostic disclosure.
- [x] **Step 5: Mount both components once in `app.jsx`; replace the large read-only hostname/footer controls with the compact status control while preserving test-strip controls.**
- [x] **Step 6: Add mobile CSS at 390×844 with no horizontal overflow and 44px primary touch targets.**
- [x] **Step 7: Run the focused Playwright test at desktop and mobile projects.** Expected: PASS.
- [x] **Step 8: Commit:** `git add lightweaver/src/components/card lightweaver/src/v3/app.jsx lightweaver/src/v3/v3-styles.css lightweaver/tests/screen-smoke.spec.ts && git commit -m "feat: add universal Lightweaver connection center"`.

## Task 5: Make working-card onboarding resumable and identity-safe

**Files:**
- Modify: `lightweaver/src/lib/cardConnection.js`
- Modify: `lightweaver/src/hooks/useCardStatus.js`
- Modify: `lightweaver/src/components/card/CardConnectionCenter.jsx`
- Modify: `lightweaver/tests/card-connection-mode.mjs`
- Modify: `lightweaver/tests/card-bridge-handoff.mjs`
- Modify: `lightweaver/tests/screen-smoke.spec.ts`

- [x] **Step 1: Add failing tests for remembered card ID plus replaceable IP, setup-network fallback, popup-blocked retry, and wrong-card refusal.**
- [x] **Step 2: Run `cd lightweaver && node tests/card-connection-mode.mjs && node tests/card-bridge-handoff.mjs`.** Expected: at least the new identity cases FAIL.
- [x] **Step 3: Make discovery candidates use unique hostname and last successful address before generic `lightweaver.local` and `192.168.4.1`.** Numeric address success updates the hint but never changes the stable ID.
- [x] **Step 4: When the card reports setup/AP mode, show three physical steps:** power the card, join `Lightweaver-XXXX`, return and press Continue. Continue opens `192.168.4.1` only from a user gesture.
- [x] **Step 5: On reconnect, compare the detected stable ID with the expected project/card association before enabling Save, GPIO, firmware, or recovery mutations.** Offer explicit `Use this card instead` rather than silently rebinding.
- [x] **Step 6: Run the Node bridge/discovery suites and focused browser flow.** Expected: PASS.
- [x] **Step 7: Commit:** `git add lightweaver/src/lib/cardConnection.js lightweaver/src/hooks/useCardStatus.js lightweaver/src/components/card/CardConnectionCenter.jsx lightweaver/tests && git commit -m "feat: resume safe local card onboarding"`.

## Task 6: Make blank-card installation automatic and platform-correct

**Files:**
- Modify: `lightweaver/src/v3/lw-flash.jsx`
- Create: `lightweaver/src/lib/firmwareRelease.js`
- Create: `lightweaver/src/lib/firmwareRelease.test.js`
- Create: `release/firmware-manifest.schema.json`
- Create: `release/test-vectors/valid-manifest.json`
- Create: `release/test-vectors/tampered-manifest.json`
- Create: `release/keys/lightweaver-release-public.pem`
- Create: `scripts/build-firmware-manifest.mjs`
- Create: `scripts/sign-release-artifacts.mjs`
- Create: `lightweaver/public/firmware/release-manifest.json`
- Create: `lightweaver/public/firmware/release-manifest.sig`
- Modify: `.github/workflows/build-firmware.yml`
- Modify: `lightweaver/tests/pages-staging.mjs`
- Modify: `lightweaver/src/lib/flash.js`
- Modify: `lightweaver/src/lib/flashPlan.js`
- Modify: `lightweaver/tests/flash-connect.mjs`
- Modify: `lightweaver/tests/firmware-image-validation.mjs`
- Create: `lightweaver/tests/universal-install.spec.ts`

- [x] **Step 1: Write failing tests that install mode automatically selects a publisher-signed deployed factory image, requires secure Web Serial, validates ESP32-S3 identity and 16MB flash, rejects a tampered manifest/image, and never exposes file/address/erase controls.**
- [x] **Step 2: Run the focused Node and Playwright tests.** Expected: FAIL because current Flash exposes advanced controls and browser guidance only after navigation.
- [x] **Step 3: Define a canonical manifest with `target`, `firmwareVersion`, `buildId`, immutable image URL, size, SHA-256, config schema range, and minimum installer version.** Sign the canonical bytes with ECDSA P-256; pin only the public key in the repository and store the private key exclusively as the protected `LIGHTWEAVER_RELEASE_SIGNING_KEY` CI secret.
- [x] **Step 4: Implement release scripts that fail closed when the signing key is absent, publish versioned immutable factory images, sign the manifest, and make CI upload the manifest, signature, image, and provenance artifact together.** Add valid and tampered fixed test vectors without committing the production private key.
- [x] **Step 5: Implement `loadProductionFirmwareRelease(fetchImpl, cryptoImpl)` to verify the manifest signature using the pinned public key, then stream/fetch the image and verify its size and SHA-256 before returning its bytes.** Never trust a URL, target, or callback supplied by page query parameters.
- [x] **Step 6: Add a simple install mode with one `Find connected card` action, automatic signed production firmware loading, chip/flash validation, plain-language erase confirmation, progress, verification, USB release, and automatic transition to the setup-network step.**
- [x] **Step 7: Move file selection, offsets, erase choice, and raw log behind a separately labelled Technician diagnostics disclosure that is not rendered in install mode.**
- [x] **Step 8: For unsupported environments, render the action from `cardConnectionFlow` and preserve the current project in the original browser.**
- [x] **Step 9: Run the focused suites plus `node lightweaver/tests/pages-staging.mjs`.** Expected: PASS with a staged signed manifest and immutable versioned image.
- [x] **Step 10: Commit:** `git add release scripts .github/workflows/build-firmware.yml lightweaver/public/firmware lightweaver/src/lib/firmwareRelease.* lightweaver/src/lib/flash.js lightweaver/src/lib/flashPlan.js lightweaver/src/v3/lw-flash.jsx lightweaver/tests && git commit -m "feat: simplify signed card installation"`.

## Task 7: Make physical preview acknowledgement explicit

**Files:**
- Modify: `lightweaver/src/v3/lw-pattern.jsx`
- Modify: `lightweaver/src/v3/lw-playlist.jsx`
- Modify: `lightweaver/src/lib/cardLiveControl.js`
- Modify: `lightweaver/src/lib/cardAction.js`
- Modify: `lightweaver/src/lib/cardAction.test.js`
- Modify: `lightweaver/tests/card-live-preview.mjs`
- Modify: `lightweaver/tests/playlist-live-preview.mjs`
- Modify: `lightweaver/tests/pattern-screen.spec.ts`

- [x] **Step 1: Extend the existing live-preview and `cardAction` tests to distinguish `Previewing in Studio`, `Sending to Lightweaver`, `Playing on Lightweaver`, superseded intent, malformed/`ok:false` acknowledgement, wrong card ID, and failed physical output.**
- [x] **Step 2: Run the focused Node suites.** Expected: the new acknowledgement assertions FAIL; existing newest-intent coalescing remains green.
- [x] **Step 3: Keep the existing per-host latest-only queue in `pushLivePreviewToCard`; do not add a second queue.** Tighten its success contract so confirmation requires valid JSON with `ok:true`, expected card identity, and the echoed/confirmed look or revision when supported.
- [x] **Step 4: Route pattern and playlist physical state through the existing `cardActionReducer`.** Set physical selection only on card acknowledgement; keep Studio preview immediately responsive and ignore superseded responses.
- [x] **Step 5: On failure, show exactly:** `The Studio preview changed, but the physical lights did not. Reconnect and retry.` with actions opening the Connection Center and retrying the latest intent.
- [x] **Step 6: Run Node and Playwright focused tests.** Expected: PASS.
- [x] **Step 7: Commit:** `git add lightweaver/src/lib/cardAction* lightweaver/src/lib/cardLiveControl.js lightweaver/src/v3/lw-pattern.jsx lightweaver/src/v3/lw-playlist.jsx lightweaver/tests && git commit -m "feat: confirm physical Lightweaver previews"`.

## Task 8: Verify and ship Phase 1

**Files:**
- Modify: `docs/public-web-deployment.md`
- Modify: `docs/lightweaver-customer-runtime.md`
- Modify: `docs/deployment-checklist.md`
- Modify: `docs/worker-flash-runbook.md`

- [x] **Step 1: Update customer documentation so every flow starts at `led.mandalacodes.com`; retain local card URLs only in technician diagnostics.**
- [x] **Step 2: Run focused unit tests:** `cd lightweaver && node --test src/lib/platformCapabilities.test.js src/lib/cardIdentity.test.js src/lib/cardConnectionFlow.test.js src/lib/firmwareRelease.test.js src/lib/cardAction.test.js`.
- [x] **Step 3: Run existing integration contracts:** `cd lightweaver && node tests/card-link-state.mjs && node tests/card-connection-mode.mjs && node tests/card-bridge-handoff.mjs && node tests/flash-connect.mjs && node tests/firmware-image-validation.mjs && node tests/card-live-preview.mjs && node tests/playlist-live-preview.mjs`.
- [x] **Step 4: Run browser flows:** `cd lightweaver && npx playwright test tests/screen-smoke.spec.ts tests/universal-install.spec.ts tests/patterns-v3.spec.ts`.
- [ ] **Step 5: Run the complete launch gate:** `cd lightweaver && npm run launch:check`. Expected: all core, production-deployment, Show, build, staging, and Pages verification checks pass.
- [ ] **Step 6: Hardware acceptance on the bench card:** connect from production HTTPS, verify card ID and GPIO16/44 pixels, select three patterns rapidly and confirm only the final pattern becomes physical, close the card page and confirm Studio stops claiming live output, reconnect without entering an IP, and complete a non-destructive USB identity check in Chrome.
- [ ] **Step 7: Request spec-compliance and code-quality reviews, fix blocking findings, rerun the full Phase 1 verification, rebuild the public artifact, and deploy only after production freshness passes.**
- [ ] **Step 8: Commit:** `git add docs && git commit -m "docs: ship universal Lightweaver connection flow"`.

## Later independently shippable plans

After Phase 1 is deployed and hardware-verified, execute three separate plans derived from the approved design:

1. Whole-card configuration transactions and structured resource limits.
2. Signed A/B network firmware updates and boot rollback.
3. Native Connector packages for the platform gaps that remain after browser and OTA paths are proven.

These phases do not block truthful connection and supported website flashing. Each receives its own plan after the preceding card contract is verified so later work is based on measured firmware size, partition behavior, and real platform gaps rather than assumptions.
