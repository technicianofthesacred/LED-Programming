# Lightweaver — development roadmap

> Open items are now also surfaced in ../TODO.md (consolidated 2026-05-29). This file stays the detailed living roadmap and changelog (Done items are the project history); TODO.md is the scannable open-work view and links back here for detail.

Living source of truth for project work. Update as items move between sections.

Last updated: 2026-07-18

> **Current scope: ESP32-only.** The runtime is the Lightweaver card alone — it
> serves its own branded page (the visitor UI) and the WLED API; the public
> Studio (`led.mandalacodes.com`) handles design/export. **No Raspberry Pi in
> the runtime path.** The Pi proxy (`lightweaver/server/`), `visitor-ui/`, and
> `docs/pi-hosted-deployment.md` are deferred for a planned future Pi
> integration — kept, not deleted, but out of the current plan.

## Current execution order: protect the working product

This is the master order of work. The detailed plans under
`docs/superpowers/plans/` are engineering references, not a stack that must be
run end to end.

### Phase 1: Finish the product already on `main` — required now

**Purpose:** reach one reliable, usable Lightweaver release before adding new
hardware architecture.

#### Phase 1A: Close confirmed release defects

1. Let the concurrent LED UX work finish and land on `main`. _(Done — merged
   as `8f2c0ae`.)_
2. Restore complete firmware card-page preview coverage. The 2026-07-18 audit
   confirmed the customer page is missing **17 of 30** factory pattern styles
   (ripple, lava, meteor, chase, candle, lightning, neon, matrix, heartbeat,
   stained, confetti, warp, pulse-ring, blocks, bloom, calm, drift — the
   advanced page has all 30). The regression test must derive the factory id
   list from `LightweaverStorage.cpp` and fail when either embedded page lacks
   a `.sw-<id>` style.
3. Pattern selection: the 2026-07-18 audit could **not reproduce** a failure
   on the customer page or in Studio — both use acknowledged controls with
   rollback, a pending lock, an explained streaming lock, and stable grid
   order. Retain those implementations. The confirmed defect is the
   **advanced page** grid: purely optimistic selection with no rollback and no
   streaming lock (a tap during a stream returns 200 with no visible change).
   Fix the advanced page and add source coverage; do not rewrite the sound
   paths.
4. Make screen recovery preserve and expose a bounded support code
   (`LW-UI-xxx`), the failed route, and a sanitized error name after the
   single automatic reload — never project contents, hosts, or tokens. Add
   fixtures for malformed, stale/forward-version, migrated, and valid saved
   projects. Two additional confirmed persistence defects land here: an
   unrecognized-version autosave is silently **overwritten within ~1.5 s**
   (must be quarantined, never destroyed), and startup restore always marks
   the project dirty (false "Unsaved changes" on an untouched app, and
   "Saved in browser" never survives reload).

Full evidence, classifications, ownership, and the answered product
questions: [2026-07-18 release-coherence
findings](superpowers/plans/2026-07-18-release-coherence-findings.md).

#### Phase 1B: Make the ordinary project journey coherent

Use this as the canonical normal workflow throughout Studio:

**Connect card → Design layout (Draw / Size / Wire) → Create looks → Arrange
playlist → Install or update when required and physically verify → Save / export**

Experienced users may jump between screens, but the interface must show the
current step and one clear next action. Apply these ownership rules:

1. **Layout owns physical structure.** Card settings shows a read-only layout
   and output summary with **Edit in Layout**. Remove the disabled section-count
   and duplicate output-routing editors from Card settings; generated circles,
   imported artwork, and customized layouts all use the same source of truth.
2. **One project-persistence surface.** Consolidate browser autosave/recovery,
   browser library, file import, and file export into one clearly named project
   area. Keep one canonical project extension while continuing to import legacy
   `.lw.json`, `.lwproj.json`, and plain JSON files.
3. **One auxiliary local-card tab.** Keep the local card/Bridge context required
   by the HTTPS-to-local command path, but reuse it for install handoffs instead
   of opening a second installer tab.
