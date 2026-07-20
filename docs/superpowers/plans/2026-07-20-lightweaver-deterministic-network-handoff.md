# Lightweaver Deterministic Network Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a factory ESP32-S3 move from its setup hotspot to the gallery LAN without stranding Studio, actively recover from later WiFi loss, and prove the exact released Studio path can load and visibly test the correct project.

**Architecture:** Firmware owns an explicit AP/STA lifecycle and keeps the setup AP alive until a correlated station-origin acknowledgement. The existing named card-page bridge carries exact-card handoff evidence from the HTTP card page to HTTPS Studio, then the same window is retargeted to the verified station IP. Studio revokes the AP lifecycle, requires a fresh station lifecycle and two complete exact-card status reads, and never treats cached identity or bridge readiness as command readiness. A source-to-production entry-graph check and real-card acceptance close the release gap.

**Tech Stack:** ESP32-S3 Arduino/C++ (PlatformIO, native C++ policy tests), React/Vite, Node test runner, Playwright, GitHub Actions/Pages, Web Serial, card-page `postMessage` bridge.

---

## Execution constraints

- Work on the current branch; do not rename it or create another worktree.
- Preserve the public HTTPS-to-local-HTTP bridge boundary and zero-login visitor flow.
- Write each regression test first and observe the intended failure before changing production code.
- Do not use direct HTTP or terminal-issued light commands as acceptance evidence. They are diagnostic only.
- Do not claim success until the signed production artifact is deployed and the erased card passes the live Studio flow.
- Keep the known-good lighting project running while network recovery is in progress.
- Use these timing constants consistently: initial station association timeout `15,000 ms`, reconnect attempt cadence `10,000 ms`, recovery AP threshold `60,000 ms`, and initial handoff AP grace `120,000 ms`.

### Task 1: Add a deterministic firmware connectivity policy

**Files:**

- Create: `firmware/lightweaver-controller/src/LightweaverConnectivityPolicy.h`
- Create: `firmware/lightweaver-controller/tests/connectivity-policy.cpp`
- Create: `firmware/lightweaver-controller/tests/connectivity-policy.mjs`
- Modify: `lightweaver/package.json`

- [ ] Write the native C++ regression test first. Cover initial setup, accepted credentials, successful association, station-origin acknowledgement, grace expiry, association timeout, later station loss, active retries, recovery AP, and successful recovery. The test should exercise a pure transition function with no Arduino dependencies:

```cpp
#include "../src/LightweaverConnectivityPolicy.h"

using lightweaver::ConnectivityEvent;
using lightweaver::ConnectivityPhase;
using lightweaver::ConnectivityState;
using lightweaver::advanceConnectivity;

int main() {
  ConnectivityState state{};
  state.phase = ConnectivityPhase::SetupAp;

  state = advanceConnectivity(state, {
    .event = ConnectivityEvent::CredentialsAccepted,
    .nowMs = 100,
    .generation = 7,
  });
  assert(state.phase == ConnectivityPhase::Joining);
  assert(state.apActive);

  state = advanceConnectivity(state, {
    .event = ConnectivityEvent::StationAssociated,
    .nowMs = 500,
    .generation = 7,
  });
  assert(state.phase == ConnectivityPhase::HandoffReady);
  assert(state.apActive);

  state = advanceConnectivity(state, {
    .event = ConnectivityEvent::StationOriginAck,
    .nowMs = 800,
    .generation = 7,
  });
  assert(state.phase == ConnectivityPhase::Station);
  assert(!state.apActive);
}
```

- [ ] Add a Node wrapper that compiles the native test with the host compiler and runs it:

