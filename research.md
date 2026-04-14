# LED Interface Research

**Hardware:** ESP32-S3 N16R8 controller + Raspberry Pi 5  
**Goal:** Control LEDs for laser-cut designs via a custom branded interface  
**Lighting Software:** Madrix (Art-Net output)

---

## 1. The S3-N16R8 Controller

The **ESP32-S3 N16R8** is a microcontroller board with:
- Dual-core processor, WiFi + Bluetooth
- 16MB flash memory + 8MB PSRAM
- 8-channel PWM LED Control (LEDC) peripheral for analog LED brightness
- RMT (Remote Control Transceiver) peripheral — ideal for driving addressable LEDs (WS2812, SK6812, etc.)
- Onboard WS2812B RGB LED (GPIO 38 or GPIO 48 depending on variant)
- All GPIO pins support PWM and interrupts

---

## 2. Firmware Options for the ESP32-S3

### WLED (Recommended for quick start)
- Open-source firmware purpose-built for addressable LEDs
- 100+ built-in effects, 50+ colour palettes
- Built-in responsive web UI, iOS/Android apps
- Full REST HTTP API and JSON API
- Supports E1.31 (sACN), Art-Net, DMX512, MQTT
- ESP32-S3 support: available (XIAO ESP32S3 variants confirmed working as of 2024)
- Project: https://kno.wled.ge

### ESPHome
- YAML-based configuration firmware, integrates tightly with Home Assistant
- Supports LED strips, PWM channels, sensors
- Good if home automation integration is needed
- Full ESP32-S3 support

### Custom Arduino Firmware
- Full control using FastLED, NeoPixelBus, or Adafruit NeoPixel libraries
- **FastLED**: Uses ESP32's RMT peripheral for rock-solid timing on addressable LEDs
- **NeoPixelBus**: Flexible; RMT recommended for ESP32-S3 (note: I2S not available on S3)
- **Arduino LEDC API**: Native PWM for traditional (non-addressable) RGB LEDs

### MicroPython
- Available for prototyping; lower performance than Arduino-based options

---

## 3. LED Control on Raspberry Pi 5

The Pi 5 uses a new RP1 chipset which broke older GPIO libraries — updated libraries are required.

### Library Options

| Library | Method | Pi 5 Support | Notes |
|---|---|---|---|
| `rpi_ws281x` | PWM/DMA | Beta (via dtoverlay) | Most common; needs kernel module |
| `Pi5Neo` | Hardware SPI (GPIO 10) | Full | Recommended for Pi 5; flicker-free |
| CircuitPython NeoPixel | SPI | Full | Adafruit ecosystem |
| `pigpio` | Software GPIO | Partial | May need updates for Pi 5 |

**Recommended for Pi 5:** SPI-based solutions (`Pi5Neo` or CircuitPython via SPI) to avoid GPIO driver compatibility issues.

- Pi5Neo: https://github.com/vanshksingh/Pi5Neo

---

## 4. Raspberry Pi 5 + ESP32-S3 Integration Patterns

### Option A: WLED on ESP32 + HTTP API from Pi (simplest)
1. Flash WLED onto the ESP32-S3
2. Both devices on the same WiFi network
3. Pi sends HTTP/JSON API requests to control WLED
4. Example: `GET http://<wled-ip>/win?bri=255&col=ff0000`
- Guide: https://tynick.com/blog/01-28-2020/controlling-wled-with-raspberry-pi-using-the-wled-api/

### Option B: MQTT Broker on Pi + ESP32 as subscriber
1. Pi runs Mosquitto MQTT broker
2. ESP32 subscribes to MQTT topics; Pi publishes commands
3. Flexible for complex automation or multi-device setups
- Library: PubSubClient (Arduino) on ESP32
- Guide: https://randomnerdtutorials.com/esp32-mqtt-publish-subscribe-arduino-ide/

### Option C: E1.31 / sACN streaming
1. Pi runs lighting software or a custom sender
2. ESP32 running WLED receives E1.31 multicast packets
3. Best for per-pixel, real-time animations from the Pi
- WLED E1.31 docs: https://kno.wled.ge/interfaces/e1.31-dmx/

