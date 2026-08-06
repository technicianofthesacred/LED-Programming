// Root cause (discovery findings 2026-08-06, #1): an abandoned Find-my-strips
// run left the card committed to the bench scaffolding project, silently
// driving 1024 pixels on every later boot. The fix marks such a project
// provisional INSIDE its stored JSON ("provisional": true), reports it on
// /api/status + /api/firmware-info as provisionalSetup, and holds the internal
// renderer dark on an unattended provisional boot (streamed frames and the
// physical controls still restore light).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const storage = readFileSync(resolve(root, 'src/LightweaverStorage.cpp'), 'utf8');
const types = readFileSync(resolve(root, 'src/LightweaverTypes.h'), 'utf8');
const main = readFileSync(resolve(root, 'src/main.cpp'), 'utf8');

assert.match(types, /bool provisionalProject = false;/,
  'RuntimeConfig must carry the provisional marker');

assert.match(storage, /config\.provisionalProject = doc\["provisional"\] \| false;/,
  'the boot parser must restore the provisional marker from the stored JSON');

assert.match(storage, /provisional must be a boolean/,
  'strict validation must reject a non-boolean provisional field');

assert.match(storage, /doc\["provisionalSetup"\] = config\.provisionalProject;/,
  '/api/status must report the provisional marker');
assert.match(main, /doc\["provisionalSetup"\] = runtimeConfig\.provisionalProject;/,
  '/api/firmware-info must report the provisional marker');

const resetStart = storage.indexOf('void resetConfig(RuntimeConfig& config) {');
const resetEnd = storage.indexOf('\n}', resetStart);
assert.ok(resetStart >= 0 && resetEnd > resetStart, 'resetConfig should exist');
assert.match(storage.slice(resetStart, resetEnd), /config\.provisionalProject = false;/,
  'resetConfig must clear the provisional marker');

// The unattended dark boot: provisional projects skip the visible startup
// fade-in unless this boot is a wiring-probation candidate (probation NEEDS a
// visible frame — wiring-probation-runtime.mjs pins that ordering).
const setupStart = main.indexOf('void setup() {');
const setupEnd = main.indexOf('void loop() {', setupStart);
const setup = main.slice(setupStart, setupEnd);
assert.match(setup,
  /if \(runtimeConfig\.provisionalProject && !loadResult\.bootedCandidate\) \{[\s\S]*?fadeTo\(0\.0f, 0\);[\s\S]*?\} else \{[\s\S]*?fadeTo\(1\.0f, looks\[currentLookIndex\]\.fadeInMs\);[\s\S]*?\}/,
  'a provisional, non-candidate boot must hold the internal renderer dark');
assert.ok(setup.indexOf('startLook(currentLookIndex)') < setup.indexOf('runtimeConfig.provisionalProject'),
  'the dark hold must come after the look is prepared, not instead of it');

console.log('provisional bench project tests passed');
