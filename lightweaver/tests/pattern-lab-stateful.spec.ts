import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/#screen=pattern-lab', { waitUntil: 'domcontentloaded' });
});

test('chooses and sculpts a living simulation through the simple Pattern Lab controls', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const recipes: Array<Record<string, unknown>> = [];
    class RecipeWorker extends NativeWorker {
      postMessage(message: { type?: string; payload?: { recipe?: Record<string, unknown> } }, transfer?: Transferable[] | StructuredSerializeOptions) {
        if (message?.type === 'render' && message.payload?.recipe) {
          recipes.push(structuredClone(message.payload.recipe));
        }
        if (transfer === undefined) super.postMessage(message);
        else super.postMessage(message, transfer);
      }
    }
    Object.defineProperty(window, 'Worker', { configurable: true, value: RecipeWorker });
    Object.defineProperty(window, '__LW_STATEFUL_RECIPES__', { value: recipes });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  await page.getByLabel('Base pattern').selectOption('generator:particles');
  await expect(page.getByTestId('pattern-lab-mapped-preview')).toHaveAttribute('data-worker-state', 'frame');
  await expect(page.getByTestId('pattern-lab-draft-name')).toHaveText('Particle Drift');
  await page.getByText('Advanced controls').click();
  await page.getByRole('slider', { name: 'Particle count' }).fill('48');
  await page.getByRole('slider', { name: 'Movement', exact: true }).fill('68');
  await expect(page.getByLabel('Movement value')).toHaveText('68%');
  await expect.poll(() => page.evaluate(() => {
    const recipes = (window as typeof window & { __LW_STATEFUL_RECIPES__: Array<Record<string, unknown>> })
      .__LW_STATEFUL_RECIPES__;
    return recipes.some(recipe => (
      (recipe.base as { kind?: string })?.kind === 'particles'
      && (recipe.macros as { movement?: number })?.movement === 0.68
      && (recipe.base as { params?: { advanced?: { particleCount?: number } } })
        ?.params?.advanced?.particleCount === 48
    ));
  })).toBe(true);

  const recipes = await page.evaluate(() => (
    (window as typeof window & { __LW_STATEFUL_RECIPES__: Array<Record<string, unknown>> })
      .__LW_STATEFUL_RECIPES__
  ));
  const stateful = recipes.filter(recipe => (recipe.base as { kind?: string })?.kind === 'particles');
  expect(stateful.length).toBeGreaterThan(0);
  expect(stateful.every(recipe => Number.isInteger(recipe.seed))).toBe(true);
  expect(stateful.some(recipe => (recipe.macros as { movement?: number })?.movement === 0.68)).toBe(true);
});

