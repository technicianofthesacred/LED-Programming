import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const storage = readFileSync(resolve(here, '../src/LightweaverStorage.cpp'), 'utf8');
const web = readFileSync(resolve(here, '../src/LightweaverWeb.cpp'), 'utf8');
const runtime = readFileSync(resolve(here, '../src/main.cpp'), 'utf8');
const api = readFileSync(resolve(here, '../src/LightweaverRuntimeApi.h'), 'utf8');

for (const field of ['breatheLowerPct', 'breatheUpperPct', 'breatheCycleSeconds']) {
  assert.match(storage, new RegExp(`zone\\.${field} = constrain`), `${field} must load into runtime zones`);
  assert.match(runtime, new RegExp(`obj\\["${field}"\\] = z\\.${field}`), `${field} must round-trip through /api/zones`);
  assert.match(web, new RegExp(`hasControlField\\(doc, "${field}"\\)`), `${field} must be accepted by /api/control`);
  assert.match(storage, new RegExp(`!lookZone\\["${field}"\\]\\.isNull\\(\\) && !lookZone\\["${field}"\\]\\.is<int>\\(\\)`), `${field} must reject malformed saved-look values before range checks`);
}

assert.match(web, /bool parseControlIntStrict\(JsonDocument& doc, const char\* key, int& value\)/,
  'URL/form integer controls need the same strict parsing as JSON integers');
assert.match(web, /for \(size_t index = 0; index < raw\.length\(\); index\+\+\).*raw\[index\] < '0'.*raw\[index\] > '9'/s,
  'URL/form integers must reject whitespace, signs, decimals, suffixes, and other non-digits');
for (const field of ['breatheLowerPct', 'breatheUpperPct', 'breatheCycleSeconds']) {
  assert.match(web, new RegExp(`parseControlIntStrict\\(doc, "${field}", requestedBreathe`),
    `${field} must reject malformed alternate control encodings before mutation`);
}

assert.match(web, /requestedBreatheUpper < requestedBreatheLower/);
assert.match(web, /requestedBreatheCycle < 4 \|\| requestedBreatheCycle > 30/);
assert.match(web, /server\.send\(422, "application\/json", "\{\\"ok\\":false,\\"error\\":\\"invalid breathe settings\\"\}"\)/);
assert.match(api, /bool runtimeGetCustomBreatheZ\(const String& targetId\);/);
assert.match(runtime, /bool runtimeGetCustomBreatheZ\(const String& targetId\)/);
assert.match(web, /out\["breathe"\] = runtimeGetCustomBreatheZ\(zoneTarget\);/,
  'targeted API acknowledgements must report the addressed zone breathe state');
assert.doesNotMatch(web, /out\["breathe"\] = runtimeGetCustomBreathe\(\);/);

console.log('breathe-config-contract tests passed');
