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

test('initializes one compact transferable geometry snapshot and keeps render messages small', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const messages: Array<Record<string, unknown>> = [];
    class InstrumentedWorker extends NativeWorker {
      postMessage(message: { type?: string; payload?: Record<string, unknown> }, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        messages.push({
          type: message?.type,
          hasGeometry: Boolean(message?.payload?.geometry),
          recipeKeys: message?.payload?.recipe ? Object.keys(message.payload.recipe as object).sort() : [],
          baseKind: (message?.payload?.recipe as { base?: { kind?: string } })?.base?.kind,
          seed: (message?.payload?.recipe as { seed?: number })?.seed,
          macroMovement: (message?.payload?.recipe as { macros?: { movement?: number } })?.macros?.movement,
          coordinates: Object.prototype.toString.call((message?.payload?.geometry as { coordinates?: unknown })?.coordinates),
          transferCount: Array.isArray(transferOrOptions) ? transferOrOptions.length : 0,
        });
        if (transferOrOptions === undefined) super.postMessage(message);
        else super.postMessage(message, transferOrOptions);
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: InstrumentedWorker });
    Object.defineProperty(window, '__LW_PATTERN_LAB_WORKER_MESSAGES__', { value: messages });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel('Base pattern').selectOption('aurora');
  await expect(page.getByTestId('pattern-lab-mapped-preview')).toHaveAttribute('data-worker-state', 'frame');
  await page.getByRole('slider', { name: 'Color', exact: true }).fill('57');
  await expect(page.getByTestId('pattern-lab-mapped-preview')).toHaveAttribute('data-worker-state', 'frame');

  const messages = await page.evaluate(() => (
    (window as typeof window & { __LW_PATTERN_LAB_WORKER_MESSAGES__: Array<Record<string, unknown>> })
      .__LW_PATTERN_LAB_WORKER_MESSAGES__
  ));
  const initializes = messages.filter(message => message.type === 'initialize');
  const renders = messages.filter(message => message.type === 'render');
  expect(initializes.length).toBeGreaterThan(0);
  expect(initializes.every(message => message.hasGeometry
    && message.coordinates === '[object Float64Array]'
    && Number(message.transferCount) === 2)).toBe(true);
  expect(renders.length).toBeGreaterThan(0);
  expect(renders.every(message => !message.hasGeometry)).toBe(true);
  expect(renders.every(message => JSON.stringify(message.recipeKeys) === JSON.stringify(['base', 'layers', 'macros', 'palette', 'seed']))).toBe(true);
  expect(renders.every(message => message.baseKind === 'lightweaver-pattern')).toBe(true);
  expect(renders.every(message => Number.isInteger(message.seed))).toBe(true);
  expect(renders.some(message => message.macroMovement === 0.5)).toBe(true);
});

