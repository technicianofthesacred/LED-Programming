# TODO: Lightweaver (folder `led/`)

Living list of outstanding work on the LED installation controller. Project is branded **Lightweaver** in user-facing copy, `led/` is just the folder slug. See `CLAUDE.md` for stack and intent.

## Soon

### Hardware and install setup (Adrian, at the artwork)

- [ ] **WLED hardware config** — set the final LED count, data pin, LED type, color order, and brightness limit for the real artwork _(you · moderate)_
  These are the physical truths the firmware needs to drive the strip correctly and safely. Done when WLED is configured for the real artwork's pixel layout and the brightness cap is set. → Plan: [docs/roadmap.md](docs/roadmap.md)
- [ ] **Controller identity** — rename the controller and reserve its install IP, then back up the existing presets before installing Lightweaver presets _(you · quick)_
  A stable hostname and reserved IP keep the card reachable on the gallery LAN, and the backup protects against losing presets during install. Done when the controller is renamed, has a reserved IP, and the old presets are backed up. → Plan: [docs/roadmap.md](docs/roadmap.md)
- [ ] **Madrix Art-Net** — configure and test Madrix Art-Net output into WLED, then define the WLED segments matching the laser-cut zones _(you · moderate)_
  This wires the design software to the controller and maps light output onto the physical zones of the piece. Done when WLED receives Madrix Art-Net and segments match the laser-cut zones. → Plan: [docs/roadmap.md](docs/roadmap.md)

## Future

- [ ] **Live Host runtime** — build the runtime for laptop, Pi, Madrix, and sound-reactive streaming _(agent · deep)_
  This is the live-performance control path that drives the card from a host machine, including audio-reactive output for installations. Done when the runtime streams live and sound-reactive frames across the laptop, Pi, and Madrix modes. → Plan: [docs/superpowers/plans/2026-05-28-lightweaver-esp32-three-mode-runtime.md](docs/superpowers/plans/2026-05-28-lightweaver-esp32-three-mode-runtime.md)

### Pi-hosted visitor UI _(deferred — not in the current ESP-only plan; the firmware card page is today's visitor UI)_

- [ ] **Pi setup** — set the hostname, autostart the visitor-ui server, configure the AP-mode SSID, and run a phone captive-portal end-to-end test _(you · moderate)_
  This stands up the future Pi as a self-contained visitor access point so a phone can join and reach the scene selector. Done when a phone joins the Lightweaver SSID and reaches the visitor UI through the captive portal. → Plan: [docs/roadmap.md](docs/roadmap.md)
- [ ] **Visitor-ui branding** — customize the brand constant and match the scenes list to the real saved WLED presets _(agent · quick)_
  The captive-portal selector should show Lightweaver branding and offer the actual scenes saved on the controller. Done when the visitor-ui uses the Lightweaver brand and its scene list matches the saved WLED presets. → Plan: [docs/roadmap.md](docs/roadmap.md)

### Mapper and firmware follow-ups

- [ ] **USB controller mode** — add a direct USB mode using the verified bench serial protocol as the first hardware handshake _(agent · moderate)_
  A wired serial path lets the mapper drive the card directly without the network, proving the protocol before wireless. Done when the mapper can drive the controller over USB serial using the bench protocol. → Plan: [docs/roadmap.md](docs/roadmap.md)
- [ ] **Split mapper file** — break the 4,713-line mapper main file into state, ui, render, and export modules _(agent · deep)_
  The single oversized file is hard to maintain and extend; splitting it by concern makes the design tool workable. Done when the mapper main file is split into separate state, ui, render, and export modules with no behavior change. → Plan: [docs/roadmap.md](docs/roadmap.md)
- [ ] **Branded effects** — build the first custom WLED effects (Candle Drift, Ember Slow, Warm Pulse, Amber Aurora, Gallery Idle) _(agent · moderate)_
  Bespoke warm effects give the installation its own visual identity beyond the stock WLED library. Done when the five named effects run on the controller. → Plan: [docs/roadmap.md](docs/roadmap.md)
- [ ] **Offline export** — build standalone-controller export (lightweaver.json and microSD sequence packages) for offline ESP32 playback _(agent · deep)_
  This lets the card play scenes from local storage with no host or network present, the key to a self-running gallery install. Done when the mapper exports lightweaver.json and microSD sequence packages the ESP32 can play offline. → Plan: [docs/roadmap.md](docs/roadmap.md)
- [ ] **Mapper unit tests** — add a Vitest unit suite for the mapper pattern helpers and export functions _(agent · moderate)_
  Tests lock down the pattern math and export formats so refactors and new features don't silently break output. Done when a Vitest suite covers the mapper pattern helpers and export functions and passes. → Plan: [docs/roadmap.md](docs/roadmap.md)

### Mapper design tool feature roadmap

- [ ] **Per-section controls** — add quick per-section controls (brightness, hue shift, direction reversal) and master brightness _(agent · moderate)_
  Fast per-zone tweaks let Adrian shape a look without editing patterns, which is the core day-to-day mapper interaction. Done when each section has brightness, hue-shift, and direction controls plus a working master brightness. → Plan: [led-art-mapper/ROADMAP.md](led-art-mapper/ROADMAP.md)
- [ ] **Palettes and tempo** — add the color palette system, BPM tap tempo with beat variables, scene presets, and per-pattern parameter sliders _(agent · deep)_
  These give patterns shared color and rhythm so scenes can move in time and be saved for reuse. Done when palettes, BPM-tapped beat variables, scene presets, and per-pattern sliders all work in the mapper. → Plan: [led-art-mapper/ROADMAP.md](led-art-mapper/ROADMAP.md)
- [ ] **Show tooling** — build scene crossfades, the timeline sequencer, and the spatial effect bus _(agent · deep)_
  This is the sequencing layer that turns individual scenes into a timed, blended show across the installation. Done when scenes crossfade, the timeline sequencer plays an ordered show, and the spatial effect bus is functional. → Plan: [led-art-mapper/ROADMAP.md](led-art-mapper/ROADMAP.md)

### Deeper WLED protocol compatibility (deferred by design)

- [ ] **Deeper WLED compat** — add the deferred WLED protocol features if a real user needs them (DNRGB or E1.31 realtime, preset bank, per-segment params and palettes) _(agent · deep)_
  These broaden the firmware's WLED-compatibility surface so more third-party tools and realtime streams just work, but only earn their cost on real demand. Done when the firmware supports DNRGB/E1.31 realtime, a preset bank, and per-segment params and palettes. → Plan: [firmware/lightweaver-controller/FUTURE_WLED_COMPAT.md](firmware/lightweaver-controller/FUTURE_WLED_COMPAT.md)

## Operational notes (not TODOs: context for future-you)

- Lightweaver is hosted on Cloudflare Pages project `lightweaver` (NOT `mandalacodes`, NOT `adrian-website`). Custom domain `led.mandalacodes.com` is attached. Fallback URL: `lightweaver-edw.pages.dev`.

- ESP32-S3 firmware + WLED for the hardware side. Reliable write path is the ESP32 AP page at `http://192.168.4.1`, public HTTPS-to-private HTTP may be blocked by browsers.
