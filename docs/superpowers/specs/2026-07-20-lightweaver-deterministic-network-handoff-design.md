# Lightweaver Deterministic Network Handoff Design

**Date:** 2026-07-20

**Status:** Approved by Adrian on 2026-07-20 ("yes")

**Scope:** ESP32-S3 WiFi lifecycle, the card-page bridge, Studio commissioning, release verification, and real-card acceptance

## Incident and goal

The signed bench card was reachable at `192.168.18.70`, accepted fast direct HTTP commands, survived a reboot, and visibly ran its 44-pixel GPIO 18 project. The released HTTPS Studio still showed **Not connected** and could not continue the production workflow. The card later remained powered over USB but disappeared from both its last LAN address and `lightweaver.local`.

The direct bench commands proved only the firmware command endpoint. They bypassed the released customer path and therefore were not end-to-end acceptance.

The goal is a deterministic transition from the setup hotspot to the gallery LAN and an automatic recovery path after later WiFi loss. A production pass must drive the card through the released Studio and verified card-page bridge; direct HTTP is diagnostic evidence only.

## Root cause

Four assumptions combined into the dead end:

1. `/api/wifi` persisted credentials, returned success, and rebooted after 400 ms. The AP page had no opportunity to prove that station association succeeded or report the assigned station address.
2. The setup link opened `192.168.4.1` as an untracked `noopener` tab in part of the commissioning UI, so its page could not return handoff evidence to the existing Studio tab.
3. Studio's automatic expected-card LAN polling is intentionally disabled on HTTPS because a public HTTPS page cannot reliably fetch private HTTP endpoints. The live route therefore needs a verified card-page bridge at a known origin.
4. After station loss, firmware observed `WiFi.status()` and relied on the ESP SDK's automatic reconnect. It did not actively restart association or restore the setup AP after a bounded outage.

mDNS remains a convenience alias. It is not sufficient handoff evidence and is never the only recovery route.

## Selected approach

Keep the ESP32 in AP+station mode during initial association, return the assigned LAN address through the already-open verified card-page bridge, migrate the named bridge window to that address, and retire the setup AP only after acknowledgement or a bounded grace period. Later station loss uses an explicit reconnect state machine and restores a recovery AP if association cannot be re-established.

Rejected alternatives:

- Continue relying on mDNS and SDK auto-reconnect: this is the behavior that failed on the real card.
- Scan the LAN directly from the public HTTPS origin: mixed-content and private-network browser controls make it nondeterministic and browser-dependent.
- Add a cloud relay or Raspberry Pi: this violates the local, zero-login ESP32-only product boundary.

## Firmware WiFi state machine

The WiFi lifecycle becomes explicit and observable:

- `setup-ap`: no saved credentials; AP and captive setup are active.
- `joining`: credentials are saved; AP remains active while station association is attempted immediately.
- `handoff-ready`: station association succeeded; status contains the stable card ID, boot ID, station IP, hostname, and a handoff generation while the AP remains active for a bounded grace window.
- `station`: the AP is retired and normal LAN operation continues.
- `reconnecting`: a previously working station link was lost; the saved lighting project continues while firmware actively retries association.
- `recovery-ap`: bounded retries failed; AP+station mode is restored so the worker can reach the card and correct WiFi without erasing the project.

`POST /api/wifi` no longer equates a saved password with a successful join. It returns an accepted transition and starts association without an immediate reboot. `/api/status` exposes the transition, AP activity, station address only after a real association, handoff generation, and retry/recovery state. It never exposes the WiFi password.

The setup AP remains available until station-origin acknowledgement or the grace timeout. `POST /api/wifi/handoff-ack` accepts only the current handoff generation after the named card page has loaded from the reported station IP and completed a fresh Studio bridge handshake. An acknowledgement received at the AP origin is insufficient. Timeout retirement is allowed only after a station address was proved; failed association keeps or restores the AP. Re-entering credentials replaces the pending transition cleanly.

After a later station loss, firmware initiates bounded reconnect attempts rather than only observing SDK state. If station recovery succeeds, it refreshes the active IP, mDNS, HTTP/realtime bindings, and boot-independent status. If it fails, it enables the recovery AP while retaining the known-good project. LED playback continues from the saved project; the UI reports the network fault without presenting the card as command-ready to Studio.

## Card-page and Studio handoff

Studio opens setup through the existing named card bridge window, not an unrelated `noopener` tab. The AP card page and Studio establish the normal origin-checked bridge handshake before credentials are submitted.

During `joining`, the card page polls fresh status. On `handoff-ready`, it sends the following evidence to its opener through the existing bridge protocol:

