import { EXPECTED_FIRMWARE_TARGET } from './constants.js';

export const DEFAULT_WLED_APP_FLASH_ADDRESS = '0x10000';
export const DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS = '0x0';

// Every valid ESP32 flash image (bootloader, app, merged factory) starts with
// this magic byte. An HTML page served by a SPA fallback starts with '<' (0x3C).
export const ESP_IMAGE_MAGIC = 0xe9;

// The merged factory image is ~1.1 MB. Anything under half a megabyte at the
// factory-firmware URL is not the real binary (an error page, a truncated
// download, or an HTML fallback served with HTTP 200).
export const MIN_FACTORY_IMAGE_BYTES = 512 * 1024;
export const LIGHTWEAVER_INSTALL_CHIP = 'ESP32-S3';
export const LIGHTWEAVER_INSTALL_FLASH_BYTES = 16 * 1024 * 1024;

const BROKEN_SUFFIX = '— nothing was written to your card.';

// Guard against flashing something that is not ESP32 firmware. The dangerous
// real-world case: Cloudflare Pages' SPA fallback answers a missing .bin path
// with index.html and HTTP 200, so `response.ok` alone would let the flasher
// erase a working card and write a web page onto it.
//
// Pure function so it is testable without a browser:
//   bytes       - Uint8Array of the image (at least the first byte)
//   size        - total byte length (defaults to bytes.length)
//   contentType - optional HTTP Content-Type header to sanity-check
//   minBytes    - optional minimum plausible size (pass MIN_FACTORY_IMAGE_BYTES
//                 for the bundled factory image; omit for user-picked files)
// Throws a plain-language Error when the image is not flashable.
export function validateFirmwareImage({ bytes, size, contentType, minBytes } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
  const totalBytes = Number.isFinite(size) ? size : data.length;

  const type = String(contentType ?? '').toLowerCase();
  if (/\btext\/html\b|\btext\/plain\b|\bapplication\/json\b|\btext\/css\b|\bjavascript\b/.test(type)) {
    throw new Error(
      `The firmware file on the site looks broken (the server sent a web page instead of firmware) ${BROKEN_SUFFIX}`,
    );
  }

  if (data.length === 0) {
    throw new Error(`The firmware file looks broken (it is empty) ${BROKEN_SUFFIX}`);
  }

  if (data[0] !== ESP_IMAGE_MAGIC) {
    throw new Error(
      `The firmware file looks broken (not an ESP32 firmware image) ${BROKEN_SUFFIX}`,
    );
  }

  if (Number.isFinite(minBytes) && totalBytes < minBytes) {
    throw new Error(
      `The firmware file looks broken (only ${totalBytes} bytes — far smaller than real firmware) ${BROKEN_SUFFIX}`,
    );
  }

  return { size: totalBytes };
}

export function parseFlashAddress(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(text)) {
    throw new Error('Invalid flash address');
  }
  const address = Number.parseInt(text, text.toLowerCase().startsWith('0x') ? 16 : 10);
  if (!Number.isSafeInteger(address) || address < 0) {
    throw new Error('Invalid flash address');
  }
  return address;
}

export function validateFlashPlan({ address, eraseAll }) {
  const parsedAddress = parseFlashAddress(address);

  if (eraseAll && parsedAddress !== 0) {
    throw new Error('Erase all requires a merged factory image flashed at 0x0.');
  }

  return { address: parsedAddress };
}

function flashSizeToBytes(value) {
  const match = /^\s*(\d+)\s*(KB|MB)\s*$/i.exec(String(value ?? ''));
  if (!match) return null;
  const multiplier = match[2].toUpperCase() === 'MB' ? 1024 * 1024 : 1024;
  const bytes = Number(match[1]) * multiplier;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

export function validateInstallHardware({ chipName, flashSize } = {}) {
  const normalizedChip = String(chipName ?? '').trim().toUpperCase();
  if (normalizedChip !== LIGHTWEAVER_INSTALL_CHIP) {
    throw new Error(`This is ${chipName || 'an unknown chip'}, not an ESP32-S3. Nothing was erased or installed.`);
  }
  const flashBytes = flashSizeToBytes(flashSize);
  if (flashBytes == null) {
    throw new Error('Studio could not verify the card has 16 MB of flash. Nothing was erased or installed.');
  }
  if (flashBytes !== LIGHTWEAVER_INSTALL_FLASH_BYTES) {
    throw new Error(`This card has ${flashSize} of flash; Lightweaver needs 16 MB. Nothing was erased or installed.`);
  }
  return { chipName: LIGHTWEAVER_INSTALL_CHIP, flashBytes };
}

export function validateProductionInstallRelease(release = {}) {
  const bytes = release.bytes instanceof Uint8Array ? release.bytes : new Uint8Array(0);
  const manifest = release.manifest && typeof release.manifest === 'object' ? release.manifest : {};
  if (manifest.target !== EXPECTED_FIRMWARE_TARGET) {
    throw new Error('The signed release does not target the Lightweaver ESP32-S3 card. Nothing can be installed.');
  }
  if (manifest.image?.size !== bytes.byteLength) {
    throw new Error('The signed firmware size does not match its manifest. Nothing can be installed.');
  }
  validateFirmwareImage({ bytes, size: bytes.byteLength, minBytes: MIN_FACTORY_IMAGE_BYTES });
  if (bytes[0x8000] !== 0xaa || bytes[0x8001] !== 0x50 || bytes[0x10000] !== ESP_IMAGE_MAGIC) {
    throw new Error('The signed firmware is not a complete ESP32-S3 factory image. Nothing can be installed.');
  }
  return { size: bytes.byteLength };
}

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_CONSTANTS = Array.from({ length: 64 }, (_, index) => (
  Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0
));

function rotateLeft(value, amount) {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

export function calculateMD5Hex(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input ?? 0);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = BigInt(bytes.length) * 8n;
  for (let index = 0; index < 8; index += 1) {
    padded[paddedLength - 8 + index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const words = new Uint32Array(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      words[index] = padded[wordOffset]
        | (padded[wordOffset + 1] << 8)
        | (padded[wordOffset + 2] << 16)
        | (padded[wordOffset + 3] << 24);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index += 1) {
      let f;
      let g;
      if (index < 16) {
        f = (b & c) | (~b & d);
        g = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        g = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        g = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * index) % 16;
      }
      const nextD = d;
      d = c;
      c = b;
      const sum = (a + f + MD5_CONSTANTS[index] + words[g]) >>> 0;
      b = (b + rotateLeft(sum, MD5_SHIFTS[index])) >>> 0;
      a = nextD;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map(word => [0, 8, 16, 24]
    .map(shift => ((word >>> shift) & 0xff).toString(16).padStart(2, '0')).join('')).join('');
}

export async function writeVerifiedFlash(loader, options) {
  if (!loader?.writeFlash) throw new Error('The connected card cannot be written');
  return loader.writeFlash({ ...options, calculateMD5Hash: calculateMD5Hex });
}

export async function replaceInstallConnection({ previous, connect, verify, disconnect }) {
  if (typeof connect !== 'function' || typeof verify !== 'function' || typeof disconnect !== 'function') {
    throw new Error('Card selection dependencies are unavailable');
  }
  if (previous) await disconnect(previous);
  const connection = await connect();
  try {
    const hardware = await verify(connection);
    return { connection, hardware };
  } catch (error) {
    await disconnect(connection);
    throw error;
  }
}
