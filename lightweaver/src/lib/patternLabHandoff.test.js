import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PATTERN_LAB_SEQUENCE_ASSETS,
  applyPatternLabHandoff,
  createPatternLabHandoff,
} from './patternLabHandoff.js';
import { classifyPatternLabCompatibility } from './patternLabCompatibility.js';
import { bakePatternLabRecipe } from './lwseqBake.js';
import { createDefaultProject, migrateProject } from './projectModel.js';
import { MAX_SAVED_LOOKS } from './sectionLookModel.js';

function recipe(overrides = {}) {
  return {
    version: 1,
    id: 'pattern-lab-aurora-journey',
    name: 'Aurora Journey',
    base: { kind: 'lightweaver-pattern', patternId: 'aurora', params: {} },
    palette: ['#102040', '#f0a060'],
    macros: { color: 0.6, movement: 0.45, shape: 0.5, texture: 0.5, energy: 0.7 },
    evolution: { enabled: false, character: 'slow-bloom', durationSeconds: 300, change: 0.35 },
    seed: 17,
    layers: [],
    targets: [{ kind: 'whole-piece', id: 'all' }],
    requirements: [],
    provenance: [],
    ...overrides,
  };
}

function compatibilityFor(source) {
  return classifyPatternLabCompatibility(source, {
    metrics: {
      pixelCount: 1,
      fps: 1,
      operationsPerFrame: 100,
      stateBytes: 256,
      framebufferBytes: 3,
      nativeConfigBytes: 256,
      microSdBytes: 1_000_000,
    },
  });
}

function compatibility(classification, reasons = []) {
  const result = compatibilityFor(recipe());
  return structuredClone({
    ...result,
    classification,
    reasons,
    actions: classification === 'bake-to-card'
      ? [{ id: 'bake', label: 'Bake to card', kind: 'bake' }]
      : [],
  });
}

const strips = [{ id: 'main', name: 'Main', pixels: [{ x: 0, y: 0 }] }];
const wiring = {
  version: 1,
  locked: true,
  verified: true,
  outputs: [{ id: 'main', name: 'Main', pin: 16, runIds: ['main-run'] }],
  runs: [{
    id: 'main-run',
    type: 'strip',
    verified: true,
    source: { stripId: 'main', from: 0, to: 0 },
    directionPolicy: 'fixed',
    physicalDirection: 'source-forward',
    seamLed: null,
  }],
};

const bakedRecipe = recipe({
  evolution: { enabled: true, character: 'slow-bloom', durationSeconds: 300, change: 0.35 },
});
const baked = await bakePatternLabRecipe({ recipe: bakedRecipe, strips, wiring, fps: 1 });

test('creates a new normalized look handoff without changing the recipe', async () => {
  const source = recipe();
  const before = JSON.stringify(source);
  const result = await createPatternLabHandoff({
    recipe: source,
    compatibility: compatibility('live-on-card'),
  });
  assert.equal(result.kind, 'look');
  assert.equal(result.look.label, 'Aurora Journey');
  assert.equal(result.look.defaultLook.patternId, 'aurora');
  assert.equal(JSON.stringify(source), before);
});

test('fails closed on versionless or malformed compatibility results', async () => {
  const cases = [
    { classification: 'live-on-card', reasons: [] },
    { ...compatibility('live-on-card'), version: 99 },
    { ...compatibility('live-on-card'), descriptor: null },
    { ...compatibility('live-on-card'), budgets: null },
    { ...compatibility('live-on-card'), budgets: {} },
    { ...compatibility('live-on-card'), descriptor: { id: {}, version: 1 } },
    { ...compatibility('studio-only'), reasons: [null] },
    { ...compatibility('unknown-target'), classification: 'unknown-target' },
  ];
  for (const candidate of cases) {
    const result = await createPatternLabHandoff({ recipe: recipe(), compatibility: candidate });
    assert.equal(result.kind, 'blocked');
    assert.equal(result.reasons[0].code, 'compatibility-invalid');
  }
});

test('a stale live classification cannot flatten evolution or layers into a static look', async () => {
  const cases = [
    bakedRecipe,
    recipe({
      layers: [{
        id: 'glow-layer',
        name: 'Glow layer',
        enabled: true,
        opacity: 0.5,
        blendMode: 'normal',
        generator: { kind: 'lightweaver-pattern', patternId: 'fire', params: {} },
        transforms: [],
        mask: null,
        target: { kind: 'whole-piece', id: 'all' },
      }],
    }),
  ];
  for (const source of cases) {
    const result = await createPatternLabHandoff({
      recipe: source,
      compatibility: compatibility('live-on-card'),
    });
    assert.equal(result.kind, 'blocked');
    assert.equal(result.reasons[0].code, 'look-unsupported');
  }
});

