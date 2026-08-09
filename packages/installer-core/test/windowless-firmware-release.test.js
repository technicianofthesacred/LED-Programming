import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertFirmwareManifestCardStudio,
  validateFirmwareManifest,
} from '../src/firmware-release.js';

const hash = character => character.repeat(64);
const manifest = {
  schemaVersion: 1,
  target: 'esp32-s3-n16r8',
  firmwareVersion: '1.2.3',
  buildId: 'a'.repeat(40),
  buildNumber: 1216,
  image: {
    url: `/firmware/releases/1.2.3/${'a'.repeat(40)}/lightweaver-controller-esp32s3-factory.bin`,
    size: 1200000,
    sha256: hash('1'),
    cardStudioReadback: { offset: 0, size: 1200000, sha256: hash('1') },
  },
  cardStudio: {
    buildId: 'a'.repeat(40),
    buildNumber: 1216,
    projectSchema: { min: 3, max: 3 },
    firmwareApi: { min: 1, max: 1 },
    totalSize: 333,
    bundleSha256: hash('2'),
    releaseMetadata: { size: 900, sha256: hash('3') },
    assets: [
      { path: '/studio/', size: 111, sha256: hash('4') },
      { path: '/studio/assets/card-a1b2c3d4.js', size: 222, sha256: hash('5') },
    ],
  },
  configSchema: { min: 1, max: 1 },
  minimumInstallerVersion: '1.4.0',
  provenance: {
    sourceRevision: 'a'.repeat(40), platformio: '6.1.19', platform: 'espressif32@7.0.1',
    framework: 'framework-arduinoespressif32@3.20017.241212+sha.dcc1105b',
    libraries: { FastLED: '3.10.3', ArduinoJson: '7.4.3', WebSockets: '2.7.3' },
  },
};

test('new combined releases validate exact card Studio identity and full-image readback', () => {
  assert.equal(validateFirmwareManifest(manifest).cardStudio.bundleSha256, hash('2'));
  assert.equal(assertFirmwareManifestCardStudio(manifest), manifest);
  assert.throws(() => validateFirmwareManifest({
    ...manifest,
    cardStudio: { ...manifest.cardStudio, buildId: 'b'.repeat(40) },
  }), /card Studio buildId/i);
  assert.throws(() => validateFirmwareManifest({
    ...manifest,
    image: { ...manifest.image, cardStudioReadback: { ...manifest.image.cardStudioReadback, sha256: hash('9') } },
  }), /readback/i);
});

test('legacy signed manifests remain readable but cannot pass the new-build card Studio assertion', () => {
  const legacy = structuredClone(manifest);
  delete legacy.cardStudio;
  delete legacy.image.cardStudioReadback;
  assert.doesNotThrow(() => validateFirmwareManifest(legacy));
  assert.throws(() => assertFirmwareManifestCardStudio(legacy), /newly built.*card Studio/i);
});
