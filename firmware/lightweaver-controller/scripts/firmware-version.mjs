#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { verify as verifySignature } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
  }
  return value;
}

function gitFileAtSourceParent(sourceRevision, path, cwd) {
  return execFileSync('git', ['show', `${sourceRevision}^:${path}`], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

export function previousSignedVersionFromSource(sourceRevision, cwd = process.cwd()) {
  if (!/^[0-9a-f]{40}$/.test(String(sourceRevision))) {
    throw new Error('Previous source lookup requires an exact 40-character revision');
  }
  const manifest = JSON.parse(gitFileAtSourceParent(
    sourceRevision,
    'lightweaver/public/firmware/release-manifest.json',
    cwd,
  ));
  const signatureText = gitFileAtSourceParent(
    sourceRevision,
    'lightweaver/public/firmware/release-manifest.sig',
    cwd,
  ).trim();
  const publicKey = gitFileAtSourceParent(
    sourceRevision,
    'release/keys/lightweaver-release-public.pem',
    cwd,
  );
  if (!/^[A-Za-z0-9_-]{86}$/.test(signatureText)) {
    throw new Error('Previous firmware manifest signature is malformed');
  }
  const signatureValid = verifySignature(
    'sha256',
    Buffer.from(JSON.stringify(canonicalJson(manifest))),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signatureText, 'base64url'),
  );
  if (!signatureValid) throw new Error('Previous firmware manifest signature verification failed');
  const previous = manifest.firmwareVersion;
  parseVersion(previous);
  return previous;
}

function readVersion(versionPath) {
  const raw = readFileSync(versionPath, 'utf8');
  const version = raw.endsWith('\r\n') ? raw.slice(0, -2) : raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  parseVersion(version);
  return version;
}

export function main(argv, {
  cwd = process.cwd(),
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

  if (command === 'check' && argument === '--previous-source' && previous !== undefined && extra.length === 0) {
    const trustedPrevious = previousSignedVersionFromSource(previous, cwd);
    if (compareVersions(current, trustedPrevious) <= 0) {
      throw new Error(`Firmware version ${current} must be greater than previous signed version ${trustedPrevious}`);
    }
    write(`${current}\n`);
    return current;
  }

  throw new Error('Usage: firmware-version.mjs bump <patch|minor|major> | check --previous <version> | check --previous-source <revision>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
