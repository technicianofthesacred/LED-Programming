# Lightweaver Card Provisioning Pipeline Audit

## Executive Summary

The card-provisioning flow for Lightweaver has **four critical steps**, each with **specific failure modes that create dead ends or false-success states**. This audit maps each step, its assumptions, the ways it can fail silently, and the fixes needed to make the entire flow repeatable and bulletproof.

**Status:** Two in-progress fixes address the most visible failures (false "connected" state and setup-screen dead-end on network join). Three additional failure classes remain: factory-default LED dark output, card-silent-drop-while-paired, and incomplete wiring verification.

---

## Step 1: Flash Firmware over USB

### The flow
1. User plugs card into computer via USB data cable
2. Studio (React) loads Web Serial API and lists COM ports
3. User selects the correct card and clicks "Install"
4. Firmware binary (1.0.0 or current release) is streamed into flash
5. Card reboots to factory defaults, broadcasts `Lightweaver-XXXXX` AP
6. Studio signals: "Setup complete, card is ready"

### Failure modes (not yet fixed)
- **No hardware handshake.** The User doesn't know which COM port is the card; any USB device shows up. Selecting the wrong one writes garbage into non-LED-controller firmware, bricking a different device. **Fix:** Web Serial API includes USB product IDs; filter to only devices with known Lightweaver board signatures.
- **No post-flash verification.** Studio claims "install succeeded" as soon as bytes finish; card may have died mid-flash or hit a corruption bug. Installer has no proof the card is alive. **Fix:** After writing, Web Serial should ping the card's bootloader or wait for a heartbeat signal over USB (requires firmware cooperation).
- **Async USB error swallowed.** On some browsers/OS combos, a disconnect during flash doesn't bubble up until too late. Code only checks for a specific error type. **Fix:** Wrap Web Serial writes in a promise-with-timeout so a silent drop is caught as an error, not a success.

---

## Step 2: Card joins home WiFi and drops AP

### The flow
1. Card boots factory firmware, broadcasts `Lightweaver-XXXXX` AP with a captive portal
2. User joins the card's AP
3. Captive portal shows a form: "Home WiFi network, password"
4. User enters home network SSID + password
5. Card connects to home network and **drops the AP**
6. Card is now reachable as `lightweaver.local` (mDNS) or a static IP
7. Studio's setup wizard should detect this and auto-advance
8. **→ This step is now FIXED by commit f1652e1** (background LAN poll auto-detects card joining home network)

### Remaining failure mode
- **No fallback if mDNS fails.** `lightweaver.local` relies on mDNS, which is unreliable on corporate networks, VPNs, and some mobile hotspots. If the user is on such a network, the card is reachable only by static IP, but Studio has no way to know what that IP is. **Fix:** Card's captive portal should display its IP address on the success screen; Studio should accept both hostname and IP input from the user as a fallback.

---

## Step 3: Studio pairs the card and checks its project state

### The flow (Commissioning / Connection Honesty)
1. Studio detects the card reachable on LAN (after Step 2)
2. Studio calls `GET /api/status` to get card identity (cardId, firmwareVersion, buildId)
3. **Card state check (NEW in commit a680454):**
   - If `source: 'internal-flash'` (factory default): card is **blank**, show "Needs project — install"
   - If paired before: card is **reachable**, show "Found — pair" if not yet paired
   - If paired + has project: card is **ready**, show "Pair and load"
4. User pairs the card (one-click acceptance)
5. Studio stores the card identity in localStorage as the "expected card"
6. **→ This step is now FIXED by commit a680454** (distinction between blank, paired, and ready; card-blank detection)

### Remaining failure modes
- **No heartbeat while paired.** After pairing, Studio marks the card "ready" but never re-checks it. If the card loses power or the WiFi drops, Studio still claims it is paired and ready, leading to a silent command failure when the user tries to control it. **Fix:** Studio should poll `/api/status` every 10-30s while idle; if the card stops answering, drop from "ready" to "reconnecting"; surface the reconnect state to the user.
- **No distinction between silent drop and intentional leave.** The card can crash and reboot, or the user can unplug it, but Studio can't tell which. Both result in the same "card stopped answering" state, so the user can't recover from a crash without re-pairing. **Fix:** On resume, Studio checks if the card's firmware/build/id match the stored identity; if yes, auto-resume without re-pairing; if no, ask to re-pair.

