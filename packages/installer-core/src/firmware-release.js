import { EXPECTED_FIRMWARE_TARGET } from './constants.js';

export { EXPECTED_FIRMWARE_TARGET } from './constants.js';
export const FIRMWARE_INSTALLER_VERSION = '1.4.0';
// Bump this only after a release is known unsafe to replay. It is installer
// policy applied after signature verification, so an older valid signature
// cannot silently downgrade a card through the normal installer.
export const MINIMUM_PRODUCTION_FIRMWARE_VERSION = '1.0.0';
// default_16MB.csv starts ota_1 at 0x650000. A merged factory image must end
// before that boundary or flashing it could overwrite the rollback slot.
export const MAX_FACTORY_IMAGE_SIZE = 0x650000;
export const PRODUCTION_FIRMWARE_ORIGIN = 'https://led.mandalacodes.com';
export const PRODUCTION_MANIFEST_URL = '/firmware/release-manifest.json';
export const PRODUCTION_SIGNATURE_URL = '/firmware/release-manifest.sig';
export const LIGHTWEAVER_PARTITION_LAYOUT = Object.freeze({
  layout: 'default_16MB.csv',
  // The signed digest covers this exact raw range from the merged factory
  // image, including all padding bytes. It is not a digest of the CSV source
  // or the shorter partitions.bin artifact.
  tableOffset: 0x8000,
  tableSize: 0x1000,
  app0Offset: 0x10000,
  app1Offset: 0x650000,
  slotSize: 0x640000,
});

