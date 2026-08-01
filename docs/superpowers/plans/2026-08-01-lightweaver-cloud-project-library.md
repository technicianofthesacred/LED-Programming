# Lightweaver Cloud Project Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a private, authenticated, cloud-backed Lightweaver project library with owner/worker roles, immutable history, online autosave, reusable-pattern sync, and individual/master backup restore.

**Architecture:** Keep the existing static Cloudflare Pages Studio and ESP32 command paths unchanged. Add a narrowly routed `/api/library/*` Pages Function, validate Cloudflare Access identity on every request, store project/asset metadata in D1 and immutable JSON bodies in private R2, and integrate it through a React repository/sync layer while preserving the current browser recovery autosave.

**Tech Stack:** React 18, Vite 6, Cloudflare Pages Functions, Cloudflare Access, D1, R2, Web Crypto, Node test runner, Playwright, Wrangler 4.

---

## File structure

- `lightweaver/functions/api/library/[[path]].js` — one Pages catch-all adapter.
- `lightweaver/functions/api/library/_shared/auth.js` — Access JWT validation and owner/worker role projection.
- `lightweaver/functions/api/library/_shared/router.js` — bounded HTTP route/method handling.
- `lightweaver/functions/api/library/_shared/store.js` — D1 metadata and private R2 snapshot operations.
- `lightweaver/functions/api/library/_shared/validation.js` — request/project/asset validation.
- `lightweaver/functions/api/library/_shared/backup.js` — master envelope export/import.
- `lightweaver/functions/api/library/_shared/memoryStore.js` — deterministic API test adapter only.
- `lightweaver/functions/api/library/library-api.test.js` — API, ACL, history, conflict, and backup tests.
- `lightweaver/migrations/0001_cloud_project_library.sql` — additive schema.
- `lightweaver/public/_routes.json` — invoke Functions only for the library API.
- `lightweaver/src/lib/cloudLibraryClient.js` — same-origin API client and typed error/result normalization.
- `lightweaver/src/lib/cloudLibraryClient.test.js` — client contract tests.
- `lightweaver/src/lib/libraryBackup.js` — browser-side backup recognition/file naming.
- `lightweaver/src/lib/libraryBackup.test.js` — backup compatibility tests.
- `lightweaver/src/state/CloudLibraryContext.jsx` — session, list, active remote identity, autosave/retry/conflict state.
- `lightweaver/src/components/projects/ProjectLibraryPanel.jsx` — online library actions and status.
- `lightweaver/src/components/projects/ProjectHistoryDialog.jsx` — revision list and restore.
- `lightweaver/src/v3/app.jsx` — provider and top-bar integration.
- `lightweaver/src/v3/lw-settings.jsx` — mount the single project-library panel.
- `lightweaver/src/lib/workspaceAssets.js` — reusable custom-pattern/Pattern-Lab snapshot adapter.
- `lightweaver/src/lib/workspaceAssets.test.js` — asset round-trip tests.
- `lightweaver/tests/cloud-project-library.spec.ts` — visible end-to-end workflows with an API fixture.
- `lightweaver/tests/cloud-bindings.mjs` — local Wrangler D1/R2 smoke.
- `lightweaver/wrangler.toml`, `package.json`, `package-lock.json`, `.gitignore` — bindings, scripts, and dependency/config safety.
- `lightweaver/tests/pages-staging.mjs`, `.github/workflows/deploy-site.yml`, `docs/deployment-checklist.md`, `docs/led-mandalacodes-setup.md`, `TODO.md` — release gates and operator setup.

### Task 1: Pure API contract, access rules, and backup format

**Files:**
- Create: `lightweaver/functions/api/library/_shared/validation.js`
- Create: `lightweaver/functions/api/library/_shared/memoryStore.js`
- Create: `lightweaver/functions/api/library/_shared/backup.js`
- Create: `lightweaver/functions/api/library/_shared/router.js`
- Create: `lightweaver/functions/api/library/library-api.test.js`

- [ ] **Step 1: Write failing API contract tests**

Cover unauthenticated `401`, worker and owner create/list/open/update, `409` stale `baseRevision`, immutable history, restore-as-new-head, archive/unarchive, worker delete `403`, owner delete, assets, and master backup round-trip. Use a request helper shaped like:

