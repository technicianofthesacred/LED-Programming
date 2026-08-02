# Lightweaver Shipping and Studio Freshness Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the two audited missing Studio changes, give every production Studio bundle a deterministic live-verifiable identity, refresh stale open tabs safely, and make “ship it to main” mean verified live production.

**Architecture:** Vite resolves one Git revision, embeds it in the bundle, and emits canonical `/studio-release.json` bytes. A strict shared parser, build graph, staging checks, and production checker prove the marker and every deployed Studio file. A pure freshness monitor drives a compact React status-bar beacon and reloads only after autosave and after the existing installer plus a new aggregate destructive-card-operation guard are inactive.

**Tech Stack:** React 18, Vite 6, Node.js test runner, Playwright, Cloudflare Pages/Wrangler, GitHub Actions, Git/GitHub CLI.

---

## File map

- Create `lightweaver/src/lib/studioRelease.js`: strict marker schema, canonical serialization, and embedded-release normalization.
- Create `lightweaver/scripts/studio-release-identity.mjs`: deterministic Git revision resolution for Vite and tests.
- Modify `lightweaver/vite.config.js`: embed the release object and emit `studio-release.json` in the same build.
- Create `lightweaver/src/lib/studioRelease.test.js`: marker parsing, canonical bytes, and build-ID derivation coverage.
- Create `lightweaver/scripts/studio-release-identity.test.mjs`: revision precedence and deterministic identity coverage.
- Modify `lightweaver/scripts/generate-studio-build-graph.mjs` and its test: include the marker in the exact artifact graph.
- Modify `lightweaver/src/lib/productionDeploymentCheck.js` and its test: resolve, parse, and verify the live marker and its no-store policy.
- Modify `lightweaver/scripts/check-prod-freshness.mjs`: compare the staged and live marker and report exact release identity.
- Modify `lightweaver/public/_headers` and `lightweaver/tests/pages-staging.mjs`: enforce staged marker presence and no-store delivery.
- Create `lightweaver/src/lib/studioFreshness.js` and `studioFreshness.test.js`: polling, validation, state, autosave, deferral, and loop prevention.
- Create `lightweaver/src/lib/studioHardwareOperation.js` and test: reference-counted destructive-operation event guard.
- Modify `lightweaver/src/v3/app.jsx` and `lightweaver/src/v3/v3-styles.css`: mount the monitor and far-right beacon.
- Modify `lightweaver/src/components/layout/shared/CardPushControl.jsx` and `lightweaver/src/v3/lw-production.jsx`: mark destructive card operations.
- Modify `lightweaver/tests/screen-smoke.spec.ts`, `card-workspace.spec.ts`, and `production-setup.spec.ts`: UI, reload deferral, and operation-signal coverage.
- Merge the four-file card-takeover commit and selectively cherry-pick the twelve-file Wire hover functional commit; adapt current `StripColorOrderCheck.jsx`.
- Modify root `AGENTS.md` and `docs/deployment-checklist.md`: durable shipment vocabulary and mandatory final proof.

### Task 1: Recover the audited missing branch changes

**Files:**
- Modify: `lightweaver/src/components/card/CardConnectionCenter.jsx`
- Modify: `lightweaver/src/lib/cardBridge.js`
- Modify: `lightweaver/tests/card-bridge-handoff.mjs`
- Modify: `lightweaver/tests/screen-smoke.spec.ts`
- Modify: `lightweaver/src/components/layout/modes/WireModePanel.jsx`
- Modify: `lightweaver/src/components/layout/shared/CardPushControl.jsx`
- Create: `lightweaver/src/components/layout/shared/WireHoverDescription.jsx`
- Modify: `lightweaver/src/components/layout/wire/StripColorOrderCheck.jsx`
- Modify: `lightweaver/src/components/layout/wire/WireDiscovery.jsx`
- Modify: `lightweaver/src/components/layout/wire/WiringAssemblyMap.jsx`
- Modify: `lightweaver/src/components/layout/wire/WiringBenchTest.jsx`
- Modify: `lightweaver/src/components/layout/wire/WiringOutputLane.jsx`
- Modify: `lightweaver/src/components/layout/wire/WiringRunRow.jsx`
- Create: `lightweaver/src/lib/wireButtonDescriptions.test.js`
- Modify: `lightweaver/src/styles/lw-wire.css`
- Modify: `lightweaver/tests/wiring-workspace.spec.ts`

