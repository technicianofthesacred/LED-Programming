# Windowless Offline Lightweaver Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one shared Lightweaver Studio that uses verified direct local-network requests when they work, otherwise replaces the current tab with a card-hosted offline Studio, while preserving exact-card safety, recovery, editable-project continuity, and the legacy bridge fallback.

**Architecture:** Extend the existing `cardLink` authority into a transport registry with `direct-lna`, `local-origin`, and `legacy-bridge` implementations, then route every HTTP command and frame family through that verified authority. The public Vite target becomes a controlled-update PWA backed by an IndexedDB `ProjectRepository`; a pruned card target from the same source is embedded into firmware and uses atomic card repository APIs. Project movement between origins is explicit first (import/export/card save), with a short-lived ciphertext-only handoff layered on after repository semantics are proven.

**Tech Stack:** React 18, Vite 6, Node test runner, Playwright, IndexedDB, Service Worker/Cache API, Web Crypto, Cloudflare Pages Functions, ESP32-S3 Arduino/PlatformIO, LittleFS/firmware HTTP APIs.

---

## File structure and ownership

Studio agent owns only `lightweaver/src/**` and focused Studio tests under `lightweaver/tests/windowless-*.spec.ts`:

- `lightweaver/src/lib/cardTransport.js` — transport interface, exact direct probe, same-origin/local routing, legacy adapter.
- `lightweaver/src/lib/cardTransport.test.js` — transport selection, correlation, revocation, no-popup contracts.
- `lightweaver/src/lib/cardLink.js` — verified authority integration; existing identity/readiness rules remain canonical.
- `lightweaver/src/lib/cardFrameStream.js` — bounded HTTP frame transport and stream-lease integration.
- `lightweaver/src/lib/cardFrameStream.http.test.js` — ordering, timeout, Stop, interruption, lease revocation.
- `lightweaver/src/lib/projectRepository.js` — repository interface/envelope validation/conflict helpers.
- `lightweaver/src/lib/indexedDbProjectRepository.js` — public repository, guarded localStorage migration, recovery copy, outbox.
- `lightweaver/src/lib/cardProjectRepository.js` — chunked card repository adapter with owner capability and expected-head guards.
- `lightweaver/src/lib/projectRepository.test.js` and `indexedDbProjectRepository.test.js` — repository/conflict/migration/quota/readback/outbox contracts.
- `lightweaver/src/lib/projectHandoff.js` — browser encryption, fragment payload, staged claim, conflict decision.
- `lightweaver/src/lib/projectHandoff.test.js` — ciphertext/token/key/single-use client contracts.
- `lightweaver/src/lib/runtimeMode.js` — public/local target detection and secure-only capability handback.
- `lightweaver/src/lib/offlineUpdate.js` — Service Worker readiness and mutation-safe controlled update.
- `lightweaver/src/state/ProjectContext.jsx` and `lightweaver/src/lib/projectStorage.js` — adopt repository seam without changing project lifecycle semantics.
- `lightweaver/src/components/card/CardConnectionCenter.jsx` — one connection entrance, direct attempt, same-tab local fallback, wrong-card copy.
- `lightweaver/src/v3/app.jsx`, `lightweaver/src/main.jsx` — runtime provider and local-mode capability gates.
- `lightweaver/src/card-main.jsx`, `lightweaver/card.html` — pruned card entry from shared screens.

Firmware agent owns only `firmware/lightweaver-controller/src/**` and focused firmware contracts under `firmware/lightweaver-controller/tests/windowless-*.mjs`:

- `LightweaverHttpFrameStream.{h,cpp}` — bounded ordered HTTP frames, owner/lease/Stop/timeout semantics.
- `LightweaverProjectRepository.{h,cpp}` — quota, staging, incremental hash/readback, atomic head promotion, recovery cleanup.
- `LightweaverOwnerCapability.{h,cpp}` — short-lived capability bound to card, boot, origin, owner session, operation generation, and expected head.
- `LightweaverCardStudio.{h,cpp}` plus generated `LightweaverCardStudioBundle.h` — immutable compressed assets, no-cache HTML/release metadata, recovery fallback.
- `LightweaverWeb.cpp`, `LightweaverRuntimeApi.h`, `main.cpp` — register the new handlers without forking existing command logic.

