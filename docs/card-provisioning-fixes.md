# Card provisioning hardening — current implementation

This is a concise implementation record, not the worker procedure or shipment
evidence. Use [`new-card-checklist.md`](new-card-checklist.md) for each card and
[`deployment-checklist.md`](deployment-checklist.md) for the release gate. The
full failure audit is [`card-provisioning-audit.md`](card-provisioning-audit.md).

## What changed

### Signed, identity-bound flashing

- Studio verifies the release signature, target, merged-image structure, size,
  and SHA-256 before erase.
- It accepts only the inspected ESP32-S3/16 MB target and binds the eFuse-derived
  card ID to the production run.
- An interrupted install is inspected before retry; destructive work is not
  repeated merely because a browser response was lost.
- Flash completion proves the bytes, not application readiness. The factory
  beacon or a fresh exact-card runtime status is still required.

### Truthful blank and connected states

- Factory firmware reports no known-good project and no normal command/output
  readiness. A reachable blank card is **Blank — load a project**, never green.
- The blank card has a narrow, one-use config authority for its exact production
  project; that does not grant ordinary runtime command authority.
- Missing readiness fields, stored pairing, a bridge hello, HTTP success, or one
  status response cannot produce Connected.
- Studio requires two fresh complete responses for the exact card, firmware,
  build, boot, host, handoff generation, operation generation, and bridge
  lifecycle. Reset, loss, or navigation revokes the prior authority.

### Safe factory life signal

- A genuinely blank card cycles a bounded two-pulse amber beacon over the
  supported output pins, at no more than eight pixels and a safe current limit.
- The beacon yields to Wi-Fi transitions, project configuration, diagnostics,
  streaming, candidate wiring, and recovery.
- It proves that factory firmware can drive a small test output. It does not
  prove the GPIO 18 project, the full 44-pixel strip, or shipment readiness.

### Deterministic Wi-Fi handoff and recovery

- Firmware owns explicit `setup-ap`, `joining`, `handoff-ready`, `station`,
  `reconnecting`, and `recovery-ap` phases.
- AP+STA remains available while the station address and local command listeners
  become ready and Studio acknowledges the exact card, boot, and generation. An
  abandoned handoff retires the open AP after five minutes without granting
  success; exact station-origin correlation can still finish it afterward.
- The setup page treats the Wi-Fi POST as accepted credentials only. It polls
  the accepted boot/generation until the station address is verified, then tells
  the worker to return to gallery Wi-Fi; join failure and timeout are explicit.
- HTTPS Studio uses the guided named card-page bridge. That page follows the
  verified station address and returns the worker to the same Studio flow; the
  worker never types or discovers a card address.
- If the first station navigation occurs before the workstation leaves the
  setup AP and lands on a browser network-error page, Studio automatically
  renavigates that same authorized tab during the bounded return window. It does
  not open repeated popups or relax exact-card correlation.
- Two fresh station statuses are required before auto-advance. Wrong-card,
  wrong-boot, stale-generation, AP-interface, or partial evidence fails closed.
- Firmware retries the station network every 10 seconds, opens the recovery AP
  by 60 seconds, preserves local playback/project state, and automatically
  returns to station when the network becomes available.

### Exact project load and physical proof

- Production mutations use short-lived leases bound to card, boot, host,
  bridge lifecycle, operation generation, job, and commissioning flow.
- The blank card receives one config through the production push path. Studio
  independently reads back the exact job/project/wiring/output/current facts;
  the POST acknowledgement alone is not success.
- The canonical bench generator and published indexed job require GPIO 18,
  44 pixels, GRB, Aurora, 1500 mA, and brightness limit 0.35.
- CI regenerates the source and artifact in an isolated temporary directory and
  byte-compares them to the committed source and indexed artifact. It also
  verifies digest, URL, size, and artifact SHA-256, so a hand edit or stale GPIO
  cannot silently enter the release.
- Guided frames remain separate from physical observation. Only the worker's
  explicit confirmation that the entire real strip is correct can create a
  physical pass.

### Release coherence

- The always-on source workflow watches firmware, production-job generators and
  sources, schemas/policy, build/sign/rebuild scripts, workflows, and current
  commissioning documents.
- The protected signer also triggers when the generator's commissioning and
  runtime-package library dependencies change. It regenerates production jobs
  after signing and reruns the exact pipeline check.
- The signed launch gate requires the committed factory image to be fresh.
- Pages staging publishes a deterministic Studio build graph. The live checker
  verifies every indexed JS/CSS asset rather than only the root HTML.
- Missing Cloudflare credentials may leave source CI green by policy, but the
  workflow explicitly records **Production publish: NOT RUN**. That result is
  not deployment or shipment evidence.

## Automated evidence and its limit

Source, native firmware, unit, browser, production-job, build, and staged Pages
tests cover the decision paths above. They prove fail-closed software behavior
and deterministic artifacts. They cannot prove Wi-Fi behavior in the gallery,
browser permissions on the production computer, electrical wiring, or emitted
light.

The real card has previously shown the bounded eight-pixel factory beacon, and
direct diagnostic control has previously produced light on the GPIO 18 strip.
Those are useful diagnostics only. They are not a completed live Studio
Production Setup run and do not prove the complete 44-pixel customer flow.

## Remaining shipment blockers

1. Merge the current source hardening and pass `npm run launch:source`.
2. Let the protected workflow compile/sign firmware and regenerate the GPIO 18
   production job; pass `npm run launch:check` on that release commit.
3. Publish Studio with Cloudflare credentials and pass
   `PROD_CHECK_REQUIRED=1 npm run check:prod`, including the live build graph.
4. Through the live Production Setup route, erase and commission a real card in
   one uninterrupted guided same-tab flow—no terminal, direct diagnostic
   control, local server, or typed card address.
5. Observe the complete 44-pixel GPIO 18 Aurora strip, then pass power-cycle and
   network-outage recovery and export the JSON/CSV production record.

Until all five are recorded, the production flow remains pending and the card
is not ready to ship.