test('creates a complete sequence package from the canonical bake result', async () => {
  const result = await createPatternLabHandoff({
    recipe: bakedRecipe,
    compatibility: compatibilityFor(bakedRecipe),
    bakeResult: baked,
  });
  assert.equal(result.kind, 'sequence');
  assert.equal(result.manifest.lwseqSha256, baked.sidecar.lwseqSha256);
  assert.equal(result.asset.assetRef, `sha256:${baked.sidecar.lwseqSha256}`);
  assert.equal(result.look.mode, 'sequence');
  assert.equal(result.look.file, result.asset.file);
  assert.equal(result.package.app, 'Lightweaver');
  assert.equal(result.package.format, 'standalone-controller-package');
  assert.equal(result.package.version, 1);
  assert.equal(result.package.files[result.asset.file].encoding, 'base64');
  assert.equal(result.package.files[result.asset.file].bytes, baked.bytes.byteLength);
  assert.deepEqual(
    new Uint8Array(Buffer.from(result.package.files[result.asset.file].data, 'base64')),
    baked.bytes,
  );
  assert.equal(result.package.files[result.asset.sidecarFile], `${baked.sidecarJson}\n`);
  assert.equal(result.package.files['/lightweaver.json'].runtimeMode, 'sd-sequence');
  assert.equal(result.package.files['/lightweaver.json'].looks[0].file, result.asset.file);
  assert.notEqual(result.package.files[result.asset.file], baked.bytes);
});

test('rejects incomplete, tampered, or stale-recipe bake results', async () => {
  const tamperedBytes = new Uint8Array(baked.bytes);
  tamperedBytes[tamperedBytes.length - 1] ^= 0xff;
  const stale = { ...structuredClone(bakedRecipe), seed: bakedRecipe.seed + 1 };
  const cases = [
    null,
    {},
    { ...baked, sidecarJson: '{}' },
    { ...baked, bytes: tamperedBytes },
    {
      ...baked,
      estimate: {
        totalBytes: baked.estimate.totalBytes,
        pixelCount: baked.estimate.pixelCount,
        frameCount: baked.estimate.frameCount,
        fps: baked.estimate.fps,
      },
    },
  ];
  for (const bakeResult of cases) {
    const result = await createPatternLabHandoff({
      recipe: bakedRecipe,
      compatibility: compatibilityFor(bakedRecipe),
      bakeResult,
    });
    assert.equal(result.kind, 'blocked');
    assert.match(result.reasons[0].code, /^bake-(?:required|invalid)$/);
  }
  const staleResult = await createPatternLabHandoff({
    recipe: stale,
    compatibility: compatibilityFor(stale),
    bakeResult: baked,
  });
  assert.equal(staleResult.kind, 'blocked');
  assert.equal(staleResult.reasons[0].code, 'bake-stale-recipe');
});

test('invalid, canceled, unsupported, and failed handoffs mutate nothing', async () => {
  const controller = { looks: [{ id: 'kept', label: 'Kept' }], sequenceAssets: [{ id: 'kept-sequence' }] };
  const source = recipe();
  const beforeController = JSON.stringify(controller);
  const beforeRecipe = JSON.stringify(source);
  const cases = await Promise.all([
    createPatternLabHandoff({ recipe: source, compatibility: null }),
    createPatternLabHandoff({ recipe: source, compatibility: compatibility('live-on-card'), cancelled: true }),
    createPatternLabHandoff({ recipe: source, compatibility: compatibility('studio-only', [{ code: 'unsupported', message: 'No card path' }]) }),
    createPatternLabHandoff({ recipe: source, compatibility: compatibility('bake-to-card'), exportError: new Error('bake failed') }),
  ]);
  for (const result of cases) {
    assert.equal(result.kind, 'blocked');
    assert.deepEqual(await applyPatternLabHandoff(controller, result), controller);
  }
  assert.equal(JSON.stringify(controller), beforeController);
  assert.equal(JSON.stringify(source), beforeRecipe);
});

test('applying a look never overwrites a built-in or existing saved look', async () => {
  const controller = {
    defaultLook: { patternId: 'fire' },
    activeLookId: 'aurora-journey',
    looks: [{ id: 'aurora-journey', label: 'Older Journey', defaultLook: { patternId: 'fire' } }],
  };
  const result = await createPatternLabHandoff({
    recipe: recipe({ id: 'aurora', name: 'Aurora Journey' }),
    compatibility: compatibility('live-on-card'),
    controller,
  });
  const next = await applyPatternLabHandoff(controller, result);
  assert.equal(next.looks.length, 2);
  assert.equal(next.looks[0].id, 'aurora-journey-2');
  assert.equal(next.looks[1].label, 'Older Journey');
  assert.equal(controller.looks.length, 1);
});

test('native look capacity blocks instead of evicting an existing look', async () => {
  const controller = {
    looks: Array.from({ length: MAX_SAVED_LOOKS }, (_, index) => ({
      id: `kept-${index + 1}`,
      label: `Kept ${index + 1}`,
      defaultLook: { patternId: 'aurora' },
    })),
  };
  const result = await createPatternLabHandoff({
    recipe: recipe(),
    compatibility: compatibility('live-on-card'),
    controller,
  });
  assert.equal(result.kind, 'blocked');
  assert.equal(result.reasons[0].code, 'look-capacity');
  assert.strictEqual(await applyPatternLabHandoff(controller, result), controller);

  const forged = { kind: 'look', look: { id: 'new', label: 'New', defaultLook: { patternId: 'fire' } } };
  assert.strictEqual(await applyPatternLabHandoff(controller, forged), controller);
  assert.equal(controller.looks.at(-1).id, `kept-${MAX_SAVED_LOOKS}`);
});