- [ ] **Step 1: Prove the takeover commit is the only unique card-branch commit and merge it with ancestry**

Run:

```bash
git rev-list --reverse --oneline origin/main..origin/codex/card-connection-takeover
git merge --no-ff origin/codex/card-connection-takeover -m "Merge card connection takeover recovery"
```

Expected: the rev-list contains only `93d66c5`, and the merge is clean with the four audited files changed.

- [ ] **Step 2: Run the recovered takeover tests**

Run:

```bash
cd lightweaver
node tests/card-bridge-handoff.mjs
npx playwright test tests/screen-smoke.spec.ts --project=chromium --workers=1
```

Expected: both commands pass and the stale-host browser case exposes **Take over connection**.

- [ ] **Step 3: Cherry-pick only the Wire functional commit**

Run:

```bash
git cherry-pick 90e465fba34cc69b558e818ec26be4db7eb97d5a
```

Expected: only the functional commit lands; `e04eeb1`, `51a54ce`, and `a9f28a0` are absent from the integration ancestry.

- [ ] **Step 4: Run the static test and observe RED on the four newer quick controls**

Run:

```bash
cd lightweaver
node --test src/lib/wireButtonDescriptions.test.js
```

Expected: FAIL identifies the quick `Try next order`, `Red is correct`, `Try other match`, and `Green is correct` buttons as missing matching `title` and `data-tooltip` attributes.

- [ ] **Step 5: Add matching descriptions to the four quick controls**

Use these exact paired values in `StripColorOrderCheck.jsx`:

```jsx
title="Apply the next color-order option and retest red on the real LEDs."
data-tooltip="Apply the next color-order option and retest red on the real LEDs."

title="Accept the visible red position and continue by testing green."
data-tooltip="Accept the visible red position and continue by testing green."

title="Try the other color order with this red position and retest green."
data-tooltip="Try the other color order with this red position and retest green."

title="Confirm the current color order after the green check."
data-tooltip="Confirm the current color order after the green check."
```

- [ ] **Step 6: Verify Wire static and portal behavior and commit the adaptation**

Run:

```bash
cd lightweaver
node --test src/lib/wireButtonDescriptions.test.js
npx playwright test tests/wiring-workspace.spec.ts --project=chromium --workers=1
git add src/components/layout/wire/StripColorOrderCheck.jsx
git commit -m "fix(studio): complete Wire hover descriptions"
```

Expected: static and Playwright suites pass; only the adaptation commit is new because the recovered functional commit already owns the other files.

### Task 2: Add deterministic Studio release identity

**Files:**
- Create: `lightweaver/src/lib/studioRelease.js`
- Create: `lightweaver/src/lib/studioRelease.test.js`
- Create: `lightweaver/scripts/studio-release-identity.mjs`
- Create: `lightweaver/scripts/studio-release-identity.test.mjs`
- Modify: `lightweaver/vite.config.js`
- Modify: `lightweaver/package.json`

- [ ] **Step 1: Write strict marker tests**

The tests must require this API and behavior:

```js
import {
  parseStudioRelease,
  serializeStudioRelease,
  studioReleaseFromRevision,
} from './studioRelease.js';

const revision = 'a'.repeat(40);
assert.deepEqual(studioReleaseFromRevision(revision), {
  schemaVersion: 1,
  sourceRevision: revision,
  buildId: 'a'.repeat(12),
});
assert.equal(
  serializeStudioRelease(studioReleaseFromRevision(revision)),
  `${JSON.stringify({ schemaVersion: 1, sourceRevision: revision, buildId: 'a'.repeat(12) }, null, 2)}\n`,
);
assert.throws(() => parseStudioRelease('{"schemaVersion":1}'), /exactly/);
assert.throws(() => parseStudioRelease(JSON.stringify({
  schemaVersion: 1,
  sourceRevision: revision,
  buildId: 'b'.repeat(12),
})), /first 12/);
```