4. **Batch production is a separate mode.** Move Workshop setup out of the
   normal Card journey and label it **Batch production**. Preserve
   `#screen=production`, production job deep links, and the former
   `#screen=card&section=workshop` entry as compatibility routes; do not weaken
   signed firmware, identity binding, worker checks, or pass records. Keep it
   discoverable through the direct URL, an Advanced & Support tile, and a
   low-emphasis Card overview link — never as a setup step.
5. **One verb per card action.** "Save to card" is the only label for the
   acknowledged config/project write (Layout, Patterns, Playlist, Card);
   "Install or update" is reserved for firmware; the top bar reads Save
   project (browser) / Export project (`.lw.json` file) / Import project.
   "Looks" is the product noun (retire visible "mixes").
6. **Fix the reproduced journey blockers found 2026-07-18:** the Card
   overview/Recovery connect action must open the guided Connection Center
   instead of silently probing; Patterns must not overflow horizontally at
   390 px and the Playlist preview status must stay visible on phones; the
   rail gets `aria-current`; card-page opens reuse the one named local-card
   window.

These changes simplify ownership and navigation. They do not create a new
hardware model, command transport, installer, or storage format.

#### Phase 1C: Verify and release

1. Re-run the existing Card, Layout/Wire, pattern, playlist, installer,
   production, persistence, migration, and recovery tests on the integrated
   `main`. The 2026-07-18 audit found CI's launch gate runs only 3 of 26
   Playwright suites and 5 of 38 lib unit files (one stale-red test was hiding
   on `main`); the coherence pass widens the gate to include the suites that
   cover its changed surfaces.
2. Bench-test one real card and LED run through the canonical normal workflow.
3. Separately smoke-test Batch production, including a legacy job deep link.
4. Fix only failures that block those workflows. Do not add multi-card,
   templates, power dashboards, history, or another navigation surface during
   this phase.
5. Build and publish the protected signed firmware release, run
   `npm run launch:check`, then deploy the verified Studio.

**Done when:** one project can be drawn, wired, given looks and a playlist,
installed, physically verified, saved/exported, restarted, and recovered
without losing work or showing false success; Batch production remains
available without appearing as a required artwork-configuration step.

**Rollback rule:** every change in this phase must be independently revertible.
If the full test gate or bench workflow regresses, do not merge it.

### Phase 2: Use the current product on the next LED project — required proof

**Purpose:** discover which reusable tools are actually missing through a
second real setup instead of predicting every future need.

Use the current single-card workflow for the next project and record repeated
setup work, unsafe manual calculations, or missing records. A repeated pain
must happen in a real project before it becomes active product scope.

**Done when:** the second project either succeeds with the current tools or
produces a short evidence-backed list of repeated problems.

### Phase 3: Add reusable infrastructure one module at a time — conditional

Each module is a separate decision, branch, test gate, and merge. Do not run the
entire reusable-card plan as one migration.

When a start condition becomes true, write a narrow implementation plan for
that one module against the then-current `main`. The large 2026-07-18 reference
plan supplies constraints and test ideas; its task numbering is not the release
order.

Skip any module whose start condition is false. The first true condition is the
next module; nothing in this table is mandatory merely because it has a number.

| Priority | Module | What it does | Start only when |
| --- | --- | --- | --- |
| 1 | Output calibration hardening | Executes and verifies firmware RGB balance, gamma, and color-order math. | A real strip shows color-output problems, or calibrated output is required for a sellable piece. |
| 2 | Reusable project templates | Copies known-good controller, LED, and power starting points into a new independent project. | The second project repeats setup that should have been reusable. |
| 3 | Power safety recommendations | Calculates supply headroom, current ceilings, voltage compatibility, and deterministic blockers. | Projects use different LED voltages, supplies, pixel loads, or installers need calculation guidance. |
| 4 | Multi-card project model | Lets one project own and select multiple independent ESP32 cards without confusing their identities. | A real installation requires more than one controller card. |
| 5 | History, replacement, and as-built records | Preserves approved setup, deviations, failed-card replacement, and installation evidence. | Cards are handed off, sold, serviced, or replaced often enough that records matter. |
| 6 | Card UI extensions | Exposes only the modules that earned their place inside the existing Card workspace. | The underlying module works and the concurrent UX work is already integrated. |

