# Footer Build Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crowded footer with concise card, firmware-release, Studio-build and test-strip status while enforcing firmware semantic-version progression beginning at 1.1.0.

**Architecture:** Installer-core gains a manifest-only signed-release loader reused by the full image loader. A pure Studio classifier converts installed and released firmware identities into display states; the footer renders those states and routes outdated cards into the existing installer. Firmware compilation and signing read one canonical version file, with a helper and CI contract preventing unchanged or decreasing versions.

**Tech Stack:** React, Vite, Node test runner, Playwright, PlatformIO/SCons, GitHub Actions, Web Crypto ECDSA.

---

### Task 1: Verify signed firmware metadata without downloading the image

**Files:**
- Modify: `packages/installer-core/src/firmware-release.js`
- Modify: `lightweaver/src/lib/firmwareRelease.test.js`

- [ ] **Step 1: Write failing manifest-only loader tests**

Add tests that call `loadProductionFirmwareManifest(fetchImpl, cryptoImpl)` with fixture manifest/signature responses and assert it returns the validated manifest without requesting `manifest.image.url`. Add tampered-signature, redirect, malformed-build-number and unavailable-manifest cases.

```js
const manifest = await loadProductionFirmwareManifest(fetchImpl, cryptoImpl);
assert.equal(manifest.buildNumber, 1154);
assert.deepEqual(calls, [
  '/firmware/release-manifest.json',
  '/firmware/release-manifest.sig',
]);
```

- [ ] **Step 2: Run the focused test and witness RED**

Run: `node --test lightweaver/src/lib/firmwareRelease.test.js`  
Expected: FAIL because `loadProductionFirmwareManifest` is not exported.

- [ ] **Step 3: Extract the signed-manifest boundary**

Implement:

```js
export async function loadProductionFirmwareManifest(
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  options = {},
) {
  // Resolve fixed production paths, fetch no-store with omitted credentials
  // and redirect rejection, verify pinned ECDSA signature, validate manifest,
  // then return the manifest without fetching image.url.
}
```

Refactor `loadProductionFirmwareRelease` to call the new function before fetching, bounding and hashing the image. Preserve every existing error and target check.

- [ ] **Step 4: Run focused release tests GREEN**

Run: `node --test lightweaver/src/lib/firmwareRelease.test.js`  
Expected: all firmware-release tests pass.

- [ ] **Step 5: Commit the release-loader boundary**

```bash
git add packages/installer-core/src/firmware-release.js lightweaver/src/lib/firmwareRelease.test.js
git commit -m "Verify firmware metadata without downloading images"
```

### Task 2: Classify installed card firmware against the signed release

**Files:**
- Create: `lightweaver/src/lib/footerFirmwareStatus.js`
- Create: `lightweaver/src/lib/footerFirmwareStatus.test.js`

- [ ] **Step 1: Write the complete classifier matrix RED**

Cover exact current identity, older card, same number/different build ID, legacy build zero, newer development build, malformed evidence, missing release and disconnected card.

```js
assert.deepEqual(classifyFooterFirmwareStatus(
  { buildNumber: 1123, buildId: 'a'.repeat(40) },
  { buildNumber: 1154, buildId: 'b'.repeat(40) },
), {
  state: 'update-available',
  installedBuildNumber: 1123,
  releaseBuildNumber: 1154,
  label: 'Card 1123 → 1154',
  actionable: true,
});
```

- [ ] **Step 2: Run focused classifier test RED**

Run: `node --test lightweaver/src/lib/footerFirmwareStatus.test.js`  
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement one pure fail-closed classifier**

Export `classifyFooterFirmwareStatus(installed, release)` and return only bounded display data. Exact `current` requires both build number and 40-character build ID equality. A greater installed number returns `development-build`, never an update action. Missing verified release returns `release-unknown`.

- [ ] **Step 4: Run focused classifier test GREEN**

Run: `node --test lightweaver/src/lib/footerFirmwareStatus.test.js`  
Expected: all matrix cases pass.