CI/tests agent owns only `lightweaver/vite.config.js`, `lightweaver/package.json` scripts, `lightweaver/public/**`, `lightweaver/functions/api/handoff/**`, `lightweaver/scripts/**`, root `scripts/**`, `.github/**`, `docs/**` except `LIGHTWEAVER_WORKBOARD.md`, and non-Studio-source contract tests:

- `lightweaver/scripts/build-card-studio.mjs` — pruned build, gzip/brotli/hash manifest, deterministic C++ header generation.
- `lightweaver/scripts/generate-service-worker.mjs` — deterministic shell manifest and controlled Service Worker.
- `lightweaver/functions/api/handoff/_shared/store.js`, `stage.js`, `[tokenHash].js` — bounded ciphertext-only, expiring, single-use staging.
- `lightweaver/tests/windowless-offline-studio.spec.ts` — real-page routing, no auxiliary window, local/public gates, offline reload.
- `lightweaver/tests/card-studio-bundle.mjs` and `firmware/.../tests/windowless-card-studio-contract.mjs` — bundle identity, hashes, fallback, size, and manifest coverage.
- `scripts/ci-changed-lanes.mjs`, `.github/workflows/test.yml`, `.github/workflows/build-firmware.yml` — ensure card-Studio source changes enter firmware-sensitive and artifact lanes.

The primary agent alone edits `LIGHTWEAVER_WORKBOARD.md`, integrates all three boundaries, runs the checkpoint, records unperformed real-device gates, and commits the verified combined batch.

### Task 1: Verified transport authority and same-tab connection experience

**Files:**
- Create: `lightweaver/src/lib/cardTransport.js`
- Create: `lightweaver/src/lib/cardTransport.test.js`
- Modify: `lightweaver/src/lib/cardLink.js`
- Modify: `lightweaver/src/components/card/CardConnectionCenter.jsx`
- Test: `lightweaver/tests/windowless-connection.spec.ts`

- [ ] **Step 1: Write failing unit contracts for result-based routing**

```js
test('selects direct-lna only after an exact fresh status response', async () => {
  const authority = await connectCardTransport({
    host: '192.168.18.70', expectedCardId: 'lw-card-a',
    fetchImpl: async () => response({ cardId: 'lw-card-a', bootId: 'boot-2', ready: true }),
  });
  assert.equal(authority.transport, 'direct-lna');
  assert.equal(authority.cardId, 'lw-card-a');
});

test('a failed direct probe returns a same-tab local fallback without opening a window', async () => {
  let opened = 0;
  const result = await connectCardTransport({ host: 'lightweaver.local', fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, openImpl: () => opened++ });
  assert.equal(result.recovery.localStudioUrl, 'http://lightweaver.local/studio/');
  assert.equal(opened, 0);
});
```

- [ ] **Step 2: Run the new unit test and verify RED**

Run: `cd lightweaver && node --test src/lib/cardTransport.test.js`

Expected: FAIL because `cardTransport.js` and `connectCardTransport` do not exist.

- [ ] **Step 3: Implement the minimal transport registry and exact probe**

```js
export const CARD_TRANSPORTS = Object.freeze({ DIRECT: 'direct-lna', LOCAL: 'local-origin', BRIDGE: 'legacy-bridge' });

export async function connectCardTransport({ host, expectedCardId = '', fetchImpl = fetch }) {
  const normalizedHost = normalizeCardHost(host);
  try {
    const response = await fetchImpl(`${cardHostToUrl(normalizedHost)}/api/status`, {
      method: 'GET', cache: 'no-store', credentials: 'omit', targetAddressSpace: 'local',
      headers: { Accept: 'application/json', 'X-Lightweaver-Probe': '1' },
    });
    const status = await response.json();
    const verified = verifyCardStatus(status, { expectedCardId, host: normalizedHost });
    return createTransportAuthority(CARD_TRANSPORTS.DIRECT, normalizedHost, verified);
  } catch (cause) {
    return { connected: false, reason: 'direct-unavailable', cause, recovery: { localStudioUrl: cardLocalStudioUrl(normalizedHost) } };
  }
}
```

