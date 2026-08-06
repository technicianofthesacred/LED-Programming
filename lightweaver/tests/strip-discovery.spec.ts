import { test, expect } from '@playwright/test';

// Strip discovery is the only flow that works on a card with nothing on it, and
// the two routing fixes it depends on are what stop a blank card being sent into
// the Layout install deadlock (install needs a bench LED check, the check sends
// frames, the bridge refuses frames while playbackReady is false).
//
// The card fixture below models the firmware, not a convenient stub. An earlier
// version of this file answered POST /api/config with `{ok:true,
// rebootRequired:true}` — a key the firmware does not have — and served the same
// blank /api/status for the whole run, so the card never left factory-beacon
// mode and the test still passed. That is precisely how a shipped deadlock
// reported itself as complete. Every response here is taken from
// LightweaverWeb.cpp `handleConfigPost` and LightweaverStorage.cpp.

const CARD_ID = 'lw-discovery-tests';
const BUILD_ID = 'd'.repeat(40);
const HOST = 'lightweaver.local';

// LightweaverWeb.cpp:1239 — the ordinary applied answer. The config is saved,
// runtimeApplySavedConfig() runs, and runtimeMarkRestartPending() sets a pending
// transition. The card does NOT restart itself: somebody has to POST /api/reboot.
function appliedConfigResponse() {
  return { ok: true, message: 'configuration saved', requiresReboot: true };
}

// LightweaverWeb.cpp:1218-1228 — the wiring-candidate answer. Note `ok` is TRUE
// on it, which is why a bare `response.ok` check reads a total non-event as
// success. Nothing was applied, nothing will reboot, the strip stays dark.
function stagedConfigResponse(activationId: string) {
  return {
    ok: true,
    state: 'staged',
    activationId,
    message: 'physical wiring changed',
    requiresReboot: false,
    requiresConfirmation: true,
  };
}

function blankStatus(overrides: Record<string, unknown> = {}) {
  // Exactly the shape classifyCardReadiness calls 'blank': erased NVS, so no
  // project identity at all and the factory-flash provisioning mode.
  return {
    app: 'Lightweaver',
    ok: true,
    provisioningContractVersion: 1,
    cardId: CARD_ID,
    firmwareVersion: '1.4.0',
    buildId: BUILD_ID,
    bootId: 'boot-discovery-1',
    runtimePhase: 'factory',
    mode: 'factory-flash',
    source: 'defaults',
    knownGoodProject: false,
    commandReady: false,
    playbackReady: false,
    outputReady: false,
    ...overrides,
  };
}

// What the card reports once it has rebooted onto a saved config: the identity
// it was given, a NEW boot id because it really restarted, and playbackReady —
// the exact flag the frame path is gated on.
function readyStatus(applied: any, boots: number) {
  return {
    app: 'Lightweaver',
    ok: true,
    provisioningContractVersion: 1,
    cardId: CARD_ID,
    firmwareVersion: '1.4.0',
    buildId: BUILD_ID,
    bootId: `boot-discovery-${boots + 1}`,
    runtimePhase: 'ready',
    mode: 'website-flash',
    source: 'nvs',
    projectId: applied?.projectId ?? '',
    projectRevision: applied?.projectRevision ?? 0,
    projectFingerprint: applied?.projectFingerprint ?? '',
    knownGoodProject: true,
    commandReady: true,
    playbackReady: true,
    outputReady: true,
    maxMilliamps: applied?.led?.maxMilliamps ?? 0,
    maxMilliampsSource: 'config',
  };
}

type CardFirmware = 'blank-applies' | 'stages-everything';

interface FakeCard {
  configs: any[];
  applied: any;
  reboots: number;
  booted: boolean;
  restartPending: boolean;
  statusReads: number;
  beaconPinned: number | null;
  beaconPins: number[];
  beaconRefused: number[];
}

// The ports a stock card can actually light: the approved output menu minus the
// GPIOs the default control assignment claims (4/5/6/7). Studio must render THIS
// list, not its own hardware contract, or it offers buttons that do nothing.
const BEACON_PORTS = [15, 16, 17, 18, 21, 38, 40, 41, 42, 47, 48];

/**
 * A blank card at `lightweaver.local`.
 *
 *  - 'blank-applies' is the firmware this flow targets: the blank card is
 *    exempted from the wiring-staging path, so its first config is applied and
 *    answered with requiresReboot. Only after a reboot does /api/status stop
 *    reporting blank.
 *  - 'stages-everything' is a card still on older firmware, where
 *    runtimeConfigJsonChangesWiring sees outputCount 0 -> N and files the write
 *    as a candidate. Nothing is applied and the card stays blank forever.
 */
