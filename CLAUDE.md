---
name: lightweaver
status: active
stack: [ESP32-S3, Lightweaver firmware, React, Vite]
deploy: public Studio at led.mandalacodes.com; local Lightweaver card command path
family: installation
last_reviewed: 2026-08-20
---

# Lightweaver — branded LED installation controller

## What this is
Custom LED lighting control platform for laser-cut art installations. **Project name: Lightweaver.** The active product uses Lightweaver firmware on an ESP32-S3 card, with Studio accessible from phone or browser.

## Current plan — ESP32-only (Pi deferred)
As of 2026-06 the runtime is **ESP32-S3 only**. The card runs the Lightweaver firmware and **serves its own branded scene-selector page (this is the visitor UI)** plus the WLED-compat JSON/WS API at `lightweaver.local` / `192.168.4.1`. The public Studio at `led.mandalacodes.com` is the design/export surface and reaches the card directly on the LAN / via the card-page postMessage bridge. **There is no Raspberry Pi in the runtime path.** A Pi integration is planned for *later* — `lightweaver/server/` (the WLED proxy), `visitor-ui/`, and `docs/pi-hosted-deployment.md` are **kept for that future** but are **not part of the current plan**; don't treat them as the live runtime or invest in them unless the Pi work is explicitly resumed.

## Current contents
- `research.md` — hardware options (ESP32-S3, WLED firmware, Madrix integration), Art-Net/E1.31 protocols, control architecture, color management
- `branded-installation-ui.md` — visitor-facing branded UI design spec (captive portal, scene selector)
- `led-art-mapper/` — Vite app for designing LED strip paths over artwork SVGs and exporting external geometry formats
- `lightweaver/` — React Studio/control app, controller package export, runtime contract tests, and deferred Pi proxy
- `firmware/lightweaver-controller/` — standalone ESP32-S3 Lightweaver card firmware for local playback
- `docs/deployment-checklist.md` — bench-to-gallery checklist, including code/runtime launch gate

## Key decisions from research
- **Active runtime**: standalone ESP32-S3 Lightweaver card for local playback.
- **Deferred options**: WLED, Raspberry Pi hosting, and Madrix/Art-Net remain research and future integration lanes.
- **Public UI split**: `led.mandalacodes.com` is the public Studio/setup/support surface. Actual LED commands stay local through the card page or its verified local bridge.
- **Launch gate**: before deployment, run `npm run launch:check` from `lightweaver/`, then complete the hardware and site smoke tests in `docs/deployment-checklist.md`.

## Project name
**Lightweaver** — use this name in UI copy, WiFi SSIDs, and any public-facing branding.

## Public web / GitHub
- **Parent site**: `mandalacodes.com` is Adrian Rasmussen's site.
- **Canonical public Lightweaver UI URL**: `led.mandalacodes.com`.
- **LED repo GitHub**: `git@github-tech:technicianofthesacred/LED-Programming.git`.
- **Mandala Codes repo GitHub**: `git@github-tech:technicianofthesacred/mandalacodes.git`.
- **Deployment split**: the Lightweaver browser UI lives at `led.mandalacodes.com`. The active command path stays local through the Lightweaver card page or verified local bridge.

## Architectural decisions
- `led-art-mapper/` is the standalone geometry tool. Its WLED and coordinate artifacts are external exports, not the active card runtime contract.
- `lightweaver/` (React) is the public Studio, installer, design, commissioning, and control surface.
- `visitor-ui/` is a **future Pi-hosted** branded React UI (captive-portal scene selector per `branded-installation-ui.md`). **Not in the current ESP-only plan** — the firmware card page is today's visitor UI. Retained for a future Pi integration; visitor-facing polish goes into the firmware page for now.
- **Tests** live under `/e2e/` using `@playwright/test`. **Diagnostic scripts** are archived in `/scripts/debug/`.

## Shipment vocabulary and standing authorization

Use these words precisely in every Lightweaver handoff:

- **Committed**: the change exists in a local Git commit. Not necessarily on GitHub.
- **Pushed**: a remote branch contains the commit. Not necessarily reviewed or on `origin/main`.
- **PR-ready**: the pushed branch has its required tests and a truthful ready-for-review pull request. Not merged.
- **Merged**: the integrated change is contained in `origin/main`. Not necessarily deployed.
- **Deployed**: the production workflow used real production credentials, published the exact integrated revision, and succeeded. A credential-skipped green workflow is not deployed.
- **Shipped**: tested, merged into `origin/main`, deployed successfully, and then independently proven live at `https://led.mandalacodes.com` by its strict no-store `/studio-release.json` revision and the exact deployed files in the staged build graph.

Every **Deployed** and **Shipped** report must name the **build numbers** — the repository's first-parent commit count, which is exactly the number GitHub prints as "N Commits" at the top of the file list. Adrian checks GitHub, checks the screen, and knows whether he is running the newest code. Never switch this to a prettier counter that steps by one per change — neat increments are worthless if they match nothing he can see. The same number is used for both surfaces:

- **Studio build** — `buildNumber` in `/studio-release.json`, shown in the Studio footer beacon.
- **Firmware build** — `buildNumber` in the signed `/firmware/release-manifest.json`, compiled into the binary as `LW_BUILD_NUMBER` and reported by the card on `/api/firmware-info` and `/api/status`. A card and the release it was flashed from always report the same number.

Say "Shipped — Studio build 412, firmware build 411", not just a commit SHA. Those numbers are how Adrian confirms a browser and a card are current without decoding a hash. The two can differ by one on a firmware release, because the signer commits the signed artifacts on top of the revision the binary was compiled from; that is expected, not drift.

