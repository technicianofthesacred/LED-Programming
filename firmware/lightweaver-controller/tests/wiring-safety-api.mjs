import assert from 'node:assert/strict';
import fs from 'node:fs';

const web = fs.readFileSync(new URL('../src/LightweaverWeb.cpp', import.meta.url), 'utf8');
const storage = fs.readFileSync(new URL('../src/LightweaverStorage.h', import.meta.url), 'utf8');
const storageImplementation = fs.readFileSync(new URL('../src/LightweaverStorage.cpp', import.meta.url), 'utf8');
const runtime = fs.readFileSync(new URL('../src/main.cpp', import.meta.url), 'utf8');

for (const [path, method] of [
  ['/api/wiring/status', 'HTTP_GET'],
  ['/api/wiring/activate', 'HTTP_POST'],
  ['/api/wiring/confirm', 'HTTP_POST'],
  ['/api/wiring/rollback', 'HTTP_POST'],
  ['/api/wiring/discover', 'HTTP_POST'],
]) {
  assert.match(web, new RegExp(`server\\.on\\("${path.replaceAll('/', '\\/')}"\\s*,\\s*${method}`), `${method} ${path} must be registered`);
}
assert.match(web, /class BoundedRuntimeRequestHandler[\s\S]*\/api\/wiring\/candidate/,
  'POST /api/wiring/candidate must use the bounded raw request handler');

for (const type of ['wiring-status', 'wiring-candidate', 'wiring-activate', 'wiring-confirm', 'wiring-rollback', 'wiring-discover']) {
  assert.ok(web.includes(`m.type==='${type}'`), `card bridge must relay ${type}`);
}

assert.match(storage, /stageRuntimeConfigJson[\s\S]*activationId/, 'staging must return a card-generated activation ID');
assert.match(storage, /activateStagedRuntimeConfig\([^)]*activationId/, 'activation must require the matching ID');
assert.match(storage, /confirmCandidateRuntimeConfig\([^)]*activationId/, 'confirmation must require the matching ID');
assert.match(storage, /rollbackCandidateRuntimeConfig\([^)]*activationId/, 'rollback must accept the matching ID');
assert.match(storageImplementation, /if \(maxMilliamps < 0 \|\| maxMilliamps > static_cast<long>\(LW_MAX_MILLIAMPS\)\)[\s\S]*unsafe LED current limit/, 'strict validation must reject an unsafe current limit instead of silently clamping it');
assert.match(storageImplementation, /if \(brightnessLimit < 0\.0f \|\| brightnessLimit > 1\.0f\)[\s\S]*brightness limit must be between 0 and 1/, 'strict validation must reject an invalid brightness limit instead of silently clamping it');
const statusJson = storageImplementation.slice(
  storageImplementation.indexOf('String runtimeWiringSafetyStatusJson()'),
  storageImplementation.indexOf('bool runtimeConfigJsonChangesWiring('),
);
for (const field of ['app', 'state', 'activationId', 'cardId', 'firmwareVersion', 'buildId', 'projectRevision', 'projectFingerprint', 'productionJobId', 'productionJobDigest']) {
  assert.match(statusJson, new RegExp(`doc\\["${field}"\\]`), `candidate status must expose exact ${field}`);
}
assert.match(statusJson, /NVS_CANDIDATE_CONFIG_KEY/, 'candidate identity must come from the staged package, not active runtime guesses');

assert.match(runtime, /LW_DISCOVERY_STEP_COUNT\s*=\s*LW_APPROVED_OUTPUT_GPIO_COUNT/,
  'wire discovery must expose exactly the approved GPIOs as sequential steps');
assert.match(runtime, /"pin"/, 'discovery must return the one active GPIO');
for (const field of ['step', 'stepCount', 'brightnessLimit', 'pixelLimit', 'nextStep']) {
  assert.match(runtime, new RegExp(`doc\\["${field}"\\]`), `discovery must report ${field}`);
}
assert.match(runtime, /"remainingProbationMs"|remainingProbationMs/, 'status must expose the card-owned probation time');
assert.match(runtime, /setupSafeDiscoveryOutputs[\s\S]*addLedsForPin/, 'discovery assignments must drive real LED outputs');

console.log('wiring-safety-api tests passed');
