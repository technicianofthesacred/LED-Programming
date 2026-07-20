import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { LWSEQ_HEADER_BYTES, toLwseqBytes } from './standaloneController.js';
import {
  MAX_PATTERN_LAB_LWSEQ_BYTES,
  bakePatternLabRecipe,
  canonicalPatternLabBakeJson,
  estimatePatternLabBake,
} from './lwseqBake.js';

function fixture() {
  return {
    recipe: {
      version: 1,
      id: 'deterministic-bloom',
      name: 'Deterministic Bloom',
      base: { kind: 'lightweaver-pattern', patternId: 'gradient', params: {} },
      palette: ['#000000', '#ff4000', '#ffffff'],
      macros: { color: 0.5, movement: 0.5, shape: 0.5, texture: 0.5, energy: 0.5 },
      evolution: { enabled: false, character: 'slow-bloom', durationSeconds: 300, change: 0.35 },
      seed: 0x12345678,
      layers: [],
      targets: [{ kind: 'whole-piece', id: 'all' }],
      requirements: [],
      provenance: [],
    },
    strips: [
      {
        id: 'outer', name: 'Outer', brightness: 1, speed: 1, hueShift: 0,
        pixels: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }],
      },
      {
        id: 'inner', name: 'Inner', brightness: 0.8, speed: 0.75, hueShift: 4,
        pixels: [{ x: 0, y: 1 }, { x: 1, y: 1 }],
      },
    ],
    groups: [],
    wiring: {
      version: 1,
      locked: true,
      verified: true,
      outputs: [
        { id: 'out-a', name: 'Output A', pin: 16, runIds: ['outer-run', 'spacer'] },
        { id: 'out-b', name: 'Output B', pin: 17, runIds: ['inner-run'] },
      ],
      runs: [
        {
          id: 'outer-run', type: 'strip', verified: true,
          source: { stripId: 'outer', from: 0, to: 2 },
          directionPolicy: 'fixed', physicalDirection: 'source-reverse', seamLed: null,
        },
        { id: 'spacer', type: 'inactive', count: 1, verified: true },
        {
          id: 'inner-run', type: 'strip', verified: true,
          source: { stripId: 'inner', from: 0, to: 1 },
          directionPolicy: 'fixed', physicalDirection: 'source-forward', seamLed: null,
        },
      ],
    },
    hidden: {},
    render: {
      bpm: 90,
      gammaEnabled: false,
      gammaValue: 2.2,
      symSettings: null,
    },
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('same canonical inputs produce byte-identical physical LWSEQ and hashes', async () => {
  const input = fixture();
  const first = await bakePatternLabRecipe({ ...input, fps: 1 });
  const second = await bakePatternLabRecipe({ ...fixture(), fps: 1 });

  assert.deepEqual(first.bytes, second.bytes);
  assert.equal(first.sidecarJson, second.sidecarJson);
  assert.deepEqual(first.sidecar, second.sidecar);
  assert.equal(first.bytes.subarray(0, 6).toString(), '76,87,83,69,81,49');
  assert.equal(first.bytes.byteLength, LWSEQ_HEADER_BYTES + 6 * 3 * 300);

  const header = new DataView(first.bytes.buffer, first.bytes.byteOffset, LWSEQ_HEADER_BYTES);
  assert.equal(header.getUint16(8, true), 1);
  assert.equal(header.getUint16(10, true), 2);
  assert.equal(header.getUint32(12, true), 6);
  assert.equal(header.getUint32(16, true), 300);
  assert.equal(header.getUint16(20, true), 1);
  assert.equal(header.getUint16(22, true), 3);
  assert.deepEqual([...first.bytes.subarray(LWSEQ_HEADER_BYTES + 9, LWSEQ_HEADER_BYTES + 12)], [0, 0, 0]);
  assert.equal(first.sidecar.lwseqSha256, sha256(first.bytes));
  assert.equal(first.sidecar.hashAlgorithm, 'SHA-256');
  assert.equal(first.sidecar.recipeSha256, sha256(Buffer.from(canonicalPatternLabBakeJson(first.recipe))));
  assert.match(first.sidecar.layoutPhysicalOrderSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.sidecar.audioLanesSha256, null);
  assert.equal(first.sidecar.seed, 0x12345678);
  assert.equal(first.sidecar.pixelCount, 6);
  assert.equal(first.sidecar.frameCount, 300);
  assert.equal(first.sidecar.fps, 1);
  assert.deepEqual(JSON.parse(first.sidecarJson), first.sidecar);
});

