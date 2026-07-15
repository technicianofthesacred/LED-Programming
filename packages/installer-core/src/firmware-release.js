export const EXPECTED_FIRMWARE_TARGET = 'esp32-s3-n16r8';
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

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
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
  assertExactKeys(manifest, MANIFEST_KEYS, 'firmware manifest');
  assertExactKeys(manifest.image, ['sha256', 'size', 'url'], 'firmware image');
  assertExactKeys(manifest.configSchema, ['max', 'min'], 'config schema range');

  if (manifest.schemaVersion !== 1) throw new Error('Unsupported firmware manifest schema');
  if (manifest.target !== EXPECTED_FIRMWARE_TARGET) throw new Error('Firmware target is not ESP32-S3 16MB');
  const firmwareVersion = parseSemver(manifest.firmwareVersion, 'firmwareVersion');
  const minimumFirmware = parseSemver(minimumFirmwareVersion, 'minimumFirmwareVersion');
  if (compareSemver(firmwareVersion, minimumFirmware) < 0) {
    throw new Error(`Firmware ${manifest.firmwareVersion} is older than the minimum trusted release ${minimumFirmwareVersion}`);
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.buildId)) {
    throw new Error('buildId must be the immutable source revision');
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
  const version = manifest.firmwareVersion.replaceAll('.', '\\.');
  const build = manifest.buildId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const immutablePath = new RegExp(
    `^/firmware/releases/${version}/${build}/lightweaver-controller-esp32s3-factory\\.bin$`,
  );
  if (!immutablePath.test(manifest.image.url)) {
    throw new Error('Firmware image URL must be an immutable versioned release path');
  }

  const { min, max } = manifest.configSchema;
  if (!isPositiveSafeInteger(min) || !isPositiveSafeInteger(max) || min > max) {
    throw new Error('Config schema range is invalid');
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
  const response = await fetchImpl(url, { cache: 'no-store', credentials: 'omit' });
  if (!response?.ok) throw new Error(`Unable to load firmware ${label}`);
  return response;
}

function resolveProductionReleaseUrl(value, label) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    throw new Error(`Firmware ${label} URL must be a relative production path`);
  }
  const resolved = new URL(value, PRODUCTION_FIRMWARE_ORIGIN);
  if (resolved.origin !== PRODUCTION_FIRMWARE_ORIGIN) {
    throw new Error(`Firmware ${label} URL must use the fixed production origin`);
  }
  // Browsers intentionally retain same-origin relative requests so local
  // Studio development and the deployed site behave as before. Node has no
  // document origin, so bridge/CLI consumers use the compiled HTTPS origin.
  return typeof window === 'object' && window?.location
    ? `${resolved.pathname}${resolved.search}${resolved.hash}`
    : resolved.href;
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

export async function loadProductionFirmwareRelease(
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  {
    publicKeyPem = LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM,
    installerVersion = FIRMWARE_INSTALLER_VERSION,
    manifestUrl = PRODUCTION_MANIFEST_URL,
    signatureUrl = PRODUCTION_SIGNATURE_URL,
  } = {},
) {
  if (typeof fetchImpl !== 'function') throw new Error('Firmware download is unavailable');
  if (!cryptoImpl?.subtle) throw new Error('Secure cryptographic verification is unavailable');

  const resolvedManifestUrl = resolveProductionReleaseUrl(manifestUrl, 'manifest');
  const resolvedSignatureUrl = resolveProductionReleaseUrl(signatureUrl, 'signature');

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

  validateFirmwareManifest(manifest, { installerVersion });
  const imageUrl = resolveProductionReleaseUrl(manifest.image.url, 'image');
  const imageResponse = await fetchRequired(fetchImpl, imageUrl, 'image');
  const bytes = await readBoundedFirmwareImage(imageResponse, manifest.image.size);
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
  const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (sha256 !== manifest.image.sha256) throw new Error('Firmware image SHA-256 mismatch');

  return { manifest, bytes };
}
