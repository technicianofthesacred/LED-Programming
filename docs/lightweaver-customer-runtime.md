# Lightweaver Customer Runtime

Lightweaver customer pieces are designed so the ESP32 card owns playback. The website edits and loads the card; it is not required for normal playback.

As of 2026-05-29, there is no Cloudflare KV relay, pairing-code path, or public polling transport. The public site creates a chip config. The customer loads that config onto the card, and the card runs locally.

## Mode 1: Factory Card

The ESP32 starts from internal flash with built-in patterns. No website, laptop, Pi, or memory card is required.

Customer behavior:
- Plug in power.
- The piece starts playing.
- Turn the rotary control to dim or brighten.
- Press the rotary control to move through the saved pattern order.

## Mode 2: Website Loads The Card

The customer or installer uses Studio v3 at `led.mandalacodes.com` to choose visual patterns, colors, output settings, and knob behavior. The hosted Studio then copies or downloads a chip config. The customer opens the card's local page and pastes the config into the card.

Stored on the card:
- LED count and output pin mapping.
- Color order.
- Master brightness limit.
- Rotary brightness direction.
- Push-button pattern order.
- Selected built-in pattern bank.

After the card page reports the config was applied, the card can run by itself.

Hosted HTTPS pages cannot reliably push directly to local HTTP hardware. Direct push is allowed only from a local HTTP/file Studio session. The reliable customer path is copy/download -> open card page -> paste/apply.

## Mode 3: Memory Card Advanced Sequence

A microSD card adds larger recorded frame sequences. The ESP32 still runs by itself.

Card contents:

```text
/lightweaver.json
/sequences/*.lwseq
```

Boot priority:
1. Valid memory card package.
2. Valid internal flash config.
3. Compiled factory defaults.

## Mode 4: Reserved Live Host

The live-host path is reserved for future laptop/Pi/Madrix/sound-reactive streaming. It is not required for customer playback in Modes 1-3.

## Bench Checklist

1. Flash the standalone Lightweaver controller firmware.
2. Boot with no SD card and confirm default pattern playback.
3. Turn the rotary control and confirm brightness changes.
4. Press the rotary control and confirm pattern cycling.
5. Connect to `Lightweaver-XXXX` WiFi.
6. Open `http://192.168.4.1/api/status` and confirm JSON status.
7. Copy or download a website-flash config from Studio v3.
8. Paste it into the card page, apply it, and reboot.
9. Confirm saved pattern order survives reboot.
10. Insert a prepared microSD package.
11. Reboot and confirm SD sequence playback.
12. Remove microSD and confirm internal flash fallback.
