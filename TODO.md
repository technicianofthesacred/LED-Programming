# TODO: Lightweaver (folder `led/`)

Living list of outstanding work on the LED installation controller. Project is branded **Lightweaver** in user-facing copy, `led/` is just the folder slug. See `CLAUDE.md` for stack and intent.

## Top priority — make the card boringly reliable

- [ ] **Execute the staged [Reliable Chip Closure plan](docs/superpowers/plans/2026-08-08-reliable-chip-closure.md).** _(firmware agent + Studio agent + CI/docs agent + Adrian)_ Phase 1 fixes proven-network retry when the router starts late, adds the firmware-owned reboot fallback after an interrupted config save, gates Art-Net consistently, publishes the exact signed release, and passes the real-card power-cycle/outage matrix. Phase 2 immediately adds universal two-envelope authority and a truthful LAN/router-address recovery action. The obsolete `2462ca4` branch is reference evidence only; implement selectively from current `main`. Done only when the exact merged Studio and signed firmware build numbers match the live release and the recorded hardware pass.

## Active release path

The card-provisioning software branch closed on 2026-07-25; its exact shipped
state and unverified hardware gates are recorded in
[docs/card-provisioning-closeout-2026-07-25.md](docs/card-provisioning-closeout-2026-07-25.md).
Resume the physical acceptance from
[docs/card-provisioning-remaining.md](docs/card-provisioning-remaining.md).

