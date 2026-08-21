import { test, expect, type Page, type Route } from '@playwright/test';
import { choosePattern, closeControls } from './helpers/pattern-lab.ts';

// The owner streams Pattern Lab's frames to the physical piece continuously while
// he works — the artwork on the wall IS his preview. Then he puts the phone down.
//
// What used to happen: requestAnimationFrame freezes on a hidden tab and the main
// thread stops running, so the render that was in flight when the screen locked
// gets its reply only when the page wakes. The unresponsive watchdog measured that
// gap in WALL time from the moment the request was posted, so a thirty-second lock
// arrived back as dozens of missed 400 ms deadlines: the worker was destroyed,
// replaced, destroyed again, and the pattern was declared "too heavy to draw here"
// — while his piece silently held the last frame it had been sent. He came back to
// a frozen artwork and a screen that had given up on it.
//
// These specs hold the worker's frame reply across a hidden window, which is
// exactly that shape, and assert the pattern is still playing afterwards.

declare global {
  interface Window {
    __patternLabFrames: string[];
    __LW_HELD_FRAMES__: {
      hold: boolean;
      spawns: number;
      buffered: Array<{ handler: (event: MessageEvent) => unknown; event: MessageEvent; self: Worker }>;
      release(): void;
    };
    __LW_PAGE_VISIBILITY__: { hidden: boolean };
  }
}

// A worker whose FRAME replies can be withheld on command, plus a spawn counter.
// Withholding a frame reply is how a frozen main thread looks from inside the
// page: the worker itself never stopped, its answer simply could not be
// delivered. Everything else ('ready', 'error', 'warning', 'stats') passes
// through untouched so the only thing under test is the deadline.
async function installHeldFrameWorker(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const control = {
      hold: false,
      spawns: 0,
      buffered: [] as Array<{ handler: (event: MessageEvent) => unknown; event: MessageEvent; self: Worker }>,
      release() {
        const pending = control.buffered.splice(0, control.buffered.length);
        for (const entry of pending) entry.handler.call(entry.self, entry.event);
      },
    };
    class HeldFrameWorker extends NativeWorker {
      constructor(url: URL | string, options?: WorkerOptions) {
        super(url, options);
        control.spawns += 1;
      }

      set onmessage(handler: ((this: Worker, ev: MessageEvent) => unknown) | null) {
        super.onmessage = handler
          ? function wrapped(this: Worker, event: MessageEvent) {
            if (control.hold && (event.data as { type?: string })?.type === 'frame') {
              control.buffered.push({ handler, event, self: this });
              return;
            }
            handler.call(this, event);
          }
          : null;
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: HeldFrameWorker });
    Object.defineProperty(window, '__LW_HELD_FRAMES__', { configurable: true, value: control });
  });
}

// Playwright cannot really background a tab, so drive the two things the product
// actually reads: document.visibilityState and the visibilitychange event. That is
// the whole contract usePatternLabWorker.js listens to.
async function installVisibilityControl(page: Page) {
  await page.addInitScript(() => {
    const state = { hidden: false };
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (state.hidden ? 'hidden' : 'visible'),
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => state.hidden });
    Object.defineProperty(window, '__LW_PAGE_VISIBILITY__', { configurable: true, value: state });
  });
}

async function setPageHidden(page: Page, hidden: boolean) {
  await page.evaluate(next => {
    window.__LW_PAGE_VISIBILITY__.hidden = next;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

async function installCardHarness(page: Page) {
  const controlBodies: Record<string, unknown>[] = [];
  await page.addInitScript(() => {
    localStorage.setItem('lw_card_identity_v1', JSON.stringify({
      version: 1,
      id: 'test-card',
      name: 'Test card',
      host: 'lightweaver.local',
    }));
    window.__patternLabFrames = [];
    class FakeWebSocket {
      readyState = 0;
      bufferedAmount = 0;
      onopen: null | (() => void) = null;
      onerror: null | (() => void) = null;
      onclose: null | (() => void) = null;
      constructor(_url: string) {
        setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
      }
      send(payload: string) { window.__patternLabFrames.push(payload); }
      close() { this.readyState = 3; this.onclose?.(); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: FakeWebSocket });
  });
  await page.route('http://lightweaver.local/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Content-Type': 'application/json',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers, body: '' });
      return;
    }
    if (url.pathname === '/api/zones') {
      await route.fulfill({ status: 200, headers, json: {
        syncZones: false,
        zones: [{ id: 'all', patternId: 'aurora', brightness: 0.62, driftHueMin: 12, driftHueMax: 211 }],
      } });
      return;
    }
    if (url.pathname === '/api/firmware-info' || url.pathname === '/api/status') {
      await route.fulfill({ status: 200, headers, json: {
        cardId: 'test-card', name: 'Test card', firmwareVersion: '1.0.0', buildId: 'test-build',
      } });
      return;
    }
    if (url.pathname === '/api/control' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      controlBodies.push(body);
      await route.fulfill({ status: 200, headers, json: body.cancelStream && !body.patternId
        ? { ok: true }
        : { ok: true, cardId: 'test-card', patternId: body.patternId || 'aurora', appliedPatternId: body.patternId || 'aurora' } });
      return;
    }
    await route.fulfill({ status: 404, headers, json: { ok: false } });
  });
  return controlBodies;
}

