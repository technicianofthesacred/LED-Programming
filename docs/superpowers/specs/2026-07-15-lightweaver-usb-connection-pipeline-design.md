# Lightweaver USB Connection Pipeline Design

**Date:** 2026-07-15  
**Status:** Approved  
**Parent design:** `2026-07-14-lightweaver-universal-web-hardware-design.md`  
**Scope:** the public Studio connection orchestrator, the card-page handoff, and a narrow cross-platform Lightweaver Bridge

## Decision

`https://led.mandalacodes.com` remains the only product entry point. Lightweaver—not the customer—decides whether a task should use direct Web Serial, the local card-page bridge, or a signed desktop Lightweaver Bridge.

The customer may still need to perform security gestures that browsers and operating systems intentionally reserve for a person: choose a USB device, approve a signed application the first time it is installed, and confirm an erase/write. Lightweaver must explain these as concrete physical actions without asking the customer to understand secure contexts, Web Serial, mixed content, native protocols, drivers, ports, firmware offsets, or local-network addressing.

This design activates the Connector capability already approved in the parent design and adds the secure-context escape and card-page behavior required by the July 15 Chrome incident.

## Incident this closes

The current card page can embed the HTTPS Studio inside an iframe hosted by `http://lightweaver.local`. Because the top-level ancestor is insecure, the embedded Studio is not a secure context and cannot access Web Serial. Chrome is supported, but the capability router currently describes it as an unsupported browser.

The sampled physical card also runs a pre-identity firmware contract. Its `/api/firmware-info` response reports 44 pixels on GPIO 16 but omits `cardId`, `firmwareVersion`, and `buildId`. Studio correctly blocks physical mutations, then hides the actionable `identity-missing` reason behind a generic preview failure.

The pipeline must therefore solve both recovery and comprehension:

1. escape an insecure embedded Studio to a secure top-level installer;
2. install current signed firmware through the available USB transport;
3. verify the returning card's stable identity;
4. resume the originating Studio task;
5. explain the exact failure when any step cannot complete.

## Product promise

The person starts at the website and sees one primary action: **Connect Lightweaver**.

Lightweaver then does the technical diagnosis and presents only the next physical action. A normal successful flow reads like:

1. Plug in the Lightweaver card.
2. Choose the Lightweaver USB device.
3. Confirm installation.
4. Wait while Lightweaver installs and verifies the card.
5. Confirm that the lights respond.

No ordinary path exposes transport selection. Advanced diagnostics may name the active route after connection.

## Connection orchestrator

One pure decision engine owns the connection pipeline. It receives observations, not browser names:

- top-level versus embedded document;
- secure-context status;
- Web Serial presence;
- desktop/mobile platform family;
- Lightweaver Bridge callback or launch state;
- remembered stable card identity and last-known connection hints;
- local bridge handshake and protocol version;
- card firmware identity/capability response;
- current task: control, install, update, or deep recovery.

It returns one state and one primary action:

| State | Meaning | Primary action |
| --- | --- | --- |
| `ready-browser-usb` | Secure top-level page with usable Web Serial | Find connected card |
| `escape-insecure-card-frame` | Studio is inside an insecure card page | Open secure installer |
| `ready-local-card` | Expected installed card acknowledged locally | Continue current task |
| `needs-card-update` | Card answered but lacks the required identity/runtime contract | Update this card |
| `launch-native-bridge` | Browser USB is unavailable and a desktop bridge may be installed | Open Lightweaver Bridge |
| `install-native-bridge` | No successful native callback followed launch | Install Lightweaver Bridge |
| `handoff-supported-device` | Current platform cannot provide either USB route | Continue on a computer |
| `wrong-card` | A different stable card answered | Reconnect expected card / Use this card |
| `recoverable-failure` | A bounded step failed without mutation ambiguity | Try the failed step again |
| `needs-safe-recovery` | Write outcome or card health is uncertain | Recover Lightweaver |

Browser-brand copy is derived guidance only. Chrome must never be called unsupported merely because it is running inside an insecure ancestor.

## Route 1: secure website USB

Direct browser installation remains the shortest path on desktop Chrome-family browsers and ChromeOS.

The installer must run as a top-level page at:

`https://led.mandalacodes.com/#screen=flash&mode=install`

When Studio detects an insecure or embedded card-page context, it shows **Open secure installer**. The button opens the fixed canonical URL as a top-level page, without carrying arbitrary callback URLs, firmware URLs, project content, or card commands. Project state remains available because the secure page uses the same public origin.

