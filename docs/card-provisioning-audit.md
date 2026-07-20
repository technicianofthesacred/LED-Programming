# Lightweaver card-provisioning audit

## Scope and acceptance rule

This audit describes the current ESP32-S3-only production path on this branch. Studio may reach a card by direct LAN HTTP when Studio is served from `http:` or `file:`, or through the local card-page `postMessage` bridge when Studio is served from `https://led.mandalacodes.com`. The public site is not a cloud control plane and the customer/gallery path remains zero-login.

The governing rule is:

> A transport connection is not a usable card. “Connected” requires the expected card identity and a complete, current readiness envelope proving that the running firmware can accept commands and drive its configured outputs.

The current branch implements that rule. One real card completed the hardware acceptance sequence described below. The remaining risks are listed explicitly; this document does not treat human visual confirmation as automated sensing.

## End-to-end audit

### 1. Select the card and flash firmware

#### Intended production step

1. Studio saves the project that must be restored after a clean install.
2. The operator selects the serial device.
3. Studio inspects the target before erase, derives the stable card ID from the ESP eFuse MAC, and accepts only an ESP32-S3 with 16 MB flash.
4. Studio verifies the production release manifest signature, target, image size, image SHA-256, merged-image structure, and ESP image magic.
5. After explicit erase confirmation, Studio performs a full-chip erase, writes the merged factory image at address `0x0`, verifies the flash write through esptool-js, resets into the application, and releases the serial port.

#### Failure modes and prior success assumptions

- The selected serial port could be a different USB device.
- A missing firmware URL could return an HTML page with HTTP 200.
- A truncated, altered, unsigned, wrong-target, app-only, or wrong-address image could erase a working card and leave it unbootable.
- A write could fail while the browser retained the serial port.
- “The bytes were written” could be mistaken for “the application booted and is serving its runtime API.”
- A browser interruption could cause Studio to repeat a destructive install whose outcome was unknown.

#### Implemented verification

- Hardware inspection must report the exact supported chip and flash size before erase.
- The release loader verifies signature and image digest before installation; the flash plan rejects implausible or incomplete factory images.
- The flash writer supplies an MD5 implementation to esptool-js, and the serial transport is released on success or failure.
- The commissioning record binds the saved project to the derived card ID, firmware version, build ID, and exact install operation.
- An interrupted flow reconnects and inspects the exact card/build; it does not automatically flash again.

#### Remaining risk

The Web Serial UI records flash completion after verified write/reset, before it has received a runtime `/api/status` envelope from the newly booted application. The later network stage does verify the running application before any project mutation, and the factory beacon provides a visible boot signal, but the flash screen itself does not yet provide an automated post-reset application heartbeat. Production wording and the operator checklist must therefore reserve “card alive” for the beacon or runtime status, not for write completion alone.

### 2. Boot blank, show life, and join permanent Wi-Fi

#### Intended production step

1. An erased card boots with no normal project outputs, looks, or zones.
2. It advertises `Lightweaver-XXXX` and serves setup at `http://192.168.4.1`.
3. While genuinely factory blank, it cycles a deliberately bounded beacon over supported output GPIOs 16, 17, 18, and 21: no more than eight amber pixels, two short pulses per step, at bounded brightness and current.
4. The operator joins the setup network and enters the permanent Wi-Fi credentials.
5. The card leaves its AP and joins the permanent LAN.

#### Failure modes and prior success assumptions

- Factory defaults could create a normal-looking LED configuration on the wrong pin, leaving the real strip dark while the API still accepted commands.
- A green board LED could be mistaken for proof that the external strip and its data path work.
- Reading absent NVS keys on every beacon frame could flood serial logs and consume runtime time on a freshly erased card.
- The card could leave the AP before Studio saved enough progress to recover.
- Studio could continue pointing at `192.168.4.1` after the AP disappeared.
- A card answering at a familiar hostname could be the wrong physical card.

#### Implemented verification

- Factory defaults are explicitly `runtimePhase: "factory"`, `knownGoodProject: false`, and `commandReady: false`; normal control and identify requests fail closed with HTTP 423.
- The beacon is separate from normal project output. Its pin list, pixel count, brightness, current limit, timing, and output ownership are bounded in firmware policy.
- Beacon ownership stops during command activity, Wi-Fi transition, candidate activation, discovery, streaming, or recovery so it cannot fight another output source.
- Missing NVS keys are checked without triggering `Preferences.getString()` errors, and beacon safety state is polled at a bounded interval rather than on every 10 ms frame.
- Commissioning progress is persisted across the network switch.
- On direct-capable Studio origins, a background poll looks for the expected card and advances only when `/api/status` reports station transport plus the exact card ID, firmware version, and build ID. An AP-mode response cannot satisfy this gate.

#### Remaining risks

- Direct LAN discovery tries card-specific hostname/address hints, remembered addresses, `lightweaver.local`, and `192.168.4.1`; it does not scan an unknown subnet. If mDNS fails and DHCP gives a never-seen address, an operator must supply or discover that address.
- A public HTTPS page cannot directly poll an HTTP card because of browser mixed-content rules. At `led.mandalacodes.com`, the local card page is the bridge. After a Wi-Fi transition, the bridge must be reopened or re-established before Studio can receive verified status. This is an intentional browser boundary, not evidence that the card is offline.

