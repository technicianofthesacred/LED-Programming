import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const types = fs.readFileSync(path.join(root, 'src/LightweaverTypes.h'), 'utf8');
const storage = fs.readFileSync(path.join(root, 'src/LightweaverStorage.cpp'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.cpp'), 'utf8');

for (const [field, type] of [
  ['projectRevision', 'uint32_t'],
  ['projectFingerprint', 'String'],
  ['productionJobId', 'String'],
  ['productionJobDigest', 'String'],
]) {
  assert.match(
    types,
    new RegExp(`${type}\\s+${field}\\b`),
    `runtime config should own bounded ${field} identity`,
  );
  assert.match(
    storage,
    new RegExp(`config\\.${field}\\s*=\\s*(?:String\\()?doc\\["${field}"\\]`),
    `storage parser should load ${field} from the accepted runtime package`,
  );
  assert.match(
    main,
    new RegExp(`doc\\["${field}"\\]\\s*=\\s*runtimeConfig\\.${field}`),
    `firmware-info should independently expose ${field}`,
  );
}

for (const [constant, value] of [
  ['LW_PROJECT_FINGERPRINT_MAX_LENGTH', '64'],
  ['LW_PRODUCTION_JOB_ID_MAX_LENGTH', '96'],
  ['LW_PRODUCTION_JOB_DIGEST_LENGTH', '64'],
]) {
  assert.match(types, new RegExp(`${constant}\\s*=\\s*${value}\\b`));
}

for (const message of [
  'project revision must be a non-negative integer',
  'project fingerprint must be 16 to 64 lowercase hex characters',
  'production job id must use 1 to 96 safe characters',
  'production job digest must be 64 lowercase hex characters',
  'production job id and digest must be provided together',
]) {
  assert.match(storage, new RegExp(message), `strict identity validation should report: ${message}`);
}

const saveStart = storage.indexOf('bool saveRuntimeConfigJson(');
const stageStart = storage.indexOf('bool stageRuntimeConfigJson(', saveStart);
const saveBody = storage.slice(saveStart, stageStart);
assert.match(saveBody, /validateRuntimeConfigJsonStrict\(json, \*parsed, message\)[\s\S]*putString\(NVS_KNOWN_GOOD_CONFIG_KEY, json\)/);
assert.match(saveBody, /if \(!ok\)[\s\S]*return false;[\s\S]*config = \*parsed;/, 'active identity must change only after the entire config is stored');

const stageEnd = storage.indexOf('bool activateStagedRuntimeConfig(', stageStart);
const stageBody = storage.slice(stageStart, stageEnd);
assert.match(stageBody, /validateRuntimeConfigJsonStrict\(json, \*parsed, message\)[\s\S]*putString\(NVS_CANDIDATE_CONFIG_KEY, json\)/);
assert.doesNotMatch(stageBody, /NVS_KNOWN_GOOD_CONFIG_KEY/, 'staging must not overwrite acknowledged identity');

const statusStart = storage.indexOf('String runtimeWiringSafetyStatusJson()');
const statusEnd = storage.indexOf('bool runtimeConfigJsonChangesWiring(', statusStart);
const statusBody = storage.slice(statusStart, statusEnd);
for (const marker of ['NVS_CANDIDATE_CONFIG_KEY', 'activationId', 'projectRevision', 'projectFingerprint']) {
  assert.match(statusBody, new RegExp(marker), 'candidate status should bind candidate identity to the card-issued activation id');
}
assert.doesNotMatch(
  main.match(/String runtimeFirmwareInfo\(\)[\s\S]*?return out;\n\}/)?.[0] || '',
  /doc\["(?:password|credentials|rawNvs)"\]/i,
);

assert.match(
  types,
  /String\s+pieceId\b/,
  'runtime config should store a stable Studio project id separately from the display name',
);

assert.match(
  storage,
  /config\.pieceId\s*=\s*String\(doc\["piece"\]\["id"\]/,
  'storage parser should load piece.id from card runtime packages',
);

assert.match(
  main,
  /doc\["piece"\]\["id"\]\s*=\s*runtimeConfig\.pieceId/,
  'firmware-info should expose the stored piece id for wrong-project write guards',
);

assert.match(
  main,
  /doc\["piece"\]\["name"\]\s*=\s*runtimeConfig\.pieceName/,
  'firmware-info should expose the stored piece name for human-readable mismatch errors',
);

console.log('project-identity-contract tests passed');
