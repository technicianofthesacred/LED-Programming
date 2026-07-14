#!/usr/bin/env node
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIRMWARE_INSTALLER_VERSION,
  canonicalFirmwareManifestBytes,
  validateFirmwareManifest,
} from '../lightweaver/src/lib/firmwareRelease.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function argumentsMap(values) {
  const result = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith('--') || value == null) throw new Error(`Missing value for ${key || 'argument'}`);
    result.set(key.slice(2), value);
  }
  return result;
}

function normalizePem(value) {
  return String(value).trim().replace(/\r\n/g, '\n');
}

const privateKeyPem = process.env.LIGHTWEAVER_RELEASE_SIGNING_KEY;
if (!privateKeyPem?.trim()) {
  throw new Error('LIGHTWEAVER_RELEASE_SIGNING_KEY is required; unsigned releases are forbidden');
}

const args = argumentsMap(process.argv.slice(2));
const manifestPath = resolve(args.get('manifest') ?? resolve(
  repoRoot,
  'lightweaver/public/firmware/release-manifest.json',
));
const signaturePath = resolve(args.get('signature') ?? resolve(
  repoRoot,
  'lightweaver/public/firmware/release-manifest.sig',
));
const publicKeyPath = resolve(args.get('public-key') ?? resolve(
  repoRoot,
  'release/keys/lightweaver-release-public.pem',
));

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
validateFirmwareManifest(manifest, { installerVersion: FIRMWARE_INSTALLER_VERSION });

let privateKey;
try {
  privateKey = createPrivateKey(privateKeyPem);
} catch {
  throw new Error('LIGHTWEAVER_RELEASE_SIGNING_KEY is not a valid private key');
}
if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
  throw new Error('LIGHTWEAVER_RELEASE_SIGNING_KEY must be an ECDSA P-256 key');
}

const expectedPublicKey = normalizePem(await readFile(publicKeyPath, 'utf8'));
const derivedPublicKey = normalizePem(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }));
if (derivedPublicKey !== expectedPublicKey) {
  throw new Error('LIGHTWEAVER_RELEASE_SIGNING_KEY does not match the pinned public key');
}

const signature = sign(
  'sha256',
  Buffer.from(canonicalFirmwareManifestBytes(manifest)),
  { key: privateKey, dsaEncoding: 'ieee-p1363' },
);
if (signature.byteLength !== 64) throw new Error('Release signer produced an invalid P-256 signature');
await writeFile(signaturePath, `${signature.toString('base64url')}\n`, { mode: 0o644 });
console.log(JSON.stringify({ manifestPath, signaturePath }));
