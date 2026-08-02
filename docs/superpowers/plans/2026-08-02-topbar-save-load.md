# Top-Bar Save and Load Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Lightweaver's file-only top-bar import and persistent breadcrumb status chip with destination-aware Save, a compact online-first Load dialog, and event-driven artboard notices.

**Architecture:** Keep `CloudLibraryContext` as the only owner of online create/open/save semantics so account visibility, customer drafts, stale-read protection, replacement confirmation, and revision conflicts remain unchanged. Add focused top-bar dialog and notice components, with `Shell` coordinating the existing browser-project fallback and local project-file replacement path. Extend the existing Playwright cloud-library fixture and reconcile lifecycle tests that currently depend on the removed breadcrumb chip.

**Tech Stack:** React 18, Vite, Playwright, Node test runner, existing Lightweaver cloud-library and project-lifecycle APIs.

---

## File map

- Create `lightweaver/src/components/projects/TopBarProjectDialogs.jsx`: compact Load and first-online-Save dialogs using the existing dialog portal.
- Create `lightweaver/src/components/projects/WorkspaceNotice.jsx`: dismissible artboard notice with transient timeout behavior.
- Modify `lightweaver/src/v3/app.jsx`: keep exactly five actions; coordinate dialogs, local-file import, destination-aware Save, and cloud/lifecycle notice events.
- Modify `lightweaver/src/v3/v3-styles.css`: remove breadcrumb chip styling and add shell-level notice placement.
- Modify `lightweaver/src/v3/v3-screens.css`: style compact dialogs, project rows, phone touch targets, and notice tones.
- Modify `lightweaver/tests/cloud-project-library.spec.ts`: cover Load, Save destinations, customer drafts, notices, focus, and phone geometry.
- Modify `lightweaver/tests/pattern-lab-isolation.spec.ts`: change the five-action contract from Import to Load and retain 320/390 px overflow checks.
- Modify existing `.savechip` consumers in `lightweaver/tests/{project-recovery-fixtures,studio-hardening,card-workspace,layout-send-to-card,workflow,patterns-v3}.spec.ts` to assert the underlying behavior or event notice.

### Task 1: Lock the five-action and compact Load contract

**Files:**
- Create: `lightweaver/src/components/projects/TopBarProjectDialogs.jsx`
- Modify: `lightweaver/src/v3/app.jsx:223-255,350-690`
- Modify: `lightweaver/src/v3/v3-styles.css:171-235,730-825`
- Modify: `lightweaver/src/v3/v3-screens.css:841-925`
- Test: `lightweaver/tests/cloud-project-library.spec.ts`
- Test: `lightweaver/tests/pattern-lab-isolation.spec.ts`

- [ ] **Step 1: Write failing browser tests for Load**

Add a test that seeds two active projects and one archived project, then proves the dialog is active-only, searchable, and opens through the existing safe replacement path:

```ts
test('Load opens a compact searchable active-project list and opens safely', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  fixture.seed('Gallery One');
  fixture.seed('Gallery Two');
  fixture.seed('Archived Study', { archived: true });
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  await page.getByRole('button', { name: 'Load project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Load project' });
  await expect(dialog.getByText('Archived Study', { exact: true })).toHaveCount(0);
  await dialog.getByRole('searchbox', { name: 'Search online projects' }).fill('Two');
  await expect(dialog.getByText('Gallery One', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Open Gallery Two' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.crumb .proj')).toHaveText('Gallery Two');
});
```

Add separate tests that: focus the Load trigger, close with Escape, and verify focus restoration; reopen and use `setInputFiles` on `data-testid="topbar-project-import"` to replace the workspace and detach the remote association; and show signed-out guidance plus `Open Preferences` without exposing project rows.

- [ ] **Step 2: Run the Load tests and verify RED**

```bash
cd lightweaver
npx playwright test tests/cloud-project-library.spec.ts tests/pattern-lab-isolation.spec.ts --project=chromium --workers=1 --grep "Load|compact project actions"
```

Expected: FAIL because the action is still `Import project` and no Load dialog exists.

- [ ] **Step 3: Implement `ProjectLoadDialog` with existing APIs**

