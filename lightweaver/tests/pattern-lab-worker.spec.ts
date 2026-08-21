import { test, expect } from '@playwright/test';
import { choosePattern } from './helpers/pattern-lab.ts';

test.beforeEach(async ({ page }) => {
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
});

test('renders mapped frames through the bounded module worker', async ({ page }) => {
  await choosePattern(page, 'aurora');
  const preview = page.getByTestId('pattern-lab-mapped-preview');
  await expect(preview.locator('canvas')).toBeVisible();
  await expect(preview).toHaveAttribute('data-worker-available', 'true');
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');
  // Pattern Lab opens already playing (patternlab-rebuild.md Phase 1), so the
  // worker is already serving preview-budget (384) samples -- there is no
  // idle "final" 1024-sample frame to observe until the owner pauses.
  await expect(preview).toHaveAttribute('data-worker-sample-limit', '384');

  // PatternLabVariants.jsx (the four thumbnail previews this used to check)
  // and PatternLabLayers.jsx ("Add layer") were both deleted in this
  // rebuild — see todo/plans/patternlab-rebuild.md §7 Phase 1. Color is the
  // surviving control that provably reaches the worker, so it stands in for
  // "a control change produces a fresh rendered frame".
  const colorFrame = await preview.getAttribute('data-worker-frame-id');
  const colorBefore = await preview.locator('canvas').evaluate(canvas => canvas.toDataURL());
  await page.getByRole('slider', { name: 'Color', exact: true }).fill('100');
  await expect.poll(async () => preview.getAttribute('data-worker-frame-id')).not.toBe(colorFrame);
  await expect.poll(() => preview.locator('canvas').evaluate(canvas => canvas.toDataURL()))
    .not.toBe(colorBefore);

  // Already playing since mount -- no Play click needed to keep frames
  // flowing at the preview budget.
  await expect(preview).toHaveAttribute('data-worker-sample-limit', '384');
  await expect.poll(async () => Number(await preview.getAttribute('data-worker-request-id'))).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
});

