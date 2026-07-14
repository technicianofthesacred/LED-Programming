# Lightweaver Root Studio and Reliable Card Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve Lightweaver at the subdomain root, save a 19-look project within the current card's NVS limit without losing data, and establish the secure local-card bridge automatically from the first pattern click.

**Architecture:** Keep the full Studio project/runtime model unchanged and introduce one compact persistence serializer at every card-write boundary. Add a bridge acquisition primitive that opens synchronously from the user's pattern click, waits for the existing verified handshake, and retries only the newest preview. Replace the `/design` Pages mount with one root bundle and root-relative firmware/assets.

**Tech Stack:** React 18, Vite 6, JavaScript ES modules, Node test runner, Playwright, Cloudflare Pages, ESP32-S3 Lightweaver bridge protocol.

---

## File structure

- Create `lightweaver/src/lib/cardStoragePayload.js` — pure compact serializer, UTF-8 sizing, and capacity error.
- Create `lightweaver/src/lib/cardStoragePayload.test.js` — exact 19-look reproduction, semantic preservation, and overflow tests.
- Modify `lightweaver/src/lib/cardPushClient.js` — use one prepared compact payload for direct HTTP, bridge, and installer URLs.
- Modify `lightweaver/src/v3/lw-pattern.jsx` — copy/download the same compact JSON and acquire the bridge from pattern clicks.
- Modify `lightweaver/src/lib/cardBridge.js` — verified bridge wait/acquire primitive with one named window.
- Modify `lightweaver/tests/card-bridge-handoff.mjs` — parent/opener, popup, timeout, and coalescing contract tests.
- Modify `lightweaver/tests/card-installer-package.mjs` and `lightweaver/tests/card-live-preview.mjs` — prove every save path uses compact payloads and refuses true overflow before transfer.
- Modify `lightweaver/tests/patterns-v3.spec.ts` — browser-level automatic connection and newest-preview behavior.
- Modify `lightweaver/package.json`, `lightweaver/public/_redirects`, and deployment checks — root-only Pages artifact.
- Modify root-URL references in `lightweaver/index.html`, `lightweaver/scripts/check-prod-freshness.mjs`, `.github/workflows/deploy-site.yml`, and current deployment/runbook docs.

### Task 1: Compact card-storage serializer

**Files:**
- Create: `lightweaver/src/lib/cardStoragePayload.js`
- Create: `lightweaver/src/lib/cardStoragePayload.test.js`

- [ ] **Step 1: Write the failing 19-look and preservation tests**

Create a test fixture with one four-pixel output and the first 19 card patterns. Assert the current runtime JSON exceeds 3,968 bytes, then specify the new API:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCardRuntimePackageFromProject } from './cardRuntimeProject.js';
import { CARD_PATTERN_BANK } from './cardPatternBank.js';
import {
  CARD_CONFIG_STORAGE_LIMIT_BYTES,
  prepareCardStoragePayload,
} from './cardStoragePayload.js';

test('19 standard looks fit card storage without deletion or reordering', () => {
  const playlist = CARD_PATTERN_BANK.slice(0, 19).map((pattern, order) => ({
    id: pattern.id,
    type: 'pattern',
    patternId: pattern.id,
    enabled: true,
    order,
  }));
  const runtimePackage = buildCardRuntimePackageFromProject({
    projectName: 'Untitled Project',
    strips: [{ id: 'strip-1', name: 'Strip 1', pixelCount: 4 }],
    standaloneController: {
      playlist,
      defaultLook: { patternId: 'plasma' },
      outputs: [{ id: 'out1', name: 'Output 1', pin: 16, pixels: 4 }],
    },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(runtimePackage.config), 'utf8') > CARD_CONFIG_STORAGE_LIMIT_BYTES);
  const prepared = prepareCardStoragePayload(runtimePackage);
  assert.ok(prepared.bytes <= CARD_CONFIG_STORAGE_LIMIT_BYTES);
  assert.deepEqual(prepared.config.looks.map(look => look.id), runtimePackage.config.looks.map(look => look.id));
  assert.equal(prepared.config.patterns, undefined);
});
```

Add separate tests proving non-default look fields and combo-zone fields remain, defaults disappear, and a deliberately large compact combo throws with `reason === 'config-too-large'`, `bytes`, and `maxBytes`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd lightweaver && node --test src/lib/cardStoragePayload.test.js`

Expected: FAIL because `cardStoragePayload.js` does not exist.

- [ ] **Step 3: Implement the pure serializer**

Implement these exports:

