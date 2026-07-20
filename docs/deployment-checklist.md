# Lightweaver — Deployment Checklist

> **Current runtime: ESP32-only.** The Lightweaver card is the sole runtime component — it serves the visitor UI, runs patterns, and exposes the local config page. There is no Raspberry Pi in the live runtime path. Sections 4 (Pi setup), 5 (Network topology), and the Pi-specific rows in Section 7 are **deferred — future Pi integration**. They are kept here for reference and will become active when Pi work resumes.

Bench-to-gallery checklist for taking a Lightweaver installation from a working dev rig to a stable on-site deployment. Walk this top-to-bottom for each piece.

---

## How production actually ships

This repo owns `led.mandalacodes.com`:

- **Push to this repo (`main`)** → CI runs the launch gate and, when the Cloudflare secrets are set, deploys this repo's root Studio artifact to the production branch of the `lightweaver` Pages project.
- **Production (`led.mandalacodes.com/`)** opens Studio directly. There is no second mount or parent-site build step.
- **Firmware on the live site** comes from `lightweaver/public/firmware/` in the same deployment.
- **Cards already in the field** only update by **USB reflash** (there is no OTA). Reflash from the Flash screen at `led.mandalacodes.com/` or a verified preview deployment.
- **Workshop cards** use the guided root Studio route `https://led.mandalacodes.com/#screen=production` in desktop Chrome or Edge. The website verifies the immutable artwork job and official firmware before it asks for USB; no native app or paid signing service is required for this browser-first lane.

**Customer entry policy:** every install, connection, configuration, update, and recovery flow starts at `https://led.mandalacodes.com/`. The root Studio is the product; `/design` is not required. `lightweaver.local`, `192.168.4.1`, and numeric card addresses are technician diagnostics only. Studio may open a card-local session as part of its guided connection flow, but customers are not instructed to type or remember those addresses.

### Signed firmware handoff

Firmware source and the production artifact land in two deliberate steps:

1. A firmware/release-policy change lands on protected `main`.
2. `.github/workflows/build-firmware.yml` verifies the source, then the protected `firmware-release` environment rebuilds the merged image, creates the immutable manifest and provenance, signs them with `LIGHTWEAVER_RELEASE_SIGNING_KEY`, commits the release set to `main`, and dispatches the site deployment.

The manifest `buildId` and provenance source revision must equal the exact source commit used by CI. A firmware source commit makes `factory-bin-freshness` fail until that protected build/sign commit exists. This is an intentional deployment block: do not bypass it and do not deploy a source-only firmware change.

`MINIMUM_PRODUCTION_FIRMWARE_VERSION` in `lightweaver/src/lib/firmwareRelease.js` is the oldest signed release the normal installer may replay. Raise it only when an older signed release is known unsafe, with a documented reason, updated policy tests, a safe replacement release, protected CI rebuild/signing, and bench verification. Ordinary releases do not raise the floor; never lower it to accept stale firmware.

After any production publish, verify the live site serves the firmware this repo built. Two ways:

- **From any phone or laptop, no clone or install (browser self-check):** open
  `https://led.mandalacodes.com/#screen=card&section=support`, choose
  **Deployment check**, and press **Run deployment check**. It verifies, in the
  browser, the manifest signature against the pinned release key, the factory
  image hash, matching provenance, every indexed production job artifact, and
  the production cache policies. All rows green = the live deployment serves a
  coherent signed release. This catches stale, partial, or corrupted publishes;
  because the page comes from the origin it is checking, the fully independent
  audit remains the script below.

- **From a repo checkout (independent audit):**

```bash
cd lightweaver && npm run check:prod
```

It hashes the live `/firmware/*.bin` against the committed binary and checks the ESP magic byte; it exits 0 with a SKIPPED note when offline (deploy-time check — not part of `test:core`).
It also requires the root Studio shell and an exact branded HTTP 404 at the
retired route. It verifies the detached firmware signature, published provenance,
production-job index, and every indexed content-addressed job artifact. For a
preview, set `PROD_ORIGIN` once so every check uses the same deployment.

---

## 0. Code/runtime launch gate

Run this before the controller leaves the bench, and again after any code, firmware, or exported config change.