`createTransportAuthority` must expose immutable `host`, `cardId`, `bootId`, `ownerSessionId`, `operationGeneration`, `transport`, `request`, `stop`, `revalidate`, and `revoke`. `request` delegates through existing `cardLink` identity/readiness/owner guards instead of duplicating them.

- [ ] **Step 4: Wire Connection Center to the real result**

The primary action remains `Connect this card`. Before probing, render copy explaining the browser local-network prompt. On failure render `Try again` and `Open local Studio`; the latter uses `window.location.assign(authority.recovery.localStudioUrl)`. Wrong-card results name expected and observed card IDs and do not expose write actions. Existing legacy bridge controls remain under an explicit rollout fallback.

- [ ] **Step 5: Add Playwright proof and verify GREEN**

Run: `cd lightweaver && node --test src/lib/cardTransport.test.js && npx playwright test tests/windowless-connection.spec.ts --project=chromium --workers=1`

Expected: PASS; Playwright stubs `window.open` to throw and proves direct success stays on HTTPS while failure calls same-tab `location.assign`.

### Task 2: Bounded HTTP frames and authority leases

**Files:**
- Create: `lightweaver/src/lib/cardFrameStream.http.test.js`
- Modify: `lightweaver/src/lib/cardFrameStream.js`
- Modify: `lightweaver/src/lib/cardLiveControl.js`
- Create: `firmware/lightweaver-controller/src/LightweaverHttpFrameStream.h`
- Create: `firmware/lightweaver-controller/src/LightweaverHttpFrameStream.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverRuntimeApi.h`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Test: `firmware/lightweaver-controller/tests/windowless-http-frame-stream.mjs`

- [ ] **Step 1: Write failing browser and firmware contracts**

```js
test('HTTP frames carry lease and monotonic sequence and Stop revokes the lease', async () => {
  const calls = [];
  const transport = createHttpFrameTransport('192.168.18.70', { authority, fetchImpl: capture(calls) });
  await transport.send(['FF0000'], { sequence: 7 });
  await transport.stop();
  assert.deepEqual(calls.map(call => call.path), ['/api/stream/lease', '/api/stream/frame', '/api/stream/stop']);
  assert.equal(calls[1].body.sequence, 7);
  await assert.rejects(() => transport.send(['00FF00'], { sequence: 8 }), /revoked/);
});
```

Firmware source contract must assert bounded body constants, endpoints `/api/stream/lease`, `/api/stream/frame`, `/api/stream/stop`, exact card/boot/session/generation correlation, strictly increasing sequence, deadline timeout, and delegation to canonical runtime frame/Stop APIs.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd lightweaver && node --test src/lib/cardFrameStream.http.test.js && node ../firmware/lightweaver-controller/tests/windowless-http-frame-stream.mjs`

Expected: FAIL because HTTP stream transport and endpoints are absent.

- [ ] **Step 3: Implement minimal browser HTTP transport**

Add `createHttpFrameTransport(host, { authority, fetchImpl, nowImpl })`. It acquires a lease with `{cardId, bootId, ownerSessionId, operationGeneration}`, refreshes before expiry, POSTs bounded chunked RGB payloads with monotonic `sequence`, and immediately revokes on any authority snapshot mismatch. `defaultFrameTransport` selects HTTP for `direct-lna` and `local-origin`; WebSocket remains an optional proven optimization and bridge chunking remains fallback.

- [ ] **Step 4: Implement firmware stream state without forking light output logic**

```cpp
struct LightweaverHttpStreamLease {
  bool active;
  String cardId, bootId, ownerSessionId;
  uint32_t operationGeneration, lastSequence, expiresAtMs;
};

