import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
});

test('renders mapped frames through the bounded module worker', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');
  const preview = page.getByTestId('pattern-lab-mapped-preview');
  await expect(preview.locator('canvas')).toBeVisible();
  await expect(preview).toHaveAttribute('data-worker-available', 'true');
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');
  await expect(preview).toHaveAttribute('data-worker-sample-limit', '1024');

  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(preview).toHaveAttribute('data-worker-sample-limit', '384');
  await expect.poll(async () => Number(await preview.getAttribute('data-worker-request-id'))).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
});

test('uses preview samples during edits and restores a final frame after controls settle', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');
  const preview = page.getByTestId('pattern-lab-mapped-preview');
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');
  await expect(preview).toHaveAttribute('data-worker-sample-limit', '1024');

  await page.getByRole('slider', { name: 'Color', exact: true }).fill('63');
  expect(await preview.getAttribute('data-worker-sample-limit')).toBe('384');
  await expect(preview).toHaveAttribute('data-worker-sample-limit', '1024');
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');
});

test('coalesces changing control inputs to at most 24 worker renders per second', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const telemetry = { renderTimes: [] as number[], terminations: 0 };
    class InstrumentedWorker extends NativeWorker {
      postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        if ((message as { type?: string })?.type === 'render') telemetry.renderTimes.push(performance.now());
        if (transferOrOptions === undefined) super.postMessage(message);
        else super.postMessage(message, transferOrOptions);
      }

      terminate() {
        telemetry.terminations += 1;
        super.terminate();
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: InstrumentedWorker });
    Object.defineProperty(window, '__LW_PATTERN_LAB_WORKER_TELEMETRY__', { value: telemetry });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel('Base pattern').selectOption('aurora');
  await expect(page.getByTestId('pattern-lab-mapped-preview')).toHaveAttribute('data-worker-state', 'frame');
  await page.evaluate(() => {
    (window as typeof window & { __LW_PATTERN_LAB_WORKER_TELEMETRY__: { renderTimes: number[] } })
      .__LW_PATTERN_LAB_WORKER_TELEMETRY__.renderTimes.length = 0;
  });

  await page.getByRole('slider', { name: 'Color', exact: true }).evaluate(async slider => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    for (let index = 0; index < 80; index += 1) {
      setValue?.call(slider, String(20 + (index % 60)));
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 12));
    }
  });
  await page.waitForTimeout(300);
  const times = await page.evaluate(() => (
    (window as typeof window & { __LW_PATTERN_LAB_WORKER_TELEMETRY__: { renderTimes: number[] } })
      .__LW_PATTERN_LAB_WORKER_TELEMETRY__.renderTimes
  ));
  expect(times.length).toBeGreaterThan(10);
  const elapsed = times.at(-1)! - times[0];
  expect(elapsed).toBeGreaterThan(1000);
  const allowed = Math.floor(elapsed / (1000 / 24)) + 1;
  expect(times.length).toBeLessThanOrEqual(allowed);
});

test('cancels queued work and rejects allocation overflow without freezing the page', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const worker = new Worker(new URL('/src/pattern-lab/patternLab.worker.js', location.origin), { type: 'module' });
    const replies: Array<{ type: string; requestId: number; payload?: Record<string, unknown> }> = [];
    const errors: string[] = [];
    let resolveReady: (() => void) | null = null;
    const ready = new Promise<void>(resolve => { resolveReady = resolve; });
    worker.onmessage = event => {
      replies.push(event.data);
      if (event.data?.type === 'ready' && event.data?.requestId === 1) resolveReady?.();
    };
    worker.onerror = event => errors.push(event.message);
    worker.postMessage({ type: 'initialize', requestId: 1, payload: {} });
    await Promise.race([ready, new Promise(resolve => setTimeout(resolve, 2000))]);
    worker.postMessage({
      type: 'render',
      requestId: 2,
      payload: {
        mode: 'preview',
        sampleCount: 1,
        layerCount: 0,
        allocationBytes: 3,
        testGenerator: { kind: 'delay', milliseconds: 180 },
      },
    });
    worker.postMessage({ type: 'cancel', requestId: 3, payload: { targetRequestId: 2 } });
    worker.postMessage({
      type: 'render',
      requestId: 4,
      payload: {
        mode: 'final',
        sampleCount: 1,
        layerCount: 0,
        allocationBytes: 4 * 1024 * 1024 + 1,
      },
    });
    worker.postMessage({
      type: 'render',
      requestId: 5,
      payload: {
        mode: 'final',
        sampleCount: 1,
        layerCount: 0,
        allocationBytes: 5,
        recipe: { base: { patternId: 'aurora', params: {} }, palette: ['#000000', '#ffffff'] },
        geometry: {
          strips: [{ id: 's1', pixels: [{ x: 0, y: 0 }] }],
          hidden: {},
        },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 350));
    worker.terminate();
    return { replies, errors };
  });

  expect(result.errors, JSON.stringify(result)).toEqual([]);
  expect(result.replies.some(reply => reply.type === 'ready' && reply.requestId === 1)).toBe(true);
  expect(result.replies.some(reply => reply.type === 'frame' && reply.requestId === 2)).toBe(false);
  expect(result.replies.some(reply => reply.type === 'stats' && reply.requestId === 3)).toBe(true);
  expect(result.replies.some(reply => reply.type === 'error'
    && reply.requestId === 4
    && String(reply.payload?.message).includes('allocation exceeds'))).toBe(true);
  expect(result.replies.some(reply => reply.type === 'stats'
    && reply.requestId === 5
    && reply.payload?.allocatedBytes === 5)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Pattern Lab' })).toBeVisible();
});

