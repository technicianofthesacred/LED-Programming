# Branded Installation UI — ESP32 + WLED

**Use case:** Art pieces in the field. Visitors connect to the ESP32's WiFi hotspot and get a simple branded page to switch LED patterns. No internet required. Everything served from the device.

---

## How It Works (Visitor Experience)

1. Visitor sees a WiFi network named after your brand/piece (e.g. `Adrian Rasmussen — Piece 01`)
2. They connect — phone auto-opens a browser (captive portal)
3. They see your branded page: logo, your colours, 3–5 named buttons
4. They tap a button — the lights change
5. That's it

---

## Part 1: Branding the WiFi Hotspot (AP Mode)

### Set AP to Always On
In WLED web UI: **Settings → WiFi Setup → "AP opens" → Always**

This ensures the hotspot is always available regardless of whether the device is connected to a router.

### Custom SSID (Two Options)

**Option A — Runtime (no recompile, per-device):**  
Settings → WiFi Setup → change the AP SSID and password fields directly.  
Fast. Good for one-off pieces.

**Option B — Compile-time (baked into firmware):**  
In `wled00/my_config.h`:
```c
#define WLED_AP_SSID "Adrian Rasmussen"
#define WLED_AP_PASS "yourpassword"
```

For multiple pieces with unique IDs, add:
```c
#define WLED_AP_SSID_UNIQUE   // appends MAC address → "Adrian Rasmussen-A1B2C3"
```

### Captive Portal
WLED has a built-in captive portal — when a visitor joins the network, iOS/Android will prompt "Sign in to network" and auto-open the browser to `http://192.168.4.1`. Works reliably on Android; iPhone support can be inconsistent (visitor may need to manually open a browser).

---

## Part 2: The Branded Page

Two approaches — choose based on how much control you want.

---

### Approach A: Replace the WLED UI (self-contained, no Pi needed)

The WLED web UI lives in `wled00/data/index.htm`. You can replace it entirely with your own page. The ESP32 serves it directly — no external server needed.

**Workflow:**
1. Clone WLED: `git clone https://github.com/wled/WLED.git`
2. Install Node: `npm install`
3. Edit `wled00/data/index.htm` with your custom HTML/CSS/JS
4. Build: `npm run build` (compiles UI into C headers)
5. Flash to ESP32 via PlatformIO or VS Code

**Critical rule:** The function `GetV() {}` must remain the **last JavaScript function** in your `<script>` tag. The build system replaces it with device settings code — move it and the device breaks.

**Minimal branded page template:**
```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Adrian Rasmussen</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0a0a0a;
      color: #f0ede8;
      font-family: 'Georgia', serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px 20px;
    }

    .wordmark {
      font-size: 13px;
      letter-spacing: 0.25em;
      text-transform: uppercase;
      opacity: 0.5;
      margin-bottom: 60px;
    }

    h1 {
      font-size: 22px;
      font-weight: normal;
      margin-bottom: 40px;
      opacity: 0.8;
    }

    .scenes {
      display: flex;
      flex-direction: column;
      gap: 12px;
      width: 100%;
      max-width: 320px;
    }

    button {
      background: transparent;
      border: 1px solid rgba(240, 237, 232, 0.25);
      color: #f0ede8;
      font-family: inherit;
      font-size: 15px;
      letter-spacing: 0.1em;
      padding: 18px 24px;
      cursor: pointer;
      transition: background 0.2s, border-color 0.2s;
      text-align: left;
    }

    button:hover   { background: rgba(240,237,232,0.06); border-color: rgba(240,237,232,0.5); }
    button.active  { background: rgba(240,237,232,0.12); border-color: rgba(240,237,232,0.8); }
    button:disabled { opacity: 0.35; cursor: default; }

    .status {
      margin-top: 40px;
      font-size: 11px;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      opacity: 0.3;
      min-height: 16px;
    }
  </style>
</head>
<body>

  <div class="wordmark">Adrian Rasmussen</div>
  <h1>Select a scene</h1>

  <div class="scenes">
    <button data-preset="1">Dusk</button>
    <button data-preset="2">Midnight</button>
    <button data-preset="3">Aurora</button>
    <button data-preset="4">Ember</button>
  </div>

  <div class="status" id="status"></div>

  <script>
    const buttons = document.querySelectorAll('[data-preset]');
    const status  = document.getElementById('status');

    async function loadPreset(id, btn) {
      buttons.forEach(b => b.disabled = true);
      status.textContent = 'Changing…';
      try {
        await fetch('/json/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ps: parseInt(id) })
        });
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        status.textContent = '';
      } catch (e) {
        status.textContent = 'Could not connect';
      } finally {
        buttons.forEach(b => b.disabled = false);
      }
    }

    buttons.forEach(btn => {
      btn.addEventListener('click', () => loadPreset(btn.dataset.preset, btn));
    });

    function GetV() {}
  </script>

</body>
</html>
```