```js
export const CARD_CONFIG_STORAGE_LIMIT_BYTES = 3968;

export class CardConfigCapacityError extends Error {
  constructor(bytes, maxBytes = CARD_CONFIG_STORAGE_LIMIT_BYTES) {
    super(`Card setup is ${bytes} bytes; this card can store ${maxBytes}. Remove a complex combined look or section, then try again.`);
    this.name = 'CardConfigCapacityError';
    this.reason = 'config-too-large';
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

export function compactCardStorageConfig(runtimePackageOrConfig = {}) { /* pure clone + omit firmware defaults */ }
export function prepareCardStoragePayload(runtimePackageOrConfig = {}, { maxBytes = CARD_CONFIG_STORAGE_LIMIT_BYTES } = {}) { /* { config, json, bytes } or throw */ }
```

Compaction rules must exactly match current firmware defaults:

- omit top-level `patterns` only when non-empty `looks` exists;
- omit look `fps:24`, `loop:true`, `fadeOutMs:320`, and `fadeInMs:420`;
- omit look `preset` only when it equals `id`;
- omit look `mode` only for procedural looks, the website-flash default;
- retain look brightness unless it equals firmware default `0.65`;
- omit zone brightness `1`, speed `1`, hue shift `0`, custom hue `32`, custom saturation `230`, breathe/drift/blackout `false`;
- remove `controls.encoder.patternCycleIds` because firmware cycles the ordered `looks` array and does not deserialize that property;
- preserve all unknown and non-default fields for forward compatibility;
- never slice arrays.

- [ ] **Step 4: Run focused and full unit tests**

Run:

```bash
cd lightweaver
node --test src/lib/cardStoragePayload.test.js
npm run test:unit
```

Expected: new tests pass and the full unit suite passes.

- [ ] **Step 5: Commit Task 1**

```bash
git add lightweaver/src/lib/cardStoragePayload.js lightweaver/src/lib/cardStoragePayload.test.js
git commit -m "fix: compact card configuration for flash storage"
```

### Task 2: Use the compact payload at every card-write boundary

**Files:**
- Modify: `lightweaver/src/lib/cardPushClient.js`
- Modify: `lightweaver/src/v3/lw-pattern.jsx`
- Modify: `lightweaver/tests/card-installer-package.mjs`
- Modify: `lightweaver/tests/card-live-preview.mjs`

- [ ] **Step 1: Write failing boundary tests**

Specify that:

- `encodeCardConfigHandoffPayload()` decodes to the compact config;
- direct `fetch('/api/config')` receives the compact config;
- `sendCardBridgeRequest('config', ...)` receives the compact config;
- an oversized compact config throws before `fetch`, bridge postMessage, URL creation, clipboard write, or download;
- Patterns copy/download content equals `prepareCardStoragePayload(runtimePackage).json`.

