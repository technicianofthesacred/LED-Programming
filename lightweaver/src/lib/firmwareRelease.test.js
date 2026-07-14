import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

import {
  EXPECTED_FIRMWARE_TARGET,
  LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM,
  canonicalFirmwareManifestBytes,
  loadProductionFirmwareRelease,
  validateFirmwareManifest,
} from './firmwareRelease.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(repoRoot, 'release/test-vectors');

async function fixture(name, encoding = 'utf8') {
  return readFile(resolve(fixtureRoot, name), encoding);
}

function response(body, ok = true) {
  return {
    ok,
    status: ok ? 200 : 404,
    async text() { return typeof body === 'string' ? body : Buffer.from(body).toString('utf8'); },
    async arrayBuffer() {
      const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

async function createFixtureFetch(manifestName = 'valid-manifest.json', imageOverride) {
  const manifest = await fixture(manifestName);
  const signature = await fixture('valid-manifest.sig');
  const image = imageOverride ?? await fixture('test-firmware.bin', null);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('release-manifest.json')) return response(manifest);
    if (String(url).endsWith('release-manifest.sig')) return response(signature);
    if (String(url).includes('/firmware/releases/')) return response(image);
    return response('missing', false);
  };
  return { fetchImpl, calls };
}

test('canonical manifest bytes are stable across object key order', async () => {
  const manifest = JSON.parse(await fixture('valid-manifest.json'));
  const reordered = {
    image: { sha256: manifest.image.sha256, url: manifest.image.url, size: manifest.image.size },
    buildId: manifest.buildId,
    target: manifest.target,
    minimumInstallerVersion: manifest.minimumInstallerVersion,
    firmwareVersion: manifest.firmwareVersion,
    schemaVersion: manifest.schemaVersion,
    configSchema: { max: manifest.configSchema.max, min: manifest.configSchema.min },
  };
  assert.deepEqual(canonicalFirmwareManifestBytes(reordered), canonicalFirmwareManifestBytes(manifest));
});

test('validates the exact supported target, immutable URL, and installer floor', async () => {
  const manifest = JSON.parse(await fixture('valid-manifest.json'));
  assert.equal(validateFirmwareManifest(manifest, { installerVersion: '1.4.0' }).target, EXPECTED_FIRMWARE_TARGET);
  assert.throws(
    () => validateFirmwareManifest({ ...manifest, target: 'esp32' }, { installerVersion: '1.4.0' }),
    /target/i,
  );
  assert.throws(
    () => validateFirmwareManifest({ ...manifest, image: { ...manifest.image, url: '/firmware/latest.bin' } }, { installerVersion: '1.4.0' }),
    /immutable/i,
  );
  assert.throws(
    () => validateFirmwareManifest(manifest, { installerVersion: '1.3.9' }),
    /installer/i,
  );
});

test('verifies a fixed signed manifest before fetching and hashing its image', async () => {
  const { fetchImpl, calls } = await createFixtureFetch();
  const publicKeyPem = await fixture('test-only-release-public.pem');
  const release = await loadProductionFirmwareRelease(fetchImpl, webcrypto, {
    publicKeyPem,
    installerVersion: '1.4.0',
    manifestUrl: '/firmware/release-manifest.json',
    signatureUrl: '/firmware/release-manifest.sig',
  });

  assert.equal(release.manifest.firmwareVersion, '1.2.3');
  assert.equal(release.bytes.byteLength, release.manifest.image.size);
  assert.equal(calls.at(-1), release.manifest.image.url);
});

test('rejects a tampered manifest before requesting any image', async () => {
  const { fetchImpl, calls } = await createFixtureFetch('tampered-manifest.json');
  const publicKeyPem = await fixture('test-only-release-public.pem');
  await assert.rejects(
    loadProductionFirmwareRelease(fetchImpl, webcrypto, {
      publicKeyPem,
      installerVersion: '1.4.0',
      manifestUrl: '/firmware/release-manifest.json',
      signatureUrl: '/firmware/release-manifest.sig',
    }),
    /signature/i,
  );
  assert.equal(calls.length, 2, 'unverified manifests must never cause an image request');
});

test('rejects an image with the wrong size or SHA-256 after signature verification', async () => {
  const publicKeyPem = await fixture('test-only-release-public.pem');
  const { fetchImpl: wrongSizeFetch } = await createFixtureFetch('valid-manifest.json', Buffer.from('short'));
  await assert.rejects(
    loadProductionFirmwareRelease(wrongSizeFetch, webcrypto, { publicKeyPem, installerVersion: '1.4.0' }),
    /size/i,
  );

  const original = Buffer.from(await fixture('test-firmware.bin', null));
  original[0] ^= 0xff;
  const { fetchImpl: wrongHashFetch } = await createFixtureFetch('valid-manifest.json', original);
  await assert.rejects(
    loadProductionFirmwareRelease(wrongHashFetch, webcrypto, { publicKeyPem, installerVersion: '1.4.0' }),
    /SHA-256/i,
  );
});

test('fails closed when manifest, signature, or WebCrypto support is unavailable', async () => {
  const publicKeyPem = await fixture('test-only-release-public.pem');
  await assert.rejects(
    loadProductionFirmwareRelease(async () => response('missing', false), webcrypto, { publicKeyPem }),
    /manifest/i,
  );
  const { fetchImpl } = await createFixtureFetch();
  await assert.rejects(
    loadProductionFirmwareRelease(fetchImpl, null, { publicKeyPem }),
    /cryptographic verification/i,
  );
});

test('pins the same production public key in source and the release key file', async () => {
  const pem = await readFile(resolve(repoRoot, 'release/keys/lightweaver-release-public.pem'), 'utf8');
  assert.equal(`${LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM.trim()}\n`, pem);
});

test('manifest builder creates a versioned immutable image and canonical manifest', async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), 'lightweaver-release-'));
  const publicRoot = resolve(scratch, 'public');
  const imagePath = resolve(scratch, 'factory.bin');
  await mkdir(publicRoot, { recursive: true });
  await writeFile(imagePath, await fixture('test-firmware.bin', null));
  const result = spawnSync(process.execPath, [
    resolve(repoRoot, 'scripts/build-firmware-manifest.mjs'),
    '--image', imagePath,
    '--public-root', publicRoot,
    '--firmware-version', '1.2.3',
    '--build-id', 'test-build',
    '--config-min', '1',
    '--config-max', '2',
    '--minimum-installer', '1.4.0',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const manifestPath = resolve(publicRoot, 'firmware/release-manifest.json');
  const manifestText = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.equal(
    manifest.image.url,
    '/firmware/releases/1.2.3/test-build/lightweaver-controller-esp32s3-factory.bin',
  );
  assert.equal(manifestText, `${new TextDecoder().decode(canonicalFirmwareManifestBytes(manifest))}\n`);
  assert.deepEqual(
    await readFile(resolve(publicRoot, manifest.image.url.slice(1))),
    await fixture('test-firmware.bin', null),
  );

  await writeFile(imagePath, Buffer.from('different firmware bytes'));
  const collision = spawnSync(process.execPath, [
    resolve(repoRoot, 'scripts/build-firmware-manifest.mjs'),
    '--image', imagePath,
    '--public-root', publicRoot,
    '--firmware-version', '1.2.3',
    '--build-id', 'test-build',
    '--config-min', '1',
    '--config-max', '2',
    '--minimum-installer', '1.4.0',
  ], { encoding: 'utf8' });
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /immutable release collision/i);
});

