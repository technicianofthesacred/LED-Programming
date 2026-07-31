import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(here, '../../../packages/lightweaver-contract/card-hardware.json');
const headerPath = path.resolve(here, '../../../firmware/lightweaver-controller/src/LightweaverHardwareContract.h');
const generatorPath = path.resolve(here, '../../scripts/generate-card-hardware-contract.mjs');
const firmwareSource = path.resolve(here, '../../../firmware/lightweaver-controller/src');
const studioStoragePath = path.resolve(here, 'cardStoragePayload.js');
const execFile = promisify(execFileCallback);

async function loadContract() {
  let manifestSource;
  try {
    manifestSource = await readFile(manifestPath, 'utf8');
  } catch (error) {
    assert.fail(`missing canonical hardware manifest: ${error.message}`);
  }
  const [studio, generator] = await Promise.all([
    import('./cardHardwareContract.js'),
    import('../../scripts/generate-card-hardware-contract.mjs'),
  ]);
  return { hardwareManifest: JSON.parse(manifestSource), ...studio, ...generator };
}

function headerNumber(source, name) {
  const match = source.match(new RegExp(`constexpr\\s+(?:uint8_t|uint16_t|uint32_t|size_t)\\s+${name}\\s*=\\s*(\\d+);`));
  assert.ok(match, `missing ${name} in generated header`);
  return Number(match[1]);
}

function headerPins(source) {
  const match = source.match(/LW_CARD_HARDWARE_OUTPUT_GPIOS\[\]\s*=\s*\{([^}]+)\};/);
  assert.ok(match, 'missing LW_CARD_HARDWARE_OUTPUT_GPIOS in generated header');
  return match[1].split(',').map(value => Number(value.trim()));
}

test('canonical hardware manifest stays identical in Studio and firmware', async () => {
  const { hardwareManifest, CARD_HARDWARE_CONTRACT } = await loadContract();
  const header = await readFile(headerPath, 'utf8');
  const expected = {
    outputPins: hardwareManifest.outputPins,
    maxOutputs: hardwareManifest.limits.maxOutputs,
    maxPixels: hardwareManifest.limits.maxPixels,
    maxZones: hardwareManifest.limits.maxZones,
    maxRangesPerZone: hardwareManifest.limits.maxRangesPerZone,
    configCapacityBytes: hardwareManifest.limits.configCapacityBytes,
  };

  assert.deepEqual(CARD_HARDWARE_CONTRACT, expected);
  assert.deepEqual(headerPins(header), expected.outputPins);
  assert.equal(headerNumber(header, 'LW_CARD_HARDWARE_MAX_OUTPUTS'), expected.maxOutputs);
  assert.equal(headerNumber(header, 'LW_CARD_HARDWARE_MAX_PIXELS'), expected.maxPixels);
  assert.equal(headerNumber(header, 'LW_CARD_HARDWARE_MAX_ZONES'), expected.maxZones);
  assert.equal(headerNumber(header, 'LW_CARD_HARDWARE_MAX_RANGES_PER_ZONE'), expected.maxRangesPerZone);
  assert.equal(headerNumber(header, 'LW_CARD_HARDWARE_CONFIG_CAPACITY_BYTES'), expected.configCapacityBytes);
});

test('hardware-contract generator rejects unsafe and duplicate output pins', async () => {
  const { hardwareManifest, validateCardHardwareManifest } = await loadContract();
  assert.throws(
    () => validateCardHardwareManifest({ ...hardwareManifest, outputPins: [16, 16] }),
    /unique/i,
  );
  assert.throws(
    () => validateCardHardwareManifest({ ...hardwareManifest, outputPins: [16, 49] }),
    /safe GPIO/i,
  );
  assert.throws(
    () => validateCardHardwareManifest({ ...hardwareManifest, limits: { ...hardwareManifest.limits, maxPixels: 0 } }),
    /positive integer/i,
  );
});

test('hardware-contract generator produces a stable header', async () => {
  const { hardwareManifest, generateCardHardwareHeader } = await loadContract();
  const first = generateCardHardwareHeader(hardwareManifest);
  const second = generateCardHardwareHeader(structuredClone(hardwareManifest));

  assert.equal(first, second);
  assert.match(first, /Generated from packages\/lightweaver-contract\/card-hardware\.json/);
});

test('hardware-contract generator writes the checked-in firmware header', async () => {
  await execFile(process.execPath, [generatorPath]);
  const header = await readFile(headerPath, 'utf8');

  assert.match(header, /LW_CARD_HARDWARE_CONFIG_CAPACITY_BYTES = 3968;/);
});

test('active Studio and firmware capacity consumers enforce generated contract parity', async () => {
  const [types, web, recipe, storage] = await Promise.all([
    readFile(path.join(firmwareSource, 'LightweaverTypes.h'), 'utf8'),
    readFile(path.join(firmwareSource, 'LightweaverWeb.cpp'), 'utf8'),
    readFile(path.join(firmwareSource, 'LightweaverRecipe.h'), 'utf8'),
    readFile(studioStoragePath, 'utf8'),
  ]);

  assert.match(types, /static_assert\(LW_MAX_PIXELS == LW_CARD_HARDWARE_MAX_PIXELS/);
  assert.match(types, /static_assert\(LW_MAX_OUTPUTS == LW_CARD_HARDWARE_MAX_OUTPUTS/);
  assert.match(types, /static_assert\(LW_MAX_ZONES == LW_CARD_HARDWARE_MAX_ZONES/);
  assert.match(types, /static_assert\(LW_MAX_RANGES_PER_ZONE == LW_CARD_HARDWARE_MAX_RANGES_PER_ZONE/);
  assert.match(web, /static_assert\(LW_MAX_RUNTIME_REQUEST_BODY_BYTES == LW_CARD_HARDWARE_CONFIG_CAPACITY_BYTES/);
  assert.match(web, /static_assert\(LW_WEB_CONFIG_MAX_BODY_BYTES == LW_CARD_HARDWARE_CONFIG_CAPACITY_BYTES/);
  assert.match(recipe, /static_assert\(LW_RECIPE_MAX_CONFIG_BYTES == LW_CARD_HARDWARE_CONFIG_CAPACITY_BYTES/);
  assert.match(storage, /CARD_CONFIG_STORAGE_LIMIT_BYTES = CARD_HARDWARE_CONTRACT\.configCapacityBytes/);
});
