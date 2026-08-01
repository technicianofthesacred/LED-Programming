# Lightweaver Account Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Lightweaver library email allowlist with owner-created username/password accounts and fixed Owner, Worker, and Customer access.

**Architecture:** Native accounts and hashed sessions live in the existing production D1 database. The existing D1/R2 project store stays intact; nullable draft ownership fields let customer drafts reuse the current project/revision machinery. Cloudflare Access remains as a temporary owner bootstrap path until native login and authorization pass production checks, then the Access path rule is removed.

**Tech Stack:** Cloudflare Pages Functions, D1, R2, Web Crypto, React 18, Node test runner, Playwright

---

## File map

- Create `lightweaver/migrations/0002_account_access.sql` for accounts, sessions, assignments, and draft markers.
- Create `lightweaver/functions/api/library/_shared/accountAuth.js` for password hashing, session cookies, and native-session authentication.
- Create `lightweaver/functions/api/library/_shared/accountStore.js` for account/session D1 operations.
- Create `lightweaver/functions/api/account/[[path]].js` for public login/session/password/logout endpoints.
- Modify `lightweaver/functions/api/library/[[path]].js` to accept native sessions and retain Access only for initial owner bootstrap.
- Modify `lightweaver/functions/api/library/_shared/router.js` for account administration, assignments, promotion, and the fixed role matrix.
- Modify `lightweaver/functions/api/library/_shared/store.js` and `memoryStore.js` for identity-filtered queries and customer draft promotion.
- Modify `lightweaver/src/lib/cloudLibraryClient.js` and `CloudLibraryContext.jsx` for login, logout, password change, account administration, assignments, and promotion.
- Create `lightweaver/src/components/projects/AccountAccessPanel.jsx` for the owner account table/form.
- Modify `lightweaver/src/components/projects/ProjectLibraryPanel.jsx` for login and role-specific project controls.
- Expand the existing cloud library unit and Playwright suites; update deployment contracts only after native auth passes.

### Task 1: Native credential and session core

**Files:**
- Create: `lightweaver/migrations/0002_account_access.sql`
- Create: `lightweaver/functions/api/library/_shared/accountAuth.js`
- Create: `lightweaver/functions/api/library/_shared/accountStore.js`
- Create: `lightweaver/functions/api/library/_shared/accountAuth.test.js`
- Modify: `lightweaver/package.json`

- [ ] **Step 1: Write failing credential/session tests**

Cover normalized unique usernames, fixed roles, minimum 12-character passwords, versioned salted password hashes, constant generic login errors, hashed opaque session tokens, forced password change, expiry, reset revocation, disabled-account denial, and short failed-login lockout. Tests use a low injected PBKDF2 iteration count while production uses the exported production count.

