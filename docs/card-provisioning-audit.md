# Lightweaver card-provisioning audit

## Scope and release status

This is the ESP32-S3-only production path. Studio runs at
`https://led.mandalacodes.com`; commands stay on the local network through the
card-page bridge. A Studio served over plain local HTTP may use direct LAN HTTP,
but direct requests, a terminal, and typed card addresses are diagnostics, not
the worker flow or shipment evidence. The gallery remains zero-login.

The invariant for every screen and mutation is:

> Reachable, paired, flashed, or acknowledged is not connected. Green/connected
> requires the expected physical card, a current complete status contract, two
> fresh envelopes from one boot and bridge lifecycle, and command/output
> readiness. A reachable factory card is **Blank — load a project** and never
> green.

Firmware source and automated contracts on this branch implement the
deterministic network handoff and recovery described below. The USB identity
ingress fix is already signed and deployed: on the real card, esptool MAC
`44:1B:F6:81:FE:B0` resolves to the firmware/LAN identity
`lw-b0fe81f61b44`, and live Studio showed that exact ID.

The subsequent dead end was reproduced at the serial protocol level. USB
inspection left the ESP32-S3 in its ROM downloader after the card briefly
started. The source fix releases GPIO0, arms the S3 RTC watchdog, closes USB
without another control-line transition, and treats fresh exact-card LAN
evidence—not a serial response—as the restart authority. The real card returned
at its station address with a new boot ID in about nine seconds and truthfully
reported a blank, non-command-ready project. Studio's source flow now also
accepts an already verified exact station card for firmware inspection instead
of forcing it back through a nonexistent setup AP.

Those fixes still require a new protected signed firmware release, a live
Studio deployment, and one uninterrupted erased-card acceptance. No factory
beacon, guided boundary, Aurora, or recovery light result was visually verified
in the diagnostic recovery. Source correctness and API readback are not
shipment evidence.

## Full-flow audit

### 1. Select one card and flash the signed factory image

**Required flow.** Production Setup loads an immutable job, verifies the signed
firmware release, asks the worker to select one USB serial device, derives the
stable card ID from the ESP eFuse MAC, validates ESP32-S3/16 MB hardware, erases
the chip, writes the merged factory image at `0x0`, verifies the write, resets,
and releases USB.

**Failure modes and former assumptions.** The chooser can select the wrong USB
device. A firmware URL can return HTML with status 200. An unsigned, altered,
truncated, wrong-target, app-only, or stale image can be written. A serial
disconnect can leave the result unknown. A verified write can be mistaken for
a running application. Retrying an ambiguous erase/write can repeat a
destructive operation.

**Verification replacing assumption.** Studio validates manifest signature,
target, image size, SHA-256, merged-image structure, and ESP image magic before
erase. The inspected eFuse identity is bound to the immutable production run.
At USB ingress, the esptool MAC bytes are converted to the firmware's canonical
order: `44:1B:F6:81:FE:B0` must become `lw-b0fe81f61b44`, not
`lw-441bf681feb0`. Browser Web Serial and the native bridge have regression
coverage for this mapping, and the deployed Studio verified the exact real-card
ID.

The writer uses esptool verification and releases the port on every exit.
Resume inspects the same card/build instead of blindly flashing again. “Flash
written” is not “card alive”: the next gate requires the factory beacon or a
fresh runtime status from that exact card.

**Root cause and correction.** Exact USB identity passed, but the original reset
sequence briefly booted the app and then sampled the download strap again,
leaving the ESP32-S3 at `DOWNLOAD(USB/UART0)`. The corrected S3 path uses its RTC
watchdog while GPIO0 is released and closes the port without resetting the
signals a second time. A torn serial response is inconclusive; Studio releases
USB and waits up to 30 seconds for fresh exact-card LAN evidence. Failure exits
the busy state with same-card recovery actions. Tests cover restart ordering,
lost reset response, unreachable card page, stale runs, and retained USB
ownership.

**Remaining gap.** This correction must be signed, deployed, and exercised by
the live worker flow after a full erase. Source tests and diagnostic recovery
cannot prove the production browser, cable, application boot, or visible output.

### 2. Prove the factory card is blank and visibly alive

**Required flow.** With no known-good project, firmware reports factory state,
`knownGoodProject: false`, and no normal command/output readiness. It advertises
`Lightweaver-XXXX`. A separate safe beacon tests the approved output pins with
at most eight dim amber pixels and two pulses, so a worker can distinguish a
running blank card from a dead card.

**Failure modes and former assumptions.** Factory defaults can target the wrong
GPIO, making valid commands appear ineffective. A green board LED can be
mistaken for strip output. A normal-looking default can hide that no customer
project is installed. Beacon code can fight a stream or config transaction.
Fresh NVS reads can create a hot error loop.

