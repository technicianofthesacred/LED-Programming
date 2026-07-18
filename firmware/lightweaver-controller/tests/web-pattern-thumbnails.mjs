import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Guards the pattern-thumbnail contract on both card-served pages:
// every factory look id must have a `.sw-<id>{` preview rule on the customer
// page (handleRoot) AND the advanced page (handleAdvancedRoot), so no factory
// pattern renders as a flat gray fallback tile. Also guards the advanced
// page's selection contract: rollback-on-failure with Retry, and a
// streaming-disabled grid naming the external source.

const srcDir = path.resolve(import.meta.dirname, '../src');
const webSource = fs.readFileSync(path.join(srcDir, 'LightweaverWeb.cpp'), 'utf8');
const storageSource = fs.readFileSync(path.join(srcDir, 'LightweaverStorage.cpp'), 'utf8');

// --- Factory look ids: parsed from applyDefaultRuntimeConfig (single source
// --- of truth — no hardcoded id list in this test).
const defaultsStart = storageSource.indexOf('void applyDefaultRuntimeConfig(');
assert.ok(defaultsStart >= 0, 'LightweaverStorage.cpp should define applyDefaultRuntimeConfig');
const defaultsRegion = storageSource.slice(defaultsStart);
const idsArrayMatch = defaultsRegion.match(/const char\* ids\[\]\s*=\s*\{([\s\S]*?)\};/);
assert.ok(idsArrayMatch, 'applyDefaultRuntimeConfig should declare the factory ids[] array');
const factoryIds = [...idsArrayMatch[1].matchAll(/"([a-z0-9-]+)"/g)].map(m => m[1]);
assert.ok(
  factoryIds.length >= 30,
  `expected at least 30 factory look ids, parsed ${factoryIds.length}`,
);
assert.equal(new Set(factoryIds).size, factoryIds.length, 'factory ids must be unique');

// --- Slice LightweaverWeb.cpp into the two page-serving regions.
// Match definitions ("() {"), not the forward declarations near the top.
const rootStart = webSource.indexOf('void handleRoot() {');
const advancedStart = webSource.indexOf('void handleAdvancedRoot() {');
const advancedEnd = webSource.indexOf('void handleStatus() {');
assert.ok(rootStart >= 0, 'handleRoot() not found');
assert.ok(advancedStart > rootStart, 'handleAdvancedRoot() should follow handleRoot()');
assert.ok(advancedEnd > advancedStart, 'handleStatus() should follow handleAdvancedRoot()');
const rootRegion = webSource.slice(rootStart, advancedStart);
const advancedRegion = webSource.slice(advancedStart, advancedEnd);

// --- Every factory id must have a swatch rule on BOTH pages.
const missingSwatchIds = (region) =>
  factoryIds.filter(id => !region.includes(`.sw-${id}{`));

assert.deepEqual(
  missingSwatchIds(rootRegion),
  [],
  'customer page (handleRoot) is missing .sw-<id> preview rules for these factory looks',
);
assert.deepEqual(
  missingSwatchIds(advancedRegion),
  [],
  'advanced page (handleAdvancedRoot) is missing .sw-<id> preview rules for these factory looks',
);

// The customer page's custom-color tile keeps its class rule (the live hue is
// layered on top via the swatchHtml inline-style special case).
assert.ok(
  rootRegion.includes('.sw-custom-color{'),
  'customer page should keep a .sw-custom-color rule',
);
assert.match(
  rootRegion,
  /id==='custom-color'.*hueToHsl\(customHue,customSat\)/,
  'swatchHtml should keep the custom-color inline-style special case',
);

// Unknown pattern ids must still render a visible tile: the base .sw fallback
// (customer page) and the .swatch fallback (advanced page) must survive.
assert.ok(
  /"\.sw\{[^}]*background/.test(rootRegion),
  'customer page should keep the base .sw{...} fallback rule with a background',
);
assert.ok(
  /\.pat-btn \.swatch\{[^}]*background/.test(advancedRegion),
  'advanced page should keep the .pat-btn .swatch{...} fallback rule with a background',
);

// --- Existing helper/API assertions (thumbnail data plumbing).
assert.match(
  webSource,
  /JsonArray zones = p\["zones"\]\.to<JsonArray>\(\);/,
  'handlePatterns should expose look zones so compound looks can render thumbnails',
);

assert.match(
  webSource,
  /z\["patternId"\] = cfg\.looks\[i\]\.zones\[zoneIndex\]\.patternId;/,
  'pattern API zone payload should include each section pattern id',
);

assert.match(
  webSource,
  /const swatchHtml=p=>/,
  'card UI should render swatches through a shared thumbnail helper',
);

assert.match(
  webSource,
  /combo-sw/,
  'compound looks should render a multi-section thumbnail instead of a blank swatch',
);

assert.match(
  webSource,
  /sceneControl=makeConfirmedControl\(\{[^\n]*render:value=>\{currentId=value;renderPat\(\)/,
  'confirmed and rolled-back scene values should redraw through the thumbnail-aware renderer',
);

// --- Advanced-page selection hardening (rollback + streaming lock).
assert.match(
  advancedRegion,
  /catch\(e\)\{if\(req!==active\)return;failed=id;currentId=confirmed;/,
  'advanced pattern grid must roll the highlighted tile back to the confirmed pattern on a failed POST',
);
assert.ok(
  advancedRegion.includes("patError('Could not change pattern."),
  'advanced page must surface a visible error message when a pattern POST fails',
);
assert.ok(
  advancedRegion.includes("id='pat-retry'") && advancedRegion.includes("$('pat-retry').onclick=()=>patternControl.retry()"),
  'advanced page must offer a Retry affordance wired to the pattern control',
);
assert.ok(
  advancedRegion.includes("patternControl.setConfirmed(p.currentId||'')"),
  'advanced page load must seed the confirmed pattern through the control (not raw assignment)',
);
assert.match(
  advancedRegion,
  /b\.disabled=patPending\|\|patStreaming/,
  'advanced grid buttons must be disabled while a request is pending or a stream is active',
);
assert.ok(
  advancedRegion.includes('Streaming from <b id=') &&
    advancedRegion.includes("srcLabel=k=>k==='artnet'?'Madrix / Art-Net':k==='wled-realtime'?'designer live preview':'external source'"),
  "advanced page must show a 'Streaming from <source>' explanation using the customer page's source labels",
);
assert.ok(
  advancedRegion.includes('cancelStream:true'),
  'advanced page streaming note should offer the cancel-stream action',
);
assert.match(
  advancedRegion,
  /const pollStream=async\(\)=>\{try\{const s=await get\('\/api\/status'\);applyStream\(s\)/,
  'advanced page must poll /api/status to track streaming state',
);

console.log('web-pattern-thumbnails tests passed');