```js
test('creates and verifies a versioned password hash without storing plaintext', async () => {
  const encoded = await hashPassword('temporary-passphrase', { iterations: 1000 });
  assert.match(encoded, /^pbkdf2-sha256\$/);
  assert.equal(encoded.includes('temporary-passphrase'), false);
  assert.equal(await verifyPassword('temporary-passphrase', encoded), true);
  assert.equal(await verifyPassword('wrong-passphrase', encoded), false);
});

test('authenticates only an active unexpired session and returns the fixed role', async () => {
  const session = await accounts.createSession(activeWorker.id);
  assert.deepEqual((await accounts.authenticateSession(session.token)).role, 'worker');
  await accounts.disableAccount(activeWorker.id);
  assert.equal(await accounts.authenticateSession(session.token), null);
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `cd lightweaver && node --test functions/api/library/_shared/accountAuth.test.js`

Expected: failure because the account authentication modules do not exist.

- [ ] **Step 3: Add the additive schema**

Create accounts with normalized username uniqueness, `owner|worker|customer` role checks, active state, `must_change_password`, failed-attempt and lock timestamps; sessions store only SHA-256 token hashes; assignments uniquely pair customer and official project; projects gain nullable `draft_of_project_id` and `draft_owner_account_id` columns plus indexes.

- [ ] **Step 4: Implement the minimal authentication core**

Use Web Crypto PBKDF2-SHA256 with a random 16-byte salt and versioned encoding. Generate 32 random session bytes, return the raw token only once, persist only its SHA-256 digest, and serialize it as:

```http
Set-Cookie: __Host-lightweaver_session=<token>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800
```

Expose focused store methods: `createAccount`, `listAccounts`, `resetPassword`, `setAccountStatus`, `setAccountRole`, `verifyLogin`, `createSession`, `authenticateSession`, `revokeSession`, and `changePassword`.

- [ ] **Step 5: Run GREEN verification**

Run: `cd lightweaver && node --test functions/api/library/_shared/accountAuth.test.js`

Expected: all native credential/session tests pass.

- [ ] **Step 6: Commit**

```bash
git add lightweaver/migrations/0002_account_access.sql lightweaver/functions/api/library/_shared/accountAuth.js lightweaver/functions/api/library/_shared/accountStore.js lightweaver/functions/api/library/_shared/accountAuth.test.js lightweaver/package.json
git commit -m "Add native Lightweaver account sessions"
```

### Task 2: Login and owner account administration API

**Files:**
- Create: `lightweaver/functions/api/account/[[path]].js`
- Modify: `lightweaver/functions/api/library/[[path]].js`
- Modify: `lightweaver/functions/api/library/_shared/router.js`
- Modify: `lightweaver/functions/api/library/library-api.test.js`
- Modify: `lightweaver/tests/cloud-bindings.mjs`

- [ ] **Step 1: Write failing API tests**

Add real request tests for `POST /api/account/login`, `GET /api/account/session`, `POST /api/account/password`, and `POST /api/account/logout`. Add owner-only tests for account list/create/reset/disable/role update and one-time first-owner bootstrap through a currently verified Access owner. Verify customers and workers receive `403` for all account administration routes.

```js
test('owner creates a worker with a forced temporary password', async () => {
  const response = await callAs(owner, '/accounts', {
    method: 'POST',
    body: { username: 'workshop', displayName: 'Workshop', role: 'worker', temporaryPassword: 'temporary-passphrase' },
  });
  assert.equal(response.status, 201);
  assert.equal(response.payload.account.mustChangePassword, true);
  assert.equal('passwordHash' in response.payload.account, false);
});

