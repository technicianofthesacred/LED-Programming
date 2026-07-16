# Lightweaver Production Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a free browser-based workshop flow that installs the official firmware, loads an exact artwork job, proves the card accepted it, verifies the real LEDs, and records a pass before the worker moves to the next artwork.

**Architecture:** A new Production Setup screen composes existing Web Serial flashing, commissioning, runtime compilation, card transport, and wiring safety modules. Immutable content-addressed job packages bind each run to one card and one project revision. Firmware exposes card-owned project/job identity so Studio can independently verify restoration; physical completion remains a human-confirmed, current-limited blue/red test.

**Tech Stack:** React 19, Vite 7, Web Serial, Node 22 tests, Playwright, ESP32-S3/PlatformIO, Cloudflare Pages.

**Approved design:** `docs/superpowers/specs/2026-07-16-lightweaver-production-setup-design.md`

---

### Task 1: Close commissioning truth gaps

**Files:**
- Modify: `lightweaver/src/lib/cardCommissioningFlow.js`
- Modify: `lightweaver/src/lib/cardCommissioningFlow.test.js`
- Modify: `lightweaver/src/lib/bridgeLaunch.js`
- Modify: `lightweaver/src/lib/bridgeProtocol.js`
- Modify: `lightweaver/src/components/card/CardCommissioningPanel.jsx`
- Modify: `lightweaver/src/lib/cardRuntimeProject.js`
- Modify: `lightweaver/src/lib/cardRuntimeContract.js`
- Modify: `lightweaver/tests/card-runtime-contract.mjs`
- Modify: focused Playwright tests

- [ ] Write failing tests proving a same-operation result from flow A cannot advance flow B, including two tabs and two different job fingerprints.
- [ ] Persist a random `flowId` before launch and bind it browser-side to the consumed result; require exact flow, operation, job fingerprint, and expected card before commissioning advances.
- [ ] Write failing tests proving `{ok:true}` or a POST echo cannot mark a project restored and that an exact independent card read-back can.
- [ ] Change restoration to require card-returned card ID, firmware version/build ID, project revision/fingerprint, and job digest. Keep staged wiring bound to its card-issued activation ID.
- [ ] Write failing runtime-package tests using non-default encoder press, alternate press, analog brightness, previous/next/blackout, and status LED pins.
- [ ] Preserve every supported saved control after normalization; reject conflicts with LED output GPIOs before mutation.
- [ ] Run:

```bash
cd lightweaver
node --test src/lib/cardCommissioningFlow.test.js
node tests/card-runtime-contract.mjs
npx playwright test tests/universal-install.spec.ts tests/connection-center-quality.spec.ts --project=chromium --workers=1
```

- [ ] Commit: `fix: bind card restoration to exact acknowledged state`

### Task 2: Persist and expose card-owned project identity

