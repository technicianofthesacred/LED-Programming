import { test, expect } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  choosePattern,
  closeControls,
  innerScrollOverflow,
  isMobileDrawerViewport,
  openControls,
  overlappingStatusBarChips,
  patternSearchInput,
  patternTile,
  selectedPatternTile,
  supportsHover,
  touchTargetShortfalls,
} from './helpers/pattern-lab.ts';
import { fileURLToPath } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
const APP_SOURCE = readFileSync(resolve(SRC_DIR, 'v3/app.jsx'), 'utf8');
const LAB_SOURCE = readFileSync(resolve(SRC_DIR, 'pattern-lab/PatternLabScreen.jsx'), 'utf8');
const LAB_CSS = readFileSync(resolve(SRC_DIR, 'pattern-lab/pattern-lab.css'), 'utf8');

function sourceFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

test.beforeEach(async ({ page }) => {
  await page.route('http://lightweaver.local/**', route => route.abort());
  await page.route('http://192.168.4.1/**', route => route.abort());
});

test('Pattern Lab is an isolated lazy Studio route', async ({ page }) => {
  await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });

  const patterns = page.getByRole('button', { name: 'Patterns', exact: true });
  await expect(patterns).toBeVisible();
  await page.getByRole('button', { name: 'Pattern Lab', exact: true }).click();

  await expect(page).toHaveURL(/#screen=pattern-lab$/);
  await expect(page.getByTestId('pattern-lab-screen')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pattern Lab' })).toBeVisible();
  await expect(patterns).toBeVisible();
});