test('Kaleidoscope multilayer direct and worker bakes are byte-identical in physical order', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { bakePatternLabRecipe } = await import('/src/lib/lwseqBake.js');
    const { recipeFromPattern } = await import('/src/lib/patternLabPatternAdapter.js');
    const nativeWorker = globalThis.Worker;
    const recipe = recipeFromPattern('meteor', { palette: ['#000000', '#ff0000'] });
    recipe.evolution.durationSeconds = 1;
    recipe.base.params = { speed: 1, tailLen: 0.8 };
    recipe.layers = [
      { generator: { kind: 'lightweaver-pattern', patternId: 'scanner', params: { width: 0.4, hue: 0.1 } }, opacity: 0.4, blendMode: 'screen', mask: { kind: 'none' } },
      { generator: { kind: 'lightweaver-pattern', patternId: 'neon', params: { rate: 3 } }, opacity: 0.3, blendMode: 'multiply', mask: { kind: 'none' } },
    ];
    const input = {
      recipe,
      strips: [{
        id: 'ring', name: 'Ring', brightness: 1, speed: 1, hueShift: 0,
        pixels: Array.from({ length: 8 }, (_, index) => ({ x: index, y: index % 2 })),
        kaleidoscope: { enabled: true, pointCount: 4, startLed: 0, offsets: [0, 0, 0, 0] },
      }],
      groups: [],
      wiring: {
        version: 1, locked: true, verified: true,
        outputs: [{ id: 'out-1', name: 'Output 1', pin: 16, runIds: ['ring-run'] }],
        runs: [{
          id: 'ring-run', type: 'strip', verified: true,
          source: { stripId: 'ring', from: 0, to: 7 },
          directionPolicy: 'fixed', physicalDirection: 'source-reverse', seamLed: null,
        }],
      },
      hidden: {},
      render: {
        bpm: 120,
        gammaEnabled: false,
        gammaValue: 2.2,
        symSettings: {
          enabled: true,
          type: 'guide-mirror',
          guide: { mode: 'fold', axis: { x1: 0, y1: 0, x2: 1, y2: 0 } },
        },
      },
      fps: 1,
    };
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: undefined });
    const direct = await bakePatternLabRecipe(input);
    Object.defineProperty(globalThis, 'Worker', { configurable: true, value: nativeWorker });
    const worker = await bakePatternLabRecipe(input);
    return {
      direct: [...direct.bytes],
      worker: [...worker.bytes],
      directHash: direct.sidecar.lwseqSha256,
      workerHash: worker.sidecar.lwseqSha256,
    };
  });
  expect(result.worker).toEqual(result.direct);
  expect(result.workerHash).toBe(result.directHash);
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
          recipeVersion: (message?.payload?.recipe as { version?: number })?.version,
          recipeLayerCount: (message?.payload?.recipe as { layers?: unknown[] })?.layers?.length,
          payloadLayerCount: message?.payload?.layerCount,
          macroMovement: (message?.payload?.recipe as { macros?: { movement?: number } })?.macros?.movement,
          masterSpeed: (message?.payload?.renderOptions as { masterSpeed?: number })?.masterSpeed,
          masterBrightness: (message?.payload?.renderOptions as { masterBrightness?: number })?.masterBrightness,
          motionWeights: (message?.payload?.renderOptions as { motionWeights?: Record<string, number> })?.motionWeights,
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
  await choosePattern(page, 'aurora');
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
    && Number(message.transferCount) === 8)).toBe(true);
  expect(renders.length).toBeGreaterThan(0);
  expect(renders.every(message => !message.hasGeometry)).toBe(true);
  expect(renders.every(message => [
    'base', 'evolution', 'id', 'layers', 'macros', 'name', 'palette', 'playback',
    'provenance', 'requirements', 'seed', 'targets', 'version',
  ].every(key => (message.recipeKeys as string[]).includes(key)))).toBe(true);
  expect(renders.every(message => message.baseKind === 'lightweaver-pattern')).toBe(true);
  expect(renders.every(message => Number.isInteger(message.seed))).toBe(true);
  expect(renders.every(message => message.recipeVersion === 2)).toBe(true);
  expect(renders.every(message => message.recipeLayerCount === message.payloadLayerCount)).toBe(true);
  expect(renders.every(message => message.masterSpeed === 1)).toBe(true);
  expect(renders.every(message => Number.isFinite(message.masterBrightness)
    && Number(message.masterBrightness) >= 0
    && Number(message.masterBrightness) <= 1)).toBe(true);
  expect(renders.every(message => {
    const weights = Object.values(message.motionWeights as Record<string, number>);
    return weights.length === 4
      && weights.every(weight => Number.isFinite(weight) && weight >= 0 && weight <= 1)
      && Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) < 1e-9;
  })).toBe(true);
  expect(renders.some(message => message.macroMovement === 0.5)).toBe(true);
});

