# Card provisioning hardening — implemented fixes and production checklist

> Historical implementation record. It includes direct diagnostic steps from
> the 2026-07-20 bench session and is not the current worker procedure or
> shipment evidence. Use [`card-provisioning-audit.md`](card-provisioning-audit.md),
> [`new-card-checklist.md`](new-card-checklist.md), and
> [`deployment-checklist.md`](deployment-checklist.md). The released Studio
> whole-system GPIO 18/full-strip acceptance remains pending.

This document records what the current branch implements. It is not a future implementation plan. The detailed failure analysis and real-card evidence are in `docs/card-provisioning-audit.md`.

## Implemented fixes

### 1. Safe, identity-bound installation

- The production release is accepted only after signature verification, manifest validation, image SHA-256 verification, target/size checks, and merged ESP32-S3 image checks.
- Studio inspects the selected serial target and rejects anything other than an ESP32-S3 with 16 MB flash before erase.
- The stable Lightweaver card ID is derived from the ESP eFuse MAC and bound to the saved commissioning flow.
- A clean install requires explicit erase confirmation, writes a factory image at `0x0`, verifies the write, resets into the app, and always releases the serial transport.
- The project snapshot is saved before erase. An interrupted install is inspected by exact card ID, firmware version, and build ID; Studio does not repeat the flash automatically.

### 2. Authoritative firmware readiness

`/api/status` now reports a versioned provisioning contract with:

- exact card, firmware, and build identity;
- per-boot `bootId`;
- `runtimePhase` (`factory`, `recovering`, or `ready`);
- `configValid` and `knownGoodProject`;
- explicit `commandReady` and `outputReady`;
- project/wiring identity and output/current information.

`commandReady` is true only when the runtime is ready, its config is valid and known-good, the web server and LED outputs are ready, and no restart transition is pending. Normal control and identify endpoints reject unready cards with HTTP 423. A no-op command that affects zero outputs is rejected rather than acknowledged as success.

### 3. Truthful Studio connection state

- Direct HTTP and HTTPS card-page bridge traffic feed one fail-closed link state machine.
- A complete exact status envelope is required; missing fields remain “checking.”
- A reachable factory card is “blank — load a project,” never ready/green.
- Stored pairing is only expected identity, not live evidence.
- Wrong card, firmware version, or build cannot be adopted as the expected card.
- Unpaired cards require an explicit adoption action.
- Direct HTTP checks run every 20 seconds and bridge checks every 5 seconds. Two missed checks clear live readiness.
- A boot or bridge lifecycle change requires two complete envelopes from the same `bootId` before the card becomes connected again. Stale/out-of-order responses cannot complete that proof.

### 4. Recoverable Wi-Fi handoff

- The commissioning record survives leaving the factory AP.
- Setup copy distinguishes `Lightweaver-XXXX`/`192.168.4.1` from the permanent LAN address.
- On `http:`/`file:` Studio origins, background discovery continues after the AP drops.
- Auto-advance requires the expected card identity, firmware/build, and `wifi.transport: "station"`; a response still in AP mode is insufficient.
- The discovered LAN host is committed only after the exact identity check, preventing a stale probe from overwriting a newer pairing.
- On the public HTTPS Studio, commands continue through the local card page because browsers block direct HTTPS-to-local-HTTP control. No account or cloud relay is introduced.

### 5. Safe factory life signal and GPIO discovery

- Factory defaults contain zero normal project outputs, looks, and zones.
- A genuinely blank card cycles a bounded factory beacon across the approved GPIO set: 16, 17, 18, and 21.
- Each step emits two short amber pulses on at most eight pixels, with bounded brightness and a 100 mA factory limit.
- Beacon output yields to Wi-Fi transitions, streaming, candidate wiring, safe discovery, recovery, and commands.
- The erased-card NVS hot loop found on real hardware is fixed: absent keys are checked without noisy reads and safety state is sampled at a bounded interval.
- Pin discovery tests one GPIO at a time, reports the exact active pin/step, requires an operator observation, and does not persist that test as project wiring.

### 6. Transactional project load and read-back