test('matches full-layout pixels when preview sampling excludes a hidden extreme strip', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { compactPatternLabWorkerGeometry, clonePatternLabWorkerGeometryForTransfer } = await import('/src/lib/patternLabWorkerProtocol.js');
    const { normalizePalette, renderPixelFrame } = await import('/src/lib/frameEngine.js');
    const visiblePixels = Array.from({ length: 500 }, (_, index) => ({
      x: index,
      y: Math.sin(index / 17) * 30,
    }));
    const source = {
      strips: [
        { id: 'visible', pixels: visiblePixels, speed: 1, brightness: 1, hueShift: 0 },
        { id: 'hidden-extreme', pixels: [{ x: 10000, y: -5000 }] },
      ],
      hidden: { 'hidden-extreme': true },
      bpm: 91,
    };
    const compact = compactPatternLabWorkerGeometry(source);
    const transferred = clonePatternLabWorkerGeometryForTransfer(compact);
    const worker = new Worker(new URL('/src/pattern-lab/patternLab.worker.js', location.origin), { type: 'module' });
    const frame = new Promise<Record<string, unknown>>(resolve => {
      worker.addEventListener('message', event => {
        if (event.data?.type === 'ready') {
          worker.postMessage({
            type: 'render',
            requestId: 2,
            payload: {
              mode: 'preview',
              generation: 1,
              recipe: { base: { patternId: 'aurora', params: {} }, palette: ['#102040', '#f09030'], layers: [] },
              time: 12.5,
              renderOptions: {
                masterSpeed: 1,
                masterBrightness: 1,
                masterSaturation: 1,
                masterHueShift: 0,
              },
            },
          });
        }
        if (event.data?.type === 'frame') resolve(event.data.payload);
      });
    });
    worker.postMessage({
      type: 'initialize', requestId: 1, payload: { geometry: transferred.geometry, generation: 1 },
    }, transferred.transfer);
    const payload = await frame;
    worker.terminate();

    const indices = new Uint32Array(payload.indices as ArrayBuffer);
    const colors = new Uint8ClampedArray(payload.colors as ArrayBuffer);
    const expected = renderPixelFrame({
      t: 12.5,
      strips: [{
        id: 'visible', speed: 1, brightness: 1, hueShift: 0,
        pts: visiblePixels.map((pixel, index) => ({
          ...pixel,
          p: index / (visiblePixels.length - 1),
          i: index,
        })),
      }],
      patternId: 'aurora',
      params: {},
      paletteNorm: normalizePalette(['#102040', '#f09030']),
      bpm: 91,
      masterSpeed: 1,
      masterBrightness: 1,
      masterSaturation: 1,
      masterHueShift: 0,
      normBounds: compact.normalizationBounds,
    }).pixels;
    return {
      sampleCount: indices.length,
      indices: [...indices],
      actual: [...colors],
      expected: [...indices].flatMap(index => {
        const color = expected[index];
        return [color.r, color.g, color.b];
      }),
    };
  });

  expect(result.sampleCount).toBe(384);
  expect(result.indices).toEqual([...result.indices].sort((a, b) => a - b));
  expect(result.actual).toEqual(result.expected);
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

