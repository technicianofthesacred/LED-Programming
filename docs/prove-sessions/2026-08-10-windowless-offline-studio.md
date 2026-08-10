# Lightweaver Prove session — 2026-08-10

## Run status

- Outcome: `INCOMPLETE`
- Authorized by: `Prove Lightweaver`
- Started at (UTC): `2026-08-10T00:05:13Z`
- Closed at (UTC): `2026-08-10T00:30:38Z`
- Expected duration stated: `At least 20 minutes; longer if hardware observation is required.`
- Development freeze active: `yes, through close`

The frozen release is live and its deployed bytes are internally consistent, but
it is not proven. The unchanged exhaustive gate is red, two additional Pattern
Lab browser contracts fail deterministically, and the connected card is not
running the frozen firmware. No code was changed, no deployment was performed,
and no card was flashed during this run.

## Frozen target

- Source revision: `ce1b9b3a5fd39cdfbcecd400bae74fd4d75e1cdd`
- Studio build: `1224`
- Firmware build: `1223` (`v1.1.3`, source `c80ba832eebe0b681112753b32d24001d01bf56f`)
- Production URL: `https://led.mandalacodes.com`
- Deployment/workflow run: `31341895143` (credentialed exact-revision deploy, success)
- Card target: bench card `lw-b0fe81f61b44`. The canonical frozen job says GPIO 18, 44 pixels, GRB, WS2815, Aurora, 1500 mA, brightness limit 0.35. Prior fixture evidence says 41 pixels and RGB, so physical verification cannot safely infer the fixture.

## Automated gates

| Gate | Command or method | Target | Started (UTC) | Result | Evidence / notes |
| --- | --- | --- | --- | --- | --- |
| Release gate | `node scripts/lightweaver-dev.mjs release` in a clean detached worktree | `ce1b9b3a5fd39cdfbcecd400bae74fd4d75e1cdd` | `2026-08-10T00:07Z` | `FAIL` | Core, storage, cloud, mapper, production, build-graph, Show, recovery, 1,365 unit assertions, and 68 production browser tests passed. Release UI was 347 pass / 1 fail: the popup test expects “card page” while the product deliberately says “legacy card page.” The gate stopped before its remaining steps. |
| Launch gate | Unchanged exhaustive GitHub workflow run `31343581596` | exact frozen revision | `2026-08-10T00:07:19Z` | `FAIL` | Independently reproduced the same universal-install copy assertion: 347 pass / 1 fail. Run closed at `2026-08-10T00:25:52Z`. First failure is retained. |
| Build and staging after stopped gate | `npm run build`, `stage:pages`, `verify:pages`, `firmware:check-bin` | exact frozen revision | `2026-08-10T00:22Z` | `PASS` | Production build, deterministic service worker, Pages Functions compilation/staging, 57-file build graph, and factory-image freshness passed independently. |
| Browser and persistence | Pattern Lab Chromium matrix plus focused retry | Studio build `1224` | `2026-08-10T00:23Z` | `FAIL` | 55 passed / 2 failed. One test still searches for the removed “Hardware” rail label; the other mock omits the current `appliedPatternId` acknowledgement and reports failed restoration. Both focused retries failed identically. These tests are not in the normal launch gate, exposing a coverage gap. |
| Connection and save/load | Cloud save/load Playwright and repository suites included above | Studio build `1224` / firmware API `1` | `2026-08-10T00:07Z` | `PASS (simulated)` | 69/69 cloud browser tests and 140 project/account/storage tests passed. This is simulated browser proof, not real-card proof. |
| Firmware and contracts | `pio test -e native`; `pio run` | frozen firmware source and bundled Studio | `2026-08-10T00:27Z` | `PASS` | Native 8/8; ESP32-S3 compile/link succeeded. RAM 198,864/327,680 bytes (60.7%); flash 2,017,301/6,553,600 bytes (30.8%). No flash performed. |
| Production dependency audit | `npm audit --omit=dev --json` | frozen lockfiles | `2026-08-10T00:29Z` | `WARN` | Studio: 3 production findings (1 low, 2 moderate: `body-parser`, `express`/`qs`), fixes available. Mapper: 0 production findings. No dependency mutation performed. |

## Live proof