test('signing script fails closed without the protected key and signs with a test-only fixture', async () => {
  const scratch = await mkdtemp(resolve(tmpdir(), 'lightweaver-sign-'));
  const manifestPath = resolve(scratch, 'release-manifest.json');
  const signaturePath = resolve(scratch, 'release-manifest.sig');
  const publicKeyPath = resolve(scratch, 'ephemeral-test-public.pem');
  await writeFile(manifestPath, await fixture('valid-manifest.json'));
  const testKey = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  await writeFile(publicKeyPath, testKey.publicKey);
  const args = [
    resolve(repoRoot, 'scripts/sign-release-artifacts.mjs'),
    '--manifest', manifestPath,
    '--signature', signaturePath,
    '--public-key', publicKeyPath,
  ];
  const missing = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, LIGHTWEAVER_RELEASE_SIGNING_KEY: '' },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /LIGHTWEAVER_RELEASE_SIGNING_KEY/);

  const signed = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, LIGHTWEAVER_RELEASE_SIGNING_KEY: testKey.privateKey },
  });
  assert.equal(signed.status, 0, signed.stderr);
  const signature = (await readFile(signaturePath, 'utf8')).trim();
  assert.match(signature, /^[A-Za-z0-9_-]{86}$/);
});

test('committed production release is signed and content-addressed by the pinned key', async () => {
  const firmwareRoot = resolve(repoRoot, 'lightweaver/public/firmware');
  const manifest = await readFile(resolve(firmwareRoot, 'release-manifest.json'));
  const parsed = JSON.parse(manifest);
  const signature = await readFile(resolve(firmwareRoot, 'release-manifest.sig'));
  const image = await readFile(resolve(repoRoot, 'lightweaver/public', parsed.image.url.slice(1)));
  const fetchImpl = async (url) => {
    if (String(url).endsWith('release-manifest.json')) return response(manifest);
    if (String(url).endsWith('release-manifest.sig')) return response(signature);
    if (url === parsed.image.url) return response(image);
    return response('missing', false);
  };
  const release = await loadProductionFirmwareRelease(fetchImpl, webcrypto);
  assert.equal(release.bytes.byteLength, parsed.image.size);
});

test('firmware workflow builds, signs, commits, and uploads one release set', async () => {
  const workflow = await readFile(resolve(repoRoot, '.github/workflows/build-firmware.yml'), 'utf8');
  assert.match(workflow, /scripts\/build-firmware-manifest\.mjs/);
  assert.match(workflow, /scripts\/sign-release-artifacts\.mjs/);
  assert.match(workflow, /secrets\.LIGHTWEAVER_RELEASE_SIGNING_KEY/);
  assert.match(workflow, /release-manifest\.json/);
  assert.match(workflow, /release-manifest\.sig/);
  assert.match(workflow, /release-provenance\.json/);
  assert.match(workflow, /firmware\/releases/);
});
