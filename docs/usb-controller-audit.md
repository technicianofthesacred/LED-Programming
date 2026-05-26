# USB controller audit

Date: 2026-05-26

## Summary

Two ESP32-S3 boards are currently visible over USB.

## Controllers

### WiFi WLED controller, also connected by USB

- USB port: `/dev/cu.usbmodem142101`
- USB product: Espressif USB JTAG/serial debug unit
- MAC: `ac:a7:04:e2:ec:e0`
- Chip: ESP32-S3, revision v0.2
- Flash: 16 MB
- PSRAM: 8 MB
- Current network identity: WLED at `192.168.18.66`
- Current firmware: WLED `0.15.4`

### New USB controller

- USB port: `/dev/cu.usbmodem5B5E0414831`
- USB product: WCH USB Single Serial
- MAC: `44:1b:f6:81:fe:b0`
- Chip: ESP32-S3, revision v0.2
- Flash: 16 MB
- PSRAM: 8 MB
- Secure boot: disabled
- Flash encryption: disabled
- Current network identity: not found on `192.168.18.x`
- Current WLED status: not detected as WLED over WiFi/mDNS
- Current firmware identity: Arduino/FastLED ESP32-S3 build, project name `arduino-lib-builder`, app version `14a0af9`, compiled `2026-03-31 11:43:43`

Serial boot logs from the new controller only showed ESP-ROM boot output. No WLED API, WLED mDNS, Lightweaver protocol, or serial command shell was detected.

## Current interaction reality

The new USB controller was backed up and flashed with temporary Lightweaver USB bench firmware.

- Backup image before flashing: `backups/controllers/esp32s3-441bf681feb0-pre-lightweaver-usb-test-20260526.bin`
- Test firmware: `firmware/lightweaver-usb-led-test`
- Serial port: `/dev/cu.usbmodem5B5E0414831`
- Serial protocol: `115200` baud, newline-terminated `LWUSB` commands
- Output pins driven in parallel: GPIO `16`, `17`, `18`, and `21`
- Pixel protocol: WS2812B / GRB
- Active pixel count during bench test: `60`
- Test brightness during bench test: `48`

Verified responses after flashing:

```text
ID?      -> LWUSB READY firmware=lightweaver-usb-led-test version=1 pins=16,17,18,21 colorOrder=GRB
COUNT 60 -> LWUSB OK pixels=60
BRI 48   -> LWUSB OK brightness=48
WARM     -> LWUSB OK warm
```

The new USB controller is now reachable for:

- chip identification
- MAC/flash/security inspection
- serial boot logs
- flashing new firmware
- direct Lightweaver USB bench commands
- basic LED output tests on GPIO `16`, `17`, `18`, and `21`

It is not yet reachable for:

- WLED JSON API control
- WLED WebSocket frame push
- Lightweaver standalone package playback
- full Lightweaver live USB app control

If the attached LEDs still do not light while `LWUSB OK` commands are returned, the likely fault is downstream of the ESP32 firmware: LED power, shared ground, data wire direction, data pin mismatch, LED protocol/color-order mismatch, or a damaged first pixel.

## Ways Lightweaver can engage this controller

### WLED Basic path

Flash WLED onto the new USB controller, configure WiFi, then control it from Lightweaver through the WLED JSON/WebSocket APIs.

This is the fastest path for Basic:

- stored WLED presets
- WLED effects
- Lightweaver WLED Basic package install
- phone/browser control after WiFi setup

### Standalone Lightweaver path

Flash `firmware/lightweaver-controller`, then provide `/lightweaver.json` and optional `.lwseq` sequence files on microSD.

This is the path for finished standalone artworks:

- no WiFi required at runtime
- no Pi required at runtime
- physical controls
- microSD sequence playback
- procedural/preset looks

Current limitation: this firmware path does not yet expose a live USB control protocol for the browser app.

### Future direct USB app path

Add a Lightweaver serial protocol to the firmware and a matching Web Serial / local bridge transport in the app.

This would allow the app to:

- discover the controller over USB
- read controller identity and firmware version
- set LED count/output pins
- send color tests
- stream preview frames
- upload profile/package data where supported
- switch looks and control brightness without WiFi

This is the right path if USB-first development should feel effortless.
