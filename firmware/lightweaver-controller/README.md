# Lightweaver Standalone Controller Firmware

Arduino/PlatformIO firmware for the sellable ESP32-S3 Lightweaver card. It does not require WLED, a Raspberry Pi, Madrix, a laptop, or live Art-Net at runtime. It boots from internal flash by default, can be configured from the Lightweaver website, and can optionally read advanced `.lwseq` frame packages from microSD.

There is no public relay in this firmware. It does not register with `led.mandalacodes.com`, display pairing codes, heartbeat to Cloudflare, or poll for remote commands. The public Studio exports a chip config; the card stores and runs it locally.

## Hardware Target

- ESP32-S3 N16R8 or compatible ESP32-S3 board.
- microSD card module wired to SPI.
- WS281x/WS2815-style addressable RGB LEDs.
- One level shifter channel per LED output.
- Shared ground between controller, LED power supply, and microSD module.
- Optional previous/next buttons, blackout button, rotary encoder, and brightness potentiometer.

## Default Wiring

| Function | GPIO |
| --- | ---: |
| LED output 1 | 16 |
| LED output 2 | 17 |
| LED output 3 | 18 |
| LED output 4 | 21 |
| Encoder A | 4 |
| Encoder B | 5 |
| Encoder press | 0 (alternate 6) |
| Previous button | 7 |
| Next button | 8 |
| Blackout button | 9 |
| Brightness pot | disabled by default (optional GPIO 1) |
| Status LED | 2 |
| microSD CS | 10 |
| microSD MOSI | 11 |
| microSD SCK | 12 |
| microSD MISO | 13 |

Buttons use `INPUT_PULLUP`, so wire each button between the GPIO and ground. GPIO 0
is the default encoder press input and GPIO 6 is its alternate. The optional
brightness potentiometer is disabled until assigned in the card configuration;
when GPIO 1 is selected, wire it as a voltage divider between 3.3 V and ground.

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
The profile is bound to the exact card ID. Every sequence entry declares its
byte length and SHA-256 digest; the card verifies both before playback.
If a factory reset is performed while the microSD card is absent, firmware
stores a reset marker and ignores old SD autorun projects until a newly
installed configuration explicitly clears that marker.

## Runtime Modes

1. Factory Card: internal flash defaults, no website or microSD.
2. Website Loaded Card: Studio v3 exports a config, then the card page saves it to ESP32 internal flash.
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

### Rebuild the website's flashed binary

The public Studio (led.mandalacodes.com) flashes a prebuilt factory image —
`lightweaver/public/firmware/lightweaver-controller-esp32s3-factory.bin` — to the
card at `0x0`. **This binary does not rebuild itself**, so after any firmware
source change you must regenerate it or every flashed card runs old firmware:

```bash
firmware/lightweaver-controller/scripts/build-factory-bin.sh
git add lightweaver/public/firmware/lightweaver-controller-esp32s3-factory.bin
git commit -m "Rebuild Lightweaver factory firmware binary"
cd lightweaver && npm run deploy:pages   # publish so the site serves it
```

The `factory-bin-freshness` test (in `npm run launch:check`, or `npm run
firmware:check-bin`) fails until the committed binary is at least as new as the
firmware source, so this can't silently go stale again.

## Stability & Power

The firmware includes runtime-safety behavior aimed at gallery uptime and
brownout resilience:

- **Power cap:** Studio exports 80% of the configured supply rating as
  `led.maxMilliamps` (for example, `3200` for a 5 V / 4 A supply). The firmware
  defaults to a conservative 1500 mA when no valid cap is supplied. FastLED
  scales all pixels down uniformly to stay under that current budget, which
  stops a full-white frame from sagging the rail into a brownout reset.
- **Crash auto-recovery:** if the previous boot ended in a brownout, panic, or
  watchdog reset, the card comes up in the visible low-brightness warm-white
  recovery state instead of silently re-entering whatever failed.
- **Task watchdog:** the loop task is watched with an 8 s timeout
  (`LW_WDT_TIMEOUT_S` build flag) and reboots the card if a handler ever wedges.
- **Discovery:** the card advertises both `_http._tcp` and `_wled._tcp` over
  mDNS with a MAC-suffixed AP name (`Lightweaver-XXXX`) and default hostname
  (`lightweaver-xxxx.local`). Studio also accepts a manually entered numeric
  address when a network does not resolve mDNS.
- **iOS captive portal:** Apple probe paths return a non-Success page so the
  setup UI reliably pops when a phone joins the `Lightweaver-XXXX` AP.

## Launch Bench Checklist

1. Format the microSD card as FAT32.
2. Export the controller package from Lightweaver.
3. For website-flash pieces, paste the chip config into the card page and apply it.
4. For microSD pieces, unpack the package to the microSD card root.
5. Power the LEDs from the final supply, not from USB.
6. Confirm shared ground between LED power and controller.
7. Verify output 1, then add outputs 2-4 one at a time.
8. Test every fitted control: next, previous, encoder press, optional
   brightness, and blackout.
9. Let the piece loop for at least 30 minutes before handing it to a buyer.
