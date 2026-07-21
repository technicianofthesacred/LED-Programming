# Lightweaver card provisioning — remaining work

Paused on 2026-07-21. The implementation through commit `a65fb06` is saved on
branch `led-density-per-meter`. It is not deployed and is not shipment-ready.

## Current truth

- Firmware Wi-Fi handoff/retry/recovery, Studio exact-card commissioning, live
  asset freshness, the GPIO 18 production job, the audit, and the worker
  checklist are implemented and independently reviewed.
- The connected card is `lw-b0fe81f61b44`. Its saved project reports GPIO 18,
  44 pixels, GRB, Aurora, and 1500 mA. The released whole-system Studio flow has
  not visibly lit and passed the full strip.
- The complete source gate is red. The interrupted run reached 233 passing
  release-UI tests and found two real failures in `tests/patterns-v3.spec.ts`:
  the current and legacy bridge preview tests did not receive a `control`
  message. One later wiring test was interrupted and eight tests did not run.
- The committed signed factory binary is expected to remain stale until the
  protected signer rebuilds it from the merged firmware source.

## 1. Close Production Setup review blockers

- [ ] Replace the module-level HTTPS bridge harness with one actual
      `ProductionScreen` browser test that completes the whole flow: USB-bound
      identity, AP status, station retarget, exactly two fresh station status
      envelopes, exactly one handoff acknowledgement, visible non-green blank
      state, exactly one config, independent read-back, real guided frame,
      human **Yes**, final fresh wiring/project reads, and a persisted pass.
- [ ] Immediately demote the shared card link and footer when a config,
      read-back, frame, or pass operation detects lease loss, mismatch, or
      timeout. Tests must observe ready/green changing to disconnected or
      revalidating without waiting for the normal polling interval.
- [ ] Bind every asynchronous Production action to the run correlation that
      started it. A stale tab or delayed run A handler must never transition,
      record, or complete a replacement run B. Add a two-tab final-pass test.
- [ ] Make the one config write exact-lease only: explicit host and transport,
      `autoDiscover: false`, no second POST to a discovered host after an
      ambiguous response. Thread `lease.transport` through wiring and frame
      clients and test direct and HTTPS paths.
- [ ] Await and surface asynchronous `onComplete` failures; cancel candidate
      operations and countdown timers on unmount.
- [ ] Re-run Task 6 spec and quality reviews until both approve.

## 2. Repair and complete the source gate

- [ ] Reproduce these tests individually and identify the cause before editing:
      `patterns-v3.spec.ts:262` (current bridge preview) and
      `patterns-v3.spec.ts:465` (legacy bridge preview). Both timed out waiting
      for a source-bound `control` message during the combined suite.
- [ ] If the new two-envelope/lifecycle contract intentionally invalidates the
      old fixtures, update the fixtures to provide current exact evidence. If
      behavior regressed, fix the production code. Do not weaken readiness.
- [ ] Re-run the two focused tests repeatedly, then the complete
      `npm run launch:source` from a clean worktree. Require zero failures and
      allow all 244 release-UI tests to finish.
- [ ] Compile firmware with `pio run -d firmware/lightweaver-controller -e
      esp32-s3-n16r8` and run the firmware/native contract suites.
- [ ] Run `git diff --check origin/main...HEAD` and review the full integrated
      diff once.

## 3. Publish the protected release

- [ ] Push the final reviewed branch and open/update a PR to `main`.
- [ ] Merge only after the source gate is green.
- [ ] Wait for the protected `build-firmware.yml` signer to rebuild the merged
      factory image, signed manifest/provenance, and GPIO 18 production job on
      `main`. Do not bypass `factory-bin-freshness`.
- [ ] Confirm the signer bot commit lands, then require `npm run launch:check`
      to pass on that exact checkout.
- [ ] Confirm the credentialed Cloudflare Pages deploy actually ran. A green
      workflow that reports **Production publish: NOT RUN** is not deployment.
- [ ] Build and stage the exact checkout, then run
      `PROD_CHECK_REQUIRED=1 npm run check:prod`. Require the live `/` bytes,
      build graph, every JS/CSS asset, signed firmware, provenance, and indexed
      job to match the checkout.

## 4. Run the live erased-card acceptance

Use `https://led.mandalacodes.com/#screen=production` and follow
[`new-card-checklist.md`](new-card-checklist.md). No terminal, typed IP, direct
HTTP command, board LED, or eight-pixel beacon can substitute for this run.

- [ ] Fully erase and flash the blank ESP32-S3 through the live Studio.
- [ ] Observe exactly the bounded eight-pixel/two-pulse amber factory beacon.
- [ ] Confirm Studio says **Blank — load a project**, never green.
- [ ] Complete the guided hotspot-to-LAN handoff in the same Studio flow; the
      exact card must return automatically and supply two fresh statuses.
- [ ] Load exactly one GPIO 18 / 44 / GRB / Aurora / 1500 mA project and verify
      the independent read-back.
- [ ] Complete every guided boundary check and visually confirm the entire
      44-pixel strip lights and animates correctly.
- [ ] Save/export the pass record for `lw-b0fe81f61b44`.
- [ ] Power-cycle: the full saved Aurora look must return, and Studio must
      demote then revalidate the new boot before showing ready.
- [ ] Turn Wi-Fi off: playback must continue, Studio must demote, and the
      recovery AP must appear within 60 seconds. Restore Wi-Fi and confirm
      automatic same-card recovery without reloading the project.

Only after every box above passes is this card, or the repeatable production
flow, ready to ship.