Use injected fetch/bridge functions already supported by the current test harness; count calls and assert zero calls for overflow.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd lightweaver
node tests/card-installer-package.mjs
node tests/card-live-preview.mjs
```

Expected: FAIL because the current paths serialize `runtimePackage.config` directly.

- [ ] **Step 3: Integrate one prepared payload**

In `cardPushClient.js`, import `prepareCardStoragePayload` and make all boundary functions prepare before encoding or transfer:

```js
const prepared = prepareCardStoragePayload(runtimePackage);
const body = prepared.json;
// bridge payload: prepared.config
// handoff base64 source: prepared.json
```

Export a small `cardStorageJson(runtimePackage)` helper for copy/download so `lw-pattern.jsx` does not duplicate serialization. Replace its pretty `JSON.stringify(runtimePackage.config, null, 2)` with the exact compact JSON; prettification must not be used because the pasted file must remain below the byte budget.

Normalize `CardConfigCapacityError` without converting it to `offline` or `mixed-content`, so UI receives `reason: 'config-too-large'` and the exact message.

- [ ] **Step 4: Run focused tests and relevant browser test**

Run:

```bash
cd lightweaver
node tests/card-installer-package.mjs
node tests/card-live-preview.mjs
npx playwright test tests/patterns-v3.spec.ts --grep "setup JSON|Save to card" --workers=1
```

Expected: all pass.

- [ ] **Step 5: Commit Task 2**

```bash
git add lightweaver/src/lib/cardPushClient.js lightweaver/src/v3/lw-pattern.jsx lightweaver/tests/card-installer-package.mjs lightweaver/tests/card-live-preview.mjs lightweaver/tests/patterns-v3.spec.ts
git commit -m "fix: enforce card storage budget on every save path"
```

### Task 3: Automatic verified card bridge from pattern clicks

**Files:**
- Modify: `lightweaver/src/lib/cardBridge.js`
- Modify: `lightweaver/src/v3/lw-pattern.jsx`
- Modify: `lightweaver/tests/card-bridge-handoff.mjs`
- Modify: `lightweaver/tests/patterns-v3.spec.ts`

- [ ] **Step 1: Write failing bridge acquisition tests**

Specify this public API:

```js
const attempt = acquireCardBridgeFromGesture(host, { studioUrl, timeoutMs: 2500 });
await attempt.ready;
```

Tests must prove:

- `bootstrapCardBridgeFromOpener()` plus a verified ready event resolves without calling `window.open`;
- a standalone page calls `window.open` synchronously once with the named card bridge window;
- a verified ready event resolves the promise for the normalized host;
- blocked popup rejects with `reason: 'popup-blocked'`;
- timeout rejects with `reason: 'bridge-timeout'`;
- concurrent acquisition for the same host reuses one promise/window.

- [ ] **Step 2: Run the bridge contract and verify RED**

Run: `cd lightweaver && node tests/card-bridge-handoff.mjs`

Expected: FAIL because `acquireCardBridgeFromGesture` is not exported.

- [ ] **Step 3: Implement acquisition in `cardBridge.js`**

Add a host-keyed in-flight map. `acquireCardBridgeFromGesture` must:

1. attach the listener and bootstrap parent/opener state;
2. resolve immediately only when `getCardBridgeState().verified` matches the host;
3. call `openCardBridge(host, { autoOpenStudio:false, studioUrl })` before its first asynchronous boundary;
4. reject immediately when `window.open` returns null;
5. listen for `CARD_BRIDGE_CHANGED_EVENT` until a verified matching host arrives;
6. clean up listener/timer/in-flight entry on resolve or reject.

Do not relax `PRIVILEGED_BRIDGE_TYPES`, `isLocalCardHost`, source-window, or target-origin checks.

- [ ] **Step 4: Make pattern selection bridge-aware**

In `lw-pattern.jsx`, make each browse-card click begin acquisition synchronously when live local preview is enabled and the bridge is not verified. Preserve the selected look immediately in Studio. After bridge readiness, schedule the originally requested preview only if its sequence is still newest. If another pattern was clicked meanwhile, only the latest pattern is sent.

Map failures to one concise recovery action:

- `popup-blocked`: “Allow the Lightweaver card window, then try the pattern again.”
- `bridge-timeout`: “The card page opened but did not answer. Check that this device is on the card’s Wi-Fi.”
- old protocol: existing Flash action.

Remove the generic “Open the card page once by clicking Card disconnected” message from this path.

- [ ] **Step 5: Run focused contract and Patterns E2E**

Run:

```bash
cd lightweaver
node tests/card-bridge-handoff.mjs
npx playwright test tests/patterns-v3.spec.ts --workers=1
```

Expected: bridge contract and full Patterns suite pass.

- [ ] **Step 6: Commit Task 3**

```bash
git add lightweaver/src/lib/cardBridge.js lightweaver/src/v3/lw-pattern.jsx lightweaver/tests/card-bridge-handoff.mjs lightweaver/tests/patterns-v3.spec.ts
git commit -m "fix: connect local card from the first pattern click"
```

### Task 4: Make the subdomain root the only deployment surface

**Files:**
- Modify: `lightweaver/package.json`
- Modify: `lightweaver/public/_redirects`
- Create: `lightweaver/public/404.html`
- Modify: `lightweaver/index.html`
- Modify: `lightweaver/scripts/check-prod-freshness.mjs`
- Create: `lightweaver/tests/pages-staging.mjs`
- Modify: `lightweaver/tests/pages-headers.mjs`
- Modify: `.github/workflows/deploy-site.yml`
- Modify: `docs/led-mandalacodes-setup.md`
- Modify: `docs/deployment-checklist.md`
- Modify: `docs/worker-flash-runbook.md`

- [ ] **Step 1: Write failing root staging assertions**

Create `tests/pages-staging.mjs`, add it immediately after `pages-headers.mjs` in `test:core`, and assert:

```js
assert.equal(pkg.scripts['build:design'], undefined);
assert.match(pkg.scripts['stage:pages'], /cp -R dist\/. \.pages\/lightweaver\//);
assert.doesNotMatch(pkg.scripts['stage:pages'], /lightweaver\/design/);
assert.doesNotMatch(redirects, /^\/design/m);
assert.match(redirects, /^\/visitor \/src\/visitor\/visitor\.html 200$/m);
assert.doesNotMatch(redirects, /^\/\*/m);
assert.ok(existsSync(resolve(root, 'public/404.html')));
```

Add source scans proving current generated links, freshness URLs, and workflow comments do not claim `/design` is canonical.

- [ ] **Step 2: Run staging tests and verify RED**

Run: `cd lightweaver && node tests/pages-staging.mjs`

Expected: FAIL on `build:design`, `/design` staging, and redirects.

- [ ] **Step 3: Change build and staging**

Use root base and root artifact:

```json
"stage:pages": "rm -rf .pages/lightweaver && mkdir -p .pages/lightweaver && cp -R dist/. .pages/lightweaver/",
"deploy:pages": "npm run build && npm run stage:pages && npx --yes wrangler pages deploy .pages/lightweaver --project-name lightweaver --branch main"
```

Make `public/_redirects` contain only the explicit visitor paths:

```text
/visitor /src/visitor/visitor.html 200
/visitor/ /src/visitor/visitor.html 200
```

Add a top-level `public/404.html`; Cloudflare Pages uses it to disable implicit SPA fallback, so `/design` is genuinely not an app route. Update the live fallback URL, firmware freshness URL to `/firmware/...`, production root/legacy-route checks, and deployment documentation/comments. Do not add a `/design` redirect or second artifact copy.

- [ ] **Step 4: Build, stage, and inspect the artifact**

Run:

```bash
cd lightweaver
node tests/pages-headers.mjs
node tests/pages-staging.mjs
npm run build
npm run stage:pages
test -f .pages/lightweaver/index.html
test -f .pages/lightweaver/404.html
test -f .pages/lightweaver/firmware/lightweaver-controller-esp32s3-factory.bin
test ! -e .pages/lightweaver/design
rg -n '/design/' .pages/lightweaver/index.html .pages/lightweaver/_redirects && exit 1 || true
```

Expected: tests and build pass; root files and the top-level 404 exist; no staged `design` directory, wildcard SPA fallback, or generated `/design/` reference exists.

- [ ] **Step 5: Commit Task 4**

```bash
git add lightweaver/package.json lightweaver/public/_redirects lightweaver/index.html lightweaver/scripts/check-prod-freshness.mjs lightweaver/tests/pages-headers.mjs lightweaver/tests/pages-staging.mjs .github/workflows/deploy-site.yml docs/led-mandalacodes-setup.md docs/deployment-checklist.md docs/worker-flash-runbook.md
git commit -m "deploy: serve Lightweaver Studio at the subdomain root"
```

### Task 5: Integrated verification and production release

**Files:**
- Verify the committed implementation; if a requirement fails, return to its owning task and add a failing regression test there before changing production code.

- [ ] **Step 1: Run focused and full verification**

Run:

```bash
cd lightweaver
node --test src/lib/cardStoragePayload.test.js
node tests/card-installer-package.mjs
node tests/card-live-preview.mjs
node tests/card-bridge-handoff.mjs
npx playwright test tests/patterns-v3.spec.ts --workers=1
npm run test:unit
npm run launch:check
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Verify locally at the root**

Start the production preview and use a fresh Playwright session to assert `/` loads Patterns and Layout, `/firmware/lightweaver-controller-esp32s3-factory.bin` is a valid binary, a 390px viewport has no horizontal overflow, and no generated navigation contains `/design`.

- [ ] **Step 3: Push and open the integration PR**

```bash
git push -u origin codex/lightweaver-root-card-fix
gh pr create --base main --head codex/lightweaver-root-card-fix \
  --title "Serve Lightweaver at root and harden card saves" \
  --body $'## Summary\n- serve Studio directly at led.mandalacodes.com\n- compact every card-bound config without dropping looks\n- connect the local card from the first pattern click\n\n## Verification\n- npm run launch:check\n- focused storage, bridge, installer, and Patterns tests\n- root Pages artifact inspection'
```

- [ ] **Step 4: Wait for the required checks and merge**

Require the launch check to pass. Merge without bypassing a product failure; a duplicate workflow cancellation caused by the repository's deployment concurrency is acceptable only when the newer run succeeds for the same commit.

- [ ] **Step 5: Verify production outside-in**

In a fresh browser against `https://led.mandalacodes.com/`, verify:

- root returns HTTP 200 and loads Studio without `/design`;
- Layout and Patterns work at root hashes;
- the 19-look compact configuration is below 3,968 bytes;
- first pattern click establishes the bridge and previews without the old manual instruction;
- public firmware SHA-256 equals the committed binary;
- the final `main` deployment run succeeded.

- [ ] **Step 6: Verify the connected card**

Using the connected test card, save the reported playlist, confirm `/api/config` accepts it, wait through any required reboot, confirm `/api/status` reports the saved piece and expected look count, then click two patterns from the root Studio and confirm the second pattern appears without a manual bridge step.

- [ ] **Step 7: Record final evidence**

Report the production URL, merge commit, deployment run, compact payload byte count, public firmware hash match, and real-card save/preview result. Do not call the work complete if only mocks passed.
