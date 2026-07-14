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
  LIGHTWEAVER_INSTALL_CHIP,
  LIGHTWEAVER_INSTALL_FLASH_BYTES,
  MIN_FACTORY_IMAGE_BYTES,
  calculateMD5Hex,
  validateProductionInstallRelease,
  writeVerifiedFlash,
  replaceInstallConnection,
  validateInstallHardware,
  validateFirmwareImage,
} from '../src/lib/flashPlan.js';

assert.equal(ESP_IMAGE_MAGIC, 0xe9, 'ESP image magic byte is 0xE9');
assert.ok(MIN_FACTORY_IMAGE_BYTES >= 512 * 1024, 'factory image floor is at least 512 KB');
assert.equal(LIGHTWEAVER_INSTALL_CHIP, 'ESP32-S3');
assert.equal(LIGHTWEAVER_INSTALL_FLASH_BYTES, 16 * 1024 * 1024);
assert.equal(calculateMD5Hex(new TextEncoder().encode('')), 'd41d8cd98f00b204e9800998ecf8427e');
assert.equal(calculateMD5Hex(new TextEncoder().encode('Lightweaver')), '1369387506106e0a993fbb800f9ac101');

function factoryImage(size = MIN_FACTORY_IMAGE_BYTES) {
  const bytes = espImage(size);
  bytes[0x8000] = 0xaa;
  bytes[0x8001] = 0x50;
  bytes[0x10000] = ESP_IMAGE_MAGIC;
  return bytes;
}

await assert.rejects(
  writeVerifiedFlash({
    async writeFlash(options) {
      assert.equal(options.calculateMD5Hash(new Uint8Array()), 'd41d8cd98f00b204e9800998ecf8427e');
      throw new Error('MD5 of file does not match data in flash!');
    },
  }, { fileArray: [] }),
  /MD5 of file does not match data in flash/,
);

{
  const disconnected = [];
  const disconnect = async connection => disconnected.push(connection.id);
  let result = await replaceInstallConnection({
    previous: null,
    connect: async () => ({ id: 'first' }),
    verify: async connection => ({ card: connection.id }),
    disconnect,
  });
  assert.equal(result.connection.id, 'first');
  result = await replaceInstallConnection({
    previous: result.connection,
    connect: async () => ({ id: 'second' }),
    verify: async connection => ({ card: connection.id }),
    disconnect,
  });
  assert.equal(result.connection.id, 'second');
  assert.deepEqual(disconnected, ['first']);
  await assert.rejects(
    replaceInstallConnection({
      previous: result.connection,
      connect: async () => ({ id: 'wrong-card' }),
      verify: async () => { throw new Error('wrong chip'); },
      disconnect,
    }),
    /wrong chip/,
  );
  assert.deepEqual(disconnected, ['first', 'second', 'wrong-card']);
}

{
  const bytes = factoryImage();
  assert.equal(validateProductionInstallRelease({
    manifest: { image: { size: bytes.length }, target: 'esp32-s3-n16r8' },
    bytes,
  }).size, bytes.length);
  const badPartition = factoryImage();
  badPartition[0x8000] = 0;
  assert.throws(
    () => validateProductionInstallRelease({ manifest: { image: { size: badPartition.length }, target: 'esp32-s3-n16r8' }, bytes: badPartition }),
    /factory image.*nothing can be installed/i,
  );
  assert.throws(
    () => validateProductionInstallRelease({ manifest: { image: { size: bytes.length + 1 }, target: 'esp32-s3-n16r8' }, bytes }),
    /does not match.*nothing can be installed/i,
  );
}

assert.deepEqual(
  validateInstallHardware({ chipName: 'ESP32-S3', flashSize: '16MB' }),
  { chipName: 'ESP32-S3', flashBytes: 16 * 1024 * 1024 },
);
assert.throws(
  () => validateInstallHardware({ chipName: 'ESP32-C3', flashSize: '16MB' }),
  /not an ESP32-S3.*nothing was erased or installed/i,
);
assert.throws(
  () => validateInstallHardware({ chipName: 'ESP32-S3', flashSize: '8MB' }),
  /needs 16 MB.*nothing was erased or installed/i,
);
assert.throws(
  () => validateInstallHardware({ chipName: 'ESP32-S3', flashSize: 'unknown' }),
  /could not verify.*nothing was erased or installed/i,
);

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