bool acceptHttpFrame(const LightweaverHttpFrameRequest& request) {
  if (!leaseMatches(request) || request.sequence <= lease.lastSequence) return false;
  lease.lastSequence = request.sequence;
  lease.expiresAtMs = millis() + LW_HTTP_STREAM_TIMEOUT_MS;
  return runtimeApplyWledFrame(request.rgb, request.rgbBytes);
}
```

The handler must reuse `frameSourceClaim`, canonical buffer bounds, `runtimeCancelStream`, and the existing recovery priority. It must never introduce a parallel rendering state machine.

- [ ] **Step 5: Verify GREEN**

Run the two focused commands from Step 2 plus `cd lightweaver && node tests/card-frame-stream.mjs`.

Expected: PASS, including existing bridge/WebSocket behavior.

### Task 3: Conflict-safe repository seam, IndexedDB migration, and durable outbox

**Files:**
- Create: `lightweaver/src/lib/projectRepository.js`
- Create: `lightweaver/src/lib/projectRepository.test.js`
- Create: `lightweaver/src/lib/indexedDbProjectRepository.js`
- Create: `lightweaver/src/lib/indexedDbProjectRepository.test.js`
- Modify: `lightweaver/src/lib/projectStorage.js`
- Modify: `lightweaver/src/state/ProjectContext.jsx`

- [ ] **Step 1: Write failing envelope and compare-and-swap tests**

```js
test('save rejects a stale expected head even when its timestamp is newer', async () => {
  const repo = createMemoryProjectRepository();
  const first = await repo.save(envelope({ id: 'p1', parentHash: null, hash: 'h1' }), null);
  await repo.save(envelope({ id: 'p1', parentHash: first.contentHash, hash: 'h2' }), first.contentHash);
  await assert.rejects(() => repo.save(envelope({ id: 'p1', parentHash: first.contentHash, hash: 'h3', modifiedAt: 999999 }), first.contentHash), error => error.code === 'head-conflict');
});
```

Add tests for the complete editable package, schema validation, stable ID, content/parent hash, local revision, source card/install identity, watch notifications, remove CAS, localStorage migration readback, retained recovery copy, IndexedDB quota/transaction failure, and outbox replay after reload.

- [ ] **Step 2: Verify RED**

Run: `cd lightweaver && node --test src/lib/projectRepository.test.js src/lib/indexedDbProjectRepository.test.js`

Expected: FAIL because the repository modules do not exist.

- [ ] **Step 3: Implement repository contracts and adapter**

```js
export class ProjectHeadConflictError extends Error { constructor(currentHead) { super('Project head changed'); this.code = 'head-conflict'; this.currentHead = currentHead; } }

export function validateProjectEnvelope(value) {
  assertProjectPackage(value.project);
  if (sha256Canonical(value.project) !== value.contentHash) throw new Error('content-hash-mismatch');
  return Object.freeze(structuredClone(value));
}
```

Implement `list/read/save/remove/watch` using IndexedDB transactions. Migration writes and reads back the IndexedDB record before marking migration complete; it retains `lw_autosave_v3_backup`. Cloud saves enqueue encrypted/validated operations in a durable outbox and replay in parent-hash order.

- [ ] **Step 4: Adapt project lifecycle above the seam**

`ProjectContext` continues to create/replace/dirty-track projects. Replace direct library persistence calls with an injected repository while keeping existing `projectStorage` exports as compatibility wrappers. UI state must name repository source (`This browser`, `Lightweaver <cardId>`, or cloud library).

- [ ] **Step 5: Verify GREEN and existing lifecycle compatibility**

Run: `cd lightweaver && node --test src/lib/projectRepository.test.js src/lib/indexedDbProjectRepository.test.js src/lib/projectStorage.test.js src/lib/projectLifecycle.test.js`

Expected: PASS.

### Task 4: Atomic card project repository and owner capability

**Files:**
- Create: `firmware/lightweaver-controller/src/LightweaverOwnerCapability.h`
- Create: `firmware/lightweaver-controller/src/LightweaverOwnerCapability.cpp`
- Create: `firmware/lightweaver-controller/src/LightweaverProjectRepository.h`
- Create: `firmware/lightweaver-controller/src/LightweaverProjectRepository.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Test: `firmware/lightweaver-controller/tests/windowless-project-repository.mjs`
- Test: `firmware/lightweaver-controller/tests/windowless-owner-capability.mjs`

- [ ] **Step 1: Write failing source/host contracts**

