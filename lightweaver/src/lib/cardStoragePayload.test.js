import test from 'node:test';
import assert from 'node:assert/strict';

import { CARD_PATTERN_BANK } from './cardPatternBank.js';
import { buildCardRuntimePackageFromProject } from './cardRuntimeProject.js';
import {
  CARD_CONFIG_STORAGE_LIMIT_BYTES,
  CardConfigCapacityError,
  compactCardStorageConfig,
  prepareCardStoragePayload,
} from './cardStoragePayload.js';

test('prepares all 19 playlist looks within the card flash storage limit', () => {
  const selectedPatterns = CARD_PATTERN_BANK.slice(0, 19);
  const runtimePackage = buildCardRuntimePackageFromProject({
    projectId: 'storage-limit-test',
    projectName: 'Storage Limit Test',
    strips: [{ id: 'test-strip', name: 'Test Strip', pixelCount: 4 }],
    standaloneController: {
      outputs: [{ id: 'out1', name: 'Output 1', pin: 16, pixels: 4 }],
      playlist: selectedPatterns.map((pattern, index) => ({
        id: pattern.id,
        type: 'pattern',
        patternId: pattern.id,
        label: pattern.label,
        enabled: true,
        createdAt: index,
      })),
    },
  });
  const verboseBytes = Buffer.byteLength(JSON.stringify(runtimePackage.config), 'utf8');

  assert.deepEqual(runtimePackage.config.led.outputs, [
    { id: 'out1', name: 'Output 1', pin: 16, pixels: 4 },
  ]);
  assert.ok(verboseBytes > CARD_CONFIG_STORAGE_LIMIT_BYTES, `expected verbose config over limit, got ${verboseBytes}`);

  const prepared = prepareCardStoragePayload(runtimePackage);

  assert.ok(prepared.bytes <= CARD_CONFIG_STORAGE_LIMIT_BYTES, `expected compact config within limit, got ${prepared.bytes}`);
  assert.deepEqual(prepared.config.looks.map(look => look.id), selectedPatterns.map(pattern => pattern.id));
  assert.deepEqual(
    reconstructFirmwareLookDefaults(prepared.config),
    runtimePackage.config.looks,
    'firmware defaults must reconstruct every original look field without semantic loss',
  );
  assert.equal('patterns' in prepared.config, false);
  assert.equal(prepared.bytes, Buffer.byteLength(prepared.json, 'utf8'));
});

test('retains non-default look fields while removing only firmware look defaults', () => {
  const config = {
    mode: 'website-flash',
    looks: [
      {
        id: 'aurora',
        label: 'Aurora',
        mode: 'procedural',
        preset: 'aurora',
        fps: 24,
        loop: true,
        fadeOutMs: 320,
        fadeInMs: 420,
        brightness: 0.65,
        studioNote: 'keep me',
      },
      {
        id: 'custom-look',
        label: 'Custom Look',
        mode: 'preset',
        preset: 'fire',
        fps: 30,
        loop: false,
        fadeOutMs: 321,
        fadeInMs: 421,
        brightness: 0.7,
        file: '/sequences/custom.lwseq',
      },
    ],
  };
  const original = structuredClone(config);

  const compact = compactCardStorageConfig(config);

  assert.deepEqual(config, original, 'caller input must not be mutated');
  assert.deepEqual(compact.looks[0], { id: 'aurora', label: 'Aurora', studioNote: 'keep me' });
  assert.deepEqual(compact.looks[1], config.looks[1]);
});

test('retains combo-zone identity and non-default values while removing zone defaults', () => {
  const compact = compactCardStorageConfig({
    looks: [{
      id: 'combo-gallery',
      label: 'Gallery Combo',
      mode: 'combo',
      preset: 'aurora',
      zones: [
        {
          id: 'outer',
          label: 'Outer Ring',
          patternId: 'fire',
          brightness: 1,
          speed: 1,
          hueShift: 0,
          customHue: 32,
          customSaturation: 230,
          customBreathe: false,
          customDrift: false,
          blackout: false,
        },
        {
          id: 'inner',
          label: 'Inner Ring',
          patternId: 'ocean',
          brightness: 0.8,
          speed: 1.2,
          hueShift: -8,
          customHue: 64,
          customSaturation: 200,
          customBreathe: true,
          customDrift: true,
          blackout: true,
          studioNote: 'keep this too',
        },
      ],
    }],
  });

  assert.deepEqual(compact.looks[0].zones[0], {
    id: 'outer',
    label: 'Outer Ring',
    patternId: 'fire',
  });
  assert.deepEqual(compact.looks[0].zones[1], {
    id: 'inner',
    label: 'Inner Ring',
    patternId: 'ocean',
    brightness: 0.8,
    speed: 1.2,
    hueShift: -8,
    customHue: 64,
    customSaturation: 200,
    customBreathe: true,
    customDrift: true,
    blackout: true,
    studioNote: 'keep this too',
  });
});

