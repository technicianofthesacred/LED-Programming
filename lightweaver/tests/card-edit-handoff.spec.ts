import { test, expect, type Page } from '@playwright/test';

// The card→Patterns handoff must either open Patterns or explain why. What it
// must never do is bounce: Patterns returning to the card leaves the intent in
// the URL, the card auto-opens Patterns again, and this component remounts on
// every hop, resetting the once-only guards that were supposed to stop it. The
// loop had no exit and no rate limit — measured at ~45 resolutions per second,
// six card requests each, aimed at an ESP32 on the owner's shelf.

const CARD_ID = 'lw-ordinary-card';
const PROJECT_ID = 'ordinary-gallery-piece';
const PROJECT_NAME = 'Ordinary gallery piece';

test.beforeEach(async ({ page }) => {
  await page.route('http://lightweaver.local/**', route => route.abort());
  await page.route('http://192.168.4.1/**', route => route.abort());
});

async function dispatchCardLink(page: Page, events: unknown[]) {
  await page.evaluate(async (nextEvents) => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const link = getSharedCardLink();
    for (const event of nextEvents as any[]) {
      const priorBootId = link.getState().validatedBootId;
      link.dispatch(event);
      if (event.type === 'card-verified' && event.readiness?.bootId
        && (!priorBootId || priorBootId === event.readiness.bootId)) link.dispatch(event);
    }
  }, events);
}

function readyStatus(overrides = {}) {
  return {
    app: 'Lightweaver', provisioningContractVersion: 1,
    cardId: CARD_ID, firmwareVersion: '1.0.0', buildId: 'a'.repeat(40),
    bootId: 'boot-1', runtimePhase: 'ready', knownGoodProject: true,
    commandReady: true, outputReady: true,
    projectRevision: 3,
    ...overrides,
  };
}

// `reportsProjectId: false` models a card flashed before the firmware began
// sending `projectId` on /api/status. Such a card cannot prove which project
// is installed, so Studio must refuse — visibly, once.
async function seedCard(page: Page, { reportsProjectId = true } = {}) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (projectId) => {
    const { createDefaultProject } = await import('/src/lib/projectModel.js');
    const current = createDefaultProject();
    current.id = projectId;
    current.name = 'Ordinary gallery piece';
    current.layout.starterPending = false;
    localStorage.setItem('lw_autosave_v3', JSON.stringify(current));
    localStorage.setItem('lw_autosave_v3_backup', JSON.stringify(current));
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1, id: 'lw-ordinary-card', firmwareVersion: '1.0.0', buildId: 'a'.repeat(40),
    }));
  }, PROJECT_ID);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(650);
  const fingerprint = await page.evaluate(async () => {
    const resolver = await import('/src/lib/cardProjectResolver.js');
    const { migrateProject } = await import('/src/lib/projectModel.js');
    const normalized = JSON.parse(localStorage.getItem('lw_autosave_v3') || '{}');
    return resolver.cardProjectFingerprint(migrateProject(normalized));
  });

  const status = readyStatus({
    projectFingerprint: fingerprint,
    ...(reportsProjectId ? { projectId: PROJECT_ID } : {}),
  });
  const counts = { status: 0, info: 0 };
  await page.route('http://lightweaver.local/api/status', route => {
    counts.status += 1;
    return route.fulfill({ json: status });
  });
  await page.route('http://lightweaver.local/api/firmware-info', route => {
    counts.info += 1;
    // /api/firmware-info carries the same id under `piece.id`, always — which
    // is exactly why the two ends of the authorization must not read from
    // different payloads.
    return route.fulfill({ json: {
      ...status,
      projectFingerprint: fingerprint,
      piece: { id: PROJECT_ID, name: PROJECT_NAME },
    } });
  });
  return { status, counts };
}

async function arriveWithEditIntent(page: Page, status: Record<string, unknown>) {
  await page.goto('/?editPattern=aurora#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: 'lightweaver.local',
    card: { id: status.cardId, firmwareVersion: status.firmwareVersion, buildId: status.buildId },
    expectedCard: { id: status.cardId, firmwareVersion: status.firmwareVersion, buildId: status.buildId },
    readiness: status,
  }]);
}

