# Lightweaver Customer Runtime

Lightweaver customer pieces are designed so the ESP32 card owns playback. The website edits and loads the card; it is not required for normal playback.

## Mode 1: Factory Card

The ESP32 starts from internal flash with built-in patterns. No website, laptop, Pi, or memory card is required.

Customer behavior:
- Plug in power.
- The piece starts playing.
- Turn the rotary control to dim or brighten.
- Press the rotary control to move through the saved pattern order.

## Mode 2: Website Loads The Card

The customer or installer connects to the Lightweaver card WiFi and saves settings to internal flash.

Stored on the card:
- LED count and output pin mapping.
- Color order.
- Master brightness limit.
- Rotary brightness direction.
- Push-button pattern order.
- Selected built-in pattern bank.

After the website reports "Saved on card", the card can run by itself.

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
7. Save a website-flash config and reboot.
8. Confirm saved pattern order survives reboot.
9. Insert a prepared microSD package.
10. Reboot and confirm SD sequence playback.
11. Remove microSD and confirm internal flash fallback.