- handoff generation;
- stable card ID and boot ID;
- firmware version/build;
- verified station IP and hostname;
- current project/readiness state.

Studio accepts the handoff only when it belongs to the active commissioning flow and expected card. It persists the verified private IP as the preferred host, clears readiness from the AP bridge lifecycle, and navigates the same named bridge window to the station IP with the handoff generation in its fragment. Reusing the same `WindowProxy` avoids a second popup permission decision. After that station-origin page completes the fresh expected-card bridge handshake, it acknowledges the generation to firmware; only then may firmware retire the AP immediately.

If the computer is still joined to `Lightweaver-XXXX`, Studio says to return to gallery WiFi and keeps the exact station target. Once the named page answers at the new origin, Studio performs two fresh full status reads for the expected card and boot before advancing. Cached identity, the AP response, a bare bridge-ready event, mDNS resolution, or one failed/partial read cannot advance the flow.

Manual IP entry remains a visible fallback, but it must pass the same expected-card and readiness checks. The dead AP address is never shown as the continuing destination after handoff evidence exists.

## Production workflow behavior

The production run retains its immutable job and expected USB card identity across the network switch. After firmware inspection/install:

1. Studio opens the tracked setup/card bridge.
2. The worker enters WiFi on the card page.
3. Studio receives and persists exact-card station handoff evidence.
4. Studio reconnects the named bridge at the verified station IP.
5. Two fresh status envelopes establish the exact boot and readiness.
6. A blank card is labeled **Blank — load a project**, never connected/green.
7. Studio stages and independently reads back the production job.
8. The guided physical test changes the real strip through the bridge.
9. A human confirmation plus final fresh read records the pass.

The connection footer and Production Setup share the same card-link state. A network loss, bridge loss, reboot, boot-ID change, or readiness failure immediately removes green state and blocks mutation.

## Error handling

- Saved credentials but no association: remain reachable on the AP and show a correct-password/network recovery action.
- Station address learned but computer still on AP: preserve the IP and prompt one network switch; do not restart setup.
- Wrong card at the learned IP: block with the expected and discovered IDs; never adopt automatically.
- Station drops during project mutation or wiring probation: fail closed and rely on the existing card-owned candidate rollback.
- Station drops after commissioning: continue the saved lighting project, demote Studio, actively reconnect, then expose recovery AP if needed.
- AP handoff acknowledgement is lost: the grace timeout and persisted handoff generation make retry safe; no project mutation is replayed.
- mDNS fails: continue with the verified station IP.

## Automated verification

Regression tests are written and observed failing before production code changes.

Firmware tests cover:

- `/api/wifi` starts `joining` without immediate reboot;
- AP remains active while station association is pending;
- only a real station association exposes `handoff-ready` and an IP;
- acknowledgement/grace transitions retire the AP safely;
- association failure retains/restores AP reachability;
- station loss causes active reconnect attempts and bounded `recovery-ap` fallback;
- reconnect success refreshes IP, mDNS, HTTP/realtime bindings, and status;
- the known-good project and LED output remain active through network recovery.

Studio unit/Playwright tests cover:

- setup uses the tracked named bridge window;
- HTTPS accepts only correlated expected-card handoff evidence;
- AP bridge lifecycle is revoked before station-origin verification;
- verified IP replaces `192.168.4.1` and survives the network switch;
- wrong-card, changed-boot, partial, stale, and duplicate handoffs fail closed;
- two fresh station responses advance automatically;
- Production Setup reaches project load and physical check through bridge transport;
- loss of the bridge or card response removes connected/success state.

Release checks compare the deployed Studio entry graph—not only firmware assets—with the exact built artifact so a firmware-only update cannot masquerade as a current integrated release.

## Real-card acceptance

Acceptance starts from an erased ESP32-S3 and uses `https://led.mandalacodes.com/#screen=production` in a supported desktop browser. The worker performs the released flow without terminal commands or a manually supplied IP.

The pass requires:

1. signed flash and exact runtime identity;
2. factory/blank state, not green;
3. hotspot WiFi entry;
4. automatic expected-card handoff to its verified LAN IP;
5. exact project load and independent readback;
6. a visible pattern/light-boundary change sent through live Studio's bridge;
7. reboot and network-loss demotion/recovery;
8. final visible 44-pixel GPIO 18 Aurora result and recorded production pass.

Direct API commands may diagnose a failure but cannot satisfy any production acceptance step.

## Out of scope

- Raspberry Pi or cloud proxy control;
- login/accounts;
- cloud relay discovery;
- arbitrary LAN scanning from HTTPS;
- treating mDNS as verified identity;
- changing the zero-login gallery visitor experience.
