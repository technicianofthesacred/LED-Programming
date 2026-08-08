# Lightweaver Reliable Chip Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `test-driven-development` for every behavior change and
> `subagent-driven-development` for the independent firmware, Studio, and
> release workstreams. Track every step with its checkbox; a green software
> gate never substitutes for the hardware acceptance in Phase 4.

**Goal:** Make the ESP32-S3 card return to trustworthy offline playback after
power loss, late router startup, network loss, and an interrupted configuration
save, then harden Studio recovery without adding a Pi, OTA, or cloud command
path.

**Architecture:** The card remains the runtime and the card-hosted visitor page
remains the dependable local control surface. Phase 1 closes two firmware
liveness defects and proves the exact signed build on hardware. Phase 2 ports
only the still-useful authority and recovery ideas from the obsolete
`2462ca4` branch into current `main`; it does not merge that branch wholesale.

**Tech Stack:** ESP32-S3, Arduino/FastLED, PlatformIO, C++ native policy tests,
Node test runner, React, Vite, Playwright, GitHub Actions, signed USB firmware,
Cloudflare Pages.

---

## Read this first

This is the accessible source of truth for finishing connection reliability.
It was written against `origin/main` revision `177e9de` on 2026-08-08. At
execution time, rebase the facts against the then-current `origin/main` before
editing.

The earlier branch `codex/connection-reliability-audit` contains commit
`2462ca4`. It is useful evidence, but it is not integrated, is seventy commits
behind the baseline used here, and overlaps later firmware and guided-setup
work. Selectively reimplement its still-relevant behavior through current tests.
Never cherry-pick or merge it wholesale.

### Already complete on current `main`

- Proven Wi-Fi credentials persist and a successful resumed association skips
  the commissioning acknowledgment.
- Radio-only transitions no longer block local patterns, brightness, scenes,
  WLED HTTP/WS/UDP control, or the firmware-served visitor page.
- Strict `commandReady` still gates configuration-class work.
- Station loss retries every ten seconds, opens a recovery AP at sixty seconds,
  preserves the installed project, and retires the AP after station recovery.
- Studio has exact card/build/boot correlation, handoff-specific two-envelope
  validation, background-tab-aware keepalive, one named card window, subnet
  discovery in guided Setup, and fail-closed wrong-card handling.
- The current Studio and signed firmware release have passed protected build,
  deploy, and live freshness gates. The exact current card has not passed the
  complete power-cycle/outage acceptance.

### Confirmed remaining failures

1. A proven card that boots before its router times out from `Joining` to
   `SetupAp`, then stops station attempts because resumed joins use generation
   zero. Restoring the router does not automatically restore the LAN path.
2. A successful ordinary `/api/config` clears the strip and sets
   `restartTransitionPending`, but firmware waits forever for browser JavaScript
   to call `/api/reboot`. Closing the tab or losing the network in that gap
   leaves the card dark until manually power-cycled.
3. Art-Net frames do not share the playback-readiness admission applied to the
   other realtime protocols.
4. Ordinary initial Studio/card authority can still be established from one
   status envelope; the stronger two-fresh-envelope rule is limited to handoff
   and reconnect paths.
5. Connection Center can tell a previously commissioned card to join a setup AP
   merely because its stable name stopped answering. It needs a truthful LAN /
   router-address recovery action before AP instructions.
6. The exact signed build has no recorded ten-power-cycle, late-router-start,
   router-outage, interrupted-save, and local-control acceptance.

## Non-negotiable constraints

- Runtime: ESP32-S3 card only. Public Studio is never required for playback.
- Command path: local LAN/AP only; no cloud relay.
- Firmware delivery: signed USB release; no OTA assumption.
- Identity: exact card ID, firmware build, boot, origin, and current bridge
  lifecycle remain required.
- Authority: two fresh matching-boot envelopes are required before ordinary
  privileged bridge authority after Phase 2.
- Mutation safety: configuration, Wi-Fi, and wiring mutations stay fail-closed;
  exact blank-card installation and wiring confirm/rollback remain possible.
- Playback safety: radio and listener transitions may not block an already
  known-good local project; wiring probation, restart, corrupt config, safe
  mode, and output failure still block it.
- Operator language: a card is not shipped until the exact merged, signed, and
  deployed revision passes the real-card matrix.

## Agent topology and file ownership

