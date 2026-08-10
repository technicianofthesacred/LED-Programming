#!/usr/bin/env node
import { createHash, verify } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_FIRMWARE_TARGET,
  FIRMWARE_INSTALLER_VERSION,
  LIGHTWEAVER_PARTITION_LAYOUT,
  assertFirmwareManifestCardStudio,
  assertFirmwareManifestBuildNumber,
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
const cardStudioReleasePath = resolve(required(
  args,
  'card-studio-release',
  resolve(repoRoot, 'lightweaver/card-dist/card-studio-release.json'),
));
const publicRoot = resolve(required(args, 'public-root', resolve(repoRoot, 'lightweaver/public')));
const publicKeyPath = resolve(required(
  args,
  'public-key',
  resolve(repoRoot, 'release/keys/lightweaver-release-public.pem'),
));
const firmwareVersion = required(args, 'firmware-version', process.env.LW_FIRMWARE_VERSION);
const buildId = required(args, 'build-id', process.env.LW_BUILD_ID ?? process.env.GITHUB_SHA);
// The comparable release identity. It must be the SAME value that was compiled
// into the binary as LW_BUILD_NUMBER, or a card and this manifest would report
// different numbers for the same release.
const buildNumberInput = String(required(args, 'build-number', process.env.LW_BUILD_NUMBER)).trim();
if (!/^[1-9][0-9]*$/.test(buildNumberInput)) {
  throw new Error('--build-number must be a positive integer (commit count of the build ID)');
}
const buildNumber = Number(buildNumberInput);
const configMin = Number(required(args, 'config-min', process.env.LW_CONFIG_SCHEMA_MIN ?? '1'));
const configMax = Number(required(args, 'config-max', process.env.LW_CONFIG_SCHEMA_MAX ?? String(configMin)));
const minimumInstallerVersion = required(
  args,
  'minimum-installer',
  process.env.LW_MINIMUM_INSTALLER_VERSION ?? FIRMWARE_INSTALLER_VERSION,
);
const sourceRevision = required(args, 'source-revision', process.env.GITHUB_SHA ?? buildId);
if (sourceRevision !== buildId) throw new Error('source revision must exactly match build ID');

const releaseDirectory = resolve(publicRoot, 'firmware/releases', firmwareVersion, buildId);
const updateApplicationPath = resolve(required(
  args,
  'update-application',
  resolve(releaseDirectory, 'lightweaver-controller-esp32s3-app.bin'),
));
const updateTicketPath = resolve(required(
  args,
  'update-ticket',
  resolve(releaseDirectory, 'firmware-update-ticket.json'),
));
const updateSignaturePath = resolve(required(
  args,
  'update-signature',
  resolve(releaseDirectory, 'firmware-update-ticket.sig'),
));

const [imageBytes, cardStudioReleaseBytes] = await Promise.all([
  readFile(imagePath),
  readFile(cardStudioReleasePath),
]);
const explicitUpdate = ['update-application', 'update-ticket', 'update-signature']
  .some(name => args.has(name));