The script test must inject environment and a fake Git resolver and prove precedence `LIGHTWEAVER_SOURCE_REVISION` → `GITHUB_SHA` → Git `HEAD`, malformed rejection, and identical output for the same revision.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
cd lightweaver
node --test src/lib/studioRelease.test.js scripts/studio-release-identity.test.mjs
```

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement the strict shared schema and deterministic resolver**

`studioRelease.js` must export the three tested functions. `studio-release-identity.mjs` must export:

```js
export function resolveStudioSourceRevision({ env = process.env, readGitHead = defaultReadGitHead } = {})
export function resolveStudioReleaseIdentity(options = {})
```

Use `execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' })`; never execute a shell or accept timestamps.

- [ ] **Step 4: Verify GREEN**

Run the same Node test command.

Expected: all release-identity tests pass with no warnings.

- [ ] **Step 5: Write a build test that requires one shared bundle/marker identity**

Extend the identity script test or create a Vite-config test that builds with
`LIGHTWEAVER_SOURCE_REVISION=b...b`, reads `dist/studio-release.json`, and
asserts the exact canonical bytes and presence of the 40-character revision in
the generated JavaScript asset.

- [ ] **Step 6: Run the build test and verify RED**

Expected: FAIL because Vite does not yet emit or embed the identity.

- [ ] **Step 7: Add the Vite release plugin and define**

At config evaluation, resolve one identity and add:

```js
define: {
  __LIGHTWEAVER_STUDIO_RELEASE__: JSON.stringify(studioRelease),
},
```

The plugin's `generateBundle()` emits:

```js
this.emitFile({
  type: 'asset',
  fileName: 'studio-release.json',
  source: serializeStudioRelease(studioRelease),
});
```

Add `test:studio-release` to `lightweaver/package.json` and include it in `launch:source` before the build.

- [ ] **Step 8: Verify identity tests and build, then commit**

Run:

```bash
cd lightweaver
npm run test:studio-release
LIGHTWEAVER_SOURCE_REVISION=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb npm run build
git add src/lib/studioRelease.js src/lib/studioRelease.test.js scripts/studio-release-identity.mjs scripts/studio-release-identity.test.mjs vite.config.js package.json package-lock.json
git commit -m "feat(studio): embed deterministic release identity"
```

Expected: tests and build pass; `dist/studio-release.json` contains build ID `bbbbbbbbbbbb` and the full revision.

### Task 3: Put the marker inside staging and production proof

**Files:**
- Modify: `lightweaver/scripts/generate-studio-build-graph.mjs`
- Modify: `lightweaver/scripts/generate-studio-build-graph.test.mjs`
- Modify: `lightweaver/src/lib/productionDeploymentCheck.js`
- Modify: `lightweaver/src/lib/productionDeploymentCheck.test.js`
- Modify: `lightweaver/scripts/check-prod-freshness.mjs`
- Modify: `lightweaver/public/_headers`
- Modify: `lightweaver/tests/pages-staging.mjs`

- [ ] **Step 1: Write failing build-graph and production-marker tests**

Add `studio-release.json` to the generator fixture and require the sorted graph
to contain it. Extend `resolveProductionUrls()` expectation with
`studioReleaseUrl`. Add tests for a helper with this interface:

```js
await verifyStudioRelease(fetchImpl, 'https://example.test/studio-release.json', expectedRelease)
```

It must accept exact valid JSON with HTTP 200 and `Cache-Control: no-store`, and
reject redirects, cacheable responses, invalid schemas, and revision mismatch.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd lightweaver
node --test scripts/generate-studio-build-graph.test.mjs src/lib/productionDeploymentCheck.test.js
```

Expected: FAIL because the graph rejects the marker and the verifier/URL do not exist.

- [ ] **Step 3: Implement graph and production verification**

Allow only `studio-release.json` in addition to current index/asset paths. Have
the generator explicitly require that file. `verifyStudioRelease` must parse
with `parseStudioRelease`, use no-store/manual redirect fetch options, validate
the response header, and compare the canonical identities.

- [ ] **Step 4: Verify GREEN**

Run the same focused Node command.

Expected: all tests pass.

- [ ] **Step 5: Write staging/header assertions and verify RED**

Require:

```text
/studio-release.json
  Cache-Control: no-store
