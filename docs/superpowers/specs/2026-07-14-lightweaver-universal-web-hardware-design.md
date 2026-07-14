# Lightweaver Universal Web Hardware Design

**Date:** 2026-07-14  
**Status:** Approved  
**Scope:** `led.mandalacodes.com`, the ESP32-S3 Lightweaver firmware, and exceptional desktop recovery support

## Purpose

`led.mandalacodes.com` is the only address a customer, creator, or technician should need to remember. From that address they must be able to design an installation, connect to a working card, configure and verify physical outputs, install a blank card, update firmware, diagnose a failure, and recover the lights.

The website remains the product interface. Hardware security boundaries still exist: a public HTTPS page cannot silently bypass operating-system USB consent, every browser cannot expose a serial device, and a public origin cannot reliably issue arbitrary requests to a private HTTP controller. Lightweaver handles those boundaries through capability detection and a deterministic fallback ladder rather than exposing browser terminology, local addresses, firmware files, or command-line steps.

The design preserves the ESP32-only runtime. A Raspberry Pi and a public cloud command relay remain out of scope.

## Product promise

Lightweaver makes one honest promise:

> Visit `led.mandalacodes.com`. Lightweaver will determine whether the card can be reached through the browser, its local page, or supported USB hardware and give one concrete next action until the requested job is complete.

Design and local-network control work across modern operating systems. Initial installation or deep recovery of blank hardware requires a supported USB-capable computer or Android device. Unsupported devices can still design, control an already-installed card, and hand the recovery session to a supported device without losing project state.

## Success criteria

The project is complete when:

1. The public website is the canonical entry point for setup, control, design, firmware installation, updates, diagnostics, and recovery.
2. Every hardware action shows whether it changed only Studio, reached the card, or was rejected.
3. A connected card reports its identity, firmware version, runtime source, GPIO assignments, pixel totals, current look, and health.
4. A customer never has to type an IP address, open Terminal, select a firmware file, choose a flash offset, or understand mixed content, Web Serial, bridges, partitions, or bootloaders.
5. A blank compatible ESP32-S3 can be installed from desktop Chrome-family browsers using the bundled signed release selected by the website.
6. Unsupported browsers present a platform-correct handoff instead of a disabled or apparently broken Flash button.
7. Once a card has Lightweaver firmware, routine firmware updates use a signed, rollback-safe network path; USB is reserved for blank or deeply damaged cards.
8. Configuration and firmware changes retain a known-good version and roll back after failed validation, failed boot confirmation, timeout, or interrupted connection.
9. Recover Lights explains what failed, what it restored, and whether physical output was acknowledged.
10. The existing standalone behavior remains intact: a configured card continues playing without the website, internet, laptop, Pi, or Connector.
11. The website can hand USB installation or recovery to another supported device while the original browser retains its Studio project unchanged.
12. Existing project lifecycle, wiring safety, visitor UI, runtime contract, build, launch, and hardware smoke tests continue to pass.

## Chosen approach

Use an adaptive web hub with three capability levels:

1. **Studio:** the public website owns design, project state, explanations, validation, and workflow orchestration.
2. **Local card connection:** the card page and card APIs own local control, configuration application, diagnostics, network updates, and acknowledgement.
3. **Lightweaver Connector:** an exceptional, website-launched desktop capability for unsupported USB environments and deep recovery.

This is preferred over browser-only operation because Web Serial and public-to-private networking are not universal. It is preferred over making a desktop application the product because everyday design and control do not need an installation. It is preferred over a cloud relay because the physical card must remain local, responsive, and functional without internet service.

## Universal entry experience

Every primary Studio screen exposes one compact Card Status control. It has five user-facing states:

- **Not connected:** Studio editing works; hardware-dependent actions identify that they require a card.
- **Connecting:** Lightweaver is testing a specific local or USB path.
- **Connected:** the card recently acknowledged a health request and its identity is visible.
- **Needs attention:** the card or transport rejected an operation and the last confirmed state remains authoritative.
- **Recovering:** a bounded recovery operation is active and its current step is visible.