### 3. Recognize the exact card and decide whether it is usable

#### Intended production step

Studio reads a versioned readiness envelope containing at least:

- `app`, `cardId`, `firmwareVersion`, and `buildId`;
- a per-boot `bootId`;
- `provisioningContractVersion`;
- `runtimePhase`;
- explicit booleans for `knownGoodProject`, `commandReady`, and `outputReady`.

The expected card ID and firmware/build must match. A factory card remains reachable but is presented as blank/needs a project. It is not presented as ready.

#### Failure modes and prior success assumptions

- TCP/HTTP or bridge handshake success could be shown as green “Connected.”
- A paired identity stored in `localStorage` could be treated as live readiness.
- A partial or old status payload could default missing readiness fields to true.
- Studio could silently adopt the first Lightweaver card found on a shared LAN.
- A different firmware build at the same address could be accepted.
- A reboot could leave stale readiness and output state visible in Studio.

#### Implemented verification

- Readiness booleans must be actual booleans; missing or malformed evidence stays “checking.”
- Unsupported contract, invalid identity, incomplete evidence, wrong card, wrong firmware version, or wrong build cannot become connected.
- Factory or non-known-good state is classified as blank even when reachable and paired.
- Unpaired discovery is an explicit operator adoption step; passive discovery does not overwrite an existing pairing.
- Both direct HTTP and bridge paths use the same readiness classifier and preserve the same fail-closed states.
- `bootId` changes cause revalidation rather than immediate reconnection.

### 4. Stay truthful through drops, resets, and transport changes

#### Intended production step

Once paired, Studio continuously proves the card remains the same usable runtime. Direct HTTP is polled every 20 seconds; the bridge is pinged every 5 seconds. Two misses clear live authority and move the link into recovery rather than leaving a green state behind.

#### Failure modes and prior success assumptions

- Card power loss, Wi-Fi loss, crash, or reset could leave Studio showing connected indefinitely.
- The first reply after a miss could be stale or arrive out of order across a reboot.
- One successful bridge lifecycle event could be mistaken for command readiness.
- A mutation could start using readiness that became stale between rendering the button and sending the request.

#### Implemented verification

- Misses clear readiness, acknowledgement time, and mutation authority.
- Recovery requires two complete status envelopes with the same candidate `bootId`; one reply is insufficient.
- Responses from an older or different boot cannot complete another boot's stable pair.
- A bridge lifecycle change also clears readiness and requires stable revalidation.
- Commissioning restore and light-check mutations perform a fresh status read immediately before mutation and bind the operation to the current host, validated boot ID, link generation, commissioning flow, and a short-lived fenced lease.
- If identity, boot, generation, or readiness changes, the mutation is refused with “nothing was changed.”

#### Remaining risk

Detection is bounded by the polling intervals and two-miss policy; Studio may take roughly one direct polling cycle plus retry, or two bridge ping failures, to demote an idle link. This is deliberate tolerance for transient LAN loss. Command-time commissioning preflights are stricter and do not rely only on the idle indicator.

### 5. Load the project without making unverified wiring permanent

#### Intended production step

1. Studio rebuilds the runtime package from the project snapshot retained before flashing.
2. Immediately before sending, Studio verifies the exact card/build is command-ready on the current boot.
3. A wiring-changing config is stored as a candidate with a card-issued `activationId`, not as known-good.
4. Studio independently reads `/api/wiring/status` and requires the same activation ID plus exact card, firmware/build, project revision/fingerprint, production job identity when present, wiring revision/digest, output layout, color order, and current limit.
5. Activation reboots into a bounded probation state. A lost reboot response is treated as ambiguous; Studio polls the card-owned transaction state after reconnect.
6. Only a successful physical light check promotes the candidate to known-good. “No lights” rolls it back.

#### Failure modes and prior success assumptions

- HTTP 200 from `POST /api/config` could be treated as proof of persistence or activation.
- An interrupted POST could be repeated, producing two different candidates.
- A config could persist while the old output topology remained active.
- Wrong GPIO, pixel count, color order, or current limit could become permanent before anyone saw light.
- Power loss during promotion could leave a corrupt mix of candidate and known-good data.
- SD/NVS corruption could silently fall back to an unrelated config or factory defaults.

#### Implemented verification

- Runtime configs are size-bounded and strictly validated before storage.
- Wiring changes use staged, booting, awaiting-confirmation, confirmed, or rollback states with activation-ID matching.
- The candidate read-back is independent of the POST response and exact to the saved commissioning project.
- A durable restore claim and recorded attempt prevent tabs or retries from sending the same uncertain mutation twice.
- Promotion journals the previous known-good config and restores it on failed/incomplete promotion; candidate state is cleared before destructive cleanup on rollback.
- Boot loading treats NVS read/type/metadata failures as recovery, not as success, and only permits SD fallback under explicit safe conditions.
- Normal runtime commands are admitted only when `runtimePhase` is ready, the config is valid and known-good, the web server and LED outputs are ready, and no restart transition is pending.
- Operation acknowledgements identify the card/boot, report the affected output scope/count, and reject commands that affect zero outputs.

