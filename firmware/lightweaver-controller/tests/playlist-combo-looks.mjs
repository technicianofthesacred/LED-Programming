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

assert.match(main, /bool\s+isLoadedLookRenderable\(const LookConfig& look, bool zoneTargeted\)/);
const resolverStart = main.indexOf('bool isLoadedLookRenderable(const LookConfig& look, bool zoneTargeted) {');
const resolverEnd = main.indexOf('\n}', resolverStart);
const resolver = main.slice(resolverStart, resolverEnd);
assert.match(resolver, /look\.mode\s*==\s*"combo"/, 'combo must be an explicit supported loaded-look mode');
assert.match(resolver, /if\s*\(zoneTargeted\)\s*return false;/, 'zone-targeted combo requests must reject');
assert.match(resolver, /isSupportedCompiledPattern\(look\.zones\[i\]\.patternId\)/, 'every combo zone must resolve to a compiled renderer');
assert.match(resolver, /look\.mode\s*==\s*"procedural"/);
assert.match(resolver, /isSupportedProceduralPattern\(look\.preset\)/, 'procedural looks require a procedural preset');
assert.match(resolver, /look\.mode\s*==\s*"preset"/);
assert.match(resolver, /isSupportedPresetPattern\(look\.preset\)/, 'preset looks require a preset renderer');
assert.match(resolver, /look\.mode\s*==\s*"sequence"/);
assert.match(resolver, /canOpenSequence\(look\.file\)/, 'sequence looks must prove their file is readable before selection');
assert.match(resolver, /return false;/, 'unsupported loaded-look modes must reject');
assert.match(main, /uint64_t\s+requiredBytes\s*=\s*uint64_t\(LWSEQ_HEADER_BYTES\)\s*\+\s*uint64_t\(frameCount\)\s*\*\s*frameBytes/);
assert.match(main, /requiredBytes\s*>\s*file\.size\(\)/, 'sequence preflight must prove all declared frames exist, not only the header');

assert.match(main, /bool\s+selectLookInstant\(int index\)/, 'instant loaded-look selection must report apply success');
assert.match(main, /return\s+selectLookInstant\(i\)/, 'global acknowledgement must derive from loaded-look apply success');
const startLookStart = main.indexOf('bool startLook(uint8_t index) {');
const startLookEnd = main.indexOf('\n}', startLookStart);
const startLook = main.slice(startLookStart, startLookEnd);
assert.ok(
  startLook.indexOf('openSequence(look.file)') < startLook.indexOf('applyLookToRuntimeZones(look)'),
  'sequence open must succeed before any runtime-zone mutation',
);

console.log('playlist-combo-looks tests passed');