async function mockBlankCard(page: any, { firmware = 'blank-applies' as CardFirmware } = {}) {
  const card: FakeCard = {
    configs: [], applied: null, reboots: 0, booted: false, restartPending: false, statusReads: 0,
    beaconPinned: null, beaconPins: [], beaconRefused: [],
  };
  await page.route(`http://${HOST}/**`, async (route: any) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/config' && request.method() === 'POST') {
      const config = JSON.parse(request.postData() || '{}');
      card.configs.push(config);
      if (firmware === 'stages-everything') {
        await route.fulfill({ json: stagedConfigResponse(`wiring-${card.configs.length}`) });
        return;
      }
      card.applied = config;
      card.restartPending = true;
      await route.fulfill({ json: appliedConfigResponse() });
      return;
    }
    if (pathname === '/api/reboot' && request.method() === 'POST') {
      card.reboots += 1;
      if (card.applied) {
        card.booted = true;
        card.restartPending = false;
      }
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (pathname === '/api/status' || pathname === '/api/firmware-info') {
      card.statusReads += 1;
      await route.fulfill({ json: card.booted ? readyStatus(card.applied, card.reboots) : blankStatus() });
      return;
    }
    // The blank-card port probe. GET lists the ports this card can light; POST
    // pins one. GPIO 4/5/6/7 are absent because the stock control assignment
    // claims them — the card, not Studio, decides which ports exist.
    if (pathname === '/api/beacon/port') {
      if (request.method() === 'GET') {
        await route.fulfill({
          json: { ok: true, available: !card.booted, ports: BEACON_PORTS, pixelsPerPort: 8 },
        });
        return;
      }
      const body = JSON.parse(request.postData() || '{}');
      if (body.release) {
        card.beaconPinned = null;
        await route.fulfill({ json: { ok: true, pinned: false } });
        return;
      }
      if (!BEACON_PORTS.includes(body.gpio)) {
        card.beaconRefused.push(body.gpio);
        await route.fulfill({
          status: 409,
          json: { ok: false, error: 'this card cannot light that port right now' },
        });
        return;
      }
      card.beaconPinned = body.gpio;
      card.beaconPins.push(body.gpio);
      await route.fulfill({ json: { ok: true, pinned: true, gpio: body.gpio, litPixels: 8, holdMs: 20000 } });
      return;
    }
    await route.fulfill({ json: { ok: true } });
  });
  await page.route('http://192.168.4.1/**', (route: any) => route.abort());
  return card;
}

async function seedBlankCardLink(page: any) {
  await page.addInitScript(cardId => {
    localStorage.clear();
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({ version: 1, id: cardId }));
    localStorage.setItem('lw_card_host', 'lightweaver.local');
  }, CARD_ID);
}

async function dispatchBlankCard(page: any) {
  await page.evaluate(async status => {
    const { getSharedCardLink } = await import('/src/lib/cardLink.js');
    const link = getSharedCardLink();
    const event = {
      type: 'card-verified',
      transport: 'direct',
      host: 'lightweaver.local',
      readiness: status,
      card: { id: status.cardId, firmwareVersion: status.firmwareVersion, buildId: status.buildId },
    };
    link.dispatch(event);
    link.dispatch(event);
  }, blankStatus());
}

// Walk the port picker to the point where the one card write has happened and
// the card is answering as Ready.
async function startDiscoveryOnGpio16(page: any) {
  const panel = page.getByTestId('strip-discovery');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('discovery-start')).toBeDisabled();
  await page.getByLabel('GPIO 16 role').selectOption('strip');
  await page.getByTestId('discovery-start').click();
}