The website then uses the existing signed-manifest installer: request a port from a deliberate click, identify ESP32-S3/16 MB hardware before mutation, verify target/signature/digest/size, require erase confirmation, write and verify the image, release USB, and continue into card onboarding.

## Card-page handoff correction

Future firmware must not replace the local HTTP card page with an iframe containing Studio.

**Open Lightweaver Studio** opens the canonical HTTPS Studio as a separate top-level window. The local card page stays open as a narrow bridge and remains the new Studio window's opener. The Studio launch carries only the bounded bridge flag and local host hint. Studio verifies the card origin and identity before any privileged request.

The old iframe bridge remains recognized only as a compatibility transport for already-installed cards. It cannot host install or deep-recovery UI. When old firmware embeds Studio, the secure-escape action is always available, so upgrading does not depend on already having the upgrade.

## Route 2: Lightweaver Bridge

The Lightweaver Bridge is a small Electron desktop application for macOS, Windows, and Linux. It is a USB installation/recovery component, not a second Studio and not a general local proxy.

Electron is selected for the first implementation because the project already has a verified `esptool-js` transport and can reuse the same signed-release and ESP32-S3 validation contracts as the browser installer. The application loads packaged local UI only.

The Bridge exposes a closed operation vocabulary:

- `install-current-release`;
- `recover-current-release`;
- `inspect-compatible-card`;
- `release-usb`;
- `restart-card`.

It cannot accept an arbitrary shell command, executable, firmware URL, flash offset, callback origin, filesystem path, network proxy request, or remote webpage.

### Native launch and return

The Bridge registers `lightweaver://run`. Studio launches it with only:

- a fixed operation name;
- a cryptographically random one-time nonce;
- the public installer protocol version.

Every protocol parameter is treated as untrusted. The custom scheme grants no hardware authority. The Bridge independently fetches the fixed production manifest from `https://led.mandalacodes.com`, verifies the pinned release signature and image, validates the connected card, and requires its own visible confirmation before erase/write.

After completion, the Bridge opens a fixed HTTPS callback on `led.mandalacodes.com` containing the nonce and a bounded result:

- success or a structured failure code;
- non-secret card ID;
- installed firmware version and build ID;
- detected target;
- verification result.

Studio accepts the callback only when the nonce matches an unexpired pending operation stored on the same public origin. The callback resumes the interface; it does not prove the LEDs changed. Studio reconnects through the normal card path and treats the card's own acknowledgement as authoritative.

The Bridge does not run a localhost HTTP server, remain resident after completion, or provide routine pattern streaming.

## Native application security

The Electron main process owns USB and network access. The renderer has:

- `nodeIntegration: false`;
- `contextIsolation: true`;
- Chromium sandbox enabled;
- a minimal preload API with typed, allowlisted operations;
- no navigation to remote content;
- no arbitrary IPC channel or raw serial API;
- a restrictive Content Security Policy;
- bounded log and payload sizes.

Production packages are reproducible from a pinned Node/Electron/toolchain lock. Release CI produces checksums and provenance, signs update metadata, and publishes artifacts only after source tests, connector tests, a packaged smoke test, and malware/signature verification gates.

Production distribution requirements:

- macOS: Developer ID signing, hardened runtime, notarization, Apple Silicon and Intel support;
- Windows: Authenticode-signed installer for supported x64/ARM64 targets selected by the website;
- Linux: AppImage plus a documented distro package when required, both checksum-verified;
- ChromeOS: direct website Web Serial; no desktop package;
- iPhone/iPad: design/control only, with recovery handoff to a supported computer;
- Android: direct USB only after a positive capability probe; otherwise computer handoff.

Unsigned development builds may be used only for local engineering. The public website must not recommend an unsigned production package. Missing signing credentials block that platform's public release rather than weakening the gate.

## Website launch experience

The website detects platform family and offers the correct package without asking the customer to choose an architecture. The sequence is:

1. Try the secure browser route when it is actually available.
2. When unavailable, show **Open Lightweaver Bridge**.
3. Attempt the registered protocol from a deliberate click.
4. If no valid callback arrives within a bounded interval, replace the action with **Install Lightweaver Bridge** and the correct signed package.
5. After installation, return to the same website task and launch the operation again.

