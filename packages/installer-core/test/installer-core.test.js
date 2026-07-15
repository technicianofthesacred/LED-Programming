import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';

import {
  ESP_CONNECT_RESET_SEQUENCE,
  ESP_IMAGE_MAGIC,
  LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM,
  MIN_FACTORY_IMAGE_BYTES,
  PRODUCTION_FIRMWARE_ORIGIN,
  calculateMD5Hex,
  canonicalFirmwareManifestBytes,
  connectEspWithResetSequence,
  flashFirmwareAndRelease,
  loadProductionFirmwareRelease,
  replaceInstallConnection,
  validateProductionInstallRelease,
} from '../src/index.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(repoRoot, 'release/test-vectors');

async function fixture(name, encoding = 'utf8') {
  return readFile(resolve(fixtureRoot, name), encoding);
}

function response(body, ok = true) {
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  let consumed = false;
  return {
    ok,
    async text() { return typeof body === 'string' ? body : bytes.toString('utf8'); },
    headers: { get: () => null },
    body: {
      getReader() {
        return {
          async read() {
            if (consumed) return { done: true };
            consumed = true;
            return { done: false, value: new Uint8Array(bytes) };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  };
}

test('Node resolves every production release request against the compiled production origin', async () => {
  const manifest = await fixture('valid-manifest.json');
  const signature = await fixture('valid-manifest.sig');
  const image = await fixture('test-firmware.bin', null);
  const publicKeyPem = await fixture('test-only-release-public.pem');
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).endsWith('release-manifest.json')) return response(manifest);
    if (String(url).endsWith('release-manifest.sig')) return response(signature);
    return response(image);
  };

  await loadProductionFirmwareRelease(fetchImpl, webcrypto, { publicKeyPem });

  assert.equal(PRODUCTION_FIRMWARE_ORIGIN, 'https://led.mandalacodes.com');
  assert.deepEqual(calls, [
    `${PRODUCTION_FIRMWARE_ORIGIN}/firmware/release-manifest.json`,
    `${PRODUCTION_FIRMWARE_ORIGIN}/firmware/release-manifest.sig`,
    `${PRODUCTION_FIRMWARE_ORIGIN}${JSON.parse(manifest).image.url}`,
  ]);
});

test('caller-controlled absolute manifest origins are rejected before network access', async () => {
  let fetched = false;
  await assert.rejects(
    loadProductionFirmwareRelease(
      async () => { fetched = true; return response('unreachable'); },
      webcrypto,
      { manifestUrl: 'https://evil.example/release-manifest.json' },
    ),
    /production origin|relative production path/i,
  );
  assert.equal(fetched, false);
});

test('caller origin hints cannot replace the compiled production origin', async () => {
  const manifest = await fixture('valid-manifest.json');
  const signature = await fixture('valid-manifest.sig');
  const image = await fixture('test-firmware.bin', null);
  const publicKeyPem = await fixture('test-only-release-public.pem');
  const calls = [];
  await loadProductionFirmwareRelease(async url => {
    calls.push(String(url));
    if (String(url).endsWith('release-manifest.json')) return response(manifest);
    if (String(url).endsWith('release-manifest.sig')) return response(signature);
    return response(image);
  }, webcrypto, {
    publicKeyPem,
    productionOrigin: 'https://evil.example',
  });
  assert.ok(calls.every(url => url.startsWith(PRODUCTION_FIRMWARE_ORIGIN)));
});

test('browser consumers retain same-origin relative request behavior', async () => {
  const manifest = await fixture('valid-manifest.json');
  const signature = await fixture('valid-manifest.sig');
  const image = await fixture('test-firmware.bin', null);
  const publicKeyPem = await fixture('test-only-release-public.pem');
  const calls = [];
  globalThis.window = { location: { origin: 'https://preview.example' } };
  try {
    await loadProductionFirmwareRelease(async url => {
      calls.push(String(url));
      if (String(url).endsWith('release-manifest.json')) return response(manifest);
      if (String(url).endsWith('release-manifest.sig')) return response(signature);
      return response(image);
    }, webcrypto, { publicKeyPem });
  } finally {
    delete globalThis.window;
  }
  assert.deepEqual(calls, [
    '/firmware/release-manifest.json',
    '/firmware/release-manifest.sig',
    JSON.parse(manifest).image.url,
  ]);
});

test('tampered manifests are rejected before image or erase-adjacent work', async () => {
  const manifest = await fixture('tampered-manifest.json');
  const signature = await fixture('valid-manifest.sig');
  const publicKeyPem = await fixture('test-only-release-public.pem');
  const calls = [];
  let eraseAdjacentCalls = 0;
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).endsWith('release-manifest.json')) return response(manifest);
    if (String(url).endsWith('release-manifest.sig')) return response(signature);
    eraseAdjacentCalls += 1;
    return response(await fixture('test-firmware.bin', null));
  };

  await assert.rejects(
    loadProductionFirmwareRelease(fetchImpl, webcrypto, { publicKeyPem }),
    /signature/i,
  );
  assert.equal(calls.length, 2);
  assert.equal(eraseAdjacentCalls, 0);
});