Every module must preserve the current Card and Layout → Wire behavior. It may
add a summary or deep link, but it may not create a second output editor,
commissioning flow, installer, or top-level Hardware destination.

### Phase 4: Broader runtime work — deferred

Pi hosting, fleet management, cloud catalogs, OTA updates, deeper WLED
compatibility, and new Art-Net infrastructure remain deferred until a real
installation cannot be completed safely without them.

### Plan status

- `2026-07-17-hardware-foundation.md`: superseded; do not execute.
- `2026-07-17-hardware-workspace.md`: superseded; do not execute.
- `2026-07-17-hardware-installation-toolkit.md`: superseded; do not execute.
- `2026-07-18-reusable-card-infrastructure.md`: detailed reference for Phase 3;
  activate one task only after its start condition is true.
- `2026-07-17-unified-card-workspace.md`: implemented, then amended by the
  Phase 1B ownership rules above. Preserve its installer safety and legacy
  aliases, but do not preserve Workshop as a normal Card section or Card as a
  second layout editor.
- The remaining 2026-07-17 closeout plans are already represented in current
  `main`; preserve their tested behavior.

**Current next action:** integrate the other LED UX work into `main`, then run
Phase 1A and 1B as one narrow release-coherence pass before the Phase 1C test,
bench, signing, and deployment gate. No reusable hardware module is currently
required to ship the working product.

Keep `codex/unified-hardware-workspace` as an incubator and engineering
reference. Do not merge the branch wholesale; extract only a triggered module
through its own narrow, current-main branch and verification gate.

## Done

### Audit + foundation (commit `839eee5`)
- [x] Decide canonical app layout: `led-art-mapper/` is design tool; `lightweaver/` provides reusable React building blocks; `visitor-ui/` is the new branded Pi-hosted UI
- [x] Build visitor-facing branded UI per `branded-installation-ui.md` — `visitor-ui/` (Vite/React + Express)
- [x] Wire WLED JSON API in `lightweaver/src/hooks/useWled.js` (setPreset/setPower/setBrightness/getState/getInfo, 3s timeout)
- [x] Stand up Pi-hosted Express server (`visitor-ui/server/index.js`) with `/api/preset/:id`, `/api/power`, `/api/brightness`, `/api/state`, captive-portal probes
- [x] Replace ad-hoc `pw-*.mjs` diagnostic scripts with real `@playwright/test` specs in `e2e/` (svg-import, layer-selection, nested-wrapper) + SVG fixtures
- [x] Archive useful diagnostic scripts to `scripts/debug/`; delete duplicates
- [x] Cache `PreviewRenderer` per-strip normals (`led-art-mapper/app/src/preview.js`)
- [x] Document deployment checklist, segment template, hardware setup (`docs/`)
- [x] Remove zero-byte `led` file

### led-art-mapper bugs (commit `839eee5`)
- [x] **BUG**: WLED frame buffer reallocates every frame — reusable `Uint8Array`, resize on length mismatch (`main.js:139`)
- [x] **BUG**: strip reversal on scene restore — applied post-sample with WHY comment (`main.js:2050-2058`)
- [x] **BUG**: float-imprecise speed comparison — epsilon `1e-4` (`main.js:1153, 1267, 1282`)

### led-art-mapper features (commit `839eee5`)
- [x] **C1** per-section pattern assignment — strip dropdown, lazy compile, render override
- [x] **C2** live WLED push over network — native WS opcode `0x02`, ~30fps, auto-reconnect with exponential backoff (1s → 15s)
- [x] **C3** section groups/zones — collapsible group panels, member assignment popover, render override
- [x] Pattern-eval error log panel — 5-entry ring, dedup consecutive, dismissable