- [ ] **Runtime lane chosen and written down:** standalone Lightweaver card, WLED + Pi-hosted visitor UI, or advanced Madrix / Art-Net live host.
- [ ] **Single entry confirmed:** customer instructions, QR codes, install, reconnect, configuration, update, and recovery all begin at `https://led.mandalacodes.com/`; no customer step requires a local hostname or IP.
- [ ] **Source gate passes:** from `lightweaver/`, run `npm run launch:source`. This runs source/runtime contracts, both Show and Production Setup Playwright suites, the production build, and staged Pages assertions without pretending a feature branch can sign firmware.
- [ ] **Signed launch gate passes:** run `npm run launch:check` on the protected release commit. It repeats the source gate and then requires the committed signed factory binary to be fresh against firmware source. A source-only firmware change must fail here.
- [ ] **Signed release complete:** after firmware changes, confirm protected CI committed the rebuilt image, signed manifest/signature, immutable release, and provenance before running the deploy workflow.
- [ ] **Launch package identified:** record the Studio git commit, firmware version, manifest `buildId`, provenance source revision, exported project package, and any microSD package used for this piece.
- [ ] **Installer policy reviewed:** verify the production firmware floor was unchanged for an ordinary release, or record the safety reason and replacement release when deliberately raising it.
- [ ] **Customer connection semantics:** verify Connect Lightweaver offers the working-card/blank-card choice, resumes a remembered stable card ID without asking for an IP, and refuses a different card until explicit adoption.
- [ ] **Physical acknowledgement semantics:** verify Studio distinguishes Previewing, Sending, and Playing; malformed, rejected, wrong-card, or stale acknowledgements never change the confirmed physical selection.
- [ ] **Standalone card API sanity — technician diagnostic only:** after confirming the stable card ID, inspect `/api/status`, `/api/config`, and `/api/recover-lights` at the card's confirmed local address. Never substitute this diagnostic for the customer website flow.
- [ ] **Pi proxy sanity** (if Pi-hosted): on the Pi, confirm `curl http://localhost:3000/api/health` and `curl "http://localhost:3000/api/wled/info?ip=<wled-ip>"`.
- [ ] **Controller record saved:** MAC address, final IP/hostname, pixel count, GPIO/output mapping, color order, brightness cap, and latest WLED/controller JSON snapshot.

### Pattern Lab release acceptance

Pattern Lab is a separate/private Studio workspace, but its delivery paths
touch browser rendering, card streaming, microSD playback, physical wiring,
and firmware capabilities. Complete this section on the final integrated
commit before merging, signing, or deploying the feature.

Automated source gate:

- [ ] From `lightweaver/`, run:
  `node --test src/lib/patternLab*.test.js src/lib/lwseqBake.test.js src/lib/offlineAudioLanes.test.js src/lib/xlightsExport.test.js src/lib/madrixPatchExport.test.js`.
- [ ] Run:
  `npx playwright test tests/pattern-lab-*.spec.ts --project=chromium --workers=1`.
- [ ] Run `node tests/standalone-package-unpack.mjs`,
  `node tests/card-frame-stream.mjs`, and
  `node tests/card-live-preview.mjs`.
- [ ] Run `npm run test:core`, `npm run build`, and
  `npm run launch:check`.
- [ ] From `firmware/lightweaver-controller/`, run
  `pio test -e native` and `pio run`.
- [ ] Confirm existing Patterns, Layout, Playlist, Show, Card, installer,
  production, persistence, migration, and recovery suites still pass; Pattern
  Lab must not weaken or replace those paths.

Browser/operator gate:

- [ ] Open `#screen=pattern-lab` on desktop and phone. Confirm the mapped
  artwork remains usable, the phone control drawer is reachable, and leaving
  the route disposes the worker without changing the active project.
- [ ] Create and reopen a private ten-minute Slow Bloom draft, compare
  Source/Draft, scrub Beginning/Middle/End, select a seeded variation, and
  confirm there is no obvious short-loop reset.
- [ ] Analyze a WAV locally. Confirm the recipe contains numeric lanes,
  settings, and a fingerprint but no WAV bytes or upload; compatibility must
  be **Bake to card**.
- [ ] Bake the same canonical recipe/layout/seed/FPS twice and compare the
  `.lwseq` bytes and sidecar hashes. Confirm cancel leaves no partial export and
  unknown physical order or unresolved audio fails closed.