| Proof | URL or method | Expected identity | Observed identity | Time (UTC) | Result | Evidence / notes |
| --- | --- | --- | --- | --- | --- | --- |
| Production deployment | GitHub Actions run `31341895143` | exact signed revision and credentialed publication | Studio 1224 / firmware 1223, publication and freshness steps succeeded | `2026-08-09T23:27:50Z` | `PASS` | Exact signer-triggered deploy; the earlier unsigned deploy correctly deferred. |
| No-store release marker | `https://led.mandalacodes.com/studio-release.json` | Studio build `1224`, revision `ce1b9b3...` | exact build and revision; 141 bytes, SHA-256 `c9907e905fa210bba6492300cbf84f2ca8a04b1f09a6c06bbeea779e6fc9378e` | `2026-08-10T00:07:07Z` | `PASS` | Fresh request was HTTP 200, `Cache-Control: no-store`, Cloudflare cache `DYNAMIC`. |
| Deployed build graph | fresh strict fetch and `PROD_CHECK_REQUIRED=1 npm run check:prod` | terminal `origin/main` | 57/57 files exact; graph SHA-256 `723074b7a672e7e90962d4a8179e0eec7a93081ce6a9f92cd6a67e341b638940` | `2026-08-10T00:08Z` | `PASS` | Live firmware image is 2,082,992 bytes, SHA-256 `91747d9ec13b9f5a0c5c57e90ff074ec7826523aaeeb0c2dc57365a7dfdaefd1`, byte-identical to the signed artifact. P-256 manifest signature verifies against the pinned public key. |
| Critical live paths | Public Studio in actual Chromium | Studio build `1224` | Lightweaver v3 rendered Setup, Layout, Patterns; footer said “Ready offline”; zero console errors | `2026-08-10T00:08:31Z–00:11:55Z` | `PARTIAL` | Read-only live rendering passed. True cold-network offline reload, a mutating edit/save/install, LNA permission allow/deny/revoke, and same-tab card fallback were not performed. |

## Release provenance findings

- The signed manifest, signature, provenance, immutable image, and alias image are
  byte-identical between the frozen commit and production. All 47 embedded Card
  Studio assets match their manifest sizes/hashes; project schema is 3..3 and
  firmware API is 1..1.
- The unprivileged signer verification job built Card Studio with build number
  `1`, despite the intended build number `1223`, because its shallow checkout did
  not supply `LIGHTWEAVER_BUILD_NUMBER`. The protected final build did use 1223
  and the committed/live bytes prove 1223. This is a defense-in-depth gap.
- GitHub reports `main` as unprotected, with no repository ruleset; the firmware
  release environment is limited to `main` but has no reviewer rule. The frozen
  revision remained unchanged during this run, but administrative immutability
  is not enforced.

## Hardware matrix

| Card / boot ID | Build / project fingerprint | GPIO / pixels / chipset / order | Power and wiring | Machine evidence | Human observation | Result |
| --- | --- | --- | --- | --- | --- | --- |
| `lw-b0fe81f61b44` / `boot-0bb7a7d8-b0fe81f61b44` | Actual firmware 1.1.1 build 1198; project rev 0, fingerprint empty | Prior fixture: GPIO 18 / 41 / WS2815 / RGB. Frozen job: GPIO 18 / 44 / WS2815 / GRB | Not inferred because fixture records disagree | Reachable at `192.168.18.70` and `/dev/cu.usbmodem142201`; station Wi-Fi configured; AP inactive; factory phase; config, known-good project, command, playback, and output readiness all false | Not requested because the frozen target is already red and is not installed on the card | `BLOCKED / NOT RUN` |

The workboard's earlier “Setup AP” state was stale: Wi-Fi has recovered, but the
card is blank and remains on build 1198. No mutation, power cycle, or flash was
performed. Direct LNA, card-local same-tab Studio, Stop/recovery, animation
stability, exact light output, and power-loss-safe storage remain physically
unverified.

## Waivers

| Check waived | Accepted by | Time (UTC) | Reason | Confidence removed |
| --- | --- | --- | --- | --- |
| None | | | | |

## Unresolved risks

| Risk | Evidence gap or failure | Practical consequence | Owner |
| --- | --- | --- | --- |
| Red unchanged exhaustive gate | Deterministic stale popup-copy assertion in both local and GitHub runs | The frozen release cannot satisfy the mandatory release gate | Studio tests |
| Pattern Lab browser contract drift | Stale route label and stale live-preview acknowledgement mock; focused retry remains red | Two important flows are outside the normal launch-gate coverage and are not green | Studio tests |
| Signer verification identity | Unprivileged verify job built Card Studio as build 1 | A pre-sign verification layer does not prove the final build identity | Release tooling |
| Main governance | No branch protection or ruleset; no firmware environment reviewer | Later authorized direct changes are not administratively blocked | Repository owner |
| Production dependencies | Three non-critical production audit findings in the Studio dependency graph | Known DoS-class advisories remain until a verified dependency update | Studio dependencies |
| Real-card/browser matrix | Frozen firmware is not on the blank card; fixture records disagree; no physical observations were taken | Cannot claim direct LNA, same-tab fallback, visible Stop/recovery, animation stability, exact output, or power-loss safety as physically proven | Adrian + primary |

## Single next step

`Return to Sprint for one release-hardening batch: correct the three deterministic browser-test contract drifts and the signer build-number verification, ship a new immutable target, then restart Prove before any hardware flash.`