test('does not publish a superseded frame before the coalesced replacement dispatches', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const telemetry = {
      renderPosts: [] as Array<{ requestId: number; time: number }>,
      deliveredFrames: [] as Array<{ requestId: number; time: number }>,
      publishedFrames: [] as Array<{ requestId: number; time: number }>,
      terminated: 0,
      replacementQueued: false,
    };
    class SupersededFrameWorker extends NativeWorker {
      postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        const request = message as { type?: string; requestId?: number; payload?: { time?: number } };
        if (request.type === 'render' && request.payload?.time === 987.25) {
          telemetry.renderPosts.push({ requestId: request.requestId || 0, time: request.payload.time });
          if (!telemetry.replacementQueued) {
            telemetry.replacementQueued = true;
            queueMicrotask(() => {
              (window as typeof window & { __LW_SUPERSEDED_FRAME_RENDER__?: (time: number) => void })
                .__LW_SUPERSEDED_FRAME_RENDER__?.(988.5);
            });
          }
          setTimeout(() => {
            this.dispatchEvent(new MessageEvent('message', {
              data: {
                type: 'frame',
                requestId: request.requestId,
                payload: {
                  mode: 'final',
                  time: request.payload?.time,
                  generation: (request.payload as { generation?: number })?.generation,
                  sampleCount: 2,
                  totalSamples: 2,
                  colors: new Uint8ClampedArray([1, 2, 3, 4, 5, 6]).buffer,
                  indices: new Uint32Array([0, 1]).buffer,
                  syntheticDelayedFrame: true,
                },
              },
            }));
          }, 10);
        } else if (request.type === 'render' && request.payload?.time === 988.5) {
          telemetry.renderPosts.push({ requestId: request.requestId || 0, time: request.payload.time });
        }
        if (transferOrOptions === undefined) super.postMessage(message);
        else super.postMessage(message, transferOrOptions);
      }

      set onmessage(handler: ((this: Worker, ev: MessageEvent) => unknown) | null) {
        super.onmessage = handler ? event => {
          const time = event.data?.payload?.time;
          if (event.data?.type === 'frame' && (time === 987.25 || time === 988.5)) {
            if (time === 987.25 && event.data?.payload?.syntheticDelayedFrame !== true) return;
            const deliver = () => {
              telemetry.deliveredFrames.push({ requestId: event.data.requestId, time });
              handler.call(this, event);
            };
            deliver();
            return;
          }
          handler.call(this, event);
        } : null;
      }

      terminate() {
        telemetry.terminated += 1;
        super.terminate();
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: SupersededFrameWorker });
    Object.defineProperty(window, '__LW_SUPERSEDED_FRAME_TELEMETRY__', { value: telemetry });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const ReactModule = await import('/node_modules/.vite/deps/react.js');
    const React = ReactModule.default || ReactModule;
    const ReactDomClient = await import('/node_modules/.vite/deps/react-dom_client.js');
    const createRoot = ReactDomClient.createRoot || ReactDomClient.default.createRoot;
    const { default: usePatternLabWorker } = await import('/src/pattern-lab/usePatternLabWorker.js');
    const telemetry = (window as typeof window & {
      __LW_SUPERSEDED_FRAME_TELEMETRY__: {
        publishedFrames: Array<{ requestId: number; time: number }>;
      };
    }).__LW_SUPERSEDED_FRAME_TELEMETRY__;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const recipe = {
      base: { patternId: 'aurora', params: {} },
      palette: ['#102040', '#f09030'],
      layers: [],
    };
    const geometry = {
      strips: [{ id: 'race', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
      hidden: {},
    };
    const renderOptions = {
      masterSpeed: 1,
      masterBrightness: 1,
      masterSaturation: 1,
      masterHueShift: 0,
    };
    function Harness({ time }: { time: number }) {
      const result = usePatternLabWorker({ recipe, geometry, time, mode: 'final', renderOptions });
      React.useEffect(() => {
        if (result.frameRequestId && result.frame) {
          const previous = telemetry.publishedFrames.at(-1);
          if (previous?.requestId !== result.frameRequestId) {
            telemetry.publishedFrames.push({
              requestId: result.frameRequestId,
              time: result.frame.time,
            });
          }
        }
      }, [result.frame, result.frameRequestId]);
      return React.createElement('div', {
        id: 'superseded-frame-harness',
        'data-status': result.status,
        'data-frame': result.frameRequestId ?? '',
        'data-frame-time': result.frame?.time ?? '',
      });
    }
    const render = (time: number) => root.render(React.createElement(Harness, { time }));
    Object.defineProperty(window, '__LW_SUPERSEDED_FRAME_RENDER__', { value: render });
    render(987.25);
  });

  const harness = page.locator('#superseded-frame-harness');
  await expect(harness).toHaveAttribute('data-status', 'frame');
  await expect(harness).toHaveAttribute('data-frame-time', '988.5');
  const telemetry = await page.evaluate(() => {
    const value = (window as typeof window & {
      __LW_SUPERSEDED_FRAME_TELEMETRY__: Record<string, unknown>;
    }).__LW_SUPERSEDED_FRAME_TELEMETRY__;
    return JSON.parse(JSON.stringify(value));
  });
  const requestA = telemetry.renderPosts.find((post: { time: number }) => post.time === 987.25);
  const requestB = telemetry.renderPosts.find((post: { time: number }) => post.time === 988.5);
  expect(requestA).toBeTruthy();
  expect(requestB).toBeTruthy();
  expect(telemetry.deliveredFrames.some((frame: { requestId: number }) => frame.requestId === requestA.requestId)).toBe(true);
  expect(telemetry.publishedFrames.some((frame: { requestId: number }) => frame.requestId === requestA.requestId)).toBe(false);
  expect(telemetry.publishedFrames.at(-1)?.requestId).toBe(requestB.requestId);
  expect(telemetry.terminated).toBeGreaterThan(0);
});

