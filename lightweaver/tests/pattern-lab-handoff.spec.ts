import { test, expect, type Route } from '@playwright/test';

const AUTOSAVE_KEY = 'lw_autosave_v3';
let cardMutationRequests: string[];

test.beforeEach(async ({ page }) => {
  cardMutationRequests = [];
  const blockCard = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'GET') cardMutationRequests.push(`${request.method()} ${request.url()}`);
    await route.abort();
  };
  await page.route('http://lightweaver.local/**', blockCard);
  await page.route('http://192.168.4.1/**', blockCard);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
});

test('reviews, cancels, and confirms a native look without touching the Pattern Lab draft', async ({ page }) => {
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY)).not.toBeNull();
  const projectBefore = await page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY);
  const parsedBefore = JSON.parse(projectBefore!);

  await page.getByLabel('Base pattern').selectOption('aurora');
  const tools = page.getByTestId('pattern-lab-runtime-tools');
  const draftId = await tools.getAttribute('data-draft-recipe-id');
  const sourceId = await tools.getAttribute('data-source-recipe-id');
  await tools.locator(':scope > summary').click();

  const handoff = page.getByTestId('pattern-lab-project-handoff');
  await handoff.getByRole('button', { name: 'Review Use in Project' }).click();
  await expect(handoff).toContainText('A new saved look named “Aurora” will be added and selected. Existing looks stay unchanged.');
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY)).toBe(projectBefore);

  await handoff.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(handoff.getByRole('button', { name: 'Review Use in Project' })).toBeVisible();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY)).toBe(projectBefore);

  await handoff.getByRole('button', { name: 'Review Use in Project' }).click();
  await handoff.getByRole('button', { name: 'Add to project' }).click();
  await expect(page.getByTestId('pattern-lab-handoff-status')).toContainText('Added and selected Aurora');
  await expect.poll(async () => {
    const raw = await page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY);
    const project = JSON.parse(raw || '{}');
    return project.devices?.standaloneController?.looks?.some((look: { label?: string }) => look.label === 'Aurora');
  }).toBe(true);

  const projectAfter = JSON.parse((await page.evaluate(key => localStorage.getItem(key), AUTOSAVE_KEY))!);
  const previousLooks = parsedBefore.devices?.standaloneController?.looks || [];
  for (const look of previousLooks) {
    expect(projectAfter.devices.standaloneController.looks).toContainEqual(look);
  }
  await expect(tools).toHaveAttribute('data-draft-recipe-id', draftId || '');
  await expect(tools).toHaveAttribute('data-source-recipe-id', sourceId || '');
  expect(cardMutationRequests).toEqual([]);
});

test('explains that an evolving recipe must be baked before project handoff', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');
  await page.getByRole('checkbox', { name: /Long Evolution/ }).check();
  const tools = page.getByTestId('pattern-lab-runtime-tools');
  await tools.locator(':scope > summary').click();

  const handoff = page.getByTestId('pattern-lab-project-handoff');
  await handoff.getByRole('button', { name: 'Review Use in Project' }).click();
  await expect(handoff).toContainText('Bake this exact recipe first.');
  await expect(handoff.getByRole('button', { name: 'Add to project' })).toBeDisabled();
  expect(cardMutationRequests).toEqual([]);
});