The control never reports Connected from a remembered hostname, an open window, a successful browser preview, or a sent request alone. It requires a recent acknowledgement from the expected card identity.

Activating **Connect Lightweaver** follows this decision order:

1. Ping an already-established card-page or Connector session.
2. Offer one-click reconnection to a remembered card identity when a browser gesture is needed to reopen its local page.
3. Ask whether the card already lights up or is blank/not responding.
4. For a working card, guide local-network or setup-network connection.
5. For a blank or deeply damaged card, evaluate USB capability and start the correct install or recovery path.

The routine interface does not show transport selection. Advanced diagnostics may name the active transport after connection.

## Platform capability contract

| Environment | Design | Control installed card | Initial USB install | Routine firmware update |
| --- | --- | --- | --- | --- |
| macOS, Windows, Linux, ChromeOS with supported Chromium browser | Yes | Yes | Website Web Serial | Local network |
| Android with compatible Chrome, USB host support, cable, and power | Yes | Yes | Offered only after a positive capability probe | Local network |
| iPhone and iPad | Yes | Yes | Hand off to supported USB device | Local network |
| Safari or Firefox desktop | Yes | Yes | Open supported browser or website-provided Connector | Local network |
| Offline card after configuration | Not applicable | Card visitor UI and physical controls | Not applicable | Deferred until connectivity returns |

The website detects capabilities at runtime. Browser names are guidance, not the source of truth: the install action is enabled only after the required secure-context and serial APIs are present. Android USB installation is treated as supported only when the browser exposes the device and the firmware transport completes a non-destructive identity handshake.

## Working-card connection

A pre-flashed card is the normal customer path.

1. The person powers the card and visits the public website.
2. Lightweaver first adopts an existing authenticated local card session.
3. If the card is new or offline, the website instructs the person to join the uniquely named `Lightweaver-XXXX` setup network.
4. A user-initiated **Continue** action opens the local card page. The card page establishes the allowed Studio session and reports card identity and capabilities.
5. Initial setup collects the destination Wi-Fi network through the card page. Wi-Fi credentials remain on the card and are never sent to the public origin.
6. After the card joins the installation network, the local session reports the resulting identity and address. Studio remembers the stable card ID and unique hostname while treating the numeric IP as replaceable cache data.
7. Studio returns to the originating task and confirms the physical card state before enabling hardware actions.

Browser popup and local-network permissions require a user gesture and cannot be bypassed. The interface anticipates the prompt immediately before it appears. If a browser blocks the local page, the same card-status surface offers **Allow and retry** with browser-specific help; it does not strand the person in a warning banner.

## Blank-card installation

The ordinary install surface contains one primary action: **Install Lightweaver**.

The website:

1. Confirms that the environment exposes the required serial capability.
2. Requests a device only from an explicit click and filters the chooser to compatible Lightweaver/ESP USB identities when reliable identifiers exist.
3. Performs a non-destructive chip identity and flash-size check.
4. Selects the current production factory image from the deployed signed release manifest.
5. Validates the image type, size, digest, target, and signature before erase or write.
6. Explains that a blank or replaced card will be initialized, then requests one final destructive confirmation.
7. Writes the factory image, verifies it, releases the serial device, and waits for the card to reboot.
8. Continues directly into setup-network connection, output configuration, and first/last-pixel verification.

The normal installer has no arbitrary file chooser, flash address field, erase toggle, baud-rate selector, or serial console. Those capabilities may exist only in a separately labelled technician diagnostic surface and must not weaken validation of the primary install flow.

If the environment lacks USB capability, the website presents one valid next action in this priority order:

1. **Continue in a supported browser on this computer.** The Studio project remains in the original browser and the supported browser opens the bounded install/recovery route.
2. **Continue on another supported device.** A QR code or short URL opens the generic install/recovery route. It carries no project content; the original browser retains the project and reconnects after the card is healthy.
3. **Enable hardware access.** Offer the platform-correct Connector only when browser handoff is unavailable or has failed.