test('cancels queued work and rejects forged geometry budgets without trusting render allocation hints', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const {
      PATTERN_LAB_WORKER_BUDGETS,
      clonePatternLabWorkerGeometryForTransfer,
      compactPatternLabWorkerGeometry,
    } = await import('/src/lib/patternLabWorkerProtocol.js');
    const compact = compactPatternLabWorkerGeometry({
      strips: [{ id: 's1', pixels: [{ x: 0, y: 0 }] }],
      hidden: {},
    });
    const initial = clonePatternLabWorkerGeometryForTransfer(compact);
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
    worker.postMessage({
      type: 'initialize', requestId: 1, payload: { geometry: initial.geometry, generation: 1 },
    }, initial.transfer);
    await Promise.race([ready, new Promise(resolve => setTimeout(resolve, 2000))]);
    worker.postMessage({
      type: 'render',
      requestId: 2,
      payload: {
        mode: 'preview',
        generation: 1,
        layerCount: 0,
        testGenerator: { kind: 'delay', milliseconds: 180 },
      },
    });
    worker.postMessage({ type: 'cancel', requestId: 3, payload: { targetRequestId: 2 } });
    const forged = clonePatternLabWorkerGeometryForTransfer(compact);
    forged.geometry.sourcePixelCount = PATTERN_LAB_WORKER_BUDGETS.maxSourcePixels + 1;
    worker.postMessage({
      type: 'initialize',
      requestId: 4,
      payload: { geometry: forged.geometry, generation: 2 },
    }, forged.transfer);
    worker.postMessage({
      type: 'render',
      requestId: 5,
      payload: {
        mode: 'final',
        generation: 1,
        layerCount: 0,
        allocationBytes: 1,
        recipe: { base: { patternId: 'aurora', params: {} }, palette: ['#000000', '#ffffff'] },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 350));
    worker.terminate();
    return { replies, errors, expectedAllocation: compact.geometryBytes + 7 };
  });

  expect(result.errors, JSON.stringify(result)).toEqual([]);
  expect(result.replies.some(reply => reply.type === 'ready' && reply.requestId === 1)).toBe(true);
  expect(result.replies.some(reply => reply.type === 'frame' && reply.requestId === 2)).toBe(false);
  expect(result.replies.some(reply => reply.type === 'stats' && reply.requestId === 3)).toBe(true);
  expect(result.replies.some(reply => reply.type === 'error'
    && reply.requestId === 4
    && String(reply.payload?.message).includes('source pixels'))).toBe(true);
  expect(result.replies.some(reply => reply.type === 'stats'
    && reply.requestId === 5
    && reply.payload?.allocatedBytes === result.expectedAllocation)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Pattern Lab' })).toBeVisible();
});

test('terminates a genuine synchronous export render and replaces the worker cleanly', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { cancelPatternLabWorker } = await import('/src/pattern-lab/usePatternLabWorker.js');
    const { compactPatternLabWorkerGeometry, clonePatternLabWorkerGeometryForTransfer } = await import('/src/lib/patternLabWorkerProtocol.js');
    const replies: Array<{ type: string; requestId: number }> = [];
    const worker = new Worker(new URL('/src/pattern-lab/patternLab.worker.js', location.origin), { type: 'module' });
    worker.onmessage = event => replies.push(event.data);
    const pixels = Array.from({ length: 1024 }, (_, index) => ({ x: index / 1023, y: (index % 37) / 36 }));
    const compact = compactPatternLabWorkerGeometry({ strips: [{ id: 'export', pixels }], hidden: {} });
    const initial = clonePatternLabWorkerGeometryForTransfer(compact);
    await new Promise<void>(resolve => {
      worker.addEventListener('message', event => {
        if (event.data?.type === 'ready') resolve();
      }, { once: true });
      worker.postMessage({
        type: 'initialize', requestId: 1, payload: { geometry: initial.geometry, generation: 1 },
      }, initial.transfer);
    });
    worker.postMessage({
      type: 'render',
      requestId: 2,
      payload: {
        mode: 'export',
        generation: 1,
        layerCount: 0,
        recipe: { base: { patternId: 'aurora', params: {} }, palette: ['#000000', '#ffffff'] },
      },
    });
    cancelPatternLabWorker(worker);
    await new Promise(resolve => setTimeout(resolve, 150));

    const replacementReplies: Array<{ type: string; requestId: number }> = [];
    const replacement = new Worker(new URL('/src/pattern-lab/patternLab.worker.js', location.origin), { type: 'module' });
    replacement.onmessage = event => replacementReplies.push(event.data);
    const replacementGeometry = clonePatternLabWorkerGeometryForTransfer(compact);
    replacement.postMessage({
      type: 'initialize', requestId: 3, payload: { geometry: replacementGeometry.geometry, generation: 2 },
    }, replacementGeometry.transfer);
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

test('rejects malformed worker frames and retains the last valid mapped frame', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const control = { corruptFrames: false };
    class MalformedFrameWorker extends NativeWorker {
      set onmessage(handler: ((this: Worker, ev: MessageEvent) => unknown) | null) {
        super.onmessage = handler ? event => {
          if (control.corruptFrames && event.data?.type === 'frame') {
            handler.call(this, new MessageEvent('message', {
              data: {
                ...event.data,
                payload: { ...event.data.payload, colors: new ArrayBuffer(1) },
              },
            }));
            return;
          }
          handler.call(this, event);
        } : null;
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: MalformedFrameWorker });
    Object.defineProperty(window, '__LW_PATTERN_LAB_MALFORMED_FRAME__', { value: control });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel('Base pattern').selectOption('aurora');
  const preview = page.getByTestId('pattern-lab-mapped-preview');
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');
  const validFrameId = await preview.getAttribute('data-worker-frame-id');
  await page.evaluate(() => {
    (window as typeof window & { __LW_PATTERN_LAB_MALFORMED_FRAME__: { corruptFrames: boolean } })
      .__LW_PATTERN_LAB_MALFORMED_FRAME__.corruptFrames = true;
  });
  await page.getByRole('slider', { name: 'Color', exact: true }).fill('72');
  await expect(preview).toHaveAttribute('data-worker-error', /malformed/i);
  await expect(preview).toHaveAttribute('data-worker-frame-id', validFrameId || '');
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');
});

