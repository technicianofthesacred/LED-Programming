import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const web = fs.readFileSync(path.join(root, 'src/LightweaverWeb.cpp'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src/LightweaverRuntimeApi.h'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.cpp'), 'utf8');

for (const method of ['HTTP_OPTIONS', 'HTTP_POST']) {
  assert.ok(
    web.includes(`server.on("/api/recover-lights", ${method},`),
    `/api/recover-lights should register ${method}`,
  );
}

assert.match(
  web,
  /m\.type==='recover-lights'/,
  'card bridge should proxy recover-lights requests for public Studio sessions',
);

assert.match(
  web,
  /handleRecoverLights/,
  'firmware web layer should expose a recover-lights handler',
);

assert.match(
  runtime,
  /String runtimeRecoverLights\(const String& patternId, float brightness, bool syncZones\);/,
  'runtime API should expose a dedicated recover-lights routine',
);

assert.match(
  main,
  /runtimeRecoverLights/,
  'main runtime should implement the recover-lights routine',
);

assert.match(
  main,
  /handleLightweaverWeb\(\);\s*if \(!recoveryHoldActive\)/,
  'firmware loop should service web recovery before draining live stream inputs',
);

assert.match(
  main,
  /recoveryHoldUntilMs = millis\(\) \+ 5000;/,
  'recover-lights should hold internal recovery output long enough to beat stale live streams',
);

assert.match(
  main,
  /recoveryBrightnessBypassUntilMs = millis\(\) \+ 5000;/,
  'recover-lights should bypass the physical brightness knob briefly during recovery',
);

assert.match(
  main,
  /bool isRecoveryPresetPattern\(const String& id\)/,
  'recover-lights should explicitly recognize solid recovery presets',
);

assert.match(
  main,
  /renderRecoveryPattern\(id, leds, totalPixels, millis\(\), mods\)/,
  'recover-lights should render the requested recovery pattern directly instead of relying on sequence mode',
);

assert.match(
  main,
  /if \(isRecoveryPresetPattern\(id\)\) return renderPresetPattern\(id, target, count, mods\);/,
  'recover-lights should render warm-white and solid test colors as presets before procedural fallback',
);

assert.match(
  main,
  /id == "test-white"/,
  'recover-lights should recognize the white strip test preset',
);

assert.match(
  main,
  /bool isWhiteTestRecovery = id == "test-white" \|\| id == "white";[\s\S]*if \(!isWhiteTestRecovery && visibleBrightness < 0\.65f\) visibleBrightness = 0\.65f;/,
  'recover-lights should allow the white strip finder test to run below recovery brightness to avoid power spikes',
);

assert.match(
  main,
  /brightnessByte/,
  'recover diagnostics should report the final FastLED brightness byte',
);

assert.match(
  main,
  /firstLogicalPixel/,
  'recover diagnostics should report whether the logical LED buffer is non-black',
);

console.log('recover-lights-endpoint tests passed');