// This non-secret key is intentionally pinned in the installer bundle. Release
// signing uses the matching private key held only in the protected CI secret.
export const LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEQ+nuEatzP5juWyVYJDC3GpSozW/y
LAB3xjDNBGPyFvbvZKhZl+cFxuR1VB2cRrIo2XaaeuqefTz1oMRb6zwQLw==
-----END PUBLIC KEY-----`;

const encoder = new TextEncoder();
const MANIFEST_KEYS = [
  'buildId',
  'configSchema',
  'firmwareVersion',
  'image',
  'minimumInstallerVersion',
  'provenance',
  'schemaVersion',
  'target',
];
// The human-comparable release identity: the commit count of buildId — the same
// number GitHub prints as "N Commits" — compiled into the binary as
// LW_BUILD_NUMBER so a card, this manifest, and GitHub all agree. Optional only so the one already-signed
// release that predates it still verifies; the builder always emits it, and
// `assertFirmwareManifestBuildNumber` enforces that for anything it produces.
const OPTIONAL_MANIFEST_KEYS = ['buildNumber', 'cardStudio', 'update'];

function sortForCanonicalJson(value) {
  if (Array.isArray(value)) return value.map(sortForCanonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortForCanonicalJson(value[key])]),
    );
  }
  return value;
}

export function canonicalFirmwareManifestBytes(manifest) {
  return encoder.encode(JSON.stringify(sortForCanonicalJson(manifest)));
}

export function validateFirmwareUpdateTicket(ticket) {
  assertExactKeys(ticket, [
    'buildId', 'buildNumber', 'compatibility', 'firmwareVersion', 'image',
    'partition', 'preservation', 'schemaVersion', 'target',
  ], 'firmware update ticket');
  assertExactKeys(ticket.image, ['sha256', 'size', 'url'], 'firmware update ticket image');
  assertExactKeys(ticket.partition, [
    'app0Offset', 'app1Offset', 'layout', 'slotSize', 'tableSha256',
  ], 'firmware update ticket partition');
  assertExactKeys(ticket.compatibility, [
    'firmwareApiMax', 'firmwareApiMin', 'minimumBootstrapBuild',
    'minimumUpdaterVersion', 'projectSchemaMax', 'projectSchemaMin',
  ], 'firmware update ticket compatibility');
  assertExactKeys(ticket.preservation, ['dataPartitionsIncluded'], 'firmware update ticket preservation');

  if (ticket.schemaVersion !== 1) throw new Error('Unsupported firmware update ticket schema');
  if (ticket.target !== EXPECTED_FIRMWARE_TARGET) throw new Error('Firmware update ticket target is invalid');
  parseSemver(ticket.firmwareVersion, 'firmware update ticket firmwareVersion');
  if (!/^[a-f0-9]{40}$/.test(ticket.buildId)) {
    throw new Error('Firmware update ticket buildId must be the immutable source revision');
  }
  if (!isPositiveSafeInteger(ticket.buildNumber)) {
    throw new Error('Firmware update ticket buildNumber must be a positive integer');
  }
  if (!isPositiveSafeInteger(ticket.image.size) || ticket.image.size > LIGHTWEAVER_PARTITION_LAYOUT.slotSize) {
    throw new Error('Firmware update ticket image must fit one application slot');
  }
  if (!/^[a-f0-9]{64}$/.test(ticket.image.sha256)) {
    throw new Error('Firmware update ticket image SHA-256 is invalid');
  }
  const expectedImageUrl = `/firmware/releases/${ticket.firmwareVersion}/${ticket.buildId}/lightweaver-controller-esp32s3-app.bin`;
  if (ticket.image.url !== expectedImageUrl) {
    throw new Error('Firmware update ticket image URL must be an immutable versioned release path');
  }
  for (const key of ['layout', 'app0Offset', 'app1Offset', 'slotSize']) {
    if (ticket.partition[key] !== LIGHTWEAVER_PARTITION_LAYOUT[key]) {
      throw new Error(`Firmware update ticket partition ${key} is invalid`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(ticket.partition.tableSha256)) {
    throw new Error('Firmware update ticket partition table SHA-256 is invalid');
  }
  for (const [minimum, maximum, label] of [
    ['firmwareApiMin', 'firmwareApiMax', 'firmware API'],
    ['projectSchemaMin', 'projectSchemaMax', 'project schema'],
  ]) {
    if (!isPositiveSafeInteger(ticket.compatibility[minimum])
      || !isPositiveSafeInteger(ticket.compatibility[maximum])
      || ticket.compatibility[minimum] > ticket.compatibility[maximum]) {
      throw new Error(`Firmware update ticket compatibility ${label} range is invalid`);
    }
  }
  if (!isPositiveSafeInteger(ticket.compatibility.minimumUpdaterVersion)
    || !isPositiveSafeInteger(ticket.compatibility.minimumBootstrapBuild)) {
    throw new Error('Firmware update ticket compatibility minimums are invalid');
  }
  if (ticket.preservation.dataPartitionsIncluded !== false) {
    throw new Error('Firmware update ticket must not include data partitions');
  }
  return ticket;
}

export function canonicalFirmwareUpdateTicketBytes(ticket) {
  validateFirmwareUpdateTicket(ticket);
  return encoder.encode(JSON.stringify(ticket));
}

function assertExactKeys(value, expected, label, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  const required = actual.filter((key) => !optional.includes(key));
  if (required.length !== wanted.length || required.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains unsupported fields`);
  }
}

