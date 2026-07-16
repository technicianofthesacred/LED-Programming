import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const web = fs.readFileSync(path.join(root, 'src/LightweaverWeb.cpp'), 'utf8');
const runtime = fs.readFileSync(path.join(root, 'src/LightweaverRuntimeApi.h'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src/main.cpp'), 'utf8');

function extractFunction(source, functionName) {
  const signature = new RegExp(`\\b${functionName}\\s*\\(`, 'g');
  let match;
  while ((match = signature.exec(source))) {
    const brace = source.indexOf('{', match.index + match[0].length);
    const semicolon = source.indexOf(';', match.index + match[0].length);
    if (brace < 0 || (semicolon >= 0 && semicolon < brace)) continue;
    let depth = 0;
    for (let i = brace; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      if (source[i] === '}') depth -= 1;
      if (depth === 0) return source.slice(brace + 1, i);
    }
  }
  throw new Error(`Cannot find ${functionName}`);
}

const recoverBody = extractFunction(main, 'runtimeRecoverLights');

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
  /m\.type==='reboot'/,
  'card bridge should proxy the hard-recovery reboot request',
);

const rebootBranchStart = web.indexOf("else if(m.type==='reboot')");
const rebootBranchEnd = web.indexOf("else if(m.type==='config')", rebootBranchStart);
const rebootBranch = web.slice(rebootBranchStart, rebootBranchEnd);
assert.match(rebootBranch, /!r\.ok\|\|response\.ok===false/,
  'bridge reboot must reject a non-2xx or explicit failed reboot response');

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

const loopStart = main.indexOf('void loop() {');
const webHandler = main.indexOf('handleLightweaverWeb();', loopStart);
const recoveryRefresh = main.indexOf('recoveryHoldActive = int32_t(recoveryHoldUntilMs - millis()) > 0;', webHandler);
const recoveryBranch = main.indexOf('if (recoveryHoldActive && ledOutputsReady) {', loopStart);
const errorBranch = main.indexOf('if (errorCode != ERROR_NONE) {', loopStart);
const streamHandler = main.indexOf('handleWledRealtime();', loopStart);
assert.ok(recoveryBranch > -1, 'firmware loop should have a recovery owner branch');
assert.ok(recoveryBranch < errorBranch, 'recovery should outrank the error-state clear loop');
assert.ok(recoveryBranch < streamHandler, 'recovery should outrank external frame producers');

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
  recoverBody,
  /showLeds\(\);/,
  'Recover lights should use the normal centralized brightness and output funnel',
);

assert.doesNotMatch(
  recoverBody,
  /FastLED\.setBrightness\s*\(/,
  'Recover lights should not bypass the centralized brightness funnel',
);

assert.match(
  main,
  /firstLogicalPixel/,
  'recover diagnostics should report whether the logical LED buffer is non-black',
);

assert.doesNotMatch(
  main,
  /doc\["recovered"\] = true;/,
  'firmware must not claim physical recovery that it cannot electrically verify',
);

assert.match(
  main,
  /doc\["accepted"\] = true;/,
  'firmware should report that the recovery command was accepted',
);

assert.match(
  main,
  /bool ledOutputsReady = false;/,
  'firmware should track successful physical output setup separately from configured counts',
);

assert.match(
  main,
  /diagnostics\["frameSubmitted"\] = ledOutputsReady;/,
  'firmware must only report frame submission after every configured output was registered',
);

console.log('recover-lights-endpoint tests passed');
assert.ok(recoveryRefresh > webHandler, 'firmware loop should recompute recovery ownership after the web handler can arm it');