test('terminates every worker and clears queued rendering when the preview unmounts', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const lifecycle = { created: 0, terminated: 0, renderPosts: 0 };
    class LifecycleWorker extends NativeWorker {
      constructor(url: URL | string, options?: WorkerOptions) {
        super(url, options);
        lifecycle.created += 1;
      }

      postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        if ((message as { type?: string })?.type === 'render') lifecycle.renderPosts += 1;
        if (transferOrOptions === undefined) super.postMessage(message);
        else super.postMessage(message, transferOrOptions);
      }

      terminate() {
        lifecycle.terminated += 1;
        super.terminate();
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: LifecycleWorker });
    Object.defineProperty(window, '__LW_PATTERN_LAB_WORKER_LIFECYCLE__', { value: lifecycle });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel('Base pattern').selectOption('aurora');
  await expect(page.getByTestId('pattern-lab-mapped-preview')).toHaveAttribute('data-worker-state', 'frame');
  await page.getByRole('slider', { name: 'Color', exact: true }).fill('61');
  await page.evaluate(() => { window.location.hash = 'screen=pattern'; });
  await expect(page.getByTestId('pattern-lab-screen')).toHaveCount(0);
  const atUnmount = await page.evaluate(() => ({
    ...(window as typeof window & { __LW_PATTERN_LAB_WORKER_LIFECYCLE__: Record<string, number> })
      .__LW_PATTERN_LAB_WORKER_LIFECYCLE__,
  }));
  await page.waitForTimeout(300);
  const afterWait = await page.evaluate(() => ({
    ...(window as typeof window & { __LW_PATTERN_LAB_WORKER_LIFECYCLE__: Record<string, number> })
      .__LW_PATTERN_LAB_WORKER_LIFECYCLE__,
  }));
  expect(atUnmount.terminated).toBe(atUnmount.created);
  expect(afterWait.renderPosts).toBe(atUnmount.renderPosts);
});