test('terminates a genuine synchronous export render and replaces the worker cleanly', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { cancelPatternLabWorker } = await import('/src/pattern-lab/usePatternLabWorker.js');
    const replies: Array<{ type: string; requestId: number }> = [];
    const worker = new Worker(new URL('/src/pattern-lab/patternLab.worker.js', location.origin), { type: 'module' });
    worker.onmessage = event => replies.push(event.data);
    await new Promise<void>(resolve => {
      worker.addEventListener('message', event => {
        if (event.data?.type === 'ready') resolve();
      }, { once: true });
      worker.postMessage({ type: 'initialize', requestId: 1, payload: {} });
    });
    const pixels = Array.from({ length: 1024 }, (_, index) => ({ x: index / 1023, y: (index % 37) / 36 }));
    worker.postMessage({
      type: 'render',
      requestId: 2,
      payload: {
        mode: 'export',
        sampleCount: 1024,
        layerCount: 0,
        allocationBytes: 1024 * 5,
        recipe: { base: { patternId: 'aurora', params: {} }, palette: ['#000000', '#ffffff'] },
        geometry: { strips: [{ id: 'export', pixels }], hidden: {} },
      },
    });
    cancelPatternLabWorker(worker);
    await new Promise(resolve => setTimeout(resolve, 150));

    const replacementReplies: Array<{ type: string; requestId: number }> = [];
    const replacement = new Worker(new URL('/src/pattern-lab/patternLab.worker.js', location.origin), { type: 'module' });
    replacement.onmessage = event => replacementReplies.push(event.data);
    replacement.postMessage({ type: 'initialize', requestId: 3, payload: {} });
    await new Promise(resolve => setTimeout(resolve, 150));
    replacement.terminate();
    return { replies, replacementReplies };
  });

  expect(result.replies.some(reply => reply.type === 'frame' && reply.requestId === 2)).toBe(false);
  expect(result.replacementReplies.some(reply => reply.type === 'ready' && reply.requestId === 3)).toBe(true);
});

test('terminates a timed-out worker while retaining the last valid frame and responsive controls', async ({ page }) => {
  await page.getByLabel('Base pattern').selectOption('aurora');
  const preview = page.getByTestId('pattern-lab-mapped-preview');
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');
  const frameId = await preview.getAttribute('data-worker-frame-id');

  await page.evaluate(() => {
    (window as typeof window & { __LW_PATTERN_LAB_WORKER_TEST_MODE__?: unknown })
      .__LW_PATTERN_LAB_WORKER_TEST_MODE__ = { kind: 'loop' };
  });
  await page.getByRole('button', { name: 'Middle' }).click();
  await expect(preview).toHaveAttribute('data-worker-state', 'timeout', { timeout: 3000 });
  await expect(preview).toHaveAttribute('data-worker-frame-id', frameId || '');

  await page.getByRole('slider', { name: 'Color', exact: true }).fill('71');
  await expect(page.getByLabel('Color value')).toHaveText('71%');
  const retainedCanvas = await preview.locator('canvas').evaluate(canvas => canvas.toDataURL());
  expect(retainedCanvas).toMatch(/^data:image\/png;base64,/);
  expect(retainedCanvas.length).toBeGreaterThan(100);
});

test('falls back to the existing mapped renderer when Worker is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Worker', { configurable: true, value: undefined });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel('Base pattern').selectOption('aurora');
  const preview = page.getByTestId('pattern-lab-mapped-preview');
  await expect(preview).toHaveAttribute('data-worker-available', 'false');
  await expect(preview).toHaveAttribute('data-worker-state', 'fallback');
  await expect(preview.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByTestId('pattern-lab-time')).not.toHaveText('0:00 / 10:00');
});