test('baked bytes retain the standalone controller LWSEQ1 byte contract', async () => {
  const baked = await bakePatternLabRecipe({ ...fixture(), fps: 1 });
  const pixelCount = baked.sidecar.pixelCount;
  const frames = Array.from({ length: baked.sidecar.frameCount }, (_, frameIndex) => (
    Array.from({ length: pixelCount }, (_, pixelIndex) => {
      const offset = LWSEQ_HEADER_BYTES + (frameIndex * pixelCount + pixelIndex) * 3;
      return { r: baked.bytes[offset], g: baked.bytes[offset + 1], b: baked.bytes[offset + 2] };
    })
  ));
  assert.deepEqual(
    baked.bytes,
    toLwseqBytes(frames, { fps: 1, outputs: baked.outputs }),
  );
});

test('browser worker receives the complete normalized recipe contract', async () => {
  const originalWorker = globalThis.Worker;
  let capturedRecipe = null;
  class FakeWorker {
    postMessage(request) {
      queueMicrotask(() => {
        if (request.type === 'initialize') {
          this.onmessage?.({
            data: {
              type: 'ready',
              requestId: request.requestId,
              payload: { generation: request.payload.generation },
            },
          });
          return;
        }
        capturedRecipe ??= request.payload.recipe;
        const colors = new Uint8ClampedArray(5 * 3);
        const indices = Uint32Array.from({ length: 5 }, (_, index) => index);
        this.onmessage?.({
          data: {
            type: 'frame',
            requestId: request.requestId,
            payload: {
              mode: 'export',
              time: request.payload.time,
              generation: request.payload.generation,
              totalSamples: 5,
              sampleCount: 5,
              colors: colors.buffer,
              indices: indices.buffer,
            },
          },
        });
      });
    }

    terminate() {}
  }

  const input = fixture();
  input.recipe.layers = [{
    id: 'halo',
    generator: { kind: 'lightweaver-pattern', patternId: 'gradient', params: { spread: 0.4 } },
    blend: 'screen',
    opacity: 0.65,
    target: { kind: 'section', id: 'outer' },
  }];
  input.recipe.targets = [{ kind: 'section', id: 'outer', feather: 0.2 }];
  input.recipe.provenance = [{ source: 'pattern-library', revision: 'fixture-v1' }];
  try {
    globalThis.Worker = FakeWorker;
    const baked = await bakePatternLabRecipe({ ...input, fps: 1 });
    assert.deepEqual(capturedRecipe, baked.recipe);
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }
});

test('estimate is exact and the absolute/storage caps reject before rendering', async () => {
  const estimate = estimatePatternLabBake({ ...fixture(), fps: 2 });
  assert.deepEqual(estimate, {
    headerBytes: LWSEQ_HEADER_BYTES,
    payloadBytes: 6 * 3 * 600,
    totalBytes: LWSEQ_HEADER_BYTES + 6 * 3 * 600,
    pixelCount: 6,
    frameCount: 600,
    fps: 2,
    durationSeconds: 300,
    estimatedRenderMilliseconds: 600 * 250,
    maxBytes: MAX_PATTERN_LAB_LWSEQ_BYTES,
  });
  await assert.rejects(
    bakePatternLabRecipe({ ...fixture(), fps: 2, maxBytes: estimate.totalBytes - 1 }),
    /storage cap.*before rendering/i,
  );
  assert.throws(
    () => estimatePatternLabBake({ ...fixture(), fps: 2, maxBytes: MAX_PATTERN_LAB_LWSEQ_BYTES + 1 }),
    /absolute.*maximum/i,
  );
});

test('unknown or unverified physical order fails closed', async () => {
  const missing = fixture();
  delete missing.wiring;
  await assert.rejects(bakePatternLabRecipe({ ...missing, fps: 1 }), /physical wiring.*required/i);

  const unlocked = fixture();
  unlocked.wiring.locked = false;
  await assert.rejects(bakePatternLabRecipe({ ...unlocked, fps: 1 }), /not send-ready|lock and verify/i);

  const unverifiedRun = fixture();
  unverifiedRun.wiring.runs[0].verified = false;
  await assert.rejects(bakePatternLabRecipe({ ...unverifiedRun, fps: 1 }), /not send-ready|lock and verify/i);
});

test('validated default output pins preserve every physical output in the header', async () => {
  const input = fixture();
  delete input.wiring.outputs[0].pin;
  delete input.wiring.outputs[1].pin;
  const baked = await bakePatternLabRecipe({ ...input, fps: 1 });
  const header = new DataView(baked.bytes.buffer, baked.bytes.byteOffset, LWSEQ_HEADER_BYTES);

  assert.equal(header.getUint16(10, true), 2);
  assert.deepEqual(baked.outputs.map(output => output.pin), [16, 17]);
});