test('matches full-layout pixels when preview sampling excludes a hidden extreme strip', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { compactPatternLabWorkerGeometry, clonePatternLabWorkerGeometryForTransfer } = await import('/src/lib/patternLabWorkerProtocol.js');
    const { renderPatternLabRecipeFrame } = await import('/src/lib/patternLabPatternAdapter.js');
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
    const recipe = {
      version: 2,
      id: 'hidden-extreme',
      name: 'Hidden extreme',
      base: { kind: 'lightweaver-pattern', patternId: 'aurora', params: {} },
      palette: ['#102040', '#f09030'],
      macros: { color: 0.5, movement: 0, shape: 0.5, texture: 0.5 },
      playback: { brightness: 1, speed: 1 },
      evolution: {
        enabled: false,
        character: 'slow-bloom',
        durationSeconds: 600,
        change: 0,
        dynamics: { dynamicRange: 0.55, rareEventStrength: 0.4 },
      },
      seed: 1,
      layers: [],
      targets: [],
      requirements: [],
      provenance: [],
    };
    const renderOptions = {
      masterSpeed: 1,
      masterBrightness: 1,
      masterSaturation: 1,
      masterHueShift: 0,
      motionWeights: { drift: 1, flow: 0, pulse: 0, surge: 0 },
    };
    const frame = new Promise<Record<string, unknown>>(resolve => {
      worker.addEventListener('message', event => {
        if (event.data?.type === 'ready') {
          worker.postMessage({
            type: 'render',
            requestId: 2,
            payload: {
              mode: 'preview',
              generation: 1,
              layerCount: 0,
              recipe,
              time: 12.5,
              renderOptions,
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
    const expected = renderPatternLabRecipeFrame(recipe, {
      t: 12.5,
      strips: [{
        id: 'visible', speed: 1, brightness: 1, hueShift: 0,
        pts: visiblePixels.map((pixel, index) => ({
          ...pixel,
          p: index / (visiblePixels.length - 1),
          i: index,
        })),
      }],
      bpm: 91,
      ...renderOptions,
      normBounds: compact.normalizationBounds,
    }).pixels;
    return {
      sampleCount: indices.length,
      controlsApplied: payload.patternLabControlsApplied,
      indices: [...indices],
      actual: [...colors],
      expected: [...indices].flatMap(index => {
        const color = expected[index];
        return [color.r, color.g, color.b];
      }),
    };
  });

  expect(result.sampleCount).toBe(384);
  expect(result.controlsApplied).toBe(true);
  expect(result.indices).toEqual([...result.indices].sort((a, b) => a - b));
  expect(result.actual).toEqual(result.expected);
});

test('uses preview samples during edits and restores a final frame after controls settle', async ({ page }) => {
  await choosePattern(page, 'aurora');
  const preview = page.getByTestId('pattern-lab-mapped-preview');
  // Pattern Lab opens already playing (patternlab-rebuild.md Phase 1), which
  // itself pins the worker to preview-budget samples. Pause first so there
  // is an idle, settled state to restore to -- that idle "final" frame is
  // what this test is actually about.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
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
    const telemetry = {
      renderEvents: [] as Array<{ at: number; seed: number | null }>,
      terminations: 0,
      creations: 0,
      initializes: 0,
    };
    class InstrumentedWorker extends NativeWorker {
      constructor(url: URL | string, options?: WorkerOptions) {
        super(url, options);
        telemetry.creations += 1;
      }

      postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        const request = message as { type?: string; payload?: { recipe?: { seed?: number } } };
        if (request?.type === 'initialize') telemetry.initializes += 1;
        if (request?.type === 'render') {
          telemetry.renderEvents.push({
            at: performance.now(),
            seed: Number.isInteger(request.payload?.recipe?.seed)
              ? request.payload!.recipe!.seed!
              : null,
          });
        }
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
  await choosePattern(page, 'aurora');
  await expect(page.getByTestId('pattern-lab-mapped-preview')).toHaveAttribute('data-worker-state', 'frame');
  const primarySeed = await page.evaluate(() => (
    (window as typeof window & {
      __LW_PATTERN_LAB_WORKER_TELEMETRY__: {
        renderEvents: Array<{ at: number; seed: number | null }>;
      };
    }).__LW_PATTERN_LAB_WORKER_TELEMETRY__.renderEvents.at(-1)?.seed ?? null
  ));
  expect(Number.isInteger(primarySeed)).toBe(true);
  await page.evaluate(() => {
    (window as typeof window & {
      __LW_PATTERN_LAB_WORKER_TELEMETRY__: { renderEvents: unknown[] };
    }).__LW_PATTERN_LAB_WORKER_TELEMETRY__.renderEvents.length = 0;
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
  const times = await page.evaluate(seed => (
    (window as typeof window & {
      __LW_PATTERN_LAB_WORKER_TELEMETRY__: {
        renderEvents: Array<{ at: number; seed: number | null }>;
      };
    }).__LW_PATTERN_LAB_WORKER_TELEMETRY__.renderEvents
      .filter(event => event.seed === seed)
      .map(event => event.at)
  ), primarySeed);
  expect(times.length).toBeGreaterThan(10);
  const elapsed = times.at(-1)! - times[0];
  expect(elapsed).toBeGreaterThan(1000);
  const allowed = Math.floor(elapsed / (1000 / 24)) + 1;
  expect(times.length).toBeLessThanOrEqual(allowed);

  // One worker, one geometry transfer, for the whole session of dragging.
  const lifecycle = await page.evaluate(() => {
    const value = (window as typeof window & {
      __LW_PATTERN_LAB_WORKER_TELEMETRY__: {
        creations: number; terminations: number; initializes: number;
      };
    }).__LW_PATTERN_LAB_WORKER_TELEMETRY__;
    return { creations: value.creations, terminations: value.terminations, initializes: value.initializes };
  });
  // Load-insensitive by construction. The old behaviour terminated and respawned once
  // per overlapping render, so creations tracked times.length (24/s during a drag). The
  // product's own cap is at most 2 automatic replacements, so 1 + 2 is the ceiling no
  // matter how slow the host is — while a return of terminate-on-overlap blows past it
  // immediately. Asserting exactly 0 made a legitimate watchdog replacement under host
  // load read as a code regression.
  expect(lifecycle.creations).toBeLessThanOrEqual(3);
  expect(lifecycle.terminations).toBeLessThan(times.length / 2);
  expect(lifecycle.creations).toBe(lifecycle.initializes);
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
                  patternLabControlsApplied: true,
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
      version: 2,
      id: 'superseded-frame',
      name: 'Superseded frame',
      base: { kind: 'lightweaver-pattern', patternId: 'aurora', params: {} },
      palette: ['#102040', '#f09030'],
      macros: { color: 0.5, movement: 0.5, shape: 0.5, texture: 0.5 },
      playback: { brightness: 1, speed: 1 },
      evolution: {
        enabled: false,
        character: 'slow-bloom',
        durationSeconds: 600,
        change: 0,
        dynamics: { dynamicRange: 0.55, rareEventStrength: 0.4 },
      },
      seed: 1,
      layers: [],
      targets: [],
      requirements: [],
      provenance: [],
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
      motionWeights: { drift: 0, flow: 1, pulse: 0, surge: 0 },
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
  // The superseded frame is dropped on arrival, not killed: one worker survives the
  // whole exchange, so its geometry is never re-transferred.
  expect(telemetry.terminated).toBe(0);
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
    const recipe = {
      version: 2,
      id: 'allocation-baseline',
      name: 'Allocation baseline',
      base: { kind: 'lightweaver-pattern', patternId: 'aurora', params: {} },
      palette: ['#000000', '#ffffff'],
      macros: { color: 0.5, movement: 0.5, shape: 0.5, texture: 0.5 },
      playback: { brightness: 1, speed: 1 },
      evolution: {
        enabled: false,
        character: 'slow-bloom',
        durationSeconds: 600,
        change: 0,
        dynamics: { dynamicRange: 0.55, rareEventStrength: 0.4 },
      },
      seed: 1,
      layers: [],
      targets: [],
      requirements: [],
      provenance: [],
    };
    const renderOptions = {
      masterSpeed: 1,
      masterBrightness: 1,
      masterSaturation: 1,
      masterHueShift: 0,
      motionWeights: { drift: 0, flow: 1, pulse: 0, surge: 0 },
    };
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
        time: 0,
        recipe,
        renderOptions,
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
        time: 0,
        recipe,
        renderOptions,
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

// UN-SKIPPED 2026-08-21. The skip above was correct while ONE 400 ms deadline drove both
// the reversible degrade and the destructive replacement: a host slow enough to push a
// healthy 1024-sample render past 400 ms destroyed its worker, so three different tests
// in this file failed across nine solo runs on an idle machine. The two clocks are now
// separate (src/lib/patternLabRenderDeadline.js): 400 ms still degrades — cheap and
// self-healing — while destroying anything needs three missed 1500 ms deadlines, ~105x
// the worst measured healthy frame (14.3 ms). A merely slow host now degrades instead of
// escalating, which is what these tests were losing to.
test('terminates a timed-out worker while retaining the last valid frame and responsive controls', async ({ page }) => {
  await choosePattern(page, 'aurora');
  const preview = page.getByTestId('pattern-lab-mapped-preview');
  // Pattern Lab opens already playing (patternlab-rebuild.md Phase 1). Pause
  // so the single Middle click below is the only render trigger -- a ticking
  // clock would keep posting fresh render requests into the hung worker and
  // the "frame id never changes while hung" assertion would be racing them.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');
  // Pausing settles (180ms later) into one more render, this time at the FINAL
  // sample budget. Reading the frame id before that render lands makes "the last
  // good frame stayed on screen" assert against a frame the preview legitimately
  // replaced a moment afterwards — which is a race, not a defect. The served
  // sample limit flipping to 1024 is the deterministic signal that the settle
  // render has arrived, so wait for that rather than for a quiet interval.
  await expect(preview).toHaveAttribute('data-worker-sample-limit', '1024');
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');
  const frameId = await preview.getAttribute('data-worker-frame-id');

  await page.evaluate(() => {
    (window as typeof window & { __LW_PATTERN_LAB_WORKER_TEST_MODE__?: unknown })
      .__LW_PATTERN_LAB_WORKER_TEST_MODE__ = { kind: 'loop' };
  });
  await page.getByRole('button', { name: 'Middle', exact: true }).click();
  // 'timeout' is a TRANSIENT state on the way to a replacement, and it is reached only
  // after three missed 400ms deadlines. A 3000ms exact-match therefore raced twice over:
  // on a loaded host it could arrive late, and on a fast one the state could already have
  // advanced past it. What this test actually guarantees is that a hung worker degrades
  // visibly without blanking the preview -- so assert reaching ANY degraded state, then
  // the two things that matter to the owner.
  await expect
    .poll(() => preview.getAttribute('data-worker-state'), { timeout: 20_000 })
    .toMatch(/timeout|worker-error|failure/);
  await expect(preview).toHaveAttribute('data-worker-frame-id', frameId || '');

  await page.getByRole('slider', { name: 'Color', exact: true }).fill('71');
  await expect(page.getByLabel('Color value', { exact: true })).toHaveText('71%');
  const retainedCanvas = await preview.locator('canvas').evaluate(canvas => canvas.toDataURL());
  expect(retainedCanvas).toMatch(/^data:image\/png;base64,/);
  expect(retainedCanvas.length).toBeGreaterThan(100);
});

// UN-SKIPPED 2026-08-21. The skip above was correct while ONE 400 ms deadline drove both
// the reversible degrade and the destructive replacement: a host slow enough to push a
// healthy 1024-sample render past 400 ms destroyed its worker, so three different tests
// in this file failed across nine solo runs on an idle machine. The two clocks are now
// separate (src/lib/patternLabRenderDeadline.js): 400 ms still degrades — cheap and
// self-healing — while destroying anything needs three missed 1500 ms deadlines, ~105x
// the worst measured healthy frame (14.3 ms). A merely slow host now degrades instead of
// escalating, which is what these tests were losing to.
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
  await choosePattern(page, 'aurora');
  const preview = page.getByTestId('pattern-lab-mapped-preview');
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');
  // Pattern Lab opens already playing, so frames keep arriving. Reading the frame id
  // off a moving preview and only THEN corrupting the stream leaves a window in which
  // a perfectly legitimate later frame lands, and the "retained the last valid frame"
  // assertion then fails against a frame that was never corrupt. Pause, then wait for
  // the settle-to-final render (sample limit 1024) before taking the id.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(preview).toHaveAttribute('data-worker-sample-limit', '1024');
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
  await choosePattern(page, 'aurora');
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
      version: 2,
      id: 'geometry-replacement',
      name: 'Geometry replacement',
      base: { kind: 'lightweaver-pattern', patternId: 'aurora', params: {} },
      palette: ['#102040', '#f09030'],
      macros: { color: 0.5, movement: 0.5, shape: 0.5, texture: 0.5 },
      playback: { brightness: 1, speed: 1 },
      evolution: {
        enabled: false,
        character: 'slow-bloom',
        durationSeconds: 600,
        change: 0,
        dynamics: { dynamicRange: 0.55, rareEventStrength: 0.4 },
      },
      seed: 1,
      layers: [],
      targets: [],
      requirements: [],
      provenance: [],
    };
    const stableRenderOptions = {
      masterSpeed: 1,
      masterBrightness: 1,
      masterSaturation: 1,
      masterHueShift: 0,
      motionWeights: { drift: 0, flow: 1, pulse: 0, surge: 0 },
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

test('shows a neutral preparing state instead of an inaccurate base when Worker is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Worker', { configurable: true, value: undefined });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await choosePattern(page, 'aurora');
  const preview = page.getByTestId('pattern-lab-mapped-preview');
  await expect(preview).toHaveAttribute('data-worker-available', 'false');
  await expect(preview).toHaveAttribute('data-worker-state', 'fallback');
  await expect(preview.locator('canvas')).toHaveCount(0);
  await expect(preview.getByTestId('pattern-lab-preparing')).toBeVisible();
  // Pattern Lab opens already playing (patternlab-rebuild.md Phase 1); the
  // preview time clock runs independently of worker availability, so it is
  // already advancing without a Play click.
  await expect(page.getByTestId('pattern-lab-time')).not.toHaveText('0:00 / 10:00');
});

// This is the test the persistent-worker rewrite needed and did not have. The old
// "terminate on overlap" code had an implicit one-in-flight limit; removing it left
// the render effect posting at the 24/s throttle floor while a real render costs more
// than 41.7 ms, so the worker's message queue grew without bound, every reply arrived
// stale, and the preview stopped updating with a core pegged. Nothing in the suite
// noticed, because every other spec drives single edits rather than sustained playback.
test('keeps at most one render in flight while playback runs and keeps delivering frames', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const inFlightByWorker = new WeakMap<Worker, Set<number>>();
    const telemetry = { maxInFlight: 0, renderPosts: 0, frameReplies: 0, instances: 0 };
    const slot = (worker: Worker) => {
      let set = inFlightByWorker.get(worker);
      if (!set) {
        set = new Set<number>();
        inFlightByWorker.set(worker, set);
      }
      return set;
    };
    class BackpressureWorker extends NativeWorker {
      constructor(url: URL | string, options?: WorkerOptions) {
        super(url, options);
        telemetry.instances += 1;
        this.addEventListener('message', event => {
          const reply = (event as MessageEvent).data as { type?: string; requestId?: number };
          if (!reply) return;
          if (reply.type === 'frame' || reply.type === 'error') {
            if (reply.type === 'frame') telemetry.frameReplies += 1;
            slot(this).delete(Number(reply.requestId));
          }
        });
      }

      postMessage(message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
        const request = message as {
          type?: string; requestId?: number; payload?: { targetRequestId?: number };
        };
        if (request?.type === 'render') {
          telemetry.renderPosts += 1;
          const pending = slot(this);
          pending.add(Number(request.requestId));
          if (pending.size > telemetry.maxInFlight) telemetry.maxInFlight = pending.size;
        }
        if (request?.type === 'cancel') slot(this).delete(Number(request.payload?.targetRequestId));
        if (transferOrOptions === undefined) super.postMessage(message);
        else super.postMessage(message, transferOrOptions);
      }

      terminate() {
        slot(this).clear();
        super.terminate();
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: BackpressureWorker });
    Object.defineProperty(window, '__LW_PATTERN_LAB_BACKPRESSURE__', { value: telemetry });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await choosePattern(page, 'aurora');
  const preview = page.getByTestId('pattern-lab-mapped-preview');
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');

  // A real 384-sample render on a real piece costs more than the 41.7 ms throttle floor;
  // the diff that removed the limit conceded as much by raising renderWarningMs to 120.
  // Make that cost explicit so the ratio is deterministic instead of machine-dependent.
  await page.evaluate(() => {
    (window as typeof window & { __LW_PATTERN_LAB_WORKER_TEST_MODE__?: unknown })
      .__LW_PATTERN_LAB_WORKER_TEST_MODE__ = { kind: 'delay', milliseconds: 120 };
  });

  const frameBefore = await preview.getAttribute('data-worker-frame-id');
  // Already playing since mount (patternlab-rebuild.md Phase 1) -- no Play
  // click needed to keep renders flowing while backpressure is measured.
  await page.evaluate(() => {
    const telemetry = (window as typeof window & {
      __LW_PATTERN_LAB_BACKPRESSURE__: Record<string, number>;
    }).__LW_PATTERN_LAB_BACKPRESSURE__;
    telemetry.maxInFlight = 0;
    telemetry.renderPosts = 0;
    telemetry.frameReplies = 0;
  });
  // Wait for the preview to have genuinely produced frames rather than for a fixed
  // stretch of wall clock: on a loaded host 3500ms could elapse with fewer than 8
  // replies, which failed the liveness check below for reasons unrelated to the code.
  await expect
    .poll(() => page.evaluate(() => (
      (window as typeof window & {
        __LW_PATTERN_LAB_BACKPRESSURE__: Record<string, number>;
      }).__LW_PATTERN_LAB_BACKPRESSURE__.frameReplies
    )), { timeout: 40_000 })
    .toBeGreaterThan(8);
  const observed = await page.evaluate(() => ({
    ...(window as typeof window & {
      __LW_PATTERN_LAB_BACKPRESSURE__: Record<string, number>;
    }).__LW_PATTERN_LAB_BACKPRESSURE__,
  }));
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  // The invariant: one render in flight per worker, always. Without it this climbs to
  // roughly (24 posts/s - 8 drains/s) * seconds and never comes back down.
  expect(observed.maxInFlight).toBeLessThanOrEqual(1);
  // Posting is bounded by draining, not by the throttle floor.
  expect(observed.renderPosts).toBeLessThanOrEqual(observed.frameReplies + observed.instances);
  // And the preview must still be alive, not merely quiet.
  expect(observed.frameReplies).toBeGreaterThan(8);
  await expect(preview).not.toHaveAttribute('data-worker-frame-id', frameBefore || '');
  await expect(preview).toHaveAttribute('data-worker-state', /frame|rendering/);
});

// The replacement path used to be unbounded: three missed deadlines terminated the
// worker, reset the strike counter, and re-queued the same payload 400 ms later. A
// pattern that never returns (the worker's own `while (true)` test path, or anything a
// user authors that does the same) therefore cycled spawn -> pegged core -> terminate
// -> spawn forever, re-transferring the geometry every time, and "Start preview again"
// walked straight back into it.
// UN-SKIPPED 2026-08-21. The skip above was correct while ONE 400 ms deadline drove both
// the reversible degrade and the destructive replacement: a host slow enough to push a
// healthy 1024-sample render past 400 ms destroyed its worker, so three different tests
// in this file failed across nine solo runs on an idle machine. The two clocks are now
// separate (src/lib/patternLabRenderDeadline.js): 400 ms still degrades — cheap and
// self-healing — while destroying anything needs three missed 1500 ms deadlines, ~105x
// the worst measured healthy frame (14.3 ms). A merely slow host now degrades instead of
// escalating, which is what these tests were losing to.
test('gives up on a pattern that never finishes a frame instead of respawning forever', async ({ page }) => {
  // Two full give-up cycles plus their settle windows. The destructive deadline is
  // deliberately 1500 ms x 3 now, so reaching the cap honestly takes ~9.4 s of awake
  // time per cycle — the price of never destroying a merely slow phone's worker.
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    const lifecycle = { created: 0 };
    const NativeWorker = window.Worker;
    class CountingWorker extends NativeWorker {
      constructor(url: URL | string, options?: WorkerOptions) {
        super(url, options);
        lifecycle.created += 1;
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: CountingWorker });
    Object.defineProperty(window, '__LW_PATTERN_LAB_SPAWNS__', { value: lifecycle });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await choosePattern(page, 'aurora');
  const preview = page.getByTestId('pattern-lab-mapped-preview');
  // Pattern Lab opens already playing (patternlab-rebuild.md Phase 1). Pause
  // so the single Middle click below is the only render trigger -- a ticking
  // clock would keep spawning render requests into the hung worker and
  // confuse the "give up, don't keep respawning" assertion below.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');
  // Pausing settles (180ms later) into one more render, this time at the FINAL
  // sample budget. Reading the frame id before that render lands makes "the last
  // good frame stayed on screen" assert against a frame the preview legitimately
  // replaced a moment afterwards — which is a race, not a defect. The served
  // sample limit flipping to 1024 is the deterministic signal that the settle
  // render has arrived, so wait for that rather than for a quiet interval.
  await expect(preview).toHaveAttribute('data-worker-sample-limit', '1024');
  await expect(preview).toHaveAttribute('data-worker-state', 'frame');
  const frameId = await preview.getAttribute('data-worker-frame-id');

  await page.evaluate(() => {
    (window as typeof window & { __LW_PATTERN_LAB_WORKER_TEST_MODE__?: unknown })
      .__LW_PATTERN_LAB_WORKER_TEST_MODE__ = { kind: 'loop' };
  });
  await page.getByRole('button', { name: 'Middle', exact: true }).click();

  await expect(preview).toHaveAttribute('data-worker-failure', 'pattern-too-heavy', { timeout: 20_000 });
  await expect(page.getByTestId('pattern-lab-preview-notice'))
    .toHaveAttribute('data-failure', 'pattern-too-heavy');
  // The last good frame is still on screen; only the retrying stopped.
  await expect(preview).toHaveAttribute('data-worker-frame-id', frameId || '');

  const spawns = () => page.evaluate(() => (
    (window as typeof window & { __LW_PATTERN_LAB_SPAWNS__: { created: number } })
      .__LW_PATTERN_LAB_SPAWNS__.created
  ));
  // Settle first, THEN assert stability. Sampling after a fixed 1500ms could catch the
  // give-up sequence mid-cycle on a loaded host, so the next window saw one more spawn
  // and the test failed while the product was behaving correctly.
  const settleSpawns = async () => {
    let previous = -1;
    let stable = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const current = await spawns();
      stable = current === previous ? stable + 1 : 0;
      if (stable >= 3) return current;
      previous = current;
      await page.waitForTimeout(250);
    }
    throw new Error('worker spawns never stopped climbing');
  };
  const settled = await settleSpawns();
  await page.waitForTimeout(2500);
  expect(await spawns()).toBe(settled);

  // One manual retry is allowed. It must spend a bounded number of workers and then
  // stop again — never restart the spawn/peg/terminate cycle the cap exists to break.
  await preview.getByTestId('pattern-lab-preview-retry').click();
  await expect
    .poll(() => preview.getAttribute('data-worker-failure'), { timeout: 20_000 })
    .toMatch(/pattern-unrenderable|worker-error/);
  const afterRetry = await settleSpawns();
  expect(afterRetry - settled).toBeLessThanOrEqual(4);
  await page.waitForTimeout(2500);
  expect(await spawns()).toBe(afterRetry);

  // And choosing different pattern code releases the piece.
  await page.evaluate(() => {
    delete (window as typeof window & { __LW_PATTERN_LAB_WORKER_TEST_MODE__?: unknown })
      .__LW_PATTERN_LAB_WORKER_TEST_MODE__;
  });
  await choosePattern(page, 'ocean');
  await expect(preview).toHaveAttribute('data-worker-state', 'frame', { timeout: 20_000 });
});
