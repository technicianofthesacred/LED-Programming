export const EXPECTED_FIRMWARE_TARGET = 'esp32-s3-n16r8';
export const FIRMWARE_INSTALLER_VERSION = '1.4.0';
export const PRODUCTION_MANIFEST_URL = '/firmware/release-manifest.json';
export const PRODUCTION_SIGNATURE_URL = '/firmware/release-manifest.sig';

// This non-secret key is intentionally pinned in the installer bundle. Release
// signing uses the matching private key held only in the protected CI secret.
export const LIGHTWEAVER_RELEASE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE8w4Ke8UlzlztEvAHmCVhiGlDNjtb
FYBylUWXRnSzpRD05Jm/34gY5h4AcGFe9DUCxCWQKIzPDDB/6YKZpDMkww==
-----END PUBLIC KEY-----`;

const encoder = new TextEncoder();
const MANIFEST_KEYS = [
  'buildId',
  'configSchema',
  'firmwareVersion',
  'image',
  'minimumInstallerVersion',
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
  { installerVersion = FIRMWARE_INSTALLER_VERSION } = {},
) {
  assertExactKeys(manifest, MANIFEST_KEYS, 'firmware manifest');
  assertExactKeys(manifest.image, ['sha256', 'size', 'url'], 'firmware image');
  assertExactKeys(manifest.configSchema, ['max', 'min'], 'config schema range');

  if (manifest.schemaVersion !== 1) throw new Error('Unsupported firmware manifest schema');
  if (manifest.target !== EXPECTED_FIRMWARE_TARGET) throw new Error('Firmware target is not ESP32-S3 16MB');
  parseSemver(manifest.firmwareVersion, 'firmwareVersion');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(manifest.buildId)) {
    throw new Error('buildId is invalid');
  }
  parseSemver(manifest.minimumInstallerVersion, 'minimumInstallerVersion');
  const currentInstaller = parseSemver(installerVersion, 'installerVersion');
  const minimumInstaller = parseSemver(manifest.minimumInstallerVersion, 'minimumInstallerVersion');
  if (compareSemver(currentInstaller, minimumInstaller) < 0) {
    throw new Error(`This firmware requires installer ${manifest.minimumInstallerVersion} or newer`);
  }

  if (!isPositiveSafeInteger(manifest.image.size)) throw new Error('Firmware image size is invalid');
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

  const [manifestResponse, signatureResponse] = await Promise.all([
    fetchRequired(fetchImpl, manifestUrl, 'manifest'),
    fetchRequired(fetchImpl, signatureUrl, 'signature'),
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
  const imageResponse = await fetchRequired(fetchImpl, manifest.image.url, 'image');
  const bytes = new Uint8Array(await imageResponse.arrayBuffer());
  if (bytes.byteLength !== manifest.image.size) {
    throw new Error(`Firmware image size mismatch: expected ${manifest.image.size}, received ${bytes.byteLength}`);
  }
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
  const sha256 = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (sha256 !== manifest.image.sha256) throw new Error('Firmware image SHA-256 mismatch');

  return { manifest, bytes };
}