The site never claims it can reliably detect whether an application is installed. Lack of a valid callback is the only launch-failure evidence.

## Resumable operation model

Install and recovery use explicit checkpoints:

1. environment selected;
2. release verified;
3. compatible card identified;
4. destructive action confirmed;
5. erase started;
6. write completed;
7. flash verification completed;
8. card restarted;
9. stable card identity acknowledged;
10. physical lights verified.

Checkpoints before erase may be resumed freely. Once erase starts, the Bridge or browser owns a non-cancellable critical section until the write outcome is known and USB is safely released. Closing UI is guarded while that section is active. A later retry begins by inspecting the card rather than assuming the prior write failed or succeeded.

The originating Studio project is never erased. If the card needs default firmware before a saved project can be restored, Studio keeps the project as a draft and resumes restoration only after the new card identity is confirmed.

## Error language

The pipeline surfaces the actual classified reason:

- **Open secure installer:** Studio is running inside the card's local connection page; Chrome itself is supported.
- **Card update required:** the card answers, but its firmware predates stable identity and safe commands.
- **Card page unavailable:** `lightweaver.local` failed; try the remembered private address or setup network automatically.
- **USB permission required:** choose the Lightweaver device in the operating-system prompt.
- **No compatible card found:** check the data cable and boot mode.
- **Wrong card:** identify both cards and stop before erase.
- **Firmware verification failed:** nothing was written.
- **Installation interrupted:** inspect the card and continue safe recovery.
- **Physical output unconfirmed:** firmware is installed, but the LEDs have not acknowledged the verification pattern.

Pattern and playlist screens must not collapse `identity-missing`, `wrong-card`, `bridge-missing`, timeout, and card rejection into the same generic preview banner.

## Tests and release gates

### Pure and browser contracts

- Capability routing distinguishes unsupported hardware from an insecure embedded Studio.
- The old iframe case always exposes a fixed top-level secure installer action.
- The website never places arbitrary URL or command data in a native protocol launch.
- Callback nonces are random, expiring, single-use, and origin-bound.
- Exact card/bridge failure reasons produce distinct recovery actions.
- Direct Web Serial installation remains the first route when available.

### Firmware contracts

- The card page opens Studio as a top-level HTTPS window and stays available as its bridge.
- The old iframe auto-open path is absent from the newly shipped firmware.
- Bridge origin, protocol version, request bounds, and stable card identity remain enforced.

### Connector contracts

- Deep links reject unknown operations, unexpected fields, oversized input, reused nonce material, and unsupported protocol versions.
- IPC rejects every channel and parameter outside the allowlist.
- Release signature, target, size, digest, and full factory image structure are verified before erase.
- Wrong-chip, wrong-flash-size, disconnect, interrupted write, failed MD5, and failed reboot paths release USB and return structured failures.
- The packaged app cannot navigate remotely or open an arbitrary callback.

### Platform acceptance

- macOS Apple Silicon and Intel: signed/notarized package, browser launch, USB install, callback, card acknowledgement.
- Windows x64 and ARM64 as supported: signed install, protocol launch, USB install, callback, card acknowledgement.
- Linux declared support matrix: package start, device permissions, USB install, callback, card acknowledgement.
- Desktop Chrome direct route: top-level secure install without Connector.
- Safari/Firefox desktop: Connector handoff without losing Studio project state.
- Old physical firmware: insecure iframe escape, signed install, new stable identity, restored control.

No package is called production-ready until its signing and real-hardware gate passes on that platform.

## Rollout

1. Ship the secure top-level escape, truthful error reasons, and future card-page top-level handoff.
2. Verify the existing direct Web Serial route on the currently connected card.
3. Build the Connector core and unsigned local development package with the same signed-release contracts.
4. Add website deep-link/callback orchestration and resumable state.
5. Add pinned cross-platform CI and package smoke tests.
6. Enable public package links one platform at a time after signing and real-hardware acceptance.
7. Keep browser USB and card-local recovery as preferred routes; invoke the Connector only for genuine platform gaps.

## Non-goals

- Removing the browser or operating system's USB consent gesture.
- A background daemon, general localhost server, VPN, cloud command relay, or Raspberry Pi runtime.
- Routine pattern streaming through the desktop Bridge.
- Arbitrary firmware flashing in the customer path.
- Promising direct USB installation on iPhone or iPad.
- Treating a protocol callback as proof that the physical LEDs changed.
