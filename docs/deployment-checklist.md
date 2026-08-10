# Lightweaver deployment and shipment gate

This is the source of truth for the current ESP32-S3-only product. Studio is
published at `https://led.mandalacodes.com`; the card runs patterns and accepts
commands locally. There is no Raspberry Pi in the shipping runtime.

## Windowless offline Studio acceptance — all unperformed

Automated route stubs and headless-browser checks are simulated evidence only.
Every item here is **UNPERFORMED** until recorded on the named real browser and
physical card; an HTTP success never substitutes for observing the lights.

- [ ] **UNPERFORMED — macOS Chrome and Edge:** allow, deny, and revoke Local Network Access; exact-card direct control; wrong-card write block; same-tab fallback; no auxiliary window.
- [ ] **UNPERFORMED — macOS Safari:** failed/unsupported direct probe uses same-tab local Studio; offline control; no auxiliary window.
- [ ] **UNPERFORMED — Android Chrome:** direct permission outcomes, same-tab fallback, installed-PWA cold offline reload, and background/resume.
- [ ] **UNPERFORMED — iPhone Safari and Chrome, and iPad Safari:** same-tab local Studio, offline control, background/resume, and fixed-origin HTTPS return.
- [ ] **UNPERFORMED — private mode:** truthful storage/install limits and no silent project loss on every required browser.
- [ ] **UNPERFORMED — networks:** router Wi-Fi, card AP `192.168.4.1` without internet, loss after load, reload, Wi-Fi handoff, and reconnect.
- [ ] **UNPERFORMED — authority:** wrong card, reboot/new boot ID, permission revoke, and origin/network/session/generation change block writes until exact revalidation.
- [ ] **UNPERFORMED — command families:** Setup, Strip Discovery, Layout/Wire, stage/visible-confirm/install/readback, Patterns, brightness, blackout/Stop, recovery, projects, and HTTP frames through `direct-lna` and `local-origin`; legacy recovery remains usable.
- [ ] **UNPERFORMED — physical output:** patterns and frames visibly animate expected pixels; Stop blacks out; recovery restores control.
- [ ] **UNPERFORMED — card serving:** first and repeated HTML/JS/CSS/font delivery causes no visible animation stall; record card/build and measured observation.
- [ ] **UNPERFORMED — damaged/incompatible bundle:** small recovery page retains safe pattern, brightness, blackout, and installer recovery.
- [ ] **UNPERFORMED — secure tools:** USB, microphone, and provenance use same-tab handback to fixed `https://led.mandalacodes.com/` only.
- [ ] **UNPERFORMED — project continuity:** complete editable export/import/card save, visible copy identity, quota rejection, and config-not-backup truthfulness.
- [ ] **UNPERFORMED — conflict/handoff:** fragment-only ciphertext is exact-card-bound, expiring, single-use; return-online conflicts require compare/keep-both/replace.
- [ ] **UNPERFORMED — power loss:** interruption at every staging/hash/readback/head-promotion boundary retains the prior known-good project.
- [ ] **UNPERFORMED — signed combined release:** exact factory offset/size/hash/readback and card-Studio build/schema/API/assets match card-reported identity.
- [ ] **UNPERFORMED — preserving USB bootstrap:** on a supported older configured card, the only write is the signed application range at `0x10000`; exact readback succeeds and Wi-Fi/project/pattern/wiring/settings hashes remain unchanged.
- [ ] **UNPERFORMED — interrupted preserving USB:** disconnect/reset at bounded write/readback/reconnect points retains data and the same non-erasing bootstrap remains repeatable.
- [ ] **UNPERFORMED — A/B update:** exact-card owner authority, ticket/app verification, inactive-slot transfer, probation, success, cancel, router loss, and rollback all preserve project/configuration.
- [ ] **UNPERFORMED — update power loss:** cuts during receive, verify, boot selection, reboot, probation, and mark-valid return either the old known-good application or the new proven application without selecting a partial image.