```

Require `.pages/lightweaver/studio-release.json`, strict parsing of it, graph
membership, and `check-prod-freshness.mjs` use of `verifyStudioRelease`.

Run:

```bash
cd lightweaver
node tests/pages-headers.mjs
npm run build && npm run stage:pages && npm run verify:pages
```

Expected: the header/staging command fails before implementation.

- [ ] **Step 6: Add header, staging, and production-checker integration**

Load the expected staged marker beside the expected graph, verify the live
marker before exact graph bytes, and include the marker revision/build ID/URL
in the successful `check-prod-freshness` summary.

- [ ] **Step 7: Verify and commit**

Run:

```bash
cd lightweaver
npm run test:build-graph
npm run test:prod-deploy
node tests/pages-headers.mjs
npm run build && npm run stage:pages && npm run verify:pages
git add scripts/generate-studio-build-graph.mjs scripts/generate-studio-build-graph.test.mjs src/lib/productionDeploymentCheck.js src/lib/productionDeploymentCheck.test.js scripts/check-prod-freshness.mjs public/_headers tests/pages-staging.mjs
git commit -m "feat(deploy): verify exact Studio release marker"
```

Expected: focused unit, headers, build, staging, and artifact verification pass.

### Task 4: Implement the safe freshness monitor

**Files:**
- Create: `lightweaver/src/lib/studioFreshness.js`
- Create: `lightweaver/src/lib/studioFreshness.test.js`
- Create: `lightweaver/src/lib/studioHardwareOperation.js`
- Create: `lightweaver/src/lib/studioHardwareOperation.test.js`

- [ ] **Step 1: Write monitor tests against a wished-for controller API**

Use this public interface:

```js
const monitor = createStudioFreshnessMonitor({
  release,
  fetchImpl,
  flushAutosave,
  reload,
  storage,
  locationOrigin,
  navigatorRef,
  documentRef,
  windowRef,
  timers,
});
monitor.subscribe(state => states.push(state));
monitor.start();
monitor.setOperationActive(true);
await monitor.checkNow();
monitor.setOperationActive(false);
monitor.stop();
```

Separate tests prove initial check, current state, five-second timeout, 30-second
visible scheduling, hidden pause, focus/visibility/online triggers, offline
**Freshness unknown** state, one in-flight request, strict marker/no-store rejection,
autosave-before-reload, autosave failure, protected-operation deferral,
immediate clear reload, same-pair loop prevention, matching-build record clear,
and storage failure refusal.

- [ ] **Step 2: Write hardware-operation guard tests**

Require:

```js
const finishA = beginStudioHardwareOperation('install-project', windowRef);
const finishB = beginStudioHardwareOperation('production-recovery', windowRef);
finishA(); // aggregate active remains true
finishB(); // aggregate active becomes false
```

Duplicate finish calls must be harmless, and `withStudioHardwareOperation()`
must clear the signal in `finally` on rejection.

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
cd lightweaver
node --test src/lib/studioFreshness.test.js src/lib/studioHardwareOperation.test.js
```

Expected: FAIL because the modules are missing.

- [ ] **Step 4: Implement the minimal controller and guard**

Use constants `STUDIO_RELEASE_PATH = '/studio-release.json'`,
`STUDIO_FRESHNESS_POLL_MS = 30_000`,
`STUDIO_FRESHNESS_TIMEOUT_MS = 5_000`, and
`STUDIO_REFRESH_ATTEMPT_KEY = 'lw_studio_refresh_attempt_v1'`.
Never include response bodies or unbounded exceptions in state. The monitor
returns immutable state shaped as `{ status, buildId, reason }`.

- [ ] **Step 5: Verify GREEN and commit**

Run the same Node test command, then:

```bash
git add lightweaver/src/lib/studioFreshness.js lightweaver/src/lib/studioFreshness.test.js lightweaver/src/lib/studioHardwareOperation.js lightweaver/src/lib/studioHardwareOperation.test.js
git commit -m "feat(studio): add safe freshness monitor"
```

Expected: all monitor/guard tests pass with no leaked timers or listeners.

### Task 5: Mount the beacon and protect destructive operations