function parseSemver(version, label) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`${label} must be a semantic version`);
  return match.slice(1).map(Number);
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function validateFirmwareManifest(
  manifest,
  {
    installerVersion = FIRMWARE_INSTALLER_VERSION,
    minimumFirmwareVersion = MINIMUM_PRODUCTION_FIRMWARE_VERSION,
  } = {},
) {
  assertExactKeys(manifest, MANIFEST_KEYS, 'firmware manifest', OPTIONAL_MANIFEST_KEYS);
  assertExactKeys(manifest.image, ['sha256', 'size', 'url'], 'firmware image', ['cardStudioReadback']);
  assertExactKeys(manifest.configSchema, ['max', 'min'], 'config schema range');

  if (manifest.schemaVersion !== 1 && manifest.schemaVersion !== 2) {
    throw new Error('Unsupported firmware manifest schema');
  }
  if (manifest.schemaVersion === 1 && manifest.update !== undefined) {
    throw new Error('Legacy firmware manifest schema 1 cannot contain an update release');
  }
  if (manifest.schemaVersion === 2 && manifest.update === undefined) {
    throw new Error('Firmware manifest schema 2 requires an update release');
  }
  if (manifest.target !== EXPECTED_FIRMWARE_TARGET) throw new Error('Firmware target is not ESP32-S3 16MB');
  const firmwareVersion = parseSemver(manifest.firmwareVersion, 'firmwareVersion');
  const minimumFirmware = parseSemver(minimumFirmwareVersion, 'minimumFirmwareVersion');
  if (compareSemver(firmwareVersion, minimumFirmware) < 0) {
    throw new Error(`Firmware ${manifest.firmwareVersion} is older than the minimum trusted release ${minimumFirmwareVersion}`);
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.buildId)) {
    throw new Error('buildId must be the immutable source revision');
  }
  if (manifest.buildNumber !== undefined && !isPositiveSafeInteger(manifest.buildNumber)) {
    throw new Error('buildNumber must be a positive integer');
  }
  parseSemver(manifest.minimumInstallerVersion, 'minimumInstallerVersion');
  const currentInstaller = parseSemver(installerVersion, 'installerVersion');
  const minimumInstaller = parseSemver(manifest.minimumInstallerVersion, 'minimumInstallerVersion');
  if (compareSemver(currentInstaller, minimumInstaller) < 0) {
    throw new Error(`This firmware requires installer ${manifest.minimumInstallerVersion} or newer`);
  }

  if (!isPositiveSafeInteger(manifest.image.size)) throw new Error('Firmware image size is invalid');
  if (manifest.image.size > MAX_FACTORY_IMAGE_SIZE) {
    throw new Error(`Firmware exceeds the maximum safe factory image size (${MAX_FACTORY_IMAGE_SIZE} bytes)`);
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.image.sha256)) throw new Error('Firmware image SHA-256 is invalid');
  if ((manifest.cardStudio == null) !== (manifest.image.cardStudioReadback == null)) {
    throw new Error('Firmware card Studio identity and readback must be present together');
  }
  if (manifest.image.cardStudioReadback != null) {
    assertExactKeys(manifest.image.cardStudioReadback, ['offset', 'sha256', 'size'], 'card Studio readback');
    if (manifest.image.cardStudioReadback.offset !== 0
      || manifest.image.cardStudioReadback.size !== manifest.image.size
      || manifest.image.cardStudioReadback.sha256 !== manifest.image.sha256) {
      throw new Error('Card Studio readback must cover the exact combined factory image');
    }
  }
  const version = manifest.firmwareVersion.replaceAll('.', '\\.');
  const build = manifest.buildId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const immutablePath = new RegExp(
    `^/firmware/releases/${version}/${build}/lightweaver-controller-esp32s3-factory\\.bin$`,
  );
  if (!immutablePath.test(manifest.image.url)) {
    throw new Error('Firmware image URL must be an immutable versioned release path');
  }

  if (manifest.update !== undefined) {
    assertExactKeys(manifest.update, ['image', 'signature', 'ticket'], 'firmware update release');
    const releaseRoot = `/firmware/releases/${manifest.firmwareVersion}/${manifest.buildId}/`;
    for (const [label, descriptor, fileName] of [
      ['image', manifest.update.image, 'lightweaver-controller-esp32s3-app.bin'],
      ['ticket', manifest.update.ticket, 'firmware-update-ticket.json'],
      ['signature', manifest.update.signature, 'firmware-update-ticket.sig'],
    ]) {
      assertExactKeys(descriptor, ['sha256', 'size', 'url'], `firmware update ${label}`);
      if (!isPositiveSafeInteger(descriptor.size)) {
        throw new Error(`Firmware update ${label} size is invalid`);
      }
      if (!/^[a-f0-9]{64}$/.test(descriptor.sha256)) {
        throw new Error(`Firmware update ${label} SHA-256 is invalid`);
      }
      if (descriptor.url !== `${releaseRoot}${fileName}`) {
        throw new Error(`Firmware update ${label} URL must be an immutable versioned release path`);
      }
    }
    if (manifest.update.image.size > 0x640000) {
      throw new Error('Firmware update image exceeds the application slot');
    }
    if (manifest.update.signature.size !== 87) {
      throw new Error('Firmware update signature must be an exact P-256 descriptor');
    }
  }

  const { min, max } = manifest.configSchema;
  if (!isPositiveSafeInteger(min) || !isPositiveSafeInteger(max) || min > max) {
    throw new Error('Config schema range is invalid');
  }
  if (manifest.cardStudio != null) {
    assertExactKeys(manifest.cardStudio, [
      'assets', 'buildId', 'buildNumber', 'bundleSha256', 'firmwareApi',
      'projectSchema', 'releaseMetadata', 'totalSize',
    ], 'card Studio release');
    if (manifest.cardStudio.buildId !== manifest.buildId) throw new Error('Card Studio buildId must equal firmware buildId');
    if (manifest.cardStudio.buildNumber !== manifest.buildNumber) throw new Error('Card Studio buildNumber must equal firmware buildNumber');
    if (!isPositiveSafeInteger(manifest.cardStudio.totalSize)) throw new Error('Card Studio total size is invalid');
    if (!/^[a-f0-9]{64}$/.test(manifest.cardStudio.bundleSha256)) throw new Error('Card Studio bundle SHA-256 is invalid');
    for (const [label, range] of Object.entries({ projectSchema: manifest.cardStudio.projectSchema, firmwareApi: manifest.cardStudio.firmwareApi })) {
      assertExactKeys(range, ['max', 'min'], `card Studio ${label} range`);
      if (!isPositiveSafeInteger(range.min) || !isPositiveSafeInteger(range.max) || range.min > range.max) {
        throw new Error(`Card Studio ${label} range is invalid`);
      }
    }
    assertExactKeys(manifest.cardStudio.releaseMetadata, ['sha256', 'size'], 'card Studio release metadata');
    if (!isPositiveSafeInteger(manifest.cardStudio.releaseMetadata.size)
      || !/^[a-f0-9]{64}$/.test(manifest.cardStudio.releaseMetadata.sha256)) {
      throw new Error('Card Studio release metadata is invalid');
    }
    if (!Array.isArray(manifest.cardStudio.assets) || manifest.cardStudio.assets.length === 0) {
      throw new Error('Card Studio assets must be a non-empty array');
    }
    const paths = new Set();
    let assetBytes = 0;
    for (const asset of manifest.cardStudio.assets) {
      assertExactKeys(asset, ['path', 'sha256', 'size'], 'card Studio asset');
      if (typeof asset.path !== 'string' || !asset.path.startsWith('/studio/') || paths.has(asset.path)) {
        throw new Error('Card Studio asset path is invalid or duplicated');
      }
      paths.add(asset.path);
      if (!isPositiveSafeInteger(asset.size) || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
        throw new Error('Card Studio asset identity is invalid');
      }
      assetBytes += asset.size;
    }
    if (assetBytes !== manifest.cardStudio.totalSize) throw new Error('Card Studio asset sizes must equal totalSize');
  }
  assertExactKeys(
    manifest.provenance,
    ['framework', 'libraries', 'platform', 'platformio', 'sourceRevision'],
    'firmware provenance',
  );
  assertExactKeys(manifest.provenance.libraries, ['ArduinoJson', 'FastLED', 'WebSockets'], 'firmware libraries');
  if (manifest.provenance.sourceRevision !== manifest.buildId) {
    throw new Error('Firmware provenance source revision must equal buildId');
  }
  for (const [label, value] of Object.entries({
    platformio: manifest.provenance.platformio,
    platform: manifest.provenance.platform,
    framework: manifest.provenance.framework,
    ...manifest.provenance.libraries,
  })) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9.+@_-]{1,96}$/.test(value)) {
      throw new Error(`Firmware provenance ${label} is invalid`);
    }
  }
  return manifest;
}