## Lightweaver Connector

The Connector is not a second Studio and is not required for ordinary customers. It is a narrow recovery and hardware-access component launched from the website.

Platform packages are built separately for supported macOS, Windows, and Linux targets. The website selects the package automatically. On macOS the application is Developer ID signed, notarized, built for Apple Silicon and Intel, and uses the hardened runtime. It requires no kernel extension, custom USB driver for native ESP32-S3 USB, administrator privileges, Accessibility, Full Disk Access, screen recording, contacts, or location permission.

The Connector exposes only these operations:

- enumerate and identify compatible USB cards;
- read bounded card status and diagnostic events;
- install a release authorized by the signed Lightweaver manifest;
- stop temporary output and release live streams;
- restore a known-good configuration or firmware slot;
- restart the card and report whether it returned healthy.

It cannot execute arbitrary shell commands, browse the general filesystem, proxy arbitrary network requests, accept arbitrary firmware in the normal flow, or run a local web server. Launch authorization is limited to the canonical production origin and explicit allowed preview origins. One-time nonces bind each launch to the requesting operation, expire after inactivity, and are consumed by the first valid website callback.

The Connector registers a `lightweaver://` launch link and opens a minimal native USB install/recovery window. The website initiates that window with a bounded operation name and one-time nonce; it does not send project content or arbitrary commands. When the operation finishes, the Connector opens a callback at `https://led.mandalacodes.com` containing the nonce, non-secret card identity, installed firmware version, and success or structured failure code. Studio validates the nonce, discards it after one use, reconnects to the card through the normal local path, and treats the card's own status as authoritative. The Connector never runs a background HTTP server and never becomes a general bridge for routine Studio control.

## Card identity and pairing

Each flashed card has a stable, non-secret card ID derived at provisioning and a unique display/host name. Studio stores:

- card ID and user-facing name;
- last confirmed firmware and capability versions;
- unique hostname and last successful address as connection hints;
- the project/card association explicitly confirmed by the person;
- the last confirmed installable project fingerprint.

It does not treat network location as identity. Before configuration, firmware, or recovery writes, the card ID must match the intended card. A mismatch stops before mutation and clearly offers **Use this card instead** or **Reconnect expected card**.

## Live control contract

Studio preview and physical playback are distinct.

When local preview is enabled, a pattern or control change follows `pending -> confirmed` or `pending -> failed`. The visible physical-card selection changes only after acknowledgement. If Studio preview changes but the card does not acknowledge it, the interface says:

> The Studio preview changed, but the physical lights did not. Reconnect and retry.

Repeated high-frequency changes are coalesced so the card receives the latest requested value instead of an unbounded queue. Playlist and configuration payloads are checked against firmware-declared count and storage limits before transmission. The card independently enforces those limits and returns a structured rejection that identifies the excessive resource and the safe maximum.

## Safe configuration transactions

GPIO, output count, pixel totals, color order, wiring, playlist, and runtime configuration changes use a shared transaction:

1. Read and fingerprint the card's current confirmed configuration.
2. Compile and validate the proposed configuration against the connected card capabilities.
3. Show a plain-language change summary, emphasizing output pin and pixel changes.
4. Save the current configuration as known-good on the card.
5. Stage the proposal without replacing known-good state.
6. Apply it in probation mode with bounded brightness and watchdog protection.
7. Require runtime health plus the appropriate physical verification acknowledgement.
8. Commit only after successful verification.
9. Roll back automatically after timeout, boot failure, renderer failure, unsafe resource use, connection loss during probation, or explicit recovery.

Studio cannot fabricate verification. A visual confirmation button is enabled only after the card acknowledged delivery of the test frame or pattern. The card retains the rollback decision across reboot so closing the browser cannot leave an unverified pin or pixel configuration committed.

## Network firmware update and rollback