test('sequence apply stores only bounded metadata and a sequence look reference', async () => {
  const controller = { sequenceAssets: [] };
  const result = await createPatternLabHandoff({
    recipe: bakedRecipe,
    compatibility: compatibilityFor(bakedRecipe),
    bakeResult: baked,
    controller,
  });
  const next = await applyPatternLabHandoff(controller, result);
  assert.equal(next.sequenceAssets.length, 1);
  assert.equal(next.sequenceAssets[0].look.mode, 'sequence');
  assert.equal(next.sequenceAssets[0].look.file, next.sequenceAssets[0].file);
  assert.equal(next.sequenceAssets[0].manifest.lwseqSha256, baked.sidecar.lwseqSha256);
  assert.equal(next.activeSequenceAssetId, next.sequenceAssets[0].id);
  assert.ok(!/(?:package|base64|sidecarJson|\"bytes\"|\"data\")/i.test(JSON.stringify(next)));
  assert.equal(controller.sequenceAssets.length, 0);

  const tamperedResult = structuredClone(result);
  tamperedResult.package.files[result.asset.sidecarFile] = '{}\n';
  assert.strictEqual(await applyPatternLabHandoff(controller, tamperedResult), controller);

  const tamperedBytes = structuredClone(result);
  tamperedBytes.package.files[result.asset.file].data = Buffer.alloc(result.asset.byteLength, 0).toString('base64');
  assert.strictEqual(await applyPatternLabHandoff(controller, tamperedBytes), controller);

  const tamperedProfile = structuredClone(result);
  tamperedProfile.package.files['/lightweaver.json'].looks[0].file = '/sequences/other.lwseq';
  assert.strictEqual(await applyPatternLabHandoff(controller, tamperedProfile), controller);

  const cyclicResult = structuredClone(result);
  cyclicResult.manifest.self = cyclicResult.manifest;
  await assert.doesNotReject(() => applyPatternLabHandoff(controller, cyclicResult));
  assert.strictEqual(await applyPatternLabHandoff(controller, cyclicResult), controller);
});

test('sequence metadata survives project JSON migration round trip and rejects unbounded data', async () => {
  const project = createDefaultProject();
  const result = await createPatternLabHandoff({
    recipe: bakedRecipe,
    compatibility: compatibilityFor(bakedRecipe),
    bakeResult: baked,
    controller: project.devices.standaloneController,
  });
  project.devices.standaloneController = await applyPatternLabHandoff(project.devices.standaloneController, result);
  project.devices.standaloneController.sequenceAssets.push({
    id: 'malformed',
    label: 'x'.repeat(10_000),
    package: result.package,
    bytes: Array.from(baked.bytes),
  });
  project.devices.standaloneController.sequenceAssets.push({
    ...project.devices.standaloneController.sequenceAssets[0],
    id: 'malformed-nested-output',
    file: '/sequences/malformed-nested-output.lwseq',
    sidecarFile: '/sequences/malformed-nested-output.lwseq.json',
    outputs: [null],
  });

  const migrated = migrateProject(JSON.parse(JSON.stringify(project)));
  const controller = migrated.devices.standaloneController;
  assert.equal(controller.sequenceAssets.length, 1);
  assert.deepEqual(controller.sequenceAssets[0], project.devices.standaloneController.sequenceAssets[0]);
  assert.equal(controller.activeSequenceAssetId, controller.sequenceAssets[0].id);
  assert.ok(JSON.stringify(controller).length < 4_000);
  assert.ok(!/(?:package|base64|sidecarJson|\"bytes\"|\"data\")/i.test(JSON.stringify(controller)));
});

test('sequence asset capacity blocks instead of evicting metadata', async () => {
  const seedResult = await createPatternLabHandoff({
    recipe: bakedRecipe,
    compatibility: compatibilityFor(bakedRecipe),
    bakeResult: baked,
  });
  const asset = (await applyPatternLabHandoff({}, seedResult)).sequenceAssets[0];
  const controller = {
    sequenceAssets: Array.from({ length: MAX_PATTERN_LAB_SEQUENCE_ASSETS }, (_, index) => ({
      ...asset,
      id: `kept-sequence-${index + 1}`,
      label: `Kept sequence ${index + 1}`,
      file: `/sequences/kept-sequence-${index + 1}.lwseq`,
      sidecarFile: `/sequences/kept-sequence-${index + 1}.lwseq.json`,
      look: {
        ...asset.look,
        id: `kept-sequence-${index + 1}`,
        label: `Kept sequence ${index + 1}`,
        file: `/sequences/kept-sequence-${index + 1}.lwseq`,
      },
    })),
  };
  const result = await createPatternLabHandoff({
    recipe: bakedRecipe,
    compatibility: compatibilityFor(bakedRecipe),
    bakeResult: baked,
    controller,
  });
  assert.equal(result.kind, 'blocked');
  assert.equal(result.reasons[0].code, 'sequence-capacity');
});
