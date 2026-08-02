# Lightweaver firmware platform upgrade

Status: **deferred for reliability**

Decision date: 2026-08-02

Lightweaver will remain on its currently pinned, tested firmware platform until
a newer platform proves at least as reliable on a real ESP32-S3 card and LED
strip. Do not change the Arduino core, ESP-IDF base, LED driver, or WLED
compatibility claim merely to make version numbers newer.

## Current production baseline

The source of truth is
`firmware/lightweaver-controller/platformio.ini` and the signed public release
manifest—not this document. At the time of this decision, the baseline is:

- PlatformIO Core 6.1.19
- PlatformIO Espressif32 platform 7.0.1
- Arduino-ESP32 core 2.0.17, based on ESP-IDF 4.4.7
- FastLED 3.10.3
- ArduinoJson 7.4.3
- WebSockets 2.7.3
- Lightweaver firmware version 1.0.0, distinguished by its exact build ID

A card is running the current Lightweaver firmware only when the `buildId`
returned by `/api/firmware-info` matches the `buildId` in
`lightweaver/public/firmware/release-manifest.json`. The semantic version alone
is insufficient because multiple Lightweaver builds can identify as `1.0.0`.

## Why the upgrade is deferred

Arduino-ESP32 3.3.11 is a reasonable future migration target because it uses a
maintained ESP-IDF 5.5.5 base. ESP-IDF 4.4 is end-of-life, so moving eventually
has security and maintenance value. That benefit does not by itself prove that
the newer LED output path is reliable enough for a sellable installation.

The latest WLED release checked during this decision, WLED 16.0.0, still uses
Arduino-ESP32 2.0.18 and ESP-IDF 4.4.8. It is a separate firmware product, not a
library bundled into Lightweaver. Its choice of the older platform is useful
evidence that ESP32 LED timing, Wi-Fi coexistence, and field stability need
physical validation before Lightweaver moves to ESP-IDF 5.x.

Relevant upstream references:

