# Lightweaver End-to-End Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `test-driven-development` for every behavior change. Independent workstreams
> may run concurrently only when their exact file ownership does not overlap.

**Goal:** Make the active ESP32-S3 Lightweaver path coherent, safe, and
verifiable from mapper design through offline card playback.

**Architecture:** One canonical deployment coordinator owns package creation,
candidate activation, read-back, and installed-state updates. A shared hardware
manifest prevents Studio and firmware drift. Mapper, transport, firmware, and
documentation are repaired as independent workstreams and integrated behind
contract tests.

**Tech Stack:** React, Vite, Node test runner, Playwright, ESP32-S3 C++,
PlatformIO, ArduinoJson, FastLED.

---

## Cost-aware agent topology

Luna is not available in this Codex workspace. Use these available roles:

| Workstream | Model | Reasoning | Ownership |
|---|---|---:|---|
| Shared contract foundation | `gpt-5.6-terra` | high | Shared manifest, parity generator/tests only |
| Studio deployment and UX | `gpt-5.6-terra` | xhigh | Assigned Studio deployment components and their tests |
| Mapper interoperability | `gpt-5.6-terra` | high | Mapper source/tests plus explicit Studio mapper-import files |
| Firmware/runtime | `gpt-5.6-terra` | xhigh | Firmware source and native/static firmware tests |
| Browser transport | `gpt-5.6-terra` | high | Bridge, frame-stream, connection files and focused tests |
| Documentation/release integration | primary agent | high | Docs, scripts, launch gate, integration tests |
| Final review | `gpt-5.6-sol` | high | Read-only spec and code-quality review |

The foundation task runs first. Studio, mapper, and firmware then fan out.
Browser transport begins when a slot opens. Documentation and release
integration run concurrently in the primary agent.

Agents must not commit from the shared workspace. The primary agent reviews,
tests, and creates coherent commits after integration.

## Workstream 0: Shared hardware contract foundation

**Files:**

- Create: `packages/lightweaver-contract/card-hardware.json`
- Create: `lightweaver/src/lib/cardHardwareContract.js`
- Create: `firmware/lightweaver-controller/src/LightweaverHardwareContract.h`
- Create: `lightweaver/scripts/generate-card-hardware-contract.mjs`
- Create: `lightweaver/src/lib/cardHardwareContract.test.js`
- Modify: `lightweaver/package.json`

- [ ] **Step 1: Write the failing parity test**

The test imports the JSON manifest and Studio adapter, parses the generated C++
header, and asserts identical output-pin, output-count, pixel, zone, and config
capacity limits.

- [ ] **Step 2: Verify the test fails**

Run:

```bash
node --test lightweaver/src/lib/cardHardwareContract.test.js
```

Expected: failure because the shared manifest and consumers do not exist.

- [ ] **Step 3: Add the manifest and deterministic generator**

The manifest contains only values currently enforced by production firmware.
The generator must refuse malformed, duplicate, or unsafe pins and write a
stable header.

- [ ] **Step 4: Replace hard-coded Studio constants**

`cardRuntimeContract.js` and pin-selection consumers import the Studio adapter.
Firmware policy includes the generated header.

- [ ] **Step 5: Verify focused parity**

Run:

```bash
node --test lightweaver/src/lib/cardHardwareContract.test.js \
  lightweaver/src/lib/cardRuntimeContract.test.js
pio test -d firmware/lightweaver-controller -e native
```

Expected: all tests pass.

## Workstream 1: Canonical deployment coordinator and commissioning UX

**Agent:** Terra xhigh

**Files:**

- Create: `lightweaver/src/lib/cardDeployment.js`
- Create: `lightweaver/src/lib/cardDeployment.test.js`
- Modify: `lightweaver/src/lib/cardRuntimeProject.js`
- Modify: `lightweaver/src/components/layout/shared/CardPushControl.jsx`
- Modify: `lightweaver/src/components/layout/modes/WireModePanel.jsx`
- Modify: `lightweaver/src/v3/lw-pattern.jsx`
- Modify: `lightweaver/src/v3/lw-playlist.jsx`
- Modify: `lightweaver/src/v3/lw-settings.jsx`
- Modify: `lightweaver/src/state/ProjectContext.jsx`
- Modify: focused Playwright specifications for the same surfaces

- [ ] **Step 1: Add failing package-equivalence tests**

Build one project with reversed split segments, a custom playlist, startup look,
power limit, gamma, and calibration. Assert that every install entry point
produces the same canonical config and fingerprint.

- [ ] **Step 2: Add failing state-machine tests**

Cover short visual updates, hardware-change candidates, explicit activation,
rollback, read-back mismatch, stale response, card identity change, and dropped
connection.