Never substitute a local build, direct HTTP request, terminal command, green
board LED, API acknowledgement, or mocked browser test for the live erased-card
acceptance below.

## Completion contract

These release states are deliberately non-interchangeable:

- **Committed**: a local Git commit contains the work.
- **Pushed**: a remote branch contains that commit.
- **PR-ready**: required tests passed and a truthful ready-for-review pull request exists.
- **Merged**: the integrated work is contained in `origin/main`.
- **Deployed**: a non-skipped production workflow used valid production credentials and successfully published the exact integrated revision.
- **Shipped**: tested, merged, deployed, and independently verified on the live production origin, including the marker and exact files described below.

“Ship it to main” authorizes the complete route through **Shipped**. It never
means stop after commit, push, PR, merge, or green CI. When blocked, say **not shipped**
and identify the exact boundary: for example merged but deploy skipped,
or deployed but live bytes do not match.

The mandatory final live proof runs only after `origin/main` has stopped moving,
including any protected firmware signer cascade. From a clean checkout of that
terminal revision, run `PROD_CHECK_REQUIRED=1 npm run check:prod` in
`lightweaver/`. The checker must rebuild and stage deterministically, require
`https://led.mandalacodes.com/studio-release.json` to be HTTP 200 with
`Cache-Control: no-store`, match its full source revision, short build ID, and
build number to the running bundle, and verify every file and digest in the
   staged Studio and firmware release graphs against live production. Record the build number, revision,
deploy workflow run, marker, and checker result. The build number is the
comparable one: it is what the Studio footer shows (`Studio current · Build
412`) and what a handoff report must quote. This independent proof—not the deploy job's own green badge—is
the final shipment gate.

## How a release reaches production

The release is deliberately split so feature branches never receive signing
keys:

1. A reviewed branch must pass the repository-owned changed-path lanes and the
   single required `Tests / gate` check. Merge queue is enabled, so the same
   gate runs on the proposed merge group instead of trusting an out-of-date
   branch result.
2. The successful `Tests` run on protected `main` is the source of deployment
   authority. Its classifier selects bounded source/build, browser, cloud,
   production, firmware-sensitive, and artifact lanes; selected lanes run in
   parallel and the aggregate gate fails if any selected lane fails or is
   cancelled. The blocking browser lane is a small established smoke set for
   project creation/navigation, connection visibility, and exact card-project
   recovery. The complete `test:release-ui` suite remains in the asynchronous
   exhaustive gate. Workflow and classifier changes conservatively run every
   lane, and deleted files are classified the same as added or edited files.
3. When that exact tested revision is firmware-sensitive, protected
   `build-firmware.yml` checks out `workflow_run.head_sha`, recompiles the
   ESP32-S3 factory and application images once with that identity, hashes the
   exact raw partition-table flash range, signs the exact update ticket before
   building/signing manifest schema 2 and provenance, regenerates every
   production job, and commits the complete release set to
   `main`. It refuses to publish if a signing input changed while it ran and
   dispatches deployment with the exact signed commit SHA. Generated
   artifact-only commits never re-trigger signing.
4. UI-only tested revisions may deploy directly. Firmware-sensitive source
   revisions are deferred until the signer dispatches their signed commit.
   `deploy-site.yml` rejects stale revisions, checks that `origin/main` still
   names the requested SHA immediately before publish, and runs
   `npm run ci:artifact`; it never substitutes a newer checkout. A manual
   dispatch cannot override this boundary: firmware-sensitive source is
   rejected unless the requested current-main SHA is the signer-generated,
   artifact-only release commit.
5. `deploy-site.yml` then applies every pending expand-only D1 migration, including
   `0002_account_access.sql` and `0003_account_session_generation.sql`, with the
   separate D1-only credential before publishing compatible Studio and Pages
   Functions. The first deployment keeps Cloudflare Access in front of the
   library for owner bootstrap; the final deployment is enabled by
   `LIGHTWEAVER_NATIVE_AUTH_READY=confirmed` only after native login is proven.