### 6. Discover the output and perform the physical light check

#### Intended production step

For an unknown connector pin, Studio/firmware tests one approved GPIO at a time. Each discovery step persists only a temporary discovery marker, reboots into a bounded eight-pixel amber pulse on that one GPIO, and does not persist project wiring. The operator answers whether the expected pixels lit. After the matching GPIO is known, Studio stages and activates the real project, then asks the operator whether the full strip is visibly correct.

#### Failure modes and prior success assumptions

- Testing every output concurrently could create electrical contention or make the observed pin ambiguous.
- An API acknowledgement could be mistaken for proof that photons appeared.
- Seeing only eight factory pixels could be mistaken for a completed 44-pixel project.
- The operator could confirm the wrong strip, wrong count, or wrong color order.
- A failed light check could strand the card on temporary wiring.

#### Implemented verification

- Discovery is sequential across GPIO 16, 17, 18, and 21 and bounded to eight dim amber pixels.
- Discovery state reports the exact step/pin and remains separate from project persistence.
- Project activation is an exact, ID-bound temporary transaction with reconnect polling.
- “Yes, lights are correct” calls the confirm endpoint; “No lights” calls rollback and returns the flow to setup.
- Candidate probation and recovery endpoints protect the previous known-good state when a test times out or is interrupted.
- After promotion and reboot, Studio requires a new `bootId`, two stable ready envelopes, and a fresh acknowledged command before the card can be treated as ready for handoff.

#### Remaining risk

The ESP32 has no optical sensor and this hardware does not measure whether the external strip emitted the requested pattern. The final light result is therefore a human observation. Software can prove which command and configuration were active, but it must never convert an HTTP acknowledgement into “lights verified.” Production records and handoff must retain the operator's explicit physical answer.

### 7. Handoff

A card is customer-ready only after all of these independent facts are present:

- exact card ID and expected firmware/build;
- known-good project identity and wiring read-back;
- current-limit and output configuration;
- human-confirmed full-strip light result;
- successful reboot with a changed boot ID;
- two stable post-reboot ready envelopes; and
- a post-reboot command acknowledgement from that exact card/boot.

The board's green power LED, a serial write completion, a bridge handshake, a single status response, or a control HTTP 200 by itself is not a handoff gate.

## Assumptions that are no longer permitted

| Old assumption | Current required evidence |
| --- | --- |
| Serial write completed, therefore firmware is running | Verified write plus later factory beacon or runtime status |
| AP disappeared, therefore setup succeeded | Expected identity reporting station transport on the LAN |
| A Lightweaver answered, therefore it is our card | Exact stored card ID, firmware version, and build ID |
| Paired or reachable means connected | Complete current readiness contract with ready/known-good/command/output truth |
| One post-reset response is enough | Two complete envelopes for the same new `bootId` |
| Config POST returned 200, therefore the project is installed | Card-issued activation ID plus independent exact candidate read-back |
| Activation response dropped, therefore activation failed | Reconnect and query card-owned transaction state |
| Command was acknowledged, therefore LEDs lit | Explicit human observation of the physical strip |
| Green board LED means strip data works | Factory/discovery beacon or full-project light check |

## Real-card acceptance evidence — 2026-07-20

This session used one physical card and strip:

- Card ID: `lw-b0fe81f61b44`
- ESP eFuse MAC: `44:1b:f6:81:fe:b0`
- LAN address after setup: `192.168.18.70`

Observed sequence:

1. The exact serial device was selected, fully erased, and flashed with the current development firmware.
2. On the erased factory boot, the operator saw the intended eight-pixel, two-pulse amber beacon. This was a human observation.
3. Serial monitoring exposed repeated reads of absent known-good/candidate NVS keys in the factory beacon loop. The code was fixed to avoid missing-key reads and to bound safety polling, then rebuilt and reflashed. The recurring error storm was absent after reflash.
4. The card joined the LAN and answered at `192.168.18.70` as the exact card ID above. It truthfully reported blank/not command-ready before a project was known-good.
5. Sequential discovery produced these human answers: GPIO 16 — no; GPIO 17 — no; GPIO 18 — yes. Each positive/negative result was supplied by the operator, not detected by software.
6. A project candidate for GPIO 18, 44 pixels, GRB order, 1500 mA limit, and the Aurora look was staged and read back.
7. After temporary activation, the operator confirmed that the full 44-pixel strip was visibly lit and animating. This was a human observation.
8. The exact candidate was promoted to known-good.
9. The card rebooted, reported a new `bootId`, returned two stable command/output-ready envelopes, and accepted a fresh post-reboot command.
10. The operator confirmed the full-strip Aurora pattern returned after reboot. This was a human observation.

This is strong acceptance evidence for the firmware, LAN API, transaction, GPIO discovery, persistence, restart, and physical strip path on that card. It is not an automated optical test, and it is not yet statistical evidence across a production batch. Repeating the checklist on multiple blank cards remains the production repeatability test.