---

## Step 4: Push project to card and verify installation

### The flow
1. Studio has a project (strips, zones, pixel counts, wiring)
2. User clicks "Send to card" or "Install project"
3. Studio calls `POST /api/config` with project snapshot (zones, wiring)
4. Card stores project into NVS (non-volatile storage)
5. **New card state (from commissioning flow):**
   - Card computes project fingerprint and stores revision + digest
   - Card responds with `{ ok: true, requiresReboot: false }`
6. **Verification gap (NOT YET FIXED):**
   - Studio never reads back the project to confirm card got it
   - Card is now running the new project but could be in any output-pin state
   - If wiring is wrong (GPIO 16 vs 17, or pixel order), the strip stays dark or lights the wrong pixels
   - User has no way to know without manually reading `/api/firmware-info` and comparing
7. **Light check (new in design):**
   - Before handing the card to the customer, Studio guides through a "light test" to verify physical wiring
   - User can send a test pattern and watch the strip light up
   - If dark: wiring is wrong, GPIO is wrong, or hardware failed
   - If lit but wrong pixels: pixel order is wrong, count is wrong, or strip connector is reversed

### Failure modes (NOT YET FIXED)
- **No readback after config push.** Studio sends the project but never asks the card to confirm it persisted correctly. Card stores correctly but Studio has no proof. **Fix:** `POST /api/config` response should include the persisted fingerprint + revision; Studio checks it matches what was sent.
- **Factory-default output pin unlit.** The card has factory defaults for GPIO (often pin 0), which is not where the customer wired their strip. Command reaches the card but lights nothing (wrong GPIO). User sees a blank strip and gives up. **Fix:** On first boot to factory defaults, card should light a brief test pattern on **all GPIO outputs in a round-robin** so the customer can see the card is alive and pinpoint which GPIO the strip is connected to.
- **Wiring saved but never activated.** The project is in NVS but the card's running state might still be the old project (if the card didn't reboot). A reboot is required but Studio doesn't enforce it and doesn't know whether the card is running the new config or the old one. **Fix:** Card's `/api/status` response includes a `wiringRevision` counter; Studio checks it matches the sent revision before proceeding; if not, Studio shows "Card needs to restart to load your project."
- **Silent wiring corruption on reboot.** If power is lost during the config write, the NVS might end up corrupted. Card reboots to factory defaults silently, and Studio has no way to know. **Fix:** Card should validate NVS on boot and respond with an error if fingerprint doesn't match expected revision; Studio checks this on every status read and marks the card as "needs recovery."
- **No independent confirmation of wiring.** Studio pushes the wiring but never asks the card to read it back independently (a separate GET request) to prove the card actually persisted it before the user leaves the studio. **Fix:** After `POST /api/config`, Studio should immediately call `GET /api/firmware-info` and check that the returned `projectFingerprint` matches what was sent.

---

## Step 5: Light Check (In-Studio Verification)

### The flow (Card + Commissioning Test)
1. Card is now on home network with project loaded
2. Studio opens the "Test & Install" screen (Wire mode Phase 3)
3. User is guided to power on the physical strip and observe
4. Studio sends a test pattern to light up specific zones/pixels
5. User confirms: "I see lights" or "No lights" or "Wrong pixels"
6. If all green: card is handed to customer
7. If red: debugging (check GPIO, check wiring, check pixel count)