| Role | Owns | Completion criterion |
| --- | --- | --- |
| Primary integrator | Fresh integration branch, dispatch, diff review, final gates, PR sequencing | Every workstream is based on current main, no overlapping edits, all critical/important review findings closed |
| Firmware agent | `firmware/lightweaver-controller/src/` and its focused tests | Late-router resume, autonomous config reboot, and Art-Net gate are red/green tested and compile for ESP32-S3 |
| Studio agent | `lightweaver/src/` and focused Node/Playwright tests | Ordinary authority needs two envelopes and commissioned-card failures end with a LAN/router action rather than invented AP instructions |
| CI/docs agent | `docs/`, root `TODO.md`, test scripts/workflows if coverage is absent | New contracts run in the relevant source gate and hardware evidence fields are current |
| Reviewer agent | Read-only integrated diff | No critical or important issue remains in timer wraparound, identity, authority, mutation admission, or recovery truth |
| Adrian, hardware operator | Router, card, strip, visual observations | Every Phase 4 observation is recorded against exact card and build numbers |

Use one worktree per implementation workstream. Firmware and Studio agents may
run concurrently because their owned source trees do not overlap. The CI/docs
agent starts after both test file lists are known. The primary integrator does
not edit an agent-owned source file while that agent is active.

---

## Phase 0: Revalidate the baseline

### Task 0: Establish current-main truth

**Owner:** Primary integrator

**Files:** Read-only inspection

- [ ] **Step 1: Start from a fresh Codex-managed isolated worktree**

Create a new Codex task from `origin/main`, give its isolated worktree the branch
`codex/reliable-chip-integration`, then verify the base before editing:

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git status --short
```

Expected: both commands exit cleanly and `git status --short` prints nothing.
Preserve `codex/connection-reliability-audit` unchanged for reference.

- [ ] **Step 2: Re-run the focused baseline contracts**

```bash
cd lightweaver
node tests/card-link-state.mjs
node tests/card-bridge-handoff.mjs
node tests/card-connection-mode.mjs
cd ../firmware/lightweaver-controller
node tests/connectivity-policy.mjs
node tests/connectivity-orchestration.mjs
node tests/wifi-handoff-contract.mjs
node tests/config-requires-reboot-response.mjs
node tests/bridge-config-reboot-ordering.mjs
```

Expected: all pass before behavior changes. Record pre-existing failures rather
than weakening assertions.

- [ ] **Step 3: Reconfirm the two liveness defects in source**

Confirm that resumed `SetupAp` retry still depends on a non-zero generation and
that `restartTransitionPending` still returns forever without a firmware-owned
deadline. If either has changed, update this plan before dispatching code work.

---

## Phase 1: Required reliable-chip firmware closure

Phase 1 blocks release. Phase 2 may not be used to postpone its hardware proof.

### Task 1: Keep retrying a proven network when the router starts late

**Owner:** Firmware agent

**Files:**

- Modify: `firmware/lightweaver-controller/src/LightweaverConnectivityPolicy.h`
- Modify: `firmware/lightweaver-controller/tests/connectivity-policy.cpp`
- Modify: `firmware/lightweaver-controller/tests/connectivity-orchestration.cpp`
- Test: `firmware/lightweaver-controller/tests/connectivity-policy.mjs`
- Test: `firmware/lightweaver-controller/tests/connectivity-orchestration.mjs`

- [ ] **Step 1: Write the failing resumed-offline policy test**

Add a case after the existing resumed-boot assertions:

```cpp
ConnectivityState resumedOffline{};
resumedOffline = advanceConnectivity(
    resumedOffline,
    input(ConnectivityEvent::CredentialsResumed, 100, 0));
resumedOffline = recordStationAttempt(resumedOffline, 100);
resumedOffline = advanceConnectivity(
    resumedOffline,
    input(ConnectivityEvent::Tick, 100 + kInitialJoinTimeoutMs));
assert(resumedOffline.phase == ConnectivityPhase::SetupAp);
assert(resumedOffline.apActive);
assert(!resumedOffline.handoffRequired);

resumedOffline = advanceConnectivity(
    resumedOffline,
    input(ConnectivityEvent::Tick,
          100 + kInitialJoinTimeoutMs + kReconnectCadenceMs));
