# Lightweaver USB Connection Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan. Keep ownership split by task; do not let agents edit overlapping files concurrently.

**Goal:** Make `https://led.mandalacodes.com` the single, comprehensible entry point for connecting, installing, updating, and recovering a Lightweaver card through either secure browser USB or a signed cross-platform Lightweaver Bridge.

**Architecture:** A pure website orchestrator selects one bounded route from observed capabilities. Secure top-level Web Serial remains first choice. Old card-page iframes escape to the canonical HTTPS installer. New firmware opens Studio as a top-level window while retaining the local card page as the command bridge. A narrow Electron Bridge provides a signed desktop USB fallback; its main process owns USB, verifies the fixed production release, and exposes only typed operations to a sandboxed local renderer.

**Tech Stack:** React 19, Vite 7, Node 22 test runner, Playwright, ESP32-S3/PlatformIO, Electron, `serialport`, `esptool-js`, electron-builder, GitHub Actions.

**Approved design:** `docs/superpowers/specs/2026-07-15-lightweaver-usb-connection-pipeline-design.md`

---

## Phase A — Fix the current browser/card failure first

### Task 1: Route by actual capability and document context

**Files:**
- Modify: `lightweaver/src/lib/platformCapabilities.js`
- Modify: `lightweaver/src/lib/platformCapabilities.test.js`
- Modify: `lightweaver/src/lib/cardConnectionFlow.js`
- Modify: `lightweaver/src/lib/cardConnectionFlow.test.js`

- [ ] Add failing tests proving that an embedded Studio beneath an insecure ancestor returns `escape-insecure-card-frame`, while a secure top-level page with Web Serial returns `ready-browser-usb`.
- [ ] Add failing tests for desktop native fallback, mobile handoff, old-card update, wrong-card, recoverable failure, and safe recovery. Assert that Chrome-in-an-insecure-frame is never described as an unsupported browser.
- [ ] Run the focused tests and confirm the new cases fail:

```bash
cd lightweaver
node --test src/lib/platformCapabilities.test.js src/lib/cardConnectionFlow.test.js
```

Expected: failures for the new context fields and action IDs.

- [ ] Extend capability observations without browser-name branching:

```js
return {
  canWebSerialInstall: secureContext === true && topLevel === true && Boolean(serial),
  embedded: topLevel === false,
  secureContext: secureContext === true,
  mustEscapeToSecureInstaller: topLevel === false || secureContext !== true,
  platform: normalizedPlatform,
};
```

- [ ] Replace the legacy action vocabulary with the approved states while keeping compatibility aliases only where existing callers still require them:

```js
[
  'ready-browser-usb', 'escape-insecure-card-frame', 'ready-local-card',
  'needs-card-update', 'launch-native-bridge', 'install-native-bridge',
  'handoff-supported-device', 'wrong-card', 'recoverable-failure',
  'needs-safe-recovery',
]
```

- [ ] Make `identity-missing` and `firmware-too-old` return `needs-card-update`; make an insecure embedded install/update return `escape-insecure-card-frame` before considering native fallback.
- [ ] Run the focused tests until green.
- [ ] Commit: `feat: route card connection by usable capabilities`

### Task 2: Provide a fixed secure-installer escape in the connection UI

**Files:**
- Create: `lightweaver/src/lib/secureInstallerHandoff.js`
- Create: `lightweaver/src/lib/secureInstallerHandoff.test.js`
- Modify: `lightweaver/src/components/card/CardConnectionCenter.jsx`
- Modify: `lightweaver/src/v3/lw-flash.jsx`
- Modify: `lightweaver/tests/connection-center-quality.spec.ts`
- Modify: `lightweaver/tests/universal-install.spec.ts`

- [ ] Write failing unit tests asserting that the helper always returns exactly `https://led.mandalacodes.com/#screen=flash&mode=install`, ignores supplied origins/callbacks/firmware URLs, and opens with `noopener` when no trusted opener bridge is required.
- [ ] Write a failing Playwright test that emulates embedded/insecure observations and expects one primary button labeled **Open secure installer** with explanatory copy naming the local card page rather than blaming Chrome.
- [ ] Implement the fixed helper:

