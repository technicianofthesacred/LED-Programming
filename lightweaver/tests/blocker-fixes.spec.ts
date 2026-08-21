import { test, expect } from '@playwright/test';

// e2e coverage for two ui-repair blockers that live on the card workspace and
// the connection center. Helpers are self-contained (mirroring
// card-workspace.spec.ts) so this file never contends with other specs.

const CARD_ID = 'lw-blocker-tests';
const OLD_BUILD = 'a'.repeat(40);
const NEW_BUILD = 'b'.repeat(40);
const HOST = 'lightweaver.local';

test.beforeEach(async ({ page }) => {
  await page.route('http://192.168.4.1/**', route => route.abort());
});

// The footer card badge is on screen before the shell has finished wiring what
// it opens, so a click can land on a button that is not listening yet and be
// lost with no retry. Under a single-file run the wiring wins and the check
// passes; alongside other files it loses and the check fails describing a
// missing panel rather than a swallowed click. Ask for the panel until it is
// there, and never click while it is already open, which would close it.
async function openConnectionCenter(page) {
  const center = page.locator('#card-connection-center');
  await expect(async () => {
    if (!(await center.isVisible())) await page.getByTestId('card-link-status').click();
    await expect(center).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  return center;
}

async function dispatchCardLink(page, events) {
  // The shell subscribes to the shared card link when it mounts. Dispatching
  // before that happens throws the event away silently: the card never appears
  // to connect, and every later assertion fails describing the symptom rather
  // than the cause. The footer card chip is rendered by the shell, so waiting
  // for it is waiting for the subscriber.
  await page.waitForSelector('[data-testid="card-link-status"]');
  await page.evaluate(async (nextEvents) => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const link = getSharedCardLink();
    for (const event of nextEvents) link.dispatch(event);
  }, events);
}

function liveStatus(overrides = {}) {
  return {
    app: 'Lightweaver', provisioningContractVersion: 1,
    cardId: CARD_ID, firmwareVersion: '1.0.0', buildId: NEW_BUILD,
    bootId: 'boot-blocker-1', runtimePhase: 'ready', knownGoodProject: true,
    commandReady: true, outputReady: true,
    ...overrides,
  };
}

test('a reflashed card can keep its new firmware instead of being re-flashed (ui-repair B1)', async ({ page }) => {
  // The remembered identity carries the OLD build; the live card answers with
  // the NEW one. Before the fix the only offered action was "Update card",
  // which re-flashes and undoes the owner's own update.
  await page.addInitScript(([id, buildId]) => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id, firmwareVersion: '1.0.0', buildId }));
    localStorage.setItem('lw_card_host', 'lightweaver.local');
  }, [CARD_ID, OLD_BUILD]);
  await page.route(`http://${HOST}/**`, route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/status' || pathname === '/api/firmware-info') {
      return route.fulfill({ json: liveStatus() });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: HOST,
    card: { id: CARD_ID, firmwareVersion: '1.0.0', buildId: NEW_BUILD },
    expectedCard: { version: 1, id: CARD_ID, firmwareVersion: '1.0.0', buildId: OLD_BUILD },
    readiness: liveStatus(),
  }]);

  const center = await openConnectionCenter(page);
  await expect(center).toContainText(/its firmware changed/i);
  const trust = center.getByTestId('trust-updated-card');
  await expect(trust).toHaveText('Keep the new firmware on this card');
  await trust.click();

  // The remembered identity now carries the live card's new firmware build —
  // the loop can continue without deleting browser storage by hand.
  await expect.poll(async () => {
    const identity = await page.evaluate(() => JSON.parse(localStorage.getItem('lw_card_identity_v1') || 'null'));
    return identity?.buildId;
  }).toBe(NEW_BUILD);
});

test('Recover lights on a bench card is honest that the setup is untouched (ui-repair B4)', async ({ page }) => {
  const status = liveStatus({
    led: { pixels: 44 },
    projectId: 'lightweaver-bench-discovery-v1', projectRevision: 1,
    projectFingerprint: 'f'.repeat(16), provisionalSetup: true,
  });
  await page.addInitScript(([id, buildId]) => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id, firmwareVersion: '1.0.0', buildId }));
    localStorage.setItem('lw_card_host', 'lightweaver.local');
  }, [CARD_ID, NEW_BUILD]);
  await page.route(`http://${HOST}/**`, route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/wiring/status') {
      return route.fulfill({ json: { ok: true, state: 'known-good', currentOutputs: [] } });
    }
    if (pathname === '/api/recover-lights') {
      return route.fulfill({ json: { ok: true, accepted: true, diagnostics: { nonBlackPixels: 44, brightnessByte: 180 } } });
    }
    if (pathname === '/api/reboot') {
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: status });
  });
  await page.goto('/#screen=card&section=overview', { waitUntil: 'domcontentloaded' });
  await dispatchCardLink(page, [{
    type: 'direct-status', connected: true, host: HOST,
    card: { id: CARD_ID, firmwareVersion: '1.0.0', buildId: NEW_BUILD },
    expectedCard: { version: 1, id: CARD_ID, firmwareVersion: '1.0.0', buildId: NEW_BUILD },
    readiness: status,
  }]);

  await page.getByRole('button', { name: 'Recover lights', exact: true }).click();
  const note = page.locator('section[aria-label="Hardware checks and recovery"] [role="status"]');
  await expect(note).toContainText('still running the temporary Find-my-strips setup', { timeout: 30000 });
  await expect(note).toContainText('Clear temporary setup');
  await expect(note).not.toContainText('acknowledged');
});