**Files:**
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/v3/v3-styles.css`
- Modify: `lightweaver/src/components/layout/shared/CardPushControl.jsx`
- Modify: `lightweaver/src/v3/lw-production.jsx`
- Modify: `lightweaver/tests/screen-smoke.spec.ts`
- Modify: `lightweaver/tests/card-workspace.spec.ts`
- Modify: `lightweaver/tests/production-setup.spec.ts`

- [ ] **Step 1: Write failing browser tests for the beacon and deferred reload**

Intercept `/studio-release.json` with valid no-store responses. Require the
footer's last child to say `Studio current · <buildId>`. Then return a different
revision and stub `window.__LW_STUDIO_RELOAD_FOR_TEST__` so the test can assert
autosave exists before the reload callback. Dispatch `lw-install-active` and
`lw-hardware-operation-active`; require `Update ready`, no reload while either
is active, and immediate reload after both are false. Add invalid/cacheable and
phone-width visibility cases.

- [ ] **Step 2: Run the focused browser test and verify RED**

Run:

```bash
cd lightweaver
npx playwright test tests/screen-smoke.spec.ts --project=chromium --workers=1
```

Expected: FAIL because no freshness beacon/monitor is mounted.

- [ ] **Step 3: Mount the controller in `Shell` and render the beacon at far right**

`StatusBar` receives `freshness` and renders after `.sb-spring`:

```jsx
<div className={`sb-freshness is-${freshness.status}`} data-testid="studio-freshness" role="status" title={freshness.title}>
  <span className="sb-dot" aria-hidden="true" />
  <span>{freshness.label}</span>
  <code>{freshness.buildId}</code>
</div>
```

Shell supplies `flushProjectAutosave`, observes both active-operation events,
and uses `window.__LW_STUDIO_RELOAD_FOR_TEST__ || (() => window.location.reload())`.

- [ ] **Step 4: Verify beacon browser tests GREEN**

Run the focused `screen-smoke.spec.ts` command again.

Expected: all tests pass at desktop and phone widths.

- [ ] **Step 5: Write failing operation-owner tests**

Extend card workspace and production test drivers to observe
`lw-hardware-operation-active`. Require install-to-card, production firmware
install/release, artwork restore/config write, and destructive recovery to emit
active then inactive, including failure. Require read-only inspection not to
emit the signal.

- [ ] **Step 6: Run those tests and verify RED**

Run:

```bash
cd lightweaver
npx playwright test tests/card-workspace.spec.ts tests/production-setup.spec.ts --project=chromium --workers=1
```

Expected: FAIL because the operation owners do not emit the aggregate signal.

- [ ] **Step 7: Wrap exact destructive async boundaries**

Use `withStudioHardwareOperation('install-project', () => ...)` around
`CardPushControl.pushToCard`. In `ProductionScreen`, wrap `installOrContinue`,
`restoreArtwork`, card-mutating recovery actions, and USB release/reset paths
that can leave an owned card mid-transition. Keep `connectCard`, pure status,
and read-only preflight unwrapped.

- [ ] **Step 8: Verify browser coverage and commit**

Run:

```bash
cd lightweaver
npx playwright test tests/screen-smoke.spec.ts tests/card-workspace.spec.ts tests/production-setup.spec.ts --project=chromium --workers=1
git add src/v3/app.jsx src/v3/v3-styles.css src/components/layout/shared/CardPushControl.jsx src/v3/lw-production.jsx tests/screen-smoke.spec.ts tests/card-workspace.spec.ts tests/production-setup.spec.ts
git commit -m "feat(studio): refresh safely to current production"
```

Expected: beacon, deferral, autosave, operation-owner, takeover, and responsive tests pass.

### Task 6: Make shipment vocabulary durable

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/deployment-checklist.md`
- Modify: `lightweaver/tests/pages-staging.mjs`

- [ ] **Step 1: Add failing static contract assertions**