test('unknown username and incorrect password return the same response', async () => {
  assert.deepEqual(await login('missing', 'wrong-passphrase'), await login('workshop', 'wrong-passphrase'));
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `cd lightweaver && node --test functions/api/library/library-api.test.js tests/cloud-bindings.mjs`

Expected: new routes fail with 404 or missing exports.

- [ ] **Step 3: Implement public account routes**

Require JSON and exact same-origin `Origin` for mutations. Login sets the host-only session cookie; logout clears and revokes it; session returns `{ username, displayName, role, mustChangePassword }`; password change is the only authenticated action permitted while `mustChangePassword` is true.

- [ ] **Step 4: Implement owner account routes and bootstrap**

Add `/api/library/accounts` list/create and `/api/library/accounts/:id` reset/status/role mutations. Add a bootstrap route that succeeds only for the existing verified Access owner and only while no native owner exists. Never return hashes, raw session tokens, or stored temporary credentials.

- [ ] **Step 5: Resolve identity in safe order**

Library requests first authenticate the native session. During rollout only, fall back to the verified Access assertion for bootstrap and current-owner continuity. Native identities use `{ accountId, username, displayName, role, mustChangePassword, subject }`; mutation audit labels use display name plus username.

- [ ] **Step 6: Run GREEN verification and commit**

Run: `cd lightweaver && node --test functions/api/library/library-api.test.js tests/cloud-bindings.mjs functions/api/library/_shared/accountAuth.test.js`

Expected: all account and existing library API tests pass.

```bash
git add lightweaver/functions/api/account lightweaver/functions/api/library lightweaver/tests/cloud-bindings.mjs
git commit -m "Add Lightweaver account login and administration"
```

### Task 3: Customer assignments and isolated drafts

**Files:**
- Modify: `lightweaver/functions/api/library/_shared/router.js`
- Modify: `lightweaver/functions/api/library/_shared/store.js`
- Modify: `lightweaver/functions/api/library/_shared/memoryStore.js`
- Modify: `lightweaver/functions/api/library/library-api.test.js`
- Modify: `lightweaver/tests/cloud-bindings.mjs`

- [ ] **Step 1: Write the failing role and draft matrix tests**

Test that workers retain the shared library but cannot permanently delete or manage accounts. Test that customers see only assigned draft records, can read/update their own draft and its history, and receive `403` for create, duplicate, archive, backup, restore, workspace assets, other customers' drafts, and official projects. Test owner assignment creates one reusable draft and promotion adds a new official revision without deleting history.

```js
test('customer update changes only the assigned draft', async () => {
  const before = await store.readProject({ id: official.id, identity: owner });
  await store.updateProject({ id: draft.id, project: customerEdit, identity: customer, baseRevision: 1 });
  const after = await store.readProject({ id: official.id, identity: owner });
  assert.deepEqual(after.project, before.project);
});

test('owner promotion appends the draft to official history', async () => {
  const promoted = await store.promoteDraft({ draftId: draft.id, actor: owner, baseRevision: official.revision });
  assert.equal(promoted.revision, official.revision + 1);
  assert.equal((await store.listRevisions({ id: official.id, identity: owner })).length, 2);
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `cd lightweaver && node --test functions/api/library/library-api.test.js tests/cloud-bindings.mjs`

Expected: assignment, filtering, and promotion assertions fail.

- [ ] **Step 3: Add server-authoritative role checks**

Centralize `requireOwner`, `requireSharedLibraryRole`, and customer project checks in the router/store boundary. Customer project queries join `project_assignments` and require matching `draft_owner_account_id`. Do not rely on hidden browser controls.

- [ ] **Step 4: Reuse projects for customer drafts**

When the owner assigns an official project, clone its current payload once into a project marked with `draft_of_project_id` and `draft_owner_account_id`. Owner/worker shared-library lists exclude drafts; the owner review query can include them. Promotion copies the draft payload into the official project through the existing revision-safe update path.

- [ ] **Step 5: Run GREEN verification and commit**

Run: `cd lightweaver && node --test functions/api/library/library-api.test.js tests/cloud-bindings.mjs`

Expected: all role, draft, project, backup, D1, and R2 tests pass.

```bash
git add lightweaver/functions/api/library lightweaver/tests/cloud-bindings.mjs
git commit -m "Add customer project drafts and assignments"
```

### Task 4: Minimal account and customer interface

**Files:**
- Create: `lightweaver/src/components/projects/AccountAccessPanel.jsx`
- Modify: `lightweaver/src/components/projects/ProjectLibraryPanel.jsx`
- Modify: `lightweaver/src/lib/cloudLibraryClient.js`
- Modify: `lightweaver/src/lib/cloudLibraryClient.test.js`
- Modify: `lightweaver/src/state/CloudLibraryContext.jsx`
- Modify: `lightweaver/tests/cloud-project-library.spec.ts`
- Modify: `lightweaver/src/styles.css` or the existing project-library stylesheet actually used by the component

- [ ] **Step 1: Write failing client and browser tests**

Cover username/password login, forced password change, logout, owner account creation/reset/disable, worker delete denial, customer assigned-only list, customer draft label, owner draft review, and promotion. The browser fixture must enforce the API role matrix rather than merely hiding buttons.

```js
test('customer sees the assigned draft without shared library controls', async ({ page }) => {
  await fixture.signInAs('customer');
  await page.goto('/#screen=card&section=preferences');
  await expect(page.getByText('Editing your draft')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download master backup' })).toHaveCount(0);
  await expect(page.getByText('Unassigned artwork')).toHaveCount(0);
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `cd lightweaver && node --test src/lib/cloudLibraryClient.test.js && npx playwright test tests/cloud-project-library.spec.ts --project=chromium --workers=1`

Expected: new account and customer UI assertions fail.

- [ ] **Step 3: Implement the account client and context state**

Add typed validation for `{ username, displayName, role, mustChangePassword }` and methods for login, logout, password change, account CRUD, assignment, draft listing, and promotion. Keep all requests same-origin with credentials included.

- [ ] **Step 4: Implement the compact UI**

Signed-out: username/password form. Forced-change: current temporary password is represented by the authenticated session; request and confirm a new password. Owner: one account table plus create/reset/enable/disable/role/assignment controls. Customer: assigned drafts only, explicit `Editing your draft` copy, and no shared-library or backup controls. Owner: `Review draft` and `Apply to main as new revision` actions.

- [ ] **Step 5: Run GREEN verification and commit**

Run: `cd lightweaver && node --test src/lib/cloudLibraryClient.test.js && npx playwright test tests/cloud-project-library.spec.ts --project=chromium --workers=1 && npm run build`

Expected: account client tests, all cloud-library browser tests, and production build pass.

```bash
git add lightweaver/src lightweaver/tests/cloud-project-library.spec.ts
git commit -m "Add account and customer draft controls"
```

### Task 5: Deployment contract, cutover, and complete verification

**Files:**
- Modify: `lightweaver/public/_routes.json`
- Modify: `lightweaver/tests/pages-staging.mjs`
- Modify: `lightweaver/tests/pages-headers.mjs`
- Modify: `lightweaver/scripts/require-cloud-library-production.mjs`
- Modify: `lightweaver/scripts/deploy-pages-production.mjs`
- Modify: `.github/workflows/deploy-site.yml`
- Modify: `lightweaver/package.json`
- Modify: `docs/deployment-checklist.md`
- Modify: `docs/led-mandalacodes-setup.md`
- Modify: `docs/superpowers/plans/2026-08-01-account-access.md`

- [x] **Step 1: Write failing deployment-contract tests**

Assert `/api/account/*` is included in Pages Functions, sensitive account/library responses are `no-store`, production migrations include `0002_account_access.sql`, unauthenticated project routes return `401`, and production no longer requires `OWNER_EMAILS` after the explicit cutover flag is confirmed.

- [x] **Step 2: Run tests and confirm RED**

Run: `cd lightweaver && node tests/pages-headers.mjs && node tests/pages-staging.mjs && node scripts/require-cloud-library-production.mjs`

Expected: account routes and native-auth deployment requirements are missing.

- [x] **Step 3: Update deployment safety gates**

Deploy the additive migration before code, require a confirmed native-auth readiness variable before removing Access requirements, and preserve fail-closed behavior when D1 is unavailable. Document bootstrap, owner recovery, account reset, role checks, preview acceptance, production cutover, and rollback.

- [x] **Step 4: Run focused and full verification**

Run:

```bash
cd lightweaver
npm run test:projects
npx playwright test tests/cloud-project-library.spec.ts --project=chromium --workers=1
npm run build
npm run launch:check
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Production cutover and smoke test**

Apply migrations 0002 and 0003, deploy dual-auth code, bootstrap the owner account through the existing Access session, and verify all three roles in preview. Then remove the `/api/account*` and `/api/library*` Access application rules, set `LIGHTWEAVER_NATIVE_AUTH_READY=confirmed`, and redeploy so native login can reach the API without the legacy Access settings. Verify signed-out denial, owner account administration, worker create/edit and delete denial, customer assignment isolation, draft save, promotion, logout, and master backup.

- [x] **Step 6: Commit final deployment changes**

```bash
git add .github/workflows/deploy-site.yml lightweaver/public lightweaver/tests lightweaver/scripts docs/deployment-checklist.md docs/superpowers/plans/2026-08-01-account-access.md
git commit -m "Prepare native account access deployment"
```
