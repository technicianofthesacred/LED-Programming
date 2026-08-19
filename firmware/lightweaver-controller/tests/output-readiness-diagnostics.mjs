import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const main = read('src/main.cpp');
const storage = read('src/LightweaverStorage.cpp');
const runtimeApi = read('src/LightweaverRuntimeApi.h');

function functionBody(source, signature) {
  const match = source.match(signature);
  assert.ok(match, `missing function matching ${signature}`);
  const start = match.index;
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function matching ${signature}`);
}

const status = functionBody(storage, /String\s+runtimeStatusJson\s*\(/);
const firmwareInfo = functionBody(main, /String\s+runtimeFirmwareInfo\s*\(/);

for (const [name, payload] of [['status', status], ['firmware-info', firmwareInfo]]) {
  assert.match(payload, /doc\["outputReady"\]\s*=\s*runtimeOutputReady\(\)/,
    `${name} must preserve the compatibility outputReady field`);
  assert.match(payload, /doc\["projectOutputReady"\]\s*=\s*runtimeProjectOutputReady\(\)/,
    `${name} must expose configured-project readiness separately`);
  assert.match(payload, /doc\["outputDriverReady"\]\s*=\s*runtimeOutputDriverReady\(\)/,
    `${name} must expose physical driver readiness separately`);
  assert.match(payload, /doc\["pixelCapacity"\]\["schemaLimit"\]\s*=\s*LW_MAX_PIXELS/,
    `${name} must label the schema pixel limit truthfully`);
  assert.match(payload, /doc\["pixelCapacity"\]\["allocatedBoot"\]\s*=\s*runtimeAllocatedPixelCapacity\(\)/,
    `${name} must expose this boot's allocated pixel capacity`);
  assert.match(payload, /outputInitialization[\s\S]*runtimeOutputInitializationCode\(\)[\s\S]*runtimeOutputInitializationMessage\(\)/,
    `${name} must include structured output initialization detail`);
}

assert.match(status, /doc\["limits"\]\["pixels"\]\s*=\s*LW_MAX_PIXELS/,
  'the legacy limits.pixels compatibility field must remain unchanged');
assert.match(firmwareInfo, /doc\["limits"\]\["pixels"\]\s*=\s*LW_MAX_PIXELS/,
  'firmware-info must retain the legacy limits.pixels compatibility field');

for (const declaration of [
  /bool\s+runtimeProjectOutputReady\s*\(\)/,
  /bool\s+runtimeOutputDriverReady\s*\(\)/,
  /uint16_t\s+runtimeAllocatedPixelCapacity\s*\(\)/,
  /const char\*\s+runtimeOutputInitializationCode\s*\(\)/,
  /const char\*\s+runtimeOutputInitializationMessage\s*\(\)/,
]) {
  assert.match(runtimeApi, declaration, `runtime API must declare ${declaration}`);
}

const compatibilityReady = functionBody(main, /bool\s+runtimeOutputReady\s*\(/);
const projectReady = functionBody(main, /bool\s+runtimeProjectOutputReady\s*\(/);
const driverReady = functionBody(main, /bool\s+runtimeOutputDriverReady\s*\(/);
assert.match(compatibilityReady, /runtimeProjectOutputReady\(\)/,
  'legacy outputReady must remain an alias of project output readiness');
assert.match(projectReady, /provisioningOutputReady\(ledOutputsReady,\s*outputCount\)/,
  'project readiness must still require configured outputs');
assert.match(driverReady, /return\s+ledOutputsReady/,
  'driver readiness must report successful controller initialization even for a factory beacon');

assert.match(main, /setOutputInitializationFailure\("pixel-buffer-allocation"/,
  'allocation failure must identify its initialization stage');
assert.match(main, /setOutputInitializationFailure\("project-output"/,
  'configured output failure must identify its initialization stage');
assert.match(main, /setOutputInitializationFailure\("factory-beacon"/,
  'factory beacon failure must be distinguishable from dead output hardware');

console.log('output-readiness-diagnostics tests passed');