### Runtime strategy
- [x] Define the two Lightweaver product versions: **Basic WLED** for entry-level stored looks and **Advanced Art-Net / Custom** for Madrix, live Art-Net, and exact standalone sequence playback — see `docs/superpowers/specs/2026-05-25-two-version-runtime-strategy-design.md`
- [x] Add shared runtime-tier and pattern-target helpers in `lightweaver/src/lib/runtimeTargets.js`
- [x] Add WLED / ADV compatibility chips to the Live pattern grid
- [x] Build WLED Basic export package generation: WLED preset bank, playlist preset, unsupported-pattern warnings, and custom-effect port list
- [x] Audit all 130 Lightweaver patterns and gate them by runtime: WLED stock, WLED custom port, audio source, beat/timeline source, or computer/Pi render — see `docs/pattern-compatibility-audit.md`
- [x] Add controller compatibility audit for the connected WLED unit: firmware, LED count, segments, presets, LED map, Art-Net/E1.31, clock, identity, and audio-source gates — see `docs/controller-compatibility-audit.md`
- [x] Verify bench ESP32-S3 is reachable at `192.168.18.66` running WLED `0.15.4`
- [x] Back up and flash the non-lit USB ESP32-S3 with temporary Lightweaver USB LED test firmware; verify `LWUSB` serial commands on `/dev/cu.usbmodem5B5E0414831` — see `docs/usb-controller-audit.md`

### Cloud relay removal
- [x] Remove Cloudflare KV relay as a Lightweaver transport; the card no longer registers, heartbeats, polls, or shows pairing codes.
- [x] Delete the Cloudflare KV namespace and keep `/api/lw/*` excluded from Pages Functions.
- [x] Reframe Studio v3 as chip-config export/load only: public HTTPS uses copy/download/open-card; direct card push is local HTTP/file only.

### Studio trust and physical wiring (2026-07-13)
- [x] Make project persistence and card installation separate acknowledged revision states; failed writes retain the last confirmed card revision and retry the exact frozen payload.
- [x] Replace the flat physical chain with one canonical wiring model compiled into output offsets, zones, WLED ledmap coordinates, frame order, firmware outputs, and assembly instructions.
- [x] Add pointer drag/drop and accessible move controls for strip runs, cable jumps, reserved-unlit addresses, up to four output lanes, physical direction, split ranges, and closed-path seams.
- [x] Add deterministic Auto Wire with preview/accept/cancel, output-count constraints, fixed-direction/seam preservation, bounded exact search, and solver-approved alternatives.
- [x] Add the acknowledged low-brightness bench chase, explicit output/run/jumper/reserved confirmations, correction invalidation, lock gating, prior-look restoration, and phone/print assembly map.
- [x] Ship Layout Send to card and canonical `ledmap.json` export from the verified compiler result.
- [x] Harden Patterns, Settings, Show, installer, and the card visitor UI against optimistic success, stale async acknowledgement, inaccessible modal/navigation behavior, and visitor-control rollback.
- [x] Rebuild the 2026-07-13 public ESP32-S3 factory binary from that hardened firmware and enforce source/binary freshness in the launch gate. Later production identity/recovery source changes now require a new protected signed release before the next deploy.

### Browser workshop production flow (source complete; release acceptance pending)
- [x] Add the root `#screen=production` worker flow for desktop Chrome/Edge Web Serial: verified immutable job, exact signed firmware, one-card identity binding, independent artwork read-back, physical checks, local pass record, and Next artwork.
- [x] Add current-limited one-boundary-at-a-time blue-first/red-last/dark-outside checks with explicit human confirmation and reboot-safe 90-second candidate rollback for count, direction, GPIO, and color order corrections.
- [x] Add safe recovery classifications, one-action guidance, stable support codes, and bounded redacted diagnostic export.
- [x] Add the no-code worker procedure in `docs/worker-flash-runbook.md` and separate the feature-branch source gate from the protected signed-firmware production gate.

## Open — user/hardware actions

These cannot be done by agents. See `docs/hardware-setup.md` for step-by-step.