test.describe('a blank card whose firmware applies its first config', () => {
  let card: FakeCard;

  test.beforeEach(async ({ page }) => {
    card = await mockBlankCard(page, { firmware: 'blank-applies' });
    await seedBlankCardLink(page);
  });

  // The owner usually already knows roughly where they plugged the strip in.
  // Confirming that by waiting for the beacon sweep to reach their port means
  // watching and trusting they read the timing right; clicking the port and
  // looking is the same answer without the guesswork.
  test('clicking a port lights that port, and only that port', async ({ page }) => {
    await page.goto('/#screen=discovery', { waitUntil: 'domcontentloaded' });
    await dispatchBlankCard(page);
    await expect(page.getByTestId('strip-discovery')).toBeVisible();

    await page.getByTestId('discovery-probe-18').click();
    await expect(page.getByTestId('discovery-probe-18')).toHaveText('Lit — turn off');
    await expect(page.getByTestId('discovery-probe-18')).toHaveAttribute('aria-pressed', 'true');
    // Polled, not asserted outright: the button label reflects Studio's own
    // state as soon as React re-renders, while the card only knows once the
    // request lands. What matters is where the light ends up.
    await expect.poll(() => card.beaconPinned, {
      message: 'the card must be lighting the port the owner named',
    }).toBe(18);
    expect(card.beaconPins).toEqual([18]);

    // Picking a different port moves the light rather than lighting both, or the
    // owner could not tell which port answered.
    await page.getByTestId('discovery-probe-21').click();
    await expect(page.getByTestId('discovery-probe-21')).toHaveText('Lit — turn off');
    await expect(page.getByTestId('discovery-probe-18')).toHaveText('Light it');
    await expect.poll(() => card.beaconPinned).toBe(21);

    // Clicking the lit port again turns it off, so a probe can be stopped
    // without leaving the screen.
    await page.getByTestId('discovery-probe-21').click();
    await expect(page.getByTestId('discovery-probe-21')).toHaveText('Light it');
    await expect.poll(() => card.beaconPinned).toBeNull();
  });

  test('the grid offers exactly the ports the card says it can light', async ({ page }) => {
    await page.goto('/#screen=discovery', { waitUntil: 'domcontentloaded' });
    await dispatchBlankCard(page);
    await expect(page.getByTestId('strip-discovery')).toBeVisible();
    await expect(page.getByTestId('discovery-probe-hint')).toBeVisible();

    for (const pin of BEACON_PORTS) {
      await expect(page.getByTestId(`discovery-probe-${pin}`)).toBeVisible();
    }
    // The stock controls claim 4/5/6/7. Studio must take that from the CARD, not
    // from its own hardware contract, because the control assignment lives in
    // the card's config and differs between cards. A button here would light
    // nothing and read as a dead port.
    for (const claimed of [4, 5, 6, 7]) {
      await expect(page.getByTestId(`discovery-probe-${claimed}`)).toHaveCount(0);
    }
    expect(card.beaconRefused, 'Studio must never ask for a port the card excluded').toEqual([]);
  });

  test('starting the run releases the port so the card is not left pinned', async ({ page }) => {
    await page.goto('/#screen=discovery', { waitUntil: 'domcontentloaded' });
    await dispatchBlankCard(page);
    await expect(page.getByTestId('strip-discovery')).toBeVisible();
    await page.getByTestId('discovery-probe-16').click();
    await expect.poll(() => card.beaconPinned).toBe(16);

    await startDiscoveryOnGpio16(page);
    // Once the bench config owns the outputs the beacon is no longer driving
    // anything, so a pin left behind would be a stale claim on the card.
    await expect.poll(() => card.beaconPinned).toBeNull();
  });

  test('a blank card is offered discovery, not the Layout dead end', async ({ page }) => {
    await page.goto('/#screen=layout', { waitUntil: 'domcontentloaded' });
    await dispatchBlankCard(page);
    await page.getByTestId('card-link-status').click();
    const findStrips = page.getByTestId('connection-find-strips');
    await expect(findStrips).toBeVisible();
    await expect(findStrips).toHaveText('Find my strips');
    await findStrips.click();
    await expect(page).toHaveURL(/#screen=discovery/);
    await expect(page.getByTestId('strip-discovery')).toBeVisible();
  });

  test('Test & Install sends a blank card to discovery instead of an LED check it cannot run', async ({ page }) => {
    await page.goto('/#screen=layout&mode=wire', { waitUntil: 'domcontentloaded' });
    await dispatchBlankCard(page);
    await expect(page.getByTestId('wire-blank-card-message'))
      .toHaveText('This card has no strips recorded yet. Find its strips first.');
    // The LED check is not offered, because it provably cannot complete here.
    await expect(page.getByTestId('start-led-check')).toHaveCount(0);
    await page.getByTestId('wire-find-strips').click();
    await expect(page).toHaveURL(/#screen=discovery/);
  });

  test('the one card write applies, reboots, and only then is the strip probed', async ({ page }) => {
    await page.goto('/#screen=discovery', { waitUntil: 'domcontentloaded' });
    await dispatchBlankCard(page);
    await startDiscoveryOnGpio16(page);

    // Probing must not begin while the card is still restarting: every frame
    // sent in that window is refused, and a dark strip reads as "no LEDs here".
    await expect(page.getByTestId('discovery-installing')).toBeVisible();
    await expect(page.getByTestId('discovery-probe')).toBeVisible({ timeout: 15000 });

    // Exactly one write, it was a config the card can actually run (one output
    // and one look is the whole validity bar), and Studio issued the restart
    // itself rather than leaving the card on its old pixel buffers.
    expect(card.configs).toHaveLength(1);
    expect(card.applied.led.outputs.length).toBeGreaterThanOrEqual(1);
    expect(card.applied.looks.length).toBeGreaterThanOrEqual(1);
    expect(card.reboots).toBe(1);
    expect(card.booted).toBe(true);
    expect(card.restartPending).toBe(false);
  });

  test('probe, decade read-off and end marker produce recorded counts', async ({ page }) => {
    await page.goto('/#screen=discovery', { waitUntil: 'domcontentloaded' });
    await dispatchBlankCard(page);

    // Every port starts unused: the card's compiled pin menu is wider than the
    // four outputs it can drive, so discovery never guesses which are wired.
    await startDiscoveryOnGpio16(page);

    await expect(page.getByTestId('discovery-probe')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('discovery-lit-count')).toHaveText('8');
    await page.getByTestId('discovery-more').click();
    await expect(page.getByTestId('discovery-lit-count')).toHaveText('16');
    await page.getByTestId('discovery-more').click();
    await expect(page.getByTestId('discovery-lit-count')).toHaveText('32');
    await page.getByTestId('discovery-enough').click();

    await expect(page.getByTestId('discovery-decade')).toBeVisible();
    const count = page.getByTestId('discovery-count-16');
    await count.fill('47');
    await page.getByTestId('discovery-counts-done').click();

    await expect(page.getByTestId('discovery-end-marker')).toBeVisible();
    // "No" reopens the probe for this port without losing anything else.
    await page.getByTestId('discovery-end-no').click();
    await expect(page.getByTestId('discovery-probe')).toBeVisible();
    await page.getByTestId('discovery-enough').click();
    await count.fill('47');
    await page.getByTestId('discovery-counts-done').click();
    await page.getByTestId('discovery-end-yes').click();

    await expect(page.getByTestId('discovery-record')).toBeVisible();
    await expect(page.getByTestId('discovery-result-16')).toHaveText('GPIO 16 · 47 LEDs');
    await page.getByTestId('discovery-record-save').click();
    await expect(page.getByTestId('discovery-done')).toBeVisible();

    const recorded = await page.evaluate(() => JSON.parse(localStorage.getItem('lw_port_roles_v1') || 'null'));
    expect(recorded).toContainEqual({ pin: 16, role: 'strip', pixelCount: 47, controlKind: '' });
  });

  test('a strip past the frame-rate threshold warns and keeps going', async ({ page }) => {
    await page.goto('/#screen=discovery', { waitUntil: 'domcontentloaded' });
    await dispatchBlankCard(page);
    await startDiscoveryOnGpio16(page);
    await expect(page.getByTestId('discovery-probe')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('discovery-enough').click();

    await page.getByTestId('discovery-count-16').fill('1400');
    const warning = page.getByTestId('discovery-warning-frame-rate');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('refreshes slower than 30 frames a second');
    await expect(warning).toContainText('It still works');

    // Warn, never block: the flow completes with the warning showing and the
    // oversized count is what gets recorded.
    await page.getByTestId('discovery-counts-done').click();
    await page.getByTestId('discovery-end-yes').click();
    await expect(page.getByTestId('discovery-result-16')).toHaveText('GPIO 16 · 1400 LEDs');
    await page.getByTestId('discovery-record-save').click();
    const recorded = await page.evaluate(() => JSON.parse(localStorage.getItem('lw_port_roles_v1') || 'null'));
    expect(recorded).toContainEqual({ pin: 16, role: 'strip', pixelCount: 1400, controlKind: '' });
  });
});

test.describe('a blank card on firmware that still stages the first config', () => {
  let card: FakeCard;

  test.beforeEach(async ({ page }) => {
    card = await mockBlankCard(page, { firmware: 'stages-everything' });
    await seedBlankCardLink(page);
  });

  test('a staged answer stops discovery and asks for a firmware update', async ({ page }) => {
    await page.goto('/#screen=discovery', { waitUntil: 'domcontentloaded' });
    await dispatchBlankCard(page);
    await startDiscoveryOnGpio16(page);

    // `ok: true` on the staged envelope is the trap. Nothing was applied, so
    // there is no honest way to continue — and the owner is told what to do
    // rather than left watching an unlit strip.
    const failure = page.getByTestId('discovery-failure');
    await expect(failure).toBeVisible({ timeout: 15000 });
    await expect(failure).toContainText(/update the card firmware/i);

    // Never silently treated as success: the probe phase is refused outright,
    // and Studio does not try to reboot a card that applied nothing.
    await expect(page.getByTestId('discovery-probe')).toHaveCount(0);
    await expect(page.getByTestId('discovery-decade')).toHaveCount(0);
    expect(card.configs).toHaveLength(1);
    expect(card.applied).toBeNull();
    expect(card.reboots).toBe(0);
    expect(card.booted).toBe(false);
  });
});
