# Lightweaver Standalone Controller Firmware

Arduino/PlatformIO firmware for the sellable ESP32-S3 Lightweaver card. It does not require WLED, a Raspberry Pi, Madrix, a laptop, or live Art-Net at runtime. It boots from internal flash by default, can be configured from the Lightweaver website, and can optionally read advanced `.lwseq` frame packages from microSD.

## Hardware Target

- ESP32-S3 N16R8 or compatible ESP32-S3 board.
- microSD card module wired to SPI.
- WS281x/WS2815-style addressable RGB LEDs.
- One level shifter channel per LED output.
- Shared ground between controller, LED power supply, and microSD module.
- Brightness potentiometer, previous/next buttons, blackout button, and rotary encoder.

## Default Wiring

| Function | GPIO |
| --- | ---: |
| LED output 1 | 16 |
| LED output 2 | 17 |
| LED output 3 | 18 |
| LED output 4 | 21 |
| Encoder A | 4 |
| Encoder B | 5 |
| Encoder press | 6 |
| Previous button | 7 |
| Next button | 8 |
| Blackout button | 9 |
| Brightness pot | 1 |
| Status LED | 2 |
| microSD CS | 10 |
| microSD MOSI | 11 |
| microSD SCK | 12 |
| microSD MISO | 13 |

Buttons use `INPUT_PULLUP`, so wire each button between the GPIO and ground. The brightness potentiometer should be wired as a voltage divider between 3.3 V and ground with the wiper on GPIO 1.

## microSD Layout

Export a Lightweaver Controller package from the app, then unpack it:

```bash
cd lightweaver
npm run standalone:unpack -- ~/Downloads/lightweaver-controller-package.json /Volumes/LIGHTWEAVER
```

The card should contain:

```text
/lightweaver.json
/sequences/001-timeline-render.lwseq
```

Non-sequence controller modes still use `/lightweaver.json`, but may not include a `/sequences` folder.

## Runtime Modes

1. Factory Card: internal flash defaults, no website or microSD.
2. Website Loaded Card: website saves config to ESP32 internal flash.
3. Memory Card Advanced: microSD provides `/lightweaver.json` and `.lwseq` sequences.
4. Live Host Reserved: laptop/Pi/Madrix/sound-reactive control is a future runtime lane.

## Look Types

- `sequence`: plays raw RGB `.lwseq` frame files from microSD.
- `procedural`: renders built-in generative looks such as `aurora`, `ember`, and `rainbow`.
- `preset`: renders utility looks such as `warm-white`, `cool-white`, `photo-white`, `test-red`, `test-green`, `test-blue`, and `blackout`.

The next/previous buttons and encoder switch looks by fading to black, loading the next look, and fading back in. The blackout button toggles a full fade to black.

## Build And Upload

Install PlatformIO, then run:

```bash
cd firmware/lightweaver-controller
pio run
pio run --target upload
pio device monitor
```

The firmware assumes the four default LED output pins: 16, 17, 18, and 21. The profile may use one to four of those outputs. Unsupported profile pins intentionally fail with a status blink instead of silently driving the wrong connector.

## Launch Bench Checklist

1. Format the microSD card as FAT32.
2. Export the controller package from Lightweaver.
3. Unpack the package to the microSD card root.
4. Power the LEDs from the final supply, not from USB.
5. Confirm shared ground between LED power and controller.
6. Verify output 1, then add outputs 2-4 one at a time.
7. Test next, previous, encoder press, brightness, and blackout controls.
8. Let the piece loop for at least 30 minutes before handing it to a buyer.