### Option D: Pi drives LEDs directly (no ESP32)
- Pi 5 drives LED strips directly via SPI using Pi5Neo or rpi_ws281x
- Eliminates the ESP32 but limits to what the Pi's GPIO can drive

---

## 5. Madrix + Art-Net Integration

Madrix acts as the **Art-Net transmitter**; the ESP32-S3 running WLED acts as the **receiving node**.

### How It Works
- Madrix generates Art-Net packets over the network → WLED receives them on the ESP32
- WLED has Art-Net support since v0.10.0

### WLED Configuration for Art-Net
1. In WLED **Sync settings**, enable DMX input
2. Select **Art-Net** as the DMX protocol
3. Reboot the device after changing protocol
4. Set starting DMX universe and starting DMX channel to match Madrix output

### DMX Channel Mapping
| LED Type | Channels per Pixel | LEDs per Universe (512 ch) |
|---|---|---|
| RGB | 3 | 170 pixels |
| RGBW | 4 (incl. dimmer) | 128 pixels |

- WLED automatically spans up to 9 adjacent universes sequentially (up to ~1500 LEDs)

### DMX Modes in WLED
- **RGB mode** — 3 channels per pixel, most common
- **RGBW mode** — 4 channels including master dimmer
- **Effect mode** — 15 channels to control effect parameters (single universe, non-realtime)

### Madrix Configuration
- Art-Net supports universes 0–255 (displayed as 1–256 in Madrix 5)
- Assign universes to devices in **Device Manager > DMX Devices**
- **Transmission mode**: prefer Unicast over Broadcast to reduce network traffic

### Known Limitations / Gotchas
- **ESP32-S3 WLED support is experimental** — standard ESP32 is more stable for Art-Net production use. Test thoroughly before relying on it.
- WiFi + Art-Net can stutter: **disable WiFi sleep in WLED settings** (Config > WiFi > Disable WiFi sleep). Higher power draw but dramatically reduces lag.
- Ethernet is superior to WiFi for stable Art-Net — check if your board supports it.
- Art-Net runs over UDP; keep the WLED device on a reliable, low-latency network segment.

---

## 6. Control Protocols Summary

| Protocol | Transport | Use Case |
|---|---|---|
| HTTP/REST | TCP/WiFi | Simple command-and-response; easy to integrate |
| JSON API | TCP/WiFi | Full WLED feature access (segments, presets, effects) |
| MQTT | TCP/WiFi | IoT pub/sub; good for multi-device/automation |
| E1.31 (sACN) | UDP multicast | Real-time per-pixel streaming; WiFi-friendly |
| Art-Net | UDP broadcast | Same as E1.31; integrates with pro lighting software |
| DMX512 | Serial | Legacy; requires USB-DMX adapter |

---

## 7. Color Management — Reducing Saturation

Default LED colours are often perceived as harsh and over-saturated. Several approaches exist, from no-code to custom firmware.

### Option 1: WLED Built-in Pastel Palette (no-code, quickest)
- WLED ships with a **"Pastel"** palette — low saturation, gentle tones
- Works with any effect that respects palettes

### Option 2: Effect Saturation Slider
- Some effects (e.g. "Cycle all LEDs through rainbow", "Colorful") expose a **saturation slider**:
  - 0–127 → pastel range
  - 128–255 → fully saturated
- Check the effect's parameter sliders in the WLED UI

### Option 3: Custom Palette JSON
- Create `palette0.json` – `palette9.json` files on the WLED device (up to 10 custom palettes)
- Define RGB stops at positions 0–255
- Instead of pure primaries, use softened values — e.g. `(200, 100, 100)` instead of `(255, 0, 0)`
- This gives full control over your exact brand colour range

### Option 4: White Channel Mixing (RGBW strips)
- Use **RGBW LED strips** — RGB + a dedicated white channel
- Adding white to a colour physically desaturates it
- WLED can **auto-calculate the white channel from RGB values** (Config > LED Preferences > Auto white)
- Best physical result; requires RGBW-capable strips and correct WLED strip type config