```js
export const SECURE_INSTALLER_URL =
  'https://led.mandalacodes.com/#screen=flash&mode=install';

export function openSecureInstaller(openWindow = window.open) {
  return openWindow(SECURE_INSTALLER_URL, '_blank', 'noopener');
}
```

- [ ] Pass `topLevel: window.top === window.self` into capability detection and wire `escape-insecure-card-frame` to the helper. Do not copy query parameters from the card page.
- [ ] Keep same-origin navigation for a secure top-level Studio; only embedded/insecure contexts open a new top-level page.
- [ ] Run:

```bash
cd lightweaver
node --test src/lib/secureInstallerHandoff.test.js src/lib/platformCapabilities.test.js src/lib/cardConnectionFlow.test.js
npx playwright test tests/connection-center-quality.spec.ts tests/universal-install.spec.ts
```

Expected: all focused tests pass.

- [ ] Commit: `feat: escape insecure card frames to secure installer`

### Task 3: Surface the exact physical-preview failure

**Files:**
- Modify: `lightweaver/src/lib/cardAction.js`
- Modify: `lightweaver/src/lib/cardAction.test.js`
- Modify: `lightweaver/src/v3/lw-pattern.jsx`
- Modify: `lightweaver/src/v3/lw-playlist.jsx`
- Modify: `lightweaver/tests/patterns-v3.spec.ts`
- Modify: `lightweaver/tests/playlist-storage.spec.ts`

- [ ] Add failing classifier tests for `identity-missing`, `wrong-card`, `bridge-missing`, `timeout`, `card-rejected`, and `physical-output-unconfirmed`.
- [ ] Define a bounded result shape instead of accepting arbitrary thrown copy:

```js
export function classifyCardActionFailure(error) {
  return { code, message, actionId, actionLabel };
}
```

- [ ] Assert distinct copy and recovery actions: update old card, reconnect expected card, reopen card page, retry timeout, inspect card rejection, and run physical verification.
- [ ] Replace the two generic catch banners with classifier output; retain the underlying error code through the live-control layer.
- [ ] Run:

```bash
cd lightweaver
node --test src/lib/cardAction.test.js
npx playwright test tests/patterns-v3.spec.ts tests/playlist-storage.spec.ts
```

- [ ] Commit: `fix: explain why physical previews did not run`

### Task 4: Make newly flashed card firmware open Studio top-level

**Files:**
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify: `firmware/lightweaver-controller/tests/private-network-cors.mjs`
- Modify: `firmware/lightweaver-controller/tests/bridge-frame-protocol.mjs`
- Modify: `lightweaver/tests/card-bridge-handoff.mjs`
- Modify: `lightweaver/tests/pages-headers.mjs`

- [ ] Change the source-contract tests first: reject `document.createElement('iframe')`; require `window.open` with the fixed HTTPS Studio origin; require the local page to remain intact and send the versioned ready handshake through `window.opener`.
- [ ] Confirm the new tests fail:

```bash
node firmware/lightweaver-controller/tests/private-network-cors.mjs
node firmware/lightweaver-controller/tests/bridge-frame-protocol.mjs
node lightweaver/tests/card-bridge-handoff.mjs
```

- [ ] Replace `studioOpenScript()` with a bounded top-level launch. Allow only the compiled canonical Studio URL and the local host hint; never accept `studioUrl` from page query parameters.
- [ ] Keep the card page open as the local bridge and show concise fallback copy if the popup is blocked.
- [ ] Update Studio bridge discovery to support the trusted opener path and keep old iframe reception only for compatibility.
- [ ] Run the source-contract tests, then build firmware:

```bash
cd firmware/lightweaver-controller
pio run -e esp32s3
```

Expected: tests and firmware build succeed.

- [ ] Commit: `fix: open Studio securely from the card page`

### Task 5: Ship and verify the secure browser repair

**Files:**
- Modify if required: `docs/deployment-checklist.md`
- Modify if required: `lightweaver/tests/universal-install.spec.ts`

