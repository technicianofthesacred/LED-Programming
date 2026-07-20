# Lightweaver Repeatable Card Provisioning Design

**Date:** 2026-07-20

**Status:** Approved direction; implementation planning pending review

**Scope:** ESP32-S3 Lightweaver firmware and React Studio production workflow

## Goal

Make commissioning a repeatable production operation: a worker can take one blank ESP32-S3 card through signed firmware installation, WiFi setup, exact-card pairing, project installation, and a witnessed light check without hidden recovery or an unverified success state.

The commissioning software is the product. A completed run is evidence about one physical card, one immutable project revision, and one observed strip—not a browser's memory of what it attempted.

## Definitions

- **Reachable:** Studio received a fresh, valid response from a Lightweaver endpoint.
- **Identified:** that response contains the stable card ID and supported protocol identity.
- **Paired:** the fresh card ID equals the card explicitly selected for this run.
- **Blank:** firmware is alive, but no valid, known-good project is installed.
- **Command-ready:** the exact paired card is freshly reachable, is not rebooting or in recovery, and reports that its command endpoint and output runtime are initialized.
- **Project-verified:** an independent read after installation matches the expected project revision, fingerprint, production job, and active wiring.
- **Physically verified:** the worker observed the bounded diagnostic on the real strip and confirmed its endpoints, direction, color order, and extent.
- **Connected:** a UI label reserved for a card that is both paired and command-ready. Stored pairing, a WebSocket object, cached status, a successful POST, or a power LED is insufficient.
- **Finished:** firmware, project, and physical verification all succeeded for the same run and card; the card still passes a final fresh readiness check.

Unknown is not success. Any field that Studio cannot establish remains `unknown`, never a false value that accidentally means ready.

## Physical fixture assumption

The photographed prototype has a separately powered LED strip and one data jumper connected to the ESP32-S3. The red LED on the development board proves only that the board has power. It is not evidence that Lightweaver booted or can accept commands.

Production fixtures use one of the approved Lightweaver LED data pins: GPIO 16, 17, 18, or 21. A shared ground between ESP32 and strip power is mandatory. The current bench strip is a 12 V WS2815-class fixture; a worker must not use the photographed 10.5 V supply with a 5 V strip.

Because the output pin is restricted but not known on a blank card, factory discovery may energize only those four approved pins, one at a time, under a conservative diagnostic current and brightness limit. It must never initialize arbitrary GPIOs or drive all candidates concurrently.

## Truth model

Firmware owns runtime truth. Studio owns the expected job and the worker-facing workflow. A state is green only when the following fresh evidence agrees:

| UI state | Required evidence |
| --- | --- |
| No card | No fresh valid response |
| Searching / reconnecting | Expected identity is known, but no fresh response is available |
| Found—pair this card | Fresh valid response, but no explicit exact-card pairing for this run |
| Blank—load a project | Fresh exact-card response with factory/no-known-good configuration |
| Project needs verification | Install was attempted, but independent card-owned readback is absent or mismatched |
| Ready for light check | Fresh exact-card command readiness plus exact project readback |
| Finished | All of the above plus a same-run physical confirmation and final readiness check |

Each status response used for commissioning must expose enough card-owned evidence to reject stale browser state:

- stable `cardId`;
- firmware version and build ID;
- protocol/contract version;
- per-boot identifier and uptime;
- reset reason where supported;
- runtime phase: factory, starting, ready, probation, recovery, or fault;
- command readiness and output initialization readiness;
- configuration source and validity;
- whether a known-good project exists;
- active project revision and fingerprint;
- production job ID and digest when commissioned;
- active wiring revision or activation ID;
- monotonically useful runtime/state revision where applicable.

Studio accepts a response only if its schema is valid and its identity matches the current operation. A changed boot identifier means the card restarted. The UI must immediately clear transient command readiness, cancel stale operations, and re-establish identity, blank/project state, and output readiness before returning to green.

## End-to-end workflow

### 1. Install signed firmware over Web Serial

Studio lets the worker choose an ESP32-S3 serial device and displays the selected USB identity. It installs only the signed production manifest and binary already permitted by the release policy.

The UI separates three events:

1. bytes were transferred;
2. the device rebooted;
3. the new Lightweaver runtime was identified.

Only the third event verifies installation. If firmware can provide a post-reboot USB identity handshake, Studio uses it. Otherwise the flow remains at **Firmware written—waiting for card to boot** until the factory AP endpoint returns the expected Lightweaver protocol, card identity, firmware version, and build ID. A transfer completion by itself is never labeled ready or successful.

Failures have bounded timeouts and preserve a clear recovery action: release the serial port, reconnect the same card, retry the signed image, or enter the documented ESP32 bootloader recovery. A response from another card or an older run cannot satisfy the check.

