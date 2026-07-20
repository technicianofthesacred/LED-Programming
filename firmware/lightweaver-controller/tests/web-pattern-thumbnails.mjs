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
const patternsSource = fs.readFileSync(path.join(srcDir, 'LightweaverPatterns.cpp'), 'utf8');

// Factory cards deliberately carry no project playlist. Thumbnail coverage is
// exercised against an explicit valid configured playlist instead.
const defaultsStart = storageSource.indexOf('void applyDefaultRuntimeConfig(');
assert.ok(defaultsStart >= 0, 'LightweaverStorage.cpp should define applyDefaultRuntimeConfig');
const defaultsRegion = storageSource.slice(defaultsStart);
assert.match(defaultsRegion, /config\.lookCount\s*=\s*0/,
  'factory defaults must not claim a configured project playlist');
const configuredLookIds = [
  'aurora', 'plasma', 'fire', 'ocean', 'ripple', 'lava',
  'rainbow', 'sparkle', 'twinkle', 'meteor', 'chase', 'scanner',
  'breathe', 'candle', 'ember', 'lightning', 'neon', 'matrix',
  'heartbeat', 'stained', 'confetti', 'warp', 'pulse-ring', 'blocks',
  'bloom', 'calm', 'drift', 'wave', 'sunset', 'warm-white',
];
assert.equal(new Set(configuredLookIds).size, configuredLookIds.length,
  'configured fixture ids must be unique');
for (const id of configuredLookIds) {
  assert.ok(patternsSource.includes(`patternId == "${id}"`),
    `configured fixture pattern ${id} must be supported by firmware`);
}

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
  configuredLookIds.filter(id => !region.includes(`.sw-${id}{`));

assert.deepEqual(
  missingSwatchIds(rootRegion),
  [],
  'customer page (handleRoot) is missing .sw-<id> preview rules for configured looks',
);
assert.deepEqual(
  missingSwatchIds(advancedRegion),
  [],
  'advanced page (handleAdvancedRoot) is missing .sw-<id> preview rules for configured looks',
);

const patternsHandler = webSource.slice(
  webSource.indexOf('void handlePatterns() {'),
  webSource.indexOf('void handleCaptiveProbe()', webSource.indexOf('void handlePatterns() {')),
);
assert.match(patternsHandler, /cfg\.lookCount \? cfg\.looks\[\*currentLookIndexPtr\]\.id : ""/,
  'a zero-look factory card must report no current project pattern');
assert.match(patternsHandler, /for \(uint8_t i = 0; i < cfg\.lookCount; i\+\+\)/,
  'pattern API must serialize only explicitly configured looks');

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