```js
async function call(store, { role = 'worker', email = 'worker@example.test', method = 'GET', path = '/projects', body }) {
  return handleLibraryRequest({
    request: new Request(`https://led.mandalacodes.com/api/library${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json', 'x-lightweaver-request': crypto.randomUUID() } : {},
      body: body ? JSON.stringify(body) : undefined,
    }),
    identity: role ? { email, role, subject: `${role}-subject` } : null,
    store,
  });
}
```

- [ ] **Step 2: Verify the contract is red**

Run: `cd lightweaver && node --test functions/api/library/library-api.test.js`

Expected: FAIL because `handleLibraryRequest`, validation, and the memory store do not exist.

- [ ] **Step 3: Implement validation and the memory repository contract**

Expose these stable interfaces:

```js
export function validatePortableProject(value, { maxBytes }) {}
export function validateWorkspaceAsset(kind, value, { maxBytes }) {}
export function validateMasterBackup(value, { maxBackupBytes, maxEntryBytes }) {}
export function createMemoryLibraryStore(seed = {}) {}
```

The store contract must provide `listProjects`, `createProject`, `readProject`, `updateProject`, `duplicateProject`, `setArchived`, `deleteProject`, `listRevisions`, `restoreRevision`, `readAsset`, `writeAsset`, `exportBackup`, and `importBackup`. Generate IDs with `crypto.randomUUID()`, hash canonical JSON with SHA-256, reject duplicate idempotency keys, and never rewrite a prior revision.

- [ ] **Step 4: Implement the route table and backup envelope**

Use the exact envelope header:

```js
export const LIBRARY_BACKUP_FORMAT = 'lightweaver.library-backup';
export const LIBRARY_BACKUP_VERSION = 1;
```

Every response must include `Cache-Control: no-store`; errors use `{ error: { code, message, requestId } }` with no project content. Authorize owner-only permanent delete in the router even if the store is called directly elsewhere.

- [ ] **Step 5: Run the tests green and commit**

Run: `cd lightweaver && node --test functions/api/library/library-api.test.js`

Expected: all API contract tests pass.

Commit: `git add lightweaver/functions && git commit -m "Build cloud library API contract"`

### Task 2: Cloudflare identity, D1/R2 store, bindings, and local smoke

**Files:**
- Create: `lightweaver/functions/api/library/_shared/auth.js`
- Create: `lightweaver/functions/api/library/_shared/store.js`
- Create: `lightweaver/functions/api/library/[[path]].js`
- Create: `lightweaver/migrations/0001_cloud_project_library.sql`
- Create: `lightweaver/public/_routes.json`
- Create: `lightweaver/tests/cloud-bindings.mjs`
- Modify: `lightweaver/wrangler.toml`
- Modify: `lightweaver/package.json`
- Modify: `lightweaver/package-lock.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write failing auth/store and binding tests**

Add tests proving exact issuer/audience/signature validation, owner projection from normalized `OWNER_EMAILS`, worker projection for other admitted identities, missing-binding `503`, D1/R2 write order, optimistic update failure cleanup, parameterized statements, and private object keys. Add a source/config test that requires:

```json
{ "version": 1, "include": ["/api/library", "/api/library/*"], "exclude": [] }
```

- [ ] **Step 2: Verify red**

Run: `cd lightweaver && node --test functions/api/library/*.test.js tests/cloud-bindings.mjs`

Expected: FAIL because authentication, bindings, schema, and the Function adapter are absent.

- [ ] **Step 3: Implement Access verification and the production store**

Validate `Cf-Access-Jwt-Assertion` with current Access JWKS, exact issuer, exact audience, expiry, and subject. Never trust client role/email headers. The adapter shape is:

```js
export async function onRequest(context) {
  const identity = await authenticateAccessRequest(context.request, context.env);
  const store = createD1R2LibraryStore(context.env, { requestId: crypto.randomUUID() });
  return handleLibraryRequest({ request: context.request, identity, store, params: context.params });
}
```

Use conditional revision updates. Write unique immutable R2 objects before committing metadata; best-effort delete an orphan when the D1 head compare-and-swap loses. Await every binding operation.

- [ ] **Step 4: Add the additive D1 schema and Wrangler bindings**