### Option 5: Gamma Correction
- Gamma correction compensates for human perception of brightness
- Enable in WLED: **Config > LED Preferences > Gamma correction**
- Softens perceived contrast and reduces the "screaming" quality of raw RGB values
- Should be enabled by default for most installations

### Option 6: Color Temperature (CCT)
- WLED supports warm/cool white mixing (WLED v0.13+)
- Per-segment CCT slider available in the UI
- Adds warmth to colours, reducing the clinical brightness of pure LEDs

### Option 7: FastLED Color Correction (custom firmware)
If you fork WLED or write custom firmware:
- **`FastLED.setCorrection()`** — takes a colour correction array to balance R/G/B output
- **`FastLED.setTemperature()`** — applies a named colour temperature profile
- Green LEDs are naturally 3–4× brighter than red; correction arrays compensate
- **HSV model** — control saturation directly: `CHSV(hue, saturation, value)` where saturation 0 = white, 255 = fully saturated

### Recommended Starting Point
1. Enable **gamma correction** in WLED (immediate improvement)
2. Try the built-in **Pastel palette** first
3. Create a **custom palette JSON** with your brand colours at reduced saturation
4. If using RGBW strips, enable **auto white calculation**

---

## 8. Custom Branded Web Interface

### WLED's Built-in UI — Can It Be Modified?
Yes, but it requires recompiling firmware:
- Source lives in `wled00/data/` (HTML, CSS, JS files)
- Edited files are compiled via `npm run build` into C header files
- Rebuild and reflash the ESP32
- Useful for minor tweaks; overkill for a full branded UI

**Recommended instead:** Build a separate custom web app on the Raspberry Pi that calls the WLED JSON API.

### Architecture: Custom UI on Raspberry Pi → WLED JSON API

```
Browser / Tablet
      ↓  HTTP
Raspberry Pi (custom web server)
      ↓  HTTP JSON API
WLED on ESP32-S3
      ↓
LED strips
```

- The Pi serves your branded UI (your fonts, colours, layout)
- The UI calls WLED's `/json` endpoint to control lights
- No ESP32 firmware changes needed

### WLED JSON API — Key Endpoints
```
GET  /json          → returns full device state
POST /json/state    → update brightness, colour, effects, segments
POST /json          → same as above (full state object)
```

**Example — set segment 0 to a custom colour:**
```json
POST /json/state
{
  "seg": [
    { "id": 0, "col": [[200, 100, 80]] }
  ]
}
```

**Example — load a preset:**
```json
POST /json/state
{ "ps": 1 }
```

### Zone-Based UI with WLED Segments
Map each physical zone of your laser-cut design to a WLED **segment**:
- A segment is a range of LEDs (start index → stop index)
- Each segment runs its own effect, colour, and brightness independently
- Configure segments in WLED once, then control them by ID from your custom UI

This means your UI can have buttons/zones that visually match the laser-cut design, each controlling the corresponding LED segment.

### Tech Stack Options for the Custom UI

| Option | Complexity | Best For |
|---|---|---|
| Plain HTML + CSS + JS (fetch API) | Low | Simple zone controls, fast to build |
| Vue.js / Svelte | Medium | Reactive UI without React overhead |
| React + Tailwind | Higher | Complex UI with components, good for long-term |

**For a branded, design-led interface, React + Tailwind is the most flexible.**

### Community Reference Projects
- **wled-ui** — React + TypeScript + Tailwind dashboard for multiple WLED devices  
  https://github.com/xenjke/wled-ui
- **PixelPi** — Multi-WLED manager designed for Raspberry Pi 4/5, runs locally  
  https://pixelpi.co.uk/

### Hosting on Raspberry Pi 5
- Node.js + Express server to serve the UI and proxy API calls to WLED
- Or a simple static file server if the frontend handles API calls directly
- Access via browser on any device on the same network (tablet, phone, desktop)

