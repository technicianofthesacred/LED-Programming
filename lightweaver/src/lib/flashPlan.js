export const DEFAULT_WLED_APP_FLASH_ADDRESS = '0x10000';
export const DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS = '0x0';

// Every valid ESP32 flash image (bootloader, app, merged factory) starts with
// this magic byte. An HTML page served by a SPA fallback starts with '<' (0x3C).
export const ESP_IMAGE_MAGIC = 0xe9;

// The merged factory image is ~1.1 MB. Anything under half a megabyte at the
// factory-firmware URL is not the real binary (an error page, a truncated
// download, or an HTML fallback served with HTTP 200).
export const MIN_FACTORY_IMAGE_BYTES = 512 * 1024;

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