// Every manifest this repository BUILDS must carry the comparable number, even
// though verification tolerates the one legacy signed release without it.
export function assertFirmwareManifestBuildNumber(manifest) {
  if (!isPositiveSafeInteger(manifest?.buildNumber)) {
    throw new Error('A newly built firmware manifest must carry a positive integer buildNumber');
  }
  return manifest;
}

// Legacy signed schema-1 manifests remain readable. Everything built after the
// card-local Studio was introduced must carry the embedded bundle and exact
// combined-image readback identities before it can be signed.
export function assertFirmwareManifestCardStudio(manifest) {
  if (!manifest?.cardStudio || !manifest?.image?.cardStudioReadback) {
    throw new Error('A newly built firmware manifest must carry the card Studio and combined-image readback identities');
  }
  return manifest;
}

export function formatFirmwareBuildLabel(manifest) {
  return isPositiveSafeInteger(manifest?.buildNumber)
    ? `Build ${manifest.buildNumber}`
    : `Build ${String(manifest?.buildId || '').slice(0, 12) || 'unknown'}`;
}

function pemToDer(pem) {
  const base64 = String(pem)
    .replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\s/g, '');
  if (!base64) throw new Error('Release public key is missing');
  const binary = typeof atob === 'function'
    ? atob(base64)
    : Buffer.from(base64, 'base64').toString('binary');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Release signature encoding is invalid');
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = typeof atob === 'function'
    ? atob(padded)
    : Buffer.from(padded, 'base64').toString('binary');
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function fetchRequired(fetchImpl, url, label) {
  const response = await fetchImpl(url, { cache: 'no-store', credentials: 'omit', redirect: 'error' });
  if (!response?.ok) throw new Error(`Unable to load firmware ${label}`);
  if (response.redirected) throw new Error(`Firmware ${label} redirects are not allowed`);
  return response;
}

