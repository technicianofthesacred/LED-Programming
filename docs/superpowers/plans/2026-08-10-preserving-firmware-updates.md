# Preserving Firmware Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a signed, preserving Lightweaver update path where older cards receive one non-erasing USB application bootstrap and update-capable cards subsequently use A/B Wi-Fi updates without losing Wi-Fi, projects, patterns, wiring, or settings.

**Architecture:** The protected release chain publishes one factory image plus one application-only image and an exact-byte P-256-signed update ticket. Firmware owns verification, inactive-slot writes, boot probation, rollback, and truthful status; Studio owns exact-card authority, acknowledged progress, same-card reconnection, and a bounded app0-only USB bootstrap. Existing factory installation and the Bridge stay available only as explicit recovery paths.

**Tech Stack:** React/Vite, Node test runner, Playwright, Web Serial/esptool-js, ESP32-S3 Arduino/ESP-IDF OTA APIs, mbedTLS P-256/SHA-256, PlatformIO, GitHub Actions, Cloudflare Pages.

---

## File structure and shared contract

The fixed update-ticket schema is shared by tooling, Studio, and firmware:

```json
{
  "schemaVersion": 1,
  "firmwareVersion": "1.1.4",
  "buildId": "40-lowercase-hex",
  "buildNumber": 1225,
  "target": "esp32-s3-n16r8",
  "image": {
    "url": "/firmware/releases/<version>/<build>/lightweaver-controller-esp32s3-app.bin",
    "size": 1234567,
    "sha256": "64-lowercase-hex"
  },
  "partition": {
    "layout": "default_16MB.csv",
    "tableSha256": "64-lowercase-hex",
    "app0Offset": 65536,
    "app1Offset": 6619136,
    "slotSize": 6553600
  },
  "compatibility": {
    "firmwareApiMin": 2,
    "firmwareApiMax": 2,
    "projectSchemaMin": 3,
    "projectSchemaMax": 3,
    "minimumUpdaterVersion": 1,
    "minimumBootstrapBuild": 1198
  },
  "preservation": { "dataPartitionsIncluded": false }
}
```

`release-manifest.json` gains one required `update` object containing immutable URL/size/SHA-256 descriptors for `image`, `ticket`, and `signature`. The ticket signature is 64-byte IEEE-P1363 P-256 encoded as base64url plus newline. Firmware endpoints are:

```text
POST /api/update/preflight
POST /api/update/begin
POST /api/update/chunk
POST /api/update/commit
POST /api/update/cancel
GET  /api/update/status
```

Every mutation carries the existing owner headers and JSON bindings plus `releaseBuildId`, `ticketSha256`, and a physical-confirmation nonce. Chunks carry `{leaseId, sequence, offset, data}` with standard base64 data and exact monotonic sequence/offset. Status uses `idle|preflighted|receiving|verifying|pending-reboot|probation|valid|rolled-back|failed`.

### Task 1: Signed application artifact and exact update ticket

**Files:**
- Modify: `packages/installer-core/src/firmware-release.js`
- Modify: `packages/installer-core/test/windowless-firmware-release.test.js`
- Modify: `lightweaver/src/lib/firmwareRelease.test.js`
- Modify: `scripts/build-firmware-manifest.mjs`
- Create: `scripts/build-firmware-update-ticket.mjs`
- Modify: `scripts/sign-release-artifacts.mjs`
- Test: `scripts/firmware-update-release.test.mjs`

- [ ] **Step 1: Write failing schema and tamper tests**

Add fixtures that require the exact ticket keys above, reject unknown keys, wrong target/layout/ranges, `dataPartitionsIncluded: true`, slot overflow, malformed digest, and manifest descriptors that do not match ticket/image bytes.

```js
assert.throws(() => validateFirmwareUpdateTicket({ ...ticket, extra: true }), /unsupported fields/);
assert.throws(() => validateFirmwareUpdateTicket({
  ...ticket,
  preservation: { dataPartitionsIncluded: true },
}), /data partitions/);
assert.deepEqual(validateFirmwareUpdateTicket(ticket), ticket);
```

- [ ] **Step 2: Run RED**

Run: `node --test packages/installer-core/test/windowless-firmware-release.test.js scripts/firmware-update-release.test.mjs`

Expected: FAIL because `validateFirmwareUpdateTicket` and the update descriptors do not exist.

