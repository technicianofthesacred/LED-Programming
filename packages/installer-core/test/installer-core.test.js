import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';

import {
  ESP_CONNECT_RESET_SEQUENCE,
  ESP_IMAGE_MAGIC,
  EXPECTED_FIRMWARE_TARGET,
  LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM,
  MAX_FACTORY_IMAGE_SIZE,
  MIN_FACTORY_IMAGE_BYTES,
  PRODUCTION_FIRMWARE_ORIGIN,
  calculateMD5Hex,
  canonicalFirmwareManifestBytes,
  connectEspWithResetSequence,
  flashFirmwareAndRelease,
  loadProductionFirmwareRelease,
  replaceInstallConnection,
  resetEspIntoApp,
  validateProductionInstallRelease,
} from '../src/index.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(repoRoot, 'release/test-vectors');

async function fixture(name, encoding = 'utf8') {
  return readFile(resolve(fixtureRoot, name), encoding);
}

function response(body, ok = true, { chunks, contentLength, redirected = false, stream = true } = {}) {
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  const streamChunks = chunks ?? [bytes];
  let index = 0;
  return {
    ok,
    redirected,
    async text() { return typeof body === 'string' ? body : bytes.toString('utf8'); },
    headers: { get: name => String(name).toLowerCase() === 'content-length' && contentLength != null ? String(contentLength) : null },
    body: stream ? {
      getReader() {
        return {
          async read() {
            if (index >= streamChunks.length) return { done: true };
            return { done: false, value: new Uint8Array(streamChunks[index++]) };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    } : null,
  };
}

async function signManifest(manifest) {
  const keys = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  );
  const signature = new Uint8Array(await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.privateKey,
    canonicalFirmwareManifestBytes(manifest),
  ));
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey));
  return {
    publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${spki.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`,
    signature: Buffer.from(signature).toString('base64url'),
  };
}

async function releaseFetch({ manifest, signature, imageResponse, calls = [] }) {
  return async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('release-manifest.json')) return response(JSON.stringify(manifest));
    if (String(url).endsWith('release-manifest.sig')) return response(signature);
    return imageResponse;
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

  await loadProductionFirmwareRelease(fetchImpl, webcrypto, { publicKeyPem, runtime: 'node' });

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
      { manifestUrl: 'https://evil.example/release-manifest.json', runtime: 'node' },
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
    runtime: 'node',
  });
  assert.ok(calls.every(url => url.startsWith(PRODUCTION_FIRMWARE_ORIGIN)));
});

test('browser/default consumers retain same-origin relative request behavior', async () => {
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
  }, webcrypto, { publicKeyPem });
  assert.deepEqual(calls, [
    '/firmware/release-manifest.json',
    '/firmware/release-manifest.sig',
    JSON.parse(manifest).image.url,
  ]);
});

test('explicit Node runtime wins in a hybrid environment with window present', async () => {
  const manifest = await fixture('valid-manifest.json');
  const signature = await fixture('valid-manifest.sig');
  const image = await fixture('test-firmware.bin', null);
  const publicKeyPem = await fixture('test-only-release-public.pem');
  const calls = [];
  globalThis.window = { location: { origin: 'https://evil.example' } };
  try {
    await loadProductionFirmwareRelease(async url => {
      calls.push(String(url));
      if (String(url).endsWith('release-manifest.json')) return response(manifest);
      if (String(url).endsWith('release-manifest.sig')) return response(signature);
      return response(image);
    }, webcrypto, { publicKeyPem, runtime: 'node' });
  } finally {
    delete globalThis.window;
  }
  assert.ok(calls.every(url => url.startsWith(PRODUCTION_FIRMWARE_ORIGIN)));
});

test('all release requests fail closed on redirects', async () => {
  const manifest = JSON.parse(await fixture('valid-manifest.json'));
  const signature = await fixture('valid-manifest.sig');
  const image = await fixture('test-firmware.bin', null);
  const publicKeyPem = await fixture('test-only-release-public.pem');
  const calls = [];
  await loadProductionFirmwareRelease(async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('release-manifest.json')) return response(JSON.stringify(manifest));
    if (String(url).endsWith('release-manifest.sig')) return response(signature);
    return response(image);
  }, webcrypto, { publicKeyPem, runtime: 'node' });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.options.redirect === 'error'));

  await assert.rejects(
    loadProductionFirmwareRelease(async () => response('redirected', true, { redirected: true }), webcrypto),
    /redirect/i,
  );
});

test('signed manifests reject wrong targets and declared oversize before image fetch', async () => {
  const base = JSON.parse(await fixture('valid-manifest.json'));
  for (const manifest of [
    { ...base, target: 'esp32-c3' },
    { ...base, image: { ...base.image, size: MAX_FACTORY_IMAGE_SIZE + 1 } },
  ]) {
    const signed = await signManifest(manifest);
    let imageFetched = false;
    await assert.rejects(loadProductionFirmwareRelease(async url => {
      if (String(url).endsWith('release-manifest.json')) return response(JSON.stringify(manifest));
      if (String(url).endsWith('release-manifest.sig')) return response(signed.signature);
      imageFetched = true;
      return response(new Uint8Array());
    }, webcrypto, { publicKeyPem: signed.publicKeyPem }), /target|maximum safe factory image size/i);
    assert.equal(imageFetched, false);
  }
});

test('bounded image loading rejects streamed oversize, truncation, missing streams, and digest mismatch', async () => {
  const manifest = JSON.parse(await fixture('valid-manifest.json'));
  const signature = await fixture('valid-manifest.sig');
  const image = Buffer.from(await fixture('test-firmware.bin', null));
  const publicKeyPem = await fixture('test-only-release-public.pem');
  const cases = [
    { response: response(image, true, { chunks: [Buffer.alloc(MAX_FACTORY_IMAGE_SIZE + 1)] }), error: /maximum safe factory image size/i },
    { response: response(image.subarray(0, -1)), error: /size mismatch/i },
    { response: response(image, true, { stream: false }), error: /bounded stream/i },
    { response: response(Buffer.from(image).fill(0, 1, 2)), error: /SHA-256 mismatch/i },
  ];
  for (const item of cases) {
    const fetchImpl = await releaseFetch({ manifest, signature, imageResponse: item.response });
    await assert.rejects(
      loadProductionFirmwareRelease(fetchImpl, webcrypto, { publicKeyPem }),
      item.error,
    );
  }
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
    manifest: { target: EXPECTED_FIRMWARE_TARGET, image: { size: bytes.length } },
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

  let cleanupAttempts = 0;
  await assert.rejects(flashFirmwareAndRelease({
    loader: {}, transport: {}, file: {}, address: 0, eraseAll: true,
    flashFirmware: async () => {},
    resetESP: async () => { throw new Error('reset failed'); },
    disconnectESP: async () => { cleanupAttempts += 1; throw new Error('release failed'); },
  }), /release failed/);
  assert.equal(cleanupAttempts, 1);
});

test('ESP32-S3 app restart uses the watchdog without toggling USB boot control lines', async () => {
  const calls = [];
  await resetEspIntoApp({
    async setDTR(value) { calls.push(`dtr:${value}`); },
    async setRTS(value) { calls.push(`rts:${value}`); },
  }, {
    chip: { CHIP_NAME: 'ESP32-S3' },
    async writeReg(address, value) { calls.push([address, value]); },
  });

  assert.deepEqual(calls, [
    'dtr:false',
    [0x600080b0, 0x50d83aa1],
    [0x6000809c, 2000],
    [0x60008098, 0xd0000102],
    [0x600080b0, 0],
  ]);
});

test('canonicalization and pinned key are exposed from the package entrypoint', async () => {
  const manifest = JSON.parse(await fixture('valid-manifest.json'));
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  assert.deepEqual(canonicalFirmwareManifestBytes(reordered), canonicalFirmwareManifestBytes(manifest));
  const pinned = await readFile(resolve(repoRoot, 'release/keys/lightweaver-release-public.pem'), 'utf8');
  assert.equal(`${LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM.trim()}\n`, pinned);
});
