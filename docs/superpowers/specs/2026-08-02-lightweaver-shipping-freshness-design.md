# Lightweaver Shipping and Studio Freshness Design

## Goal

Make Lightweaver's delivery state truthful from source through the live Studio,
and make an already-open Studio converge safely to the current production build.
The same integration also recovers the two audited feature commits that are still
absent from `main`, without re-merging branches whose trees already landed.

This design applies to the ESP32-S3-only runtime and the public Studio at
`https://led.mandalacodes.com`. It does not resume or modify the deferred
Raspberry Pi runtime.

## Shipping vocabulary and standing authorization

The repository will use these terms precisely:

- **Committed**: a local commit exists. It may not exist on GitHub.
- **Pushed**: the commit exists on a remote branch. It is not on `main` unless
  the remote branch is `origin/main`.
- **PR-ready**: the branch is pushed, its pull request is reviewable, and its
  required checks pass. It is not merged or deployed.
- **Merged**: the intended source and ancestry are reachable from
  `origin/main`. A merge is not evidence that production changed.
- **Deployed**: the credentialed production workflow actually uploaded the
  staged Pages artifact and completed its required post-publish checks. A green
  workflow that reports **Production publish: NOT RUN** is not deployed.
- **Shipped**: the intended source is merged into `origin/main`, the applicable
  protected signer cascade has completed, a credentialed production deployment
  succeeded, and an independent live check proves that
  `led.mandalacodes.com` serves the exact expected marker, root, JavaScript,
  CSS, firmware release, and production jobs.

For this project, Adrian's instruction **ship it to main** is standing
authorization to complete that entire sequence after the approved design gate:
test, push, open and merge the integration PR, wait for protected workflows,
deploy, and verify live production. A branch, pull request, pushed commit, or
green CI result alone must be reported as **not shipped**, together with the
exact boundary reached.

This is the code-delivery meaning of **shipped**. The erased-card and per-card
physical acceptance gates in `docs/deployment-checklist.md` remain required
before a hardware batch ships; the code-delivery claim does not silently claim
that physical acceptance was performed.

## Deterministic Studio release identity

### Canonical identity

Every production Studio build receives one canonical identity derived from the
exact Git source revision being built:

```json
{
  "schemaVersion": 1,
  "sourceRevision": "c5004edf1980123bfd1e5b612aa07aeaf4ddc67d",
  "buildId": "c5004edf1980"
}
```

`sourceRevision` is exactly 40 lowercase hexadecimal characters. `buildId` is
exactly the first 12 characters of `sourceRevision`; it is the compact value
shown in Studio. The object has exactly those three keys. It contains no build
time, random identifier, filesystem path, workflow run number, or other
nondeterministic value.

The build resolves the revision once from `LIGHTWEAVER_SOURCE_REVISION` when
explicitly set, then from GitHub Actions' `GITHUB_SHA`, otherwise from the
checked-out Git `HEAD`, and rejects a malformed revision. The production
workflow passes the checked-out revision through this contract. Vite embeds the
same frozen identity object in the running bundle and emits its canonical
newline-terminated JSON bytes as `/studio-release.json`. Because both outputs
come from the same resolver in the same build, the marker cannot truthfully
identify a different bundle.

### Staging and cache policy

The staged Pages artifact must contain `studio-release.json` at its root.
`public/_headers` assigns that path `Cache-Control: no-store`; staging tests
require the file and the header rule. The marker is added to
`studio-build-graph.json`, so its byte count and SHA-256 are covered alongside
`index.html` and every Vite JavaScript/CSS asset. The graph still excludes
itself, avoiding a circular digest.

The strict release parser rejects invalid JSON, extra or missing keys, a schema
other than `1`, an invalid full revision, or a `buildId` that is not the first
12 characters of that revision. Rebuilding the same clean revision must produce
identical marker bytes and an identical build graph.

### Production proof

The production checker adds `/studio-release.json` to its resolved same-origin
URLs and loads the local staged marker before contacting production. The live
marker must return HTTP 200 without redirects, include `Cache-Control: no-store`,
pass the strict parser, and exactly match the staged identity. The build-graph
verification then hashes the live marker bytes as part of the exact deployed
file set. The final success output records the full source revision, compact
build ID, marker URL, and verified file count.

The marker check does not replace the existing root, asset, authentication,
signed firmware, production-job, or cache-policy checks. It joins them as one
mandatory production proof.