- [ ] Run the entire web/core launch gate:

```bash
cd lightweaver
npm run launch:check
```

- [ ] Run all firmware contract tests and a release build; verify the generated factory image is fresh and signed through the existing release workflow.
- [ ] Deploy Studio through the existing production workflow and verify `https://led.mandalacodes.com/#screen=flash&mode=install` loads without `/design`.
- [ ] On the connected real card, perform the user-reserved USB gesture, install the current signed firmware, and verify `/api/firmware-info` returns `cardId`, `firmwareVersion`, and `buildId`.
- [ ] Verify pattern preview, playlist preview, reclaim/recover, and card-page launch. Record the card acknowledgement and physical-light check separately.
- [ ] Commit any checklist evidence: `docs: record secure installer hardware verification`

---

## Phase B — Build the narrow native USB fallback

### Task 6: Extract one browser-neutral installer core

**Files:**
- Create: `packages/installer-core/package.json`
- Create: `packages/installer-core/src/firmware-release.js`
- Create: `packages/installer-core/src/flash-plan.js`
- Create: `packages/installer-core/src/flash-connection.js`
- Create: `packages/installer-core/src/flash-workflow.js`
- Create: `packages/installer-core/test/installer-core.test.js`
- Modify as compatibility re-exports: `lightweaver/src/lib/firmwareRelease.js`
- Modify as compatibility re-exports: `lightweaver/src/lib/flashPlan.js`
- Modify as compatibility re-exports: `lightweaver/src/lib/flashConnection.js`
- Modify as compatibility re-exports: `lightweaver/src/lib/flashWorkflow.js`
- Modify: `lightweaver/package.json`
- Modify: `lightweaver/package-lock.json`

- [ ] Add package-level tests by porting the signed-manifest, bounded-download, target/size/digest, MD5, reset retry, and guaranteed-release cases before moving implementation.
- [ ] Create a dependency-free ESM package and move pure logic without behavioral changes. Keep the old Studio paths as re-exports so existing imports remain stable.
- [ ] Add a fixed-origin release loader option for Node. It may resolve only against `https://led.mandalacodes.com`; caller input cannot replace the origin.
- [ ] Run package and Studio tests:

```bash
node --test packages/installer-core/test/*.test.js
cd lightweaver && npm run test:core
```

- [ ] Commit: `refactor: share verified installer core`

### Task 7: Scaffold a sandboxed Electron Bridge

**Files:**
- Create: `lightweaver-bridge/package.json`
- Create: `lightweaver-bridge/package-lock.json`
- Create: `lightweaver-bridge/electron-builder.yml`
- Create: `lightweaver-bridge/entitlements.mac.plist`
- Create: `lightweaver-bridge/src/main.js`
- Create: `lightweaver-bridge/src/preload.js`
- Create: `lightweaver-bridge/src/renderer/index.html`
- Create: `lightweaver-bridge/src/renderer/app.js`
- Create: `lightweaver-bridge/src/renderer/styles.css`
- Create: `lightweaver-bridge/test/security.test.js`

