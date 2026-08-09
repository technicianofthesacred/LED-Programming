import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../src');
const studioHeaderPath = resolve(root, 'LightweaverCardStudio.h');
const studioSourcePath = resolve(root, 'LightweaverCardStudio.cpp');
assert.ok(existsSync(studioHeaderPath) && existsSync(studioSourcePath),
  'embedded card Studio firmware server must exist');
const header = readFileSync(studioHeaderPath, 'utf8');
const source = readFileSync(studioSourcePath, 'utf8');
const bundlePath = resolve(root, 'LightweaverCardStudioBundle.h');
const bundle = existsSync(bundlePath) ? readFileSync(bundlePath, 'utf8') : source;
const web = readFileSync(resolve(root, 'LightweaverWeb.cpp'), 'utf8');

assert.match(bundle, /struct LightweaverCardStudioAsset/);
for (const field of ['path', 'contentType', 'contentEncoding', 'bytes', 'compressedSize', 'uncompressedSize', 'compressedSha256', 'immutable']) {
  assert.match(bundle, new RegExp(`\\b${field}\\b`), `generated bundle table includes ${field}`);
}
assert.match(bundle, /LW_CARD_STUDIO_ASSETS\[\]/);
assert.match(source, /LW_CARD_STUDIO_ASSETS/);
for (const constant of [
  'LW_CARD_STUDIO_BUILD_ID', 'LW_CARD_STUDIO_BUILD_NUMBER',
  'LW_CARD_STUDIO_PROJECT_SCHEMA_MIN', 'LW_CARD_STUDIO_PROJECT_SCHEMA_MAX',
  'LW_CARD_STUDIO_FIRMWARE_API_MIN', 'LW_CARD_STUDIO_FIRMWARE_API_MAX',
  'LW_CARD_STUDIO_TOTAL_SIZE', 'LW_CARD_STUDIO_BUNDLE_SHA256',
  'LW_CARD_STUDIO_ASSET_COUNT',
]) assert.match(source, new RegExp(constant), `server consumes ${constant}`);
assert.match(source, /\/studio\//);
assert.match(source, /Content-Encoding/);
assert.match(source, /immutable/);
assert.match(source, /max-age=31536000/);
assert.match(source, /no-store|no-cache/);
assert.match(source, /build/i);
assert.match(source, /schema/i);
assert.match(source, /api/i);
assert.match(source, /sha256/i);
assert.match(source, /mutationsEnabled/,
  'bundle validation gates project/stream mutations');
assert.match(source, /fallback|recovery/i,
  'invalid bundle deliberately falls through to the existing small recovery page');
assert.match(web, /registerLightweaverCardStudio/);
assert.match(web, /handleRoot/, 'the legacy bridge/recovery root remains present');
assert.doesNotMatch(web, /server\.onNotFound\(registerLightweaverCardStudio/,
  'card Studio does not replace the card recovery not-found behavior wholesale');

console.log('windowless card Studio tests passed');
