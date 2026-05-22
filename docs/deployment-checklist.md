# Lightweaver — Deployment Checklist

Bench-to-gallery checklist for taking a Lightweaver installation from a working dev rig to a stable on-site deployment. Walk this top-to-bottom for each piece.

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

- [ ] **SSID convention:** `Lightweaver — Adrian Rasmussen` (em dash, single space either side). Append a piece suffix if multiple devices on site, e.g. `Lightweaver — Adrian Rasmussen 02`.
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

## 4. Pi setup

- [ ] **Hostname:** `lightweaver.local` (mDNS) so the visitor-ui server is discoverable without an IP.
- [ ] **Autostart Lightweaver Pi server** — build `lightweaver/dist/`, run `npm run serve:pi`, restart on failure, start after network-online.target. See `docs/pi-hosted-deployment.md`.
- [ ] **Network:** Ethernet to the gallery switch when available; fall back to WiFi STA on the WLED AP for tabletop pieces.
- [ ] **Static IP** (or DHCP reservation) so Madrix and the visitor-ui both have a stable target.
- [ ] **Firewall:** open ports 80 (UI), 6454 (Art-Net) if the Pi is also bridging.

---

## 5. Network topology

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

## 6. On-site smoke test (5 steps)

Run through this end-to-end before opening the gallery.

1. **Power on** the Pi and the WLED controller. Wait ~30 s for both to come up.
2. **Connect a phone** to the `Lightweaver — Adrian Rasmussen` SSID. Confirm captive portal opens, or browse to `http://lightweaver.local`.
3. **Tap the first scene button** in the visitor UI.
4. **Look at the strip** — the corresponding preset should be visible within ~500 ms.
5. **Cycle through every scene button** — each one must produce a visibly different look on the strip. No dark frames, no stuck pixels.

If any step fails, see Section 7.

---

## 7. Failure modes & recovery

| Symptom | Likely cause | Recovery |
|---|---|---|
| Visitor UI loads but lights don't change | WLED unreachable from Pi | SSH the Pi: `curl http://<wled-ip>/json`. If timeout, check WLED is on the AP and STA link is up. Power-cycle WLED if STA dropped. |
| Strip frozen mid-effect | Madrix lost link / Art-Net stream stopped | In WLED, disable Art-Net input briefly to release the lock, then re-enable. Restart Madrix output. |
| Pi reboot after power blip | Power glitch, SD card issue | systemd brings visitor-ui back up automatically. If not, SSH and `systemctl status visitor-ui`. Check SD card health if recurring. |
| Captive portal doesn't trigger on iOS | Known iOS quirk | Tell visitor to manually open Safari and browse to `lightweaver.local` or `4.3.2.1`. Add a printed sign as fallback. |
| Visible stutter / dropped frames | WiFi sleep re-enabled, or interference | Re-check Config > WiFi > Disable WiFi sleep. Move WLED off congested 2.4 GHz channels. |
| Strip section dark | Loose data line, dead pixel, or PSU droop | Inspect physical connection. Check segment config didn't truncate the strip. Measure 5V/12V at the far end of the run. |
