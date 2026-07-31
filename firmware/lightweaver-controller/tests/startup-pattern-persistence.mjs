import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const main = readFileSync(resolve(here, '../src/main.cpp'), 'utf8');
const storage = readFileSync(resolve(here, '../src/LightweaverStorage.cpp'), 'utf8');

const validateStart = storage.indexOf('bool validateRuntimeConfigJsonStrict(');
const validateEnd = storage.indexOf('bool mountRuntimeSd(', validateStart);
assert.ok(validateStart >= 0 && validateEnd > validateStart, 'strict config validator should exist');
const validate = storage.slice(validateStart, validateEnd);
assert.match(
  validate,
  /startup\s*==\s*id\s*\|\|\s*startup\s*==\s*preset/,
  'install validation should accept startupPatternId as either a stored look id or its preset alias',
);

const startupStart = main.indexOf('uint8_t findStartupLook() {');
const startupEnd = main.indexOf('\n}', startupStart);
assert.ok(startupStart >= 0 && startupEnd > startupStart, 'boot startup resolver should exist');
const startup = main.slice(startupStart, startupEnd);
assert.match(
  startup,
  /looks\[i\]\.id\s*==\s*startupLookId\s*\|\|\s*looks\[i\]\.preset\s*==\s*startupLookId/,
  'boot must resolve the same startup preset aliases accepted during install',
);

const setupStart = main.indexOf('void setup() {');
const setupEnd = main.indexOf('void loop() {', setupStart);
assert.ok(setupStart >= 0 && setupEnd > setupStart, 'firmware setup should exist');
const setup = main.slice(setupStart, setupEnd);
assert.ok(
  setup.indexOf('currentLookIndex = findStartupLook()') < setup.indexOf('startLook(currentLookIndex)'),
  'boot must resolve the stored startup selection before starting playback',
);

const saveStart = storage.indexOf('bool saveRuntimeConfigJson(');
const saveEnd = storage.indexOf('bool suppressSdProjectAutorunAfterFactoryReset(', saveStart);
assert.ok(saveStart >= 0 && saveEnd > saveStart, 'internal-flash config save should exist');
const save = storage.slice(saveStart, saveEnd);
assert.ok(
  save.indexOf('putString(NVS_KNOWN_GOOD_CONFIG_KEY, json)') < save.indexOf('config = *parsed'),
  'install acknowledgement must persist the startup selection before replacing live config state',
);
assert.match(
  save,
  /putString\(NVS_KNOWN_GOOD_CONFIG_KEY, json\)\s*==\s*json\.length\(\)/,
  'the complete validated multi-look package must be durably stored, not only its first pattern',
);

const parseStart = storage.indexOf('void applyJsonToConfig(');
const parseEnd = storage.indexOf('bool loadJsonString(', parseStart);
assert.ok(parseStart >= 0 && parseEnd > parseStart, 'runtime config parser should exist');
const parse = storage.slice(parseStart, parseEnd);
assert.match(parse, /for\s*\(JsonVariant\s+lookValue\s*:\s*looks\)/,
  'boot parser must restore every stored look');
assert.match(parse, /config\.lookCount\+\+/,
  'boot parser must retain the restored multi-pattern count for /api/patterns');

console.log('startup-pattern-persistence tests passed');
