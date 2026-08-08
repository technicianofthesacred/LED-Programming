import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const storage = readFileSync(resolve(here, '../src/LightweaverStorage.cpp'), 'utf8');
const scripts = JSON.parse(
  readFileSync(resolve(here, '../../../lightweaver/package.json'), 'utf8'),
).scripts;

const start = storage.indexOf('bool stageRuntimeConfigJson(');
const end = storage.indexOf('bool activateStagedRuntimeConfig(', start);
assert.notEqual(start, -1, 'stageRuntimeConfigJson should exist');
assert.notEqual(end, -1, 'activateStagedRuntimeConfig should follow staging');
const stage = storage.slice(start, end);

const readStateAt = stage.indexOf('WiringCandidateState priorState = readCandidateState(prefs)');
const validateAt = stage.indexOf('validateCandidateMetadataForBoot(prefs, priorState, message)');
const rejectAt = stage.indexOf('if (priorState != WIRING_CANDIDATE_NONE)');
const cleanupAt = stage.indexOf('finalizeCommittedPromotion(prefs)');
const writeAt = stage.indexOf('prefs.putString(NVS_CANDIDATE_CONFIG_KEY, json)');

assert.ok(readStateAt >= 0 && validateAt > readStateAt,
  'staging should read and validate the persisted transaction before acting');
assert.ok(rejectAt > validateAt && cleanupAt > rejectAt,
  'an accurate active-transaction rejection must happen before committed cleanup');
assert.ok(writeAt > cleanupAt,
  'the active-transaction guard must run before candidate bytes can change');
assert.match(
  stage.slice(rejectAt, cleanupAt),
  /prefs\.end\(\);[\s\S]*message = "wiring transaction is active; confirm or roll back before staging another candidate";[\s\S]*return false;/,
  'a second staged POST should explain the active transaction and leave it untouched',
);

assert.match(
  scripts['test:core'],
  /node \.\.\/firmware\/lightweaver-controller\/tests\/wiring-stage-active-transaction\.mjs/,
  'the source contract list should include the active-transaction regression wrapper',
);
assert.match(
  scripts['test:core'],
  /node \.\.\/firmware\/lightweaver-controller\/tests\/hash-config-install\.mjs/,
  'the source contract list should include the reusable-window hash installer wrapper',
);
assert.match(
  scripts['test:core:source'],
  /node scripts\/run-core-source-tests\.mjs/,
  'test:core:source should execute the configured source contract list',
);

console.log('wiring-stage-active-transaction tests passed');
