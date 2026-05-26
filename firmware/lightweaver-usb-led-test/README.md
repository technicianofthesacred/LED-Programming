# Lightweaver USB LED Test Firmware

Temporary bench firmware for verifying an ESP32-S3 controller and attached LEDs over USB before installing WLED or the standalone Lightweaver runtime.

It drives the expected Lightweaver output pins `16`, `17`, `18`, and `21` with the same pixel buffer at low brightness. If the LED data line is on any of those pins and power/ground are correct, the strip should respond.

## Build and upload

```bash
cd firmware/lightweaver-usb-led-test
pio run
pio run --target upload --upload-port /dev/cu.usbmodem5B5E0414831
pio device monitor --port /dev/cu.usbmodem5B5E0414831 --baud 115200
```

## Serial commands

Send newline-terminated commands at `115200` baud:

```text
HELP
ID?
SOLID 255 0 0
SOLID 0 255 0
SOLID 0 0 255
WARM
CLEAR
BRI 32
COUNT 120
CHASE 255 160 0
TEST
```

The firmware replies with `LWUSB ...` lines so scripts and the app can detect it.