- [ ] Export one xLights model, MADRIX fixture CSV, and Art-Net setup note;
  compare their first/last pixels, outputs, universe/channel assignments, and
  direction with the locked wiring map.
- [ ] Confirm Advanced Graph, Shader Bake, and card Art-Net recording remain
  disabled by default. Do not enable card-side recording for release.
- [ ] Confirm the visible Use in Project confirmation adds a new asset and
  never overwrites a built-in or existing look. Until that UI is connected,
  recipe/`.lwseq` export is the supported handoff and the branch is not ready
  for release.

Physical ESP32-S3 gate — required; automation cannot replace it:

- [ ] Connect the phone/Studio and card on the same installation LAN or the
  card AP. Do not test through a public HTTPS-to-local HTTP assumption, cloud
  relay, or Raspberry Pi; none is in the current runtime.
- [ ] Run **Preview on Lights**, then Stop, navigate away, force one delivery
  error, and supersede the stream from another tab. In every case confirm the
  previous card zones/look are restored, or the documented safe fallback is
  used when no snapshot exists.
- [ ] Compare a representative native recipe with the mapped Studio preview:
  geometry, seed, timing, palette, brightness, and motion must match. The
  firmware capability descriptor must continue to report physical parity as
  unverified until this evidence is recorded.
- [ ] Play a complex baked recipe from microSD for its complete intended
  duration. Verify exact physical order across every output, clean loop/end
  behavior, stable frame rate, and no corruption after reboot/power loss.
- [ ] Verify RGB/color order, gamma, white balance, brightness ceiling, current
  limiting, temperature, networking, and SD stability on the intended supply
  and pixel load.
- [ ] Record card/build identity, recipe hash, physical-layout hash, `.lwseq`
  hash, test layout, duration, and pass/fail evidence with the installation
  record.

See [the Pattern Lab operator guide](pattern-lab-user-guide.md) and
[algorithm provenance](pattern-lab-algorithm-provenance.md).

### Workshop Production Setup acceptance

The worker procedure is [worker-flash-runbook.md](worker-flash-runbook.md). Complete this gate before telling workers to use the production website.

- [ ] **Job release prepared:** publish each job with `scripts/build-production-job.mjs`; confirm `public/production/jobs/index.json` names only immutable digest URLs and the staged artifact verification passes.
- [ ] **Protected firmware release prepared:** let `build-firmware.yml` build and sign the exact merged firmware source. Never copy a locally built binary over the signed artifact or weaken `firmware:check-bin`.
- [ ] **Root route verified:** run the Production Setup Playwright suite, then confirm the deployed `https://led.mandalacodes.com/#screen=production` opens the worker workflow from the root site without `/design` or Bridge.
- [ ] **Live assets verified:** after Pages publishes, run `PROD_CHECK_REQUIRED=1 npm run check:prod`; require the root shell, retired-route 404, signed image, matching provenance, immutable job index/artifacts, and committed/live firmware hash to agree.
- [ ] **No-code worker rehearsal:** a worker who did not build the software completes the runbook using only the website, printed job code/QR, one data cable, one card, and the powered fixture.
- [ ] **Real physical acceptance:** on an actual card and strip, record install/update, exact identity read-back, every blue/red/dark boundary, a temporary correction confirmed, a correction allowed to roll back, reboot recovery, pass export, and Next-artwork reset.
- [ ] **Records exported:** save both CSV and JSON outside browser storage at the end of the batch.

**Current release limiter (updated 2026-07-18):** The committed public factory artifact is no longer stale — protected CI rebuilt and signed the merged firmware source in `582a476` and `factory-bin-freshness` passes. The remaining limiter is **physical acceptance**: the real-card checklist above (worker rehearsal, identity read-back, boundary checks, rollback, pass records) has not been recorded, and any new firmware source change (for example the 2026-07-18 pattern-preview repair) re-arms the freshness gate until protected CI signs it again. Do not claim the production workflow is physically accepted until those records exist.

### Physical wiring acceptance — real card and artwork required

Studio's automated tests prove the wiring compiler, drag/drop interactions, Auto Wire determinism, delivery acknowledgement, rollback, and assembly-map generation. They do **not** prove the installation's physical wires. Complete every item below beside the powered artwork; do not mark these passed from a mocked browser run.

