#!/usr/bin/env node
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIRMWARE_INSTALLER_VERSION,
  canonicalFirmwareUpdateTicketBytes,
  canonicalFirmwareManifestBytes,
  validateFirmwareUpdateTicket,
  validateFirmwareManifest,
} from '../packages/installer-core/src/firmware-release.js';

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
const kind = args.get('kind') ?? 'manifest';
if (kind !== 'manifest' && kind !== 'ticket' && kind !== 'all') {
  throw new Error('--kind must be manifest, ticket, or all');
}
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

async function writeSignature(bytes, path) {
  const signature = sign(
    'sha256',
    bytes,
    { key: privateKey, dsaEncoding: 'ieee-p1363' },
  );
  if (signature.byteLength !== 64) throw new Error('Release signer produced an invalid P-256 signature');
  await writeFile(path, `${signature.toString('base64url')}\n`, { mode: 0o644 });
}

const output = {};
if (kind === 'manifest' || kind === 'all') {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateFirmwareManifest(manifest, { installerVersion: FIRMWARE_INSTALLER_VERSION });
  await writeSignature(Buffer.from(canonicalFirmwareManifestBytes(manifest)), signaturePath);
  Object.assign(output, { manifestPath, signaturePath });
}
if (kind === 'ticket' || kind === 'all') {
  const ticketPath = resolve(args.get('ticket') ?? resolve(
    repoRoot,
    'lightweaver/public/firmware/firmware-update-ticket.json',
  ));
  const ticketSignaturePath = resolve(args.get('ticket-signature') ?? resolve(
    repoRoot,
    'lightweaver/public/firmware/firmware-update-ticket.sig',
  ));
  const ticketBytes = await readFile(ticketPath);
  let ticket;
  try {
    ticket = JSON.parse(ticketBytes.toString('utf8'));
  } catch {
    throw new Error('Firmware update ticket is not valid JSON');
  }
  validateFirmwareUpdateTicket(ticket);
  const canonicalBytes = Buffer.from(canonicalFirmwareUpdateTicketBytes(ticket));
  if (!ticketBytes.equals(canonicalBytes)) {
    throw new Error('Firmware update ticket bytes are not canonical');
  }
  await writeSignature(ticketBytes, ticketSignaturePath);
  Object.assign(output, { ticketPath, ticketSignaturePath });
}
console.log(JSON.stringify(output));