**Testing without reflashing:**  
Open `wled00/data/index.htm` in a browser locally. It will ask for a device IP — enter your WLED device's IP. You can iterate on the design against a live device without recompiling each time.

---

### Approach B: Custom UI on Raspberry Pi (more flexible, easier to update)

The ESP32 runs standard WLED (no UI changes). The Pi hosts your branded page and serves it over the same WiFi network. Visitors connect to the ESP32's AP, which the Pi is also connected to, and browse to the Pi's IP.

```
Visitor → ESP32 WiFi AP → Pi (serves branded UI) → WLED JSON API → LEDs
```

**When to use this approach:**
- You want to update the UI frequently without reflashing
- You need more complex interaction (animations, sound, analytics)
- Multiple WLED devices in one installation

**Pi server (Node.js):**
```javascript
// server.js
const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static('public')); // serves your branded index.html

const WLED_IP = '192.168.4.1';

app.post('/preset/:id', async (req, res) => {
  const r = await fetch(`http://${WLED_IP}/json/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ps: parseInt(req.params.id) })
  });
  res.json(await r.json());
});

app.listen(80);
```

---

## Part 3: Setting Up Presets in WLED

Each button on your page maps to a WLED preset. Set these up once via the WLED web UI, then they persist on the device.

**Creating presets:**
1. Connect to WLED at `http://192.168.4.1`
2. Dial in the effect, colour, and brightness you want
3. Click the bookmark/star icon → **Save preset**
4. Name it (e.g. "Dusk") and assign it a slot number (1–250)
5. Repeat for each scene

**Preset API call:**
```json
POST /json/state
{ "ps": 1 }
```

**Cycle through a range automatically:**
```json
{ "ps": "1~4~" }
```

**Cycle randomly:**
```json
{ "ps": "1~4r" }
```

---

## Part 4: Build Environment

### Tools needed
- [Node.js 20+](https://nodejs.org)
- [Git](https://git-scm.com)
- [VS Code](https://code.visualstudio.com) + [PlatformIO extension](https://platformio.org/install/ide?install=vscode)

### Steps
```bash
git clone https://github.com/wled/WLED.git
cd WLED
npm install

# Edit wled00/data/index.htm with your branded UI
# Then:
npm run build       # compiles UI into firmware headers

# Open in VS Code, select your board env, hit Upload
```

### ESP32-S3 board config (platformio.ini)
```ini
[env:esp32s3]
platform  = espressif32@6.4.0
board     = esp32s3dev
framework = arduino

build_flags =
  ${common.build_flags_esp32s3}
  -D WLED_AP_SSID='"Adrian Rasmussen"'
  -D WLED_AP_PASS='"yourpassword"'

monitor_speed = 115200
upload_speed  = 921600
```

### Per-piece workflow (multiple installations)
1. Flash all controllers with the same base firmware
2. Configure each one individually via the WLED web UI:
   - AP SSID → piece-specific name (or use `WLED_AP_SSID_UNIQUE` at compile time)
   - Create the piece-specific presets
   - Set LED count and pin for that piece's strip
3. Settings persist in device storage — no recompile per piece

---

## Part 5: Deployment Checklist

- [ ] AP mode set to **Always**
- [ ] AP SSID set to your brand/piece name
- [ ] AP password set (or left open if public installation)
- [ ] Presets created and named to match UI buttons
- [ ] Gamma correction enabled (Config → LED Preferences)
- [ ] WiFi sleep disabled (Config → WiFi → Disable WiFi sleep) — prevents Art-Net/AP lag
- [ ] Custom `index.htm` built and flashed (Approach A), or Pi server running (Approach B)
- [ ] Tested captive portal on iOS and Android
- [ ] Preset button labels match preset names in WLED

---

## Resources

- WLED source (UI files): https://github.com/wled/WLED/tree/main/wled00/data
- WLED compiling guide: https://kno.wled.ge/advanced/compiling-wled/
- WLED custom AP config: https://kno.wled.ge/advanced/custom-ap/
- WLED JSON API: https://kno.wled.ge/interfaces/json-api/
- WLED presets: https://kno.wled.ge/features/presets/
- Web installer (no-compile flash): https://install.wled.me/
- wled-ui reference project: https://github.com/xenjke/wled-ui