- [ ] **Output identity:** run Wire → Bench test and confirm each connector label/GPIO lights only its intended physical output.
- [ ] **Pixel boundary:** for every output/run, confirm pixel 1 is blue, the proposed final pixel is red, and every pixel outside that boundary stays dark. Use the inline +/− controls until the physical endpoint is exact.
- [ ] **Direction and order:** confirm the blue-to-red boundary follows every run in its physical direction and lane order; record corrections in Studio.
- [ ] **Jumper routing:** compare every cable-jump prompt and assembly-map destination with the installed wire, including estimated length and strain relief.
- [ ] **Reserved addresses:** confirm every reserved-unlit block stays dark and consumes the documented address count.
- [ ] **Color order:** run a red/green/blue check on every output and correct RGB/GRB/etc. before signoff.
- [ ] **Brightness cap:** verify the configured current/brightness limit against the real PSU and wiring gauge.
- [ ] **Automatic rollback:** stage a deliberately wrong GPIO, start the 90-second test, do not confirm it, and verify the card returns to the last confirmed GPIO/pixel count without Studio.
- [ ] **Reset during test:** restart or power-cycle during an unconfirmed wiring test and verify the card boots the last confirmed wiring instead of re-arming the candidate.
- [ ] **Wire discovery exit:** start Find my LED wire, confirm no more than four color/GPIO choices are active, then close it and verify the card returns to normal playback.
- [ ] **Recover Lights:** while a wiring candidate or diagnostic output is active, invoke Recover Lights and verify the card cancels it, restores confirmed wiring, reconnects, and produces visible output. The UI must still ask the person whether light is visible.
- [ ] **Locked wiring saved:** complete verification, lock the canonical wiring, save the project file, install that exact revision on the card, and archive the printed assembly map with the controller record.

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

1. **Start at Studio** — open `https://led.mandalacodes.com/` and select Connect Lightweaver.
2. **Choose physical condition** — select My card already lights up or Blank or not responding. Confirm Studio presents one supported next action.
3. **Install when needed** — use the one-button official installer. Confirm identity/target and signed release verification occur before destructive confirmation; do not choose a local firmware file.
4. **Join setup Wi-Fi when instructed** — connect to `Lightweaver-XXXX`, return to Studio, and press Continue. Do not type a local IP.
5. **Verify identity** — confirm Studio reports the expected stable card ID, firmware version, and build ID before hardware changes.
6. **Power-on playback** — the status LED pulses once on boot and LEDs start the saved/default pattern within ~2 s.
7. **Physical controls** — turn the rotary control to change brightness and press it to cycle the saved pattern order.
8. **Acknowledged preview** — choose three patterns rapidly in Studio. Only the newest intent may become Playing on Lightweaver and the physical LEDs must match it.
9. **Failure truth** — return malformed or rejected acknowledgement in a controlled bench test. Studio must preserve the prior physical selection and offer Reconnect and Retry with the standard failure message.
10. **Reconnect** — close the card page/session. Studio must stop claiming live physical output, then reconnect the expected card from the Card Status control without asking for an IP.
11. **Recovery** — start a temporary diagnostic/stream, invoke Recover Lights in Studio, and confirm it releases temporary ownership, restores confirmed state, receives acknowledgement, and asks whether light is physically visible.
12. **Offline playback** — disconnect Studio/internet and confirm the card continues standalone playback and physical controls.

If any step fails, see Section 7.

### Output-correctness acceptance fixture

Run this fixture after firmware or controller-package changes and before approving any new effect work. Use a strip with the first LED clearly marked **blue end** and the final LED clearly marked **red end**. Keep the same power supply, LED count, color order, brightness limit, and camera exposure for the whole run.

Record `GET /api/status` before and after each source change. Its `lwOutput` object must report the expected `sourceClass`, `brightnessByte`, output gamma/calibration values, measured FPS, and dithering state.