- [ ] Pin exact versions of Electron, electron-builder, `serialport`, and `esptool-js` in the Bridge’s own lockfile. Do not add them to the Studio package.
- [ ] Write failing security tests for `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, local packaged content only, blocked navigation, blocked new windows, CSP, and a preload API containing only typed operation/progress/result methods.
- [ ] Implement the smallest local UI with states: select card, inspect, confirm, installing (non-cancellable), verifying, complete, and recovery required.
- [ ] Enforce bounded logs and redact device serial/path data from callbacks and normal UI logs.
- [ ] Run:

```bash
cd lightweaver-bridge
npm test
npm run pack:dir
```

Expected: security tests pass and the unpacked application starts without remote navigation.

- [ ] Commit: `feat: scaffold secure Lightweaver Bridge`

### Task 8: Implement the main-process USB transport and operation runner

**Files:**
- Create: `lightweaver-bridge/src/native-serial-transport.js`
- Create: `lightweaver-bridge/src/operation-runner.js`
- Create: `lightweaver-bridge/src/result-callback.js`
- Create: `lightweaver-bridge/test/native-serial-transport.test.js`
- Create: `lightweaver-bridge/test/operation-runner.test.js`
- Create: `lightweaver-bridge/test/result-callback.test.js`

- [ ] Write a fake-port conformance suite for the esptool transport surface: connect/disconnect, bounded read queue, write, flush, DTR/RTS, PID/info, timeout, and guaranteed cleanup.
- [ ] Write operation tests for wrong chip, wrong flash size, signature failure, image mismatch, disconnect, interrupted write, failed MD5, failed reboot, identity mismatch, and success. Assert erase never starts before all verification and visible confirmation.
- [ ] Implement `ESPLoader` in Electron main using a `serialport` adapter; renderer receives progress but no port object, arbitrary bytes, path, or raw IPC.
- [ ] Reuse installer-core for signed release download, target validation, full factory image validation, reset retry, verified write, and release in `finally`.
- [ ] Add post-reboot identity acknowledgement before returning success. If acknowledgement is unavailable, return `physical-output-unconfirmed` rather than success.
- [ ] Run Bridge tests and an attached-card development smoke test. Do not publish the unsigned package.
- [ ] Commit: `feat: install and recover cards through native USB`

### Task 9: Add a closed deep-link and callback protocol

**Files:**
- Create: `lightweaver-bridge/src/protocol.js`
- Create: `lightweaver-bridge/test/protocol.test.js`
- Create: `lightweaver/src/lib/bridgeProtocol.js`
- Create: `lightweaver/src/lib/bridgeProtocol.test.js`

- [ ] Write mirrored failing tests for exact operations, protocol version, 128-bit-or-stronger nonce encoding, exact keys, maximum URL length, unsupported fields, expiry, reuse, and fixed callback origin.
- [ ] Accept only:

```text
lightweaver://run?operation=install-current-release&nonce=<random>&version=1
```

- [ ] Support exactly the five approved operations. Deep links must not contain firmware URLs, callbacks, flash offsets, shell text, file paths, hosts, or project payloads.
- [ ] Return only to a compiled `https://led.mandalacodes.com` callback with bounded code, card ID, firmware version/build ID, target, and verification result.
- [ ] Store pending nonces on the public origin with creation time and operation; consume once; reject wrong, expired, or repeated callbacks.
- [ ] Run both protocol suites and commit: `feat: add bounded Bridge launch protocol`

### Task 10: Integrate Bridge fallback into the website orchestrator

**Files:**
- Create: `lightweaver/src/lib/bridgeLaunch.js`
- Create: `lightweaver/src/lib/bridgeLaunch.test.js`
- Modify: `lightweaver/src/components/card/CardConnectionCenter.jsx`
- Modify: `lightweaver/src/v3/lw-flash.jsx`
- Modify: `lightweaver/tests/universal-install.spec.ts`
- Modify: `lightweaver/tests/connection-center-quality.spec.ts`

- [ ] Add tests for direct Web Serial preference, deliberate Bridge launch, bounded callback wait, install prompt after no callback, successful resume, preserved Studio draft, and platform handoff where no USB route exists.
- [ ] Generate the protocol URL only from a locally created nonce and allowlisted operation. Launch it only from a deliberate click.
- [ ] Treat lack of a valid callback as launch failure evidence; never claim reliable installed-app detection.
- [ ] Keep public download buttons disabled until the platform manifest marks a signed, accepted package available.
- [ ] After a successful callback, reconnect to the card and require its own identity acknowledgement; do not treat callback success as proof of physical lights.
- [ ] Run focused unit/Playwright tests and commit: `feat: connect Studio to Lightweaver Bridge`

---

## Phase C — Package, sign, and enable platforms independently

### Task 11: Add reproducible unprivileged package CI

**Files:**
- Create: `.github/workflows/build-lightweaver-bridge.yml`
- Create: `release/bridge-manifest.schema.json`
- Create: `scripts/build-bridge-manifest.mjs`
- Create: `scripts/verify-bridge-artifacts.mjs`
- Create: `lightweaver-bridge/test/package-smoke.test.js`