test('Pattern Lab keeps one lazy route descriptor and owns its stylesheet', () => {
  expect(APP_SOURCE).toMatch(/lazy\(\(\)\s*=>\s*import\(['"]\.\.\/pattern-lab\/PatternLabScreen\.jsx['"]\)\)/);
  expect(APP_SOURCE).toContain('const STUDIO_SCREENS');
  expect(APP_SOURCE).toContain('const SCREEN_BY_ID');

  const styleImporters = sourceFilesUnder(SRC_DIR)
    .filter(file => readFileSync(file, 'utf8').includes("import './pattern-lab.css'"))
    .map(file => relative(SRC_DIR, file));
  expect(styleImporters).toEqual(['pattern-lab/PatternLabScreen.jsx']);
});

test('Pattern Lab shell exposes its current step and decorative preview safely', async ({ page }) => {
  expect(LAB_SOURCE).toContain("aria-current={activeWorkflowStep === index ? 'step' : undefined}");
  expect(LAB_CSS).not.toMatch(/color:\s*var\(--text-faint\)/);
  expect(LAB_CSS).not.toMatch(/(?:^|[;{]\s*)color:\s*var\(--accent\)/m);

  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  const workflow = page.getByRole('navigation', { name: 'Pattern Lab workflow' });
  await expect(workflow.getByRole('button', { name: 'Choose' })).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('svg.plab-sculpture')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('svg.plab-sculpture')).toHaveAttribute('focusable', 'false');
});

test('compact Pattern Lab progression moves focus to each authoring destination', async ({ page }) => {
  await page.setViewportSize({ width: 1454, height: 894 });
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });

  const toolbar = page.getByTestId('pattern-lab-toolbar');
  const workflow = page.getByRole('navigation', { name: 'Pattern Lab workflow' });
  await expect(toolbar).toBeVisible();
  expect((await toolbar.boundingBox())!.height).toBeLessThanOrEqual(56);

  const choose = workflow.getByRole('button', { name: 'Choose' });
  const sculpt = workflow.getByRole('button', { name: 'Sculpt' });
  const evolve = workflow.getByRole('button', { name: 'Evolve' });
  const save = workflow.getByRole('button', { name: 'Save' });
  for (const step of [choose, sculpt, evolve, save]) {
    await expect(step.locator('svg')).toHaveCount(1);
    expect((await step.boundingBox())!.height).toBeGreaterThanOrEqual(36);
  }

  await choose.click();
  await expect(patternSearchInput(page)).toBeFocused();
  await choosePattern(page, 'aurora');

  await sculpt.click();
  await expect(page.getByRole('heading', { name: 'Sculpt', exact: true })).toBeFocused();
  await expect(sculpt).toHaveAttribute('aria-current', 'step');

  await evolve.click();
  await expect(page.getByRole('heading', { name: 'Evolve', exact: true })).toBeFocused();
  await expect(evolve).toHaveAttribute('aria-current', 'step');

  await save.click();
  await expect(page.getByRole('button', { name: 'Save private draft' })).toBeFocused();
  await expect(save).toHaveAttribute('aria-current', 'step');
});

test('Pattern Lab toolbar stays one quiet icon row from workspace width to phone width', async ({ page }) => {
  for (const viewport of [
    { width: 793, height: 768 },
    { width: 390, height: 844 },
    { width: 320, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });

    const toolbar = page.getByTestId('pattern-lab-toolbar');
    const workflow = page.getByRole('navigation', { name: 'Pattern Lab workflow' });
    const toolbarBox = await toolbar.boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(toolbarBox!.height).toBeLessThanOrEqual(56);
    await expect(workflow.locator('.plab-step-label')).toHaveCount(0);
    await expect(toolbar.getByRole('status', { name: /private workspace/i })).toBeVisible();
    await expect(toolbar.getByText(/your project and lights stay unchanged/i)).toHaveCount(0);

    for (const name of ['Choose', 'Sculpt', 'Evolve', 'Save']) {
      const step = workflow.getByRole('button', { name });
      await expect(step).toBeVisible();
      await expect(step.locator('svg')).toHaveCount(1);
      expect((await step.boundingBox())!.height)
        .toBeGreaterThanOrEqual(viewport.width <= 720 ? 44 : 36);
    }

    if (viewport.width <= 360) {
      await expect(toolbar.getByRole('heading', { name: 'Pattern Lab' })).toBeHidden();
    } else {
      await expect(toolbar.getByRole('heading', { name: 'Pattern Lab' })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
      .toBeLessThanOrEqual(0);
    // The document-level check above is not sufficient on its own: a live
    // session found 36px of horizontal overflow inside the Pattern Lab
    // scroll container while document.scrollWidth stayed clean, because
    // .plab-scroll owns its own overflow/scrollbar rather than the
    // document's. Check the inner scroll container directly so this class
    // of defect cannot ship unnoticed again.
    expect(await page.locator('.plab-scroll').evaluate(element => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(0);
  }
});

test('icon-only actions expose immediate styled tooltips on hover and keyboard focus', async ({ page }) => {
  await page.setViewportSize({ width: 1454, height: 894 });
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });

  const tooltipState = locator => locator.evaluate(element => {
    const styles = getComputedStyle(element, '::after');
    return {
      content: styles.content,
      opacity: styles.opacity,
      visibility: styles.visibility,
    };
  });
  const assertCustomTooltip = async (locator, copy) => {
    await expect(locator).toHaveAttribute('aria-label');
    await expect(locator).toHaveAttribute('title');
    await expect(locator).toHaveAttribute('data-tooltip', copy);
    await locator.focus();
    await expect.poll(() => tooltipState(locator)).toMatchObject({
      content: `"${copy}"`,
      opacity: '1',
      visibility: 'visible',
    });
  };

  const workflow = page.getByRole('navigation', { name: 'Pattern Lab workflow' });
  const patternTooltips = new Map([
    ['Choose', 'Choose a base pattern'],
    ['Sculpt', 'Color, brightness, and speed always apply; movement or shape and texture depend on what you picked'],
    ['Evolve', 'Build a long-changing journey'],
    ['Save', 'Save this variation privately'],
  ]);
  for (const [name, copy] of patternTooltips) {
    await assertCustomTooltip(workflow.getByRole('button', { name }), copy);
  }
  for (const name of ['Sculpt', 'Evolve', 'Save']) {
    await expect(workflow.getByRole('button', { name })).toHaveAttribute('data-tooltip-align', 'end');
  }

  const globalTooltips = ['New project', 'Projects', 'Preferences', 'Export project', 'Save project'];
  for (const copy of globalTooltips) {
    await assertCustomTooltip(page.getByRole('button', { name: copy, exact: true }), copy);
  }

  // The forced viewport above (1454x894) is desktop-sized, but Mobile
  // Chrome's project config also sets hasTouch: true — an honest emulation
  // of a real phone, which has no persistent hover. Pattern Lab's tooltip
  // CSS is gated behind `@media (hover: hover)` specifically so it never
  // leaks onto touch devices, so a hover-capable run must show the tooltip
  // on hover and a touch-only run must NOT — both are real, both are worth
  // asserting, rather than skipping the touch side of this test.
  const hoverCapable = await supportsHover(page);
  const choose = workflow.getByRole('button', { name: 'Choose' });
  await choose.hover();
  await expect.poll(() => tooltipState(choose)).toMatchObject(
    hoverCapable
      ? { content: '"Choose a base pattern"', opacity: '1', visibility: 'visible' }
      : { opacity: '0', visibility: 'hidden' },
  );

  const privateStatus = page.getByRole('status', { name: /private workspace/i });
  await expect(privateStatus).toHaveAttribute(
    'data-tooltip',
    'Private workspace: your project and lights stay unchanged',
  );
  await privateStatus.hover();
  await expect.poll(() => tooltipState(privateStatus)).toMatchObject(
    hoverCapable
      ? { content: '"Private workspace: your project and lights stay unchanged"', opacity: '1', visibility: 'visible' }
      : { opacity: '0', visibility: 'hidden' },
  );
});

test('compact project actions never overlap project identity at constrained widths', async ({ page }) => {
  for (const viewport of [
    { width: 1454, height: 894 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
    { width: 320, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
    await page.locator('.crumb .proj').evaluate(element => {
      element.textContent = 'Extremely Long Lightweaver Installation Project Name That Must Truncate Without Covering Any Global Actions';
    });

    const actions = page.locator('.top-right');
    const projectName = page.locator('.crumb .proj');
    await expect(projectName).toBeVisible();
    if (viewport.width > 360) await expect(page.locator('.brand .name')).toBeVisible();

    for (const name of ['New project', 'Projects', 'Preferences', 'Export project', 'Save project']) {
      const action = page.getByRole('button', { name, exact: true });
      await expect(action).toBeVisible();
      await expect(action.locator('svg')).toHaveCount(1);
      await expect(action.locator('.top-action-label')).toBeHidden();
      expect((await action.boundingBox())!.height)
        .toBeGreaterThanOrEqual(viewport.width <= 720 ? 44 : 36);
    }

    if (viewport.width <= 360) {
      await expect(page.getByRole('img', { name: 'Lightweaver' })).toBeVisible();
      await expect(page.locator('.brand .name')).toBeHidden();
    }

    const [projectBox, actionsBox, horizontalOverflow] = await Promise.all([
      projectName.boundingBox(),
      actions.boundingBox(),
      page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ]);
    expect(projectBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    if (projectBox!.y < actionsBox!.y + actionsBox!.height
      && actionsBox!.y < projectBox!.y + projectBox!.height) {
      expect(projectBox!.x + projectBox!.width).toBeLessThanOrEqual(actionsBox!.x);
    }
    expect(horizontalOverflow).toBeLessThanOrEqual(0);
  }
});

test('Pattern Lab workspace fills its Studio section without an inset frame', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });

  const screen = page.getByTestId('pattern-lab-screen');
  const workspace = page.getByRole('region', { name: 'Pattern authoring workspace' });
  const [screenBox, workspaceBox, shellStyles, workspaceStyles] = await Promise.all([
    screen.boundingBox(),
    workspace.boundingBox(),
    screen.locator('.plab-scroll').evaluate(element => {
      const styles = getComputedStyle(element);
      return {
        paddingTop: styles.paddingTop,
        paddingRight: styles.paddingRight,
        paddingBottom: styles.paddingBottom,
        paddingLeft: styles.paddingLeft,
      };
    }),
    workspace.evaluate(element => {
      const styles = getComputedStyle(element);
      return {
        borderTopWidth: styles.borderTopWidth,
        borderRadius: styles.borderRadius,
        boxShadow: styles.boxShadow,
      };
    }),
  ]);

  expect(screenBox).not.toBeNull();
  expect(workspaceBox).not.toBeNull();
  expect(workspaceBox!.x).toBeCloseTo(screenBox!.x, 0);
  expect(workspaceBox!.x + workspaceBox!.width).toBeCloseTo(screenBox!.x + screenBox!.width, 0);
  expect(workspaceBox!.y + workspaceBox!.height).toBeCloseTo(screenBox!.y + screenBox!.height, 0);
  expect(shellStyles).toEqual({
    paddingTop: '0px',
    paddingRight: '0px',
    paddingBottom: '0px',
    paddingLeft: '0px',
  });
  expect(workspaceStyles).toEqual({
    borderTopWidth: '0px',
    borderRadius: '0px',
    boxShadow: 'none',
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const [mobileScreenBox, mobileWorkspaceBox] = await Promise.all([
    screen.boundingBox(),
    workspace.boundingBox(),
  ]);
  expect(mobileScreenBox).not.toBeNull();
  expect(mobileWorkspaceBox).not.toBeNull();
  expect(mobileWorkspaceBox!.y + mobileWorkspaceBox!.height)
    .toBeCloseTo(mobileScreenBox!.y + mobileScreenBox!.height, 0);
});

test('existing Studio routes remain available beside Pattern Lab', async ({ page }) => {
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('pattern-lab-screen')).toBeVisible();

  // Each route is proved mounted by a CSS selector rather than a test id: the
  // Card workspace has no test id that renders in every card state, so its root
  // class is the only always-present anchor. Keeping one form for all five
  // keeps the loop honest about what it is asserting.
  // The rail item was renamed from "Setup" to "Card" by the card-interaction
  // consolidation (PR #156, card-consolidation architecture) — the screen
  // itself (.card-workspace-screen, src/v3/lw-card.jsx) is unchanged.
  const routes = [
    { label: 'Layout', mounted: '[data-testid="layout-mode-switch"]' },
    { label: 'Patterns', mounted: '[data-testid="pattern-project-preview"]' },
    { label: 'Playlist', mounted: '[data-testid="playlist-physical-preview-status"]' },
    { label: 'Show', mounted: '[data-testid="show-stage"]' },
    // The Setup rail item became the consolidated Card workspace (PR #156).
    { label: 'Card', mounted: '.card-workspace-screen' },
  ];

  for (const route of routes) {
    const railItem = page.getByRole('button', { name: route.label, exact: true });
    await railItem.click();
    await expect(railItem).toHaveAttribute('aria-current', 'page');
    await expect(page.locator(route.mounted).first()).toBeVisible();
    await expect(page.getByTestId('pattern-lab-screen')).toHaveCount(0);
  }
});

// The tests below run at whatever width the active Playwright project
// provides — desktop chromium's 1280x720 and Mobile Chrome's emulated
// Pixel 5 (393x851) — rather than forcing a viewport, specifically so they
// exercise the drawer-gated mobile layout for real on the project that ships
// it. They were all found by hand at 375x812 on a physical phone and missed
// entirely by a suite that had never run below desktop width.
test('the pattern tile grid opens through the mobile drawer and stays reachable on desktop', async ({ page }) => {
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });

  if (await isMobileDrawerViewport(page)) {
    // Closed by default: the tile grid is drawer-gated content, so it must
    // not be the accessibility-tree/hit-testable until the drawer opens.
    await expect(patternTile(page, 'aurora')).not.toBeVisible();
  }

  await choosePattern(page, 'aurora');
  await expect(page.getByTestId('pattern-lab-draft-name')).toBeVisible();
  await expect(selectedPatternTile(page)).toHaveAttribute('data-pattern-id', 'aurora');

  if (await isMobileDrawerViewport(page)) {
    // The open drawer is the widest, most content-dense state the screen
    // reaches on a phone — the state most likely to reintroduce the
    // .plab-scroll inner overflow a prior session found while the document
    // level check stayed clean.
    expect(await innerScrollOverflow(page)).toBeLessThanOrEqual(0);
    await closeControls(page);
    await expect(patternTile(page, 'aurora')).not.toBeVisible();
    // The chosen draft's name stays on screen behind the closed drawer —
    // closing Controls must not lose the selection it just made.
    await expect(page.getByTestId('pattern-lab-draft-name')).toBeVisible();
  }
});

test('no two Studio status-bar chips occupy the same rectangle at Pattern Lab widths', async ({ page }) => {
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  // A live session found the offline-update chip and the firmware chip
  // assigned the same CSS grid cell at a narrow width, painting one over the
  // other. Check every width the app defines a distinct status-bar layout
  // for (src/v3/v3-styles.css: >1024px flex row, <=1024px wrapped flex,
  // <=640px named-grid-area layout), not just whatever the current project
  // happens to default to.
  for (const viewport of [{ width: 1280, height: 800 }, { width: 900, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const overlaps = await overlappingStatusBarChips(page);
    expect(overlaps, `status-bar chips overlapped at ${viewport.width}px: ${JSON.stringify(overlaps)}`).toEqual([]);
  }
});

test('primary Pattern Lab controls meet the 44px touch target floor on a phone', async ({ page }) => {
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  if (!(await isMobileDrawerViewport(page))) {
    // Touch-target sizing is a mobile-viewport concern; desktop chromium
    // still runs this file so a reader sees this decision, not a silent gap.
    return;
  }

  const preTargets = [
    page.getByRole('button', { name: 'Pattern controls' }),
    page.getByRole('button', { name: 'Choose', exact: true }),
  ];
  expect(await touchTargetShortfalls(page, preTargets)).toEqual([]);

  await choosePattern(page, 'aurora');
  const drawerTargets = [
    page.getByRole('button', { name: 'Close pattern controls' }),
    page.getByRole('slider', { name: 'Brightness' }),
    page.getByRole('slider', { name: 'Speed' }),
  ];
  expect(await touchTargetShortfalls(page, drawerTargets)).toEqual([]);
});

test('the preview stays visible and interactive while a control is being dragged on a phone', async ({ page }) => {
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  if (!(await isMobileDrawerViewport(page))) return;

  await choosePattern(page, 'aurora');
  const brightness = page.getByRole('slider', { name: 'Brightness' });
  await expect(brightness).toBeVisible();

  // Simulate the moment a real drag is in progress: pointer down on the
  // slider without releasing it. The owner's complaint was never about the
  // drawer being open — it is specifically that the artwork preview goes
  // dead exactly when they are mid-gesture watching it respond to their
  // thumb. Assert the BEHAVIOUR (the preview stays on screen and able to
  // receive interaction while that gesture is live), not today's markup, so
  // this keeps meaning the same thing after Phase 2 reshapes the drawer.
  const box = await brightness.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  try {
    // Check the actual inert boundary (`.plab-preview`, the ancestor
    // PatternLabScreen.jsx applies `inert={mobileDrawer && drawerOpen ? ''
    // : undefined}` to) rather than the inner preview content: `inert` is
    // not reflected onto descendant elements' own IDL property, only
    // enforced behaviourally, so asserting on a child would pass even while
    // the boundary that actually disables it is set.
    const previewRegion = page.locator('.plab-preview');
    await expect(previewRegion).toBeVisible();
    await expect(previewRegion).not.toHaveJSProperty('inert', true);
    await expect(page.getByTestId('pattern-lab-preview-content')).toBeVisible();
  } finally {
    await page.mouse.up();
  }
});