### 2. Prove factory life without assuming project wiring

A new or erased card reports factory phase and `knownGoodProject: false`. Studio shows **Blank—load a project**, even though the firmware and network endpoints are healthy.

Factory firmware must not run the current arbitrary GPIO16/44-pixel/Aurora project as though it were valid. Instead it enters a bounded factory beacon:

- outputs are otherwise dark;
- only GPIO 16, 17, 18, and 21 are eligible;
- one pin is initialized at a time;
- a short, dim, recognizable pulse is sent with a conservative pixel ceiling and current cap;
- each controller is torn down before the next pin is tried;
- the sequence pauses or stops when Studio begins an explicit operation;
- normal factory boot remains recoverable even if no strip is attached.

The beacon proves only that a visible strip responded when a worker sees it. Firmware can prove that an output controller initialized and a frame was submitted; it cannot electrically prove illumination with the current hardware.

### 3. Join WiFi and automatically reacquire the same card

The worker joins `Lightweaver-XXXX`, opens the captive setup page, and enters gallery WiFi credentials. Before dropping the AP, the card displays its stable ID and explains that the worker should return the phone/computer to the gallery network. If the network grants an address, the card exposes it where the platform allows.

Studio enters a handoff state before the AP disappears. It continuously attempts reacquisition within a bounded window and advances automatically only after a fresh LAN response matches the expected card ID and protocol.

Transport behavior:

- From an HTTP-served Studio, direct LAN HTTP may probe mDNS and known/manual addresses.
- From `https://led.mandalacodes.com`, Studio uses the card-page bridge. The bridge must reacquire and report fresh identity, blank/project state, boot ID, and readiness; a cached bridge identity or ping alone cannot mark the card connected.
- A manual IP/address field remains the fallback when mDNS or browser discovery is unavailable.

If reacquisition times out, the screen stays useful: it says whether the AP handoff was observed, asks the worker to confirm the computer returned to gallery WiFi, accepts the card's IP, and offers retry. It never keeps presenting the dead AP page as the destination.

### 4. Pair only the exact fresh card

Studio displays the discovered stable card ID and requires an explicit pairing action for a new production run. Ordinary Connect does not silently adopt an unexpected card.

Pairing persists the expected identity for reconnection convenience, but persistence is not current connectivity. Every command preflight requires a fresh matching identity and command-ready status. An unexpected card produces a blocking identity mismatch, not automatic adoption.

Direct and bridge transports use the same state machine. Keepalives demote a card after bounded missed responses. A later matching response may resume the workflow only after full readiness and project-state revalidation. A changed boot ID triggers the same revalidation even when the stable card ID is unchanged.

### 5. Install and independently verify the project

Studio validates the immutable production job before mutation: project fingerprint/revision, job digest, GPIO support and conflicts, pixel count, color order, current cap, storage capacity, zones/looks, and required firmware build.

Installation is transactional:

1. Stage the candidate configuration on the exact card.
2. Receive a card-issued activation identifier.
3. Activate/reboot into probation without overwriting the previous known-good project.
4. Reacquire the same card and boot.
5. Perform a separate card-owned readback.
6. Compare the complete expected identity: card, build, project revision/fingerprint, job ID/digest, wiring, controls, and activation.
7. Keep the candidate unconfirmed until the physical light check passes.

A successful POST acknowledges receipt only. It does not prove persistence, activation, or correct physical output. Invalid GPIOs, duplicated/conflicting pins, unsupported color orders, unknown zones, partial zone updates, and malformed values must return explicit errors before changing live output.

Factory reset must clear all project sources that can override factory state, including removable-storage configuration when the product promises a complete erase. If removable media prevents a true erase, Studio must identify that source and tell the worker to remove or clear it; it must not call the card blank while loading that project.

### 6. Run the guided physical light check

The light check is a required commissioning gate, not an optional demo.

For a blank fixture whose data pin is unknown, **Find my LED wire** tests GPIO 16, 17, 18, and 21 sequentially. The worker selects the step that visibly lights the strip. The selected pin is then staged in the project; discovery alone does not silently persist it.

For the project diagnostic:

- only one physical output is active at a time;
- the first pixel is blue and the final pixel is red;
- intermediate pixels are dim and current-limited;
- pixels outside the expected boundary remain dark;
- direction, pixel count, output pin, and color order are tested through the same candidate/rollback mechanism;
- loss of Studio, timeout, reboot, brownout, or explicit failure restores the previous known-good configuration.

The worker must answer what was observed. Firmware acknowledgement can prove controller initialization and frame submission, but cannot substitute for sight of the real strip. Color cues are paired with position/text so the instructions do not rely on color perception alone.

Only a positive same-run observation promotes the candidate to known-good. Studio then reacquires the card, independently reads the promoted configuration, sends a harmless final command/readiness probe, and records completion. If this final probe fails, the run returns to reconnecting rather than finished.