6. The deploy runs `PROD_CHECK_REQUIRED=1 npm run check:prod`. Before cutover it
   requires the Access denial. After cutover it requires public Studio HTTP 200,
   native account and library session HTTP 401 responses with `no-store`, and a
   reachable public login Function, as well as the signed release, job, cache,
   Studio build-graph, firmware release-graph, immutable update artifact, and
   JS/CSS proofs.
7. One fully erased physical card completes the live Production Setup route and
   [`new-card-checklist.md`](new-card-checklist.md). Only then may a batch begin.

The unchanged exhaustive `npm run launch:check` runs nightly and on manual
dispatch in `exhaustive.yml`. Its failure is a release incident: investigate it
and keep the next shipment blocked until the exact current `main` revision is
green. It does not retroactively turn a previously proven live revision into a
different deployment or replace the exact-revision gate above.

If Cloudflare credentials are absent, push/CI-triggered deployment intentionally
does not fail the source build, but the workflow summary says **Production
publish: NOT RUN**. That green CI result is not a deployment and cannot satisfy
steps 5–7. A human manual deploy with missing credentials fails loudly.

## Release evidence

- [ ] Reviewed source commit is on `main`; record commit: `____________`.
- [ ] `Tests / gate` passed for that exact main revision; record run: `____________`.
- [ ] Protected signer committed the unchanged factory alias and immutable
      factory image, immutable application image, exact update ticket and P-256
      signature, manifest schema 2 and signature, provenance, regenerated job
      source, content-addressed job, and job index.
- [ ] Signed release commit is current; record commit: `____________`.
- [ ] The most recent nightly/manual `Exhaustive launch check` is green on
      current `main`; if not, this shipment remains blocked.
- [ ] Deploy workflow says the Cloudflare upload ran—not **NOT RUN**.
- [ ] `PROD_CHECK_REQUIRED=1 npm run check:prod` passed after publish, including
      every file in the live Studio build graph.
- [ ] The staged and live `firmware/release-build-graph.json` match exactly and
      every listed factory/app/ticket/signature/manifest/provenance byte matches
      its recorded size and SHA-256.
- [ ] Live `https://led.mandalacodes.com/#screen=production` opens the current
      root Studio and verified `bench-fixture-44` job.

## Native account cutover runbook