- [ ] Write manifest/schema tests and packaged smoke tests before the workflow.
- [ ] Pin every GitHub Action by full commit SHA and Node 22. Use `npm ci` from the Bridge lockfile.
- [ ] Run source/security tests first, then build unsigned engineering artifacts for macOS, Windows, and Linux in isolated jobs. Produce checksums, architecture, source revision, toolchain provenance, and malware-scan results.
- [ ] Ensure untrusted build jobs have no signing secrets and cannot publish production assets.
- [ ] Verify workflow syntax and local manifest generation; commit: `ci: build reproducible Bridge artifacts`

### Task 12: Add protected signing and fail-closed publication

**Files:**
- Modify: `.github/workflows/build-lightweaver-bridge.yml`
- Modify: `lightweaver-bridge/electron-builder.yml`
- Modify: `lightweaver-bridge/entitlements.mac.plist`
- Create: `lightweaver/public/bridge/release-manifest.json`
- Create: `docs/lightweaver-bridge-release.md`

- [ ] Add protected environment jobs for macOS Developer ID/hardened runtime/notarization and Windows Authenticode. Linux artifacts remain checksum/provenance verified. Never expose secrets to pull-request jobs.
- [ ] Fail closed when a signing credential, notarization result, signature verification, checksum, malware scan, or real-hardware acceptance record is absent.
- [ ] Publish immutable version/build paths and a signed Bridge release manifest only after every gate for that platform passes.
- [ ] Keep unavailable platforms out of the website manifest rather than linking unsigned packages.
- [ ] Verify installed packages and custom-protocol registration on each claimed architecture; commit: `ci: sign and publish accepted Bridge releases`

### Task 13: Run the platform and physical-hardware launch gate

**Files:**
- Modify: `docs/deployment-checklist.md`
- Modify: `docs/lightweaver-bridge-release.md`
- Modify if evidence changes scope: `docs/roadmap.md`

- [ ] macOS Apple Silicon and Intel: signed/notarized install, website launch, USB install/recovery, callback, card identity acknowledgement, physical-light confirmation.
- [ ] Windows x64 and any claimed ARM64 target: signed install, protocol launch, USB install/recovery, callback, card identity acknowledgement, physical-light confirmation.
- [ ] Linux declared distributions: package start, USB permissions guidance, install/recovery, callback, card acknowledgement, physical-light confirmation.
- [ ] Desktop Chrome/ChromeOS: secure top-level Web Serial remains preferred and completes without Bridge.
- [ ] Safari/Firefox desktop: Bridge handoff resumes the same Studio task.
- [ ] iOS and unsupported mobile: clear computer handoff without losing Studio project state.
- [ ] Old firmware: insecure iframe escape → signed update → stable identity → restored live control.
- [ ] Run `npm run launch:check`, all Bridge tests, firmware contract tests, and production URL smoke tests once as a coherent final gate.
- [ ] Enable each platform’s public download only after its own evidence is complete. Commit: `docs: record Bridge platform acceptance`

---

## Plan self-review gate

- [ ] Trace every state, security boundary, checkpoint, error class, platform, and non-goal in the approved design to at least one task and test above.
- [ ] Search this plan for unfinished placeholders:

```bash
rg -n "[T]BD|[T]ODO|[F]IXME|later[[:space:]]+decide|some[[:space:]]+test|as[[:space:]]+needed" \
  docs/superpowers/plans/2026-07-15-lightweaver-usb-connection-pipeline.md
```

Expected: no matches.

- [ ] Confirm new public types are named consistently across website and Bridge: operation, nonce, protocol version, result code, card ID, firmware version, build ID, target, and verification result.
- [ ] Confirm no task introduces a localhost server, background daemon, remote Electron page, arbitrary firmware flasher, Pi dependency, or callback-as-light-proof.
- [ ] Treat absent Apple/Windows signing credentials and absent real hardware evidence as platform release blockers, not reasons to weaken the implementation.
