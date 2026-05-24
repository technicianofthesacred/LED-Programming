# Lightweaver Pi-hosted deployment

Practical Raspberry Pi 5 deployment path for gallery use. This serves the Lightweaver Vite build and keeps WLED control behind the Pi service so phones and browsers do not need direct cross-origin access to the ESP32 controller.

## Build and run

From `lightweaver/`:

```bash
npm ci
npm run build
PORT=3000 WLED_HOST=192.168.1.42 npm run serve:pi
```

Open `http://lightweaver.local:3000` or `http://<pi-ip>:3000`.

For first-time setup, find the controller before starting the server:

```bash
npm run doctor:wled -- --scan
```

Use the printed `WLED_HOST=<ip>` value when launching the Pi service. On the current bench network the verified controller is `192.168.18.66`.

Useful scripts:

- `npm run build`: writes the static app to `lightweaver/dist/`
- `npm run serve:pi`: serves `dist/` and `/api/wled/*`
- `npm run pi:start`: builds, then starts the Pi server
- `npm run doctor:wled -- --scan`: finds USB serial and WLED network devices

## WLED API routes

The Pi server proxies the WLED JSON and WebSocket interfaces:

- `GET /api/wled/discover`: mDNS and quick probes
- `GET /api/wled/discover?scan=1`: mDNS plus local subnet scan
- `GET /api/wled/info?ip=<wled-host>`: proxied `/json/info`
- `GET /api/wled/state?ip=<wled-host>`: proxied `/json/state`
- `POST /api/wled/state?ip=<wled-host>`: proxied state update
- `POST /api/wled/test?ip=<wled-host>`: low-brightness solid-color bench test
- `GET /api/wled/snapshot?ip=<wled-host>`: full WLED `/json` config/state snapshot
- `POST /api/wled/recover?ip=<wled-host>`: low-brightness known-good amber recovery state
- `WS /api/wled/ws?ip=<wled-host>`: proxied WLED frame WebSocket

Set `WLED_HOST=<ip-or-hostname>` if one controller is the default. The UI still accepts an IP address and sends it as `?ip=`.

## Controller commissioning

The Devices panel now stores controller profiles in the Lightweaver project. Each profile records MAC, IP, generated hostname, firmware, LED basics, power budget, calibration state, Art-Net notes, wiring notes, and the latest WLED snapshot. Use this flow on the Pi before a gallery install:

1. Devices > **Find & Connect**.
2. **Save from WLED** to create or refresh the profile.
3. Confirm LED basics, color order, pixel count, power budget, and wiring.
4. **Save WLED snapshot**.
5. Copy the generated **Install Report**.

The profile is project data, so exporting or backing up the project preserves the controller commissioning record.

## systemd service

Create `/etc/systemd/system/lightweaver.service`:

```ini
[Unit]
Description=Lightweaver gallery controller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/pi/lightweaver/lightweaver
Environment=NODE_ENV=production
Environment=PORT=3000
Environment=WLED_HOST=192.168.1.42
ExecStart=/usr/bin/npm run serve:pi
Restart=on-failure
RestartSec=3
User=pi

[Install]
WantedBy=multi-user.target
```

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now lightweaver
sudo systemctl status lightweaver
```

For port 80, either set `PORT=80` and grant Node the binding capability, or put nginx/Caddy in front of `localhost:3000`.

## Smoke test on site

1. `curl http://localhost:3000/api/health` on the Pi.
2. `curl "http://localhost:3000/api/wled/info?ip=<wled-ip>"`.
3. Open the app on a phone at `http://lightweaver.local:3000`.
4. Devices panel: scan, connect, send a test pattern.
5. Pattern or Live screen: verify frame push changes the LEDs.

Real-controller testing is still required for WebSocket throughput, segment layout, Art-Net coexistence with Madrix, and WLED preset behavior.