- [ ] **Step 5: Commit the classifier**

```bash
git add lightweaver/src/lib/footerFirmwareStatus.js lightweaver/src/lib/footerFirmwareStatus.test.js
git commit -m "Classify footer firmware release status"
```

### Task 3: Enforce one progressing firmware semantic version

**Files:**
- Create: `firmware/lightweaver-controller/VERSION`
- Create: `firmware/lightweaver-controller/scripts/firmware-version.mjs`
- Create: `firmware/lightweaver-controller/tests/firmware-version-policy.mjs`
- Modify: `firmware/lightweaver-controller/platformio.ini`
- Modify: `firmware/lightweaver-controller/scripts/inject-build-identity.py`
- Modify: `firmware/lightweaver-controller/src/main.cpp`
- Modify: `firmware/lightweaver-controller/src/LightweaverStorage.cpp`
- Modify: `.github/workflows/build-firmware.yml`
- Modify: `lightweaver/package.json`

- [ ] **Step 1: Write the version-policy contract RED**

Require canonical `VERSION` content `1.1.0`; require the injector and signer workflow to read that file; reject duplicated release literals in PlatformIO; and exercise helper outputs for patch/minor/major plus malformed or decreasing versions.

```js
assert.equal(readFileSync(versionPath, 'utf8').trim(), '1.1.0');
assert.match(workflow, /firmware\/lightweaver-controller\/VERSION/);
assert.doesNotMatch(platformio, /LW_FIRMWARE_VERSION=.*1\.0\.0/);
```

- [ ] **Step 2: Run the contract RED**

Run: `node firmware/lightweaver-controller/tests/firmware-version-policy.mjs`  
Expected: FAIL because canonical VERSION and helper are absent.

- [ ] **Step 3: Add canonical version injection**

Set `VERSION` to `1.1.0`. Make `inject-build-identity.py` validate the file with strict semantic version syntax and append `LW_FIRMWARE_VERSION` alongside build ID/number. Remove the PlatformIO hard-coded version flag. Keep C++ fallback literals only for non-PlatformIO safety and require tests to identify them as fallbacks.

- [ ] **Step 4: Add the bump helper and package commands**

Implement a script supporting:

```text
node firmware-version.mjs bump patch  # 1.1.0 -> 1.1.1
node firmware-version.mjs bump minor  # 1.1.0 -> 1.2.0
node firmware-version.mjs bump major  # 1.1.0 -> 2.0.0
node firmware-version.mjs check --previous 1.0.0
```

Expose `firmware:bump` and `firmware:version:check` scripts without allowing malformed or decreasing versions.

- [ ] **Step 5: Make protected signing consume and enforce VERSION**

Read `FW_VERSION` from the canonical file before the tested compile and signed build. Compare it with the previously signed manifest on firmware-sensitive changes and fail before signing if it is unchanged or lower. Pass the exact same version into compile and manifest generation.

- [ ] **Step 6: Run policy and firmware identity tests GREEN**

Run:

```bash
node firmware/lightweaver-controller/tests/firmware-version-policy.mjs
node firmware/lightweaver-controller/tests/release-build-identity.mjs
node firmware/lightweaver-controller/tests/card-identity-capabilities.mjs
```

Expected: all pass.

- [ ] **Step 7: Compile ESP32-S3 firmware**

Run: `pio run -d firmware/lightweaver-controller -e esp32-s3-n16r8`  
Expected: successful build reporting the injected 1.1.0 source version.

- [ ] **Step 8: Commit version enforcement**

```bash
git add .github/workflows/build-firmware.yml lightweaver/package.json firmware/lightweaver-controller
git commit -m "Enforce progressing firmware versions"
```

### Task 4: Replace the footer with actionable build status

