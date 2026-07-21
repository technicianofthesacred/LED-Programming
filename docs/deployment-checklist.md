# Lightweaver deployment and shipment gate

This is the source of truth for the current ESP32-S3-only product. Studio is
published at `https://led.mandalacodes.com`; the card runs patterns and accepts
commands locally. There is no Raspberry Pi in the shipping runtime.

Never substitute a local build, direct HTTP request, terminal command, green
board LED, API acknowledgement, or mocked browser test for the live erased-card
acceptance below.

## How a release reaches production

The release is deliberately split so feature branches never receive signing
keys:

1. Merge reviewed source to protected `main`.
2. The always-on Tests workflow runs `npm run launch:source`. It verifies
   source contracts, Production Setup, production-job consistency, the Studio
   build, staged Pages artifact, and build graph. Firmware source changes are
   expected to make the signed-binary freshness gate red at this point.
3. The protected `build-firmware.yml` workflow compiles the merged ESP32-S3
   factory image, creates and signs its manifest/provenance, regenerates every
   production job against that exact release, and commits the complete release
   set to `main`. Generator, job-source, schema, and job-builder changes trigger
   this workflow even when firmware C++ is unchanged. Generated artifact-only
   commits do not re-trigger it.
4. On the protected release commit, `npm run launch:check` must pass. It repeats
   the source gate and proves the committed signed factory binary is fresh.
5. `deploy-site.yml` builds and publishes the root Studio to the `lightweaver`
   Cloudflare Pages production branch. On HTTPS, Studio automatically uses the
   card-page bridge for local commands; workers never install or operate a
   separate Bridge product.
6. The deploy runs `PROD_CHECK_REQUIRED=1 npm run check:prod`. The live check
   verifies the signed release, production-job index/artifacts, cache policy,
   root Studio, and the published build graph plus every reachable JS/CSS asset.
7. One fully erased physical card completes the live Production Setup route and
   [`new-card-checklist.md`](new-card-checklist.md). Only then may a batch begin.

If Cloudflare credentials are absent, push/CI-triggered deployment intentionally
does not fail the source build, but the workflow summary says **Production
publish: NOT RUN**. That green CI result is not a deployment and cannot satisfy
steps 5–7. A human manual deploy with missing credentials fails loudly.

## Release evidence

- [ ] Reviewed source commit is on `main`; record commit: `____________`.
- [ ] `npm run launch:source` passed for that source.
- [ ] Protected signer committed the image, manifest, signature, provenance,
      regenerated job source, content-addressed job, and job index.
- [ ] Signed release commit is current; record commit: `____________`.
- [ ] `npm run launch:check` passed on the signed release commit.
- [ ] Deploy workflow says the Cloudflare upload ran—not **NOT RUN**.
- [ ] `PROD_CHECK_REQUIRED=1 npm run check:prod` passed after publish, including
      every file in the live Studio build graph.
- [ ] Live `https://led.mandalacodes.com/#screen=production` opens the current
      root Studio and verified `bench-fixture-44` job.

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
- [ ] Run `npm run launch:source` from `lightweaver/` and `pio test -e native`
      plus `pio run` from `firmware/lightweaver-controller/`.
- [ ] Confirm existing Patterns, Layout, Playlist, Show, Card, installer,
      Production Setup, persistence, migration, and recovery suites still pass.
- [ ] On the protected signed release commit, run `npm run launch:check`; never
      accept a feature-branch binary as current production firmware.

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