test('replaces live geometry without mapping an old frame and falls back safely on invalid geometry', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const lifecycle = { created: 0, terminated: 0 };
    class GeometryWorker extends NativeWorker {
      constructor(url: URL | string, options?: WorkerOptions) {
        super(url, options);
        lifecycle.created += 1;
      }

      set onmessage(handler: ((this: Worker, ev: MessageEvent) => unknown) | null) {
        super.onmessage = handler ? event => {
          if (event.data?.type === 'frame') {
            setTimeout(() => handler.call(this, event), 120);
            return;
          }
          handler.call(this, event);
        } : null;
      }

      terminate() {
        lifecycle.terminated += 1;
        super.terminate();
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: GeometryWorker });
    Object.defineProperty(window, '__LW_PATTERN_LAB_GEOMETRY_LIFECYCLE__', { value: lifecycle });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const ReactModule = await import('/node_modules/.vite/deps/react.js');
    const React = ReactModule.default || ReactModule;
    const ReactDomClient = await import('/node_modules/.vite/deps/react-dom_client.js');
    const createRoot = ReactDomClient.createRoot || ReactDomClient.default.createRoot;
    const { default: usePatternLabWorker } = await import('/src/pattern-lab/usePatternLabWorker.js');
    const host = document.createElement('div');
    host.id = 'pattern-lab-worker-harness-host';
    document.body.append(host);
    const root = createRoot(host);
    const recipe = {
      base: { patternId: 'aurora', params: {} },
      palette: ['#102040', '#f09030'],
      layers: [],
    };
    const stableRenderOptions = {
      masterSpeed: 1,
      masterBrightness: 1,
      masterSaturation: 1,
      masterHueShift: 0,
    };
    function Harness({ geometry }: { geometry: Record<string, unknown> }) {
      const result = usePatternLabWorker({
        recipe,
        geometry,
        time: 4,
        mode: 'final',
        renderOptions: stableRenderOptions,
      });
      return React.createElement('div', {
        id: 'pattern-lab-worker-harness',
        'data-status': result.status,
        'data-frame': result.frameRequestId ?? '',
        'data-generation': result.geometryGeneration ?? '',
        'data-error': result.error?.message ?? '',
      });
    }
    const render = (geometry: Record<string, unknown>) => {
      root.render(React.createElement(Harness, { geometry }));
    };
    Object.defineProperty(window, '__LW_PATTERN_LAB_GEOMETRY_HARNESS__', {
      value: { render, unmount: () => root.unmount() },
    });
    render({
      strips: [{ id: 'a', pixels: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
      hidden: {},
    });
  });
  const harness = page.locator('#pattern-lab-worker-harness');
  await expect(harness).toHaveAttribute('data-status', 'frame');
  const firstFrame = await harness.getAttribute('data-frame');
  const firstGeneration = await harness.getAttribute('data-generation');

  await page.evaluate(() => {
    (window as typeof window & {
      __LW_PATTERN_LAB_GEOMETRY_HARNESS__: { render: (geometry: Record<string, unknown>) => void };
    }).__LW_PATTERN_LAB_GEOMETRY_HARNESS__.render({
      strips: [{ id: 'b', pixels: [
        { x: 10, y: 10 }, { x: 11, y: 11 }, { x: 12, y: 12 }, { x: 13, y: 13 },
      ] }],
      hidden: {},
    });
  });
  await expect.poll(async () => harness.getAttribute('data-generation')).not.toBe(firstGeneration);
  expect(await harness.getAttribute('data-frame')).toBe('');
  await expect(harness).toHaveAttribute('data-status', 'frame');
  expect(await harness.getAttribute('data-frame')).not.toBe(firstFrame);
  const validCounts = await page.evaluate(() => {
    const lifecycle = (window as typeof window & {
      __LW_PATTERN_LAB_GEOMETRY_LIFECYCLE__: { created: number; terminated: number };
    }).__LW_PATTERN_LAB_GEOMETRY_LIFECYCLE__;
    return { created: lifecycle.created, terminated: lifecycle.terminated };
  });
  expect(validCounts.created - validCounts.terminated).toBe(1);

  await page.evaluate(() => {
    (window as typeof window & {
      __LW_PATTERN_LAB_GEOMETRY_HARNESS__: { render: (geometry: Record<string, unknown>) => void };
    }).__LW_PATTERN_LAB_GEOMETRY_HARNESS__.render({ strips: [], hidden: {} });
  });
  await expect(harness).toHaveAttribute('data-status', 'fallback');
  await expect(harness).toHaveAttribute('data-frame', '');
  await expect(harness).toHaveAttribute('data-error', /visible source pixel/i);
  const invalidCounts = await page.evaluate(() => {
    const lifecycle = (window as typeof window & {
      __LW_PATTERN_LAB_GEOMETRY_LIFECYCLE__: { created: number; terminated: number };
    }).__LW_PATTERN_LAB_GEOMETRY_LIFECYCLE__;
    return { created: lifecycle.created, terminated: lifecycle.terminated };
  });
  expect(invalidCounts.created).toBe(invalidCounts.terminated);
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
