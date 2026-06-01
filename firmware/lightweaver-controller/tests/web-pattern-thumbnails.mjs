import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const sourcePath = path.resolve(import.meta.dirname, '../src/LightweaverWeb.cpp');
const source = fs.readFileSync(sourcePath, 'utf8');

assert.match(
  source,
  /JsonArray zones = p\["zones"\]\.to<JsonArray>\(\);/,
  'handlePatterns should expose look zones so compound looks can render thumbnails',
);

assert.match(
  source,
  /z\["patternId"\] = cfg\.looks\[i\]\.zones\[zoneIndex\]\.patternId;/,
  'pattern API zone payload should include each section pattern id',
);

assert.match(
  source,
  /const swatchHtml=p=>/,
  'card UI should render swatches through a shared thumbnail helper',
);

assert.match(
  source,
  /combo-sw/,
  'compound looks should render a multi-section thumbnail instead of a blank swatch',
);

console.log('web-pattern-thumbnails tests passed');