## Open-Studio freshness behavior

### Polling contract

The running Studio knows its embedded release identity and owns one freshness
controller. It requests the fixed same-origin path `/studio-release.json` with
`cache: "no-store"`, manual redirect handling, and a five-second timeout:

- once after the shell mounts;
- every 30 seconds while `document.visibilityState === "visible"`;
- immediately when the window receives `focus`;
- immediately when the document becomes visible; and
- immediately when the browser fires `online`.

Only one request may be in flight. Hidden tabs do not run the interval, and an
offline browser does not attempt a request. Focus, visibility, and online events
coalesce with an in-flight check instead of creating parallel fetches.

For this feature, a **newer production build** means the strictly valid current
production marker has a different full `sourceRevision` from the running
bundle. Git hashes are identities rather than sortable versions, so the browser
does not invent an ordering. A deliberate production rollback is also a
different current production build and should make the open tab converge to it.
The deployment workflow is responsible for proving that the production marker
and bytes are coherent before the deployment is called shipped.

### State and beacon

A persistent compact beacon sits after the existing status-bar spring, making
it the far-right item in the bottom Studio status bar. It uses the existing
status-bar typography, dot, spacing, and color tokens rather than introducing a
new visual language. It remains visible at phone widths.

The beacon exposes these bounded states:

- **Checking · `<buildId>`** while the first request is outstanding.
- **Studio current · `<buildId>`** with the existing success color when the
  marker matches the running bundle.
- **Update ready · `<buildId>`** while a different valid production build is
  waiting for an active protected hardware operation to finish.
- **Freshness unknown · `<buildId>`** with a quiet warning/idle treatment when
  the browser is offline, the request times out or fails, the response
  redirects, the response is not HTTP 200, the no-store header is absent, or
  the marker is invalid.

The visible error state contains no unbounded server response or exception
text. A concise `title` fallback explains the state, and the status text uses
polite live-region semantics without announcing every successful poll.

Errors never schedule a reload. They remain bounded to the normal 30-second
visible poll plus the explicit lifecycle triggers above; success clears the
unknown state.

### Safe automatic refresh

When a valid production identity differs from the embedded identity, Studio
reloads automatically only after these steps:

1. Confirm no protected firmware/card operation is active.
2. Call the existing synchronous `flushProjectAutosave()` and record whether it
   succeeded.
3. Record the attempted pair of running revision and target revision in
   `sessionStorage`.
4. Call `window.location.reload()`.

An autosave failure changes the beacon to **Freshness unknown** and does not
reload, because preserving the current project is more important than updating
the shell.

The attempt record prevents a partial CDN/browser-cache cutover from causing a
reload loop. If the tab reloads into the same old bundle and sees the same
target marker, it does not reload a second time. A matching bundle clears the
record; a later different target revision is eligible for one new attempt.
Malformed, unreachable, cacheable, or redirected markers never write an
attempt record. If `sessionStorage` cannot persist the attempt record, Studio
shows **Freshness unknown** and does not reload, because loop protection is a
precondition for automatic refresh.

### Protected hardware operations

The existing `lw-install-active` signal remains the source of truth for an
active Web Serial firmware install and continues to lock install navigation.
Freshness observes that same signal. A second shell-level
`lw-hardware-operation-active` signal, with `{ active, operation }` detail,
covers destructive card operations outside the installer without changing the
install-navigation behavior. Producers dispatch aggregate active and inactive
transitions around these exact mutation classes:

- firmware erase, flash, release/reset, and recovery;
- writing or promoting card hardware/configuration state;
- installing a project, production job, or wiring configuration to a card; and
- destructive production recovery that can leave the card inconsistent if the
  page disappears mid-operation.

Read-only status, discovery, inspection, export, and ordinary live preview are
not reload blockers. Existing operation owners emit the inactive transition in
`finally`, so success, failure, and cancellation all clear the guard. If a new
marker arrives while guarded, freshness retains one pending target and reloads
immediately when the combined active-operation state becomes false; it does not
wait for the next 30-second poll.

## Missing-change recovery

### Card connection takeover

Commit `93d66c587a5f152980c7de14f0bbecc242c6c971` from
`origin/codex/card-connection-takeover` is genuinely absent from `main` and is
the branch's only unique commit. Integrate it with ancestry preserved when the
clean merge remains possible. Its expected surface is limited to:

- `lightweaver/src/components/card/CardConnectionCenter.jsx`
- `lightweaver/src/lib/cardBridge.js`
- `lightweaver/tests/card-bridge-handoff.mjs`
- `lightweaver/tests/screen-smoke.spec.ts`

The recovered behavior gives a user an explicit **Take over connection** action
when a stale Studio host owns the card-page bridge. Normal fresh ownership and
origin checks remain unchanged. Focused handoff and browser coverage must pass
after integration. Once the final integration is reachable from `main`, PR #51
is closed as merged or superseded with a truthful reference to the integration
that contains it.

### Wire hover descriptions

Cherry-pick only functional commit
`90e465fba34cc69b558e818ec26be4db7eb97d5a` from
`origin/codex/wire-hover-descriptions`. Do not bring its obsolete plan-only
commits into the integration ancestry. Adapt the functional change to current
`main` and preserve the portal tooltip behavior, native `title` fallback,
viewport clamping, and static coverage that every Wire button has matching
`data-tooltip` and `title` text.

Current `main` added four quick color-order controls after that branch fork.
They also receive matching descriptions:

- **Try next order**: apply the next candidate order and retest red.
- **Red is correct**: accept the visible red position and continue to green.
- **Try other match**: switch to the other order with the same red position and
  retest green.
- **Green is correct**: confirm the current order after the green check.

Static tests cover all buttons, including these four, and Playwright verifies a
single unclipped hover portal plus restored `title` fallback at phone and
desktop widths.

### Already-landed branches

The audited squash-merge trees from PR #45, PR #48, and PR #49 are already in
`main`. Do not merge or cherry-pick these branches:

- `origin/codex/cloud-project-library`
- `origin/codex/cloud-library-sign-in`
- `origin/codex/pattern-color-order-popover`

Delete those three obsolete remote branches only after the integration is
merged, the credentialed production deploy succeeds, and the independent live
proof passes. Branch cleanup is never allowed to run ahead of shipment proof.

## Durable repository contract

Root `AGENTS.md` gains the shipping vocabulary and standing **ship it to main**
contract near the public GitHub/deployment guidance. It must explicitly forbid
calling a commit, push, PR, merge, or credential-skipped workflow shipped.

`docs/deployment-checklist.md` gains the same vocabulary, a release-evidence
entry for the Studio marker's full revision and short build ID, and a mandatory
final live proof that names the exact production URL and marker. Its existing
credential warning, signer flow, firmware/job proof, and physical erased-card
acceptance stay intact.

## Verification and delivery

Implementation follows test-driven development. Focused coverage must prove:

- strict release-marker parsing and deterministic canonical bytes;
- the marker and running bundle share one identity;
- build-graph inclusion and exact marker hashing;
- staged marker presence and `no-store` header policy;
- production URL resolution, live header/identity validation, and exact-byte
  mismatch failures;
- startup, 30-second visible polling, focus, visibility, online, offline,
  timeout, invalid-marker, and request-coalescing behavior;
- autosave-before-reload, failed-autosave refusal, protected-operation
  deferral, immediate reload after the guard clears, and session reload-loop
  protection;
- far-right beacon text, build ID, responsive visibility, and accessibility;
- card-connection takeover behavior; and
- complete Wire hover descriptions, including the four newer quick controls.

After focused tests, run the full relevant `npm run launch:source` gate on the
integrated source. Push one coherent integration branch and merge its PR into
`main`. Then observe the actual protected workflows to their terminal state.
If the firmware signer cascade is triggered, wait for its signed release commit
and the deploy it dispatches; do not verify or report against the earlier
source-only commit.

The final independent proof rebuilds/stages the exact final `origin/main`
revision and runs the required production checker against
`https://led.mandalacodes.com`. It also fetches the live marker without cache
and records its exact bytes/revision. Only after that proof passes may the work
be reported **shipped** and the three already-landed remote branches be deleted.
If any boundary fails or credentials skip publishing, report **not shipped**
and name the last proven boundary.

## Scope boundaries

- Preserve current card, project, cloud-library, and visitor interfaces except
  for the approved takeover and hover-description behavior.
- Keep the freshness beacon in the existing bottom status bar; do not redesign
  Studio chrome.
- Do not add a service worker, background updater, manual update modal, or
  user-configurable polling interval.
- Do not modify `lightweaver/server/`, `visitor-ui/`, or
  `docs/pi-hosted-deployment.md`.
- Do not re-merge already-landed cloud library, sign-in, or color-order popover
  histories.