```js
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'lw-connectivity-'));
try {
  const binary = join(dir, 'connectivity-policy');
  execFileSync(process.env.CXX || 'c++', [
    '-std=c++17',
    'connectivity-policy.cpp',
    '-o', binary,
  ], { cwd: new URL('.', import.meta.url) });
  execFileSync(binary, { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] Run `node firmware/lightweaver-controller/tests/connectivity-policy.mjs` and confirm it fails because the policy does not exist.

- [ ] Implement the smallest pure state machine. Keep hardware effects out of this header. The public shape must expose these phases and decisions:

```cpp
namespace lightweaver {

constexpr uint32_t kInitialJoinTimeoutMs = 15000;
constexpr uint32_t kReconnectCadenceMs = 10000;
constexpr uint32_t kRecoveryApThresholdMs = 60000;
constexpr uint32_t kHandoffGraceMs = 120000;

enum class ConnectivityPhase {
  SetupAp,
  Joining,
  HandoffReady,
  Station,
  Reconnecting,
  RecoveryAp,
};

enum class ConnectivityEvent {
  Tick,
  CredentialsAccepted,
  StationAssociated,
  StationLost,
  StationOriginAck,
};

struct ConnectivityInput {
  ConnectivityEvent event = ConnectivityEvent::Tick;
  uint32_t nowMs = 0;
  uint32_t generation = 0;
};

struct ConnectivityState {
  ConnectivityPhase phase = ConnectivityPhase::SetupAp;
  bool apActive = true;
  bool stationAssociated = false;
  bool reconnectDue = false;
  uint32_t phaseStartedMs = 0;
  uint32_t lastAttemptMs = 0;
  uint32_t generation = 0;
};

ConnectivityState advanceConnectivity(
  const ConnectivityState& current,
  const ConnectivityInput& input
);

}  // namespace lightweaver
```

- [ ] Run the native test and verify it passes.

- [ ] Add the wrapper to `test:core` in `lightweaver/package.json`, then run `cd lightweaver && npm run test:core:source`.

- [ ] Commit: `test(firmware): define deterministic wifi lifecycle`

### Task 2: Replace save-and-reboot with observable AP+STA handoff

**Files:**

- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverTypes.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverRuntimeApi.h`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Create: `firmware/lightweaver-controller/tests/wifi-handoff-contract.mjs`
- Modify: `lightweaver/package.json`

- [ ] Write a source-contract regression test that asserts:

  - `handleWifiPost()` returns HTTP `202`, starts `joining`, and does not call `ESP.restart()`;
  - `/api/status` exposes `wifi.transition`, `wifi.apActive`, `wifi.stationIp`, `wifi.handoffGeneration`, and reconnect metadata without credentials;
  - `/api/wifi/handoff-ack` exists and validates both the active generation and the ESP32 station interface that received the request;
  - failed association leaves the AP active.

```js
assert.match(web, /server\.send\(202,[^;]+\);/);
assert.doesNotMatch(wifiHandler, /ESP\.restart\s*\(/);
assert.match(web, /"\/api\/wifi\/handoff-ack"/);
for (const key of ['transition', 'apActive', 'stationIp', 'handoffGeneration']) {
  assert.match(storage, new RegExp(`wifi\\[\\"${key}\\"\\]`));
}
assert.doesNotMatch(storage, /wifi\[[^\n]+password/);
```

- [ ] Run `node firmware/lightweaver-controller/tests/wifi-handoff-contract.mjs` and confirm it fails for the missing endpoint/status fields and immediate reboot.

- [ ] Add runtime WiFi fields to the existing runtime state without persisting passwords in status. Keep the saved `WifiConfig` separate from transient handoff truth:

```cpp
ConnectivityPhase connectivityPhase = ConnectivityPhase::SetupAp;
bool setupApActive = true;
uint32_t wifiHandoffGeneration = 0;
uint32_t wifiPhaseStartedMs = 0;
uint32_t wifiLastAttemptMs = 0;
String stationIp;
```

- [ ] Change `handleWifiPost()` to validate object/type and bounded SSID, password, and hostname fields before mutating NVS; persist only after complete validation. Increment a nonzero handoff generation, switch to `WIFI_AP_STA`, begin association, and return accepted transition evidence. Remove the delayed restart:

```cpp
runtimeBeginWifiJoin(savedWifi.ssid, savedWifi.password);
JsonDocument response;
response["accepted"] = true;
response["transition"] = "joining";
response["handoffGeneration"] = runtimeConfig.wifiHandoffGeneration;
String body;
serializeJson(response, body);
server.send(202, "application/json", body);
```

