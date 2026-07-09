# Lightweaver — Deployment Checklist

> **Current runtime: ESP32-only.** The Lightweaver card is the sole runtime component — it serves the visitor UI, runs patterns, and exposes the local config page. There is no Raspberry Pi in the live runtime path. Sections 4 (Pi setup), 5 (Network topology), and the Pi-specific rows in Section 7 are **deferred — future Pi integration**. They are kept here for reference and will become active when Pi work resumes.

Bench-to-gallery checklist for taking a Lightweaver installation from a working dev rig to a stable on-site deployment. Walk this top-to-bottom for each piece.

---

## How production actually ships

Pushing to this repo does **not** update `led.mandalacodes.com`. The real path:

- **Push to this repo (main)** → CI runs tests (`Tests` workflow + the `test` job in `Deploy site`) and, when the Cloudflare secrets are set, publishes the Studio bundle to the **`studio` preview branch only** (`https://studio.lightweaver-edw.pages.dev`). It never touches production.
- **Production (`led.mandalacodes.com`)** = a **manual** rebuild + wrangler deploy of the **mandalacodes repo's bundle** (which embeds this repo's Studio dist and the factory firmware binary). Exact commands: `docs/led-mandalacodes-setup.md`, "Deploy".
- **Firmware on the live site** only updates with that manual publish — a fresh binary committed here sits in preview until the mandalacodes bundle is republished.
- **Cards already in the field** only update by **USB reflash** (there is no OTA). Reflash from the Flash screen at `led.mandalacodes.com/design/` or the studio preview.

After any production publish, verify the live site serves the firmware this repo built:

```bash
cd lightweaver && npm run check:prod
```

It hashes the live `/firmware/*.bin` against the committed binary and checks the ESP magic byte; it exits 0 with a SKIPPED note when offline (deploy-time check — not part of `test:core`).

---

## 0. Code/runtime launch gate

Run this before the controller leaves the bench, and again after any code, firmware, or exported config change.

- [ ] **Runtime lane chosen and written down:** standalone Lightweaver card, WLED + Pi-hosted visitor UI, or advanced Madrix / Art-Net live host.
- [ ] **Public/local split confirmed:** `led.mandalacodes.com` is the public Studio/setup surface. Actual LED commands must run through the local card page, WLED UI, Pi proxy, or another local bridge.
- [ ] **Launch check passes:** from `lightweaver/`, run `npm run launch:check`. This runs the core runtime contract tests and production Vite build.
- [ ] **Launch package identified:** record the git commit SHA, firmware image/version, exported project package, and any microSD package used for this piece.
- [ ] **Standalone card API sanity** (if using the custom firmware): connect to the card and confirm `GET http://192.168.4.1/api/status`, config apply through `/api/config`, and the low-brightness `/api/recover-lights` path.
- [ ] **Pi proxy sanity** (if Pi-hosted): on the Pi, confirm `curl http://localhost:3000/api/health` and `curl "http://localhost:3000/api/wled/info?ip=<wled-ip>"`.
- [ ] **Controller record saved:** MAC address, final IP/hostname, pixel count, GPIO/output mapping, color order, brightness cap, and latest WLED/controller JSON snapshot.

---

## 1. Pre-deploy WLED config

Configure via the WLED web UI (`http://<wled-ip>` or `http://4.3.2.1` in AP mode) before the device leaves the bench.

- [ ] **Gamma correction ON** — Config > LED Preferences > Gamma correction. Removes the "screaming RGB" look, especially at low brightness.
- [ ] **Color order** matches the strip. WS2815 is typically GRB. Run a red-only test; if it lights green or blue, fix the order.
- [ ] **Max brightness cap** — Config > LED Preferences > Maximum brightness. Set ~200/255 so UI input cannot blow the PSU budget or thermally stress the strip.
- [ ] **WiFi sleep DISABLED** — Config > WiFi Setup > Disable WiFi sleep. **Reason:** with sleep enabled the radio idles between packets, adding 50–200 ms of latency. Art-Net streams at 30–44 Hz, so any sleep-induced delay turns into visible stutter and dropped frames. Slight power cost; mandatory for streaming.
- [ ] **Auto-white** (RGBW only) — Config > LED Preferences > Auto white.
- [ ] LED count and data pin correct for this piece.

---

## 2. AP mode setup

- [ ] **SSID convention (ESP32 card lane):** `Lightweaver-XXXX` where `XXXX` is the last 4 hex digits of the card's MAC address (set automatically by the Lightweaver firmware). _(WLED stock lane: if using stock WLED firmware instead of the Lightweaver card firmware, set the SSID manually — suggested format `Lightweaver-<MAC4>` to stay consistent.)_
- [ ] **Password:** open for public installations, or a simple shared password (e.g. `lightweaver`) if you want to gate access.
- [ ] **Captive portal enabled** — WLED ships this on by default. Verify on iOS and Android: connecting to the SSID should auto-open a browser to `http://4.3.2.1`.
- [ ] **AP mode = Always** — Config > WiFi Setup > "AP opens" > Always. Hotspot stays up regardless of STA link.
- [ ] **Mode choice:**
  - **AP-only** for standalone gallery pieces (no router, visitor connects directly).
  - **AP + STA** when the Pi is the UI host and the WLED needs to also be reachable on the gallery LAN.

---

## 3. Madrix Art-Net config

- [ ] **Universes:** allocate one universe per ~170 RGB pixels (or ~128 RGBW). WLED auto-spans up to 9 sequential universes.
- [ ] **Channels per universe:** **510** (170 px × 3 ch). Leaves the last 2 of 512 unused — standard practice and avoids partial-pixel boundary issues.
- [ ] **IP target:** unicast to the WLED IP (preferred over broadcast — less network noise, more reliable on WiFi).
- [ ] **FPS target:** 30–44 Hz. Below 30 looks choppy; above 44 risks WiFi packet loss on the ESP32.
- [ ] In WLED: Sync settings > DMX input > Art-Net, set start universe + channel to match Madrix output, reboot.

