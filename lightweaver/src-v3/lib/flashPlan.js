export const DEFAULT_WLED_APP_FLASH_ADDRESS = '0x10000';
export const DEFAULT_LIGHTWEAVER_FACTORY_FLASH_ADDRESS = '0x0';

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