test('wall clock, random, network, executable source, and unresolved audio inputs are rejected', async () => {
  for (const capability of ['wall-clock', 'random', 'network', 'live-audio']) {
    const input = fixture();
    input.recipe.requirements = [{ capability, required: true }];
    await assert.rejects(
      bakePatternLabRecipe({ ...input, fps: 1 }),
      new RegExp(`${capability.replace('-', '.*')}.*deterministic|unresolved|unsupported`, 'i'),
    );
  }

  const unknown = fixture();
  unknown.recipe.requirements = [{ capability: 'future-sensor', required: true }];
  await assert.rejects(
    bakePatternLabRecipe({ ...unknown, fps: 1 }),
    /future-sensor.*unresolved|unresolved.*future-sensor/i,
  );

  const source = fixture();
  source.recipe.sourceCode = 'return fetch("https://example.com")';
  await assert.rejects(bakePatternLabRecipe({ ...source, fps: 1 }), /executable source|sourceCode/i);

  const audio = fixture();
  audio.recipe.requirements = [{
    capability: 'offline-analysis', required: true, bakeable: true,
    analysisVersion: 1, audioSha256: 'a'.repeat(64),
  }];
  await assert.rejects(bakePatternLabRecipe({ ...audio, fps: 1 }), /offline audio.*required|unresolved/i);
});

test('hostile accessors and non-plain bake inputs are rejected without evaluation', async () => {
  const accessor = fixture();
  let evaluated = false;
  Object.defineProperty(accessor.recipe, 'requirements', {
    enumerable: true,
    get() {
      evaluated = true;
      return [];
    },
  });
  await assert.rejects(
    bakePatternLabRecipe({ ...accessor, fps: 1 }),
    /accessor|plain data/i,
  );
  assert.equal(evaluated, false);

  const nonPlain = fixture();
  nonPlain.hidden = new Map();
  await assert.rejects(
    bakePatternLabRecipe({ ...nonPlain, fps: 1 }),
    /plain object|plain data/i,
  );
});

test('resolved offline audio is canonically hashed and must cover the bake duration', async () => {
  const input = fixture();
  const laneLength = 301;
  const lanes = {
    version: 1,
    audioFingerprint: { algorithm: 'SHA-256', sha256: 'b'.repeat(64), byteLength: 2048 },
    settings: {
      sampleRate: 1,
      channels: 1,
      durationSeconds: 301,
      windowSize: 256,
      hopSize: 1,
      frameCount: laneLength,
      frameTimeOrigin: 'window-center',
      frameTimeOffsetSeconds: 0,
      analysisWorkUnits: 1,
      window: 'hann',
      spectrumScale: 'web-audio-byte-frequency',
      minDecibels: -100,
      maxDecibels: -30,
      featureContract: 'show-audio-features-v1',
    },
    lanes: Object.fromEntries(
      ['bass', 'mid', 'high', 'level', 'centroid', 'flux', 'onset']
        .map(name => [name, Array.from({ length: laneLength }, (_, index) => index / laneLength)]),
    ),
  };
  input.recipe.requirements = [{
    capability: 'offline-analysis', required: true, bakeable: true,
    analysisVersion: 1, audioSha256: lanes.audioFingerprint.sha256,
  }];
  const baked = await bakePatternLabRecipe({ ...input, fps: 1, audioLanes: lanes });
  assert.equal(baked.sidecar.audioLanesSha256, sha256(Buffer.from(canonicalPatternLabBakeJson(lanes))));

  lanes.settings.durationSeconds = 299;
  await assert.rejects(
    bakePatternLabRecipe({ ...input, fps: 1, audioLanes: lanes }),
    /cover the full bake duration/i,
  );

  lanes.settings.durationSeconds = 301;
  lanes.settings.frameCount = 1;
  for (const name of Object.keys(lanes.lanes)) lanes.lanes[name] = [0];
  await assert.rejects(
    bakePatternLabRecipe({ ...input, fps: 1, audioLanes: lanes }),
    /cover the full bake duration/i,
  );
});

test('AbortSignal cancels before work and during cooperative rendering', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    bakePatternLabRecipe({ ...fixture(), fps: 1, signal: before.signal }),
    { name: 'AbortError' },
  );

  const during = new AbortController();
  const operation = bakePatternLabRecipe({ ...fixture(), fps: 2, signal: during.signal });
  setTimeout(() => during.abort(), 0);
  await assert.rejects(operation, { name: 'AbortError' });
});

test('the bake result is bound to the initial immutable input snapshot', async () => {
  const input = { ...fixture(), fps: 1 };
  const operation = bakePatternLabRecipe(input);
  input.recipe.evolution.durationSeconds = 900;
  input.strips[0].pixels[0].x = 999;
  const baked = await operation;

  assert.equal(baked.sidecar.frameCount, 300);
  assert.equal(baked.estimate.frameCount, 300);
  assert.equal(baked.estimate.totalBytes, baked.bytes.byteLength);
});