---

## 4. Pi setup _(Deferred — future Pi integration)_

> Skip this section for the current ESP32-only plan. Resume when Pi integration is explicitly started.

- [ ] **Hostname:** `lightweaver.local` (mDNS) so the visitor-ui server is discoverable without an IP.
- [ ] **Autostart Lightweaver Pi server** — build `lightweaver/dist/`, run `npm run serve:pi`, restart on failure, start after network-online.target. See `docs/pi-hosted-deployment.md`.
- [ ] **Network:** Ethernet to the gallery switch when available; fall back to WiFi STA on the WLED AP for tabletop pieces.
- [ ] **Static IP** (or DHCP reservation) so Madrix and the visitor-ui both have a stable target.
- [ ] **Firewall:** open ports 80 (UI), 6454 (Art-Net) if the Pi is also bridging.

---

## 5. Network topology _(Deferred — future Pi integration)_

> This diagram reflects the Pi-hosted future plan. Current ESP32-only topology is in Section 6.

```
  [ Visitor phone ]
        |
        |  WiFi (Lightweaver SSID)
        v
  [ Raspberry Pi 5 ]  <-- hosts visitor-ui (port 80)
        |             <-- mDNS: lightweaver.local
        |  Ethernet / WiFi STA
        v
  [ ESP32-S3 / WLED ] <-- Art-Net listener (UDP 6454)
        |             <-- JSON API (HTTP)
        |  Data pin (GPIO)
        v
  [ WS2815 LED strips ]

  [ Madrix host ] --Art-Net unicast--> [ ESP32-S3 / WLED ]
  (separate machine on same LAN, optional for streaming scenes)
```

---

## 6. ESP32 card smoke test — current plan

This is the actual customer flow for the ESP32-only runtime. Run through end-to-end before the piece leaves the bench.

1. **Power on** the card. The status LED pulses once on boot; the LEDs start playing the default pattern within ~2 s.
2. **Turn the rotary control** — confirm brightness changes. Press it — confirm pattern cycles.
3. **Join the card's AP** — on a phone, open WiFi settings and connect to `Lightweaver-XXXX` (XXXX = last 4 MAC digits printed on the card label or read from `GET /api/status`).
4. **Captive portal** — on iOS/Android the setup page should open automatically. If not, open a browser to `http://192.168.4.1`. Confirm the card's branded scene-selector page loads.
5. **Pick a scene** — tap a scene button. Confirm the strip changes within ~500 ms.
6. **Cycle all scenes** — each button must produce a visibly different look. No dark frames, no stuck pixels.
7. **Optional home-WiFi setup** — in the card page's settings, enter the customer's home WiFi credentials. After reboot the card joins that network and becomes reachable at `lightweaver.local` from any device on the same network.

If any step fails, see Section 7.

---

## 7. On-site smoke test (Pi-hosted) _(Deferred — future Pi integration)_

> For the current ESP32-only plan, use Section 6 above.

Run through this end-to-end before opening the gallery.

1. **Power on** the Pi and the WLED controller. Wait ~30 s for both to come up.
2. **Connect a phone** to the `Lightweaver-XXXX` AP (XXXX = last 4 MAC digits). Confirm captive portal opens, or browse to `http://192.168.4.1`.
3. **Tap the first scene button** in the visitor UI.
4. **Look at the strip** — the corresponding preset should be visible within ~500 ms.
5. **Cycle through every scene button** — each one must produce a visibly different look on the strip. No dark frames, no stuck pixels.

If any step fails, see Section 8.

---

## 8. Failure modes & recovery

### ESP32 card lane (current plan)

| Symptom | Likely cause | Recovery |
|---|---|---|
| No LED output on power-on | Firmware not flashed or bad GPIO config | Check `/api/status` returns correct LED count and GPIO. Reflash firmware. |
| Captive portal doesn't trigger on iOS | Known iOS quirk | Tell visitor to open Safari and browse to `http://192.168.4.1`. Add a printed sign as fallback. |
| Card page loads but lights don't change | Scene bank not loaded or LED count mismatch | Check `GET /api/status`. Use Studio to re-push config. Confirm LED count matches hardware. |
| `lightweaver.local` not reachable after home-WiFi setup | mDNS blocked by router, or card not yet joined | Try the card's IP directly. Check that the card is on the same WiFi subnet. |
| Strip frozen mid-effect | Art-Net stream stalled (if Madrix in use) | Disable Art-Net input on the card briefly, then re-enable. Restart Madrix output. |
| Visible stutter / dropped frames | WiFi sleep re-enabled, or interference | Re-check Config > WiFi > Disable WiFi sleep. Move the card off congested 2.4 GHz channels. |
| Strip section dark | Loose data line, dead pixel, or PSU droop | Inspect physical connection. Check segment config didn't truncate the strip. Measure 5V/12V at the far end of the run. |

### Pi-hosted lane _(Deferred — future Pi integration)_

| Symptom | Likely cause | Recovery |
|---|---|---|
| Visitor UI loads but lights don't change | WLED unreachable from Pi | SSH the Pi: `curl http://<wled-ip>/json`. If timeout, check WLED is on the AP and STA link is up. Power-cycle WLED if STA dropped. |
| Pi reboot after power blip | Power glitch, SD card issue | systemd brings visitor-ui back up automatically. If not, SSH and `systemctl status visitor-ui`. Check SD card health if recurring. |
