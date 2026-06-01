import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(here, '../src');
const types = readFileSync(resolve(srcDir, 'LightweaverTypes.h'), 'utf8');
const storage = readFileSync(resolve(srcDir, 'LightweaverStorage.cpp'), 'utf8');
const main = readFileSync(resolve(srcDir, 'main.cpp'), 'utf8');

assert.match(types, /struct\s+LookZoneConfig\s*\{/);
assert.match(types, /LookZoneConfig\s+zones\[LW_MAX_ZONES\]/);
assert.match(types, /bool\s+hasZoneLooks\s*=\s*false/);

assert.match(storage, /void\s+resetLookZone\(/);
assert.match(storage, /lookJson\["zones"\]\.as<JsonArray>\(\)/);
assert.match(storage, /look\.hasZoneLooks\s*=\s*look\.zoneCount\s*>\s*0/);

assert.match(main, /void\s+applyLookToRuntimeZones\(const LookConfig& look\)/);
assert.match(main, /applyLookToRuntimeZones\(look\);/);
assert.match(
  main,
  /if\s*\(!look\s*\)\s*\{[\s\S]*renderProceduralPattern\(zone\.patternId/,
  'renderZone should render compiled procedural patterns even when the selected playlist only contains combo looks',
);

console.log('playlist-combo-looks tests passed');