async function startLivePreview(page: Page) {
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await choosePattern(page, 'aurora');
  await closeControls(page);
  const preview = page.getByTestId('pattern-lab-mapped-preview');
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');
  await page.getByRole('button', { name: 'Preview on Lights' }).click();
  await expect(page.getByRole('button', { name: 'Stop preview' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => window.__patternLabFrames.length)).toBeGreaterThan(0);
  return preview;
}

test('a locked phone does not cost the owner the pattern that is live on his piece', async ({ page }) => {
  await installHeldFrameWorker(page);
  await installVisibilityControl(page);
  await installCardHarness(page);
  const preview = await startLivePreview(page);

  const spawns = () => page.evaluate(() => window.__LW_HELD_FRAMES__.spawns);
  const spawnsBefore = await spawns();
  const frameIdBefore = await preview.getAttribute('data-worker-frame-id');

  // The screen locks: the render in flight will not be answered until it wakes.
  await page.evaluate(() => { window.__LW_HELD_FRAMES__.hold = true; });
  await setPageHidden(page, true);

  // Five seconds asleep. Under the old wall clock that was twelve missed 400 ms
  // deadlines: worker destroyed, replaced, destroyed again, pattern abandoned as
  // "too heavy to draw here" — all of it while nobody was looking.
  await page.waitForTimeout(5000);

  expect(await spawns()).toBe(spawnsBefore);
  await expect(preview).not.toHaveAttribute('data-worker-failure', 'pattern-too-heavy');
  await expect(preview).not.toHaveAttribute('data-worker-failure', 'pattern-unrenderable');

  // He picks the phone back up.
  await setPageHidden(page, false);
  await page.evaluate(() => {
    window.__LW_HELD_FRAMES__.hold = false;
    window.__LW_HELD_FRAMES__.release();
  });

  // The pattern is still the one playing: same worker, drawing again, still live
  // on the piece, and never abandoned.
  await expect.poll(() => preview.getAttribute('data-worker-state'), { timeout: 20_000 })
    .toMatch(/frame|rendering/);
  await expect.poll(() => preview.getAttribute('data-worker-frame-id'), { timeout: 20_000 })
    .not.toBe(frameIdBefore);
  expect(await spawns()).toBe(spawnsBefore);
  await expect(preview).not.toHaveAttribute('data-worker-failure', /pattern-(too-heavy|unrenderable)/);
  await expect(page.getByRole('button', { name: 'Stop preview' })).toHaveAttribute('aria-pressed', 'true');
  const framesAfterWake = await page.evaluate(() => window.__patternLabFrames.length);
  await expect.poll(() => page.evaluate(() => window.__patternLabFrames.length))
    .toBeGreaterThan(framesAfterWake);
});

test('a slow render degrades the preview without throwing the worker away', async ({ page }) => {
  await installHeldFrameWorker(page);
  await installVisibilityControl(page);
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
  await choosePattern(page, 'aurora');
  await closeControls(page);
  const preview = page.getByTestId('pattern-lab-mapped-preview');
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');
  const spawnsBefore = await page.evaluate(() => window.__LW_HELD_FRAMES__.spawns);

  // Withhold one frame for two seconds: five times the 400 ms degrade threshold,
  // comfortably short of the 1500 ms x 3 that authorises destroying anything.
  await page.evaluate(() => { window.__LW_HELD_FRAMES__.hold = true; });
  await expect(preview).toHaveAttribute('data-worker-degraded', 'true', { timeout: 10_000 });
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => window.__LW_HELD_FRAMES__.spawns)).toBe(spawnsBefore);

  await page.evaluate(() => {
    window.__LW_HELD_FRAMES__.hold = false;
    window.__LW_HELD_FRAMES__.release();
  });
  // A frame arriving clears the degrade by itself — no owner action, no reload.
  await expect.poll(() => preview.getAttribute('data-worker-degraded'), { timeout: 20_000 })
    .toBe(null);
  await expect(preview).toHaveAttribute('data-worker-state', /frame|rendering/);
});

test('giving up while the lights are live restores the piece and says so', async ({ page }) => {
  test.setTimeout(120_000);
  await installHeldFrameWorker(page);
  await installVisibilityControl(page);
  const controls = await installCardHarness(page);
  const preview = await startLivePreview(page);

  // Never answer another frame. This is the genuine non-terminating case — the
  // worker's own `while (true)` path, or a pattern an owner authored that does the
  // same — and it is the one state where the piece would otherwise sit frozen on
  // its last frame with nothing on the wall or the screen explaining why.
  await page.evaluate(() => { window.__LW_HELD_FRAMES__.hold = true; });

  await expect(preview).toHaveAttribute('data-worker-failure', 'pattern-too-heavy', { timeout: 60_000 });

  // The lights are put back on the look they had before the preview started —
  // a look the card plays on its own, so the artwork keeps moving.
  await expect.poll(() => controls.filter(body => body.cancelStream && !body.patternId).length, { timeout: 20_000 })
    .toBe(1);
  await expect.poll(() => controls.some(body => body.patternId === 'aurora' && body.zone === 'all'), { timeout: 20_000 })
    .toBe(true);

  // And the screen never lets him believe the pattern is still playing.
  const live = page.locator('.plab-live-preview');
  await expect(live).toHaveAttribute('data-live-state', 'pattern-stopped-restored', { timeout: 20_000 });
  await expect(live.getByRole('status')).toContainText('stopped drawing');
  await expect(page.getByRole('button', { name: 'Preview on Lights' })).toBeVisible();
});
