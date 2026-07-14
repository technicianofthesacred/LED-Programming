#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_FIRMWARE_TARGET,
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

function required(args, name, fallback) {
  const value = args.get(name) ?? fallback;
  if (!value) throw new Error(`Missing required --${name}`);
  return value;
}

const args = argumentsMap(process.argv.slice(2));
const imagePath = resolve(required(
  args,
  'image',
  resolve(repoRoot, 'lightweaver/public/firmware/lightweaver-controller-esp32s3-factory.bin'),
));
const publicRoot = resolve(required(args, 'public-root', resolve(repoRoot, 'lightweaver/public')));
const firmwareVersion = required(args, 'firmware-version', process.env.LW_FIRMWARE_VERSION);
const buildId = required(args, 'build-id', process.env.LW_BUILD_ID ?? process.env.GITHUB_SHA);
const configMin = Number(required(args, 'config-min', process.env.LW_CONFIG_SCHEMA_MIN ?? '1'));
const configMax = Number(required(args, 'config-max', process.env.LW_CONFIG_SCHEMA_MAX ?? String(configMin)));
const minimumInstallerVersion = required(
  args,
  'minimum-installer',
  process.env.LW_MINIMUM_INSTALLER_VERSION ?? FIRMWARE_INSTALLER_VERSION,
);

const imageBytes = await readFile(imagePath);
const imageName = 'lightweaver-controller-esp32s3-factory.bin';
const releaseDirectory = resolve(publicRoot, 'firmware/releases', firmwareVersion, buildId);
const immutableImagePath = resolve(releaseDirectory, imageName);
const imageUrl = `/firmware/releases/${firmwareVersion}/${buildId}/${imageName}`;
const manifest = {
  schemaVersion: 1,
  target: EXPECTED_FIRMWARE_TARGET,
  firmwareVersion,
  buildId,
  image: {
    url: imageUrl,
    size: imageBytes.byteLength,
    sha256: createHash('sha256').update(imageBytes).digest('hex'),
  },
  configSchema: { min: configMin, max: configMax },
  minimumInstallerVersion,
};

validateFirmwareManifest(manifest, { installerVersion: FIRMWARE_INSTALLER_VERSION });
await mkdir(releaseDirectory, { recursive: true });
let existingImage = null;
try {
  existingImage = await readFile(immutableImagePath);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
if (existingImage && !existingImage.equals(imageBytes)) {
  throw new Error(`Immutable release collision at ${immutableImagePath}`);
}
if (!existingImage) await copyFile(imagePath, immutableImagePath);

const manifestPath = resolve(publicRoot, 'firmware/release-manifest.json');
const provenancePath = resolve(publicRoot, 'firmware/release-provenance.json');
await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, Buffer.concat([
  Buffer.from(canonicalFirmwareManifestBytes(manifest)),
  Buffer.from('\n'),
]));
await writeFile(provenancePath, `${JSON.stringify({
  schemaVersion: 1,
  sourceRevision: process.env.GITHUB_SHA ?? buildId,
  workflowRun: process.env.GITHUB_RUN_ID ?? null,
  target: EXPECTED_FIRMWARE_TARGET,
  firmwareVersion,
  buildId,
  image: manifest.image,
}, null, 2)}\n`);

console.log(JSON.stringify({ manifestPath, immutableImagePath, provenancePath }));