- [ ] **Step 3: Implement strict shared validation and canonical bytes**

Export from installer-core and the Studio wrapper:

```js
export const LIGHTWEAVER_PARTITION_LAYOUT = Object.freeze({
  layout: 'default_16MB.csv',
  app0Offset: 0x10000,
  app1Offset: 0x650000,
  slotSize: 0x640000,
});
export function validateFirmwareUpdateTicket(ticket) { /* exact-key, bounded validation */ }
export function canonicalFirmwareUpdateTicketBytes(ticket) {
  validateFirmwareUpdateTicket(ticket);
  return new TextEncoder().encode(JSON.stringify(ticket));
}
```

Extend `validateFirmwareManifest` so `manifest.update.image`, `.ticket`, and `.signature` are immutable, fixed-key descriptors and the image/ticket identity equals the factory manifest identity.

- [ ] **Step 4: Build and sign exact bytes**

Make `build-firmware-update-ticket.mjs` hash PlatformIO `.pio/build/esp32-s3-n16r8/firmware.bin` and the exact 4096-byte raw flash range `[0x8000,0x9000)` from the merged factory image (including padding), reject images larger than `0x640000`, copy the app image to its immutable release path, and write the one-line exact ticket. Extend `sign-release-artifacts.mjs` to sign the ticket bytes separately with the same protected production P-256 key.

- [ ] **Step 5: Run GREEN**

Run: `node --test packages/installer-core/test/windowless-firmware-release.test.js scripts/firmware-update-release.test.mjs lightweaver/src/lib/firmwareRelease.test.js`

Expected: all update schema, signature, identity, and tamper tests pass.

### Task 2: Firmware verifier and preserving A/B transfer state machine

**Files:**
- Create: `firmware/lightweaver-controller/src/LightweaverFirmwareUpdate.h`
- Create: `firmware/lightweaver-controller/src/LightweaverFirmwareUpdate.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverRuntimeApi.h`
- Test: `firmware/lightweaver-controller/tests/firmware-update-ticket.mjs`
- Test: `firmware/lightweaver-controller/tests/firmware-update-state.mjs`
- Test: `firmware/lightweaver-controller/tests/firmware-update-web-contract.mjs`

- [ ] **Step 1: Write failing verifier/state/web contracts**

Tests must prove wrong signature, target, layout, size, digest, schema/API range, downgrade, active-slot request, stale owner binding, changed head, wrong sequence/offset, timeout, concurrent mutation, and oversized chunk all fail before boot selection changes.

```cpp
assert(update.begin(validLease) == UpdateResult::Accepted);
assert(update.acceptChunk(validLease, 0, 0, bytes, size) == UpdateResult::Accepted);
assert(update.acceptChunk(validLease, 2, size, bytes, size) == UpdateResult::SequenceMismatch);
assert(update.activeSlotUnchanged());
```

- [ ] **Step 2: Run RED**

Run: `node firmware/lightweaver-controller/tests/firmware-update-ticket.mjs && node firmware/lightweaver-controller/tests/firmware-update-state.mjs && node firmware/lightweaver-controller/tests/firmware-update-web-contract.mjs`

Expected: FAIL because updater modules/endpoints are absent.

- [ ] **Step 3: Implement ticket verification as a deep module**

`LightweaverFirmwareUpdate` must own:

```cpp
struct FirmwareUpdateBinding {
  LightweaverOwnerBinding owner;
  String releaseBuildId;
  String ticketSha256;
};

struct FirmwareUpdateStatus {
  UpdatePhase phase;
  size_t receivedBytes;
  size_t expectedBytes;
  String expectedBuildId;
  String activeSlot;
  String pendingSlot;
  String lastError;
  String rollbackReason;
};
```

Parse exact ticket bytes with bounded ArduinoJson capacity; SHA-256 the raw ticket; verify the 64-byte IEEE-P1363 signature against the pinned production public key using mbedTLS; validate target, build identity, partition digest/constants, capacity, compatibility, and `dataPartitionsIncluded == false`.

- [ ] **Step 4: Implement inactive-slot lifecycle**