Keep `LIGHTWEAVER_NATIVE_AUTH_READY` unset until the bootstrap and acceptance
steps below pass. There is no public signup, email identity, invitation, or
self-service recovery; only the owner creates accounts and resets passwords.
The resource/binding procedure remains in
[`led-mandalacodes-setup.md`](led-mandalacodes-setup.md#private-cloud-project-library).

- [ ] `npm run test:projects` and `npm run test:cloud-bindings` pass from
      `lightweaver/`; the latter applies the migration only to isolated local
      state and proves unauthenticated `401`, `Cache-Control: no-store`, an
      authenticated project round-trip, and worker delete `403`.
- [ ] `npm run build`, `npm run stage:pages`, and `npm run verify:pages` pass;
      `_routes.json` includes `/api/account*` and `/api/library*`, while `/`
      remains a public static Studio route.
- [ ] Preview D1 and private R2 bindings use `PROJECTS_DB` and `PROJECT_BLOBS`;
      production has separate resources with the same binding names.
- [ ] Pages Preview Access is enabled because preview deployment URLs are public
      by default. Its Access application allows only the approved exact-email
      identities, covers hash and branch-alias URLs, and the preview Function
      uses that preview application's audience. Set
      `LIGHTWEAVER_PREVIEW_ACCESS_READY=confirmed` only after signed-out root
      and `/api/library/session` requests are denied.
- [ ] Access protects `led.mandalacodes.com/api/library*` with its exact-email
      owner policy. Keep `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAILS`, and
      preview Access readiness configured while native readiness is unconfirmed.
- [ ] Run the deploy once with native readiness unconfirmed. Confirm the workflow
      applies migrations `0002` and `0003` before publishing the dual-auth code,
      and its live proof still sees the Access denial.
- [ ] While signed in through the existing Access owner session, open Studio's
      Library panel and use **Create owner account**. Do not put a temporary or
      permanent password in a command, log, issue, screenshot, or CI variable.
- [ ] Sign in with that native owner, change the temporary password, sign out,
      and sign back in. Create one worker and one customer through the Accounts
      panel; there is no signup or email flow.
- [ ] Before cutover, prove owner account/reset/delete powers, worker
      create/edit/history with permanent delete denied, and customer assignment
      isolation, draft save, owner promotion, logout denial, and master backup.
- [ ] Before removing Access, store a master backup outside browser storage and
      Cloudflare.
- [ ] The production workflow used `CLOUDFLARE_MIGRATION_API_TOKEN` for the
      additive migration before the Pages deploy; the Pages credential has no
      D1 administrative permission.
- [ ] Only after all native checks pass, remove the Cloudflare Access path
      protection, set the GitHub variable
      `LIGHTWEAVER_NATIVE_AUTH_READY=confirmed`, and rerun the same deployment.
      The Access audience/team/owner settings are no longer required in this
      phase; D1/R2 resource IDs, names, limits, and library readiness remain
      mandatory.
- [ ] In a signed-out browser, verify `/` is HTTP 200 and both
      `/api/account/session` and `/api/library/session` are HTTP 401 with
      `Cache-Control: no-store`—never an Access 302. Confirm login failures stay
      generic, then repeat the owner, worker, and customer checks.
- [ ] Rollback order: restore the Access application/policy, unset or reset
      `LIGHTWEAVER_NATIVE_AUTH_READY`, then deploy the prior compatible Pages
      release. Do not reverse `0002`/`0003`; their additive D1 schema remains.

Do not use a Pages rollback as a database rollback. Expanded D1 schema and
private R2 revisions remain in place; roll back only to code compatible with
that schema, or follow the explicit backup/Time Travel incident procedure.

The manifest `buildId` and provenance source revision must identify the exact
source compiled by the protected workflow. Do not copy a local binary over the
signed artifact, lower verification policy, or deploy a source-only firmware
commit.

## Canonical production fixture

The generator—not a hand-edited artifact—is the source of truth:
`release/job-generators/bench-fixture-44.mjs`.

- Data: GPIO 18
- Pixels: 44
- Color order: GRB
- Startup look: Aurora
- Maximum current: 1500 mA
- Brightness limit: 0.35

`npm run test:production-jobs` proves those values agree across the generated
source, public index, and indexed immutable job. A GPIO 16 bench job is a
release blocker for this fixture.

## Live erased-card acceptance

Use desktop Chrome or Edge, one USB data cable, the powered GPIO 18 fixture,
and the production URL. Start with a full chip erase. Do not use a preview
deployment, developer tools, a local server, a terminal, or a typed local IP.

- [ ] The exact USB-derived card ID is retained for the whole run. For USB MAC
      `44:1B:F6:81:FE:B0`, the only valid firmware/LAN ID is
      `lw-b0fe81f61b44`.
- [ ] The live site flashes only the verified signed factory release.
- [ ] USB release/reset finishes and the action becomes usable again; a disabled
      **Releasing USB…** state is not completion.
- [ ] The blank card produces the eight-pixel/two-pulse amber factory beacon.
- [ ] Studio calls the reachable card **Blank — load a project**, never green.
- [ ] The worker joins `Lightweaver-XXXX` and returns to the same Studio tab.
- [ ] The automatic card-page bridge follows the exact boot/generation from AP
      to verified LAN address; two fresh status envelopes advance the flow.
- [ ] The project is sent once and independent read-back proves GPIO 18, 44,
      GRB, Aurora, 1500 mA, and brightness limit 0.35.
- [ ] Every blue/red/dark boundary is physically observed on the real strip.
- [ ] The final Aurora check visibly animates all 44 pixels.
- [ ] A power cycle demotes stale Studio authority, restores local playback,
      and requires two status envelopes from the new boot.
- [ ] During a network outage, playback continues, Studio demotes the card, the
      recovery AP appears by 60 seconds, and LAN reconnection happens
      automatically when the network returns.
- [ ] Both JSON and CSV production records are exported outside browser storage.

Repeat this acceptance after any change to firmware, card transport,
commissioning, production jobs, deployment staging/freshness, or physical
fixture wiring.

## Per-card production

Once the release acceptance above passes, run
[`new-card-checklist.md`](new-card-checklist.md) from top to bottom for each card.
Disconnect the finished card before selecting the next USB device. A failed or
ambiguous check quarantines that card; it does not authorize a manual shortcut.

## Failure truth

| Observation | What it proves | Shipment action |
| --- | --- | --- |
| Flash/write complete | Bytes were verified | Continue; not alive yet |
| Exact USB ID `lw-b0fe81f61b44` | USB byte-order mapping is correct | Continue; transport and output unproved |
| Disabled **Releasing USB…** | Release/reset is still pending or stuck | Stop; require timeout and same-card recovery |
| `ERR_NAME_NOT_RESOLVED` for `lightweaver.local` | mDNS did not provide a route | Stop; do not infer flash, boot, or handoff success |
| Missing from prior LAN and expected AP | No current network transport was found | Recover/reinspect the exact USB card; never assume success |
| Green board LED | Controller has some power | Continue; strip unproved |
| Eight amber pixels pulse | Factory firmware/beacon path runs | Continue; project unproved |
| Blank status | Exact reachable card has no known-good project | Load once; never show green |
| One station status | One response arrived | Wait for the second fresh response |
| Config/frame acknowledged | Card accepted a request | Require independent read-back / human light check |
| Partial strip or flicker | Output is incorrect | Stop; do not record a pass |
| CI green, publish skipped | Source/test job succeeded | Deploy before acceptance |
| Live build-graph mismatch | Site is stale or partially published | Stop; redeploy coherent artifact |
| Wi-Fi loss but Studio stays green | Truthfulness regression | Stop the release |

## Pattern Lab release acceptance

Pattern Lab is a separate/private Studio workspace, but its delivery paths
touch browser rendering, card streaming, microSD playback, physical wiring,
and firmware capabilities. Complete these gates on the final integrated source
and repeat the signed/live gates after protected CI publishes the release.

Automated source gate:

- [ ] Run the Pattern Lab unit tests, `LWSEQ1` package checks, and
      `tests/pattern-lab-*.spec.ts` browser suite.
- [ ] Run `npm run launch:source` from `lightweaver/` (this now includes the
      mapper contract/build gate), then run `pio test -e native` plus `pio run`
      from `firmware/lightweaver-controller/`.
- [ ] Confirm existing Patterns, Layout, Playlist, Show, Card, installer,
      Production Setup, persistence, migration, and recovery suites still pass.
- [ ] Confirm the protected signer and exact-revision deploy completed; never
      accept a feature-branch binary as current production firmware. Run the
      manual `Exhaustive launch check` when this acceptance is part of a release.

Browser/operator gate:

- [ ] Open `#screen=pattern-lab` on desktop and phone. Confirm the mapped
      artwork and phone control drawer are usable and leaving the route changes
      neither the active project nor connected card.
- [ ] Create and reopen a private ten-minute draft, compare Source/Draft,
      scrub Beginning/Middle/End, and confirm there is no obvious short loop.
- [ ] Analyze a WAV locally and confirm only numeric lanes, settings, and a
      fingerprint enter the recipe—never WAV bytes or an upload.
- [ ] Bake the same canonical recipe/layout/seed/FPS twice and compare the
      `.lwseq` bytes and sidecar hashes. Cancel must leave no partial export.
- [ ] Confirm **Use in Project** reviews the exact addition, never overwrites a
      built-in/existing look, and binds sequence metadata to the downloaded,
      hash-verified controller package.
- [ ] Keep Advanced Graph, Shader Bake, and card Art-Net recording disabled by
      default. Exported xLights/MADRIX/Art-Net physical order must match wiring.

Physical ESP32-S3 gate:

- [ ] On the same installation LAN/card AP, verify Preview on Lights rollback
      after Stop, navigation, delivery failure, and ownership supersession.
- [ ] Compare a representative native recipe with Studio for geometry, seed,
      timing, palette, brightness, and motion. Keep the descriptor's physical
      parity flag unverified until this evidence is recorded.
- [ ] Play a complex baked recipe from microSD for its complete duration and
      verify physical order, clean loop/end behavior, stable FPS, reboot, and
      power-loss recovery.
- [ ] Record RGB order, gamma, white balance, brightness/current limits,
      temperature, networking, SD stability, card/build identity, recipe hash,
      physical-layout hash, and `.lwseq` hash with the installation record.

See [the Pattern Lab operator guide](pattern-lab-user-guide.md) and
[algorithm provenance](pattern-lab-algorithm-provenance.md).

## Kaleidoscope standalone acceptance — 2026-08-01

Automated contract evidence from the integrated source:

| Source pixels / reflection points | Serialized config bytes | 3968-byte limit |
| --- | ---: | --- |
| 400 / 4 | 1012 | Pass |
| 400 / 6 | 1016 | Pass |
| 400 / 8 | 1020 | Pass |
| 453 / 4 | 1012 | Pass |
| 453 / 6 | 1016 | Pass |
| 453 / 8 | 1020 | Pass |

- Firmware build identity: local development build; no signed release ID yet.
- ESP32-S3 build: pass; RAM 198232 / 327680 bytes (60.5%), flash
  1216117 / 6553600 bytes (18.6%).
- Native derivation/sampling; host-rendered `aurora`, `rainbow`, `wave`, and
  native-recipe goldens; strict no-wrap/no-overlap storage rejection before
  candidate writes; exact mapping read-back; legacy omission; fresh-evidence
  capability gates; and streamed/sequence buffer isolation: pass.
- Physical card ID: **not run**.
- Five-minute mapped standalone minimum FPS: **not run** (must be at least 28).
- Physical 400–453-pixel 4/6/8-point calibration, start shift, one-LED nudge,
  reversal, seam, split, inactive gap, second output, disconnected playback,
  and exact reconnect read-back: **not run**.
- Old-firmware standalone-install rejection with transient RGB streaming still
  available: **not run**.

Do not treat the automated results as physical acceptance. Record the exact
card ID, signed firmware build ID, measured minimum FPS, and pass/fail for every
physical case above before shipping a Kaleidoscope installation.

## Current limiter

As of 2026-07-21, the USB byte-order and ESP32-S3 RTC-watchdog restart fixes are
signed, deployed, and exercised by live Studio against the physical card.
Esptool MAC `44:1B:F6:81:FE:B0` produced `lw-b0fe81f61b44`; the exact signed
release flashed; USB released; and Production Setup reached the setup-network
handoff without the former ROM-downloader dead end. The strict live verifier
also proved the signed image and all 51 Studio build-graph files. After the full
erase, the old station route disappeared and the card page targeted
`192.168.4.1`, as expected before joining the factory AP. The AP join, project
load, patterns, visible strip, power-cycle, and Wi-Fi recovery checks are still
open, so Lightweaver is **not ready to ship** yet.

## Deferred lanes

WLED Basic, Raspberry Pi hosting, Madrix/Art-Net gallery commissioning, and OTA
are separate future/runtime lanes. Their notes remain in the dedicated docs;
they do not belong in or satisfy this ESP32-S3 card-production gate.