### Starting Path for Custom UI
1. **Define segments** in WLED that match your laser-cut design zones
2. **Save scenes as presets** for different lighting moods
3. **Build a minimal HTML page** with zone buttons calling `/json/state` via `fetch()`
4. Iterate into a full branded UI once the logic is proven
5. Move to React if the UI grows in complexity

---

## 9. Supporting Software / Tools

| Tool | Platform | Purpose |
|---|---|---|
| WLED | ESP32 firmware | Full-featured LED controller with web UI |
| ESPHome | ESP32 firmware | YAML-configured firmware; HA integration |
| Node-RED | Raspberry Pi | Visual programming for LED automation workflows |
| Mosquitto | Raspberry Pi | Lightweight MQTT broker |
| diyHue | Raspberry Pi | Emulates Philips Hue bridge; WLED-compatible |
| GlowBridge | Raspberry Pi | Ambient lighting: captures video → streams to WLED |
| Home Assistant | Server/Pi | Full home automation hub; integrates WLED, ESPHome |

---

## 10. Recommended Starting Architecture

Given the ESP32-S3 N16R8 + Raspberry Pi 5 setup and a laser-cut design context:

1. **ESP32-S3**: Flash with WLED firmware
   - Gives immediate web UI and mobile app control
   - Enables HTTP/JSON API for custom Pi-side software
   - Supports E1.31 for future real-time animation

2. **Raspberry Pi 5**: Custom control interface (web app or desktop app)
   - Communicates with WLED via HTTP JSON API
   - Can run Node-RED or a custom Python/Node.js server
   - Can host a bespoke web UI tailored to the laser-cut design's zones/segments

3. **Control flow**: Custom UI on Pi → HTTP JSON API → WLED on ESP32 → LED strips

---

## 11. Resources & References

**WLED**
- Project docs: https://kno.wled.ge
- Compatible controllers: https://kno.wled.ge/basics/compatible-controllers/
- JSON API: https://kno.wled.ge/interfaces/json-api/
- HTTP API: https://kno.wled.ge/interfaces/http-api/
- E1.31 / Art-Net / DMX: https://kno.wled.ge/interfaces/e1.31-dmx/
- Segments: https://kno.wled.ge/features/segments/
- Palettes: https://kno.wled.ge/features/palettes/
- Presets: https://kno.wled.ge/features/presets/
- White/CCT handling: https://kno.wled.ge/features/cct/
- Compiling / custom UI: https://kno.wled.ge/advanced/compiling-wled/
- GitHub: https://github.com/wled/WLED/

**Madrix**
- Art-Net device configuration: https://help.madrix.com/m5/html/madrix/hidd_device_page_net.html
- DMX universe settings: https://help.madrix.com/tutorials/html/hidd_dmx_universe_setttings_for_sev.html

**Libraries**
- FastLED: https://fastled.io/
- FastLED HSV colors: https://github.com/FastLED/FastLED/wiki/FastLED-HSV-Colors
- FastLED color correction: https://github.com/FastLED/FastLED/wiki/FastLED-Color-Correction
- Pi5Neo (Pi 5 NeoPixel SPI): https://github.com/vanshksingh/Pi5Neo
- rpi_ws281x Pi 5 support: https://www.hackster.io/news/userspace-ws281x-control-on-the-raspberry-pi-5-inches-closer-with-new-python-library-release-6c8af3e50d9e

**Custom UI**
- wled-ui (React/Tailwind reference): https://github.com/xenjke/wled-ui
- PixelPi (Pi 4/5 WLED manager): https://pixelpi.co.uk/
- WLED control from Pi (HTTP): https://tynick.com/blog/01-28-2020/controlling-wled-with-raspberry-pi-using-the-wled-api/

**Other**
- ESP32-S3 N16R8 component docs: https://docs.cirkitdesigner.com/component/4b4ed254-a856-4650-890b-973cc80257bd/esp32-s3-n16r8
- MQTT ESP32 + Pi guide: https://randomnerdtutorials.com/esp32-mqtt-publish-subscribe-arduino-ide/
- GlowBridge ambient lighting: https://github.com/HonkeyKong/GlowBridge
- diyHue bridge: https://diyhue.org/