Use ESP-IDF OTA APIs (`esp_ota_get_next_update_partition`, `esp_ota_begin`, `esp_ota_write`, `esp_ota_end`, `esp_ota_set_boot_partition`) only after preflight. Bind the lease to owner/card/boot/session/generation/project head/release/ticket. Begin calls canonical `runtimeCancelStream`, acknowledges safe blackout, and refuses concurrent mutations. Chunk writes exact bounded bytes. Commit verifies received size, final SHA-256, ESP image header, embedded build identity, then selects only the inactive partition and schedules reboot. Cancel/timeout calls `esp_ota_abort` and restores normal authority.

- [ ] **Step 5: Register bounded endpoints and status capability**

Use the existing raw-body handler pattern; never buffer the whole image. Add `firmwareUpdate: {version: 1, network: true}` plus current update/rollback evidence to `/api/status` and `/api/firmware-info`. CORS must allow only existing exact origins and required owner headers.

- [ ] **Step 6: Run GREEN and compile**

Run the three contract commands, then:

`cd firmware/lightweaver-controller && pio run -e esp32-s3-n16r8`

Expected: all contracts pass and PlatformIO links within flash/RAM limits.

### Task 3: Boot probation, health confirmation, and rollback evidence

**Files:**
- Create: `firmware/lightweaver-controller/src/LightweaverFirmwareBootHealth.h`
- Create: `firmware/lightweaver-controller/src/LightweaverFirmwareBootHealth.cpp`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Test: `firmware/lightweaver-controller/tests/firmware-boot-health.cpp`
- Test: `firmware/lightweaver-controller/tests/firmware-boot-health.mjs`

- [ ] **Step 1: Write failing boot-health tests**

Cover pending-image detection, compiled identity mismatch, storage mount failure, unreadable saved config/project head, renderer/control/web/watchdog/output failure, offline router success, deadline expiry, reset during probation, successful mark-valid, and persisted rollback reason.

```cpp
assert(evaluateBootHealth(healthyOfflineFixture).decision == BootDecision::MarkValid);
assert(evaluateBootHealth(routerRequiredFixture).decision == BootDecision::MarkValid);
assert(evaluateBootHealth(storageFailureFixture).decision == BootDecision::Rollback);
```

- [ ] **Step 2: Run RED**

Run: `node firmware/lightweaver-controller/tests/firmware-boot-health.mjs`

Expected: FAIL because the health policy module does not exist.

- [ ] **Step 3: Implement deterministic health policy and ESP-IDF adapter**

Keep the pure decision policy separate from ESP calls. On a pending image, gather only local readiness facts. If healthy, call `esp_ota_mark_app_valid_cancel_rollback()` after all local subsystems initialize. If unhealthy or expired, persist a redacted reason and call `esp_ota_mark_app_invalid_rollback_and_reboot()`. Never require internet, station Wi-Fi, mDNS, or a browser. Do not perform irreversible data migration before mark-valid.

- [ ] **Step 4: Run GREEN and compile**

Run the boot-health contract and full PlatformIO build. Expected: policy passes and rollback-enabled binary links.

### Task 4: Studio update release client and Wi-Fi updater

**Files:**
- Create: `lightweaver/src/lib/firmwareUpdateRelease.js`
- Create: `lightweaver/src/lib/firmwareUpdateRelease.test.js`
- Create: `lightweaver/src/lib/cardFirmwareUpdater.js`
- Create: `lightweaver/src/lib/cardFirmwareUpdater.test.js`
- Modify: `lightweaver/src/lib/cardTransport.js`
- Test: `lightweaver/src/lib/cardTransport.test.js`

- [ ] **Step 1: Write failing client/transport tests**

Prove Studio verifies manifest signature, update descriptors, exact ticket bytes/signature, app bytes/digest, and identity chain before preflight. Prove updater sends exact owner bindings, release/ticket bindings, monotonic 32 KiB chunks, follows acknowledged status, resumes after reload, cancels on authority change, and requires same Card ID + changed Boot ID + target build + unchanged project head before success.

- [ ] **Step 2: Run RED**

Run: `cd lightweaver && node --test src/lib/firmwareUpdateRelease.test.js src/lib/cardFirmwareUpdater.test.js src/lib/cardTransport.test.js`

Expected: FAIL because the release/update clients are missing.

- [ ] **Step 3: Implement verified release loading**

Return a short-lived in-memory object only:

```js
{
  manifest,
  ticket,
  ticketBytes,
  ticketSha256,
  ticketSignature,
  imageBytes,
}
```

