// Contract: the flasher must never write a non-firmware payload to a card.
//
// Real-world failure this guards: Cloudflare Pages' SPA fallback answers a
// missing /firmware/*.bin path with index.html and HTTP 200, so a flasher that
// only checks `response.ok` would erase a working card (eraseAll) and write an
// HTML page onto it — a brick until USB reflash. validateFirmwareImage must
// reject anything that is not a plausible ESP32 image, with a plain-language
// error that makes clear nothing was written.

import assert from 'node:assert/strict';
import {
  ESP_IMAGE_MAGIC,
  MIN_FACTORY_IMAGE_BYTES,
  validateFirmwareImage,
} from '../src/lib/flashPlan.js';

assert.equal(ESP_IMAGE_MAGIC, 0xe9, 'ESP image magic byte is 0xE9');
assert.ok(MIN_FACTORY_IMAGE_BYTES >= 512 * 1024, 'factory image floor is at least 512 KB');

function espImage(size) {
  const bytes = new Uint8Array(size);
  bytes[0] = ESP_IMAGE_MAGIC;
  return bytes;
}

// A real factory-sized ESP image passes, with and without content-type.
{
  const bytes = espImage(1_099_808);
  const result = validateFirmwareImage({
    bytes,
    contentType: 'application/octet-stream',
    minBytes: MIN_FACTORY_IMAGE_BYTES,
  });
  assert.equal(result.size, 1_099_808);
  validateFirmwareImage({ bytes, minBytes: MIN_FACTORY_IMAGE_BYTES });
}

// The header check works from a 1-byte head + separate total size (the flash
// button validates File objects without reading the whole file into memory).
{
  const head = espImage(1);
  const result = validateFirmwareImage({ bytes: head, size: 1_099_808 });
  assert.equal(result.size, 1_099_808);
}

// The SPA fallback case: HTML bytes with an HTML content-type must be refused
// even though the HTTP status was 200.
{
  const html = new TextEncoder().encode('<!doctype html><html><head></head></html>');
  assert.throws(
    () => validateFirmwareImage({
      bytes: html,
      contentType: 'text/html; charset=utf-8',
      minBytes: MIN_FACTORY_IMAGE_BYTES,
    }),
    /nothing was written to your card/,
  );
}

// HTML bytes with a lying/absent content-type still fail the magic-byte check.
{
  const html = new TextEncoder().encode('<!doctype html>'.repeat(50_000));
  assert.throws(
    () => validateFirmwareImage({ bytes: html, contentType: 'application/octet-stream' }),
    /not an ESP32 firmware image/,
  );
  assert.throws(() => validateFirmwareImage({ bytes: html }), /nothing was written/);
}

// Web-page content-types are refused regardless of body bytes.
for (const contentType of ['text/html', 'text/plain', 'application/json', 'text/css', 'application/javascript']) {
  assert.throws(
    () => validateFirmwareImage({ bytes: espImage(2 * 1024 * 1024), contentType }),
    /web page instead of firmware/,
    `content-type ${contentType} must be refused`,
  );
}

// A truncated download (right magic byte, implausibly small) is refused when a
// minimum size is required.
{
  assert.throws(
    () => validateFirmwareImage({ bytes: espImage(4096), minBytes: MIN_FACTORY_IMAGE_BYTES }),
    /far smaller than real firmware/,
  );
  // ...but a small app-only image a user browsed to is fine without minBytes.
  validateFirmwareImage({ bytes: espImage(4096) });
}

// Empty or missing payloads are refused, never flashed.
assert.throws(() => validateFirmwareImage({ bytes: new Uint8Array(0) }), /empty/);
assert.throws(() => validateFirmwareImage({}), /nothing was written/);

// Every rejection reads as "nothing touched your card" — the flasher surfaces
// these messages verbatim.
for (const bad of [
  () => validateFirmwareImage({ bytes: new Uint8Array([0x3c]) }),
  () => validateFirmwareImage({ bytes: espImage(10), minBytes: MIN_FACTORY_IMAGE_BYTES }),
  () => validateFirmwareImage({ bytes: espImage(2 * 1024 * 1024), contentType: 'text/html' }),
]) {
  assert.throws(bad, /nothing was written to your card/);
}

console.log('firmware-image-validation tests passed');
