import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const main = readFileSync(resolve(root, 'src/main.cpp'), 'utf8');
const storage = readFileSync(resolve(root, 'src/LightweaverStorage.cpp'), 'utf8');
const types = readFileSync(resolve(root, 'src/LightweaverTypes.h'), 'utf8');

assert.match(
  types,
  /struct RuntimeConfig\s*{[\s\S]*String ledType\s*=\s*"WS2812B";/,
  'legacy projects without an LED type must retain the WS2812B controller',
);
assert.match(
  storage,
  /config\.ledType\s*=\s*String\(led\["type"\]\s*\|\s*"WS2812B"\)/,
  'runtime storage must preserve the project LED type with a legacy fallback',
);
assert.match(
  storage,
  /led type must be WS2812B or WS2815/,
  'firmware must reject unsupported LED chipset types before applying config',
);
assert.match(
  storage,
  /canonicalLed\["version"\]\s*=\s*bindLedType\s*\?\s*2\s*:\s*1;[\s\S]*canonicalLed\["type"\]\s*=\s*ledType/,
  'wiring digest v2 must bind an explicit LED chipset while keeping missing-type v1 compatibility',
);
const legacyUpgrade = storage.match(/bool upgradeLegacyNvsWiringDigest\([\s\S]*?\n\}/)?.[0] || '';
assert.match(
  legacyUpgrade,
  /doc\["led"\]\["type"\]\.isNull\(\)[\s\S]*calculateWiringDigest\(doc, true\)[\s\S]*calculateWiringDigest\(doc, false\)[\s\S]*suppliedDigest\s*!=\s*legacyDigest/,
  'only an explicit LED type with the exact legacy physical digest may enter the one-time upgrade path',
);
assert.match(
  legacyUpgrade,
  /doc\["wiringDigest"\]\s*=\s*currentDigest[\s\S]*serializeJson\(doc, json\)/,
  'a verified legacy NVS config must be rewritten to the type-bound digest before strict validation',
);
const strictValidation = storage.match(/bool validateRuntimeConfigJsonStrict\([\s\S]*?\nbool loadSdConfig\(/)?.[0] || '';
assert.doesNotMatch(
  strictValidation,
  /upgradeLegacyNvsWiringDigest/,
  'new Studio and SD payloads must not bypass the type-bound digest contract',
);
const nvsLoad = storage.match(/ProvisioningStorageState loadNvsConfigKeyStrict\([\s\S]*?\n\}/)?.[0] || '';
assert.match(
  nvsLoad,
  /allowLegacyDigestUpgrade\s*&&\s*upgradeLegacyNvsWiringDigest\(json\)[\s\S]*validateRuntimeConfigJsonStrict\(json[\s\S]*prefs\.putString\(key, json\)[\s\S]*prefs\.getString\(key,[\s\S]*prefs\.putString\(key, originalJson\)/,
  'the opted-in persisted NVS config receives an exact-match upgrade with readback and rollback',
);
assert.match(
  storage,
  /loadNvsConfigKeyStrict\(\s*NVS_KNOWN_GOOD_CONFIG_KEY,\s*config,\s*knownGoodValid,\s*message,\s*true\)/,
  'only the committed known-good slot opts into legacy digest migration',
);
assert.doesNotMatch(
  storage,
  /loadNvsConfigKeyStrict\(\s*NVS_CANDIDATE_CONFIG_KEY,[\s\S]{0,120},\s*true\)/,
  'staged candidates must remain current-digest-only',
);
assert.match(
  main,
  /ledType\s*=\s*config\.ledType;/,
  'the configured LED type must reach physical output setup',
);
assert.match(
  main,
  /if\s*\(ledType\s*==\s*"WS2815"\)\s*{[\s\S]*FastLED\.addLeds<WS2815, DATA_PIN, RGB>\(start, count\);[\s\S]*}\s*else\s*{[\s\S]*FastLED\.addLeds<WS2812B, DATA_PIN, RGB>\(start, count\);/,
  'WS2815 projects must use FastLED native WS2815 timing while other projects retain WS2812B',
);
assert.match(
  main,
  /doc\["ledType"\]\s*=\s*runtimeConfig\.ledType;/,
  'firmware info must identify the active physical LED controller',
);
assert.match(
  storage,
  /changes\s*=\s*changes\s*\|\|[\s\S]*parsed->ledType\s*!=\s*current\.ledType/,
  'changing LED timing must be classified as physical wiring that requires restart and probation',
);
assert.match(
  storage,
  /doc\["ledType"\]\s*=\s*String\(candidateDoc\["led"\]\["type"\]\s*\|\s*"WS2812B"\)/,
  'staged wiring status must expose the candidate LED timing',
);

console.log('ws2815-output-driver tests passed');