**Files:**
- Modify: `firmware/lightweaver-controller/src/LightweaverTypes.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Modify: `lightweaver/src/lib/cardRuntimeContract.js`
- Modify: `lightweaver/src/lib/cardPushClient.js`
- Modify: `lightweaver/src/lib/cardIdentity.js`
- Create: `firmware/lightweaver-controller/tests/project-identity-contract.mjs`
- Modify: firmware storage/API tests

- [ ] Write failing firmware contract tests for bounded `projectRevision`, `projectFingerprint`, `productionJobId`, and `productionJobDigest` persistence and `/api/firmware-info` read-back.
- [ ] Add strict length/character validation and include the fields in the compact stored configuration without exposing credentials or exceeding the 3968-byte limit.
- [ ] Persist identity only after the full runtime package is accepted; rejected or partial saves retain the previous acknowledged identity.
- [ ] Read identity independently after reconnect/reboot. Do not use the POST response as proof.
- [ ] Run:

```bash
node firmware/lightweaver-controller/tests/project-identity-contract.mjs
cd firmware/lightweaver-controller && pio run -e esp32-s3-n16r8
cd ../../lightweaver && node tests/card-runtime-contract.mjs
```

- [ ] Commit: `feat: acknowledge installed artwork revisions on card`

### Task 3: Add immutable production jobs and run state

**Files:**
- Create: `release/production-job.schema.json`
- Create: `scripts/build-production-job.mjs`
- Create: `lightweaver/src/lib/productionJobPackage.js`
- Create: `lightweaver/src/lib/productionJobPackage.test.js`
- Create: `lightweaver/src/lib/productionRun.js`
- Create: `lightweaver/src/lib/productionRun.test.js`
- Create: `lightweaver/public/production/jobs/index.json`

- [ ] Write failing tests for schema/version, 256 KiB maximum size, SHA-256 content address, exact firmware target, exact project revision/fingerprint, control/output completeness, config-capacity preflight, and GPIO conflicts.
- [ ] Reject mutable Studio projects, digest mismatches, unknown fields, external unsigned packages, stale firmware floors, oversized card payloads, and conflicting pins before USB acquisition.
- [ ] Model the run states `select-job`, `connect-card`, `inspect`, `install`, `reconnect`, `restore`, `verify-card`, `check-lights`, `record`, `complete`, and `recovery` with `{runId, flowId, jobDigest, expectedCardId}` correlation.
- [ ] Persist resumable non-secret run state across refresh/network switching; never persist Wi-Fi credentials, serial paths/numbers, firmware bytes, or arbitrary raw errors.
- [ ] Run:

```bash
cd lightweaver
node --test src/lib/productionJobPackage.test.js src/lib/productionRun.test.js
```

- [ ] Commit: `feat: define immutable Lightweaver production jobs`

### Task 4: Build the worker Production Setup screen

**Files:**
- Create: `lightweaver/src/v3/lw-production.jsx`
- Create: `lightweaver/src/components/production/ProductionJobPicker.jsx`
- Create: `lightweaver/src/components/production/ProductionPassRecord.jsx`
- Create: `lightweaver/src/lib/productionRecords.js`
- Create: `lightweaver/src/lib/productionRecords.test.js`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/lib/platformCapabilities.js`
- Modify: `lightweaver/src/v3/v3-styles.css`
- Create: `lightweaver/tests/production-setup.spec.ts`

- [ ] Write failing Playwright tests for the complete worker flow, unsupported-browser handoff, interrupted reconnect, wrong card, no duplicate restore, retained pass record, and Next-artwork state reset.
- [ ] Route `#screen=production` from the root Studio and expose one **Production setup** staff entry. Never add it to the card visitor UI.
- [ ] Require secure top-level desktop Chrome/Edge Web Serial. Never launch the native Bridge from production mode.
- [ ] Preload the verified job and firmware before a Wi-Fi/AP handoff; provide job-code and verified file selection when QR camera access is unavailable.
- [ ] Store bounded pass records locally with primary/backup copies and JSON/CSV export. Clearly state that unexported records are local to this browser.
- [ ] Make **Next artwork** retain completed records but clear selected job, USB/card identity, commissioning state, and physical-test state.
- [ ] Verify keyboard operation, focus restoration, live announcements, 200% zoom/reflow, reduced motion, and mobile computer-handoff copy.
- [ ] Run:

```bash
cd lightweaver
node --test src/lib/productionRecords.test.js
npx playwright test tests/production-setup.spec.ts --project=chromium --workers=1
npm run build
```

- [ ] Commit: `feat: add browser production setup for workshop cards`

### Task 5: Add bounded physical output diagnosis

**Files:**
- Create: `lightweaver/src/lib/productionPhysicalTest.js`
- Create: `lightweaver/src/lib/productionPhysicalTest.test.js`
- Create: `lightweaver/src/components/production/ProductionPhysicalTest.jsx`
- Modify: `lightweaver/src/v3/lw-production.jsx`
- Reuse/modify: `lightweaver/src/lib/wiringChase.js`
- Reuse/modify: `lightweaver/src/lib/cardFrameStream.js`
- Reuse/modify: `lightweaver/src/lib/cardWiringSafety.js`
- Modify: firmware endpoint contract tests
- Modify: `lightweaver/tests/production-setup.spec.ts`

