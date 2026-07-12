# TODO: Lightweaver (folder `led/`)

Living list of outstanding work on the LED installation controller. Project is branded **Lightweaver** in user-facing copy, `led/` is just the folder slug. See `CLAUDE.md` for stack and intent.

## Soon

### Layout screen redesign (planned 2026-07-10)

- [ ] **Try the redesigned Layout screen on a real project** — all three phases of the redesign are code-complete (Draw | Size | Wire modes, Send to card, export for other LED software); what's left is your hands-on pass: import a real artwork file, walk Draw → Size → Wire, push to a bench card, and note anything that feels wrong _(you · moderate)_
  Everything is committed on the `simplify-ui-design-flow` branch with 36 automated checks green. A real card appeared on the network during the build and the tests were hardened against that. Consider a Codex remote review of the branch before merging. → Plan: [docs/layout-redesign-plan.md](docs/layout-redesign-plan.md)

### Mandala listening-gallery visualizer (in progress — laptop simulator)

Building the sound-reactive effect set for the backlit laser-cut mandala (675 LEDs, 5 concentric rings) as a laptop simulator first, then port the winning effects to the ESP32 card. Aesthetic: high-end listening gallery, NOT festival — warm ember/bronze/candlelight only, slow motion, but the music must OBVIOUSLY move it. Fable used sparingly for taste-only calls (effect recipe, audio→visual mapping, color palettes); Opus for everything else.

- [ ] **Keep tuning the nine mandala effect modes for legibility** — play through all nine with music and dial each until the music is unmistakably driving it, with real dark-to-bright contrast and localized (partial-ring) lighting _(you + agent · deep)_
  Current state: simulator at [led-art-mapper/mandala-sim/index.html](led-art-mapper/mandala-sim/index.html) (serve it, open localhost, press Play demo). Nine modes in two tiers — slow: Meridian, Hearth, Embers, Strata, Tide; livelier: Lattice, Procession, Bloom, Spiral. Just did a legibility pass (live response ~1s not slow averages, dark floors, arc-gated partial rings). Measured quiet→loud swing 3–8× on most; Meridian/Embers subtlest by design. Still needs: per-mode feel tuning with real listening, decide which modes make the final cut, then port winners to firmware. Direction + specs in `docs/mandala-*.md`. → Direction: [docs/mandala-effects-direction-v2.md](docs/mandala-effects-direction-v2.md), diagnosis: [docs/mandala-effects-diagnosis.md](docs/mandala-effects-diagnosis.md), color: [docs/mandala-color-system.md](docs/mandala-color-system.md), mapping: [docs/mandala-audio-mapping.md](docs/mandala-audio-mapping.md)
- [ ] **Port the chosen mandala effects to ESP32 firmware** — once the effect set is locked in the simulator, translate the winning modes to FastLED C++ on the card with an onboard mic for standalone audio _(agent · deep)_
  Blocked on the tuning item above. The simulator math was written cheap-enough-for-the-chip on purpose (per-pixel arithmetic + a few smoothed scalars, one ~50-element ember array). Needs: precompute ring/radius/angle tables at boot, an onboard I2S mic + simple 3-band split feeding the same bass/mid/high/energy/centroid signals, and the auto-leveler. Standalone is the goal — no laptop, no Pi in the runtime path. → Specs: `docs/mandala-*.md`

### Bench verification of the 2026-06-11 firmware batch (needs a card in hand)

- [ ] **Bench-test WiFi recovery firmware** — flash the rebuilt factory binary to a bench card and verify the new WiFi recovery chain end-to-end _(you · moderate)_
  The 2026-06-11 batch (WiFi auto-rejoin, Change-WiFi/factory-reset buttons, scan polling, CORS allowlist, multi-range zones) was written and reviewed without hardware. Done when: wrong-password setup shows the "WiFi isn't connecting" banner and Re-enter WiFi works; power-cycling the router while the card runs makes the card rejoin within ~2 minutes on its own; the captive portal stays usable during retry attempts (watch for AP hiccups from STA channel switching); Studio push and mapper live push still work from localhost and led.mandalacodes.com. → Changes: `firmware/lightweaver-controller/src/`, review at [docs/project-review-2026-06-11.md](docs/project-review-2026-06-11.md)
- [ ] **Redeploy the mandalacodes production bundle** — rebuild and deploy the landing+/design bundle so production picks up the new Studio dist and firmware binary _(you · quick)_
  Deploy ownership was settled 2026-06-11: this repo deploys only to the `studio` Pages preview branch; production at led.mandalacodes.com ships from the mandalacodes repo. Done when led.mandalacodes.com/design and /firmware/…factory.bin serve the new builds. → Plan: [docs/led-mandalacodes-setup.md](docs/led-mandalacodes-setup.md)

### Security hardening (2026-06-16 audit)

The 2026-06-16 audit fixes (firmware C1/H1/H2/M1/M4, Studio C2/H3/M3/M5/M6, Pi/mapper H4/M2) landed on `claude/sharp-allen-7atzz2` and pass all gates. These are the remaining owner-decision and verification items. → Full report: [docs/security-audit-2026-06-16.md](docs/security-audit-2026-06-16.md)

- [ ] **Bench-verify the security fixes on hardware** — confirm C1 (no WiFi password in `/api/firmware-info`), H1 (`maxMilliamps` clamp), H2 (exact-origin CORS), and M1 (WS Origin check) on a real card _(you · moderate)_
  These firmware changes were written and reviewed without hardware. Done when `/api/firmware-info` shows `wifi.configured` and no password, a full-white pattern can't exceed the clamped current draw, and Studio/mapper push still work from localhost and led.mandalacodes.com while a foreign Origin is rejected. → Findings: [docs/security-audit-2026-06-16.md](docs/security-audit-2026-06-16.md)