Reject redirects/cross-origin URLs, cache all mutable descriptors with `no-store`, verify immutable byte size/SHA-256, and never persist firmware bytes or authority credentials.

- [ ] **Step 4: Implement acknowledged updater controller**

Expose `preflight()`, `begin()`, `send()`, `commit()`, `cancel()`, `readStatus()`, and `reconnect()`. Every method consumes the existing exact-card authority object and fails closed on card/boot/head/generation/origin/network changes. Persist only redacted correlation (`cardId`, release build, ticket digest, phase), never image/ticket raw bytes or capabilities.

- [ ] **Step 5: Run GREEN**

Run the focused Node tests. Expected: all signature, binding, progress, retry, cancel, and reconnection scenarios pass.

### Task 5: One-time non-erasing USB bootstrap

**Files:**
- Create: `lightweaver/src/lib/preservingUsbBootstrap.js`
- Create: `lightweaver/src/lib/preservingUsbBootstrap.test.js`
- Modify: `lightweaver/src/lib/flashPlan.js`
- Modify: `lightweaver/src/lib/flashWorkflow.js`
- Modify: `lightweaver/src/lib/usbFirmwareIdentity.js`
- Test: `packages/installer-core/test/installer-core.test.js`
- Test: `lightweaver/src/lib/usbFirmwareIdentity.test.js`

- [ ] **Step 1: Write failing range/eligibility/readback tests**

Use real supported v1.1.1 and current signed image fixtures. Prove exact eFuse Card ID, S3/16MB, direct installed identity, exact partition-table SHA-256, app0 source, compatibility, and image fit are all mandatory. Assert the only write is `[0x10000, 0x10000 + image.size)`, `eraseAll:false`; assert no overlap with partition table, NVS, OTA data, app1, SPIFFS/project storage, or any other partition. Reject unknown/partial facts before calling write.

- [ ] **Step 2: Run RED**

Run: `cd lightweaver && node --test src/lib/preservingUsbBootstrap.test.js src/lib/usbFirmwareIdentity.test.js ../packages/installer-core/test/installer-core.test.js`

Expected: FAIL because preserving bootstrap planning/execution is absent.

- [ ] **Step 3: Implement fail-closed bootstrap plan**

```js
export const PRESERVING_BOOTSTRAP_RANGE = Object.freeze({ start: 0x10000, end: 0x650000 });
export function planPreservingBootstrap(evidence, release) {
  // validate exact facts; return one immutable write plan or throw before write
  return { address: 0x10000, eraseAll: false, bytes: release.imageBytes };
}
```

Read the committed partition table directly over Web Serial, hash only those bytes, and discard them after validation. Do not read NVS or project partitions.

- [ ] **Step 4: Implement write/readback/reset/reconnect**

Use the existing loader with `eraseAll:false`, verify SHA-256 by reading back exactly the application length, reset into app, release USB, and wait for the same Card ID with target build and preserved project head when it was available before ROM mode. Interruption messaging must say data remains and the same bootstrap can be repeated; it must not claim A/B rollback.

- [ ] **Step 5: Run GREEN**

Run all focused USB/installer tests. Expected: safe range, eligibility, interruption, exact readback, and reconnection pass.

### Task 6: Owner-facing preserving update experience

**Files:**
- Modify: `lightweaver/src/v3/lw-flash.jsx`
- Modify: `lightweaver/src/components/card/CardConnectionCenter.jsx`
- Modify: `lightweaver/src/lib/firmwareUpdatePlan.js`
- Modify: `lightweaver/src/lib/firmwareUpdatePlan.test.js`
- Test: `lightweaver/tests/install-update-plan.spec.ts`
- Test: `lightweaver/tests/card-connection-center.spec.ts`

- [ ] **Step 1: Write failing visible browser tests**

Cover: capable card gets **Update over Wi-Fi** as primary; old supported card gets **Update once over USB**; installed/target versions and builds, exact Card ID, project head, preserved-data list, physical-confirmation instruction, card-acknowledged phases, rollback result, reload resume, wrong-card recovery, and separate destructive factory recovery. Assert routine paths never show SSID/password, file, address, partition, or erase controls.

- [ ] **Step 2: Run RED**