- [ ] Replace the boot-time blocking `tryStationJoin()`/STA-only fallback with the same nonblocking policy. A card booting with saved credentials must keep or restore AP reachability until station association and verified handoff; the 15-second timeout must not freeze rendering.

- [ ] On a real `WL_CONNECTED`, store `WiFi.localIP()`, enter `handoff-ready`, refresh mDNS/HTTP/realtime bindings, and keep the AP alive.

- [ ] Add `POST /api/wifi/handoff-ack`. Require the current nonzero generation and prove that the request reached the station interface with `server.client().localIP() == WiFi.localIP()`; never trust the request `Host` header for this proof. An AP-interface request must return `409` and leave the AP running. Send and flush the acknowledgement before scheduling AP teardown.

- [ ] Add `runtimeSetWifiTransitionPending(bool)` and include it in `runtimeTransitionPending()`. During joining, handoff, reconnect, and recovery, command readiness fails closed without replacing the known-good lighting configuration.

- [ ] Retire the AP after valid station-origin acknowledgement, or after `120,000 ms` only if the station is still associated. A failed join must remain reachable in `setup-ap` with a useful status error.

- [ ] Run the new contract test, the native policy test, and `cd lightweaver && npm run test:core:source`.

- [ ] Commit: `fix(firmware): keep setup ap through verified lan handoff`

### Task 3: Actively recover from runtime station loss without stopping LEDs

**Files:**

- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverWledRealtime.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverWledRealtime.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverArtnet.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverArtnet.h`
- Modify: `firmware/lightweaver-controller/tests/wifi-handoff-contract.mjs`
- Modify: `firmware/lightweaver-controller/tests/factory-beacon-safety.mjs`
- Create: `firmware/lightweaver-controller/tests/wifi-project-preservation.mjs`

- [ ] Extend the failing tests to require active `WiFi.reconnect()` or `WiFi.begin(...)` attempts, a `recovery-ap` transition after `60,000 ms`, and no factory beacon renderer when a known-good project exists.

- [ ] Run both firmware contract tests and observe the new failures.

- [ ] Replace passive `maintainConnectivity()` observation with orchestration driven by the policy:

```cpp
if (decision.reconnectDue) {
  WiFi.reconnect();
  runtimeConfig.wifiLastAttemptMs = now;
}
if (decision.phase == ConnectivityPhase::RecoveryAp && !runtimeConfig.setupApActive) {
  WiFi.mode(WIFI_AP_STA);
  startRecoveryAccessPoint();
}
```

- [ ] When station association returns, refresh station IP and mDNS, call the existing `wledRealtimeRebind()`, add and call an idempotent `artnetRebind()` for UDP port 6454, and transition back to `station`. Do not erase credentials or the commissioned project.

- [ ] Gate the yellow factory-alive beacon on `!knownGoodProject`, not merely AP transport. A commissioned card in `recovery-ap` continues its saved scene.

- [ ] Add a preservation contract proving that handoff/reconnect/recovery paths never call `prefs.clear()`, remove known-good/candidate keys, delete SD project content, or invoke factory reset. The explicit reset-WiFi path may remove only the WiFi NVS key.

- [ ] Run:

```sh
node firmware/lightweaver-controller/tests/connectivity-policy.mjs
node firmware/lightweaver-controller/tests/wifi-handoff-contract.mjs
node firmware/lightweaver-controller/tests/factory-beacon-safety.mjs
node firmware/lightweaver-controller/tests/wifi-project-preservation.mjs
cd lightweaver && npm run test:core:source
```

- [ ] Commit: `fix(firmware): recover wifi while preserving playback`

### Task 4: Add a correlated Studio handoff model and bridge retargeting

**Files:**

- Create: `lightweaver/src/lib/cardWifiHandoff.js`
- Create: `lightweaver/src/lib/cardWifiHandoff.test.js`
- Modify: `lightweaver/src/lib/cardBridge.js`
- Modify: `lightweaver/src/lib/cardBridge.openLocalCardPage.test.js`
- Modify: `lightweaver/tests/card-bridge-handoff.mjs`
- Modify: `lightweaver/package.json`

- [ ] Write failing unit tests for exact-card handoff parsing. Reject missing/partial evidence, public/non-IP targets, a mismatched card ID, changed boot ID, stale generation, and duplicates. Accept only a complete private-LAN station target for the active flow:

```js
const handoff = acceptWifiHandoff({
  status: {
    cardId: 'lw-b0fe81f61b44',
    bootId: 'boot-2',
    wifi: {
      transition: 'handoff-ready',
      stationIp: '192.168.18.70',
      handoffGeneration: 4,
    },
  },
  expectedCardId: 'lw-b0fe81f61b44',
  expectedBootId: 'boot-2',
  lastGeneration: 3,
});
assert.equal(handoff.host, '192.168.18.70');
```

- [ ] Extend bridge tests so retargeting reuses `CARD_BRIDGE_WINDOW_NAME`, navigates the existing `WindowProxy`, clears the AP lifecycle before navigation, and appends only a URL-fragment generation:

```js
const result = retargetCardBridge('192.168.18.70', {
  handoffGeneration: 4,
  expectedCardId: 'lw-b0fe81f61b44',
});
assert.equal(result.ok, true);
assert.match(opened.location.href, /^http:\/\/192\.168\.18\.70\/#/);
assert.match(opened.location.hash, /wifiHandoff=4/);
```

- [ ] Run `cd lightweaver && node --test src/lib/cardWifiHandoff.test.js src/lib/cardBridge.openLocalCardPage.test.js && node tests/card-bridge-handoff.mjs` and observe the failures.

- [ ] Implement `acceptWifiHandoff()` as a pure validator. Use existing host normalization and identity helpers; do not introduce a second identity format.

- [ ] Implement `retargetCardBridge()` using the stored named window. Before assigning its new URL, call the existing bridge lifecycle revocation path so AP readiness cannot survive the origin change. Include `wifiHandoff`, `expectedCardId`, and Studio origin in the fragment; never include WiFi credentials.

- [ ] On the station-origin card page, complete the normal bridge handshake first, read fresh status, verify card/generation, then `POST /api/wifi/handoff-ack` to its own origin. Do not acknowledge from the AP page.

- [ ] Add the new unit test to `test:core`, run the focused tests, then `npm run test:core:source`.

- [ ] Commit: `feat(studio): migrate verified card bridge to lan`

### Task 5: Make commissioning advance itself and fail closed

**Files:**

- Modify: `lightweaver/src/components/card/CardCommissioningPanel.jsx`
- Modify: `lightweaver/src/components/card/CardConnectionCenter.jsx`
- Modify: `lightweaver/src/lib/cardConnection.js`
- Modify: `lightweaver/src/lib/cardLink.js`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/tests/connection-center-quality.spec.ts`
- Modify: `lightweaver/tests/card-link-state.mjs`

- [ ] Add Playwright coverage showing that the setup action uses the tracked named bridge, AP `handoff-ready` evidence replaces `192.168.4.1` with the verified LAN IP, the window is retargeted, and two fresh complete station responses advance automatically. Add negative cases for wrong card, changed boot, one response only, stale response, and bridge loss.

- [ ] Add card-link state assertions that every lifecycle/origin change clears `connected` and `commandReady` until two full expected-card envelopes arrive.

- [ ] Run:

```sh
cd lightweaver
node tests/card-link-state.mjs
npx playwright test tests/connection-center-quality.spec.ts --project=chromium --workers=1
```

Confirm the new cases fail.

- [ ] Replace every commissioning setup `target="_blank" rel="noopener noreferrer"` path with the existing `connectCardLink('192.168.4.1')`/named bridge path. Preserve a popup-blocked error with a retry button.

- [ ] In the active commissioning flow only, consume validated `handoff-ready` evidence, persist the private IP through `rememberCardHost`, retarget the named bridge, and show one precise instruction if the workstation still needs to rejoin gallery WiFi.

- [ ] Remove the HTTPS early-exit that disables card-return handling. HTTPS must use bridge transport; direct fetch remains allowed only on HTTP.

- [ ] Require two new station-origin status envelopes with the expected card ID and boot ID before marking command-ready or advancing. On bridge close, timeout, reboot, mismatch, or readiness failure, demote immediately and block mutation.

- [ ] Run focused Node/Playwright tests and `npm run test:core:source`.

- [ ] Commit: `fix(studio): auto-resume exact card after wifi setup`

### Task 6: Prove Production Setup uses the migrated bridge through physical test

**Files:**

- Modify: `lightweaver/src/v3/lw-production.jsx`
- Modify: `lightweaver/src/components/production/ProductionPhysicalTest.jsx`
- Modify: `lightweaver/tests/production-setup.spec.ts`
- Modify: `lightweaver/src/lib/cardPushClient.test.js`

- [ ] Add a browser test that starts with a factory USB identity, supplies AP bridge status, migrates to the station origin, observes two status envelopes, loads the immutable job, reads it back, sends the guided light change through bridge transport, and records the pass only after human confirmation plus a final fresh read.

- [ ] Add loss-path cases during project write and physical test. Assert the footer changes from ready to disconnected, mutation stops, and no success record is written.

- [ ] Run `cd lightweaver && npx playwright test tests/production-setup.spec.ts --project=chromium --workers=1` and confirm the new cases fail.

- [ ] Thread the verified handoff host through the existing production run without replacing the expected USB card identity or job. All production reads/writes on HTTPS must use the current bridge lifecycle.

- [ ] Keep **Blank — load a project** distinct from command-ready. A card may be present and command-ready while still requiring project load, but it is never rendered as production success/green before independent project readback.

- [ ] Ensure the guided light check uses the same bridge mutation path and that final acceptance performs a fresh evidence read after the visible change.

- [ ] Run the focused production tests, `node --test src/lib/cardPushClient.test.js`, and `npm run test:production`.

- [ ] Commit: `test(production): cover hotspot-to-lit-strip workflow`

### Task 7: Verify the deployed Studio entry graph, not only firmware assets

**Files:**

- Modify: `lightweaver/scripts/check-prod-freshness.mjs`
- Modify: `lightweaver/src/lib/productionDeploymentCheck.js`
- Modify: `lightweaver/src/lib/productionDeploymentCheck.test.js`
- Modify: `lightweaver/tests/pages-staging.mjs`

- [ ] Add failing tests that model an updated firmware manifest served by an old Studio entry chunk. Require the check to compare the deployed root loader and every imported entry/module fingerprint needed to reach Production Setup with the staged build graph.

- [ ] Run:

```sh
cd lightweaver
node --test src/lib/productionDeploymentCheck.test.js
node tests/pages-staging.mjs
```

Confirm the stale-entry fixture fails for the correct reason.

- [ ] Extend staging to emit a deterministic Studio build-graph manifest containing file paths and SHA-256 hashes. Extend production freshness checking to fetch and compare that graph plus the signed firmware manifest.

- [ ] Make mismatch output name the first stale/missing asset. Do not silently skip a reachable production mismatch; network-unavailable may remain an explicit skip only in local source verification.

- [ ] Run the focused tests, `npm run build`, `npm run stage:pages`, and `npm run verify:pages`.

- [ ] Commit: `ci: verify deployed studio entry graph`

### Task 8: Update the operator audit and repeatable new-card checklist

**Files:**

- Modify: `docs/deployment-checklist.md`
- Modify: `docs/roadmap.md`
- Create: `docs/card-provisioning-audit.md`
- Create: `docs/new-card-checklist.md`

- [ ] Write the audit as a step-by-step table for flash, factory boot, WiFi entry, LAN handoff, project load, physical test, and customer handoff. For each step include the evidence required, historical failure modes, every former assumed-success boundary, new automatic recovery, and operator-visible failure state.

- [ ] Create a one-page non-engineer checklist. Every item must be observable and binary. Include exact labels such as **Blank — load a project**, exact 44-pixel/GPIO 18 job verification for the current bench card, visible all-strip light confirmation, reboot, recovery, and recorded pass. Mark terminal/direct HTTP commands as engineering diagnostics, never checklist steps.

- [ ] Update the deployment checklist launch gate to require the deterministic handoff regression suite, deployed entry graph match, erased-card live Studio pass, and a deliberate network-loss recovery observation.

- [ ] Review the documents against the approved design. Remove any language that treats a bridge-open event, saved credentials, a ping, mDNS, cached identity, or a project write response as success by itself.

- [ ] Commit: `docs: publish repeatable card production audit`

### Task 9: Full local verification and implementation review

**Files:**

- Review all files changed since `75c7301`

- [ ] Run formatting/static checks already defined by the repository; do not introduce a second formatter.

- [ ] Run the complete source launch gate:

```sh
cd lightweaver
npm run launch:source
```

- [ ] Build firmware locally for the real target:

```sh
cd firmware/lightweaver-controller
pio run -e esp32-s3-n16r8
```

- [ ] Run `cd lightweaver && npm run launch:check` against the exact locally staged binary.

- [ ] Inspect `git diff --check` and `git diff 75c7301...HEAD`. Self-review every changed status transition against the approved design, especially AP-origin acknowledgement, wrong-card adoption, project preservation during recovery, and stale green state.

- [ ] If any verification fails, fix the root cause, add/strengthen its regression test, and rerun the focused test plus the full gate.

- [ ] Commit only any required verification fixes: `fix: close commissioning verification gaps`

### Task 10: Publish the exact signed build and pass real-card acceptance

**Files:**

- Verify: `.github/workflows/build-firmware.yml`
- Verify: deployed `https://led.mandalacodes.com/`
- Record evidence in: `docs/deployment-checklist.md`

- [ ] Push the current branch and open a PR to `main`. Confirm the source verification and firmware build workflows run for every changed firmware source, script, Studio, and deployment-check file.

- [ ] After review, merge once. Wait for the protected signer/release workflow to publish the signed firmware artifact and its manifest, then wait for the Pages deployment of the same integrated commit. Do not manually substitute an unsigned local binary.

- [ ] Run `cd lightweaver && npm run check:prod`. Confirm it reports both the exact signed firmware digest and exact Studio entry-graph match.

- [ ] In a supported desktop browser, open `https://led.mandalacodes.com/#screen=production`. Erase the ESP32-S3 and flash the signed factory image through Web Serial.

- [ ] Without a terminal or manual IP entry, verify the live sequence:

  1. Studio records exact USB/runtime card identity.
  2. Factory card is visibly alive and labeled **Blank — load a project**, never green.
  3. The tracked setup bridge accepts gallery WiFi credentials.
  4. Studio learns and persists the exact card's station IP.
  5. After the workstation returns to gallery WiFi, the named bridge reconnects automatically.
  6. Two complete fresh status reads make commands available.
  7. Studio loads and reads back GPIO 18, 44 pixels, GRB, Aurora, and the configured power limit.
  8. The guided test visibly changes the whole physical strip through the live bridge.
  9. Human confirmation plus final fresh evidence records the pass.

- [ ] Power-cycle the card. Confirm Studio demotes during absence, reconnects to the same exact card, and the saved 44-pixel scene returns visibly.

- [ ] Perform one controlled gallery-WiFi outage. Confirm Studio immediately loses ready/green state, the LEDs continue the saved project, firmware actively retries, and `Lightweaver-XXXX` recovery AP appears within 60 seconds if the outage persists. Restore WiFi and confirm automatic exact-card recovery.

- [ ] Record the signed firmware hash, deployed Studio graph hash, card ID, boot evidence, verified LAN IP, project readback, physical-test confirmation, reboot result, and network-recovery result in the checklist.

- [ ] Only after every item passes, report the production line ready for repeatable card-after-card use. If a hardware step cannot be performed, report precisely that the release is software-verified but not ship-ready.

## Definition of done

- A blank ESP32-S3 is flashed, commissioned, loaded, visibly tested, rebooted, and recovered through the released Studio without terminal commands, manual IP entry, hidden network recovery, or false green/success state.
- Automated firmware, Studio, browser, build, and production-freshness tests pass.
- The signed firmware artifact and deployed Studio entry graph match the reviewed source.
- The full-flow audit and non-engineer checklist are published and verified against the physical card.