- [ ] Write failing tests proving only one output/boundary activates, the first included pixel is blue, final included pixel red, intermediate pixels are dim/current-limited, and everything outside the boundary is dark.
- [ ] Add acknowledged candidate transactions for pixel count ±, direction, GPIO/output, and color order with a 90-second automatic rollback and reboot-safe last-confirmed wiring.
- [ ] Classify `nothing-lit`, `wrong-color`, `wrong-start-end`, `wrong-count`, `wrong-output`, `flashing-or-frozen`, and `correct`; route to power/data, GPIO, direction, count, color order, stream release/restart, project restore, or signed firmware recovery from evidence.
- [ ] Require explicit worker physical confirmation for every output. A transport acknowledgement can never produce a pass record.
- [ ] Run:

```bash
cd lightweaver
node --test src/lib/productionPhysicalTest.test.js
npx playwright test tests/production-setup.spec.ts --project=chromium --workers=1
```

- [ ] Commit: `feat: verify workshop LED output safely`

### Task 6: Add production recovery, documentation, and free release gate

**Files:**
- Create: `lightweaver/src/lib/productionRecovery.js`
- Create: `lightweaver/src/lib/productionRecovery.test.js`
- Create: `lightweaver/src/components/production/ProductionRecovery.jsx`
- Create: `docs/worker-flash-runbook.md`
- Modify: `docs/deployment-checklist.md`
- Modify: `docs/roadmap.md`
- Modify: `.github/workflows/deploy-site.yml`
- Modify: production smoke tests

- [ ] Write failing tests for charge-only cable, port busy, Linux permissions, missing driver, multiple cards, unsupported card, disconnect phase, signed-release failure, USB ownership uncertainty, wrong-card reconnect, restore failure, and physical failure.
- [ ] For every failure show what happened, whether the card changed, whether USB is released, one safest action, and a stable support code. Reflash only when firmware evidence warrants it.
- [ ] Add a redacted diagnostic export containing app/version, OS/arch, support code, phase, firmware target, and VID/PID only.
- [ ] Document the worker’s exact no-code sequence, test fixture, data-cable check, job selection, light observations, record export, and escalation path.
- [ ] Run the full web/firmware gate:

```bash
cd lightweaver
npm run launch:check
npm run firmware:check-bin
cd ../firmware/lightweaver-controller
pio run -e esp32-s3-n16r8
```

- [ ] Deploy the root Studio with the existing Cloudflare workflow and verify `https://led.mandalacodes.com/#screen=production` plus immutable job/firmware assets.
- [ ] On a real card and strip, verify install/update, exact identity read-back, every output boundary, rollback, reboot, recovery, pass export, and Next-artwork cycle. Record physical evidence separately from automated acknowledgements.
- [ ] Commit: `docs: record production setup launch acceptance`

---

## Deferred without blocking the free launch

- Native Bridge public packaging, Apple notarization, and Windows Authenticode.
- OTA firmware updates.
- Centralized/cloud production-record storage.
- Phone-based USB flashing.

## Self-review gate

- [ ] Every destructive transition has a failing test first and exact card/job/run correlation.
- [ ] No UI copy labels a browser-saved project or POST response as installed-on-card proof.
- [ ] Production mode never launches the native Bridge or accepts arbitrary firmware.
- [ ] No full-white multi-output test exists.
- [ ] No credentials, serial paths/numbers, nonces, project payloads, or firmware bytes enter logs/diagnostics.
- [ ] `rg -n "[T]BD|[T]ODO|[F]IXME|later[[:space:]]+decide|some[[:space:]]+test|as[[:space:]]+needed" docs/superpowers/plans/2026-07-16-lightweaver-production-setup.md` returns no matches.