Create `TopBarProjectDialogs.jsx`. Its public API is:

```jsx
export function ProjectLoadDialog({ open, onClose, onImportFromComputer, onOpenPreferences })
```

Inside it, use `useCloudLibrary()`, `library.activeProjects`, a local search query, and `library.openProject(project)`. On `{ ok: true }`, close; on `cancelled` or `superseded`, stay quiet; on other failures show `result.error?.message || 'That project could not be opened.'`. Render through `CloudLibraryDialogPortal` with `dialogRef`, a labelled Close control as `initialFocusRef`, `role="dialog"`, `aria-modal="true"`, and `aria-labelledby="topbar-load-title"`.

The authenticated body contains only search, active rows, and one Open button per row. The signed-out body reads `Sign in to load online projects`, explains account access stays in Preferences, and exposes `Open Preferences`. The footer contains only `Import from computer` and a hidden `.lw.json/.lwproj.json/.json` input. Do not mount `ProjectLibraryPanel`.

In `app.jsx`, rename the second action to `Load project`, open this dialog, and keep the current `replaceProject`/`detachProject` file flow behind its import button. Keep `cloudLibrary.openProject` unchanged.

- [ ] **Step 4: Add compact and phone-safe styling**

```css
.topbar-project-dialog { width: min(440px, 100%); }
.topbar-project-search { width: 100%; margin-top: 14px; }
.topbar-project-list { display: grid; gap: 5px; margin-top: 10px; }
.topbar-project-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; border-top: 1px solid var(--border-hair); }
.topbar-project-row > div { display: grid; min-width: 0; }
.topbar-project-row strong { color: var(--text-hi); font-size: 12px; overflow-wrap: anywhere; }
.topbar-project-row span { color: var(--text-faint); font-family: var(--font-mono); font-size: 9.5px; }
.topbar-project-secondary { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border-hair); }
@media (max-width: 640px) {
  .topbar-project-dialog { max-height: calc(100vh - 24px); padding: 16px; }
  .topbar-project-dialog .btn, .topbar-project-dialog .pm-input { min-height: 44px; }
}
```

- [ ] **Step 5: Verify GREEN and commit**

Run Step 2. Expected: PASS, including Escape/focus restoration, signed-out guidance, computer import, and existing 320/390 px action geometry.

```bash
git add lightweaver/src/components/projects/TopBarProjectDialogs.jsx lightweaver/src/v3/app.jsx lightweaver/src/v3/v3-styles.css lightweaver/src/v3/v3-screens.css lightweaver/tests/cloud-project-library.spec.ts lightweaver/tests/pattern-lab-isolation.spec.ts
git commit -m "feat: add compact topbar project loader"
```

### Task 2: Make Save destination-aware

**Files:**
- Modify: `lightweaver/src/components/projects/TopBarProjectDialogs.jsx`
- Modify: `lightweaver/src/v3/app.jsx:560-590,640-690`
- Modify: `lightweaver/src/v3/v3-screens.css`
- Test: `lightweaver/tests/cloud-project-library.spec.ts`

- [ ] **Step 1: Write failing tests for every Save destination**

```ts
test('Save prompts once for an authenticated unassociated project and creates it online', async ({ page }) => {
  const fixture = new LibraryFixture('worker');
  await fixture.install(page);
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Project name').fill('Gallery Bloom');
  await page.getByRole('button', { name: 'Save project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Save project online' });
  await expect(dialog.getByLabel('Online project title')).toHaveValue('Gallery Bloom');
  await dialog.getByRole('button', { name: 'Save online' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => [...fixture.projects.values()].map(project => project.title)).toContain('Gallery Bloom');
});
```

Also prove: associated Save uses the existing revision-safe PUT; signed-out Save writes `lw_project_library_v1` and stays on the current Studio screen; and a customer who opens an assigned draft then presses Save updates only the draft record while the official record remains unchanged.

- [ ] **Step 2: Run the Save tests and verify RED**

```bash
cd lightweaver
npx playwright test tests/cloud-project-library.spec.ts --project=chromium --workers=1 --grep "Save prompts|associated Save|signed-out Save|customer.*Save"
```