Contracts cover capability issuance only from commissioning or deliberate physical-pairing authority; binding to card/boot/origin/session/generation/expected head; expiry/revocation; quota preflight with recovery headroom; chunk order and size; staged hash/readback; atomic small head pointer; previous known-good retention; stale-head replace/delete rejection; abandoned staging cleanup after boot; and power loss at every promotion boundary.

- [ ] **Step 2: Verify RED**

Run: `node firmware/lightweaver-controller/tests/windowless-owner-capability.mjs && node firmware/lightweaver-controller/tests/windowless-project-repository.mjs`

Expected: FAIL because repository APIs and storage markers are absent.

- [ ] **Step 3: Implement capability and repository state**

```cpp
struct LightweaverOwnerCapability {
  String tokenHash, cardId, bootId, origin, ownerSessionId, expectedHead;
  uint32_t operationGeneration, expiresAtMs;
};

struct LightweaverProjectUpload {
  String uploadId, projectId, contentHash, expectedHead, stagingPath;
  size_t totalBytes, receivedBytes, chunkSize;
};
```

Expose bounded endpoints for capability pairing/status/revoke and project list/read/preflight/begin/chunk/commit/delete. The commit sequence is `close -> hash -> full readback -> write new immutable version -> fsync/close -> atomically replace head pointer -> verify head -> retain previous known-good -> cleanup staging`. A failure before verified head promotion leaves the old head active.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 commands plus existing storage/power-loss contracts: `node firmware/lightweaver-controller/tests/storage-stack-safety.mjs && node firmware/lightweaver-controller/tests/wiring-promotion-power-loss.mjs`.

Expected: PASS.

### Task 5: Card repository adapter, import/export, and explicit copy identity

**Files:**
- Create: `lightweaver/src/lib/cardProjectRepository.js`
- Create: `lightweaver/src/lib/cardProjectRepository.test.js`
- Modify: `lightweaver/src/lib/projectFiles.js`
- Modify: `lightweaver/src/state/ProjectContext.jsx`
- Modify: `lightweaver/src/components/card/CardConnectionCenter.jsx`
- Test: `lightweaver/tests/windowless-project-continuity.spec.ts`

- [ ] **Step 1: Write failing adapter and screen tests**

Tests prove preflight before upload, owner capability required, bounded sequential chunks, cancellation leaves previous head, readback hash verification, stale-head conflict with compare/keep-both/replace choices, `Save project to this card`, `Export project`, `Import project`, and visible copy source.

- [ ] **Step 2: Verify RED**

Run: `cd lightweaver && node --test src/lib/cardProjectRepository.test.js && npx playwright test tests/windowless-project-continuity.spec.ts --project=chromium --workers=1`

Expected: FAIL because the adapter/actions do not exist.

- [ ] **Step 3: Implement the adapter and explicit transfer actions**

```js
export function createCardProjectRepository({ authority, fetchImpl = fetch }) {
  return {
    list: () => authority.request('/api/projects'),
    read: id => authority.request(`/api/projects/${encodeURIComponent(id)}`),
    save: (envelope, expectedHead) => uploadEnvelopeInChunks({ authority, fetchImpl, envelope, expectedHead }),
    remove: (id, expectedHead) => authority.request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE', body: { expectedHead } }),
    watch: listener => authority.watch(listener),
  };
}
```

Import uses existing schema migration and replacement confirmation. Export uses the existing project file format with envelope metadata. Installed hardware config is labeled `Installed configuration`, never `Complete editable project`.

- [ ] **Step 4: Verify GREEN**

Run Step 2 plus `cd lightweaver && node --test src/lib/projectFiles.test.js`.

Expected: PASS.

### Task 6: Offline public PWA and mutation-safe updates

**Files:**
- Create: `lightweaver/src/lib/offlineUpdate.js`
- Create: `lightweaver/src/lib/offlineUpdate.test.js`
- Modify: `lightweaver/src/main.jsx`
- Modify: `lightweaver/vite.config.js`
- Create: `lightweaver/scripts/generate-service-worker.mjs`
- Modify: `lightweaver/package.json`
- Test: `lightweaver/tests/windowless-offline-studio.spec.ts`

