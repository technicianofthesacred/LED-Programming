# TODO: Lightweaver (folder `led/`)

Living list of outstanding work on the LED installation controller. Project is branded **Lightweaver** in user-facing copy, `led/` is just the folder slug. See `CLAUDE.md` for stack and intent.

## Soon

### Hardware and install setup (Adrian, at the artwork)

- [ ] Set the final WLED LED count, data pin, LED type, color order, and brightness limit for the real artwork _(band: you-required)_ _(effort: moderate)_ → Plan: [docs/roadmap.md](docs/roadmap.md)
- [ ] Rename the controller and reserve its install IP, then back up the existing presets before installing Lightweaver presets _(band: you-required)_ _(effort: quick)_ → Plan: [docs/roadmap.md](docs/roadmap.md)
- [ ] Configure and test Madrix Art-Net output into WLED, then define the WLED segments matching the laser-cut zones _(band: you-required)_ _(effort: moderate)_ → Plan: [docs/roadmap.md](docs/roadmap.md)

### Pi-hosted visitor UI

- [ ] Set up the Pi: hostname, autostart the visitor-ui server, AP-mode SSID, and a phone captive-portal end-to-end test _(band: you-required)_ _(effort: moderate)_ → Plan: [docs/roadmap.md](docs/roadmap.md)
- [ ] Customize the visitor-ui brand constant and match the scenes list to the real saved WLED presets _(band: agent-runnable)_ _(effort: quick)_ → Plan: [docs/roadmap.md](docs/roadmap.md)

## Future

- [ ] Build the Live Host runtime for laptop, Pi, Madrix, and sound-reactive streaming _(band: agent-runnable)_ _(effort: deep)_ → Plan: [docs/superpowers/plans/2026-05-28-lightweaver-esp32-three-mode-runtime.md](docs/superpowers/plans/2026-05-28-lightweaver-esp32-three-mode-runtime.md)

### Mapper and firmware follow-ups

- [ ] Add a direct USB controller mode using the verified bench serial protocol as the first hardware handshake _(band: agent-runnable)_ _(effort: moderate)_ → Plan: [docs/roadmap.md](docs/roadmap.md)
- [ ] Split the 4,713-line mapper main file into state, ui, render, and export modules _(band: agent-runnable)_ _(effort: deep)_ → Plan: [docs/roadmap.md](docs/roadmap.md)
- [ ] Build the first branded custom WLED effects (Candle Drift, Ember Slow, Warm Pulse, Amber Aurora, Gallery Idle) _(band: agent-runnable)_ _(effort: moderate)_ → Plan: [docs/roadmap.md](docs/roadmap.md)
- [ ] Build standalone-controller export (lightweaver.json and microSD sequence packages) for offline ESP32 playback _(band: agent-runnable)_ _(effort: deep)_ → Plan: [docs/roadmap.md](docs/roadmap.md)
- [ ] Add a Vitest unit suite for the mapper pattern helpers and export functions _(band: agent-runnable)_ _(effort: moderate)_ → Plan: [docs/roadmap.md](docs/roadmap.md)

### Mapper design tool feature roadmap

- [ ] Add the quick per-section controls (brightness, hue shift, direction reversal) and master brightness _(band: agent-runnable)_ _(effort: moderate)_ → Plan: [led-art-mapper/ROADMAP.md](led-art-mapper/ROADMAP.md)
- [ ] Add the color palette system, BPM tap tempo with beat variables, scene presets, and per-pattern parameter sliders _(band: agent-runnable)_ _(effort: deep)_ → Plan: [led-art-mapper/ROADMAP.md](led-art-mapper/ROADMAP.md)
- [ ] Build the complex show tooling: scene crossfades, the timeline sequencer, and the spatial effect bus _(band: agent-runnable)_ _(effort: deep)_ → Plan: [led-art-mapper/ROADMAP.md](led-art-mapper/ROADMAP.md)

### Deeper WLED protocol compatibility (deferred by design)

- [ ] Add the deferred WLED protocol features if a real user needs them (DNRGB or E1.31 realtime, preset bank, per-segment params and palettes) _(band: agent-runnable)_ _(effort: deep)_ → Plan: [firmware/lightweaver-controller/FUTURE_WLED_COMPAT.md](firmware/lightweaver-controller/FUTURE_WLED_COMPAT.md)

## Operational notes (not TODOs: context for future-you)

- Lightweaver is hosted on Cloudflare Pages project `lightweaver` (NOT `mandalacodes`, NOT `adrian-website`). Custom domain `led.mandalacodes.com` is attached. Fallback URL: `lightweaver-edw.pages.dev`.

- ESP32-S3 firmware + WLED for the hardware side. Reliable write path is the ESP32 AP page at `http://192.168.4.1`, public HTTPS-to-private HTTP may be blocked by browsers.
