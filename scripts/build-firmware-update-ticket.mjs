#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_FIRMWARE_TARGET,
  LIGHTWEAVER_PARTITION_LAYOUT,
  canonicalFirmwareUpdateTicketBytes,
  validateFirmwareUpdateTicket,
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

function positiveInteger(args, name, fallback) {
  const input = String(required(args, name, fallback)).trim();
  if (!/^[1-9][0-9]*$/.test(input)) throw new Error(`--${name} must be a positive integer`);
  const value = Number(input);
  if (!Number.isSafeInteger(value)) throw new Error(`--${name} must be a safe positive integer`);
  return value;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeImmutable(path, bytes) {
  let existing = null;
  try {
    existing = await readFile(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing && !existing.equals(bytes)) throw new Error(`Immutable release collision at ${path}`);
  if (!existing) await writeFile(path, bytes);
}

const args = argumentsMap(process.argv.slice(2));
const applicationPath = resolve(required(
  args,
  'application',
  resolve(repoRoot, 'firmware/lightweaver-controller/.pio/build/esp32-s3-n16r8/firmware.bin'),
));
const factoryPath = resolve(required(
  args,
  'factory',
  resolve(repoRoot, 'lightweaver/public/firmware/lightweaver-controller-esp32s3-factory.bin'),
));
const publicRoot = resolve(required(args, 'public-root', resolve(repoRoot, 'lightweaver/public')));
const firmwareVersion = required(args, 'firmware-version', process.env.LW_FIRMWARE_VERSION);
const buildId = required(args, 'build-id', process.env.LW_BUILD_ID ?? process.env.GITHUB_SHA);
const buildNumber = positiveInteger(args, 'build-number', process.env.LW_BUILD_NUMBER);
const firmwareApiMin = positiveInteger(args, 'firmware-api-min', process.env.LW_FIRMWARE_API_MIN ?? '2');
const firmwareApiMax = positiveInteger(args, 'firmware-api-max', process.env.LW_FIRMWARE_API_MAX ?? String(firmwareApiMin));
const projectSchemaMin = positiveInteger(args, 'project-schema-min', process.env.LW_PROJECT_SCHEMA_MIN ?? '3');
const projectSchemaMax = positiveInteger(args, 'project-schema-max', process.env.LW_PROJECT_SCHEMA_MAX ?? String(projectSchemaMin));
const minimumUpdaterVersion = positiveInteger(args, 'minimum-updater-version', process.env.LW_MINIMUM_UPDATER_VERSION ?? '1');
const minimumBootstrapBuild = positiveInteger(args, 'minimum-bootstrap-build', process.env.LW_MINIMUM_BOOTSTRAP_BUILD ?? '1198');

const [applicationBytes, factoryBytes] = await Promise.all([
  readFile(applicationPath),
  readFile(factoryPath),
]);
if (applicationBytes.byteLength < 1 || applicationBytes.byteLength > LIGHTWEAVER_PARTITION_LAYOUT.slotSize) {
  throw new Error('Application image must fit one OTA application slot');
}
if (applicationBytes[0] !== 0xe9) throw new Error('Application image is not an ESP32 application image');
const applicationEnd = LIGHTWEAVER_PARTITION_LAYOUT.app0Offset + applicationBytes.byteLength;
if (factoryBytes.byteLength < applicationEnd) {
  throw new Error('Factory image does not contain the exact app0 payload');
}
const embeddedApplication = factoryBytes.subarray(LIGHTWEAVER_PARTITION_LAYOUT.app0Offset, applicationEnd);
if (!embeddedApplication.equals(applicationBytes)) {
  throw new Error('Application image is not the exact app0 payload inside the factory image');
}
const partitionEnd = LIGHTWEAVER_PARTITION_LAYOUT.tableOffset + LIGHTWEAVER_PARTITION_LAYOUT.tableSize;
if (factoryBytes.byteLength < partitionEnd) {
  throw new Error('Factory image does not contain the full raw partition-table range');
}
const rawPartitionTable = factoryBytes.subarray(LIGHTWEAVER_PARTITION_LAYOUT.tableOffset, partitionEnd);

const applicationName = 'lightweaver-controller-esp32s3-app.bin';
const ticketName = 'firmware-update-ticket.json';
const releaseDirectory = resolve(publicRoot, 'firmware/releases', firmwareVersion, buildId);
const immutableApplicationPath = resolve(releaseDirectory, applicationName);
const ticketPath = resolve(releaseDirectory, ticketName);
const ticket = {
  schemaVersion: 1,
  firmwareVersion,
  buildId,
  buildNumber,
  target: EXPECTED_FIRMWARE_TARGET,
  image: {
    url: `/firmware/releases/${firmwareVersion}/${buildId}/${applicationName}`,
    size: applicationBytes.byteLength,
    sha256: sha256(applicationBytes),
  },
  partition: {
    layout: LIGHTWEAVER_PARTITION_LAYOUT.layout,
    tableSha256: sha256(rawPartitionTable),
    app0Offset: LIGHTWEAVER_PARTITION_LAYOUT.app0Offset,
    app1Offset: LIGHTWEAVER_PARTITION_LAYOUT.app1Offset,
    slotSize: LIGHTWEAVER_PARTITION_LAYOUT.slotSize,
  },
  compatibility: {
    firmwareApiMin,
    firmwareApiMax,
    projectSchemaMin,
    projectSchemaMax,
    minimumUpdaterVersion,
    minimumBootstrapBuild,
  },
  preservation: { dataPartitionsIncluded: false },
};
validateFirmwareUpdateTicket(ticket);
const ticketBytes = Buffer.from(canonicalFirmwareUpdateTicketBytes(ticket));

await mkdir(releaseDirectory, { recursive: true });
await writeImmutable(immutableApplicationPath, applicationBytes);
await writeImmutable(ticketPath, ticketBytes);

console.log(JSON.stringify({ immutableApplicationPath, ticketPath }));
