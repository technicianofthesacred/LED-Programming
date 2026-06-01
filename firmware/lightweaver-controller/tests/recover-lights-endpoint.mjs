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
  /brightnessByte/,
  'recover diagnostics should report the final FastLED brightness byte',
);

assert.match(
  main,
  /firstLogicalPixel/,
  'recover diagnostics should report whether the logical LED buffer is non-black',
);

console.log('recover-lights-endpoint tests passed');