- [ ] **Decide AI-endpoint auth posture** — choose whether `AI_PATTERN_AUTH_TOKEN` should be required by default if the Pi/AI server is ever exposed beyond localhost _(you · quick)_
  The audit kept the endpoint default-open to preserve the documented local single-user flow (only the memory leak + an exposure warning were fixed). Done when the token policy is decided and, if required, set in the deploy environment. → Findings: [docs/security-audit-2026-06-16.md](docs/security-audit-2026-06-16.md)
- [ ] **Tighten the postMessage bridge preview-subdomain trust** — drop or pin the `*.lightweaver-edw.pages.dev` wildcard in the firmware `lwBridgeAllowed` check _(agent · quick)_
  This is a separate trust surface from the H2 HTTP-CORS fix and was left untouched to stay surgical; any pushed Pages preview currently matches. Done when the bridge allowlist trusts only exact, known origins. → Findings: [docs/security-audit-2026-06-16.md](docs/security-audit-2026-06-16.md)
- [ ] **Sandbox pattern execution properly** — move `new Function()` pattern eval into a Web Worker / wasm interpreter for true isolation _(agent · deep)_
  The audit's shadowing + denylist + CSP hardening (C2) blocks the realistic exfil vectors but is not a real sandbox; a Worker would require reworking the synchronous per-pixel preview contract. Done when pattern code runs with no DOM/`fetch`/`window` reach and the preview still renders. → Findings: [docs/security-audit-2026-06-16.md](docs/security-audit-2026-06-16.md)

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

- [ ] **Rescue the split-zone lighting fix from the old tender-dirac branch** — a zone split into pieces currently goes dark on its later pieces; the fix exists on the stale `claude/tender-dirac-b575t8` branch but that whole branch can't be merged (it predates the v3.3 reorg and collides in ~10 places, including the firmware and the compiled firmware file, so a blind merge would revert newer work) _(you + agent · moderate)_
  Lift only the multi-range zone rendering change onto a fresh branch off current main, build it, then bench-test on real hardware before flashing any installation. Done when split zones light every segment, the build passes, a bench-test confirms it, and the firmware bundle is redeployed. Do NOT merge the old branch wholesale — salvage the one feature. → Source branch: `claude/tender-dirac-b575t8` (firmware/lightweaver-controller/src/main.cpp + LightweaverWeb.cpp)
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

### Remaining review findings (deferred from the 2026-06-11 fix pass)

- [ ] **Non-blocking fades** — convert the firmware's blocking fadeTo into a loop() state machine so pattern taps stay responsive during transitions _(agent · moderate)_
  fadeTo spins up to ~2s without servicing the web server or captive DNS, so taps feel laggy exactly when the customer is interacting. Done when fades render incrementally from loop() and the page stays responsive during a transition. → Findings: [docs/project-review-2026-06-11.md](docs/project-review-2026-06-11.md)
- [ ] **OTA firmware updates** — add an OTA path so shipped cards can be updated without USB reflash _(agent · deep)_
  Today a fielded card can only be fixed by mailing it back or a house call; the recovery/WDT machinery assumes firmware can be fixed in the field. Done when a card can safely self-update from a signed/validated image with rollback on failure. → Findings: [docs/project-review-2026-06-11.md](docs/project-review-2026-06-11.md)
- [ ] **Touch support for both editors** — convert Studio Layout/Timeline drags and the mapper canvas to Pointer Events with coarse-pointer-visible controls _(agent · deep)_
  The stated target is "web interface accessible from phone" but the editing surfaces are mouse-only today. Done when strip drawing, clip dragging, and hover-only buttons work on a tablet. → Findings: [docs/project-review-2026-06-11.md](docs/project-review-2026-06-11.md)
- [ ] **Studio connection-story convergence** — collapse WledBar/DevicesPanel/ChipScreen/StatusBar into one protocol-aware card widget _(agent · moderate)_
  DevicesPanel still uses the broken legacy http push/scan path with guessed diagnoses; ChipScreen does it right. Done when there is one card-connection surface that leads with the bridge on HTTPS. → Findings: [docs/project-review-2026-06-11.md](docs/project-review-2026-06-11.md)
- [ ] **Mapper SVG fidelity** — handle transform attributes, relative compound paths, and viewBox offsets on import _(agent · moderate)_
  Illustrator/Inkscape exports with transforms land offset/scaled and mm-based LED counts come out wrong. Done when transformed and relative-path SVGs measure and render correctly. → Findings: [docs/project-review-2026-06-11.md](docs/project-review-2026-06-11.md)

### Deeper WLED protocol compatibility (deferred by design)

- [ ] **Deeper WLED compat** — add the deferred WLED protocol features if a real user needs them (DNRGB or E1.31 realtime, preset bank, per-segment params and palettes) _(agent · deep)_
  These broaden the firmware's WLED-compatibility surface so more third-party tools and realtime streams just work, but only earn their cost on real demand. Done when the firmware supports DNRGB/E1.31 realtime, a preset bank, and per-segment params and palettes. → Plan: [firmware/lightweaver-controller/FUTURE_WLED_COMPAT.md](firmware/lightweaver-controller/FUTURE_WLED_COMPAT.md)

## Operational notes (not TODOs: context for future-you)

- Lightweaver is hosted on Cloudflare Pages project `lightweaver` (NOT `mandalacodes`, NOT `adrian-website`). Custom domain `led.mandalacodes.com` is attached. Fallback URL: `lightweaver-edw.pages.dev`.

- ESP32-S3 firmware + WLED for the hardware side. Reliable write path is the ESP32 AP page at `http://192.168.4.1`, public HTTPS-to-private HTTP may be blocked by browsers.