- [ ] Set final WLED LED count, data GPIO, LED type, color order, and brightness limit for the actual artwork
- [ ] Rename the controller and reserve MAC `ac:a7:04:e2:ec:e0` as `192.168.18.66` or the chosen install IP
- [ ] Back up current `/presets.json` before installing Lightweaver presets
- [ ] Configure & test Madrix Art-Net output → WLED (universes, 510 ch/universe, 30–44 Hz, WiFi sleep disabled)
- [ ] Define WLED segments matching laser-cut zones — fill in zone IDs in `docs/segments.md`
- [ ] Capture per-device record: MAC, post-STA IP, segment JSON dump
- [ ] Run the real-artwork physical wiring acceptance gate: output identity, first pixel, direction/order, jumper routing, reserved addresses, color order, brightness cap, and archived locked wiring/assembly map
- [ ] Rehearse the complete Production Setup runbook with a workshop worker who did not build the software; retain the exported CSV and JSON pass records.
- [ ] On a real card/strip, capture Production Setup evidence for firmware install/update, exact card/job read-back, all blue/red/dark boundaries, candidate confirm, timed rollback, reboot recovery, support export, and Next artwork.

## Open — deployment

- [x] Publish the public Lightweaver browser UI at `led.mandalacodes.com` through Mandala Codes/Cloudflare Pages
- [x] Keep actual card control local to the ESP32 page unless a local bridge is intentionally added
- [ ] Run the protected `firmware-release` signer for the latest merged firmware source; the currently committed public factory artifact is stale and the strict deploy gate must remain red until CI publishes the new signed release.
- [ ] Deploy the root Studio only after `npm run launch:check` passes on that signed release commit, then require `PROD_CHECK_REQUIRED=1 npm run check:prod` and verify the live `#screen=production` route.
- [x] Publish at least one immutable production job — `bench-fixture-44` (44-LED bench strip, GPIO 16) is published through the same-origin index and regenerated automatically against every newly signed firmware release by `scripts/rebuild-production-jobs.mjs` in the protected workflow. Detached-signature export for the offline file lane remains available via `--signing-key`.
- [ ] Pi setup: hostname, autostart `visitor-ui/server` (systemd unit example in `visitor-ui/README.md`)
- [ ] AP mode SSID convention: `Lightweaver-XXXX` (MAC-suffix, set by firmware automatically; see ESP32 card smoke test in `docs/deployment-checklist.md`)
- [ ] Captive portal end-to-end test from a phone on the AP
- [ ] Customize `BRAND` constant in `visitor-ui/src/App.jsx` (artist, piece, accent color)
- [ ] Match `SCENES` array in `visitor-ui/src/App.jsx` to actual saved WLED presets

## Open — software follow-ups

- [x] Add the free desktop Chrome/Edge Web Serial production lane for one-card flashing and loading. Native Bridge packaging remains deferred and is not part of Production Setup.
- [ ] Flash current no-relay firmware to any existing cards that were built with the old relay polling module.
- [ ] **Refactor**: split 4,713-line `led-art-mapper/app/src/main.js` into modules (state, ui, render, export) — *deferred from this round; best done in a focused session because it touches everything*
- [ ] Extend runtime target badges to Pattern, Timeline, and Export screens
- [ ] WLED Basic installer: run controller compatibility audit, back up existing presets, then apply the generated package directly to a connected WLED controller
- [ ] Lightweaver custom WLED effect build: first branded ambient set for Candle Drift, Ember Slow, Warm Pulse, Amber Aurora, and Gallery Idle
- [ ] Standalone controller export: generate `lightweaver.json` and `.lwseq` microSD packages for ESP32-S3 playback
- [ ] Add Vitest unit suite for `led-art-mapper` pattern helpers + export functions
- [ ] Tighten Playwright selectors flagged with `// TODO: tighten selector` in `e2e/*.spec.ts`
- [ ] Wire visitor-ui brightness slider to debounce instead of commit-on-release (current behavior is intentional — confirm UX)
- [ ] Add `lightweaver` UI hook-up for the new JSON API methods (currently only the hook exposes them)

## Open — nice-to-have

- [ ] Pattern syntax validator with friendly inline errors (currently runtime-only)
- [ ] Accessibility pass on `led-art-mapper` (ARIA, keyboard nav, shortcut documentation)
- [ ] Visitor-ui idle screensaver / brand animation while no scene is selected
- [ ] Telemetry: log preset selections to a local file for installation analytics

## How to update this doc

- Move items between sections as work progresses; do not delete done items — they are the project changelog.
- Reference the commit SHA when marking something done.
- Add new items under the appropriate section as they are discovered.
- Keep entries one line where possible; link to longer notes in `docs/` if needed.
