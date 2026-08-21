import { test, expect } from '@playwright/test';
import { choosePattern, openControls } from './helpers/pattern-lab.ts';

// The destructive paths of Pattern Lab's private library: naming a design,
// saving a second version of one, deleting one, and undoing the two things
// that silently threw work away before this existed (a base-pattern switch,
// and a delete).
//
// Every assertion here is on state — stored drafts, field values, button
// labels — never on canvas pixels: requestAnimationFrame does not tick in a
// backgrounded harness tab, so a pixel comparison here would prove nothing.

const DRAFTS_KEY = 'lw_pattern_lab_drafts_v1';

async function storedDrafts(page: import('@playwright/test').Page) {
  return page.evaluate(key => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [] as Array<{ id: string; name: string; speed: number }>;
    return (JSON.parse(raw).drafts as Array<Record<string, never>>).map(draft => ({
      id: draft.id as unknown as string,
      name: draft.name as unknown as string,
      speed: (draft.playback as unknown as { speed: number })?.speed,
    }));
  }, DRAFTS_KEY);
}

function nameField(page: import('@playwright/test').Page) {
  return page.getByTestId('pattern-lab-draft-name');
}

async function rename(page: import('@playwright/test').Page, name: string) {
  await nameField(page).fill(name);
  await nameField(page).press('Enter');
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
});

test('a design can be named, and the name is what reaches private storage', async ({ page }) => {
  await choosePattern(page, 'aurora');
  // The name field is on the design, above the artwork — not behind a save
  // dialog — so it is reachable the moment a pattern is chosen.
  await expect(nameField(page)).toBeEditable();
  await expect(nameField(page)).toHaveValue('Aurora');

  await rename(page, '  Hallway   at dusk  ');
  // Trimmed and collapsed, not stored raw.
  await expect(nameField(page)).toHaveValue('Hallway at dusk');

  await openControls(page);
  await page.getByRole('button', { name: 'Save private draft' }).click();
  await expect(page.getByTestId('pattern-lab-save-status')).toContainText('Hallway at dusk');
  expect((await storedDrafts(page)).map(draft => draft.name)).toEqual(['Hallway at dusk']);

  // An emptied field falls back rather than saving a nameless design.
  await nameField(page).fill('');
  await nameField(page).press('Enter');
  await expect(nameField(page)).not.toHaveValue('');
});

// The headline regression. Before this, savePatternLabDraft overwrote by id,
// so tweaking a saved design and saving again destroyed the earlier version
// with no warning and no way back.
test('saving a tweaked design again keeps both versions instead of overwriting the first', async ({ page }) => {
  await choosePattern(page, 'aurora');
  await rename(page, 'Rainbow Flow');
  await openControls(page);
  // The Speed slider is a percentage on screen (25-200) and a multiplier in
  // the recipe (0.25-2), so 50 here is playback.speed 0.5 in storage.
  await page.getByRole('slider', { name: 'Speed', exact: true }).fill('50');
  await page.getByRole('button', { name: 'Save private draft' }).click();
  await expect(page.getByTestId('pattern-lab-save-status')).toContainText('Rainbow Flow');

  const first = await storedDrafts(page);
  expect(first).toHaveLength(1);

  // Once a design is saved, the primary action stops being a plain "save":
  // it becomes an explicitly additive one, and overwriting moves to a button
  // that names what it would overwrite.
  const primary = page.getByRole('button', { name: 'Save as a new design' });
  await expect(primary).toBeVisible();
  const replace = page.getByTestId('pattern-lab-replace-draft');
  await expect(replace).toContainText('Rainbow Flow');

  await page.getByRole('slider', { name: 'Speed', exact: true }).fill('175');
  await primary.click();

  const both = await storedDrafts(page);
  expect(both).toHaveLength(2);
  expect(both.map(draft => draft.name).sort()).toEqual(['Rainbow Flow', 'Rainbow Flow 2']);
  expect(both.find(draft => draft.name === 'Rainbow Flow')?.speed).toBe(0.5);
  expect(both.find(draft => draft.name === 'Rainbow Flow 2')?.speed).toBe(1.75);
  expect(new Set(both.map(draft => draft.id)).size).toBe(2);

  // Replace is still available and still means replace — one record, updated.
  await page.getByRole('slider', { name: 'Speed', exact: true }).fill('125');
  await page.getByTestId('pattern-lab-replace-draft').click();
  const replaced = await storedDrafts(page);
  expect(replaced).toHaveLength(2);
  expect(replaced.find(draft => draft.name === 'Rainbow Flow 2')?.speed).toBe(1.25);
  expect(replaced.find(draft => draft.name === 'Rainbow Flow')?.speed).toBe(0.5);
});

test('deleting a saved design is undoable, and the undo puts it back', async ({ page }) => {
  await choosePattern(page, 'aurora');
  await rename(page, 'Keep me');
  await openControls(page);
  await page.getByRole('button', { name: 'Save private draft' }).click();
  await expect.poll(async () => (await storedDrafts(page)).length).toBe(1);

  await page.getByRole('button', { name: 'Delete Keep me' }).click();
  await expect.poll(async () => (await storedDrafts(page)).length).toBe(0);

  const undoBar = page.getByTestId('pattern-lab-undo-bar');
  await expect(undoBar).toContainText('Keep me');
  await page.getByTestId('pattern-lab-undo').click();

  await expect.poll(async () => (await storedDrafts(page)).map(draft => draft.name)).toEqual(['Keep me']);
  await expect(undoBar).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open Keep me' })).toBeVisible();
});

// The other destructive act that already existed and had no way back:
// choosing a different base pattern rebuilds the draft from scratch, so
// every slider, knob and colour move on the previous one is discarded.
test('undo restores the work that switching base patterns wiped', async ({ page }) => {
  await choosePattern(page, 'aurora');
  await rename(page, 'Slow ember');
  await openControls(page);
  await page.getByRole('slider', { name: 'Speed', exact: true }).fill('50');

  await choosePattern(page, 'fire');
  await expect(nameField(page)).toHaveValue('Fire');

  const undoBar = page.getByTestId('pattern-lab-undo-bar');
  await expect(undoBar).toContainText('Slow ember');
  await page.getByTestId('pattern-lab-undo').click();

  await expect(nameField(page)).toHaveValue('Slow ember');
  await openControls(page);
  await expect(page.getByRole('slider', { name: 'Speed', exact: true })).toHaveValue('50');
  await expect(undoBar).toHaveCount(0);
});