function resolveProductionReleaseUrl(value, label, runtime) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    throw new Error(`Firmware ${label} URL must be a relative production path`);
  }
  const resolved = new URL(value, PRODUCTION_FIRMWARE_ORIGIN);
  if (resolved.origin !== PRODUCTION_FIRMWARE_ORIGIN) {
    throw new Error(`Firmware ${label} URL must use the fixed production origin`);
  }
  // Browsers intentionally retain same-origin relative requests so local
  // Studio development and the deployed site behave as before. Node bridge
  // consumers opt in to the compiled HTTPS origin explicitly.
  return runtime === 'node'
    ? resolved.href
    : `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

async function readBoundedFirmwareImage(response, expectedSize) {
  const lengthHeader = response.headers?.get?.('content-length');
  if (lengthHeader != null) {
    const declaredSize = Number(lengthHeader);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      throw new Error('Firmware image Content-Length is invalid');
    }
    if (declaredSize > MAX_FACTORY_IMAGE_SIZE) {
      throw new Error(`Firmware exceeds the maximum safe factory image size (${MAX_FACTORY_IMAGE_SIZE} bytes)`);
    }
    if (declaredSize !== expectedSize) {
      throw new Error(`Firmware image size mismatch: expected ${expectedSize}, received ${declaredSize}`);
    }
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error('Firmware image cannot be read as a bounded stream');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > MAX_FACTORY_IMAGE_SIZE) {
        await reader.cancel();
        throw new Error(`Firmware exceeds the maximum safe factory image size (${MAX_FACTORY_IMAGE_SIZE} bytes)`);
      }
      if (total > expectedSize) {
        await reader.cancel();
        throw new Error(`Firmware image size mismatch: expected ${expectedSize}, received more data`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  if (total !== expectedSize) {
    throw new Error(`Firmware image size mismatch: expected ${expectedSize}, received ${total}`);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedReleaseArtifact(response, descriptor, label, maximumSize) {
  const { size: expectedSize } = descriptor;
  if (expectedSize > maximumSize) throw new Error(`Firmware update ${label} exceeds its safe size limit`);
  const lengthHeader = response.headers?.get?.('content-length');
  if (lengthHeader != null) {
    const declaredSize = Number(lengthHeader);
    if (!Number.isSafeInteger(declaredSize) || declaredSize < 0) {
      throw new Error(`Firmware update ${label} Content-Length is invalid`);
    }
    if (declaredSize !== expectedSize) {
      throw new Error(`Firmware update ${label} size mismatch: expected ${expectedSize}, received ${declaredSize}`);
    }
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error(`Firmware update ${label} cannot be read as a bounded stream`);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > expectedSize || total > maximumSize) {
        await reader.cancel();
        throw new Error(`Firmware update ${label} size mismatch: expected ${expectedSize}, received more data`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  if (total !== expectedSize) {
    throw new Error(`Firmware update ${label} size mismatch: expected ${expectedSize}, received ${total}`);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256Hex(cryptoImpl, bytes) {
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function loadProductionFirmwareManifest(
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  {
    publicKeyPem = LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM,
    installerVersion = FIRMWARE_INSTALLER_VERSION,
    manifestUrl = PRODUCTION_MANIFEST_URL,
    signatureUrl = PRODUCTION_SIGNATURE_URL,
    runtime = 'browser',
  } = {},
) {
  if (typeof fetchImpl !== 'function') throw new Error('Firmware download is unavailable');
  if (!cryptoImpl?.subtle) throw new Error('Secure cryptographic verification is unavailable');

  if (runtime !== 'browser' && runtime !== 'node') {
    throw new Error('Firmware runtime must be browser or node');
  }
  const resolvedManifestUrl = resolveProductionReleaseUrl(manifestUrl, 'manifest', runtime);
  const resolvedSignatureUrl = resolveProductionReleaseUrl(signatureUrl, 'signature', runtime);

  const [manifestResponse, signatureResponse] = await Promise.all([
    fetchRequired(fetchImpl, resolvedManifestUrl, 'manifest'),
    fetchRequired(fetchImpl, resolvedSignatureUrl, 'signature'),
  ]);
  const manifestText = await manifestResponse.text();
  const signatureText = (await signatureResponse.text()).trim();
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error('Firmware manifest is not valid JSON');
  }

  const publicKey = await cryptoImpl.subtle.importKey(
    'spki',
    pemToDer(publicKeyPem),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const signature = decodeBase64Url(signatureText);
  if (signature.byteLength !== 64) throw new Error('Firmware signature has an invalid length');
  const signatureValid = await cryptoImpl.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signature,
    canonicalFirmwareManifestBytes(manifest),
  );
  if (!signatureValid) throw new Error('Firmware manifest signature verification failed');

  return validateFirmwareManifest(manifest, { installerVersion });
}

export async function loadProductionFirmwareRelease(
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  options = {},
) {
  const { runtime = 'browser' } = options;
  const manifest = await loadProductionFirmwareManifest(fetchImpl, cryptoImpl, options);
  const imageUrl = resolveProductionReleaseUrl(manifest.image.url, 'image', runtime);
  const imageResponse = await fetchRequired(fetchImpl, imageUrl, 'image');
  const bytes = await readBoundedFirmwareImage(imageResponse, manifest.image.size);
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
  const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (sha256 !== manifest.image.sha256) throw new Error('Firmware image SHA-256 mismatch');

  return { manifest, bytes };
}

export async function loadProductionFirmwareUpdateRelease(
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  options = {},
) {
  const { runtime = 'browser', publicKeyPem = LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM } = options;
  const manifest = await loadProductionFirmwareManifest(fetchImpl, cryptoImpl, options);
  if (manifest.schemaVersion !== 2 || !manifest.update) {
    throw new Error('Signed firmware manifest does not publish a preserving update release');
  }
  const ticketUrl = resolveProductionReleaseUrl(manifest.update.ticket.url, 'update ticket', runtime);
  const signatureUrl = resolveProductionReleaseUrl(manifest.update.signature.url, 'update ticket signature', runtime);
  const imageUrl = resolveProductionReleaseUrl(manifest.update.image.url, 'update image', runtime);
  const [ticketResponse, signatureResponse, imageResponse] = await Promise.all([
    fetchRequired(fetchImpl, ticketUrl, 'update ticket'),
    fetchRequired(fetchImpl, signatureUrl, 'update ticket signature'),
    fetchRequired(fetchImpl, imageUrl, 'update image'),
  ]);
  const [ticketBytes, signatureFileBytes, imageBytes] = await Promise.all([
    readBoundedReleaseArtifact(ticketResponse, manifest.update.ticket, 'ticket', 64 * 1024),
    readBoundedReleaseArtifact(signatureResponse, manifest.update.signature, 'ticket signature', 87),
    readBoundedReleaseArtifact(imageResponse, manifest.update.image, 'image', LIGHTWEAVER_PARTITION_LAYOUT.slotSize),
  ]);
  const [ticketSha256, signatureSha256, imageSha256] = await Promise.all([
    sha256Hex(cryptoImpl, ticketBytes),
    sha256Hex(cryptoImpl, signatureFileBytes),
    sha256Hex(cryptoImpl, imageBytes),
  ]);
  if (ticketSha256 !== manifest.update.ticket.sha256) throw new Error('Firmware update ticket SHA-256 mismatch');
  if (signatureSha256 !== manifest.update.signature.sha256) throw new Error('Firmware update ticket signature SHA-256 mismatch');
  if (imageSha256 !== manifest.update.image.sha256) throw new Error('Firmware update image SHA-256 mismatch');

  let ticket;
  try {
    ticket = JSON.parse(new TextDecoder().decode(ticketBytes));
  } catch {
    throw new Error('Firmware update ticket is not valid JSON');
  }
  validateFirmwareUpdateTicket(ticket);
  const canonicalTicketBytes = canonicalFirmwareUpdateTicketBytes(ticket);
  if (canonicalTicketBytes.byteLength !== ticketBytes.byteLength
    || canonicalTicketBytes.some((byte, index) => byte !== ticketBytes[index])) {
    throw new Error('Firmware update ticket bytes are not canonical');
  }
  if (ticket.target !== manifest.target
    || ticket.firmwareVersion !== manifest.firmwareVersion
    || ticket.buildId !== manifest.buildId
    || ticket.buildNumber !== manifest.buildNumber) {
    throw new Error('Firmware update ticket identity does not match the signed manifest');
  }
  if (ticket.image.url !== manifest.update.image.url
    || ticket.image.size !== manifest.update.image.size
    || ticket.image.sha256 !== manifest.update.image.sha256) {
    throw new Error('Firmware update ticket image descriptor does not match the signed manifest');
  }
  if (manifest.cardStudio
    && (ticket.compatibility.firmwareApiMin !== manifest.cardStudio.firmwareApi.min
      || ticket.compatibility.firmwareApiMax !== manifest.cardStudio.firmwareApi.max
      || ticket.compatibility.projectSchemaMin !== manifest.cardStudio.projectSchema.min
      || ticket.compatibility.projectSchemaMax !== manifest.cardStudio.projectSchema.max)) {
    throw new Error('Firmware update ticket compatibility does not match the signed card Studio');
  }

  const signatureText = new TextDecoder().decode(signatureFileBytes);
  if (!/^[A-Za-z0-9_-]{86}\n$/.test(signatureText)) {
    throw new Error('Firmware update ticket signature encoding is invalid');
  }
  const ticketSignature = decodeBase64Url(signatureText.trim());
  if (ticketSignature.byteLength !== 64) throw new Error('Firmware update ticket signature has an invalid length');
  const publicKey = await cryptoImpl.subtle.importKey(
    'spki',
    pemToDer(publicKeyPem),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const signatureValid = await cryptoImpl.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    ticketSignature,
    ticketBytes,
  );
  if (!signatureValid) throw new Error('Firmware update ticket signature verification failed');

  return {
    manifest,
    ticket,
    ticketBytes,
    ticketSha256,
    ticketSignature,
    imageBytes,
  };
}
