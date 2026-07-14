import assert from 'node:assert/strict';
import fs from 'node:fs';

const web = fs.readFileSync(new URL('../src/LightweaverWeb.cpp', import.meta.url), 'utf8');
const storage = fs.readFileSync(new URL('../src/LightweaverStorage.h', import.meta.url), 'utf8');
const storageImplementation = fs.readFileSync(new URL('../src/LightweaverStorage.cpp', import.meta.url), 'utf8');
const runtime = fs.readFileSync(new URL('../src/main.cpp', import.meta.url), 'utf8');

for (const [path, method] of [
  ['/api/wiring/status', 'HTTP_GET'],
  ['/api/wiring/candidate', 'HTTP_POST'],
  ['/api/wiring/activate', 'HTTP_POST'],
  ['/api/wiring/confirm', 'HTTP_POST'],
  ['/api/wiring/rollback', 'HTTP_POST'],
  ['/api/wiring/discover', 'HTTP_POST'],
]) {
  assert.match(web, new RegExp(`server\\.on\\("${path.replaceAll('/', '\\/')}"\\s*,\\s*${method}`), `${method} ${path} must be registered`);
}

for (const type of ['wiring-status', 'wiring-candidate', 'wiring-activate', 'wiring-confirm', 'wiring-rollback', 'wiring-discover']) {
  assert.ok(web.includes(`m.type==='${type}'`), `card bridge must relay ${type}`);
}

assert.match(storage, /stageRuntimeConfigJson[\s\S]*activationId/, 'staging must return a card-generated activation ID');
assert.match(storage, /activateStagedRuntimeConfig\([^)]*activationId/, 'activation must require the matching ID');
assert.match(storage, /confirmCandidateRuntimeConfig\([^)]*activationId/, 'confirmation must require the matching ID');
assert.match(storage, /rollbackCandidateRuntimeConfig\([^)]*activationId/, 'rollback must accept the matching ID');
assert.match(storageImplementation, /if \(maxMilliamps < 0 \|\| maxMilliamps > static_cast<long>\(LW_MAX_MILLIAMPS\)\)[\s\S]*unsafe LED current limit/, 'strict validation must reject an unsafe current limit instead of silently clamping it');
assert.match(storageImplementation, /if \(brightnessLimit < 0\.0f \|\| brightnessLimit > 1\.0f\)[\s\S]*brightness limit must be between 0 and 1/, 'strict validation must reject an invalid brightness limit instead of silently clamping it');

assert.match(runtime, /LW_DISCOVERY_BATCH_SIZE\s*=\s*4/, 'wire discovery must cap a batch at four GPIOs');
assert.match(runtime, /"assignments"/, 'discovery must return color-to-GPIO assignments');
assert.match(runtime, /"remainingProbationMs"|remainingProbationMs/, 'status must expose the card-owned probation time');
assert.match(runtime, /setupSafeDiscoveryOutputs[\s\S]*addLedsForPin/, 'discovery assignments must drive real LED outputs');

console.log('wiring-safety-api tests passed');
