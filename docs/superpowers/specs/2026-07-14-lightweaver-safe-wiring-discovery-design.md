# Lightweaver Safe Wiring Discovery and Recovery Design

**Date:** 2026-07-14  
**Status:** Approved direction; ready for implementation planning

## Objective

Make wiring changes safe for people who do not understand GPIOs, while keeping GPIO numbers visible and editable for experts. A configuration mistake may fail a temporary test, but it must not strand the card, overwrite the last working setup, or require new code to recover.

## Core model

Lightweaver must keep two concepts separate:

- **Logical sections** are artwork regions such as outer circle and inner circle. They control mapping and patterns.
- **Physical outputs** are actual data wires leaving the controller. Only an explicit physical-wire action may create one.

Auto Wire may order logical sections along confirmed physical outputs. It must never infer additional GPIO outputs from section count, geometry, strip count, or pattern grouping.

## Simple wiring flow

The primary action is **Test new wiring**, not Save.

1. Ask: **How many LED data wires leave the controller?** Default to one.
2. Show one output card per physical wire. Display a friendly port label and its GPIO number.
3. If the user knows the GPIO, they may select it. If not, **Find my LED wire** starts guided discovery.
4. The card tests no more than four approved LED-safe GPIOs at once, using a distinct persistent color for each pin and safe brightness. The UI shows the same color-to-GPIO choices.
5. The user selects the color they see. Lightweaver records that GPIO as physically confirmed and tests the next physical wire.
6. Pixel count and direction use the existing persistent boundary frame: first pixel blue, final pixel red, all unrelated pixels black. Inline plus/minus controls adjust the count.
7. After every output is confirmed, Lightweaver activates the complete candidate configuration in probation mode.
8. The user confirms **Everything is lighting correctly**. Only then does the candidate become known-good.

If no tested pin lights, the UI does not ask the user to diagnose GPIOs. It presents a short physical checklist: LED power, common ground, DATA IN direction, connector seating, and supported controller port.

## Expert mode

Expert mode exposes GPIO selectors and permits reordering outputs. It uses the same model, validation, probation, and rollback path as Simple mode. Expert mode reveals details; it does not bypass safety.

Changing a confirmed GPIO, output count, output order, or physical pixel allocation clears only the affected physical confirmations and requires a new test. Creative edits and logical section changes do not invalidate physical GPIO confirmation.

## Transactional configuration

The card stores three states:

- **known-good:** the last physically confirmed runtime configuration;
- **candidate:** a staged configuration under test;
- **candidate state:** activation identifier, state, and boot-attempt marker.

Saving a candidate must never replace the active known-good JSON in place.

Activation sequence:

1. Studio sends and validates the candidate.
2. Firmware persists it in the candidate slot and marks it `armed`.
3. The card reboots, loads the candidate once, and immediately marks it `awaiting-confirmation`.
4. A 90-second probation timer begins after the web runtime is available.
5. Confirmation atomically promotes candidate to known-good and clears probation state.
6. Timeout, browser abandonment, explicit failure, watchdog reset, brownout, invalid output initialization, or another reboot while awaiting confirmation restores known-good automatically.

On firmware upgrade, an existing active configuration becomes the initial known-good configuration. A malformed known-good slot falls back to compiled safe defaults and starts the card setup access point.

## Validation rails

Before candidate persistence, firmware rejects:

- unsupported or duplicated active GPIOs;
- conflicts with configured buttons, encoder, SD, or reserved board pins;
- zero pixels, output totals above firmware capacity, or malformed ranges;
- more physical outputs than the supported driver-channel limit;
- configurations exceeding storage capacity;
- invalid pattern, zone, or startup references;
- unsafe current-limit values.

Validation occurs before changing the live runtime object. The running card and its output controllers remain internally consistent until the controlled reboot.

## Recovery behavior

**Recover lights** is one guided action with automatic escalation:

1. Stop browser frame producers and cancel card-side streaming ownership.
2. Restart the card to reset the LED driver.
3. Wait for the card to return and reapply the active known-good output configuration.
4. Hold a visible warm-white frame and report only what firmware can prove: command accepted, outputs initialized, frame submitted.
5. If a candidate is in probation or failed initialization, automatically discard it and restore known-good before restarting.
6. If known-good still produces no visible light, offer **Find my LED wire**. Do not claim physical recovery without user confirmation.

The card page must expose **Restore working setup** in safe mode. Safe mode remains available from the card-hosted page and setup Wi-Fi, independent of the public Studio.

## User-facing language

Simple mode uses:

- LED Port 1
- Data wire
- Find my LED wire
- Test new wiring
- Restore working setup
- Did this output light?

GPIO numbers remain visible as secondary text, for example `LED Port 1 · GPIO 18`. Terms such as NVS, candidate slot, frame ownership, RMT, and compiler preflight remain hidden outside diagnostics.

## Failure handling

- A known HTTP rejection is an error, never success.
- Network loss during probation is recoverable; the card owns the timeout and rollback.
- A stale browser or bridge reply cannot confirm a different card, activation identifier, or candidate.
- Repeated recovery clicks collapse into one active recovery operation.
- Recovery and candidate confirmation are idempotent.
- Firmware cannot electrically verify LED illumination, so visual confirmation remains the promotion gate.

## Testing and acceptance

Automated coverage must prove:

- logical sections never increase physical output count;
- unsupported/conflicting pins fail before persistence;
- active known-good remains byte-for-byte unchanged while a candidate is staged;
- candidate boots once, promotes only with the matching activation identifier, and rolls back on timeout or reboot;
- output initialization failure cannot report frame submission;
- Recover Lights restores known-good and reconnects across direct and bridge transports;
- stale card/activation responses cannot confirm current state;
- Simple and Expert mode share the same transactional API;
- discovery batches never exceed four safe output controllers;
- no wiring surface scrolls horizontally on supported phone widths.

Hardware acceptance uses a known 44-pixel strip on every supported LED GPIO, then a two-output fixture. Each test verifies pin discovery, blue/red endpoints, candidate promotion, forced timeout rollback, power-cycle rollback, and recovery from a deliberately wrong GPIO.

## Out of scope

- Electrically sensing LED waveform success without additional hardware feedback;
- automatically inferring the number of physical data wires from artwork geometry;
- changing firmware binaries as part of a wiring transaction;
- Raspberry Pi recovery paths.