assert(resumedOffline.phase == ConnectivityPhase::Joining);
assert(resumedOffline.reconnectDue);
assert(!resumedOffline.handoffRequired);
assert(resumedOffline.generation == 0);
```

- [ ] **Step 2: Run the policy wrapper and observe red**

```bash
node firmware/lightweaver-controller/tests/connectivity-policy.mjs
```

Expected: FAIL because resumed generation zero never leaves `SetupAp`.

- [ ] **Step 3: Implement the smallest retry rule**

Preserve the distinction between an untouched factory AP and an already-proven
network. The retry condition should admit either a live commissioning
generation or a resumed join:

```cpp
if (current.phase == ConnectivityPhase::SetupAp &&
    (current.generation != 0 || !current.handoffRequired) &&
    elapsed(input.nowMs, current.lastAttemptMs, kReconnectCadenceMs)) {
  next.phase = ConnectivityPhase::Joining;
  next.reconnectDue = true;
  next.phaseStartedMs = input.nowMs;
  return next;
}
```

Do not make an unconfigured factory AP start blind station attempts.

- [ ] **Step 4: Add orchestration coverage**

Prove that each resumed retry records one hardware station attempt, keeps the
AP usable, and retires it only after association and a binding attempt.

- [ ] **Step 5: Verify green**

```bash
node firmware/lightweaver-controller/tests/connectivity-policy.mjs
node firmware/lightweaver-controller/tests/connectivity-orchestration.mjs
node firmware/lightweaver-controller/tests/wifi-handoff-contract.mjs
```

Expected: PASS; first-time handoff still requires acknowledgment.

- [ ] **Step 6: Commit the isolated behavior**

```bash
git add firmware/lightweaver-controller/src/LightweaverConnectivityPolicy.h \
  firmware/lightweaver-controller/tests/connectivity-policy.cpp \
  firmware/lightweaver-controller/tests/connectivity-orchestration.cpp
git commit -m "Keep proven WiFi retrying after boot"
```

### Task 2: Make successful config saves self-reboot safely

**Owner:** Firmware agent

**Files:**

- Create: `firmware/lightweaver-controller/src/LightweaverRestartPolicy.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverRuntimeApi.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Create: `firmware/lightweaver-controller/tests/restart-fallback-policy.cpp`
- Create: `firmware/lightweaver-controller/tests/restart-fallback-policy.mjs`
- Modify: `firmware/lightweaver-controller/tests/config-requires-reboot-response.mjs`
- Preserve: `firmware/lightweaver-controller/tests/bridge-config-reboot-ordering.mjs`

- [ ] **Step 1: Write the native timer policy first**

Use elapsed-time subtraction so `millis()` wraparound remains safe:

```cpp
namespace lightweaver {
constexpr std::uint32_t kConfigRestartFallbackMs = 5000;

struct RestartFallbackState {
  bool armed = false;
  std::uint32_t armedAtMs = 0;
};

constexpr RestartFallbackState armConfigRestartFallback(std::uint32_t nowMs) {
  return {true, nowMs};
}

constexpr bool configRestartFallbackDue(
    const RestartFallbackState& state,
    std::uint32_t nowMs) {
  return state.armed &&
      static_cast<std::uint32_t>(nowMs - state.armedAtMs) >=
          kConfigRestartFallbackMs;
}
}
```

The native test must cover not armed, one millisecond before, exact deadline,
after deadline, and wraparound.

- [ ] **Step 2: Run the new wrapper and observe red**

```bash
node firmware/lightweaver-controller/tests/restart-fallback-policy.mjs
```

Expected: FAIL until the policy header and native test exist.

- [ ] **Step 3: Add an explicit config-save fallback API**

Expose `runtimeArmConfigRestartFallback()` separately from
`runtimeMarkRestartPending()`. Do not silently arm every reset/wiring call site:
some call it before storage transactions finish and clear it on failure.

In the successful non-staged `/api/config` path:

```cpp
runtimeApplySavedConfig();
runtimeMarkRestartPending();
runtimeArmConfigRestartFallback();
server.send(200, "application/json",
            String("{\"ok\":true,\"message\":\"") + message +
            "\",\"requiresReboot\":true}");
```

In `loop()`, check the fallback before the existing dark hold:

```cpp
if (restartTransitionPending) {
  if (lightweaver::configRestartFallbackDue(
          configRestartFallbackState, millis())) {
    delay(50);
    ESP.restart();
  }
  delay(10);
  return;
}
```

The five-second fallback leaves the existing 250ms card-page `/api/reboot`
path faster while guaranteeing recovery when the client disappears.

- [ ] **Step 4: Extend source contracts**

Assert all of the following:

- successful non-staged config arms the fallback exactly once;
- staged wiring config does not arm it;
- failed config does not arm it;
- `/api/config` still returns `requiresReboot:true`;
- the bridge still schedules `/api/reboot` and replies before reboot;
- loop calls `ESP.restart()` only after the policy says the fallback is due.