**Verification replacing assumption.** Factory status is explicit and fails
closed. Normal mutations require the narrower authority appropriate to the
operation; a blank exact card may accept one project configuration but may not
accept ordinary runtime commands. Beacon timing, pins, pixel count, brightness,
current, and ownership are bounded. It yields during setup, discovery,
streaming, candidates, or recovery. Missing-key reads and safety polling are
bounded.

**Visible distinction.** Eight amber pixels prove only the factory beacon path.
They do not prove the 44-pixel project, correct GPIO, color order, or customer
readiness.

### 3. Join Wi-Fi without losing the card

**Required flow.** The worker joins the guided setup hotspot and enters the
gallery/home credentials. Firmware runs AP+STA through explicit phases:
`setup-ap`, `joining`, `handoff-ready`, `station`, `reconnecting`, and
`recovery-ap`. It does not reboot merely to save credentials. The setup AP stays
available until the station API is actually ready and Studio acknowledges the
exact handoff.

The handoff proof contains the exact card ID, boot ID, handoff generation, and
private station IPv4 address. The card-page bridge retargets its one named
window from the AP to that verified station address. Studio acknowledges only
the same identity, boot, generation, and station interface. AP shutdown is
delayed and revalidated after that acknowledgement.

**Failure modes and former assumptions.** “Credentials saved” can be mistaken
for joined. The AP can disappear before Studio learns where the card went. A
setup tab can remain stranded on the dead AP page. An old acknowledgement can
close a new AP lifecycle. Another Lightweaver on the LAN can be adopted. The
listener can fail to bind even though Wi-Fi reports associated.

**Verification replacing assumption.** `202 joining` is progress, not success.
`handoff-ready` requires the station address plus runtime listener readiness.
Acknowledgement is exact and one lifecycle only; malformed, stale, AP-origin,
wrong-boot, wrong-generation, or wrong-card messages fail closed. Same-window
navigation revokes old bridge authority. The worker never types or discovers a
local IP.

**Corrected preflight behavior.** The observed `ERR_NAME_NOT_RESOLVED`, missing
old LAN route, and missing AP were three failed routes, never handoff success.
After the watchdog recovery, the real card returned on its existing station
network. Production Setup now consumes that already verified exact-card station
evidence for preflight; it no longer tries to correlate an old installed build
to the not-yet-installed release's factory AP lifecycle. A card that does not
return still exits the bounded wait and offers exact-card recovery without
advancing.

**Remaining gap.** The live HTTPS path—including popup permission, an actual
blank-card network switch, retarget, and return to the same Studio tab—must pass
on the real card. Direct LAN polling does not substitute for this test.

### 4. Recognize the exact card and classify blank versus usable

**Required evidence.** A complete status envelope includes stable identity and
release fields, per-boot `bootId`, provisioning contract version, Wi-Fi phase
and interface, handoff generation, runtime phase, and explicit
`knownGoodProject`, `commandReady`, and `outputReady` booleans. Studio requires
two fresh, complete, monotonically newer station envelopes from the same boot,
host, operation generation, and bridge lifecycle.

**Failure modes and former assumptions.** HTTP success, a bridge hello, stored
pairing, a remembered host, a partial status object, or one response can all be
shown as “connected.” Stale status can survive a reset or silent network loss.
A previously paired card A can authorize a newly flashed card B.

**Verification replacing assumption.** Missing fields never default true.
Wrong identity/release/boot/lifecycle responses revoke authority. The status
model separates reachability, exact-card presence, blank config-only authority,
and full runtime command readiness. A factory card reads **Blank — load a
project**, not green. Deliberate USB inspection binds a new production run to
that card; stored authority for another card cannot cross the boundary.

### 5. Load exactly one project and independently verify it

**Required flow.** The immutable job for the current physical fixture compiles
one runtime package. For the canonical bench fixture it is GPIO 18, 44 pixels,
GRB, Aurora, 1500 mA, and brightness limit 0.35. Studio obtains a short-lived
operation lease bound to card ID, host, boot ID, bridge lifecycle, operation
generation, job, and flow. The blank card receives one configuration request.
Studio independently reads the installed state and compares job digest,
project revision/fingerprint, wiring digest/revision, outputs, count, color
order, and current limit.

**Failure modes and former assumptions.** POST 200 can be mistaken for installed.
A preflight can accidentally revoke the blank card's one legitimate config
authority. A lost response can cause a duplicate write. A link can change after
button render but before or during mutation. A wiring-changing candidate can be
made permanent before anyone sees the strip.

**Verification replacing assumption.** Blank/config authority is narrower than
runtime-command authority and is consumed atomically by the production push
path. Correlation records are bounded and do not grant broad authority after a
reload. Every mutation checks its lease before and after I/O; lifecycle,
generation, host, boot, flow, or identity change cancels it and cannot produce
a pass. Read-back is independent of the POST acknowledgement. Wiring changes
remain candidate transactions until the physical check confirms them; failure
or timeout restores the last known-good state.

### 6. Prove the physical strip, not merely the API

