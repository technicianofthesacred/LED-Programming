# Lightweaver development workflow

This workflow keeps ordinary product iteration fast while retaining the strict
release and hardware gates that make a shipped Lightweaver trustworthy. The
mistake to avoid is applying the final release process to every small defect.

## How to ask

You do not need to remember mode names. Describe what you want in ordinary
language and the primary agent chooses the operating mode:

- A list of features or glitches becomes [Sprint](workflows/sprint.md).
- Sitting with the card, strip, colors, wiring, or power becomes
  [Bench](workflows/bench.md).
- “Prove Lightweaver” starts the explicitly authorized long
  [Prove](workflows/prove.md) run. Less explicit “check everything” language
  requires a duration warning and confirmation first.
- “Ship” keeps its release meaning and never silently invokes Prove.

The operating mode controls coordination and human attention. The verification
tiers below still control how much automated evidence runs inside that mode.

## The three loops

### Glitch loop — 3–10 minutes

Use this by default for one reproducible browser, interaction, copy, layout, or
local state defect.

1. Keep one stable Studio process running:

   ```bash
   node scripts/lightweaver-dev.mjs preview
   ```

2. Reproduce the defect on the actual screen. Record the exact route, state, and
   observable failure.
3. Add one focused regression and run only that test. It must fail for the
   expected reason before production code changes.
4. Make the smallest bounded fix and rerun that focused test.
5. Inspect the same screen at `http://127.0.0.1:4173/` and leave any check that
   needs Adrian's eyes on the visual-feedback list.
6. Continue to the next independent glitch. Do not release yet.

Focused browser example:

```bash
node scripts/lightweaver-dev.mjs focused tests/card-control-drawer.spec.ts --grep "rolls back"
```

Focused Node example:

```bash
node --test src/lib/cardCustomerControlState.test.js --test-name-pattern "rolls back"
```

The glitch loop does not bump `VERSION`, rebuild a factory image, sign firmware,
deploy, flash a card, run every browser spec, or run `launch:check`.

### Checkpoint loop — 10–20 minutes

Use this after a coherent group of related fixes, before pushing a substantial
branch, or when shared state/transport code changed. A useful checkpoint is
typically several related defects that can be reviewed together—not an arbitrary
timer or one CSS adjustment.

Run the focused feature suite once, then:

```bash
node scripts/lightweaver-dev.mjs checkpoint
```

This runs the complete library unit set and a production Vite build. Add one
relevant Playwright spec when the batch changes visible behavior. Add firmware
contracts and PlatformIO only when firmware source or the browser/card wire
contract changed.

Escalate from glitch to checkpoint immediately when a change affects a shared
authority boundary, persistence, project replacement, card mutation, firmware
protocol, authentication, or release identity. Do not escalate merely because a
test is inconvenient.

### Release loop

Use this only when Adrian says ship/push to main, or when a release checkpoint is
explicitly being prepared.

```bash
node scripts/lightweaver-dev.mjs release
```

Then use the existing production chain:

1. Push one coherent branch and obtain a green `Tests / gate`.
2. Merge the exact reviewed revision.
3. For firmware-sensitive changes, wait for the protected signer and its new
   signed-artifact commit.
4. Wait for the real Cloudflare deploy, not the short deferred run.
5. Prove `/studio-release.json`, the build graph, and the signed firmware
   manifest against terminal `origin/main`.
6. Report both the Studio build and firmware build.
7. Perform only the hardware checks required by the changed boundary. Never
   mark a visual hardware gate passed without real observation.

The scheduled/manual exhaustive launch workflow remains valuable release
evidence. It is deliberately outside the editing loop.

## Firmware and configured cards

The public release is a full factory image. The factory image erases the card's
Wi-Fi, installed project, patterns, and settings; this is intentional for a new
or explicitly erased installation, but it is not a safe routine update format.

Never flash a configured card with the factory image merely to prove a browser
change. Before any required factory flash, record or export enough information
to reconstruct the card: card identity, Wi-Fi recovery route, project ID,
revision and fingerprint, GPIO outputs, pixel count, chipset, color order,
current limit, and known-good look. If that recovery material is unavailable,
stop before erasing.

Firmware versions are release identifiers, not progress counters. Accumulate
firmware changes, bump the semantic version once at the release boundary, let the
protected signer create the immutable release, and flash that exact signed image
only when hardware proof is necessary.

## Browser discipline

- Use one Vite instance on port 4173. A strict port makes a duplicate process
  fail immediately instead of creating confusing parallel state.
- Browser tests own their configured test server. Stop the interactive preview
  before a suite whose configuration starts the same port.
- Use the actual browser screen for visual proof. Playwright is the regression
  harness, not a substitute for looking at the rendered result.
- Preserve the current route and fixture while iterating so each comparison has
  the same starting state.

## Time and escalation rules

- At 10 minutes on one small glitch, state the root cause or narrow the task.
- At 20 minutes without a working result, stop adding tests/reviews, identify the
  bottleneck, and simplify or split the work.
- Do not add agents for overlapping files or repeated review. Parallel work is
  useful only for independent boundaries with independently testable outputs.
- One integrated review is enough for a coherent batch. A new review cycle is
  justified only by a newly discovered critical boundary.
- Report working behavior, a test result, a live link, or a concrete blocker—not
  process volume.

## What the words mean

- **Build**: implement and verify the requested behavior. A spec or plan is an
  internal implementation aid, never the stopping point.
- **Checkpoint**: a locally verified coherent batch; not deployed.
- **Ship**: complete the PR, merge, signer when applicable, production deploy,
  live build proof, and proportionate hardware proof.

This division makes exploration cheap and shipping strict. Removing release
work from the glitch loop does not weaken production; it concentrates the costly
proof at the boundary where it can actually protect a release.