### Failure modes (NOT YET FIXED)
- **No automated light check.** The test is manual; Studio sends patterns but relies on the user to *squint at the strip* and say "yes I see it." If the strip is in a dark room or the user is colorblind, this fails. **Fix:** Studio should ask the card to light a distinct, bright test pattern; card should report success/failure (via a status LED or a response). Then Studio can autonomously verify without user judgment.
- **Test pattern can't reach dark-wired GPIO.** If the wiring is on GPIO 16 but the factory default was GPIO 17, the test pattern goes to GPIO 17 and the user sees nothing, thinks the card is dead, and doesn't proceed. **Fix:** Before the test, Studio should query `/api/firmware-info` to learn which GPIO the card thinks the strip is on; if it doesn't match the sent wiring, Studio should refuse the test and ask to re-send the wiring.
- **No feedback loop from card about wiring state.** Card could measure strip current draw or use capacitive sensing to detect "is a strip actually connected to this GPIO?" but doesn't. Studio can't tell if the user actually wired anything. **Fix:** Card should optionally report GPIO connection status in `/api/status` (requires firmware change).
- **Light check can be skipped.** There's no gate forcing the user to actually perform the light check before handing the card to the customer. User could skip it and hand over a non-working card. **Fix:** Commissioning flow should mark wiring as "staged" (pending physical check) and "activated" (physically verified); only "activated" cards can be marked complete.

---

## Summary of Failure Classes

| Failure | Symptom | Current Status | Fix Complexity |
|---------|---------|-----------------|------------------|
| False "connected" state | Studio claims card ready when it's blank/paired/disconnected | **FIXED (a680454)** | Done |
| Setup wizard dead-end on network join | User joins AP, card goes to home WiFi, wizard stuck | **FIXED (f1652e1)** | Done |
| Factory default dark output | User sees no lights, thinks card is dead | NOT FIXED | Medium |
| Card silent-drop while paired | Studio claims ready, user tries to control, command fails | NOT FIXED | Low |
| No post-flash verification | Installer claims success without checking card is alive | NOT FIXED | Medium |
| No readback after project push | Project sent, no proof card persisted it | NOT FIXED | Low |
| Wiring state ambiguous | Card running old project vs new project, user doesn't know | NOT FIXED | Low |
| Light check manual & skippable | Test relies on human eye, can be skipped | NOT FIXED | Medium |
| mDNS unreliable on corporate/VPN | Card unreachable as `lightweaver.local`, user stranded | NOT FIXED | Low |

---

## Remaining Work: Priority Order

1. **Card silent-drop detection** (Low complexity, high impact) — Poll `/api/status` every 20s; drop from "ready" to "reconnecting" if card stops answering; surface to user.

2. **Post-flash heartbeat verification** (Medium complexity, high impact) — After Web Serial write, wait for card to respond over USB or HTTP before claiming success.

3. **Factory default light check on first boot** (Medium complexity, high impact) — Card cycles GPIO outputs on boot to prove it's alive and let user identify the correct GPIO.

4. **Wiring readback verification** (Low complexity, medium impact) — After `POST /api/config`, read `/api/firmware-info` to confirm fingerprint persists.

5. **mDNS fallback (static IP input)** (Low complexity, low impact) — Captive portal displays IP on success; Studio accepts both hostname and IP in setup wizard.

6. **Card connection status in `/api/status`** (Medium complexity, medium impact) — Report GPIO connection status (requires firmware change).

7. **Automated light test with card feedback** (High complexity, medium impact) — Card reports wiring-test success/failure; Studio gates on it before handoff.

---

## End-to-End Checklist for a New Card

After this audit is complete and fixes are implemented, the checklist a non-engineer would follow to commission a blank card:

```
[ ] 1. Plug card into computer via USB
[ ] 2. Click "Install current Lightweaver firmware"
[ ] 3. Wait for: "Firmware installed, card ready"
[ ] 4. Power the card (if separate power required)
[ ] 5. Join the card's WiFi hotspot (Lightweaver-XXXXX)
[ ] 6. Wait for: "Card detected on home network" (auto-advance)
[ ] 7. Unplug USB, set card on final location
[ ] 8. In Studio, click "Send project to card"
[ ] 9. Wait for: "Project installed, revision X confirmed"
[ ] 10. Power on LED strip, connect to card's GPIO
[ ] 11. In Studio, click "Test lights"
[ ] 12. Watch: Card cycles through output pins
[ ] 13. Mark: "Lights visible on GPIO [__]"
[ ] 14. Confirm: "Wiring test passed"
[ ] 15. Hand card to customer with printable recovery card
```