test('removes the encoder cycle metadata that firmware does not deserialize', () => {
  const compact = compactCardStorageConfig({
    controls: {
      encoder: {
        a: 4,
        patternCycleIds: ['aurora', 'fire'],
        futureEncoderOption: 'preserved',
      },
      next: 8,
    },
  });

  assert.deepEqual(compact.controls, {
    encoder: { a: 4, futureEncoderOption: 'preserved' },
    next: 8,
  });
});

test('never slices arrays while compacting', () => {
  const config = {
    patterns: [{ id: 'fallback-pattern' }],
    looks: Array.from({ length: 40 }, (_, index) => ({
      id: `look-${index}`,
      mode: 'combo',
      zones: Array.from({ length: 12 }, (_, zoneIndex) => ({
        id: `zone-${zoneIndex}`,
        patternId: 'aurora',
      })),
    })),
    zones: [{
      id: 'mapped-zone',
      ranges: Array.from({ length: 6 }, (_, index) => ({ start: index, count: 1 })),
    }],
    futureArray: Array.from({ length: 45 }, (_, index) => index),
  };

  const compact = compactCardStorageConfig(config);

  assert.equal(compact.looks.length, 40);
  assert.equal(compact.looks[0].zones.length, 12);
  assert.equal(compact.zones[0].ranges.length, 6);
  assert.deepEqual(compact.futureArray, config.futureArray);
});

test('keeps patterns when there are no persisted looks', () => {
  const compact = compactCardStorageConfig({
    patterns: [{ id: 'aurora', label: 'Aurora', mode: 'procedural' }],
    looks: [],
  });

  assert.deepEqual(compact.patterns, [{ id: 'aurora', label: 'Aurora', mode: 'procedural' }]);
  assert.deepEqual(compact.looks, []);
});

test('preserves an object-valued config key when the input is a raw config', () => {
  const rawConfig = {
    mode: 'website-flash',
    futureRootField: 'keep this',
    config: { futureNestedField: true },
    looks: [{ id: 'aurora', mode: 'procedural', preset: 'aurora' }],
  };

  const compact = compactCardStorageConfig(rawConfig);

  assert.equal(compact.mode, 'website-flash');
  assert.equal(compact.futureRootField, 'keep this');
  assert.deepEqual(compact.config, { futureNestedField: true });
  assert.deepEqual(compact.looks, [{ id: 'aurora' }]);
});

test('throws an exact UTF-8 capacity error for an oversized compact combo', () => {
  const config = {
    piece: { name: '🔥 Gallery Piece' },
    looks: [{
      id: 'oversized-combo',
      label: 'Oversized Combo',
      mode: 'combo',
      zones: [{
        id: 'zone-one',
        patternId: 'aurora',
        studioMetadata: 'x'.repeat(4200),
      }],
    }],
  };
  const expectedJson = JSON.stringify(compactCardStorageConfig(config));
  const expectedBytes = Buffer.byteLength(expectedJson, 'utf8');

  assert.throws(
    () => prepareCardStoragePayload({ format: 'lightweaver-card-runtime-package', config }),
    error => {
      assert.ok(error instanceof CardConfigCapacityError);
      assert.equal(error.name, 'CardConfigCapacityError');
      assert.equal(error.reason, 'config-too-large');
      assert.equal(error.bytes, expectedBytes);
      assert.equal(error.maxBytes, CARD_CONFIG_STORAGE_LIMIT_BYTES);
      assert.equal(
        error.message,
        `Card configuration is ${expectedBytes} bytes, exceeding the ${CARD_CONFIG_STORAGE_LIMIT_BYTES}-byte flash storage limit. Remove playlist looks or simplify combo zones, then try again.`,
      );
      return true;
    },
  );
});

function reconstructFirmwareLookDefaults(config = {}) {
  return config.looks.map(look => ({
    ...look,
    mode: look.mode ?? (config.mode === 'sd-sequence' ? 'sequence' : 'procedural'),
    preset: look.preset ?? look.id,
    fps: look.fps ?? 24,
    loop: look.loop ?? true,
    fadeOutMs: look.fadeOutMs ?? 320,
    fadeInMs: look.fadeInMs ?? 420,
    brightness: look.brightness ?? 0.65,
    ...(Array.isArray(look.zones) ? { zones: look.zones.map(reconstructFirmwareZoneDefaults) } : {}),
  }));
}

function reconstructFirmwareZoneDefaults(zone = {}) {
  return {
    ...zone,
    brightness: zone.brightness ?? 1,
    speed: zone.speed ?? 1,
    hueShift: zone.hueShift ?? 0,
    customHue: zone.customHue ?? 32,
    customSaturation: zone.customSaturation ?? 230,
    customBreathe: zone.customBreathe ?? false,
    customDrift: zone.customDrift ?? false,
    blackout: zone.blackout ?? false,
  };
}