- [ ] **Step 3: Verify the red state**

Run:

```bash
node --test lightweaver/src/lib/cardDeployment.test.js \
  lightweaver/src/lib/cardRuntimeProject.test.js
npx playwright test lightweaver/tests/layout-send-to-card.spec.ts \
  lightweaver/tests/patterns-v3.spec.ts \
  lightweaver/tests/playlist-storage.spec.ts \
  --project=chromium --workers=1
```

Expected: failures demonstrate package drift and false installed states.

- [ ] **Step 4: Implement one deployment coordinator**

Expose:

```js
prepareCardDeployment(project, cardEvidence)
classifyCardChanges(previousConfig, nextConfig)
runCardDeployment(prepared, transport, callbacks)
verifyCardDeployment(prepared, readBack)
```

Only `verifyCardDeployment` may advance installed state.

- [ ] **Step 5: Converge install entry points**

Test & Install owns the complete flow. Contextual buttons open it as
**Update card**. Remove local package construction and local installed-state
mutation from the four screens.

- [ ] **Step 6: Implement the approved interaction states**

Use **Ready to install**, **Sending**, **Test lights**, **Verifying card**, and
**Installed**. Add the four-part change review, persistent **Stop lights**, safe
brightness, photosensitivity warning, preserved-setup reassurance, plain
recovery actions, accessible announcements, and the verified success ending.

- [ ] **Step 7: Verify focused behavior**

Run the commands from Step 3. Expected: all pass with exact package equality and
no false success.

## Workstream 2: Mapper interoperability and address safety

**Agent:** Terra high

**Files:**

- Modify: `led-art-mapper/app/src/main.js`
- Modify: `led-art-mapper/app/src/export.js`
- Modify: `led-art-mapper/app/src/mapper.js`
- Add or modify: `led-art-mapper/app/test/*.test.js`
- Create: `lightweaver/src/lib/mapperProjectImport.js`
- Create: `lightweaver/src/lib/mapperProjectImport.test.js`
- Modify: `lightweaver/src/lib/projectFiles.js`
- Modify: `lightweaver/src/components/layout/hooks/useLayoutImport.js`
- Modify: mapper and Studio import Playwright specifications

- [ ] **Step 1: Add failing mapper-format and conversion tests**

Assert a distinctive mapper kind/version, explicit conversion of strip order,
pixel counts, reverse flags, geometry, and artwork, and rejection without
mutating the current Studio project.

- [ ] **Step 2: Add failing live-address tests**

Hide the first, middle, and final strips. Assert physical frame length remains
constant, hidden ranges are black, later ranges retain their addresses, and the
last hidden range is cleared.

- [ ] **Step 3: Add failing coordinate/export tests**

Assert preview, coordinate JSON, and FastLED use one contain transform. Assert
stock WLED export uses a flat index map with `-1` gaps and a bounded logical
grid.

- [ ] **Step 4: Verify red**

Run:

```bash
node --test led-art-mapper/app/test/*.test.js \
  lightweaver/src/lib/mapperProjectImport.test.js
```

Expected: failures reproduce silent default import, index shifting, coordinate
stretching, and oversized WLED grids.

- [ ] **Step 5: Implement format identity, safe conversion, and previews**

Conversion must complete before project replacement. Import defaults to a new
project and reports artwork, strip count, and LED count.

- [ ] **Step 6: Implement stable addressing and shared coordinates**

Keep hidden physical ranges, emit black for them, and reuse one normalized
coordinate function across all spatial consumers.

- [ ] **Step 7: Verify mapper and Studio handoff**

Run focused Node and Playwright tests plus both production builds.

## Workstream 3: Firmware runtime, microSD, reset, power, and compatibility

**Agent:** Terra xhigh

**Files:**

- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverProvisioningPolicy.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverTypes.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverWledJsonApi.cpp`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Modify: firmware native and static contract tests
- Modify: `lightweaver/scripts/unpack-standalone-package.mjs`
- Modify: focused package-integrity tests

- [ ] **Step 1: Add failing native policy tests**

Cover SD exact-identity acceptance, SD/NVS/factory precedence, sequence
availability after NVS selection, reset without SD, shared pins, and
collision-resistant hostnames.

- [ ] **Step 2: Add failing integrity and JSON tests**

Cover sequence byte-length/hash mismatch, quoted and escaped look labels,
oversized WLED state requests, and unsupported segment operations.

- [ ] **Step 3: Verify red**

Run:

```bash
pio test -d firmware/lightweaver-controller -e native
pio test -d firmware/lightweaver-controller -e native-output-color-parser
node --test lightweaver/src/lib/patternLabHandoff.test.js
```

- [ ] **Step 4: Implement deterministic mounted storage**

Mount once before configuration selection. Accept valid exact-identity SD
projects as command-ready, otherwise use known-good NVS, otherwise factory
recovery. Keep sequence media available after selection.

- [ ] **Step 5: Make reset independent of SD**

Clear internal configuration first. Report optional SD cleanup separately.

- [ ] **Step 6: Align power, hostname, and compatibility behavior**

Use the shared pin contract, enforce the exported current limit, suffix default
hostnames, escape JSON, bound requests, and reject unsupported per-segment
operations.

- [ ] **Step 7: Verify firmware**

Run both native suites and:

```bash
pio run -d firmware/lightweaver-controller
```

Expected: all tests and the ESP32-S3 build pass.

## Workstream 4: Browser transport and recovery

**Agent:** Terra high

**Files:**

- Modify: `lightweaver/src/lib/cardFrameStream.js`
- Modify: `lightweaver/src/lib/cardBridge.js`
- Modify: `lightweaver/src/lib/cardConnection.js`
- Modify: the firmware card-page bridge response shape if required
- Modify: focused transport and Connection Center tests

- [ ] **Step 1: Add failing delivery-result tests**

Assert delivered, dropped, and failed results remain distinct through direct and
card-page transports. Dropped frames must not count as delivered.

- [ ] **Step 2: Add failing recovery tests**

Cover typed bridge errors, one tracked window, delayed verified acquisition,
manual address disclosure only after discovery fails, and captive-host
normalization.

- [ ] **Step 3: Verify red**

Run the focused bridge, frame-stream, connection, and browser recovery suites.

- [ ] **Step 4: Implement typed results and one-window recovery**

Preserve error reasons end to end. Replace `_blank` recovery actions with the
named managed card window.

- [ ] **Step 5: Implement tolerant acquisition**

Use event-driven verified readiness with a bounded overall recovery state, not a
fixed 2.5-second false timeout. Reveal manual local address only when automatic
paths exhaust safely.

- [ ] **Step 6: Verify focused transport and browser behavior**

Run the commands from Step 3 and confirm no stale or wrong-card mutation.

## Workstream 5: Documentation, launch gate, and polish

**Owner:** Primary agent

**Files:**

- Modify: `docs/hardware-setup.md`
- Modify: `docs/lightweaver-customer-runtime.md`
- Modify: `docs/deployment-checklist.md`
- Modify: firmware and mapper README/guide files
- Create or update: deferred WLED documentation
- Modify: `lightweaver/package.json` scripts only
- Modify: launch scripts and tests
- Modify: relevant Studio CSS for approved interaction polish

- [ ] **Step 1: Rewrite the current hardware path**

The primary guide installs the signed Lightweaver factory firmware and follows
the card commissioning flow. Historical WLED installation is clearly deferred.

- [ ] **Step 2: Align runtime and hardware facts**

Document microSD precedence, output/control pins, power limits, reset behavior,
and the physical acceptance boundary.

- [ ] **Step 3: Expand launch coverage**

Add mapper contract tests, shared hardware parity, exact installation package
equality, and firmware native tests to the relevant launch source gate.

- [ ] **Step 4: Apply focused visual polish**

Remove the relevant decorative side-stripe treatments and width-based layout
animations detected in active Studio surfaces. Do not redesign the separate
visitor UI in this scope.

- [ ] **Step 5: Run focused review**

Check every requirement in the approved design against an implementation task
and test. Reject placeholders, silent fallback, and unverified success copy.

## Integration and final verification

- [ ] **Step 1: Inspect every agent diff**

Confirm no files outside assigned ownership changed and no user work was
overwritten.

- [ ] **Step 2: Run focused suites for each workstream**

Every test added through TDD must have observed red and green evidence in its
workstream report.

- [ ] **Step 3: Run complete software gates**

```bash
node --test led-art-mapper/app/test/*.test.js
npm run build --prefix led-art-mapper/app
npm run launch:check --prefix lightweaver
pio test -d firmware/lightweaver-controller -e native
pio test -d firmware/lightweaver-controller -e native-output-color-parser
pio run -d firmware/lightweaver-controller
PROD_CHECK_REQUIRED=1 npm run check:prod --prefix lightweaver
```

- [ ] **Step 4: Run frontier-model final review**

A fresh `gpt-5.6-sol` reviewer compares the complete diff with the approved
design and reports critical, important, and minor issues. Critical and important
issues are fixed and re-reviewed.

- [ ] **Step 5: Record the physical boundary honestly**

Software completion does not close AP join, visible-strip, power-cycle,
microSD-playback, or Wi-Fi recovery checks without the real card.

