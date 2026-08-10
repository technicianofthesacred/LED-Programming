export const LIGHTWEAVER_APP_PARTITION_OFFSET = 0x10000;
export const LIGHTWEAVER_APP_PARTITION_SIZE = 0x640000;
export const USB_FIRMWARE_READ_CHUNK_SIZE = 0x10000;

const ENVELOPE_OVERLAP = 1024;
const CONTRACT_MARKER_BEFORE = 'lw-%012llx';
const CONTRACT_MARKER_AFTER = 'provisioningContractVersion';
const CONTRACT_MARKER_DISTANCE = 256;
const IDENTITY_PATTERN = /((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]{1,32})?)\x00([a-f0-9]{40})\x00/g;

function bytesOf(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function isErased(bytes) {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0xff) return false;
  }
  return true;
}

export function parseLightweaverFirmwareIdentity(value) {
  const bytes = bytesOf(value);
  if (!bytes?.length) return null;
  const text = new TextDecoder('latin1').decode(bytes);
  IDENTITY_PATTERN.lastIndex = 0;
  for (let match = IDENTITY_PATTERN.exec(text); match; match = IDENTITY_PATTERN.exec(text)) {
    const identityStart = match.index;
    const identityEnd = identityStart + match[0].length;
    const before = text.lastIndexOf(CONTRACT_MARKER_BEFORE, identityStart);
    if (before < 0 || identityStart - (before + CONTRACT_MARKER_BEFORE.length) > CONTRACT_MARKER_DISTANCE) continue;
    const after = text.indexOf(CONTRACT_MARKER_AFTER, identityEnd);
    if (after < 0 || after - identityEnd > CONTRACT_MARKER_DISTANCE) continue;
    return Object.freeze({
      firmwareVersion: match[1],
      buildId: match[2],
      source: 'usb-flash',
    });
  }
  return null;
}

export async function readLightweaverFirmwareIdentity(loader, { onProgress } = {}) {
  if (typeof loader?.readFlash !== 'function') return null;
  const partitionEnd = LIGHTWEAVER_APP_PARTITION_OFFSET + LIGHTWEAVER_APP_PARTITION_SIZE;
  let carry = new Uint8Array(0);
  try {
    for (let address = LIGHTWEAVER_APP_PARTITION_OFFSET; address < partitionEnd; address += USB_FIRMWARE_READ_CHUNK_SIZE) {
      const size = Math.min(USB_FIRMWARE_READ_CHUNK_SIZE, partitionEnd - address);
      const result = bytesOf(await loader.readFlash(address, size));
      if (!result || result.length < size) return null;
      const chunk = result.subarray(0, size);
      if (isErased(chunk)) return null;
      const scan = new Uint8Array(carry.length + chunk.length);
      scan.set(carry);
      scan.set(chunk, carry.length);
      const identity = parseLightweaverFirmwareIdentity(scan);
      onProgress?.({
        bytesRead: address + size - LIGHTWEAVER_APP_PARTITION_OFFSET,
        totalBytes: LIGHTWEAVER_APP_PARTITION_SIZE,
      });
      if (identity) return identity;
      carry = scan.slice(Math.max(0, scan.length - ENVELOPE_OVERLAP));
    }
  } catch {
    return null;
  }
  return null;
}