- [ ] **Step 1: Write failing cache/update contracts**

Tests assert hashed shell assets are cache-first; navigation and `studio-release.json` are network-first with compatible cached fallback; `/api/`, card hosts, and cloud responses are never cached; `Ready offline` appears only after required shell verification; waiting updates do not activate during active mutation or unsaved transition; and cold offline reload succeeds after one online install.

- [ ] **Step 2: Verify RED**

Run: `cd lightweaver && node --test src/lib/offlineUpdate.test.js && npx playwright test tests/windowless-offline-studio.spec.ts --project=chromium --workers=1`

Expected: FAIL because Service Worker/update modules are absent.

- [ ] **Step 3: Generate and register a deterministic Service Worker**

The generator consumes the Vite manifest after build and writes `dist/sw.js` with build-scoped cache names. The fetch handler rejects caching when `url.pathname.startsWith('/api/')`, `request.method !== 'GET'`, or the URL is not the canonical Studio origin. `offlineUpdate` registers it only in public HTTPS mode and exposes `installing/ready/update-waiting`; activation calls `skipWaiting` only when both `hasActiveMutation()` and `hasUnsavedTransition()` are false.

- [ ] **Step 4: Bundle fonts and manifest locally**

Remove external font fetches used by the Studio shell, add local font assets under `lightweaver/public/fonts/`, and add a web manifest with canonical start URL/display identity. Do not enable Service Worker registration in card-local HTTP mode.

- [ ] **Step 5: Verify GREEN and production build**

Run: `cd lightweaver && node --test src/lib/offlineUpdate.test.js && npm run build && npx playwright test tests/windowless-offline-studio.spec.ts --project=chromium --workers=1`.

Expected: PASS; `dist/sw.js` and manifest exist and offline reload renders Studio.

### Task 7: Shared-source card Studio, compatibility gate, and signed bundle embedding

**Files:**
- Create: `lightweaver/src/lib/runtimeMode.js`
- Create: `lightweaver/src/lib/runtimeMode.test.js`
- Create: `lightweaver/src/card-main.jsx`
- Create: `lightweaver/card.html`
- Modify: `lightweaver/src/v3/app.jsx`
- Create: `lightweaver/scripts/build-card-studio.mjs`
- Modify: `lightweaver/vite.config.js`
- Modify: `lightweaver/package.json`
- Create: `firmware/lightweaver-controller/src/LightweaverCardStudio.h`
- Create: `firmware/lightweaver-controller/src/LightweaverCardStudio.cpp`
- Generate: `firmware/lightweaver-controller/src/LightweaverCardStudioBundle.h`
- Modify: `firmware/lightweaver-controller/src/LightweaverWeb.cpp`
- Test: `lightweaver/tests/card-studio-bundle.mjs`
- Test: `firmware/lightweaver-controller/tests/windowless-card-studio-contract.mjs`

- [ ] **Step 1: Write failing target and bundle contracts**

Tests prove the local target uses shared React screens and `local-origin`, excludes Service Worker/cloud account/USB/microphone modules, hands secure-only tools back to the fixed HTTPS URL in the same tab, emits `card-studio-release.json` with build/schema/API ranges/hashes/total size, serves immutable compressed hashed assets and no-cache HTML/metadata, rejects incompatible/damaged bundles, and always retains the existing small card page.

- [ ] **Step 2: Verify RED**

Run: `cd lightweaver && node --test src/lib/runtimeMode.test.js && node tests/card-studio-bundle.mjs && node ../firmware/lightweaver-controller/tests/windowless-card-studio-contract.mjs`.

Expected: FAIL because the card target and embedded asset server do not exist.

- [ ] **Step 3: Implement the pruned shared target**

`runtimeMode` returns `{kind:'public-https'|'card-local', transport:'direct-lna'|'local-origin', secureTools:boolean, onlineStudioUrl:'https://led.mandalacodes.com/'}` from origin/capabilities, never browser name. `card-main.jsx` mounts the same `ProjectProvider`/Studio app with local adapters. Secure-only buttons call `window.location.assign` to the bounded HTTPS route.

