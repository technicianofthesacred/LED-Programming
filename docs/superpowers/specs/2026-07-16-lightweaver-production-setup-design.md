# Lightweaver Production Setup Design

**Status:** Approved by Adrian on 2026-07-16 (“yes do all”)

## Goal

Make `https://led.mandalacodes.com` the only tool a workshop worker needs to load, update, verify, and record a sellable Lightweaver artwork without installing a desktop application or handling firmware files, JSON, GPIO tables, or local IP addresses.

## Product boundary

Production Setup is a staff workflow inside the public Studio at `#screen=production`. It uses secure top-level Web Serial in desktop Chrome or Edge. It never launches the Electron Bridge and never weakens the existing signed-firmware policy. Unsupported browsers keep the selected job but direct the worker to reopen the same website in Chrome or Edge.

The customer-facing artwork UI remains simple. Cards leave the workshop already flashed, configured, physically verified, and labeled. Customer USB flashing is a recovery/update path, not normal setup.

## Worker flow

1. Select or scan an immutable production job.
2. Connect exactly one card over USB.
3. Inspect card identity and the official firmware target without mutation.
4. Install the signed current release only when evidence requires it.
5. Reconnect the same stable card after reboot.
6. Restore the exact job revision and supported controls.
7. Read back card-owned project and firmware identity.
8. Test one physical output/boundary at a time: first pixel blue, final pixel red, intermediate pixels current-limited, all pixels outside the boundary dark.
9. Require explicit worker confirmation and record pass/fail.
10. “Next artwork” clears transient card/job-test state while retaining completed production records.

## Immutable jobs

A production job is a content-addressed `.lwjob.json` package, not a mutable Studio project. It contains the job/artwork label, package digest, required firmware target, exact project revision/fingerprint, canonical restore snapshot, compiled runtime configuration, supported controls, and expected physical outputs. QR codes point to the immutable same-origin job URL. File import remains the fallback when camera scanning is unavailable.

The website verifies schema, size, digest, firmware target, card configuration capacity, and GPIO conflicts before acquiring USB or mutating a card. Job packages arriving outside the trusted same-origin index require their own production-job signature; the firmware signing key is not reused.

## Truth and correlation

Every run has a random `runId` and `flowId` bound to the immutable `jobDigest`. A result is accepted only when run, flow, operation, job, and expected card match. A result from another tab, earlier card, or previous batch cannot advance the current job.

Studio never labels a project restored from a successful POST response or its own expected values. Firmware persists card-owned `projectRevision`, `projectFingerprint`, `productionJobId`, and `productionJobDigest`. Studio independently reads them back with the exact card ID, firmware version, and build ID after save/reboot. Wiring candidates additionally require the card-issued activation ID, physical confirmation, activation confirmation, and a final read-back.

All firmware-supported control pins and behaviors are restored exactly after normalization and conflict validation: encoder A/B/press/alternate press, rotate direction/step, previous/next/blackout, analog brightness, and status LED.

## Physical safety

Only one output/boundary is active at a time. The diagnostic never sends synchronized full-brightness white. It uses a low current/brightness ceiling, blue start marker, red end marker, dim intermediate pixels, and darkness outside the active boundary. Pixel count, direction, GPIO/output, and color order changes use acknowledged candidate transactions with automatic rollback until the worker confirms the physical result.

Transport acknowledgement proves only that a test command was accepted. Completion always requires a worker’s physical observation.

## Records and recovery

Pass records contain only workshop facts: run/job/package digest, artwork/batch, stable card ID, firmware version/build, card-read project revision/fingerprint, restored controls, physical results, activation confirmation, worker-entered identifier, and timestamps. The free launch stores bounded records locally with backup plus JSON/CSV export; the UI clearly warns that unexported records are not centralized.

Errors state what happened, whether anything changed, whether USB is released, one safest next action, and a stable support code. Recovery chooses inspect, release USB, reconnect, restore project, rerun physical diagnosis, or signed firmware recovery from evidence. “Lights wrong” never defaults to reflashing.

## Release scope

The free production release includes the website, Web Serial worker lane, signed firmware, recovery, local pass-record export, accessibility, and physical bench acceptance. Native Bridge packaging/signing and OTA updates remain optional later improvements and are not launch dependencies.

## Acceptance

Automated gates must cover package validation, exact correlation, card-owned read-back, control preservation, reconnect/resume, duplicate restore prevention, bounded diagnostics, rollback, record retention, browser gating, responsive accessibility, and production deployment. Final acceptance additionally requires a real card and strip: every output, count, direction, color order, current cap, reboot/reconnect, recovery, and Next-artwork batch cycle must be observed physically.