test('shared core preserves image, MD5, reset retry, connection, and release safety', async () => {
  assert.equal(calculateMD5Hex(new Uint8Array()), 'd41d8cd98f00b204e9800998ecf8427e');
  const bytes = new Uint8Array(MIN_FACTORY_IMAGE_BYTES);
  bytes[0] = ESP_IMAGE_MAGIC;
  bytes[0x8000] = 0xaa;
  bytes[0x8001] = 0x50;
  bytes[0x10000] = ESP_IMAGE_MAGIC;
  assert.equal(validateProductionInstallRelease({
    manifest: { target: 'esp32-s3-n16r8', image: { size: bytes.length } },
    bytes,
  }).size, bytes.length);

  const attempts = [];
  const disconnected = [];
  const connected = await connectEspWithResetSequence({
    port: {},
    createTransport: (_port, attempt) => ({ disconnect: async () => disconnected.push(attempt.mode) }),
    createLoader: ({ transport }) => ({
      transport,
      main: async mode => {
        attempts.push(mode);
        if (mode !== ESP_CONNECT_RESET_SEQUENCE.at(-1)) throw new Error('retry');
        return 'ESP32-S3';
      },
    }),
  });
  assert.deepEqual(attempts, ESP_CONNECT_RESET_SEQUENCE);
  assert.deepEqual(disconnected, ESP_CONNECT_RESET_SEQUENCE.slice(0, -1));
  assert.equal(connected.chip, 'ESP32-S3');

  const replaced = [];
  await assert.rejects(replaceInstallConnection({
    previous: { id: 'old' },
    connect: async () => ({ id: 'bad' }),
    verify: async () => { throw new Error('wrong chip'); },
    disconnect: async connection => replaced.push(connection.id),
  }), /wrong chip/);
  assert.deepEqual(replaced, ['old', 'bad']);

  let released = 0;
  await assert.rejects(flashFirmwareAndRelease({
    loader: {},
    transport: {},
    file: {},
    address: 0,
    eraseAll: true,
    flashFirmware: async () => { throw new Error('write failed'); },
    disconnectESP: async () => { released += 1; },
  }), /write failed/);
  assert.equal(released, 1);
});

test('canonicalization and pinned key are exposed from the package entrypoint', async () => {
  const manifest = JSON.parse(await fixture('valid-manifest.json'));
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  assert.deepEqual(canonicalFirmwareManifestBytes(reordered), canonicalFirmwareManifestBytes(manifest));
  const pinned = await readFile(resolve(repoRoot, 'release/keys/lightweaver-release-public.pem'), 'utf8');
  assert.equal(`${LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM.trim()}\n`, pinned);
});
