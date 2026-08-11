# Lightweaver Card Lifecycle Hardening Design

**Status:** Approved direction; written design awaiting final review  
**Date:** 2026-08-11  
**Scope:** Current ESP32-S3 runtime, public Studio, and the card-hosted bridge page

## Outcome

Lightweaver will recover automatically after a preserving firmware update, present one truthful card state across Setup, attention, update, and ordinary controls, and allow safe exact-card controls without redundant physical-touch prompts. Physical confirmation remains required only where software cannot prove the real light result or where an operation is destructive or security-sensitive.

The real acceptance card must remain configured as GPIO18, 41 pixels, WS2815, RGB. No recovery or control path may infer or rewrite a different hardware configuration.

## Current failures

1. A Wi-Fi preserving update enters `restarting` after commit but does not initiate the same reconnect path used by the USB flow. The update panel owns a local timer and eventually shows a stale error even when the exact card has rebooted successfully.
2. Setup, footer attention, firmware update, connection center, and the customer control drawer translate overlapping card evidence independently. Their local phases can disagree after a reboot or transient transport loss.
3. Ordinary controls can ask for physical pairing even when Studio already has fresh exact-card, boot, project, and readiness evidence sufficient for a reversible command.
4. Customer-control initialization starts zone and pattern reads concurrently. When no active transport authority exists, both reads independently acquire one; the second acquisition revokes the first, so an already verified card can render as unreachable.

## Chosen design

### 1. One card lifecycle projection

The shared card-link store remains the authoritative transport and identity source. A small derived lifecycle projection will combine:

- expected and observed card identity;
- normalized host and active transport;
- boot identity and freshness;
- runtime, command, output, and playback readiness;
- installed project identity, revision, and fingerprint;
- update session and correlation evidence;
- operation activity and uncertainty.

Consumers receive stable product states such as disconnected, reconnecting, verifying, ready, setup-required, update-required, project-mismatch, and attention-required. Setup, the footer, connection center, firmware update, and customer controls must render from this projection instead of inventing separate recovery truth.

### 2. Bounded post-update recovery coordinator

After a preserving update commits, Studio starts a bounded recovery coordinator with the pre-update card ID, host candidates, boot ID, project identity, and signed target firmware identity.

The coordinator:

1. marks the shared lifecycle as restarting/reconnecting;
2. reacquires only the same expected card using the existing host, stable local hostname, or verified bridge;
3. requires a new boot identity;
4. verifies the signed target firmware version/build;
5. verifies the saved project identity and readiness, or reports exact rollback/provisional evidence;
6. publishes the verified result to the shared card-link store;
7. closes the update session and clears stale panel errors only after correlation succeeds.

Timeouts remain bounded and actionable. A timeout must not claim the update failed or discard saved card data. A wrong card, wrong firmware, changed project, rollback, or uncertain write remains a hard attention state.

### 3. Single-flight transport acquisition

Transport acquisition becomes single-flight per normalized host and expected card ID. Concurrent read-only consumers share the same in-flight acquisition and receive the same resulting authority. A successful second consumer must not revoke an authority that the first consumer is still using.

Revocation remains correct when the card, boot, host, or operation generation actually changes. This fixes the customer-control race without weakening identity checks.

### 4. Capability policy for ordinary controls

Reversible pattern, color, brightness, speed, hue, zone, playlist navigation, and blackout/restore commands may run when all of the following are freshly proven:

- the transport reaches the expected card;
- the boot identity is current;
- the runtime is command-ready;
- the installed project matches the Studio project;
- the requested pattern or zone exists in that installed project.

These commands do not require another physical touch. Existing commissioning evidence and exact-card software authorization may be reused within their scoped lifetime.

Physical confirmation remains required for wiring discovery, GPIO/count/color-order/chipset changes, staged installation, and any result whose correctness depends on seeing the LEDs. Destructive reset/erase and firmware authorization retain their narrow security contracts.

## State and error behavior

- A transient missed keepalive closes command access but may retain playback-ready display when firmware evidence supports it.
- Reconnect never silently adopts a different card.
- New boot evidence invalidates stale transport authority and in-flight commands.
- A project mismatch routes to the matching Setup task; it does not masquerade as a network failure.
- Update rollback/provisional evidence is shown explicitly and never reduced to a generic reconnect error.
- Ordinary control failures roll back optimistic UI state and retain a retry action after fresh lifecycle verification.

## Verification

Implementation proceeds test-first with focused regressions for:

- Wi-Fi preserving update automatically reconnecting after commit;
- exact card, new boot, target firmware, and unchanged project correlation;
- timeout, wrong-card, wrong-build, rollback, and project-mismatch outcomes;
- concurrent zone/pattern reads sharing one transport acquisition;
- Setup, footer attention, update panel, and control drawer rendering the same lifecycle state;
- safe controls working without a redundant physical-touch prompt;
- physical/destructive operations retaining their confirmation gates.

The end-to-end matrix then machine-verifies patterns, colors, zones, playlists, previous/next navigation, reboot persistence, recovery, and Studio/card-page navigation in ego-browser task space 35. Deployment and card readback occur only after focused tests and the full launch gate pass. Final readback must prove GPIO18, 41 pixels, WS2815, RGB, the expected project fingerprint, and the released Studio/firmware build identities.

Visual confirmation is requested only for a physical property that no API or card readback can establish.

## Boundaries

- Current runtime is ESP32-S3 only; deferred Pi, WLED, Madrix, and Art-Net work is excluded.
- No production deployment occurs before the implementation and release gates pass.
- No automated path changes the verified real-card hardware configuration.
- No recovery path broadens authority to another card, project, firmware build, or destructive operation.
