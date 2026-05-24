# Lightweaver — Hardware Setup

Action items for the human. These are the steps an agent cannot run from the keyboard alone — they involve a USB cable, a power supply, and eyes on the strip.

---

## 1. Flash WLED 0.15.4 onto the ESP32-S3 N16R8

The firmware binary is in the repo root: `WLED 0.15.4 ESP32-S3 16MB.bin`.

ESP32-S3 expects:
- **Bootloader offset:** `0x0`
- **Partition table offset:** `0x8000`
- **OTA boot data offset:** `0xe000`
- **WLED app offset:** `0x10000`
- **Baud:** 921600 for upload, 115200 for serial monitor

The repo binary is the official WLED `WLED_0.15.4_ESP32-S3_16MB_opi.bin` app image, not a merged factory image. Do not flash it by itself at `0x0`; that produces a boot loop.

### Option A — esptool.py four-part install (recommended for first-time)

1. Plug the ESP32-S3 into the host machine via USB-C.
2. Hold **BOOT**, tap **RESET**, release **BOOT** to enter download mode.
3. Run the command below, changing the port if needed.

```bash
python3 -m pip install esptool

mkdir -p /tmp/lightweaver-wled-flash
curl -L -o /tmp/lightweaver-wled-flash/bootloader_esp32s3_opi.bin \
  https://wled-install.github.io/suppl_dir/bootloader_esp32s3_opi.bin
curl -L -o /tmp/lightweaver-wled-flash/partitions_16MB.bin \
  https://wled-install.github.io/suppl_dir/partitions_16MB.bin
curl -L -o /tmp/lightweaver-wled-flash/boot_app0_v2022.bin \
  https://wled-install.github.io/suppl_dir/boot_app0_v2022.bin

python3 -m esptool \
  --chip esp32s3 \
  --port /dev/cu.usbmodem142101 \
  --baud 921600 \
  --before default_reset \
  --after hard_reset \
  write_flash \
  --erase-all \
  --verify \
  --flash_mode keep \
  --flash_freq keep \
  --flash_size keep \
  -z \
  0x0 /tmp/lightweaver-wled-flash/bootloader_esp32s3_opi.bin \
  0x8000 /tmp/lightweaver-wled-flash/partitions_16MB.bin \
  0xe000 /tmp/lightweaver-wled-flash/boot_app0_v2022.bin \
  0x10000 "WLED 0.15.4 ESP32-S3 16MB.bin"
```

On macOS the port is typically `/dev/cu.usbmodem*`. On Windows it's `COM<n>`.

### Option B — Lightweaver / led-art-mapper Web Serial flasher (app updates only)

Use the in-browser flasher only after the bootloader, partition table, and OTA boot data are already installed. For the official WLED release `.bin`, use address `0x10000` and leave **Erase all flash first** unchecked.

---

## 2. Verify WLED comes up

1. Wait ~10 seconds after flashing for first boot.
2. On a phone or laptop, look for a WiFi network named `WLED-AP`. Default password is `wled1234`.
3. Connect, then browse to `http://4.3.2.1`.
4. In the WLED UI, open **Info**. Record:
   - **Version:** must read `0.15.4`.
   - **Free heap:** healthy values are >100 kB at idle. Sub-30 kB means a problem.
   - **Uptime:** should increase as you reload Info.

If the controller joins the studio LAN instead of staying in AP mode, run:

```bash
cd lightweaver
npm run doctor:wled -- --scan
```

The doctor lists USB serial evidence, probes likely WLED addresses, ranks discovered controllers, and prints the recommended `WLED_HOST=<ip>` value for the Lightweaver Pi server. To send a low-brightness bench pattern during verification:

```bash
npm run doctor:wled -- --host 192.168.18.66 --test blue
```

Current bench controller, verified May 24, 2026:

- **IP:** `192.168.18.66`
- **MAC:** `aca704e2ece0`
- **Firmware:** `0.15.4`, release `ESP32-S3_16MB_opi`
- **Flash/PSRAM:** 16MB flash, 8MB PSRAM

---

## 3. Commission the controller in Lightweaver

Open **Devices** in Lightweaver and use the controller commissioning workflow:

1. **Find & Connect** discovers WLED through the Pi service, mDNS, or a fallback scan.
2. **Save from WLED** creates a controller profile keyed by MAC address.
3. Fill in **LED Basics**:
   - **LED type:** WS2815 for the current 12V strip plan.
   - **Pixels:** total physical pixel count.
   - **GPIO:** data pin, commonly GPIO 16 unless wiring says otherwise.
   - **Color order:** start with GRB.
   - **Max brightness:** start at 180 or lower until the power budget is confirmed.
4. Use **Color test** buttons, then confirm color once red, green, blue, and white behave as expected.
5. Use **Pixel test** buttons:
   - **First** should light physical pixel 1.
   - **Last** should light the far end.
   - **Every 10** confirms count and rough spacing.
6. Fill in **Power Safety**:
   - Voltage, PSU amps, estimated mA per pixel.
   - Confirm common ground and level shifter status.
7. Click **Save WLED snapshot** to store the current `/json` dump in the project profile.
8. Copy the **Install Report** before taking the controller off the bench.

The **Known-good state** button returns WLED to a low-brightness amber solid. Use it whenever Art-Net, live streaming, or an effect leaves the strip in an unknown state.

---

## 4. Configure LED type and length directly in WLED

1. WLED UI > **Config** > **LED Preferences**.
2. **LED type:** WS2815 (or WS281x — WS2815 uses the same protocol).
3. **Length:** total physical pixel count of the strip for this piece.
4. **Data pin:** the GPIO the strip's data line is wired to (commonly GPIO 16 on the N16R8 dev boards — confirm against your wiring).
5. **Color order:** GRB to start; adjust if a red-only test shows the wrong colour.
6. Save, then in the main UI set brightness to ~64 and apply the **Solid** effect with a pure red. The whole strip should glow red. Try green and blue. If any colour is wrong, fix the colour order.
7. Try the **Chase** or **Running** effect to confirm pixel ordering and direction match the physical strip.

---

## 5. Test Art-Net from Madrix

Minimal Madrix patch to verify Art-Net reception:

1. In Madrix, open **Device Manager > DMX Devices**.
2. Add an **Art-Net** device. Set the IP to the WLED's IP, **universe 0**, transmission **Unicast**.
3. Patch a single tile (170 RGB pixels) onto universe 0.
4. Add a static colour effect (e.g. solid blue at 50% brightness).
5. In WLED: **Sync Interfaces** > enable **Art-Net (DMX)**, set start universe 0, start channel 0, reboot.
6. Start Madrix output. The strip should immediately show the Madrix colour. Stop output — strip returns to the WLED-side effect after the timeout.

If the strip does not respond: confirm the WLED IP is reachable (`ping`), check Madrix is unicasting (not broadcasting to a different subnet), and confirm WiFi sleep is disabled in WLED.

---

## 6. Capture and record (per device)

For every controller deployed, write the following down somewhere durable (a markdown file per device, or a spreadsheet):

- **WLED MAC address** — UI > Info > MAC. Used for DHCP reservations and unique SSID suffixes.
- **IP after AP→STA join** — once joined to the gallery / Pi network, record the assigned IP.
- **Segment configuration JSON dump** — `curl http://<wled-ip>/json > device-<mac>.json`. This snapshots segments, presets, and all settings for disaster recovery.

These three values plus the firmware version are the minimum needed to reproduce a device's runtime state from scratch.