Expected: FAIL because authenticated unassociated Save currently falls through to browser storage and opens Preferences.

- [ ] **Step 3: Add `ProjectSaveDialog`**

Its API is:

```jsx
export function ProjectSaveDialog({ open, initialTitle, onClose, onSave })
```

Render a portal form named `Save project online`, focus an `Online project title` input initialized from `projectName`, and provide Close, Cancel, and `Save online`. Submit `await onSave(title)`, close only on success, show `Give the project a useful title.` for `title-required`, and otherwise show the returned error message. Apply the same 44 px phone target rule.

- [ ] **Step 4: Route Save in this exact order**

```jsx
if (session.status === 'authenticated' && activeRemoteProject) {
  return cloudLibrary.saveNow();
}
if (session.status === 'authenticated' && session.role !== 'customer') {
  setSaveDialogOpen(true);
  return { ok: true, prompted: true };
}
const record = saveCurrentProjectToLibrary(serializeProject());
markProjectPersisted('browser');
showWorkspaceNotice({ kind: 'success', message: formatBrowserProjectSaveLabel(record), transient: true });
return { ok: true, record };
```

Use `cloudLibrary.createProject(title)` for confirmation. Do not change context methods, roles, formats, or revision semantics. Associated customers save drafts through `saveNow`; unassociated customers use the non-destructive browser fallback.

- [ ] **Step 5: Verify GREEN and commit**

```bash
cd lightweaver
npm run test:projects:browser
git add lightweaver/src/components/projects/TopBarProjectDialogs.jsx lightweaver/src/v3/app.jsx lightweaver/src/v3/v3-screens.css lightweaver/tests/cloud-project-library.spec.ts
git commit -m "feat: route topbar saves by destination"
```

Expected: all cloud-library browser tests pass and the customer's official project is byte-for-byte unchanged.

### Task 3: Replace the breadcrumb chip with event-driven notices

**Files:**
- Create: `lightweaver/src/components/projects/WorkspaceNotice.jsx`
- Modify: `lightweaver/src/v3/app.jsx:223-255,350-690`
- Modify: `lightweaver/src/v3/v3-styles.css:190-208`
- Modify: `lightweaver/src/v3/v3-screens.css`
- Test: `lightweaver/tests/cloud-project-library.spec.ts`
- Test: `lightweaver/tests/project-recovery-fixtures.spec.ts`

- [ ] **Step 1: Write failing notice tests**

Test that a recovery notice appears at `data-testid="workspace-notice"`, can be dismissed immediately, and auto-clears after 2200 ms if left alone. Test that explicit online/browser save success also clears. Test that conflict, associated-project offline, and error notices remain after 2200 ms, can be dismissed, and can reappear only after the underlying state leaves and later re-enters. Assert `.savechip` has count zero.

- [ ] **Step 2: Run notice tests and verify RED**

```bash
cd lightweaver
npx playwright test tests/cloud-project-library.spec.ts tests/project-recovery-fixtures.spec.ts --project=chromium --workers=1 --grep "workspace notice|recovery"
```

Expected: FAIL because lifecycle and cloud status are still rendered persistently in `.savechip`.

- [ ] **Step 3: Implement `WorkspaceNotice`**

```jsx
export const TRANSIENT_WORKSPACE_NOTICE_MS = 2200;

export function WorkspaceNotice({ notice, onDismiss }) {
  useEffect(() => {
    if (!notice?.transient) return undefined;
    const timer = window.setTimeout(onDismiss, TRANSIENT_WORKSPACE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice, onDismiss]);
  if (!notice) return null;
  const urgent = notice.kind === 'conflict' || notice.kind === 'error';
  return <aside className={`workspace-notice is-${notice.kind}`} data-testid="workspace-notice" role={urgent ? 'alert' : 'status'}>
    <span>{notice.message}</span>
    {notice.action && <button type="button" className="btn ghost-sm" onClick={notice.action.onClick}>{notice.action.label}</button>}
    <button type="button" className="workspace-notice-dismiss" aria-label="Dismiss notice" onClick={onDismiss}>×</button>
  </aside>;
}
```

