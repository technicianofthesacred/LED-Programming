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
  MAX_FACTORY_IMAGE_SIZE,
  LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM,
  MINIMUM_PRODUCTION_FIRMWARE_VERSION,
  canonicalFirmwareManifestBytes,
  loadProductionFirmwareRelease,
  validateFirmwareManifest,
} from './firmwareRelease.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const fixtureRoot = resolve(repoRoot, 'release/test-vectors');
const TEST_BUILD_ID = '0123456789abcdef0123456789abcdef01234567';

async function fixture(name, encoding = 'utf8') {
  return readFile(resolve(fixtureRoot, name), encoding);
}

function response(body, ok = true, { contentLength, chunks } = {}) {
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  let index = 0;
  const streamChunks = chunks ?? [bytes];
  return {
    ok,
    status: ok ? 200 : 404,
    async text() { return typeof body === 'string' ? body : Buffer.from(body).toString('utf8'); },
    headers: {
      get(name) {
        if (String(name).toLowerCase() !== 'content-length') return null;
        return contentLength == null ? null : String(contentLength);
      },
    },
    body: {
      getReader() {
        return {
          async read() {
            if (index >= streamChunks.length) return { done: true, value: undefined };
            return { done: false, value: new Uint8Array(streamChunks[index++]) };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
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
    provenance: manifest.provenance,
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
  assert.throws(
    () => validateFirmwareManifest({ ...manifest, image: { ...manifest.image, size: MAX_FACTORY_IMAGE_SIZE + 1 } }),
    /maximum safe factory image size/i,
  );
  const stale = {
    ...manifest,
    firmwareVersion: '0.9.9',
    image: {
      ...manifest.image,
      url: manifest.image.url.replace('/1.2.3/', '/0.9.9/'),
    },
  };
  assert.equal(MINIMUM_PRODUCTION_FIRMWARE_VERSION, '1.0.0');
  assert.throws(() => validateFirmwareManifest(stale), /older than the minimum trusted release/i);
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

test('rejects an older but cryptographically valid signed release before requesting its image', async () => {
  const base = JSON.parse(await fixture('valid-manifest.json'));
  const manifest = {
    ...base,
    firmwareVersion: '0.9.9',
    image: { ...base.image, url: base.image.url.replace('/1.2.3/', '/0.9.9/') },
  };
  const keys = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  );
  const signature = new Uint8Array(await webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    keys.privateKey,
    canonicalFirmwareManifestBytes(manifest),
  ));
  const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey));
  const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${spki.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).endsWith('release-manifest.json')) return response(JSON.stringify(manifest));
    if (String(url).endsWith('release-manifest.sig')) return response(Buffer.from(signature).toString('base64url'));
    return response(await fixture('test-firmware.bin', null));
  };
  await assert.rejects(
    loadProductionFirmwareRelease(fetchImpl, webcrypto, { publicKeyPem }),
    /older than the minimum trusted release/i,
  );
  assert.equal(calls.length, 2, 'stale signed releases must be rejected before their image is fetched');
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

test('uses Content-Length and bounded streaming instead of unbounded response buffering', async () => {
  const publicKeyPem = await fixture('test-only-release-public.pem');
  const manifest = await fixture('valid-manifest.json');
  const signature = await fixture('valid-manifest.sig');
  const image = await fixture('test-firmware.bin', null);
  const oversizedFetch = async (url) => {
    if (String(url).endsWith('release-manifest.json')) return response(manifest);
    if (String(url).endsWith('release-manifest.sig')) return response(signature);
    return response(image, true, { contentLength: MAX_FACTORY_IMAGE_SIZE + 1 });
  };
  await assert.rejects(
    loadProductionFirmwareRelease(oversizedFetch, webcrypto, { publicKeyPem }),
    /maximum safe factory image size/i,
  );

  let cancelled = false;
  const extraChunk = Buffer.alloc(MAX_FACTORY_IMAGE_SIZE + 1, 0);
  const streamingFetch = async (url) => {
    if (String(url).endsWith('release-manifest.json')) return response(manifest);
    if (String(url).endsWith('release-manifest.sig')) return response(signature);
    const streamed = response(image, true, { chunks: [extraChunk, Buffer.from('overflow')] });
    const original = streamed.body.getReader;
    streamed.body.getReader = () => {
      const reader = original();
      reader.cancel = async () => { cancelled = true; };
      return reader;
    };
    return streamed;
  };
  await assert.rejects(
    loadProductionFirmwareRelease(streamingFetch, webcrypto, { publicKeyPem }),
    /maximum safe factory image size/i,
  );
  assert.equal(cancelled, true, 'oversized streams must be cancelled immediately');
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
    '--build-id', TEST_BUILD_ID,
    '--source-revision', TEST_BUILD_ID,
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
    `/firmware/releases/1.2.3/${TEST_BUILD_ID}/lightweaver-controller-esp32s3-factory.bin`,
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
    '--build-id', TEST_BUILD_ID,
    '--source-revision', TEST_BUILD_ID,
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
  const deployWorkflow = await readFile(resolve(repoRoot, '.github/workflows/deploy-site.yml'), 'utf8');
  assert.match(workflow, /scripts\/build-firmware-manifest\.mjs/);
  assert.match(workflow, /scripts\/sign-release-artifacts\.mjs/);
  assert.match(workflow, /secrets\.LIGHTWEAVER_RELEASE_SIGNING_KEY/);
  assert.match(workflow, /release-manifest\.json/);
  assert.match(workflow, /release-manifest\.sig/);
  assert.match(workflow, /release-provenance\.json/);
  assert.match(workflow, /firmware\/releases/);
  assert.doesNotMatch(workflow, /workflow_dispatch/);
  assert.match(workflow, /environment:\s*firmware-release/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /gh workflow run deploy-site\.yml --ref main/);
  assert.doesNotMatch(workflow, /uses:\s*actions\/[^@]+@v\d/);
  assert.match(workflow, /platformio==6\.1\.19/);
  assert.match(workflow, /LW_BUILD_ID:\s*\$\{\{ github\.sha \}\}/);
  assert.ok(workflow.indexOf('  verify:') > workflow.indexOf('jobs:'));
  assert.match(workflow, /build:\s*\n\s*needs: verify/);
  const verifyJob = workflow.slice(workflow.indexOf('  verify:'), workflow.indexOf('  build:'));
  assert.doesNotMatch(verifyJob, /LIGHTWEAVER_RELEASE_SIGNING_KEY|environment:/);
  assert.match(verifyJob, /permissions:\s*\n\s*contents: read/);
  assert.match(verifyJob, /node --test src\/lib\/firmwareRelease\.test\.js/);
  assert.match(verifyJob, /pio run/);
  const signedVerification = workflow.indexOf('Verify signed release set');
  const releaseCommit = workflow.indexOf('Commit updated signed release');
  const artifactUpload = workflow.indexOf('Upload signed release set');
  assert.ok(signedVerification > 0 && signedVerification < releaseCommit);
  assert.ok(releaseCommit < artifactUpload);
  assert.match(workflow.slice(signedVerification, releaseCommit), /release-build-identity\.mjs/);
  assert.match(workflow.slice(signedVerification, releaseCommit), /firmwareRelease\.test\.js/);
  assert.match(deployWorkflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(deployWorkflow, /uses:\s*actions\/[^@]+@v\d/);
});

test('firmware dependencies are exactly pinned and provenance is signature-bound', async () => {
  const platformio = await readFile(resolve(repoRoot, 'firmware/lightweaver-controller/platformio.ini'), 'utf8');
  assert.match(platformio, /^platform = espressif32@7\.0\.1$/m);
  assert.match(platformio, /fastled\/FastLED@3\.10\.3/);
  assert.match(platformio, /bblanchon\/ArduinoJson@7\.4\.3/);
  assert.match(platformio, /links2004\/WebSockets@2\.7\.3/);
  assert.doesNotMatch(platformio, /@\^/);
  assert.match(platformio, /extra_scripts = pre:scripts\/inject-build-identity\.py/);

  const manifest = JSON.parse(await fixture('valid-manifest.json'));
  assert.equal(manifest.provenance.platformio, '6.1.19');
  assert.equal(manifest.provenance.platform, 'espressif32@7.0.1');
  assert.match(manifest.provenance.sourceRevision, /^[a-f0-9]{40}$/);
});
