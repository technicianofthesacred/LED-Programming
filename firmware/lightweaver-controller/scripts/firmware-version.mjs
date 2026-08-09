#!/usr/bin/env node

import { verify as verifySignature } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  canonicalFirmwareManifestBytes,
  LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM,
} from '../../../packages/installer-core/src/firmware-release.js';

const STRICT_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const canonicalVersionPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'VERSION');

export function parseVersion(value) {
  const match = STRICT_SEMVER.exec(String(value));
  if (!match) throw new Error(`Expected a strict semantic version (major.minor.patch), received: ${value}`);
  const parts = match.slice(1).map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) {
    throw new Error(`Expected a strict semantic version with safe integer components, received: ${value}`);
  }
  return parts;
}

export function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

export function bumpVersion(version, level) {
  const parts = parseVersion(version);
  if (!['patch', 'minor', 'major'].includes(level)) {
    throw new Error('Firmware bump level must be patch, minor, or major');
  }
  const index = { major: 0, minor: 1, patch: 2 }[level];
  parts[index] += 1;
  for (let reset = index + 1; reset < parts.length; reset += 1) parts[reset] = 0;
  if (!Number.isSafeInteger(parts[index])) throw new Error('Firmware version component exceeds the safe integer range');
  return parts.join('.');
}

async function fetchProductionReleaseText(fetchImpl, url, label) {
  if (typeof fetchImpl !== 'function') throw new Error('Production firmware release fetch is unavailable');
  const response = await fetchImpl(url, {
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  });
  if (!response?.ok || response.status !== 200) {
    throw new Error(`Production firmware release ${label} returned HTTP ${response?.status ?? 'unknown'}`);
  }
  return response.text();
}

export async function checkPreviousProduction({
  fetchImpl = globalThis.fetch,
  publicKeyPem = LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM,
  versionPath = canonicalVersionPath,
  write = value => process.stdout.write(value),
} = {}) {
  const [manifestText, signatureBody] = await Promise.all([
    fetchProductionReleaseText(
      fetchImpl,
      'https://led.mandalacodes.com/firmware/release-manifest.json',
      'manifest',
    ),
    fetchProductionReleaseText(
      fetchImpl,
      'https://led.mandalacodes.com/firmware/release-manifest.sig',
      'signature',
    ),
  ]);
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error('Production firmware release manifest is not valid JSON');
  }
  const signatureText = signatureBody.trim();
  if (!/^[A-Za-z0-9_-]{86}$/.test(signatureText)) {
    throw new Error('Production firmware release signature is malformed');
  }
  const signatureValid = verifySignature(
    'sha256',
    canonicalFirmwareManifestBytes(manifest),
    { key: publicKeyPem, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signatureText, 'base64url'),
  );
  if (!signatureValid) throw new Error('Production firmware release signature verification failed');
  const previous = manifest.firmwareVersion;
  parseVersion(previous);
  const current = readVersion(versionPath);
  if (compareVersions(current, previous) <= 0) {
    throw new Error(`Firmware version ${current} must be greater than previous signed version ${previous}`);
  }
  write(`${current}\n`);
  return current;
}

function readVersion(versionPath) {
  const raw = readFileSync(versionPath, 'utf8');
  const version = raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  parseVersion(version);
  return version;
}

export function main(argv, {
  versionPath = canonicalVersionPath,
  write = value => process.stdout.write(value),
} = {}) {
  const [command, argument, previous, ...extra] = argv;
  const current = readVersion(versionPath);

  if (command === 'bump' && ['patch', 'minor', 'major'].includes(argument) && previous === undefined) {
    const next = bumpVersion(current, argument);
    writeFileSync(versionPath, `${next}\n`);
    write(`${next}\n`);
    return next;
  }

  if (command === 'check' && argument === '--previous' && previous !== undefined && extra.length === 0) {
    parseVersion(previous);
    if (compareVersions(current, previous) <= 0) {
      throw new Error(`Firmware version ${current} must be greater than previous signed version ${previous}`);
    }
    write(`${current}\n`);
    return current;
  }

  throw new Error('Usage: firmware-version.mjs bump <patch|minor|major> | check --previous <version> | check --previous-production');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length === 4 && process.argv[2] === 'check' && process.argv[3] === '--previous-production') {
      await checkPreviousProduction();
    } else {
      main(process.argv.slice(2));
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
