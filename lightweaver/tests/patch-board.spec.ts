import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function writeFixture(tmp: string) {
  const fixture = path.join(tmp, 'patch-board-line.svg');
  fs.writeFileSync(fixture, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 620 40" width="620" height="40">
  <g id="line-layer" data-name="Line">
    <path d="M 10 20 H 610" fill="none" stroke="#fff" stroke-width="3"/>
  </g>
</svg>`);
  return fixture;
}

test('wire path splits a visible source path into saved physical segments', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-patch-board-'));
  const fixture = writeFixture(tmp);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(1\)/ }).click();
  await expect(page.locator('.la-strip-row')).toHaveCount(1);

  // The old "Wire Path" disclosure (.lw-patch-details, always open, with its
  // own "Wire Path" heading + "Source Paths" list) is now the collapsed
  // "Advanced" details (.la-wire-editor) — PatchBoardScreen always renders
  // `embedded`, which drops the heading and source-path list entirely.
  const mappingPanel = page.locator('.la-wire-editor');
  if (!(await mappingPanel.evaluate((el: HTMLDetailsElement) => el.open))) {
    await page.locator('.la-wire-editor > summary').click();
  }
  await expect(page.locator('.lw-wire-path.is-embedded')).toBeVisible();
  await expect(page.getByText('Splits')).toBeVisible();
  // No cuts yet: the "Wiring order" segment-chip list only renders once
  // there are more physical patches than strips (i.e. after a split).
  await expect(page.locator('.lw-wire-segment-chip')).toHaveCount(0);

  await page.getByRole('button', { name: 'Split' }).click();
  const stripPath = page.locator('path[data-strip-path]').first();
  const target = await stripPath.evaluate((path: SVGPathElement) => {
    const point = path.getPointAtLength(path.getTotalLength() * 0.45);
    const ctm = path.getScreenCTM();
    if (!ctm) return null;
    return {
      x: point.x * ctm.a + point.y * ctm.c + ctm.e,
      y: point.x * ctm.b + point.y * ctm.d + ctm.f,
    };
  });
  expect(target).not.toBeNull();
  await page.mouse.click(target!.x, target!.y);
  await expect(page.locator('.lw-wire-segment-chip')).toHaveCount(2);
  await page.getByRole('button', { name: 'Add a gap' }).click();
  await expect(page.locator('.lw-wire-off-chip')).toBeVisible();

  // Note: the old "Export" rail screen (ledmap.json download) no longer
  // exists in this build — per docs/layout-redesign-plan.md, Send to card +
  // Export ledmap.json are Phase 3 work that hasn't shipped ("exists in code
  // with no button"). Dropped until Phase 3 lands a real Export surface.
  const saveDownload = page.waitForEvent('download');
  await page.getByTitle('Save project file').click();
  const saved = await saveDownload;
  const projectPath = path.join(tmp, await saved.suggestedFilename());
  await saved.saveAs(projectPath);
  const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  expect(projectData.layout.patchBoard.patches.some((patch: any) => patch.source?.type === 'off')).toBe(true);
  expect(projectData.layout.patchBoard.patches.filter((patch: any) => patch.source?.type === 'strip')).toHaveLength(2);
});

test('numeric patch board fields replace the full value when clicked and typed', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-patch-board-number-input-'));
  const fixture = writeFixture(tmp);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.rail-item', { hasText: 'Layout' }).click();
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(1\)/ }).click();
  await expect(page.locator('.la-strip-row')).toHaveCount(1);

  // The old "Off LED count" field this test exercised (.lw-wire-off-input)
  // never had select-on-focus behavior in the frozen mockup either — this
  // test's real intent (clicking a numeric field selects its full value so
  // typing replaces rather than appends) is implemented today on the strip
  // LED-count field instead (onFocus={e => e.target.select()} at
  // src/components/LayoutScreen.jsx around the "Strip LED count" input), so
  // repoint there. Click the strip row to expand its inspector.
  await page.locator('.la-strip-row').first().click();
  const stripLedCount = page.getByRole('spinbutton', { name: 'Strip LED count' });
  await stripLedCount.fill('12');
  // Click elsewhere in the strip detail panel to move focus off the field.
  await page.getByText('Drag on canvas to move').click();

  await stripLedCount.click();
  await page.keyboard.press('3');

  await expect(stripLedCount).toHaveValue('3');
});

test('canvas split mode creates a cut marker on the artwork path', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-canvas-chop-'));
  const fixture = writeFixture(tmp);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(1\)/ }).click();
  await expect(page.locator('.la-strip-row')).toHaveCount(1);

  // "Selected split" and its Move/Merge/Delete controls live inside
  // PatchBoardScreen, which only renders once the "Advanced" details panel
  // (.la-wire-editor) is open.
  await page.locator('.la-wire-editor > summary').click();

  await page.getByRole('button', { name: 'Split' }).click();
  await expect(page.getByRole('button', { name: 'Split' })).toHaveClass(/active/);

  const stripPath = page.locator('path[data-strip-path]').first();
  const target = await stripPath.evaluate((path: SVGPathElement) => {
    const point = path.getPointAtLength(path.getTotalLength() * 0.45);
    const ctm = path.getScreenCTM();
    if (!ctm) return null;
    return {
      x: point.x * ctm.a + point.y * ctm.c + ctm.e,
      y: point.x * ctm.b + point.y * ctm.d + ctm.f,
    };
  });
  expect(target).not.toBeNull();
  await page.mouse.click(target!.x, target!.y);

  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(1);
  await expect(page.locator('.lw-wire-cut-marker-notch')).toHaveCount(1);
  await expect(page.locator('.lw-wire-cut-marker circle')).toHaveCount(0);
  await expect(page.locator('.lw-wire-canvas-segment')).toHaveCount(2);
  await expect(page.getByText('Selected split')).toBeVisible();
  await page.getByRole('button', { name: 'Move cut later' }).click();
  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(1);
  await page.getByRole('button', { name: 'Merge back into one strip' }).click();
  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(0);
  await expect(page.getByText('Selected split')).toHaveCount(0);
  await page.mouse.click(target!.x, target!.y);
  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete cut' }).click();
  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(0);
  await expect(page.locator('.lw-wire-canvas-segment')).toHaveCount(0);
  await page.mouse.click(target!.x, target!.y);
  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(1);
  await expect(page.locator('.lw-wire-canvas-segment')).toHaveCount(2);

  const saveDownload = page.waitForEvent('download');
  await page.getByTitle('Save project file').click();
  const saved = await saveDownload;
  const projectPath = path.join(tmp, await saved.suggestedFilename());
  await saved.saveAs(projectPath);
  const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  const stripPatches = projectData.layout.patchBoard.patches
    .filter((patch: any) => patch.source?.type === 'strip')
    .sort((a: any, b: any) => a.source.startLed - b.source.startLed);
  expect(stripPatches).toHaveLength(2);
  const [first, second] = stripPatches;
  const maxLed = projectData.layout.strips[0].pixelCount - 1;
  expect(first.source.startLed).toBe(0);
  expect(second.source.startLed).toBe(first.source.endLed + 1);
  expect(first.source.endLed).toBeGreaterThan(1);
  expect(first.source.endLed).toBeLessThan(maxLed);
});

test('canvas split overlay includes one-led physical segments', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-canvas-one-led-'));
  const fixture = writeFixture(tmp);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(1\)/ }).click();

  await page.getByRole('button', { name: 'Split' }).click();
  const stripPath = page.locator('path[data-strip-path]').first();
  const clickAt = async (ratio: number) => {
    const target = await stripPath.evaluate((path: SVGPathElement, ratioArg) => {
      const point = path.getPointAtLength(path.getTotalLength() * ratioArg);
      const ctm = path.getScreenCTM();
      if (!ctm) return null;
      return {
        x: point.x * ctm.a + point.y * ctm.c + ctm.e,
        y: point.x * ctm.b + point.y * ctm.d + ctm.f,
      };
    }, ratio);
    expect(target).not.toBeNull();
    await page.mouse.click(target!.x, target!.y);
  };

  await clickAt(2 / 9);
  await clickAt(3 / 9);

  await expect(page.locator('.lw-wire-cut-marker')).toHaveCount(2);
  await expect(page.locator('.lw-wire-canvas-segment')).toHaveCount(3);
});

test('canvas link mode records clicked chopped segments as physical route order', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-canvas-link-'));
  const fixture = writeFixture(tmp);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(1\)/ }).click();

  // "Add a gap" lives inside PatchBoardScreen, which only renders once the
  // "Advanced" details panel (.la-wire-editor) is open.
  await page.locator('.la-wire-editor > summary').click();

  await page.getByRole('button', { name: 'Split' }).click();
  const stripPath = page.locator('path[data-strip-path]').first();
  const clickAt = async (ratio: number) => {
    const target = await stripPath.evaluate((path: SVGPathElement, ratioArg) => {
      const point = path.getPointAtLength(path.getTotalLength() * ratioArg);
      const ctm = path.getScreenCTM();
      if (!ctm) return null;
      return {
        x: point.x * ctm.a + point.y * ctm.c + ctm.e,
        y: point.x * ctm.b + point.y * ctm.d + ctm.f,
      };
    }, ratio);
    expect(target).not.toBeNull();
    await page.mouse.click(target!.x, target!.y);
  };
  await clickAt(0.33);
  await clickAt(0.66);
  await expect(page.locator('.lw-wire-canvas-segment')).toHaveCount(3);
  await page.getByRole('button', { name: 'Split' }).click();
  await page.getByRole('button', { name: 'Add a gap' }).click();

  await page.getByRole('button', { name: 'Link' }).click();
  const segments = page.locator('.lw-wire-canvas-segment-hit');
  await expect(segments).toHaveCount(3);
  await segments.nth(2).click();
  await segments.nth(0).click();
  await expect(page.locator('.lw-route-badge')).toHaveCount(2);

  const saveDownload = page.waitForEvent('download');
  await page.getByTitle('Save project file').click();
  const saved = await saveDownload;
  const projectPath = path.join(tmp, await saved.suggestedFilename());
  await saved.saveAs(projectPath);
  const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  const rowIds = projectData.layout.patchBoard.chains[0].rowIds;
  const offRowId = rowIds.find((id: string) => id.startsWith('off-'));
  expect(offRowId).toBeTruthy();
  // The strip now lives on the strip-<n> id namespace (line-layer → strip-1), so
  // its split-segment patch ids follow suit.
  expect(rowIds).toEqual([
    'patch-strip-1-7-9',
    offRowId,
    'patch-strip-1-0-3',
  ]);
});

test('canvas link mode ignores segment clicks while physical map is locked', async ({ page }) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lightweaver-canvas-link-locked-'));
  const fixture = writeFixture(tmp);

  // The "Unlocked"/"Locked" toggle button that used to flip
  // `patchBoard.physicalLocked` only rendered when PatchBoardScreen was NOT
  // `embedded` — LayoutScreen now always renders it embedded (see
  // src/components/PatchBoardScreen.jsx:180-198), so that toggle is
  // unreachable from the current UI. The lock itself is still fully wired
  // through the data layer (src/lib/patchBoard.js and the canvas link-mode
  // guard at src/components/LayoutScreen.jsx:1718), so we seed a locked
  // board the other supported way a locked project can arrive: by loading a
  // project file that already has `physicalLocked: true`. Build that file by
  // saving the app's own real output and flipping one field, rather than
  // hand-authoring the project schema (which is being actively developed
  // elsewhere in this repo).
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.setInputFiles('input[accept=".svg"]', fixture);
  await page.getByRole('button', { name: /\+ All \(1\)/ }).click();

  await page.getByRole('button', { name: 'Split' }).click();
  const stripPath = page.locator('path[data-strip-path]').first();
  const target = await stripPath.evaluate((path: SVGPathElement) => {
    const point = path.getPointAtLength(path.getTotalLength() * 0.45);
    const ctm = path.getScreenCTM();
    if (!ctm) return null;
    return {
      x: point.x * ctm.a + point.y * ctm.c + ctm.e,
      y: point.x * ctm.b + point.y * ctm.d + ctm.f,
    };
  });
  expect(target).not.toBeNull();
  await page.mouse.click(target!.x, target!.y);
  await page.getByRole('button', { name: 'Split' }).click();
  await expect(page.locator('.lw-wire-canvas-segment')).toHaveCount(2);

  const saveDownload = page.waitForEvent('download');
  await page.getByTitle('Save project file').click();
  const saved = await saveDownload;
  const unlockedPath = path.join(tmp, await saved.suggestedFilename());
  await saved.saveAs(unlockedPath);
  const lockedProject = JSON.parse(fs.readFileSync(unlockedPath, 'utf8'));
  lockedProject.layout.patchBoard.physicalLocked = true;
  const lockedPath = path.join(tmp, 'locked-project.json');
  fs.writeFileSync(lockedPath, JSON.stringify(lockedProject));

  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  // A cleared project reboots into the default two-circle hardware layout
  // (strips already present), so loading a project file triggers the
  // "replace your current strips" confirm().
  page.once('dialog', dialog => dialog.accept());
  await page.setInputFiles('input[accept=".json"]', lockedPath);
  await expect(page.locator('.la-strip-row')).toHaveCount(1);

  await page.getByRole('button', { name: 'Link' }).click();
  const segments = page.locator('.lw-wire-canvas-segment-hit');
  await expect(segments).toHaveCount(2);
  await segments.nth(1).click();

  const relockedDownload = page.waitForEvent('download');
  await page.getByTitle('Save project file').click();
  const relocked = await relockedDownload;
  const projectPath = path.join(tmp, await relocked.suggestedFilename());
  await relocked.saveAs(projectPath);
  const projectData = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  expect(projectData.layout.patchBoard.physicalLocked).toBe(true);
  const rowIds = projectData.layout.patchBoard.chains[0].rowIds;
  expect(rowIds).toHaveLength(2);
});