### 7. Finish and start the next card

The completion record is bound to the run ID, immutable job digest, stable card ID, firmware build, project fingerprint/revision, activation, physical result, and timestamps. Locally stored records are explicitly described as local and must be exported according to the production process.

**Next card** clears all transient identity, acknowledgements, bridge/direct connection state, discovery selections, activation IDs, physical confirmations, and cached success UI. It retains the selected immutable job only when the worker deliberately chooses batch mode. No evidence from the previous card can advance the next run.

## Failure handling principles

- A timeout is a timeout, never success.
- Unknown blank/project state is shown as **Checking card**, never ready.
- A command rejection or zero affected outputs is an error.
- A reboot invalidates transient readiness and acknowledgements.
- Network loss during candidate probation is owned by the card-side rollback timer.
- Repeated actions are idempotent or rejected by operation/run/activation correlation.
- Recovery preserves the last known-good configuration unless the worker explicitly performs a full factory erase.
- Error messages state what was verified, what remains unknown, whether the card changed, and one safest next action.

## Automated verification

### Firmware contract and native tests

Tests must cover:

- truthful factory/configuration source and known-good fields;
- boot ID/uptime behavior and reset transitions;
- restricted sequential factory discovery pins and safe current/pixel ceilings;
- output teardown between discovery pins;
- validation rejection before live mutation;
- accurate affected-output counts and command acknowledgements;
- project fingerprint/revision persistence and independent readback;
- candidate promotion and rollback on timeout, reboot, fault, and lost confirmation;
- full factory erase behavior across NVS and removable-storage overrides;
- current limiting, output color order, direction, wiring safety, WLED compatibility, and hardware capability contracts.

The relevant PlatformIO native/parser tests and firmware source-contract tests become part of the normal launch gate, rather than optional commands known only to maintainers.

### Studio unit and integration tests

Tests must cover:

- the state matrix above, especially unknown never becoming green;
- transfer complete versus verified post-flash boot;
- exact-card correlation across serial, AP, LAN, direct, and bridge transports;
- AP-to-LAN automatic handoff and manual-address fallback;
- bridge reacquisition requiring full fresh state, not cached identity;
- silent drop and reboot demotion/recovery;
- independent project readback and mismatch handling;
- stale run, card, boot, operation, and activation responses;
- sequential pin discovery and worker confirmation;
- physical-check gating and final readiness probe;
- clean **Next card** behavior in batch production.

Playwright remains useful for deterministic workflow coverage, but mocked browser tests must not be described as hardware acceptance.

### Release and CI coverage

CI and deployment path filters must include every input capable of changing production jobs, manifests, generated firmware references, or commissioning behavior. The launch gate runs the complete relevant Studio, firmware-contract, package-generation, and production-workflow suites from a clean checkout.

## Real-card acceptance

Final acceptance uses a genuinely erased ESP32-S3 and the photographed-style powered strip fixture. It is performed through the same released Studio and signed artifact a worker will use.

The witnessed run must prove:

1. signed flash completes and the new runtime identity is verified;
2. the card reports blank and never green;
3. the factory beacon visibly reaches the strip on its actual supported pin;
4. WiFi AP handoff automatically reacquires the same card;
5. the exact job installs and survives reboot;
6. independent readback matches the job and wiring;
7. endpoint, direction, count, color order, and current-limited light test are visibly correct;
8. a deliberate network loss or power cycle removes green connected state and recovers honestly;
9. completion is recorded only after the final fresh probe;
10. **Next card** begins with no inherited success.

The run log records commands, identities, and readbacks; the worker records the visual result. Hardware acceptance is incomplete until a human sees the correct strip light.

## Documentation deliverables

- A full audit organized by the seven workflow stages, with assumptions and verification gaps linked to implemented controls.
- A one-page **New Card** checklist using only worker-facing language and stopping whenever Studio has not shown a verified gate.
- A recovery appendix for USB bootloader recovery, WiFi reacquisition, manual address entry, wrong/no light, project rollback, and full erase.
- A release acceptance record for the real-card run.

Existing `docs/card-provisioning-audit.md`, `docs/card-provisioning-fixes.md`, and `docs/card-provisioning-checklist.md` are preliminary drafts. They contain claims that are not yet verified, including treating a POST as persistence proof and implying software can autonomously observe light without extra hardware. Implementation replaces or reconciles those drafts against this design before they are used on the production line.

## Out of scope

- Raspberry Pi runtime or proxy work;
- account/login requirements for the gallery experience;
- cloud relay control of LAN cards;
- electrical LED-presence sensing without added hardware;
- OTA as a prerequisite for the USB production workflow;
- arbitrary GPIO discovery outside the four approved Lightweaver outputs.