In `pages-staging.mjs`, read root `AGENTS.md` and require all six terms,
`ship it to main`, `Production publish: NOT RUN`, `studio-release.json`, and an
independent final live proof in both the agent contract and checklist.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
cd lightweaver
node tests/pages-staging.mjs
```

Expected: FAIL on the missing durable shipment language.

- [ ] **Step 3: Add the exact vocabulary and evidence fields**

Add committed, pushed, PR-ready, merged, deployed, and shipped definitions to
both documents. Add checklist fields for final `origin/main` commit, signer
commit when applicable, Studio full revision, 12-character build ID,
credentialed deploy run, marker URL, exact verified file count, and independent
live checker result. Retain the separate physical batch gate.

- [ ] **Step 4: Verify and commit**

Run:

```bash
cd lightweaver
node tests/pages-staging.mjs
git add ../AGENTS.md ../docs/deployment-checklist.md tests/pages-staging.mjs
git commit -m "docs: make Lightweaver shipment proof explicit"
```

Expected: the static deployment contract passes.

### Task 7: Integrate, verify, and ship

**Files:** all files above; no deferred Pi paths.

- [ ] **Step 1: Run focused verification from a clean tree**

Run:

```bash
cd lightweaver
npm run test:studio-release
npm run test:build-graph
npm run test:prod-deploy
node --test src/lib/studioFreshness.test.js src/lib/studioHardwareOperation.test.js src/lib/wireButtonDescriptions.test.js
node tests/card-bridge-handoff.mjs
npx playwright test tests/screen-smoke.spec.ts tests/wiring-workspace.spec.ts tests/card-workspace.spec.ts tests/production-setup.spec.ts --project=chromium --workers=1
npm run build && npm run stage:pages && npm run verify:pages
```

Expected: all focused tests, browser flows, build, staging, and exact artifact checks pass.

- [ ] **Step 2: Run the full relevant launch gate once**

Run:

```bash
cd lightweaver
npm run launch:source
```

Expected: exit 0 across source, account/library, mapper, production, Playwright, build, staging, and artifact verification.

- [ ] **Step 3: Review scope and ancestry**

Run:

```bash
git status --short
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
git log --oneline --decorate origin/main..HEAD
git merge-base --is-ancestor 93d66c5 HEAD
git merge-base --is-ancestor 90e465f HEAD
git merge-base --is-ancestor e04eeb1 HEAD && exit 1 || true
git diff --name-only origin/main...HEAD | rg '^(lightweaver/server/|visitor-ui/|docs/pi-hosted-deployment\.md)$' && exit 1 || true
```

Expected: clean tree, no whitespace errors, both functional commits present,
obsolete Wire plans absent, and no deferred Pi path changed.

- [ ] **Step 4: Publish and merge through GitHub**

Use the GitHub publish workflow: push `codex/shipping-freshness-recovery`, open
one integration PR to `main`, wait for required checks, and merge it. Record the
merge commit now at `origin/main`. If PR #51 remains open after its commit is
reachable from `main`, close it with a truthful comment referencing the merged
integration PR.

- [ ] **Step 5: Wait for the real deployment boundary**

Inspect GitHub Actions through `gh`. If `build-firmware.yml` runs, wait for its
signed release commit and the deploy dispatch it triggers. Wait for
`deploy-site.yml` and require the upload step plus required post-publish
freshness check to succeed. A summary containing **Production publish: NOT
RUN** or credential skip leaves status **not shipped**.

- [ ] **Step 6: Independently verify final live production**

Create a temporary detached worktree at the final `origin/main`, install linked
dependencies, then run:

```bash
cd lightweaver
npm run build
npm run stage:pages
PROD_CHECK_REQUIRED=1 npm run check:prod
curl --fail --silent --show-error \
  -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
  -D /tmp/lightweaver-release-headers \
  https://led.mandalacodes.com/studio-release.json
```

Expected: checker exit 0, live marker HTTP 200 with `Cache-Control: no-store`,
marker bytes equal the staged marker, and full revision equals the exact final
deployed `origin/main` revision.

- [ ] **Step 7: Clean obsolete remote branches only after live proof**

Run:

```bash
git push origin --delete codex/cloud-project-library codex/cloud-library-sign-in codex/pattern-color-order-popover
git fetch --prune origin
```

Expected: all three obsolete remotes are absent; no cleanup ran before live proof.

- [ ] **Step 8: Report the exact shipment result**

Report **shipped** only with the integration PR, final `origin/main` revision,
credentialed deploy run, live marker revision/build ID, exact verified file
count, production checker result, PR #51 disposition, and deleted branch names.
Otherwise report **not shipped** and the last proven boundary.