let updateApplicationBytes;
let updateTicketBytes;
let updateSignatureBytes;
let publicKeyBytes;
try {
  [updateApplicationBytes, updateTicketBytes, updateSignatureBytes, publicKeyBytes] = await Promise.all([
    readFile(updateApplicationPath),
    readFile(updateTicketPath),
    readFile(updateSignaturePath),
    readFile(publicKeyPath),
  ]);
} catch (error) {
  if (explicitUpdate || error?.code !== 'ENOENT') throw error;
}
const hasUpdate = updateApplicationBytes !== undefined;
const cardStudioRelease = JSON.parse(cardStudioReleaseBytes.toString('utf8'));
if (cardStudioRelease.buildId !== buildId || cardStudioRelease.buildNumber !== buildNumber) {
  throw new Error('Card Studio release identity must exactly match the compiled firmware identity');
}
if (!Array.isArray(cardStudioRelease.assets) || cardStudioRelease.assets.length === 0) {
  throw new Error('Card Studio release must contain compressed asset identities');
}
let updateTicket;
if (hasUpdate) {
  try {
    updateTicket = JSON.parse(updateTicketBytes.toString('utf8'));
  } catch {
    throw new Error('Firmware update ticket is not valid JSON');
  }
  validateFirmwareUpdateTicket(updateTicket);
  if (!updateTicketBytes.equals(Buffer.from(canonicalFirmwareUpdateTicketBytes(updateTicket)))) {
    throw new Error('Firmware update ticket bytes are not canonical');
  }
  if (updateTicket.firmwareVersion !== firmwareVersion
    || updateTicket.buildId !== buildId
    || updateTicket.buildNumber !== buildNumber
    || updateTicket.target !== EXPECTED_FIRMWARE_TARGET) {
    throw new Error('Firmware update ticket identity must exactly match the factory release identity');
  }
  if (updateTicket.compatibility.firmwareApiMin !== cardStudioRelease.firmwareApi.min
    || updateTicket.compatibility.firmwareApiMax !== cardStudioRelease.firmwareApi.max
    || updateTicket.compatibility.projectSchemaMin !== cardStudioRelease.projectSchema.min
    || updateTicket.compatibility.projectSchemaMax !== cardStudioRelease.projectSchema.max) {
    throw new Error('Firmware update ticket compatibility must exactly match the card Studio release');
  }
  if (updateTicket.image.size !== updateApplicationBytes.byteLength
    || updateTicket.image.sha256 !== createHash('sha256').update(updateApplicationBytes).digest('hex')) {
    throw new Error('Firmware update ticket image descriptor does not match the application bytes');
  }
  const applicationEnd = LIGHTWEAVER_PARTITION_LAYOUT.app0Offset + updateApplicationBytes.byteLength;
  if (imageBytes.byteLength < applicationEnd
    || !imageBytes.subarray(LIGHTWEAVER_PARTITION_LAYOUT.app0Offset, applicationEnd).equals(updateApplicationBytes)) {
    throw new Error('Factory image app0 payload does not match the signed application update');
  }
  const signatureText = updateSignatureBytes.toString('utf8');
  if (!/^[A-Za-z0-9_-]{86}\n$/.test(signatureText)) {
    throw new Error('Firmware update ticket signature must be 64-byte P-256 base64url plus newline');
  }
  const ticketSignature = Buffer.from(signatureText.trim(), 'base64url');
  if (!verify(
    'sha256',
    updateTicketBytes,
    { key: publicKeyBytes, dsaEncoding: 'ieee-p1363' },
    ticketSignature,
  )) {
    throw new Error('Firmware update ticket signature verification failed');
  }
}
const imageSha256 = createHash('sha256').update(imageBytes).digest('hex');
const imageName = 'lightweaver-controller-esp32s3-factory.bin';
const immutableImagePath = resolve(releaseDirectory, imageName);
const imageUrl = `/firmware/releases/${firmwareVersion}/${buildId}/${imageName}`;
const manifest = {
  schemaVersion: hasUpdate ? 2 : 1,
  target: EXPECTED_FIRMWARE_TARGET,
  firmwareVersion,
  buildId,
  buildNumber,
  image: {
    url: imageUrl,
    size: imageBytes.byteLength,
    sha256: imageSha256,
    cardStudioReadback: { offset: 0, size: imageBytes.byteLength, sha256: imageSha256 },
  },
  ...(hasUpdate ? { update: {
    image: updateTicket.image,
    ticket: {
      url: `/firmware/releases/${firmwareVersion}/${buildId}/firmware-update-ticket.json`,
      size: updateTicketBytes.byteLength,
      sha256: createHash('sha256').update(updateTicketBytes).digest('hex'),
    },
    signature: {
      url: `/firmware/releases/${firmwareVersion}/${buildId}/firmware-update-ticket.sig`,
      size: updateSignatureBytes.byteLength,
      sha256: createHash('sha256').update(updateSignatureBytes).digest('hex'),
    },
  } } : {}),
  cardStudio: {
    buildId: cardStudioRelease.buildId,
    buildNumber: cardStudioRelease.buildNumber,
    projectSchema: cardStudioRelease.projectSchema,
    firmwareApi: cardStudioRelease.firmwareApi,
    totalSize: cardStudioRelease.totalSize,
    bundleSha256: cardStudioRelease.bundleSha256,
    releaseMetadata: {
      size: cardStudioReleaseBytes.byteLength,
      sha256: createHash('sha256').update(cardStudioReleaseBytes).digest('hex'),
    },
    assets: cardStudioRelease.assets.map(asset => ({
      path: asset.route,
      size: asset.brotli.size,
      sha256: asset.brotli.sha256,
    })),
  },
  configSchema: { min: configMin, max: configMax },
  minimumInstallerVersion,
  provenance: {
    sourceRevision,
    platformio: '6.1.19',
    platform: 'espressif32@7.0.1',
    framework: 'framework-arduinoespressif32@3.20017.241212+sha.dcc1105b',
    libraries: {
      FastLED: '3.10.3',
      ArduinoJson: '7.4.3',
      WebSockets: '2.7.3',
    },
  },
};

validateFirmwareManifest(manifest, { installerVersion: FIRMWARE_INSTALLER_VERSION });
assertFirmwareManifestBuildNumber(manifest);
assertFirmwareManifestCardStudio(manifest);
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
  schemaVersion: hasUpdate ? 2 : 1,
  sourceRevision,
  workflowRun: process.env.GITHUB_RUN_ID ?? null,
  target: EXPECTED_FIRMWARE_TARGET,
  firmwareVersion,
  buildId,
  buildNumber,
  image: manifest.image,
  ...(hasUpdate ? { update: {
    image: manifest.update.image,
    ticket: manifest.update.ticket,
    signature: manifest.update.signature,
    partition: updateTicket.partition,
  } } : {}),
  cardStudio: manifest.cardStudio,
  toolchain: manifest.provenance,
}, null, 2)}\n`);

console.log(JSON.stringify({ manifestPath, immutableImagePath, provenancePath }));
