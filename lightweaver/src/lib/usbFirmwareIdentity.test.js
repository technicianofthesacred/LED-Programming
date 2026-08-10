import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  LIGHTWEAVER_APP_PARTITION_OFFSET,
  LIGHTWEAVER_APP_PARTITION_SIZE,
  USB_FIRMWARE_READ_CHUNK_SIZE,
  parseLightweaverFirmwareIdentity,
  readLightweaverFirmwareIdentity,
} from './usbFirmwareIdentity.js';

const releases = [
  {
    version: '1.1.1',
    buildId: '1366faf23a29a815044bae2e50405ff14b424e42',
    buildNumber: 1198,
    path: '../../public/firmware/releases/1.1.1/1366faf23a29a815044bae2e50405ff14b424e42/lightweaver-controller-esp32s3-factory.bin',
  },
  {
    version: '1.1.3',
    buildId: 'c80ba832eebe0b681112753b32d24001d01bf56f',
    buildNumber: 1223,
    path: '../../public/firmware/releases/1.1.3/c80ba832eebe0b681112753b32d24001d01bf56f/lightweaver-controller-esp32s3-factory.bin',
  },
];

for (const release of releases) {
  test(`parses the strict identity envelope from the signed ${release.version} image`, async () => {
    const image = new Uint8Array(await readFile(new URL(release.path, import.meta.url)));
    const expected = {
      firmwareVersion: release.version,
      buildId: release.buildId,
      buildNumber: release.buildNumber,
      source: 'usb-flash',
    };
    assert.deepEqual(parseLightweaverFirmwareIdentity(image), expected);
    assert.deepEqual(await readLightweaverFirmwareIdentity({
      async readFlash(address, size) {
        const result = new Uint8Array(size).fill(0xff);
        result.set(image.subarray(address, Math.min(image.length, address + size)));
        return result;
      },
    }), expected);
  });
}

test('rejects an arbitrary binary that only contains version and build strings', () => {
  const bytes = new TextEncoder().encode(`noise${'\0'}1.1.3${'\0'}${'a'.repeat(40)}${'\0'}noise`);
  assert.equal(parseLightweaverFirmwareIdentity(bytes), null);
});

test('chunked reader stays inside the app partition and finds an envelope across chunks', async () => {
  const prefix = 'lw-%012llx\0';
  const identity = `1.1.3\0${'c'.repeat(40)}\0`;
  const suffix = 'provisioningContractVersion';
  const envelope = new TextEncoder().encode(prefix + identity + suffix);
  const start = USB_FIRMWARE_READ_CHUNK_SIZE - 20;
  const virtual = new Uint8Array(USB_FIRMWARE_READ_CHUNK_SIZE * 2).fill(0xff);
  virtual.set(envelope, start);
  const calls = [];
  const loader = {
    async readFlash(address, size) {
      calls.push({ address, size });
      const relative = address - LIGHTWEAVER_APP_PARTITION_OFFSET;
      return virtual.slice(relative, relative + size);
    },
  };
  assert.deepEqual(await readLightweaverFirmwareIdentity(loader), {
    firmwareVersion: '1.1.3', buildId: 'c'.repeat(40), source: 'usb-flash',
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    address: LIGHTWEAVER_APP_PARTITION_OFFSET,
    size: USB_FIRMWARE_READ_CHUNK_SIZE,
  });
  assert.ok(calls.every(({ address, size }) => address >= LIGHTWEAVER_APP_PARTITION_OFFSET
    && address + size <= LIGHTWEAVER_APP_PARTITION_OFFSET + LIGHTWEAVER_APP_PARTITION_SIZE));
});

test('read failure and erased app flash return null without leaving the app partition', async () => {
  const failedCalls = [];
  assert.equal(await readLightweaverFirmwareIdentity({
    async readFlash(address, size) {
      failedCalls.push({ address, size });
      throw new Error('serial read stopped');
    },
  }), null);
  assert.deepEqual(failedCalls, [{
    address: LIGHTWEAVER_APP_PARTITION_OFFSET,
    size: USB_FIRMWARE_READ_CHUNK_SIZE,
  }]);

  let erasedCalls = 0;
  assert.equal(await readLightweaverFirmwareIdentity({
    async readFlash() {
      erasedCalls += 1;
      return new Uint8Array(USB_FIRMWARE_READ_CHUNK_SIZE).fill(0xff);
    },
  }), null);
  assert.equal(erasedCalls, 1, 'an erased app stops without reading the full partition');
});