- [ ] **Step 5: Verify red-to-green behavior**

```bash
node firmware/lightweaver-controller/tests/restart-fallback-policy.mjs
node firmware/lightweaver-controller/tests/config-requires-reboot-response.mjs
node firmware/lightweaver-controller/tests/bridge-config-reboot-ordering.mjs
node firmware/lightweaver-controller/tests/factory-beacon-safety.mjs
node firmware/lightweaver-controller/tests/wiring-safety-regressions.mjs
```

Expected: PASS with explicit browser reboot behavior unchanged.

- [ ] **Step 6: Commit the isolated behavior**

```bash
git add firmware/lightweaver-controller/src/LightweaverRestartPolicy.h \
  firmware/lightweaver-controller/src/LightweaverRuntimeApi.h \
  firmware/lightweaver-controller/src/LightweaverWeb.cpp \
  firmware/lightweaver-controller/src/main.cpp \
  firmware/lightweaver-controller/tests/restart-fallback-policy.cpp \
  firmware/lightweaver-controller/tests/restart-fallback-policy.mjs \
  firmware/lightweaver-controller/tests/config-requires-reboot-response.mjs
git commit -m "Reboot safely after interrupted config save"
```

### Task 3: Apply playback admission to Art-Net

**Owner:** Firmware agent

**Files:**

- Modify: `firmware/lightweaver-controller/src/LightweaverArtnet.cpp`
- Modify: `firmware/lightweaver-controller/tests/wled-command-readiness.mjs`

- [ ] **Step 1: Add a failing source contract**

Extract `decodePacket()` and assert `runtimePlaybackReady()` is checked after
packet validation but before frame-source ownership or pixel writes.

- [ ] **Step 2: Run and observe red**

```bash
node firmware/lightweaver-controller/tests/wled-command-readiness.mjs
```

- [ ] **Step 3: Add the admission check**

```cpp
#include "LightweaverRuntimeApi.h"

// After validating packet size/pixel count, before source ownership:
if (!runtimePlaybackReady()) return;
```

- [ ] **Step 4: Verify and commit**

```bash
node firmware/lightweaver-controller/tests/wled-command-readiness.mjs
git add firmware/lightweaver-controller/src/LightweaverArtnet.cpp \
  firmware/lightweaver-controller/tests/wled-command-readiness.mjs
git commit -m "Gate Art-Net on playback readiness"
```

### Task 4: Firmware build and focused review

**Owner:** Firmware agent, then Reviewer agent

- [ ] **Step 1: Run the complete firmware source segment**

Run every firmware command included by `lightweaver/package.json`'s current
`test:core` script. Expected: zero failures.

- [ ] **Step 2: Build the target**

```bash
pio test -d firmware/lightweaver-controller -e native
pio run -d firmware/lightweaver-controller
```

Expected: native tests and ESP32-S3 build pass with memory usage recorded.

- [ ] **Step 3: Review only the firmware diff**

Reviewer checks timer wraparound, response-flush time, repeated arming,
first-time handoff, late-router recovery, AP retention, project preservation,
and that wiring/factory-reset failure paths remain able to cancel pending work.
Fix every critical and important finding and rerun Steps 1–2.

---

## Phase 2: Immediate authority and recovery hardening

These changes are recommended immediately after Phase 1. They improve honest
recovery but do not block starting the Phase 1 hardware run.

### Task 5: Require two fresh envelopes for ordinary bridge authority

**Owner:** Studio agent

**Files:**

- Modify: `lightweaver/src/lib/cardBridge.js`
- Modify: `lightweaver/src/lib/cardLink.js`
- Modify: `lightweaver/src/lib/cardReadiness.js` only if classification needs a
  narrow fail-closed correction
- Modify: `lightweaver/tests/card-bridge-handoff.mjs`
- Modify: `lightweaver/tests/card-link-state.mjs`
- Update affected fixtures: `card-live-preview.mjs`,
  `card-installer-package.mjs`, and `card-frame-stream.mjs`

- [ ] **Step 1: Write failing authority tests**

Prove one exact ordinary status may discover identity but cannot authorize
`control`, `frame`, `config`, or wiring messages. A second fresh status with the
same `bootId`, card, build, host, and bridge lifecycle authorizes the appropriate
command class. Boot, lifecycle, navigation, timeout, invalid status, or identity
change resets the candidate count.

- [ ] **Step 2: Run focused tests and observe red**