"Ship it to main" is standing authorization to complete that entire sequence, including the integration PR, merge, production workflow, and final live proof. A commit, push, PR, merge, or green CI result alone never satisfies it. If any boundary cannot be crossed, report **not shipped** and name the exact last verified state and blocker. Do not claim completion before the final live proof against the terminal `origin/main` revision, including any protected firmware signer commit triggered by the merge.

## Firmware development loop — bench vs release

Two paths, chosen by one question: **is the card on a USB cable?**

- **Bench (USB, ~90 seconds)** — `bash scripts/firmware-dev.sh` compiles locally
  (~50s clean, ~20s incremental) and flashes over USB (~22s). The card reboots
  itself keeping Wi-Fi, project, patterns, and settings. This is THE loop for
  all firmware iteration. Dev builds report `buildId "dev"` / `buildNumber 0`
  so they can never be mistaken for a signed release; Studio will show an
  "update available" chip against the official release — expected, ignore it
  while iterating.
- **Release (merge to main, ~30 min, unattended)** — only when work is done and
  should become the official signed update: for cards with no USB cable (a
  customer's wall, Wi-Fi-only updates from the browser) and for the public
  download. "Ship it to main" runs it. Requires a `VERSION` bump; run
  `node scripts/ci-preflight.mjs` first — it answers in ~2s what CI will demand.

Iterating never needs the release path. A bench card can live on dev builds
indefinitely and jump to a signed release any time (USB flash or Wi-Fi update).

**"Ship it" defaults to quick, and a signed card release is on demand.**
Studio source is embedded in the card bundle, so every visual change is
technically firmware-sensitive. It is NOT treated as a release: when the
firmware lane fires only because of that embedded copy
(`firmwareBundleOnly` in `scripts/ci-changed-lanes.mjs`), the signer is
skipped and the site deploys straight away — no VERSION bump, live in
~10 minutes. Bundle drift accumulates harmlessly and ships with the next
release.

A signed card release happens when either is true: real firmware changed
(`firmware/**` source, platformio, release machinery), or **VERSION was
bumped** — the bump IS the on-demand trigger, so "finalize firmware" means
bump `firmware/lightweaver-controller/VERSION` plus its pinned literal in
`tests/firmware-version-policy.mjs` and merge (~30 min, signed, published).

The firmware TEST lane is unchanged: Studio changes still compile against the
card, so a bundle that no longer fits fails on the PR rather than twenty
minutes into a release. Predict what a diff gets before pushing:
`node scripts/ci-preflight.mjs`.

Consequence to keep in mind: between releases, the signed download and any
Wi-Fi update are older than the live site. A bench card on a dev build is
unaffected; a customer card gets the drift at the next release.

## Agent ownership boundaries
- `led-art-mapper/app/src/` — owned by led-art-mapper agent; do not edit
- `lightweaver/src/` — owned by lightweaver-app agent; do not edit
- `firmware/lightweaver-controller/src/` — owned by firmware agent; do not edit
- `scripts/`, `.github/`, `docs/`, root markdown files, `lightweaver/scripts/`, `lightweaver/vite.config.js`, `lightweaver/package.json` (scripts section only), `.gitignore` — owned by CI/docs agent

## Tools already built
- `led-art-mapper/` — design tool: draw LED strip paths over artwork, set pixel counts, write live patterns (JS), and export WLED/FastLED/CSV geometry for external consumers

## Next steps
- [x] Tooling: led-art-mapper design tool, lightweaver React building blocks, visitor-ui scaffold
- [x] Operational docs: `docs/deployment-checklist.md`, `docs/hardware-setup.md`, `docs/segments.md`
- [x] Launch gate: `npm run launch:check` in `lightweaver/` runs core runtime contract tests and production build
- [ ] Complete current signed Lightweaver firmware acceptance on the physical ESP32-S3 card
- [ ] Complete project read-back, visible-strip, power-cycle, offline, microSD, and Wi-Fi recovery checks
- [ ] _(deferred)_ Configure WLED/Madrix and Art-Net only when that future lane is explicitly resumed
- [ ] _(deferred — future Pi integration, not current plan)_ Build out `visitor-ui/` against the WLED JSON API and deploy to the Pi

## Branch landing rules (standing policy — read before pushing or merging)
Full policy: `docs/branch-maintenance.md`. The short version every session must follow:
- Every branch is either **PR'd**, **`archive/`-prefixed with a TODO.md entry**, or **deletable**. Never end a session with only "pushed to branch X".
- Before opening a PR for a branch you don't own, check the account's session list and ask the owning session whether the build is done. If unsure, open it as a **draft**.
- Once the owning session confirms done and CI is green, **merge without asking** and delete the branch. Land one stream at a time.
- "**Wrap it up**" from Adrian means: finish the increment, then merge / PR-and-watch / archive-and-log — pick one, do it, report which.
- **Half-built work never merges.** Wrapping an unfinished stream = push the branch + a TODO.md resume entry (branch name, done, remaining, resume point). No resume entry, no wrap.

## Where to look for…
- **Launch checklist / deployment source of truth** → `docs/deployment-checklist.md`
- **Project roadmap (living source of truth)** → `docs/roadmap.md`
- **Hardware research** → `research.md`
- **Visitor UI design plan** → `branded-installation-ui.md`
- **LED layout design tool** → `led-art-mapper/`
- **Direction / strategy log** → `THINKING.md` (rejected paths + tensions across chats)
- **Outstanding work** → `TODO.md` (project root)

## TODO format
`TODO.md` items follow the workspace convention: `- [ ] **Bold lead.** _(band: agent-runnable | you-required | routine)_ One descriptive sentence.` with an optional link/detail line underneath pointing to the full plan doc, PR, or referenced files. Group items under `## Soon` / `## Future` / `## Operational notes`. The band hint tells the i64os Temple page which lane to render the item in.

@./THINKING.md
