# Lightweaver USB LED Test Firmware

Temporary bench firmware for verifying an ESP32-S3 controller and attached LEDs over USB before installing WLED or the standalone Lightweaver runtime.

It drives the expected Lightweaver output pins `16`, `17`, `18`, and `21` with the same pixel buffer at low brightness. If the LED data line is on any of those pins and power/ground are correct, the strip should respond.

It also reads a pushable rotary encoder on pins `4` and `5`, with push on
GPIO `0` or GPIO `6` by default, and emits input events over USB:

```text
LWUSB ROTARY turn=clockwise
LWUSB ROTARY turn=counterclockwise
LWUSB ROTARY press
```

Lightweaver maps those events through the Pattern screen rotary organizer:
rotation changes brightness according to the chosen clockwise mapping, and press
cycles through the ordered pattern list.

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
ORDER RGB
ORDER GRB
CHASE 255 160 0
FRAME ff000000ff000000ff
TEST
```

`ORDER` changes the runtime strip byte order without reflashing. Use `RGB` if
`SOLID 255 0 0` should be red but appears green on a strip configured as `GRB`.

`FRAME` accepts packed RGB hex, six hex characters per pixel (`rrggbb`). For
example, the line above sends one red, one green, and one blue pixel.

The firmware replies with `LWUSB ...` lines so scripts and the app can detect it.

## Rotary pins

Default build flags:

```ini
-DLW_ENCODER_A_PIN=4
-DLW_ENCODER_B_PIN=5
-DLW_ENCODER_PRESS_PIN=0
-DLW_ENCODER_PRESS_ALT_PIN=6
-DLW_ENCODER_REVERSED=1
```

If clockwise/counterclockwise is backwards for a different encoder, either swap
A/B wiring or change `-DLW_ENCODER_REVERSED`.
