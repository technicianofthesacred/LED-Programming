# Lightweaver — Hardware Setup

Action items for the human. These are the steps an agent cannot run from the keyboard alone — they involve a USB cable, a power supply, and eyes on the strip.

---

## 1. Flash WLED 0.15.4 onto the ESP32-S3 N16R8

The firmware binary is in the repo root: `WLED 0.15.4 ESP32-S3 16MB.bin`.

ESP32-S3 expects:
- **Flash offset:** `0x0` (the WLED .bin is a merged image — flash at offset 0, not 0x10000)
- **Baud:** 921600 for upload, 115200 for serial monitor

### Option A — led-art-mapper Web Serial flasher (recommended for first-time)

1. Plug the ESP32-S3 into the host machine via USB-C.
2. Hold **BOOT**, tap **RESET**, release **BOOT** to enter download mode.
3. Open `led-art-mapper/` in a Chromium-based browser (Web Serial is required — Firefox won't work).
4. Open the **Flash firmware** panel.
5. Select the serial port that just appeared, choose `WLED 0.15.4 ESP32-S3 16MB.bin`, click **Flash**.
6. When done, tap **RESET** on the board.

### Option B — esptool.py (command line)

```bash
pip install esptool

# Erase first if reflashing a previously-used board
esptool.py --chip esp32s3 --port /dev/ttyUSB0 erase_flash

# Flash WLED
esptool.py \
  --chip esp32s3 \
  --port /dev/ttyUSB0 \
  --baud 921600 \
  write_flash -z 0x0 \
  "WLED 0.15.4 ESP32-S3 16MB.bin"
```

On macOS the port is typically `/dev/cu.usbmodem*`. On Windows it's `COM<n>`.

---

## 2. Verify WLED comes up

1. Wait ~10 seconds after flashing for first boot.
2. On a phone or laptop, look for a WiFi network named `WLED-AP`. Default password is `wled1234`.
3. Connect, then browse to `http://4.3.2.1`.
4. In the WLED UI, open **Info**. Record:
   - **Version:** must read `0.15.4`.
   - **Free heap:** healthy values are >100 kB at idle. Sub-30 kB means a problem.
   - **Uptime:** should increase as you reload Info.

---

## 3. Configure LED type and length, run a test pattern

1. WLED UI > **Config** > **LED Preferences**.
2. **LED type:** WS2815 (or WS281x — WS2815 uses the same protocol).
3. **Length:** total physical pixel count of the strip for this piece.
4. **Data pin:** the GPIO the strip's data line is wired to (commonly GPIO 16 on the N16R8 dev boards — confirm against your wiring).
5. **Color order:** GRB to start; adjust if a red-only test shows the wrong colour.
6. Save, then in the main UI set brightness to ~64 and apply the **Solid** effect with a pure red. The whole strip should glow red. Try green and blue. If any colour is wrong, fix the colour order.
7. Try the **Chase** or **Running** effect to confirm pixel ordering and direction match the physical strip.

---

## 4. Test Art-Net from Madrix

Minimal Madrix patch to verify Art-Net reception:

1. In Madrix, open **Device Manager > DMX Devices**.
2. Add an **Art-Net** device. Set the IP to the WLED's IP, **universe 0**, transmission **Unicast**.
3. Patch a single tile (170 RGB pixels) onto universe 0.
4. Add a static colour effect (e.g. solid blue at 50% brightness).
5. In WLED: **Sync Interfaces** > enable **Art-Net (DMX)**, set start universe 0, start channel 0, reboot.
6. Start Madrix output. The strip should immediately show the Madrix colour. Stop output — strip returns to the WLED-side effect after the timeout.

If the strip does not respond: confirm the WLED IP is reachable (`ping`), check Madrix is unicasting (not broadcasting to a different subnet), and confirm WiFi sleep is disabled in WLED.

---

## 5. Capture and record (per device)

For every controller deployed, write the following down somewhere durable (a markdown file per device, or a spreadsheet):

- **WLED MAC address** — UI > Info > MAC. Used for DHCP reservations and unique SSID suffixes.
- **IP after AP→STA join** — once joined to the gallery / Pi network, record the assigned IP.
- **Segment configuration JSON dump** — `curl http://<wled-ip>/json > device-<mac>.json`. This snapshots segments, presets, and all settings for disaster recovery.

These three values plus the firmware version are the minimum needed to reproduce a device's runtime state from scratch.