**Required flow.** Studio sends the bounded guided light frames through the same
verified card-page bridge used in production. The worker observes the real
strip: named output only, first pixel blue, final pixel red, all pixels between
dimly lit, and everything outside the boundary dark. The final Aurora check
must visibly light the complete 44-pixel strip. Only the worker's explicit
answer can complete the physical gate.

**Failure modes and former assumptions.** A delivered frame, HTTP 200, board
LED, factory eight-pixel beacon, browser preview, or a few flickers can be
mistaken for correct light. Wrong GPIO, count, direction, color order, power,
ground, or DATA-IN orientation can leave all or part dark. Network loss during
the frame can leave Studio displaying stale success.

**Verification replacing assumption.** Frame delivery remains distinct from
human observation. The operation lease is checked around every frame and is
invalidated immediately when card-link truth is lost. Loss demotes the footer,
cancels streaming, and cannot create a pass. Temporary corrections are bounded
and roll back unless the real boundary is confirmed.

Pattern, playlist, brightness, color, and frame responses now say only
**Applied by Lightweaver runtime** after exact runtime acknowledgement. They do
not say that LEDs are playing or visible. The card's visitor page hydrates from
the read-only zones snapshot instead of issuing an empty control mutation, so
opening or refreshing the page cannot silently change the strip. The final
warm-white/Aurora result remains a separate human-visible gate.

**Remaining gap.** There is no optical sensor. A human must see and confirm the
entire real strip. The user has not yet reported this succeeding through the
released whole-system flow, so shipment acceptance remains open.

### 7. Power and network recovery

**Required flow.** After pass, power-cycle the finished card. It must return to
the saved Aurora project without Studio assistance, then provide two new status
envelopes for the changed boot before Studio becomes green. During a Wi-Fi
outage, LED playback must continue. Firmware owns deterministic station retry
at 10-second intervals. If still offline, it opens the recovery AP by 60
seconds without erasing the project, and automatically returns to station when
the network returns.

**Failure modes and former assumptions.** SDK auto-reconnect and application
retry can race. A reset can preserve a stale green UI. Recovery AP can erase or
replace known-good output. Listener failure can be called connected. Network
loss can stop local playback.

**Verification replacing assumption.** Firmware has one retry owner and reports
truthful phases. Station readiness includes local control listener readiness.
Studio revokes control authority on misses, reset, or lifecycle change and
requires two new complete envelopes. Recovery does not take LED ownership and
does not discard the project.

**Remaining gap.** The 10-second retry, recovery AP at or before 60 seconds,
continued playback, and automatic LAN return must be timed on the released
real card.

### 8. Record and hand off

A shipment pass is issued only after the exact card/release/job read-back,
human full-strip result, new-boot revalidation, post-reboot command, recovery
checks, and exported production record are all present. The worker disconnects
the finished card before beginning the next immutable run.

The deployed bundle is part of the product. Source checks run before signing;
the protected workflow signs firmware and rebuilds jobs; deployment publishes
Studio; the live checker fetches the build graph and verifies the root plus
every reachable JS/CSS asset. A green CI run that skipped Cloudflare for missing
credentials is explicitly **not deployed** and cannot authorize shipment.

## Success assumptions removed

| Former assumption | Evidence now required |
| --- | --- |
| Flash write finished | Verified write plus factory beacon or exact runtime status |
| USB showed `44:1B:F6:81:FE:B0` | Canonical expected ID is `lw-b0fe81f61b44`; identity only |
| Button says **Releasing USB…** | Nothing yet; require completion or an actionable timeout |
| Green board LED means the strip works | Human observation of the commanded external strip |
| AP disappeared, so Wi-Fi setup worked | Exact handoff-ready proof, exact acknowledgement, and two station envelopes |
| `lightweaver.local` did not resolve | Hostname discovery failed; recover the exact card before continuing |
| Card is absent from its old LAN address and AP | No current transport was found; do not infer boot, handoff, or card death |
| A Lightweaver answered | Expected card ID, release, boot, generation, host, and bridge lifecycle |
| Paired/reachable means connected | Complete current command/output readiness; blank stays non-green |
| One status response is current | Two fresh complete responses for one lifecycle and boot |
| Config POST succeeded | One correlated write plus independent exact read-back |
| Frame was acknowledged, so LEDs lit | Explicit human full-strip observation |
| Reset did not change the screen, so it survived | New boot ID plus two new ready envelopes and a fresh command |
| CI was green, so the site deployed | Credentialed publish plus live build-graph freshness proof |
| Eight amber pixels means finished | Beacon only; full 44-pixel project check still required |

## Current release limiter

The USB byte-order fix is deployed and verified. The ESP32-S3 restart and
station-preflight corrections are implemented and verified in source and on the
real card at the transport/status level, but are not yet in the protected live
release described here. The current limiter is publish plus one uninterrupted
live acceptance. Do not mark a card ready to ship until an erased card completes
[`new-card-checklist.md`](new-card-checklist.md), including human physical-light
and recovery checks; none was verified in the diagnostic recovery.
