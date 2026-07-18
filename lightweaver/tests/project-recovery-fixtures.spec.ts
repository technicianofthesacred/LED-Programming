import { test, expect } from '@playwright/test';

// Persistence & recovery fixtures (defects B-1 / B-2).
//
// Each test seeds localStorage BEFORE the app loads with a stored-project
// fixture, then asserts the app boots to a working Layout screen and — for
// unrestorable payloads — that the raw payload survives in
// `lw_autosave_v3_quarantine` even after the 500 ms debounced autosave flush
// has overwritten the live keys (`lw_autosave_v3` + `_backup`).

const AUTOSAVE_KEY = 'lw_autosave_v3';
const AUTOSAVE_BACKUP_KEY = 'lw_autosave_v3_backup';
const QUARANTINE_KEY = 'lw_autosave_v3_quarantine';
const LEGACY_AUTOSAVE_KEY = 'lw_autosave_v1';
const LIFECYCLE_KEY = 'lw_project_lifecycle_v1';

const MALFORMED_SENTINEL = 'LW-SENTINEL-MALFORMED';
const FORWARD_SENTINEL = 'LW-SENTINEL-FORWARD';

async function seedStorage(page: any, entries: Record<string, string>) {
  await page.addInitScript((seed: Record<string, string>) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
  }, entries);
}

async function expectWorkingLayoutScreen(page: any) {
  await expect(page.getByRole('button', { name: 'Import SVG' }).first()).toBeVisible();
  await expect(page.getByTestId('screen-error-fallback')).toHaveCount(0);
}

function readKey(page: any, key: string) {
  return page.evaluate((k: string) => localStorage.getItem(k) || '', key);
}

test('malformed autosave JSON is quarantined, not destroyed by the autosave flush', async ({ page }) => {
  const malformed = `{"version":3,"name":"${MALFORMED_SENTINEL}`; // unterminated JSON
  await seedStorage(page, { [AUTOSAVE_KEY]: malformed });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expectWorkingLayoutScreen(page);

  // The raw payload must land in quarantine…
  await expect.poll(() => readKey(page, QUARANTINE_KEY)).toContain(MALFORMED_SENTINEL);
  const record = JSON.parse(await readKey(page, QUARANTINE_KEY));
  expect(record.reason).toBe('parse-error');
  expect(record.payload).toBe(malformed);
  expect(record.at).toBeGreaterThan(0);

  // …and still be there well after the 500 ms debounced flush has run and
  // overwritten the live autosave keys with the default project.
  await page.waitForTimeout(2500);
  expect(await readKey(page, QUARANTINE_KEY)).toContain(MALFORMED_SENTINEL);
  const live = await readKey(page, AUTOSAVE_KEY);
  expect(live).not.toContain(MALFORMED_SENTINEL);
  expect(JSON.parse(live).version).toBe(3);
  expect(await readKey(page, AUTOSAVE_BACKUP_KEY)).not.toContain(MALFORMED_SENTINEL);
});

test('forward-version autosave is quarantined with its payload intact', async ({ page }) => {
  const forward = JSON.stringify({ version: 99, name: 'From the future', sentinel: FORWARD_SENTINEL });
  await seedStorage(page, { [AUTOSAVE_KEY]: forward, [AUTOSAVE_BACKUP_KEY]: forward });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expectWorkingLayoutScreen(page);

  await expect.poll(() => readKey(page, QUARANTINE_KEY)).toContain(FORWARD_SENTINEL);
  const record = JSON.parse(await readKey(page, QUARANTINE_KEY));
  expect(record.reason).toBe('unsupported-version');
  expect(JSON.parse(record.payload).version).toBe(99);

  // Prove the 500 ms flush did not destroy the quarantined copy.
  await page.waitForTimeout(2500);
  expect(await readKey(page, QUARANTINE_KEY)).toContain(FORWARD_SENTINEL);
  expect(await readKey(page, AUTOSAVE_KEY)).not.toContain(FORWARD_SENTINEL);
});

test('valid legacy v1 project migrates and opens', async ({ page }) => {
  const legacy = JSON.stringify({
    version: 1,
    name: 'Legacy Piece',
    strips: [{
      id: 'legacy-strip',
      name: 'Legacy strip',
      pathData: 'M 100 100 L 300 100',
      pixelCount: 20,
    }],
    showClips: [{ id: 'clip-1', track: 0, patternId: 'aurora', start: 0, end: 10 }],
  });
  await seedStorage(page, { [LEGACY_AUTOSAVE_KEY]: legacy });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expectWorkingLayoutScreen(page);

  await expect(page.locator('.crumb .proj')).toHaveText('Legacy Piece');
  await expect(page.locator('.la-strip-row')).toHaveCount(1);
  // Nothing to quarantine — the legacy payload restored.
  expect(await readKey(page, QUARANTINE_KEY)).toBe('');
});

test('valid v3 autosave restores without claiming Unsaved changes', async ({ page }) => {
  const project = JSON.stringify({ version: 3, id: 'lwproj-fixture-v3', name: 'Fixture V3' });
  await seedStorage(page, { [AUTOSAVE_KEY]: project, [AUTOSAVE_BACKUP_KEY]: project });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expectWorkingLayoutScreen(page);

  await expect(page.locator('.crumb .proj')).toHaveText('Fixture V3');
  // Restored work is truthfully labelled — never the false-dirty
  // "Unsaved changes" of defect B-1.
  await expect(page.locator('.savechip')).toContainText('Restored from recovery copy');
  await expect(page.locator('.savechip')).not.toContainText('Unsaved changes');
  expect(await readKey(page, QUARANTINE_KEY)).toBe('');
});

test('a project saved in the browser is still "Saved in browser" after reload', async ({ page }) => {
  const project = JSON.stringify({ version: 3, id: 'lwproj-fixture-saved', name: 'Saved Fixture' });
  await seedStorage(page, {
    [AUTOSAVE_KEY]: project,
    [LIFECYCLE_KEY]: JSON.stringify({ version: 1, dirty: false, persistedDestination: 'browser', installed: false }),
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expectWorkingLayoutScreen(page);

  await expect(page.locator('.crumb .proj')).toHaveText('Saved Fixture');
  await expect(page.locator('.savechip')).toContainText('Saved in browser');
});

test('fresh boot is a clean New project and New project needs no discard confirm', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    (window as any).__lwConfirmCalls = 0;
    const originalConfirm = window.confirm;
    window.confirm = (...args: any[]) => {
      (window as any).__lwConfirmCalls += 1;
      return originalConfirm ? false : false;
    };
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expectWorkingLayoutScreen(page);

  await expect(page.locator('.savechip')).toContainText('New project');
  await expect(page.locator('.savechip')).not.toContainText('Unsaved changes');

  // Wait past the first autosave flush: an untouched app must STILL be clean.
  await page.waitForTimeout(700);
  await expect(page.locator('.savechip')).toContainText('New project');

  await page.getByRole('button', { name: 'New project' }).click();
  // Neither the accessible replacement dialog nor window.confirm may fire on
  // an untouched app.
  await page.waitForTimeout(400);
  await expect(page.getByRole('dialog', { name: 'Replace current project?' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__lwConfirmCalls)).toBe(0);
  await expectWorkingLayoutScreen(page);
});