- [ ] **Step 4: Emit notices only from events**

In `Shell`, keep one notice object and a ref to the previous `{ status, online, remoteId }`. Emit transient recovery only when the initial lifecycle label is `Restored from recovery copy`; transient browser/online success after an explicit save or a pending/waiting/saving to saved transition; persistent conflict when status enters `conflict`; persistent offline when an associated project becomes offline; and persistent error when status enters `error`. Give conflict/error notices a `Review` action that opens Preferences. Clear a state-owned notice when its underlying state resolves, and record dismissal so the same unchanged state does not recreate it.

Remove `saveLabel` from `TopBar`, delete the breadcrumb `.savechip`, and render the notice as a grid overlay after the active screen. Do not show passive `New project`, `Unsaved changes`, or initial `Saved online` status.

- [ ] **Step 5: Place the notice at the artboard upper-right**

```css
.workspace-notice { grid-column: 2 / 4; grid-row: 2 / 4; align-self: start; justify-self: end; z-index: 90; display: flex; align-items: center; gap: 8px; max-width: min(360px, calc(100% - 24px)); margin: 12px; padding: 9px 10px 9px 12px; border: 1px solid var(--border-soft); border-radius: var(--r-md); background: color-mix(in srgb, var(--bg-panel) 94%, transparent); box-shadow: 0 10px 30px rgba(0,0,0,.22); }
.workspace-notice-dismiss { width: 32px; height: 32px; flex: none; color: var(--text-lo); }
.workspace-notice.is-conflict, .workspace-notice.is-error { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.workspace-notice.is-offline { border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); }
@media (max-width: 640px) { .workspace-notice { grid-column: 2 / 3; margin: 8px; max-width: calc(100% - 16px); } .workspace-notice .btn, .workspace-notice-dismiss { min-width: 44px; min-height: 44px; } }
```

- [ ] **Step 6: Verify GREEN and commit**

Run Step 2. Expected: transient notices disappear after 2.2 seconds and persistent notices remain.

```bash
git add lightweaver/src/components/projects/WorkspaceNotice.jsx lightweaver/src/v3/app.jsx lightweaver/src/v3/v3-styles.css lightweaver/src/v3/v3-screens.css lightweaver/tests/cloud-project-library.spec.ts lightweaver/tests/project-recovery-fixtures.spec.ts
git commit -m "feat: show event-driven workspace notices"
```

### Task 4: Reconcile lifecycle and responsive regressions

**Files:**
- Modify: `lightweaver/tests/studio-hardening.spec.ts`
- Modify: `lightweaver/tests/card-workspace.spec.ts`
- Modify: `lightweaver/tests/layout-send-to-card.spec.ts`
- Modify: `lightweaver/tests/workflow.spec.ts`
- Modify: `lightweaver/tests/patterns-v3.spec.ts`
- Modify: `lightweaver/tests/project-recovery-fixtures.spec.ts`
- Modify: `lightweaver/tests/pattern-lab-isolation.spec.ts`

- [ ] **Step 1: Run all former chip consumers and verify RED**

```bash
cd lightweaver
npx playwright test tests/studio-hardening.spec.ts tests/card-workspace.spec.ts tests/layout-send-to-card.spec.ts tests/workflow.spec.ts tests/patterns-v3.spec.ts tests/project-recovery-fixtures.spec.ts tests/pattern-lab-isolation.spec.ts --project=chromium --workers=1
```

Expected: FAIL only at obsolete `.savechip` or `Import project` expectations.

- [ ] **Step 2: Replace chip assertions with behavior-specific evidence**

- Dirty/current lifecycle: inspect `lw_project_lifecycle_v1` or the destination-specific status already under test.
- Card install success: assert `settings-card-status`, card action text, or captured card payload.
- Recovery/browser save: assert the transient workspace notice immediately after the event.
- Clean New: assert no replacement dialog and no ambient workspace notice.
- Global actions: assert exactly `New project`, `Load project`, `Preferences`, `Export project`, and `Save project`.

Keep all existing replacement, revision, payload, conflict, and geometry assertions.