- A fresh exact command-ready status is required immediately before project restoration.
- Wiring-changing configs are staged under a card-issued activation ID.
- Studio independently reads candidate status and requires the exact activation ID, card/build, project revision/fingerprint, production identity when present, wiring revision/digest, outputs, color order, and current limit.
- Durable, fenced restore leases prevent two tabs or uncertain retries from performing duplicate mutations.
- Candidate activation may reboot. Studio treats a dropped activation response as ambiguous and resolves it by polling the card-owned transaction after reconnect.
- Candidate storage, activation, confirmation, rollback, and promotion are identity-bound and power-loss-aware.
- Promotion journals the previous known-good config; rollback restores it and removes the bootable candidate marker safely.
- NVS corruption and unsafe SD/NVS ambiguity fail into recovery instead of silently appearing ready.

### 7. Guided physical verification and safe promotion

- The project initially runs as a temporary candidate, not as permanent known-good wiring.
- Studio starts the exact candidate light test only while holding fresh link/boot/flow authority.
- “Yes, the lights are correct” confirms that activation ID and promotes it.
- “No lights” rolls that activation ID back and returns commissioning to setup.
- If a test is interrupted, probation and recovery preserve or restore the previous known-good state.
- After reboot, Studio clears stale authority, waits for two stable ready envelopes from the new boot, and requires a fresh command acknowledgement.
- Physical visibility is intentionally an operator answer. The software never claims an optical result from a transport acknowledgement.

### 8. Recoverable factory reset

- Factory reset requires the explicit `RESET` confirmation token.
- SD removal/availability and NVS clearing are checked fail-closed.
- The endpoint returns HTTP 202 with `pendingVerification`; it does not call the card reset merely because deletion started.
- The card reboots, and only the subsequent factory readiness/beacon evidence proves the reset result.

## Automated coverage

The current tests cover the important production contracts at multiple levels:

- release signature/digest, image shape, chip/flash target, flash plan, serial release, and interrupted-install behavior;
- readiness normalization, blank/checking/ready UI states, identity mismatch, unsupported or incomplete contracts;
- direct and bridge misses, reboot/lifecycle revalidation, two-envelope stability, and stale/out-of-order responses;
- station-only Wi-Fi auto-advance and wrong-card/build rejection;
- fresh mutation preflights, cross-tab fencing, uncertain restoration, and exact independent read-back;
- candidate stage/activate/confirm/rollback, probation, power-loss promotion, recovery, and current-limit evidence;
- factory defaults, beacon limits/ownership, sequential supported GPIOs, NVS polling regression, and reset failure modes;
- Playwright commissioning screens for the resumable Wi-Fi, project-load, light-check, blank-card, link-loss, and restart states;
- native firmware policy tests and ESP32-S3 PlatformIO build verification.

Mocks and source-contract tests prove software decisions and request ordering. They do not prove that a physical LED emitted light; that evidence is supplied by the real-card acceptance run and the operator checklist.

## Remaining production risks

These are the real gaps after the current hardening work:

1. **No immediate post-flash application heartbeat in the Web Serial screen.** The image write is verified, but application boot is proved later by the beacon or LAN status. Do not label the card alive at byte-write completion.
2. **Unknown DHCP address when mDNS fails.** Studio does not scan the LAN. Preserve the card's learned IP/hostname or provide the IP manually when `lightweaver.local` is unavailable.
3. **HTTPS bridge re-establishment after Wi-Fi switching.** The public site cannot directly contact local HTTP. Reopen the local card page after the card joins permanent Wi-Fi if the bridge does not reconnect itself.
4. **Human visual judgement.** There is no optical/current sensor proving which external pixels emitted light. The operator must confirm the eight-pixel discovery signal and full-strip project result honestly.
5. **Batch evidence.** One card completed the exact real-hardware acceptance flow. Production confidence still requires running the same checklist across multiple blank cards and recording failures by step.

## New-card checklist for a non-engineer

Use one checklist per physical card. Do not skip a failed item and do not hand off a card on the strength of a green board LED or a “request sent” message.

### Before flashing