**Files:**
- Create: `lightweaver/src/hooks/useFirmwareReleaseIdentity.js`
- Create: `lightweaver/src/hooks/useFirmwareReleaseIdentity.test.js`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/components/card/CardStatusControl.jsx`
- Modify: `lightweaver/src/v3/v3-styles.css`
- Create: `lightweaver/tests/footer-build-status.spec.ts`

- [ ] **Step 1: Write hook lifecycle tests RED**

Test initial loading, verified manifest success, failure to `release-unknown`, online retry and a refresh token representing a newer Studio deployment. Mock only `loadProductionFirmwareManifest` and assert stale promises cannot overwrite newer state.

- [ ] **Step 2: Implement `useFirmwareReleaseIdentity`**

Return `{ state, manifest, error }`, abort/supersede stale loads, listen for `online`, and accept a Studio freshness identity key so a new deployed revision reloads the no-store signed manifest.

- [ ] **Step 3: Write browser footer states RED**

Mock card-link and signed-release evidence. Assert the footer contains only card, firmware, Studio and Test strip controls; removed telemetry is absent. Cover:

```ts
await expect(page.getByTestId('footer-firmware-status')).toHaveText('Card 1123 → 1154');
await expect(page.getByTestId('studio-freshness')).toContainText('Studio 1155');
await expect(page.locator('.status-bar')).not.toContainText('GPIO');
await expect(page.locator('.status-bar')).not.toContainText('density');
```

- [ ] **Step 4: Render the reduced footer**

Keep `CardStatusControl` to name and state; remove `connectedSummary`. Add the firmware classifier output beside it. Preserve full build IDs and failure reasons in accessible descriptions. Keep Studio label concise and expand Test strip only when active.

- [ ] **Step 5: Route update actions safely**

Pass an `onOpenFirmwareUpdate` callback from Shell that opens `#screen=card&section=flash` through existing card navigation. The footer must not call Web Serial, download firmware or mutate card state.

- [ ] **Step 6: Implement desktop and phone layouts**

Desktop: one row. Under existing responsive breakpoints, never hide firmware or Studio identities; compact accessible labels and move Test strip to a second row only when needed. Remove obsolete fact/divider CSS.

- [ ] **Step 7: Run focused footer and hook tests GREEN**

Run:

```bash
node --test lightweaver/src/hooks/useFirmwareReleaseIdentity.test.js
npx playwright test lightweaver/tests/footer-build-status.spec.ts --project=chromium --workers=1
```

Expected: all state, routing and responsive cases pass.

- [ ] **Step 8: Commit the footer**

```bash
git add lightweaver/src/hooks/useFirmwareReleaseIdentity.js lightweaver/src/hooks/useFirmwareReleaseIdentity.test.js lightweaver/src/v3/app.jsx lightweaver/src/components/card/CardStatusControl.jsx lightweaver/src/v3/v3-styles.css lightweaver/tests/footer-build-status.spec.ts
git commit -m "Show card and Studio builds in the footer"
```

### Task 5: Integrated verification and browser proof

**Files:**
- Modify only if a verified integration defect requires correction.

- [ ] **Step 1: Run focused source gates**

```bash
node --test lightweaver/src/lib/footerFirmwareStatus.test.js lightweaver/src/lib/firmwareRelease.test.js lightweaver/src/hooks/useFirmwareReleaseIdentity.test.js
node firmware/lightweaver-controller/tests/firmware-version-policy.mjs
```

- [ ] **Step 2: Run normal application gates**

```bash
cd lightweaver
npm run test:unit
npm run build
```

Expected: 1,309 or more unit tests pass and Vite production build succeeds.

- [ ] **Step 3: Run firmware compile and core release gate**

```bash
pio run -d firmware/lightweaver-controller -e esp32-s3-n16r8
cd lightweaver && npm run test:core
```

- [ ] **Step 4: Verify the actual desktop and phone footer in the browser**

At desktop width confirm card, firmware, Studio and Test strip are one row. At 390×844 confirm build identities remain visible, Test strip wraps without horizontal overflow, and the outdated action reaches Install or update without opening Web Serial.

- [ ] **Step 5: Review the integrated diff and commit only genuine fixes**

Run `git diff --check`, inspect `origin/main...HEAD`, and preserve unrelated user changes. Do not flash or mark any physical hardware gate passed.