test('a card that reports its installed project opens Patterns once, not repeatedly', async ({ page }) => {
  const { status, counts } = await seedCard(page);
  await arriveWithEditIntent(page, status);

  await expect(page).toHaveURL(/#screen=pattern$/, { timeout: 20_000 });
  await page.waitForTimeout(1_500);

  // Still there a moment later. The old behaviour reached #screen=pattern too
  // — for a few milliseconds at a time, hundreds of times a second.
  await expect(page).toHaveURL(/#screen=pattern$/);
  expect(counts.status, `resolved the card ${counts.status} times`).toBeLessThan(20);
});

test('a card whose firmware cannot report its installed project explains itself once', async ({ page }) => {
  const { status, counts } = await seedCard(page, { reportsProjectId: false });
  await arriveWithEditIntent(page, status);

  const alert = page.locator('.card-commissioning [role="alert"], [role="alert"]').first();
  await expect(alert).toContainText(/does not report which project is installed/i, { timeout: 20_000 });

  const settled = counts.status;
  await page.waitForTimeout(2_000);

  // The refusal is terminal: the owner stays on the card, and Studio stops
  // asking the card the same question.
  await expect(page).toHaveURL(/#screen=card/);
  expect(counts.status - settled, 'kept polling the card after refusing').toBeLessThan(5);
  expect(counts.status, `resolved the card ${counts.status} times`).toBeLessThan(20);
});

test('an intent Patterns cannot claim is offered, not handed over again', async ({ page }) => {
  // Landing on Patterns with an intent but no authorization to claim — a
  // bookmarked handoff URL, or a reload after the authorization lapsed. This
  // is the case that used to loop: Patterns returns to the card, the card sees
  // the intent still in the URL and sends the owner straight back.
  const { status, counts } = await seedCard(page);
  await page.goto('/?editPattern=aurora#screen=pattern', { waitUntil: 'domcontentloaded' });
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: 'lightweaver.local',
    card: { id: status.cardId, firmwareVersion: status.firmwareVersion, buildId: status.buildId },
    expectedCard: { id: status.cardId, firmwareVersion: status.firmwareVersion, buildId: status.buildId },
    readiness: status,
  }]);

  await expect(page).toHaveURL(/#screen=card/, { timeout: 20_000 });

  // The intent stays in the address bar: it is still what the owner came for,
  // and loading the project by hand must still honour it. What stops is the
  // automatic hand-over — the card offers the project instead.
  expect(new URL(page.url()).searchParams.get('editPattern')).toBe('aurora');
  await expect(
    page.getByRole('region', { name: 'Matching card project' }).getByRole('button', { name: /^Load / }),
  ).toBeVisible({ timeout: 20_000 });

  // And it stays put, instead of being handed back and forth.
  await page.waitForTimeout(1_500);
  await expect(page).toHaveURL(/#screen=card/);
  expect(counts.status, `resolved the card ${counts.status} times`).toBeLessThan(20);
});

test('loading the offered project by hand still honours the intent the owner arrived with', async ({ page }) => {
  // The recovery path the circuit breaker must leave open: suppressing the
  // automatic hand-over must not strand the owner away from what they asked
  // for. An explicit Load re-authorizes and opens Patterns.
  const { status } = await seedCard(page);
  await page.goto('/?editPattern=aurora#screen=pattern', { waitUntil: 'domcontentloaded' });
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: 'lightweaver.local',
    card: { id: status.cardId, firmwareVersion: status.firmwareVersion, buildId: status.buildId },
    expectedCard: { id: status.cardId, firmwareVersion: status.firmwareVersion, buildId: status.buildId },
    readiness: status,
  }]);

  const load = page.getByRole('region', { name: 'Matching card project' }).getByRole('button', { name: /^Load / });
  await expect(load).toBeVisible({ timeout: 20_000 });
  await load.click();

  await expect(page).toHaveURL(/#screen=pattern$/, { timeout: 20_000 });
});