The immediate goal is to prove and ship the product already on `main`, not to
run every historical plan. The ordered source of truth is the
[release-first roadmap](docs/roadmap.md#current-execution-order-protect-the-working-product).

1. Finish and integrate the concurrent LED UX work.
2. Close the confirmed release defects and simplify the ordinary project
   journey without changing the underlying hardware architecture.
3. Run the complete automated and real-card workflow on that exact `main`.
4. Fix only release blockers, publish the protected signed firmware, and deploy.
5. Use a second real LED project to decide which reusable module is actually
   needed next.

The three 2026-07-17 Hardware plans are superseded. The 2026-07-18 reusable-card
plan is a reference library, not one large job to execute.

## Soon

### Branch consolidation audit — 2026-08-11

All 25 `codex/*` branches were audited commit-by-commit against `main`. **Twenty-two
carry nothing main does not already have**; the three exceptions are recorded below.
Every branch tip is preserved as `archive/codex/<name>` on the remote, so the whole
`codex/*` namespace can be deleted without losing a commit.

- [ ] **Delete the 25 stale `codex/*` remote branches.** _(you-required · routine)_ Verified redundant: 20 are strict ancestors of `main`; `commissioning-full-loop` landed as `ec3a1752` (#112/#113) and `fix-wifi-schema-compat` as `b459873c` (#111), both byte-identical. The agent session that audited them could not delete refs (the sandbox denies ref deletion with HTTP 403), so this needs one `git push origin --delete …` from a normal checkout. `archive/codex/*` branches can go too, except the two named below.
- [x] **`codex/software-update-grant-main` — the recovery half is now on `main`.** Its `ba483e3a` and main's `d3ae6f7d` were two independent fixes to the same bug written one minute apart. Main's `runtimeKnownGood` gate is the safer design and is kept, but it rejected a class of genuinely successful updates forever; fixed 2026-08-11 (see the firmware-update entry below). Its artifact commits are superseded — merging that branch now would roll the signed release back from 1.1.15/1306 to 1.1.12/1280.
- [ ] **Port the still-useful parts of `2462ca4` (`codex/connection-reliability-audit`).** _(agent-runnable)_ Confirmed still missing from `main`, in recommended order. Do **not** merge or cherry-pick the branch — it is 270 commits stale and its patch deletes recovery affordances main has since built. Reference tip: `archive/codex/connection-reliability-audit`.
  - **`colorOrder` is admitted through the playback gate.** `LightweaverWeb.cpp:1973-1978` validates and applies a strip-wide color-order rewrite under `handleControlPost`'s deliberately-widened `provisioningControlAdmitted(runtimePlaybackReady())` gate (`:1928`). A persistent global output mutation rides the gate that was widened so radio transitions would not block *playback*. Five lines: require `runtimeCommandReady()` for the `colorOrder` branch. Highest value-per-risk item on the branch.
  - **Firmware enforces no readiness admission on config/wiring/Wi-Fi mutations.** `handleConfigPost:1276`, `handleWiringCandidate:1360`, `handleWiringActivate:1400`, `handleWiringDiscover:1441`, `handleWifiPost:1485` have no gate; the only `423` responses in the file are the two playback routes. Studio's bridge refuses these client-side (`cardBridge.js:2156-2172`), but direct transport, the card's own advanced page, and any LAN client are unguarded — while this plan lists "configuration, Wi-Fi, and wiring mutations stay fail-closed" as non-negotiable. ~60 lines; substitute `runtimeCommandReady()` for the branch's `runtimeMutationReady()`, which main does not have under that name.
  - **`revalidating` has no bounded deadline.** `cardLink.js:942` clears the connect timer for handoff *and* ordinary validation alike. A card that keeps answering pings but never yields a confirming envelope — e.g. an unsupported `provisioningContractVersion` — leaves "Checking card" on screen permanently with no watchdog anywhere. Ping failure is the only escape. ~15 lines plus a test.
  - **`canPushDirectlyToCard` trusts any `http:` page and `file:`** (`cardConnection.js:406-409`). Low real-world risk (false on production HTTPS), but the wrong answer picks a direct transport that then fails CORS instead of falling back to the bridge that would have worked. Update `tests/card-connection-mode.mjs:55` with it.
  - **`/api/status` never publishes `wifi.proven` or a `wifi.nextAction`.** Main tracks the proven bit correctly (`LightweaverStorage.cpp:1495`) but never reports it, so support cannot distinguish "credentials saved but never reached the network" from "commissioned and healthy" without a serial console. Two lines, no behavior change.
- [ ] **Narrow follow-up: `provisionalSetup` in the firmware-update recovery gate.** _(agent-runnable · quick)_ The firmware's own pre-update check (`LightweaverFirmwareUpdate.cpp:658`) lets a provisional-setup card start an update, but `correlateFirmwareUpdateRecovery` still refuses to call it recovered afterwards while `provisionalSetup === true` and a project head was preserved. Left in deliberately on 2026-08-11 rather than loosen a safety gate without hardware evidence; decide with a real bench card.

**Verified already-complete on `main` (plan Phase 1), so the plan doc's unchecked boxes are stale:** Art-Net now shares playback admission (`LightweaverArtnet.cpp:106`), config saves self-reboot after an interrupted save (`runtimeArmConfigRestartFallback`, `main.cpp:2578`), and proven-Wi-Fi boot resume plus late-router retry landed via `CredentialsResumed` + the `!handoffRequired` re-arm (`LightweaverConnectivityPolicy.h:211`) — main's design is strictly stronger than the branch's `beginStationResume`, adding stale-ack immunity and setup-AP channel co-persistence. Plan Tasks 5 and 6 remain genuinely unbuilt.

- [ ] Make connection, setup, updates, and card saves one software-first flow _(band: agent-runnable)_ _(effort: deep)_ → Plan: [software-first-card-flow.md](todo/plans/software-first-card-flow.md)
- [ ] **Sweep the remaining card-status fixtures that omit `projectId`.** _(agent-runnable · routine)_ The fix in `pattern-link-timing-fix` corrected the two fixtures that were driving the handoff loop, but the omission is systemic: `tests/card-link-state.mjs:30` (~39 call sites, in `test:core`), `src/lib/cardReadiness.test.js:11` (~31, `test:unit`), `tests/playlist-storage.spec.ts:69`, `tests/connection-center-quality.spec.ts:26`, `tests/screen-smoke.spec.ts:117` and others all default a "ready" card to one that reports no installed project — which no real card does. Harmless today because those suites never exercise pattern authorization, but each one is a trap for the next person who adds a test there.
- [x] **The card→Patterns handoff loops forever against any card whose `/api/status` omits `projectId`.** _(agent-runnable · release blocker)_ Diagnosed 2026-08-07, separate from the routing race fixed in `ac52341`. Patterns builds its authorization binding from the card-link readiness envelope (`installedProjectId: readiness.projectId || readiness.piece?.id`, `lw-pattern.jsx:433`) while the card screen issues it from `/api/firmware-info` (which carries `piece.id`). The firmware only started sending `projectId` on `/api/status` in `f1ad74e` (2026-08-04) and never sends `piece.id` there, so **every card flashed before that build makes `consumeCardEditAuthorization` fail permanently**. Patterns then bounces to `#screen=card&section=overview`, CardScreen remounts, its `cardProjectProbeRef` de-dupe guard (a component-scoped `useRef`, `lw-card.jsx:738`) resets to `''`, and the resolve restarts immediately — measured at ~45 resolutions/second, ~130 requests/second at the card, with the owner stuck on a disabled "Verifying project…". Fixed 2026-08-07: `installedProjectIdFromCardStatus` in `src/lib/cardReadiness.js` is now the single source both ends bind from, a card that cannot report its installed project is refused with an explanation instead of retried, and a claim Patterns loses is remembered at module scope (`src/lib/cardEditIntent.js`) so the card offers the project rather than handing it over again — while the intent stays in the URL so an explicit Load still honours it. Covered by `tests/card-edit-handoff.spec.ts`.
- [ ] **Provision and prove the private cloud project library.** _(you-required)_ Source/local gates can be integrated without remote access, but release is blocked until separate preview/production D1 and private R2 resources, exact-email Access at `/api/library*`, owner configuration, and the separate Pages-only and D1-only CI credentials are provisioned. Run preview migration/deploy and authenticated, unauthenticated, worker-delete, backup/restore proof before setting `LIGHTWEAVER_PRODUCTION_LIBRARY_READY=confirmed`; then migrate production before deploying the exact compatible commit. No card command or local URL may pass through the library API. → Runbook: [docs/led-mandalacodes-setup.md#private-cloud-project-library](docs/led-mandalacodes-setup.md#private-cloud-project-library), gate: [docs/deployment-checklist.md#private-project-library-release-evidence](docs/deployment-checklist.md#private-project-library-release-evidence)
- [ ] **Card OTA decision.** _(you-required)_ Decide whether cards should self-update from the signed release feed (infrastructure exists: signed manifest + verification) or stay USB-flash-only; USB-only is the deliberate current model — see THINKING.md 2026-07-26 for the tradeoff before building anything.
- [x] **Studio and firmware build stamps.** _(agent-runnable)_ Both surfaces show the repository commit count — the same number GitHub prints as "N Commits" — instead of a commit SHA. The Studio footer reads `Studio current · Build 1066`, and a card reports `buildNumber` on `/api/firmware-info` so its panel reads `1.0.0 · Build 1066`. Published in `/studio-release.json` and the signed firmware manifest, and printed in the deploy workflow summary.
- [ ] **Require `buildNumber` in the firmware manifest.** _(agent-runnable)_ `validateFirmwareManifest` currently tolerates a missing `buildNumber` so the one already-signed release that predates numbered builds keeps verifying; once the signer has published a numbered release, move it from `OPTIONAL_MANIFEST_KEYS` into `MANIFEST_KEYS` and add it to the JSON schema's `required` list.

### Pattern Lab release acceptance (feature branch source complete)

- [x] Wire the existing immutable handoff contract to a visible **Use in Project** confirmation that adds a new look or sequence asset without overwriting built-ins or saved looks.
- [ ] Run the complete focused Pattern Lab, Studio, firmware, and launch checks from [the deployment checklist](docs/deployment-checklist.md#pattern-lab-release-acceptance) on the final integrated commit.
- [ ] On a real ESP32-S3 and mapped strip, verify a ten-minute evolution, native recipe parity, full baked microSD playback, Preview on Lights rollback, pixel order, color order, gamma, brightness, and power limiting.
- [ ] Verify the public Studio authoring flow on a phone and the local card command path while the phone and card share the installation LAN/AP; do not introduce a Pi or public-cloud command relay.
- [ ] Merge, rebuild/sign firmware, and deploy only after those gates pass; the current feature branch is not a released or physically accepted build.

Operator workflow and current limitations: [Pattern Lab operator guide](docs/pattern-lab-user-guide.md).

### Release coherence pass (before bench signoff and deployment)

Run these against the fully integrated `main`; they are Phase 1 release work,
not part of the conditional reusable-hardware plan.

- [ ] **Repair and test every firmware card-page pattern preview** — the 2026-07-18 audit confirmed **17 of 30** factory styles are missing from the customer page (not just Ripple and Lava Lamp); add them and cross-check both embedded pages against the factory id list _(firmware agent · quick)_
  Done when all 30 factory tiles render styled previews and a source test derives the id list from `LightweaverStorage.cpp` and fails if either page lacks a `.sw-<id>` rule. → Evidence: [docs/superpowers/plans/2026-07-18-release-coherence-findings.md](docs/superpowers/plans/2026-07-18-release-coherence-findings.md)
- [ ] **Fix advanced-page pattern selection; keep the sound paths** — the customer page and Studio contracts verified sound (report unreproduced there); the advanced page grid is optimistic with no rollback and no streaming lock _(firmware agent · moderate)_
  Done when the advanced grid rolls back on rejection/failure, locks with an explanation during streams, and source tests cover both; customer-page and Studio selection code unchanged. → Evidence: [docs/superpowers/plans/2026-07-18-release-coherence-findings.md](docs/superpowers/plans/2026-07-18-release-coherence-findings.md)
- [ ] **Make recovery diagnostic and saved-state safe** — persist a bounded `LW-UI-xxx` support code, route, and sanitized error name across the one automatic reload; quarantine forward-version/corrupt autosaves instead of overwriting them; fix the false-dirty-at-boot lifecycle _(Studio agent · moderate)_
  Done when the recovery screen shows code/route/error-name (never project data), a `{version:99}` autosave survives reload in quarantine, fresh boot is not "Unsaved changes", and fixtures cover malformed/stale/migrated/valid saved projects. → Evidence: [docs/superpowers/plans/2026-07-18-release-coherence-findings.md](docs/superpowers/plans/2026-07-18-release-coherence-findings.md)
- [ ] **Restore one owner for layout and output routing** — replace Card's disabled section-count and duplicate output controls with a read-only summary and **Edit in Layout** deep link _(Studio agent · moderate)_
  Done when Draw/Size/Wire remains the sole editor for generated, imported, and customized layouts, while Card clearly summarizes what will be installed. → Order: [docs/roadmap.md](docs/roadmap.md)
- [ ] **Consolidate project Save/Load** — put autosave/recovery status, browser library, import, and export in one project area; canonical export is `.lw.json`; Layout toolbar Save/Load become Export/Import with the same naming and lifecycle marking _(Studio agent · moderate)_
  Done when the top bar reads Save project / Export project / Import project, Preferences no longer downloads a competing `.lwproj.json`, autosave is labeled as the automatic recovery copy, and legacy `.lw.json`, `.lwproj.json`, plain JSON, and project v1/v2/v3 files still load. → Order: [docs/roadmap.md](docs/roadmap.md)
- [ ] **Converge the handoff to one auxiliary card tab** — route all card-page opens through the one named local-card window (several UI call sites use unnamed `_blank` today) and give the secure-installer escape a stable window target with its reason visible; the escape itself stays (Web Serial requires a top-level secure context) _(Studio agent · moderate)_
  Done when the normal connected-card journey needs Studio plus at most one auxiliary local-card tab, blocked popups show a visible reason, and all secure Bridge/install fallbacks remain tested. → Order: [docs/roadmap.md](docs/roadmap.md)
- [ ] **Move Workshop into separate Batch production mode** — remove it from normal Card navigation and the artwork setup steps while preserving the production implementation, signed-job checks, `#screen=production`, `#screen=card&section=workshop`, and job deep links; keep it discoverable via an Advanced & Support tile and a low-emphasis overview link _(Studio agent · moderate)_
  Done when the normal journey reads Connect → Layout → Looks → Playlist → Install/verify → Save/export, and manufacturing workers can still enter Batch production directly. → Order: [docs/roadmap.md](docs/roadmap.md)
- [ ] **Unify labels and fix reproduced journey blockers** — one verb "Save to card" for the acknowledged write, "Install or update" reserved for firmware, "Looks" not "mixes"; connect actions open the Connection Center instead of a silent probe; Patterns 390 px overflow and clipped Playlist status fixed; rail `aria-current`; stale settings-alias test repaired and the launch gate widened beyond 3/26 Playwright suites _(Studio agent · moderate)_
  Done when the label audit passes in specs, no route horizontally scrolls at 390 px, connect visibly opens the guided flow, and `launch:source` runs the suites covering the changed surfaces. → Evidence: [docs/superpowers/plans/2026-07-18-release-coherence-findings.md](docs/superpowers/plans/2026-07-18-release-coherence-findings.md)

### Layout wiring hardening (implemented 2026-07-13; physical signoff remains)

- [ ] **Bench-sign off the canonical wiring flow on the real artwork** — Draw and Size the piece, drag or Auto Wire its runs into the correct output lanes, confirm every output/first pixel/direction/jumper/reserved block with the guided chase, lock the wiring, install that exact revision, and compare the phone/print assembly map to the physical build _(you · moderate)_
  The Studio implementation, compiler, solver, acknowledged transport, rollback, and responsive UI are complete and automated. Hardware identity, color order, brightness/current limits, and actual jumper routing still require the card and artwork; mocks are not accepted as physical proof. → Gate: [docs/deployment-checklist.md](docs/deployment-checklist.md), design: [docs/superpowers/specs/2026-07-13-lightweaver-experience-hardening-design.md](docs/superpowers/specs/2026-07-13-lightweaver-experience-hardening-design.md)

### Mandala listening-gallery visualizer (in progress — laptop simulator)

Building the sound-reactive effect set for the backlit laser-cut mandala (675 LEDs, 5 concentric rings) as a laptop simulator first, then port the winning effects to the ESP32 card. Aesthetic: high-end listening gallery, NOT festival — warm ember/bronze/candlelight only, slow motion, but the music must OBVIOUSLY move it. Fable used sparingly for taste-only calls (effect recipe, audio→visual mapping, color palettes); Opus for everything else.

- [ ] **Keep tuning the nine mandala effect modes for legibility** — play through all nine with music and dial each until the music is unmistakably driving it, with real dark-to-bright contrast and localized (partial-ring) lighting _(you + agent · deep)_
  Current state: simulator at [led-art-mapper/mandala-sim/index.html](led-art-mapper/mandala-sim/index.html) (serve it, open localhost, press Play demo). Nine modes in two tiers — slow: Meridian, Hearth, Embers, Strata, Tide; livelier: Lattice, Procession, Bloom, Spiral. Just did a legibility pass (live response ~1s not slow averages, dark floors, arc-gated partial rings). Measured quiet→loud swing 3–8× on most; Meridian/Embers subtlest by design. Still needs: per-mode feel tuning with real listening, decide which modes make the final cut, then port winners to firmware. Direction + specs in `docs/mandala-*.md`. → Direction: [docs/mandala-effects-direction-v2.md](docs/mandala-effects-direction-v2.md), diagnosis: [docs/mandala-effects-diagnosis.md](docs/mandala-effects-diagnosis.md), color: [docs/mandala-color-system.md](docs/mandala-color-system.md), mapping: [docs/mandala-audio-mapping.md](docs/mandala-audio-mapping.md)
- [ ] **Port the chosen mandala effects to ESP32 firmware** — once the effect set is locked in the simulator, translate the winning modes to FastLED C++ on the card with an onboard mic for standalone audio _(agent · deep)_
  Blocked on the tuning item above. The simulator math was written cheap-enough-for-the-chip on purpose (per-pixel arithmetic + a few smoothed scalars, one ~50-element ember array). Needs: precompute ring/radius/angle tables at boot, an onboard I2S mic + simple 3-band split feeding the same bass/mid/high/energy/centroid signals, and the auto-leveler. Standalone is the goal — no laptop, no Pi in the runtime path. → Specs: `docs/mandala-*.md`

### Bench verification of the 2026-06-11 firmware batch (needs a card in hand)

- [ ] **Bench-test WiFi recovery firmware** — flash the rebuilt factory binary to a bench card and verify the new WiFi recovery chain end-to-end _(you · moderate)_
  The 2026-06-11 batch (WiFi auto-rejoin, Change-WiFi/factory-reset buttons, scan polling, CORS allowlist, multi-range zones) was written and reviewed without hardware. Done when: wrong-password setup shows the "WiFi isn't connecting" banner and Re-enter WiFi works; power-cycling the router while the card runs makes the card rejoin within ~2 minutes on its own; the captive portal stays usable during retry attempts (watch for AP hiccups from STA channel switching); Studio push and mapper live push still work from localhost and led.mandalacodes.com. → Changes: `firmware/lightweaver-controller/src/`, review at [docs/project-review-2026-06-11.md](docs/project-review-2026-06-11.md)

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

- [ ] **Client project sharing** — add private, revocable read-only links for previewing and downloading selected artwork projects; keep editing owner-only, and defer accounts, collaborators, and public discovery until Lightweaver is intentionally expanded beyond Adrian's single-user Studio _(agent · deep)_
  This is explicitly outside the current personal project-library scope. Done when a selected project can be shared without exposing the rest of the library, access can be revoked, and recipients cannot modify the source project.
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

### Remaining review findings (deferred from the 2026-06-11 fix pass)

- [ ] **Non-blocking fades** — convert the firmware's blocking fadeTo into a loop() state machine so pattern taps stay responsive during transitions _(agent · moderate)_
  fadeTo spins up to ~2s without servicing the web server or captive DNS, so taps feel laggy exactly when the customer is interacting. Done when fades render incrementally from loop() and the page stays responsive during a transition. → Findings: [docs/project-review-2026-06-11.md](docs/project-review-2026-06-11.md)
- [ ] **OTA firmware updates** — add an OTA path so shipped cards can be updated without USB reflash _(agent · deep)_
  Today a fielded card can only be fixed by mailing it back or a house call; the recovery/WDT machinery assumes firmware can be fixed in the field. Done when a card can safely self-update from a signed/validated image with rollback on failure. → Findings: [docs/project-review-2026-06-11.md](docs/project-review-2026-06-11.md)
- [ ] **Finish touch support outside the Wire workspace** — extend the Wire screen's pointer-event/coarse-target approach to Studio Draw/Timeline and the mapper canvas _(agent · deep)_
  Wire lane and cable dragging now work with Pointer Events and retain accessible move controls; Draw, Timeline, and the separate mapper still need equivalent tablet behavior. Done when strip drawing, clip dragging, and remaining hover-only controls work on a tablet. → Findings: [docs/project-review-2026-06-11.md](docs/project-review-2026-06-11.md)
- [ ] **Studio connection-story convergence** — collapse WledBar/DevicesPanel/ChipScreen/StatusBar into one protocol-aware card widget _(agent · moderate)_
  DevicesPanel still uses the broken legacy http push/scan path with guessed diagnoses; ChipScreen does it right. Done when there is one card-connection surface that leads with the bridge on HTTPS. → Findings: [docs/project-review-2026-06-11.md](docs/project-review-2026-06-11.md)
- [ ] **Mapper SVG fidelity** — handle transform attributes, relative compound paths, and viewBox offsets on import _(agent · moderate)_
  Illustrator/Inkscape exports with transforms land offset/scaled and mm-based LED counts come out wrong. Done when transformed and relative-path SVGs measure and render correctly. → Findings: [docs/project-review-2026-06-11.md](docs/project-review-2026-06-11.md)

### Deeper WLED protocol compatibility (deferred by design)

- [ ] **Deeper WLED compat** — add the deferred WLED protocol features if a real user needs them (DNRGB or E1.31 realtime, preset bank, per-segment params and palettes) _(agent · deep)_
  These broaden the firmware's WLED-compatibility surface so more third-party tools and realtime streams just work, but only earn their cost on real demand. Done when the firmware supports DNRGB/E1.31 realtime, a preset bank, and per-segment params and palettes. → Plan: [firmware/lightweaver-controller/FUTURE_WLED_COMPAT.md](firmware/lightweaver-controller/FUTURE_WLED_COMPAT.md)

## Operational notes (not TODOs: context for future-you)

- Lightweaver is hosted on Cloudflare Pages project `lightweaver` (NOT `mandalacodes`, NOT `adrian-website`). Custom domain `led.mandalacodes.com` is attached. Fallback URL: `lightweaver-edw.pages.dev`.

- The Arduino/ESP-IDF platform upgrade is intentionally deferred for LED reliability. Before changing the core or related firmware dependencies, follow [the firmware platform upgrade warnings and acceptance gates](docs/firmware-platform-upgrade.md).

- ESP32-S3 firmware + WLED for the hardware side. Reliable write path is the ESP32 AP page at `http://192.168.4.1`, public HTTPS-to-private HTTP may be blocked by browsers.