- [ ] **Step 4: Build and embed deterministic assets**

The builder runs the card Vite input, rejects source maps/external URLs, precompresses assets, hashes exact compressed bytes, writes `card-studio-release.json`, enforces an explicit maximum bundle size, then writes a deterministic PROGMEM table header. Firmware serves `/studio/`, `/studio/card-studio-release.json`, and hashed assets with correct encoding/cache headers. Any hash/range failure redirects `/studio/` to the existing recovery page with safe pattern/brightness/blackout/recovery controls.

- [ ] **Step 5: Verify GREEN and firmware compile**

Run Step 2, `cd lightweaver && npm run build:card`, and `cd firmware/lightweaver-controller && pio run -e esp32-s3-devkitc-1` (or the repository's configured release environment).

Expected: PASS and firmware binary remains within the application slot budget.

### Task 8: Secure single-use encrypted handoff and explicit conflicts

**Files:**
- Create: `lightweaver/src/lib/projectHandoff.js`
- Create: `lightweaver/src/lib/projectHandoff.test.js`
- Create: `lightweaver/functions/api/handoff/_shared/store.js`
- Create: `lightweaver/functions/api/handoff/stage.js`
- Create: `lightweaver/functions/api/handoff/[tokenHash].js`
- Test: `lightweaver/functions/api/handoff/handoff-api.test.js`
- Test: `lightweaver/tests/windowless-project-handoff.spec.ts`

- [ ] **Step 1: Write failing crypto/API contracts**

Tests prove independent 256-bit random lookup token and AES-GCM key, ciphertext-only request bodies, token hash indexing, bounded size/TTL, single-use consume, no plaintext/key in server state, fragment-only token/key, exact-card bind after decrypt/validate, strict top-level public completion, and compare/keep-both/replace for parent-hash conflicts.

- [ ] **Step 2: Verify RED**

Run: `cd lightweaver && node --test src/lib/projectHandoff.test.js functions/api/handoff/handoff-api.test.js && npx playwright test tests/windowless-project-handoff.spec.ts --project=chromium --workers=1`.

Expected: FAIL because handoff client/API do not exist.

- [ ] **Step 3: Implement browser handoff**

```js
const lookupToken = crypto.getRandomValues(new Uint8Array(32));
const keyBytes = crypto.getRandomValues(new Uint8Array(32));
const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
const iv = crypto.getRandomValues(new Uint8Array(12));
const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encodeEnvelope(envelope));
```

Upload `{tokenHash, iv, ciphertext, expiresAt}` only. Navigate current tab to the bounded local `/studio/#handoff=<lookup>.<key>`. Local Studio claims once, decrypts client-side, validates/migrates, checks exact card, and applies explicit conflict resolution. Reverse flow stages ciphertext then top-level navigates to the fixed public origin so only the public origin can use Strict cookies.

- [ ] **Step 4: Implement bounded Pages Functions**

Reject plaintext JSON project shapes, bodies above the project maximum, invalid token hashes, expired records, repeated claims, and non-GET/POST verbs. Store TTL metadata with ciphertext; consume deletes before returning bytes so concurrent claims cannot both succeed.

- [ ] **Step 5: Verify GREEN**

Run Step 2 and existing cloud session tests.

Expected: PASS.

### Task 9: Release-lane integration, regression matrix, and legacy preservation

**Files:**
- Modify: `scripts/ci-changed-lanes.mjs`
- Modify: `scripts/ci-changed-lanes.test.mjs`
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/build-firmware.yml`
- Modify: `scripts/build-firmware-manifest.mjs`
- Modify: `release/firmware-manifest.schema.json`
- Test: `lightweaver/tests/windowless-command-families.mjs`
- Test: `lightweaver/tests/windowless-offline-studio.spec.ts`
- Test: `firmware/lightweaver-controller/tests/windowless-card-studio-contract.mjs`
- Modify: `docs/deployment-checklist.md`

- [ ] **Step 1: Write failing release and command-family contracts**

The command matrix runs Setup, Strip Discovery, Layout/Wire, stage/confirm/install/readback, Patterns, brightness, blackout/Stop, recovery, project repository, and HTTP frames through both `direct-lna` and `local-origin`. It separately proves `legacy-bridge` still passes its existing suite. Release tests prove the combined firmware/local-Studio image identity and hashes are covered by the signed manifest and installer readback contract.

- [ ] **Step 2: Verify RED**

Run: `cd lightweaver && node tests/windowless-command-families.mjs && node ../scripts/ci-changed-lanes.test.mjs && node tests/firmware-image-validation.mjs`.

Expected: FAIL until new targets/files enter release lanes and manifest coverage.

- [ ] **Step 3: Integrate build/release lanes**

Mark `lightweaver/src/**` changes that affect the card target, the card builder, generated bundle, and firmware asset server as firmware-sensitive. Build the card bundle before PlatformIO, include its identity/size/hash list in the signed manifest, and verify exact combined-image offset/hash/size/readback. Do not bump firmware version or sign release artifacts during this Sprint.

- [ ] **Step 4: Document exact unperformed gates**

Update deployment checklist with the real-device matrix from the approved design: macOS Chrome/Edge/Safari, Android Chrome, iPhone Safari/Chrome, iPad Safari, router/AP/no-internet, background/resume/private mode, permission allow/deny/revoke, wrong card/reboot/Wi-Fi handoff, smooth asset serving, physical lights, Stop, install/readback, power-loss injection, and conflict return-online. Mark all as unperformed unless physically observed.

- [ ] **Step 5: Run focused regressions and integrated checkpoint**

Run focused unit/firmware/Playwright commands from Tasks 1–8, then once:

```bash
cd lightweaver
node ../scripts/lightweaver-dev.mjs checkpoint
npm run build:card
node tests/windowless-command-families.mjs
node ../firmware/lightweaver-controller/tests/windowless-card-studio-contract.mjs
```

Expected: all automated checks pass. Do not run release signing, deploy, push, or flash.

### Task 10: Integrated review, workboard evidence, and local commit

**Files:**
- Modify: `LIGHTWEAVER_WORKBOARD.md`
- Review: all files changed since `7bbe57e888545e4f1262976bbb68cb3cffaa7d56`

- [ ] **Step 1: Review the combined diff against every approved-design requirement**

Confirm result-based capability routing, same-tab fallback, zero routine popup in direct/local modes, legacy retention, exact-card authority/revocation, Stop/recovery, physical confirmation ordering, complete editable projects, atomic power-loss behavior, card bundle fallback, offline public start, secure tool handback, and single-use encrypted handoff.

- [ ] **Step 2: Run fresh final verification**

Run the integrated checkpoint from Task 9, production Vite builds, card bundle build, firmware contract set, bounded PlatformIO build, and focused Playwright windowless specs. Record exact pass counts and any environmental skips.

- [ ] **Step 3: Update the workboard**

Replace active ownership rows with completed evidence and add real-card/browser observations to the visual/Bench queue. Do not mark physical or multi-browser gates passed from simulation.

- [ ] **Step 4: Commit the verified batch locally**

```bash
git add LIGHTWEAVER_WORKBOARD.md docs/superpowers/plans/2026-08-09-windowless-offline-studio.md lightweaver firmware scripts .github release docs/deployment-checklist.md
git commit -m "feat: add windowless offline Lightweaver Studio"
```

Do not push, deploy, sign, bump firmware, or flash hardware.

## Self-review against the approved spec

- Runtime/direct probe/same-tab local fallback: Tasks 1 and 7.
- Unified command/frame authority and revocation: Tasks 1, 2, and 9.
- Public PWA/offline/update safety: Task 6.
- Repository seam/IndexedDB/migration/outbox/conflicts: Task 3.
- Atomic card repository/owner capability/quota/power loss: Tasks 4 and 5.
- Shared-source embedded card Studio/recovery/compatibility: Task 7.
- Explicit transfer and secure online handoff: Tasks 5 and 8.
- Legacy bridge preservation and complete regression matrix: Task 9.
- Exact remaining real-device/browser/physical gates: Tasks 9 and 10.
- Deferred Pi and `visitor-ui/` are absent from all ownership and task lists.