- [ ] **Direction and channel order:** display first LED blue and final LED red, with all LEDs between them black. The marked ends and colors must match exactly.
- [ ] **Primary/white frames:** display full red, green, blue, then white. No channel may be swapped, stuck, or contaminated by another channel.
- [ ] **Neutral ramps:** display a gray ramp and a low-level gradient. Brightness must increase monotonically without a black step after the first non-zero value. With output gamma disabled and calibration at `1/1/1`, the result is the legacy-neutral baseline.
- [ ] **Gamma comparison:** repeat the ramps with output gamma disabled, then enabled at `2.2`. The enabled run must preserve black and full scale while visibly redistributing intermediate levels. Confirm `lwOutput.gammaEnabled` and `gammaValue` match the active package.
- [ ] **Calibration comparison:** at low brightness, reduce one calibration channel at a time and confirm only that physical channel is reduced. Restore `red/green/blue` to `1/1/1` before continuing.
- [ ] **Local brightness composition:** play one local look at master `100%`, then `50%`. The second reading and visible output must be lower, with the local look's own brightness/fade still active and no abrupt source change.
- [ ] **Studio live frame:** send the same known frame at master `100%`, then `50%`. `lwOutput.sourceClass` must read `external`; the active local look brightness/fade must not alter either live frame.
- [ ] **Art-Net live frame:** send that frame by Art-Net at master `100%`, then `50%`. Confirm the same external-source brightness behavior as Studio and no double dimming.
- [ ] **Source transitions:** move local → Studio → local → Art-Net → local. Each accepted source must take ownership cleanly, and local playback must resume after the stream watchdog expires without a stuck or stale frame.
- [ ] **Blackout and recovery:** trigger blackout, confirm all physical LEDs are off, then run **Recover lights**. Confirm frame producers stop before recovery, the recovery output is low brightness, and ordinary local playback can resume.
- [ ] **Current-limit stress:** show full white at the installation brightness cap for the planned dwell time. Confirm stable voltage, temperature, frame rate, and no resets, flicker, or visible color shift.
- [ ] **Dithering threshold:** hold an external stream at or above `100 FPS`, then below `100 FPS`, long enough for FastLED's internal measurement to settle. Confirm `lwOutput.dithering` matches the state used by the last transmitted frame without changing the source contract. FastLED 3.10 forcibly disables controller dithering below `100 FPS`; Lightweaver deliberately reports and follows that effective library boundary.

Do not mark the output phase visually accepted from software tests alone. Save the card identity, package hash/commit, fixture settings, diagnostic snapshots, and pass/fail notes with the controller record.

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
| No LED output on power-on | Firmware not installed, unsafe/stale release, or bad GPIO config | Start at `led.mandalacodes.com`, use Recover Lights, then follow the guided signed install/recovery path. A technician may inspect status only after confirming card identity. |
| Setup page does not open after joining `Lightweaver-XXXX` | Browser captive-portal or local-network permission | Return to Studio and press Continue/Retry from the Card Status flow. Escalate local-address inspection to a technician. |
| Studio preview changes but lights do not | Card did not acknowledge the newest physical intent | Use the adjacent Reconnect action, then Retry. Do not accept the Studio preview as proof of physical output. |
| Expected card does not reconnect | Different network, card page closed, or a different card answered | Use Card Status → Reconnect expected card. Adopt a different stable ID only through Use this card instead. |
| Recovery does not produce visible light | Temporary owner, invalid wiring, firmware failure, power, or data path | Run Recover Lights from Studio and record its acknowledgement. If still dark, proceed to guided USB recovery and physical power/data diagnostics. |
| Strip frozen mid-effect | Art-Net stream stalled (if Madrix in use) | Disable Art-Net input on the card briefly, then re-enable. Restart Madrix output. |
| Visible stutter / dropped frames | WiFi sleep re-enabled, or interference | Re-check Config > WiFi > Disable WiFi sleep. Move the card off congested 2.4 GHz channels. |
| Strip section dark | Loose data line, dead pixel, or PSU droop | Inspect physical connection. Check segment config didn't truncate the strip. Measure 5V/12V at the far end of the run. |

### Pi-hosted lane _(Deferred — future Pi integration)_

| Symptom | Likely cause | Recovery |
|---|---|---|
| Visitor UI loads but lights don't change | WLED unreachable from Pi | SSH the Pi: `curl http://<wled-ip>/json`. If timeout, check WLED is on the AP and STA link is up. Power-cycle WLED if STA dropped. |
| Pi reboot after power blip | Power glitch, SD card issue | systemd brings visitor-ui back up automatically. If not, SSH and `systemctl status visitor-ui`. Check SD card health if recurring. |
