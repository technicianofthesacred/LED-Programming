# Lightweaver Visitor UI

> **Status (2026-06): not in the current plan.** The current runtime is
> **ESP32-only** and the **firmware card page is the visitor UI** — this
> separate Pi-hosted app has no host today. It's kept for a planned future
> Raspberry Pi integration. Don't ship or invest in it unless that Pi work is
> resumed; put visitor-facing changes in the firmware (`firmware/lightweaver-controller/`) instead.

Pi-hosted, branded touchscreen UI for the Lightweaver LED installation by Adrian Rasmussen. Visitors connect to the installation WiFi and tap large scene tiles; the Pi proxies preset / power / brightness commands to a WLED-flashed ESP32-S3 over the local network.

## Local development

```bash
npm install
npm run dev          # Vite on :3000 (UI)
WLED_IP=10.0.0.x PORT=3001 npm start   # Express in another terminal
```

The Vite dev server proxies `/api` to `localhost:3001`.

## Production build

```bash
npm run build        # outputs dist/
```

## Pi deployment

```bash
npm install
npm run build
WLED_IP=192.168.4.1 PORT=80 node server/index.js
```

`WLED_IP` defaults to `192.168.4.1` (WLED AP). `PORT` defaults to 3000. Port 80 needs root/`setcap`.

### systemd unit (optional)

Save as `/etc/systemd/system/lightweaver.service`:

```ini
[Unit]
Description=Lightweaver visitor UI
After=network-online.target

[Service]
WorkingDirectory=/home/pi/visitor-ui
ExecStart=/usr/bin/node server/index.js
Environment=PORT=80
Environment=WLED_IP=192.168.4.1
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now lightweaver`.

## Captive portal

Captive portal probes (`/generate_204`, `/hotspot-detect.html`, etc.) redirect to `/`. Full hotspot setup (hostapd / dnsmasq, WLED AP "Always") is documented in `../branded-installation-ui.md`.

## Customizing

Edit the `BRAND` and `SCENES` constants at the top of `src/App.jsx`. Preset ids must match the slot numbers saved in WLED.