```bash
cd lightweaver
node tests/card-bridge-handoff.mjs
node tests/card-link-state.mjs
```

- [ ] **Step 3: Implement per-lifecycle envelope validation**

Maintain a candidate boot ID and count inside both the link reducer and the
bridge authority boundary. Set privileged lifecycle/readiness authority only
when the count reaches two. Identity discovery may remain visible after the
first envelope; mutation/playback authority may not.

- [ ] **Step 4: Preserve readiness classes**

Playback commands use firmware `playbackReady`; configuration/wiring use strict
`commandReady`. Reboot and exact recovery may remain identity/lifecycle gated
without pretending the runtime is ready.

- [ ] **Step 5: Update fixtures and verify green**

Every ordinary bridge fixture that performs a privileged command must send two
matching statuses. Add explicit assertions that the first remains unauthorized.

```bash
node tests/card-live-preview.mjs
node tests/card-installer-package.mjs
node tests/card-frame-stream.mjs
node tests/card-bridge-handoff.mjs
node tests/card-link-state.mjs
```

- [ ] **Step 6: Commit**

```bash
git add lightweaver/src/lib/cardBridge.js lightweaver/src/lib/cardLink.js \
  lightweaver/src/lib/cardReadiness.js \
  lightweaver/tests/card-live-preview.mjs \
  lightweaver/tests/card-installer-package.mjs \
  lightweaver/tests/card-frame-stream.mjs \
  lightweaver/tests/card-bridge-handoff.mjs \
  lightweaver/tests/card-link-state.mjs
git commit -m "Require two statuses for card authority"
```

### Task 6: Give commissioned-card failures a truthful LAN recovery action

**Owner:** Studio agent

**Files:**

- Modify: `lightweaver/src/components/card/CardConnectionCenter.jsx`
- Modify: `lightweaver/src/lib/cardConnection.js` if a small host classifier is
  needed
- Modify: `lightweaver/tests/connection-center-quality.spec.ts`
- Modify: `lightweaver/src/lib/cardConnection.test.js`

- [ ] **Step 1: Write failing terminal-action tests**

Cover these distinct states:

1. Confirmed factory/setup evidence shows `Lightweaver-XXXX` AP steps.
2. A previously commissioned card whose stable LAN name/address stopped
   answering shows a router-reported local-IP field and power/USB fallback; it
   does not claim a setup AP exists.
3. Mobile has a concrete computer/USB route rather than passive copy.
4. Submitted LAN address opens the existing named card bridge window and still
   requires exact identity before adoption.

- [ ] **Step 2: Run focused Playwright and observe red**

```bash
cd lightweaver
npx playwright test tests/connection-center-quality.spec.ts \
  --project=chromium --workers=1 \
  --grep "mobile handoff|ordinary no-answer|router address"
```

- [ ] **Step 3: Separate AP evidence from LAN failure**

Only `setup-network` or confirmed factory/AP evidence renders hotspot
instructions. Ordinary failure at a remembered stable host renders:

- **Find the card's current address**;
- local-IP entry labeled **Card IP from router**;
- **Connect router address** using the named bridge window;
- **Use power or USB recovery** when the router does not list the card.

Do not add a cloud probe or claim that public HTTPS can scan arbitrary HTTP
hosts. Existing Setup subnet sweep remains a localhost/local-network tool.

- [ ] **Step 4: Verify terminal states and build**

```bash
node --test src/lib/cardConnection.test.js
npx playwright test tests/connection-center-quality.spec.ts \
  --project=chromium --workers=1
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add lightweaver/src/components/card/CardConnectionCenter.jsx \
  lightweaver/src/lib/cardConnection.js \
  lightweaver/src/lib/cardConnection.test.js \
  lightweaver/tests/connection-center-quality.spec.ts
git commit -m "Give lost cards a truthful LAN recovery path"
```

### Task 7: Studio review

**Owner:** Reviewer agent

Review exact identity, exact origins, two-envelope resets, command classes,
blank-card installation authority, manual-host validation, and every reachable
Connection Center terminal state. Fix every critical and important finding and
rerun Tasks 5–6 tests.

---

## Phase 3: Integrate, sign, and prove the live release

### Task 8: Integrate workstreams without branch archaeology

**Owner:** Primary integrator

- [ ] Rebase firmware and Studio branches onto the same current `origin/main`.
- [ ] Integrate by reviewed commits; resolve behavior against current source,
      never by choosing all of `2462ca4` during conflicts.
- [ ] Inspect `git diff --check`, changed-file ownership, and generated artifacts.
- [ ] Confirm the current source gate actually runs every new wrapper/test.

