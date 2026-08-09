# Integrated Card Control Drawer Implementation Plan

> Source design: `docs/superpowers/specs/2026-08-09-card-control-drawer-design.md`

## Goal

Keep routine customer control inside Lightweaver Studio: a connected card opens a compact, native control drawer instead of sending the user through a separate full-screen card page. Preserve the card-served customer UI for direct `lightweaver.local` use, clearly identify that surface as the physical card, and reserve the full Studio editor for advanced work.

## Constraints

- ESP32-S3 and local LAN command path only; no Pi, cloud command path, iframe, or OTA path.
- The drawer may expose patterns, brightness, speed, hue, custom breathe/drift, and blackout/restore only.
- Installation, GPIO, wiring, Wi-Fi, firmware, reboot, reset, and destructive controls stay out of the drawer.
- All mutations use the existing verified card bridge/direct-card authority and acknowledged `/api/control` path.
- A failed or stale command restores the last card-confirmed state and remains visibly retryable.
- Firmware version advances from 1.1.0 to 1.1.1 because firmware behavior changes.

## Task 1 — Repair card-to-Studio handoff

**Files**
- Modify `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify `firmware/lightweaver-controller/tests/private-network-cors.mjs`

**Work**
1. Prove the verified-opener path loses the requested route/edit intent.
2. Navigate the verified opener to the bounded Studio URL before focusing it.
3. Add a prominent “On this Lightweaver card” origin marker to both card-served pages.
4. Verify generic Studio opening and exact pattern editing without opening another popup.

## Task 2 — Add bounded pattern read transport

**Files**
- Modify `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify the focused bridge source-contract test
- Modify `lightweaver/src/lib/cardLiveControl.js`
- Modify `lightweaver/tests/card-live-preview.mjs`

**Work**
1. Add read-only `patterns` bridge routing to `/api/patterns`.
2. Add `readCardPatternsFromCard()` using the verified bridge when present and direct local fetch otherwise.
3. Normalize and bound the pattern payload; reject malformed/untrusted responses.
4. Prove bridge and direct reads without broadening mutation authority.

## Task 3 — Build the customer control state model

**Files**
- Add `lightweaver/src/lib/cardCustomerControls.js`
- Add `lightweaver/src/lib/cardCustomerControls.test.js`

**Work**
1. Normalize `/api/zones` and `/api/patterns` into a bounded customer-facing model.
2. Derive the exact full control look sent for every edit.
3. Track optimistic, pending, confirmed, failed, and superseded commands.
4. Prove failed commands restore confirmed state and late acknowledgements cannot overwrite newer intent.

## Task 4 — Build the integrated drawer

**Files**
- Add `lightweaver/src/components/card/CardControlDrawer.jsx`
- Modify the relevant Studio stylesheet
- Modify `lightweaver/src/components/card/CardStatusControl.jsx`
- Modify `lightweaver/src/v3/app.jsx`
- Add `lightweaver/tests/card-control-drawer.spec.ts`

**Work**
1. Make the connected footer card control open the drawer; disconnected/attention states continue to open the connection center.
2. Show exact card name and connection state, pattern picker plus previous/next, brightness, speed, hue shift, basic custom color/breathe/drift, and blackout/restore.
3. Use existing acknowledged live-control transport for every mutation.
4. Provide one “Advanced editing” action that routes the same Studio tab into the full pattern editor with the exact active pattern intent.
5. Implement desktop right drawer and phone full-height bottom sheet with focus return, Escape, accessible labels, and no viewport overflow.
6. Prove excluded installation/destructive controls are absent and no popup opens during normal control.

## Task 5 — Firmware identity and release artifacts

**Files**
- Modify `firmware/lightweaver-controller/VERSION`
- Modify focused version policy expectations
- Rebuild `firmware/lightweaver-controller/factory/lightweaver-controller-esp32s3.factory.bin`

**Work**
1. Keep canonical firmware version at 1.1.1.
2. Compile the ESP32-S3 firmware and prove the binary contains 1.1.1.
3. Rebuild the website factory image and pass freshness/identity contracts.

## Task 6 — Integrated verification and delivery

1. Run focused firmware source contracts and Studio unit/browser tests red-before-green.
2. Run `npm run test:unit`, the relevant browser/core gates, `npm run build`, and PlatformIO ESP32-S3 compile.
3. Review the integrated diff for authority, stale-command, accessibility, and scope regressions.
4. Commit, push, open a ready PR, wait for required CI, merge to main, wait for the protected signer/deploy cascade, and prove the exact live Studio and firmware build identities.
5. Flash only the exact signed release to the attached card, read back version/build/card identity, and browser-verify the card marker, drawer, controls, and same-tab advanced handoff. Never claim a visual hardware gate without Adrian's eyes.