Create tables for projects, project revisions, asset heads, asset revisions, and library imports. Include foreign keys, unique `(project_id, revision)` and `(asset_kind, revision)` constraints, archive/deletion timestamps, an archived-state field on every project revision for immutable archive history, hash/byte length, actor identity, and idempotency keys. Configure `PROJECTS_DB`, `PROJECT_BLOBS`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OWNER_EMAILS`, and `MAX_LIBRARY_BODY_BYTES` without committing real IDs or identities to source; local tests receive deterministic test configuration.

- [ ] **Step 5: Add local binding smoke and scripts**

Add:

```json
{
  "test:projects": "node --test functions/api/library/library-api.test.js tests/cloud-bindings.mjs",
  "test:cloud-bindings": "node tests/cloud-bindings.mjs"
}
```

The smoke test creates a temporary Wrangler state directory, applies migrations locally, starts `wrangler pages dev` on an ephemeral port, uses a signed test Access JWT through the same verifier, tests one project round-trip and worker-delete rejection, then stops the process.

- [ ] **Step 6: Run green and commit**

Run: `cd lightweaver && npm run test:projects && npm run test:cloud-bindings`

Expected: all API/auth/binding tests pass with no remote resources touched.

Commit: `git add .gitignore lightweaver/functions lightweaver/migrations lightweaver/public/_routes.json lightweaver/tests/cloud-bindings.mjs lightweaver/wrangler.toml lightweaver/package.json lightweaver/package-lock.json && git commit -m "Add private Cloudflare project storage"`

### Task 3: Browser repository, backup recognition, and workspace assets

**Files:**
- Create: `lightweaver/src/lib/cloudLibraryClient.js`
- Create: `lightweaver/src/lib/cloudLibraryClient.test.js`
- Create: `lightweaver/src/lib/libraryBackup.js`
- Create: `lightweaver/src/lib/libraryBackup.test.js`
- Create: `lightweaver/src/lib/workspaceAssets.js`
- Create: `lightweaver/src/lib/workspaceAssets.test.js`
- Modify: `lightweaver/src/lib/customPatterns.js`
- Modify: `lightweaver/src/lib/patternLabStorage.js`

- [ ] **Step 1: Write failing client and asset tests**

Prove JSON/no-store API parsing, `401` sign-in state, `403` permission state, `409` conflict state, request idempotency, individual/master file naming, master-envelope recognition that cannot be mistaken for a project, and complete custom-pattern/revision/Pattern-Lab draft snapshot round-trip.

- [ ] **Step 2: Verify red**

Run: `cd lightweaver && node --test src/lib/cloudLibraryClient.test.js src/lib/libraryBackup.test.js src/lib/workspaceAssets.test.js`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement the same-origin client**

Expose:

```js
export function createCloudLibraryClient({ fetchImpl = fetch, baseUrl = '/api/library' } = {}) {}
export class CloudLibraryError extends Error { constructor(code, message, details = {}) {} }
```

Methods mirror the API. Mutations send `content-type: application/json`, `x-lightweaver-request`, `credentials: 'same-origin'`, and `baseRevision`; downloads return `Blob` without exposing an R2 key.

- [ ] **Step 4: Implement backup and reusable-asset adapters**

Expose `canonicalLibraryBackupFileName(date)`, `isLibraryBackup(value)`, `readWorkspaceAssets(storage)`, and `writeWorkspaceAssets(snapshot, storage)`. Include custom patterns, custom-pattern revisions, and Pattern Lab drafts; validate all collections before any local write. Dispatch one `lw:workspace-assets-changed` event from both custom-pattern and Pattern Lab mutations.

- [ ] **Step 5: Run green and commit**

Run: `cd lightweaver && node --test src/lib/cloudLibraryClient.test.js src/lib/libraryBackup.test.js src/lib/workspaceAssets.test.js src/lib/customPatterns.test.js src/lib/patternLabStorage.test.js`

Expected: all tests pass.

Extend `test:projects` here, after those client files exist, so it covers the server API/auth/store suite plus `src/lib/cloudLibraryClient.test.js`, `src/lib/libraryBackup.test.js`, and `src/lib/workspaceAssets.test.js`.

Commit: `git add lightweaver/src/lib && git commit -m "Add cloud library client and portable workspace assets"`

### Task 4: Online autosave, conflict recovery, and project library UI

**Files:**
- Create: `lightweaver/src/state/CloudLibraryContext.jsx`
- Create: `lightweaver/src/components/projects/ProjectLibraryPanel.jsx`
- Create: `lightweaver/src/components/projects/ProjectHistoryDialog.jsx`
- Modify: `lightweaver/src/v3/app.jsx`
- Modify: `lightweaver/src/v3/lw-settings.jsx`
- Modify: `lightweaver/src/state/ProjectContext.jsx`
- Create: `lightweaver/tests/cloud-project-library.spec.ts`
- Modify: `lightweaver/playwright.config.ts`

- [ ] **Step 1: Write failing visible workflow tests**

Use a deterministic same-origin API fixture to prove: unauthenticated sign-in prompt; worker identity; create and title first online project; cloud autosave after edits; exact `Saved online` state only after acknowledgement; offline `Waiting to save online` with intact local recovery; open/rename/duplicate/archive/unarchive; history restore; conflict actions `Open latest` and `Save as copy`; worker has no delete action; owner delete requires confirmation; browser-library claim; individual import/export; master backup/restore.

- [ ] **Step 2: Verify red**

Run: `cd lightweaver && npx playwright test tests/cloud-project-library.spec.ts --project=chromium --workers=1`

Expected: FAIL because the provider and online library controls do not exist.

- [ ] **Step 3: Implement CloudLibraryContext**

The provider owns session, role, list, active remote project ID, authoritative remote revision, request generation, sync timer, retry, conflict, and asset revision. It consumes `serializeProject`, `replaceProject`, and lifecycle markers from `ProjectContext`. Preserve the 500 ms local recovery effect unchanged. Cloud save is debounced separately and uses a captured project/lifecycle revision; a stale response cannot mark a newer edit saved.

```js
const value = {
  session, projects, activeRemoteProject, syncState,
  createProject, openProject, saveNow, duplicateProject,
  archiveProject, unarchiveProject, deleteProject,
  listHistory, restoreHistory, exportProject, exportMaster,
  restoreMaster, claimBrowserProjects, resolveConflict,
};
```

- [ ] **Step 4: Implement the project library panels**

Show role and identity, search, Active/Archived tabs, last editor/time/revision, online state, and the required actions. Workers may archive but never see Delete. The owner sees permanent Delete only for archived projects and must type the project title. A manual request cannot bypass the server `403`.

- [ ] **Step 5: Integrate the top bar and Preferences**

`Save project` means save online when authenticated and associated with a remote record; otherwise it preserves the existing browser save as a recovery-compatible fallback and opens the sign-in/library guidance. `Export project` remains individual `.lw.json`. Mount one project library panel; remove the duplicate local-only library UI after its claim action remains available.

- [ ] **Step 6: Run green and commit**

Run: `cd lightweaver && npx playwright test tests/cloud-project-library.spec.ts tests/project-recovery-fixtures.spec.ts tests/workflow.spec.ts --project=chromium --workers=1`

Expected: all cloud and existing project recovery/file workflows pass.

Commit: `git add lightweaver/src/state lightweaver/src/components/projects lightweaver/src/v3 lightweaver/tests lightweaver/playwright.config.ts && git commit -m "Connect Studio to the online project library"`

### Task 5: Reusable-pattern online synchronization

**Files:**
- Modify: `lightweaver/src/state/CloudLibraryContext.jsx`
- Modify: `lightweaver/src/pattern-lab/PatternLabScreen.jsx`
- Modify: `lightweaver/src/v3/lw-pattern.jsx`
- Modify: `lightweaver/tests/cloud-project-library.spec.ts`
- Modify: `lightweaver/tests/pattern-lab-authoring.spec.ts`
- Modify: `lightweaver/tests/ai-pattern-assistant.spec.ts`

- [ ] **Step 1: Add failing cross-device asset tests**

Prove that a saved custom pattern, its revisions, and Pattern Lab drafts upload as authenticated workspace assets; a fresh browser loads them before pattern selection; offline changes retry; a stale asset revision becomes an explicit conflict; and master backup/restore includes them.

- [ ] **Step 2: Verify red**

Run: `cd lightweaver && npx playwright test tests/cloud-project-library.spec.ts tests/pattern-lab-authoring.spec.ts tests/ai-pattern-assistant.spec.ts --project=chromium --workers=1`

Expected: the new cross-device tests fail because asset events are local-only.

- [ ] **Step 3: Add asset sync to the cloud provider**

Subscribe to `lw:workspace-assets-changed`, coalesce changes, write with `baseRevision`, and suppress the event loop while applying a server snapshot locally. Never delete a valid local asset because a remote fetch failed. Resolve an asset conflict by keeping both named copies where IDs collide.

- [ ] **Step 4: Run green and commit**

Run the command from Step 2 again.

Expected: all cloud/custom-pattern/Pattern-Lab workflows pass.

Commit: `git add lightweaver/src lightweaver/tests && git commit -m "Sync reusable patterns across Lightweaver devices"`

### Task 6: Deployment gates, infrastructure runbook, and release proof

**Files:**
- Modify: `lightweaver/tests/pages-staging.mjs`
- Modify: `lightweaver/tests/pages-headers.mjs`
- Modify: `lightweaver/scripts/check-prod-freshness.mjs`
- Modify: `lightweaver/package.json`
- Modify: `.github/workflows/test.yml`
- Modify: `.github/workflows/deploy-site.yml`
- Modify: `docs/deployment-checklist.md`
- Modify: `docs/led-mandalacodes-setup.md`
- Modify: `TODO.md`

- [ ] **Step 1: Write failing release-contract assertions**

Require the staged `_routes.json`, Functions build, exact API `no-store` behavior, migration-before-deploy step, separate least-privilege migration credential, preview/prod binding names, unauthenticated denial smoke, worker delete denial smoke, and explicit proof that no card URL routes through `/api/library`.

- [ ] **Step 2: Verify red**

Run: `cd lightweaver && node tests/pages-headers.mjs && node tests/pages-staging.mjs && npm run test:cloud-bindings`

Expected: release assertions fail until scripts/workflows/docs are integrated.

- [ ] **Step 3: Integrate build and CI gates**

Add `npm run test:projects` and `npm run test:cloud-bindings` to `launch:source`. Build Functions during staging verification. CI applies local migrations for tests; production applies remote additive migrations before deploying compatible Functions. Do not grant the normal Pages deploy token broader D1 administrative access; document a separate migration credential.

- [ ] **Step 4: Document one-time Cloudflare setup without secret values**

Document exact resource names, bindings, Access path `/api/library*`, exact-email allow policy, owner identity variable, fail-closed Functions behavior, disabled R2 public access, local/preview/prod migration commands, backup restore smoke, rollback limits, and logout URL. Never print or commit tokens, account IDs, audience IDs, real email addresses, or bucket credentials.

- [ ] **Step 5: Run focused verification**

Run:

```bash
cd lightweaver
npm run test:projects
npm run test:cloud-bindings
npx playwright test tests/cloud-project-library.spec.ts tests/project-recovery-fixtures.spec.ts tests/workflow.spec.ts tests/pattern-lab-authoring.spec.ts tests/ai-pattern-assistant.spec.ts --project=chromium --workers=1
npm run build
npm run stage:pages
npm run verify:pages
```

Expected: every command exits 0.

- [ ] **Step 6: Run the full source launch gate**

Run: `cd lightweaver && npm run launch:source`

Expected: exit 0 with no failed tests or build steps. Do not run `launch:check` until the protected signed `main` firmware release commit is the integration target.

- [ ] **Step 7: Preview and production proof**

Provision and migrate preview resources, deploy to a non-main Pages branch, and prove authenticated create/edit/history/backup plus unauthenticated denial. Only after that proof, migrate production, deploy the exact verified commit, and re-run the same smoke against `https://led.mandalacodes.com`.

- [ ] **Step 8: Commit release integration**

Commit: `git add .github lightweaver docs TODO.md && git commit -m "Gate and document the private project library"`

## Self-review result

- The tasks cover every design requirement: authentication, roles, cloud persistence, local recovery, conflicts, history, archive/delete, reusable patterns, individual/master backups, migration, release verification, and unchanged local card control.
- No implementation step depends on a secret value in source.
- API/client method names and backup format are consistent across tasks.
- Client sharing, public discovery, comments, and per-project worker permissions remain excluded.
