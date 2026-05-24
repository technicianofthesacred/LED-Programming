export const DEFAULT_WLED_APP_FLASH_ADDRESS = '0x10000';

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
    throw new Error('A single WLED app binary cannot be flashed after erasing all flash. Use the four-part ESP32-S3 install flow first, or flash a true merged image at 0x0.');
  }

  return { address: parsedAddress };
}