After initial installation, routine updates use an A/B firmware layout with a minimal recovery path:

1. Studio or the card checks a signed release manifest and compares compatible versions.
2. The person sees the purpose, target card, installed version, new version, and whether configuration migration is required.
3. The card receives the image into the inactive application slot.
4. The card verifies target, size, digest, signature, and available storage before marking the slot bootable.
5. The card reboots into probation and starts LEDs at a safe bounded output.
6. Firmware self-tests configuration loading, renderer startup, card API availability, watchdog health, and output capability initialization.
7. The new slot becomes permanent only after self-test and a successful health acknowledgement.
8. Failed boot, crash loop, expired confirmation, or incompatible configuration returns automatically to the previous slot and known-good configuration.

Loss of internet does not stop a running card. Updates are never mandatory in the middle of control or installation work. A recovery firmware path remains available even if both application configuration and installation Wi-Fi are invalid.

## Recover Lightweaver

One recovery action escalates through bounded steps and stops immediately when the physical card returns healthy:

1. Cancel active browser/card frame streams and temporary wiring tests.
2. Request status and classify the active frame source, renderer state, configuration probation, reset reason, storage pressure, and firmware slot.
3. Restore the last confirmed look when only a temporary stream owns output.
4. Roll back an unverified configuration transaction.
5. Restore the known-good runtime configuration and restart the renderer.
6. Restart the card and confirm that it returns with the expected identity.
7. Enter the card's setup/recovery network when installation Wi-Fi is unavailable.
8. Restore the previous valid firmware slot through local recovery.
9. Request USB and launch the website's supported install/Connector path only when local recovery is unavailable.

Every step has a deadline, is safe to repeat, and records a structured result. Completion names the detected cause when evidence supports it, the state restored, and the card acknowledgement. If the cause is unknown, the interface says so instead of guessing.

Example:

> **Lights restored.** The 44-item playlist exceeded this card's saved-playlist limit. Lightweaver restored the previous 8-item playlist and restarted playback on GPIO 16.

Recovery does not erase the current Studio project. When a project caused the failure, Studio preserves it as a draft and identifies the rejected portion.

## Safety and security boundaries

- All destructive firmware operations require a deliberate click and target-card confirmation.
- Release manifests and firmware images are signed; a digest alone is not treated as publisher authorization.
- Wi-Fi credentials remain between the person and the local card page.
- Local bridge messages use an explicit origin allowlist, versioned features, card identity, request IDs, deadlines, and bounded payload sizes.
- Connector launch and callback are native, short-lived, origin-restricted, operation-restricted, and never a general local proxy.
- Card endpoints enforce payload, playlist, zone, pixel, output, storage, and frame-rate limits independently of Studio validation.
- Firmware and configuration probation survive browser closure and power interruption.
- Diagnostics redact Wi-Fi credentials, tokens, private project data, and unrelated serial devices.
- The public website never claims that operating-system permission was granted before the operating system confirms it.

## Failure behavior

Failures remain beside the action and preserve the last confirmed state.

- **Unsupported browser:** explain that this device can still design/control and offer the correct supported-device handoff for USB work.
- **USB device absent:** ask for a data-capable cable and boot-mode sequence only after the chooser returns no compatible device.
- **Wrong card:** stop before writing and show both expected and detected names.
- **Card page blocked:** offer one user-gesture retry and browser-specific popup/local-network help.
- **Card stopped responding:** stop pending writes, retain the draft, and offer Recover Lightweaver.
- **Payload too large:** identify the resource, current amount, card maximum, and an automatic safe reduction preview.
- **Update interrupted:** card continues the old slot or rolls back; Studio resumes from the card's reported state.
- **Connector unavailable:** ordinary editing remains available and the website offers supported-browser/device handoff.

No error instructs an ordinary customer to use Terminal, inspect developer tools, type an IP address, download a raw binary, or manually erase flash.

## Implementation boundaries

The work is divided into four sequentially integrated capabilities:

1. **Universal connection and truthful control**
   - One Card Status state machine, capability detection, working-card onboarding, supported-browser handoff, card identity checks, acknowledgement-driven preview, and structured limits.
2. **Safe card updates and recovery**
   - Firmware A/B/recovery partition design, signed release manifest, OTA endpoints, boot confirmation, configuration transactions, and recovery escalation.
3. **USB installer hardening**
   - Compatible-device filtering, automatic production image selection, signature verification, simple install UI, platform guidance, and resumable post-flash onboarding.
4. **Exceptional Connector**
   - The smallest signed desktop USB install/recovery window, launched by a `lightweaver://` link and returning only a bounded result to the website.

The Connector is last because correct card-local OTA and recovery eliminate most reasons to install it. The existing deferred Pi server remains untouched.

## Testing strategy

### Unit and contract tests

- Connection state transitions cannot report Connected without acknowledgement.
- Capability routing produces one valid next action for every supported platform fixture.
- Card identity mismatch blocks every mutating operation.
- Live-control coalescing bounds the queue and preserves the latest intent.
- Configuration validation and card-side limits agree on pixel, GPIO, playlist, storage, and payload constraints.
- Recovery classification maps structured evidence to deterministic steps without inventing causes.
- Release manifest and firmware signature failures block installation and OTA.

### Browser tests

- Supported desktop Chromium completes the mocked Web Serial install flow.
- Unsupported browsers receive a usable handoff and retain the originating project/task.
- Popup-blocked, local-page-closed, wrong-card, timeout, oversized payload, and interrupted update paths remain recoverable.
- Pattern selection distinguishes Studio-only preview from card-confirmed output.
- Narrow phone layouts can connect to and control a pre-flashed card without exposing desktop USB actions.

### Firmware tests

- Configuration probation commits only after health and verification.
- Timeout, reboot, power interruption, invalid pin, invalid pixel count, and renderer failure restore known-good state.
- OTA rejects wrong target, wrong size, invalid digest, invalid signature, insufficient storage, and incompatible configuration.
- Crash loop or missing boot confirmation returns to the previous application slot.
- Recover is idempotent across every escalation step.
- Resource limits reject oversized playlists/configuration without exhausting memory or freezing output.

### Real hardware gates

- Install a blank ESP32-S3 from macOS and Windows desktop Chromium.
- Verify the supported Linux/ChromeOS path or explicitly gate release if its permissions differ.
- Test Android only on declared supported device/cable combinations before showing its USB action.
- Configure a pre-flashed card from a phone through its setup network.
- Interrupt OTA during transfer and during first boot; confirm old firmware resumes.
- Apply a wrong GPIO and oversized pixel/playlist configuration; confirm automatic rollback and explanatory recovery.
- Close Studio during configuration probation and power-cycle the card; confirm known-good output returns.
- Verify deep USB recovery through the native Connector launch/callback flow on each distributed desktop platform.

## Rollout

1. Ship truthful card status, acknowledgement-driven controls, capability detection, and platform handoff before changing firmware partitions.
2. Ship card-side structured limits and configuration rollback.
3. Add signed A/B OTA and recovery after bench interruption testing passes.
4. Replace the current advanced-looking Flash surface with the automatic production installer while retaining technician diagnostics behind an explicit boundary.
5. Build and distribute the narrow Connector only for platform gaps that remain after OTA and browser installation are proven.
6. Update `docs/public-web-deployment.md`, `docs/lightweaver-customer-runtime.md`, installer copy, deployment checklist, and customer handoff material to point exclusively to `led.mandalacodes.com`.

## Non-goals

- Remote internet control of a card away from its local network.
- A Cloudflare polling relay or public device command queue.
- Reintroducing the Raspberry Pi runtime.
- Requiring accounts for basic setup or control.
- Making iPhone or iPad promise unsupported direct ESP32 USB flashing.
- Turning the Connector into a second design application.
- Allowing ordinary customers to flash arbitrary firmware or bypass hardware safety limits.