- [ ] Open the correct finished Studio project and confirm its intended pixel count, color order, current limit, looks/zones, and artwork name.
- [ ] Connect only the card being commissioned by a USB data cable.
- [ ] In Studio, choose **Install Lightweaver** and select the serial device.
- [ ] Confirm Studio identifies an **ESP32-S3 with 16 MB flash** and shows a Lightweaver card ID.
- [ ] Write the card ID on the job/traveler before erasing.
- [ ] Confirm the clean erase warning only after the correct project has been saved.

### Flash and prove factory boot

- [ ] Start the install and wait until the verified write completes and USB is released.
- [ ] Do not call the card alive yet. Wait for the external strip to show **eight dim amber pixels, two pulses at a time**, or for verified runtime status.
- [ ] If the green board LED is on but no amber strip pixels ever appear, stop and check strip power, shared ground, data direction, connector, and the supported GPIO wiring. Do not continue as success.

### Join permanent Wi-Fi

- [ ] Join `Lightweaver-XXXX` in the computer/phone Wi-Fi settings.
- [ ] Open `http://192.168.4.1` while joined to that setup network.
- [ ] Enter the permanent gallery/home Wi-Fi and submit it.
- [ ] Return the computer/phone to the permanent Wi-Fi.
- [ ] Return to Studio and wait for the exact written card ID to appear on the LAN.
- [ ] If using `led.mandalacodes.com`, open/reopen the local card page when Studio requests the bridge.
- [ ] Do not proceed while Studio says checking, reconnecting, wrong card, wrong firmware/build, or unreachable.
- [ ] Confirm Studio says the expected card is **blank / needs project**, not ready.

### Find the LED data GPIO

- [ ] Start the guided wire discovery.
- [ ] Test GPIO 16 and answer **Yes** only if the expected eight amber pixels pulse on the intended strip; otherwise answer **No**.
- [ ] If needed, repeat for GPIO 17, then GPIO 18, then GPIO 21.
- [ ] Record the one GPIO that physically lit the intended strip.
- [ ] If none lights, stop. Check electrical wiring and power; do not invent a pin or mark the card connected.

### Load and test the real project

- [ ] Update/confirm the Studio project uses the observed GPIO.
- [ ] Confirm the intended pixel count, color order, and current limit once more.
- [ ] Choose **Load project** and wait for Studio to stage and independently read back the exact candidate.
- [ ] Start the temporary light check.
- [ ] Inspect the physical strip: the full intended pixel count must light, the displayed colors/order must be correct, and the project look must animate as expected.
- [ ] If anything is dark, short, reversed, or the wrong color, choose **No lights / not correct** so Studio rolls back. Correct the project or continue diagnosis, then restage.
- [ ] Choose **Yes, lights are correct** only after personally seeing the correct full strip. This is the physical acceptance record.

### Reboot and handoff

- [ ] Wait for the card to reboot and rejoin permanent Wi-Fi.
- [ ] Wait for Studio to finish checking the new boot; do not use the first response as the pass signal.
- [ ] Confirm Studio reports the expected card as ready/known-good after stable revalidation.
- [ ] Confirm the full-strip project returns automatically after reboot.
- [ ] Send one final pattern/look command and confirm both that the exact card acknowledges it and that the strip visibly responds.
- [ ] Record: card ID, firmware/build, LAN hostname/IP, GPIO, pixel count, color order, current limit, project/job identity, operator name, and date.
- [ ] Hand the card to the customer only when every box above is checked.

## Real-card reference result

The acceptance card for this branch was `lw-b0fe81f61b44` (MAC `44:1b:f6:81:fe:b0`, LAN `192.168.18.70`). It was fully erased and flashed; displayed the factory eight-pixel/two-pulse amber beacon; was reflashed after the factory NVS hot-loop fix; identified GPIO 18 after negative observations on GPIOs 16 and 17; staged a 44-pixel, GRB, 1500 mA Aurora project; received a human full-strip pass; promoted the project; rebooted into a new boot ID; produced two stable ready envelopes; accepted a post-reboot command; and received a second human full-strip pass after reboot.