Run: `cd lightweaver && node scripts/lightweaver-dev.mjs focused tests/install-update-plan.spec.ts tests/card-connection-center.spec.ts --grep "preserving update"`

Expected: FAIL because preserving actions/states are not rendered.

- [ ] **Step 3: Implement the bounded state-driven UI**

Render acknowledged phases only:

```text
Preparing card
Sending signed update
Verifying update
Restarting card
Reconnected to Card <id> on firmware <version> · Build <number>
```

Keep ordinary controls disabled until fresh post-reboot authority is established. Show rollback as restored build + redacted reason. Put **Factory reset and reinstall** in a recovery disclosure with explicit destructive copy and existing confirmation; never auto-fallback from preserving failure to erase.

- [ ] **Step 4: Inspect the actual screen and run GREEN**

Run the two focused Playwright files, then inspect capable, old-card, progress, rollback, and failure fixtures at 390px and desktop width. Expected: tests pass, copy is unclipped, and no manual firmware/network choices appear in routine flow.

### Task 7: CI, provenance, staged production, and integrated checkpoint

**Files:**
- Modify: `.github/workflows/build-firmware.yml`
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/deploy-site.yml`
- Modify: `scripts/ci-changed-lanes.mjs`
- Modify: `scripts/ci-changed-lanes.test.mjs`
- Modify: `scripts/verify-firmware-artifact.mjs`
- Modify: `scripts/verify-production-artifacts.mjs`
- Modify: `lightweaver/vite.config.js`
- Modify: `docs/development-workflow.md`
- Modify: `docs/deployment-checklist.md`
- Modify: `LIGHTWEAVER_WORKBOARD.md` (primary agent only)

- [ ] **Step 1: Write failing workflow/artifact tests**

Assert the protected signer exports factory+app+ticket+ticket signature+manifest+manifest signature+provenance; every descriptor byte-matches artifacts; both images embed the same version/build/Card Studio identity; the production build graph contains immutable app/ticket/signature paths; updater/release/UI paths classify firmware-sensitive; production firmware pins only the production public key.

- [ ] **Step 2: Run RED**

Run: `node --test scripts/ci-changed-lanes.test.mjs scripts/firmware-update-release.test.mjs` plus existing firmware artifact tests.

Expected: FAIL because workflows and staged artifacts do not contain the update chain.

- [ ] **Step 3: Extend workflows and provenance**

Build the app image and merged factory image from the same full-history source with identical `LW_BUILD_ID`, `LW_BUILD_NUMBER`, version, Card Studio, toolchain, and partition table. Sign only in the protected signer. Upload and deploy all immutable artifacts. Verify staged Pages output before publication and live build-graph bytes after publication. Preserve factory alias and Bridge.

- [ ] **Step 4: Run focused and integrated verification**

Run:

```bash
cd lightweaver && node scripts/lightweaver-dev.mjs checkpoint
cd firmware/lightweaver-controller && pio run -e esp32-s3-n16r8
node --test scripts/ci-changed-lanes.test.mjs scripts/firmware-update-release.test.mjs
```

Then run the focused Playwright update files and the firmware updater/boot contracts once against the integrated tree.

Expected: unit, browser, firmware, release, production build, and PlatformIO checks all pass.

- [ ] **Step 5: Record honest remaining gates**

Update the workboard with automated evidence and keep these as unpassed Bench gates: real v1.1.1 app-only bootstrap/readback; preservation hashes and saved Wi-Fi/project/settings; interrupted USB writes; A/B transfer/commit/probation power cuts; router loss; actual-light recovery; multi-browser LNA/Bridge behavior. Do not flash, sign, deploy, or claim physical proof during this build-only Sprint.

## Self-review

- Spec coverage: release chain, card verification/A-B/rollback, USB bootstrap, Studio flow, preservation/privacy/security, failure states, legacy recovery, CI/provenance, and real hardware gates each map to a task.
- Interface consistency: ticket keys, partition constants, update binding fields, endpoint names, chunk fields, and status phases are defined once above and reused in every task.
- Scope: no Pi or visitor-UI work; no unattended updates, cloud relay, Wi-Fi credential export, public SSID scanning, arbitrary firmware, or removal of factory/Bridge recovery.
- Placeholders: code comments denote implementation bodies only where the plan immediately specifies every validation and side effect; no requirement is deferred or left undefined.