### Task 9: Run complete relevant software verification

**Owner:** Primary integrator and CI/docs agent

```bash
cd lightweaver
npm run test:core
npm run test:core:source
npm run build
cd ../firmware/lightweaver-controller
pio test -e native
pio run
```

Then run the current Connection Center, Setup, Patterns, installer, and card
workspace Playwright suites named by the changed surfaces. Expected: zero
failures and no skipped new contract.

### Task 10: Publish through protected release lanes

**Owner:** Primary integrator after explicit execution authorization

- [ ] Push the integration branch and open a ready-for-review PR only after
      local gates pass.
- [ ] Require all PR checks; merge into `main` only when green.
- [ ] Wait for the protected firmware signer commit created from the exact
      merged firmware source revision.
- [ ] Verify the signed manifest's firmware build number and source revision.
- [ ] Wait for the credentialed Pages deploy of the terminal `origin/main`.
- [ ] Run the strict no-store `/studio-release.json` and build-graph proof.
- [ ] Report **deployed**, not **shipped**, until Phase 4 passes.

---

## Phase 4: Real-card acceptance — shipment gate

### Task 11: Configure the installation network

**Owner:** Adrian

- [ ] Use a fixed 2.4 GHz SSID and password.
- [ ] Disable wireless client isolation.
- [ ] Reserve the card's DHCP address by MAC; record the reservation and router
      model in the acceptance record.
- [ ] Keep `192.168.4.1` as the setup/recovery AP route; do not assign it as the
      station address.

### Task 12: Flash and commission the exact release

**Owner:** Adrian with Primary integrator observing evidence

- [ ] Identify `lw-b0fe81f61b44` over USB.
- [ ] Flash the signed firmware whose build number matches the protected release
      manifest.
- [ ] Install the real project and verify read-back for project ID/fingerprint,
      GPIO, light count, chipset, color order, current limit, and startup look.
- [ ] Complete the one-time Wi-Fi proof; record station IP and boot ID.
- [ ] Verify the full strip and first scene visually.

### Task 13: Run the liveness matrix

**Owner:** Adrian; agent records exact evidence

- [ ] **Ten power cycles:** each returns the saved look without Studio; record
      boot-to-light and boot-to-station time.
- [ ] **Late router start:** power the card with router off, wait for recovery
      AP, restore router, and prove automatic station return without reloading
      the project.
- [ ] **Three router outages:** while playing, remove the router; local visitor
      scene changes still work, Studio demotes, recovery AP appears by sixty
      seconds, and LAN connection returns automatically.
- [ ] **Interrupted config save:** submit a valid non-wiring config, close or
      sever the client immediately after acknowledgment, and prove firmware
      reboots within the bounded fallback and restores playback.
- [ ] **Listener failure observation:** if WLED/Art-Net listener rebinding is
      delayed, local playback remains available and mutation status remains
      honest.
- [ ] **Wrong route:** make the remembered LAN address stale and prove
      Connection Center shows the router-address action, verifies exact card
      identity, and never invents a setup AP.

### Task 14: Record shipment evidence

**Owner:** CI/docs agent and Primary integrator

- [ ] Update `docs/deployment-checklist.md` and the current card acceptance
      record with exact Studio build, firmware build, card ID, boot IDs, router,
      station IP, timings, visual observations, and exported pass records.
- [ ] Mark the top `TODO.md` item complete only when all Phase 1–4 boxes pass.
- [ ] Report **Shipped — Studio build N, firmware build M** only after merged,
      deployed, strict live proof, and this hardware record all agree.

---

## Explicitly deferred

These are not allowed to delay the reliable-chip release:

- Raspberry Pi runtime or proxy work;
- OTA firmware updates;
- public-cloud card commands or relay;
- a full connection-attempt ledger;
- transactional rollback to the previous Wi-Fi credentials;
- arbitrary LAN scanning from public HTTPS;
- complete legacy UI convergence;
- broad recovery-page redesign;
- Pattern Lab, audio-reactive firmware, and unrelated Studio polish.

Promote a deferred item only after Phase 4 exposes it as a real blocker or the
owner explicitly starts a separate project.

## Final completion criterion

This plan is complete only when the exact production card can be powered in any
normal order relative to its router, plays its saved project without Studio,
recovers from a lost router, recovers from a lost config-save client, exposes a
specific truthful action when Studio cannot find it, and has matching signed,
deployed, and hardware evidence. Anything less is **not shipped**.