- [Arduino-ESP32 3.3.11 release](https://github.com/espressif/arduino-esp32/releases/tag/3.3.11)
- [Arduino-ESP32 2.x to 3.x migration guide](https://docs.espressif.com/projects/arduino-esp32/en/latest/migration_guides/2.x_to_3.0.html)
- [ESP-IDF support policy](https://docs.espressif.com/projects/esp-idf/en/release-v4.4/esp32/versions.html)
- [pioarduino 3.3.11 platform release](https://github.com/pioarduino/platform-espressif32/releases/tag/55.03.311)
- [WLED 16.0.0 release](https://github.com/wled/WLED/releases/tag/v16.0.0)

## Known migration warnings

1. **Official PlatformIO does not currently supply Arduino-ESP32 3.x.** The
   tested candidate uses the community `pioarduino` platform. Pin an immutable
   release and record it in firmware provenance; never follow a moving branch.
2. **The build environment must use Python 3.10–3.14.** The old local
   PlatformIO launcher observed during the trial used Python 3.9 and could not
   run the newer platform.
3. **The WebServer parser safety patch must be reviewed, not bypassed.**
   `scripts/guard-webserver-control-body.py` is hash-locked to the audited
   Arduino 2.0.17 `Parsing.cpp`. An unchanged trial against 3.3.11 correctly
   stopped on a different parser hash. Review the new allocation and body-read
   paths, adapt the guard and its tests, and only then update the expected hash.
4. **Arduino 3.x contains breaking APIs and build changes.** Expect changes in
   networking, watchdogs, RMT, I2S, timers, LEDC, and other ESP32 services.
   Compilation success is necessary but does not prove runtime compatibility.
5. **FastLED output must be treated as physically unverified on the new core.**
   RMT/I2S driver changes can affect ESP32-S3 clockless LED timing, especially
   while Wi-Fi, WebSockets, Art-Net, or SD access is active. Watch for flicker,
   corruption, pauses, resets, and dropped frames.
6. **Do not combine the core migration with unrelated dependency upgrades.**
   First migrate the core while holding FastLED, ArduinoJson, WebSockets,
   firmware behavior, and schemas constant. Upgrade one dependency at a time
   afterward so regressions remain attributable.
7. **WLED does not get upgraded by changing the Lightweaver core.** Installing
   stock WLED replaces the Lightweaver firmware. Newer WLED JSON/API
   compatibility is separate Lightweaver application work; never advertise a
   newer WLED version until the corresponding behavior is implemented and
   tested.
8. **Preserve installed-card compatibility.** Confirm NVS data, wiring
   probation, project identity, config schema, microSD packages, factory reset,
   and recovery behavior across upgrade and rollback.

## When to reconsider

Open a platform migration only when at least one of these is true:

- a relevant security advisory or unsupported dependency affects Lightweaver;
- a field failure is fixed only in a maintained core;
- a required ESP32-S3, networking, USB, SD, or LED feature needs the newer core;
- upstream FastLED and ESP32-S3 evidence shows the target core is stable with
  simultaneous Wi-Fi and clockless LED output; or
- maintaining the old build toolchain becomes less reliable than migrating.

At migration time, reassess the latest stable supported core. Do not assume
3.3.11 remains the correct target merely because it was evaluated in 2026-08.

## Required migration sequence

1. Create an isolated migration branch and preserve the last signed production
   image as the rollback build.
2. Pin the candidate platform and toolchain exactly. Record the Arduino core,
   ESP-IDF, compiler, PlatformIO, and library versions in release provenance.
3. Review and adapt the WebServer parser guard before allowing a compile.
4. Compile with existing library pins. Fix compatibility without adding new
   features or changing public APIs and persisted schemas.
5. Run the source tests and release gates from
   `docs/deployment-checklist.md`, including:

   ```bash
   cd firmware/lightweaver-controller
   pio test -e native
   pio run

   cd ../../lightweaver
   npm run launch:source
   ```

6. Compare binary size, free heap, boot behavior, frame rate, and reset reasons
   against the current production firmware.
7. Flash a non-production ESP32-S3 and complete the hardware acceptance below.
8. Rebuild and publish a signed factory image only after hardware acceptance.
   Run `npm run launch:check` on the protected signed release commit and confirm
   that the live manifest, provenance, image size, and SHA-256 all match.
9. Canary the release on a small number of recoverable cards before treating it
   as the new production baseline.

## Hardware acceptance

Use the real Lightweaver card, representative power supply, and the intended
LED strip type. A migration is not accepted until all of the following pass:

- clean factory flash, first boot, USB identity, and factory beacon;
- upgrade with existing NVS state and clean recovery from incompatible state;
- rollback to the previous signed image with known-good behavior restored;
- AP mode, captive page, Wi-Fi handoff, STA reconnect, mDNS, and extended
  router-loss recovery;
- local card page and Studio bridge control, including bounded/oversized HTTP
  request rejection and Origin/CORS checks;
- WLED-compatible HTTP/WebSocket control and WLED realtime UDP;
- Art-Net input under sustained traffic and source-priority transitions;
- microSD detection, sequence validation/playback, removal, and error recovery;
- rotary controls, blackout, look changes, reboot, watchdog, and brownout
  recovery;
- every supported output pin, WS2812B and WS2815 timing, configured color
  order/direction, maximum intended pixel count, and current limiting;
- simultaneous LED output plus Wi-Fi/WebSocket/Art-Net traffic with no visible
  flicker, corruption, long pauses, unexpected resets, or unacceptable frame
  loss; and
- a prolonged soak covering repeated reconnects, look changes, and power
  cycles—not only a short bench demonstration.

If any physical behavior is less reliable than the existing production image,
keep the existing image in production and document the failed candidate. Do not
lower the acceptance gate to justify the upgrade.
