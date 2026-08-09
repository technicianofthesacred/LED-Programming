# Effortless Card Setup Design

## Outcome

The owner remains in Lightweaver Studio from connection through physical discovery, Layout, and final card verification. The local HTTP card page is a small passive bridge utility, never a second task surface.

## Flow

1. **Connect and identify.** Studio verifies the exact card. Firmware update and Wi-Fi setup appear only when they block this phase.
2. **Find and verify lights.** One contained modal guides output selection, physical lighting, count, color ruler, and final-boundary proof. Unsaved measurements cannot be dismissed accidentally.
3. **Build the layout.** Discovery returns to Layout with the bridge alive and the discovered output/count evidence available.
4. **Test and save to card.** Existing install and physical-check contracts remain authoritative. The bridge is released only after a genuine final completion signal or explicit session disconnect.

## Bridge lifecycle

- Studio bridge-only launches include the exact bounded fragment `bridgeUtility=1` and request `popup=yes,width=360,height=180`.
- Firmware enters passive mode on the first verified bridge-only load and after a reload/reboot of that same utility context.
- Ordinary visible card-page launches omit the utility intent, clear persisted passive state, reveal the normal card page, and request a usable window size where the browser permits it.
- Release remains protocol v5 with exact opener, source, origin, active-utility, and allowed-reason checks.
- Mobile and reused named windows may ignore size requests; function and copy cannot depend on dimensions.

## Hardware overview

Replace the five equal implementation steps with four outcome phases. Do not present firmware or Wi-Fi as universal milestones. Remove duplicated first-run actions and keep recovery/support tools out of the primary path while initial setup is active.

## Safety and recovery

- Busy configuration, reboot, lighting, and unsaved-record phases block incidental dismissal and disconnect.
- Closing the overlay in a safe phase preserves the bridge and exact prior Studio route.
- Discovery completion returns to Layout without releasing the bridge.
- Failed bridge release preserves the tracked target so the owner can retry or reopen.

## Verification

Behavior is covered by red/green unit and Playwright tests, a production Studio build, focused firmware contracts, an ESP32-S3 build, one desktop/mobile inspection batch, and one Impeccable detector run. Physical-card flashing and deployment remain outside this change.
