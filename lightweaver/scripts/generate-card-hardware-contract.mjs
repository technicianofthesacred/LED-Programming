import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const manifestPath = path.join(root, 'packages/lightweaver-contract/card-hardware.json');
const headerPath = path.join(root, 'firmware/lightweaver-controller/src/LightweaverHardwareContract.h');

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

export function validateCardHardwareManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('Hardware contract must be an object.');
  }
  const contractVersion = positiveInteger(manifest.contractVersion, 'contractVersion');
  const outputPins = manifest.outputPins;
  if (!Array.isArray(outputPins) || outputPins.length === 0) {
    throw new TypeError('outputPins must be a non-empty array.');
  }
  const uniquePins = new Set();
  for (const pin of outputPins) {
    if (!Number.isSafeInteger(pin) || pin < 0 || pin > 48) {
      throw new RangeError(`outputPins must contain a safe GPIO value (0-48): ${pin}`);
    }
    if (uniquePins.has(pin)) throw new RangeError(`outputPins must be unique: ${pin}`);
    uniquePins.add(pin);
  }
  const limits = manifest.limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new TypeError('limits must be an object.');
  }
  const normalized = {
    contractVersion,
    outputPins: [...outputPins],
    limits: {
      maxOutputs: positiveInteger(limits.maxOutputs, 'limits.maxOutputs'),
      maxPixels: positiveInteger(limits.maxPixels, 'limits.maxPixels'),
      maxZones: positiveInteger(limits.maxZones, 'limits.maxZones'),
      maxRangesPerZone: positiveInteger(limits.maxRangesPerZone, 'limits.maxRangesPerZone'),
      configCapacityBytes: positiveInteger(limits.configCapacityBytes, 'limits.configCapacityBytes'),
    },
  };
  if (normalized.outputPins.length < normalized.limits.maxOutputs) {
    throw new RangeError('outputPins must cover every configured output.');
  }
  return normalized;
}

export function generateCardHardwareHeader(manifest) {
  const contract = validateCardHardwareManifest(manifest);
  const { limits } = contract;
  return `#pragma once\n\n// Generated from packages/lightweaver-contract/card-hardware.json. Do not edit.\n\n#include <cstddef>\n#include <cstdint>\n\nconstexpr uint8_t LW_CARD_HARDWARE_CONTRACT_VERSION = ${contract.contractVersion};\nconstexpr uint8_t LW_CARD_HARDWARE_OUTPUT_GPIOS[] = {${contract.outputPins.join(', ')}};\nconstexpr size_t LW_CARD_HARDWARE_OUTPUT_GPIO_COUNT =\n    sizeof(LW_CARD_HARDWARE_OUTPUT_GPIOS) / sizeof(LW_CARD_HARDWARE_OUTPUT_GPIOS[0]);\nconstexpr uint8_t LW_CARD_HARDWARE_MAX_OUTPUTS = ${limits.maxOutputs};\nconstexpr uint16_t LW_CARD_HARDWARE_MAX_PIXELS = ${limits.maxPixels};\nconstexpr uint8_t LW_CARD_HARDWARE_MAX_ZONES = ${limits.maxZones};\nconstexpr uint8_t LW_CARD_HARDWARE_MAX_RANGES_PER_ZONE = ${limits.maxRangesPerZone};\nconstexpr uint16_t LW_CARD_HARDWARE_CONFIG_CAPACITY_BYTES = ${limits.configCapacityBytes};\n`;
}

export async function writeCardHardwareHeader({ source = manifestPath, target = headerPath } = {}) {
  const manifest = JSON.parse(await readFile(source, 'utf8'));
  const header = generateCardHardwareHeader(manifest);
  await writeFile(target, header);
  return header;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeCardHardwareHeader();
}
