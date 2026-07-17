import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const sourcePath = name => resolve(root, 'src', name);
const read = name => readFileSync(sourcePath(name), 'utf8');

for (const name of [
  'LightweaverOutputColorConfig.h',
  'LightweaverOutputColorParser.h',
  'LightweaverOutputColorParser.cpp',
  'LightweaverColorPipeline.h',
  'LightweaverColorPipeline.cpp',
]) {
  assert.equal(existsSync(sourcePath(name)), true, `${name} must define the centralized output-color contract`);
}

const types = read('LightweaverTypes.h');
const storage = read('LightweaverStorage.cpp');
const pipeline = read('LightweaverColorPipeline.cpp');
const main = read('main.cpp');
const wled = read('LightweaverWledJsonApi.cpp');

assert.match(types, /OutputColorConfig\s+outputColor/);
assert.match(storage, /parseOutputColorConfig\([\s\S]*doc\["led"\]/,
  'stored config must validate output color before becoming active');
assert.match(storage, /config\.maxMilliamps\s*=\s*clampMilliamps/,
  'output-color parsing must retain the production current ceiling');
assert.match(pipeline, /scale8_video\([\s\S]*applyGamma_video|gammaLut_/,
  'pipeline must apply cached RGB balance and optional gamma');
assert.match(pipeline, /switch\s*\(colorOrderCode\)/,
  'configured channel order must remain the final color transform');
assert.match(main, /outputColorPipeline\.configure\(config\.outputColor\)/);
assert.match(main, /physicalLeds\[physicalIndex\]\s*=\s*outputColorPipeline\.transform\(leds\[logicalIndex\],\s*ledColorOrderCode\)/,
  'all normal logical frames must pass through one final output-color funnel');
assert.match(main, /doc\["capabilities"\]\["outputColor"\]\s*=\s*1/);
assert.match(main, /doc\["outputColor"\]\["gammaEnabled"\]/);
assert.match(main, /doc\["outputColor"\]\["calibration"\]\["red"\]/);
assert.match(wled, /doc\["lwOutput"\]\["gammaEnabled"\]/,
  'WLED-compatible diagnostics must expose the applied output-color state');

console.log('output-color-pipeline tests passed');