test('the real worker renders the deterministic bounded stateful generator pack', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const {
      PATTERN_LAB_WORKER_BUDGETS,
      clonePatternLabWorkerGeometryForTransfer,
      compactPatternLabWorkerGeometry,
    } = await import('/src/lib/patternLabWorkerProtocol.js');
    const generatorIds = [
      'particles',
      'ripple',
      'random-walkers',
      'cellular-field',
      'gray-scott-1d',
    ];
    const geometry = compactPatternLabWorkerGeometry({
      strips: [{
        id: 'stateful',
        pixels: Array.from({ length: 96 }, (_, index) => ({
          x: index / 95,
          y: 0.5 + Math.sin(index / 9) * 0.3,
        })),
      }],
      hidden: {},
    });

    async function run(generatorId: string, seed: number, times: number[]) {
      const worker = new Worker(new URL('/src/pattern-lab/patternLab.worker.js', location.origin), { type: 'module' });
      let requestId = 1;
      const replies: Array<{ type: string; requestId: number; payload: Record<string, unknown> }> = [];
      const waiters = new Set<() => void>();
      worker.onmessage = event => {
        replies.push(event.data);
        for (const wake of waiters) wake();
      };
      const waitFor = (predicate: (reply: typeof replies[number]) => boolean) => new Promise<typeof replies[number]>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`Timed out waiting for ${generatorId}`)), 3000);
        const inspect = () => {
          const found = replies.find(predicate);
          if (!found) return;
          clearTimeout(deadline);
          waiters.delete(inspect);
          resolve(found);
        };
        waiters.add(inspect);
        inspect();
      });
      const transfer = clonePatternLabWorkerGeometryForTransfer(geometry);
      worker.postMessage({
        type: 'initialize',
        requestId,
        payload: { geometry: transfer.geometry, generation: 1 },
      }, transfer.transfer);
      await waitFor(reply => reply.type === 'ready' && reply.requestId === 1);

      const frames = [];
      const stats = [];
      for (const time of times) {
        requestId += 1;
        const activeRequest = requestId;
        worker.postMessage({
          type: 'render',
          requestId: activeRequest,
          payload: {
            mode: 'final',
            generation: 1,
            layerCount: 0,
            time,
            recipe: {
              id: `stateful-${generatorId}`,
              seed,
              base: { kind: generatorId, params: { advanced: {} } },
              palette: ['#101020', '#40b0ff', '#ffe090'],
              macros: { color: 0.62, movement: 0.58, shape: 0.44, texture: 0.71, energy: 0.73 },
              layers: [],
            },
            renderOptions: {
              masterSpeed: 1,
              masterBrightness: 1,
              masterSaturation: 1,
              masterHueShift: 0,
            },
          },
        });
        const [frameReply, statsReply] = await Promise.all([
          waitFor(reply => reply.type === 'frame' && reply.requestId === activeRequest),
          waitFor(reply => reply.type === 'stats' && reply.requestId === activeRequest),
        ]);
        const colors = new Uint8ClampedArray(frameReply.payload.colors as ArrayBuffer);
        frames.push({
          checksum: [...colors].reduce((sum, value, index) => (sum + value * (index + 1)) >>> 0, 0),
          lit: [...colors].some(value => value > 0),
          sampleCount: frameReply.payload.sampleCount,
        });
        stats.push(statsReply.payload);
      }
      worker.terminate();
      return { frames, stats };
    }

    const pack: Record<string, Awaited<ReturnType<typeof run>>> = {};
    for (const generatorId of generatorIds) pack[generatorId] = await run(generatorId, 41, [0, 1 / 24, 1]);
    const repeat = await run('particles', 41, [0, 1 / 24, 1]);
    const changedSeed = await run('particles', 42, [0, 1 / 24, 1]);
    const accelerated = await run('gray-scott-1d', 41, [0, 900]);
    const realtimeSoak = await run(
      'particles',
      91,
      Array.from({ length: 48 }, (_, index) => index / PATTERN_LAB_WORKER_BUDGETS.previewFps),
    );
    return {
      budget: PATTERN_LAB_WORKER_BUDGETS.maxAllocationBytes,
      pack,
      repeat,
      changedSeed,
      accelerated,
      realtimeSoak,
    };
  });

  for (const [generatorId, run] of Object.entries(result.pack)) {
    expect(run.frames.every(frame => frame.lit), generatorId).toBe(true);
    expect(run.frames.every(frame => frame.sampleCount === 96), generatorId).toBe(true);
    expect(run.stats.every(stats => stats.generatorId === generatorId), generatorId).toBe(true);
    expect(run.stats.every(stats => Number(stats.generatorStateBytes) > 0), generatorId).toBe(true);
    expect(run.stats.every(stats => Number(stats.allocatedBytes) <= result.budget), generatorId).toBe(true);
  }
  expect(result.repeat.frames).toEqual(result.pack.particles.frames);
  expect(result.changedSeed.frames).not.toEqual(result.pack.particles.frames);
  expect(result.accelerated.stats.at(-1)?.generatorElapsedSeconds).toBe(900);
  expect(new Set(result.realtimeSoak.stats.map(stats => stats.generatorStateBytes)).size).toBe(1);
  expect(result.realtimeSoak.stats.at(-1)?.generatorElapsedSeconds).toBeCloseTo(47 / 24, 8);
  await expect(page.getByRole('heading', { name: 'Pattern Lab' })).toBeVisible();
});