- [ ] **Step 3: Prove phone geometry at 320 and 390 px**

```ts
expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
for (const name of ['New project', 'Load project', 'Preferences', 'Export project', 'Save project']) {
  const box = await page.getByRole('button', { name, exact: true }).boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
}
```

Open Load at each width and assert its bounds are within the viewport and its controls do not overlap.

- [ ] **Step 4: Verify GREEN and remove stale selectors**

Run Step 1, then:

```bash
rg -n "savechip|Import project" lightweaver/tests lightweaver/src/v3/app.jsx lightweaver/src/v3/v3-styles.css
```

Expected: test group exits 0; search has no executable UI/test matches.

- [ ] **Step 5: Commit**

```bash
git add lightweaver/tests
git commit -m "test: align lifecycle coverage with workspace notices"
```

### Task 5: Full verification, visual inspection, review, and delivery

**Files:**
- Verify: `lightweaver/`
- Review base: `deff416`

- [ ] **Step 1: Run focused suites**

```bash
cd lightweaver
npm run test:projects
npm run test:projects:browser
npx playwright test tests/project-recovery-fixtures.spec.ts tests/pattern-lab-isolation.spec.ts tests/studio-hardening.spec.ts --project=chromium --workers=1
```

Expected: all commands exit 0.

- [ ] **Step 2: Run the full launch gate**

```bash
cd lightweaver
npm run launch:check
```

Expected: exit 0 through source tests, browser suites, release checks, production build, staged Pages verification, and firmware freshness.

- [ ] **Step 3: Visually inspect the actual app**

```bash
cd lightweaver
npm run dev -- --host 127.0.0.1
```

Inspect Layout plus Load/Save dialogs at 1440×900, 390×844, and 320×720. Confirm five tappable actions, no breadcrumb chip, in-viewport dialogs, non-overlapping project rows, and notices at the artboard upper-right without obscuring primary controls. Capture screenshots as evidence.

- [ ] **Step 4: Request independent review and resolve findings with TDD**

```bash
git diff --check deff416..HEAD
git diff --stat deff416..HEAD
git diff deff416..HEAD -- lightweaver/src lightweaver/tests docs/superpowers/plans/2026-08-02-topbar-save-load.md
```

Give the reviewer the approved spec, this plan, `BASE_SHA=deff416`, and current HEAD. Fix every Critical or Important finding by first adding a failing regression test, then rerun its focused suite.

- [ ] **Step 5: Re-run final evidence after review**

```bash
cd lightweaver
npm run launch:check
```

Expected: final reviewed tree exits 0.

- [ ] **Step 6: Commit, push, and open a ready PR**

```bash
git add docs/superpowers/plans/2026-08-02-topbar-save-load.md lightweaver/src lightweaver/tests
git commit -m "feat: finish topbar save and load workflow"
git push -u origin codex/topbar-save-load
gh pr create --base main --head codex/topbar-save-load --title "Add top-bar Save and Load workflow" --body-file /tmp/lightweaver-topbar-pr.md
```

The PR body summarizes destination-aware Save, compact online-first Load, event-driven notices, `npm run launch:check`, and desktop/phone visual verification.

- [ ] **Step 7: Follow CI without merging or deploying**

```bash
gh pr checks --watch --fail-fast
```

Expected: every required check passes. For any failure, inspect logs, reproduce locally, add a failing regression where applicable, fix, rerun the relevant suite plus `npm run launch:check`, push, and watch the replacement run. Stop at a ready PR.

---

## Plan self-review

- Spec coverage: Tasks 1–4 cover all five actions, online-first Load, computer import, signed-out guidance, Save destinations, customer draft isolation, event notices, accessibility, and 320/390 px behavior. Task 5 covers focused/full verification, visual inspection, review, PR delivery, and CI.
- Placeholder scan: every step names exact files, APIs, commands, expected failures, and passing evidence; no deferred implementation markers remain.
- API consistency: both dialogs use `CloudLibraryDialogPortal`; Load calls `activeProjects` and `openProject`; first Save calls `createProject`; associated Save calls `saveNow`; local import continues through `replaceProject`; no context, API, account, or storage-format change is planned.
