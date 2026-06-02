export const DEFAULT_LWUSB_PUSH_FPS = 18;
export const DEFAULT_LWUSB_MAX_PIXELS = 600;
export const DEFAULT_LWUSB_BAUD_RATE = 115200;
export const DEFAULT_LWUSB_SERIAL_UTILIZATION = 0.6;

export function clampByte(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

export function byteToHex(value) {
  return clampByte(value).toString(16).padStart(2, '0');
}

export function pixelsToLwUsbFrameHex(pixels = [], { maxPixels = DEFAULT_LWUSB_MAX_PIXELS } = {}) {
  if (!Array.isArray(pixels)) return '';
  const limit = Math.max(0, Math.min(maxPixels || DEFAULT_LWUSB_MAX_PIXELS, pixels.length));
  let hex = '';
  for (let i = 0; i < limit; i++) {
    const pixel = pixels[i] || {};
    hex += byteToHex(pixel.r) + byteToHex(pixel.g) + byteToHex(pixel.b);
  }
  return hex;
}

export function isLwUsbFrameHex(value) {
  const hex = String(value || '');
  return hex.length % 6 === 0 && /^[0-9a-fA-F]*$/.test(hex);
}

export function normalizeLwUsbPixelCount(value, { maxPixels = DEFAULT_LWUSB_MAX_PIXELS, fallback = 30 } = {}) {
  const parsed = Number.parseInt(value, 10);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  const max = Math.max(1, Number.parseInt(maxPixels, 10) || DEFAULT_LWUSB_MAX_PIXELS);
  return Math.max(1, Math.min(max, base));
}

export function estimateLwUsbFrameBytes(pixelCount) {
  const count = Math.max(0, Number.parseInt(pixelCount, 10) || 0);
  return 'FRAME '.length + (count * 6) + 1;
}

export function getLwUsbSerialSafeFps(pixelCount, {
  baudRate = DEFAULT_LWUSB_BAUD_RATE,
  maxFps = DEFAULT_LWUSB_PUSH_FPS,
  utilization = DEFAULT_LWUSB_SERIAL_UTILIZATION,
} = {}) {
  const requestedFps = Math.max(1, Math.min(30, Number(maxFps) || DEFAULT_LWUSB_PUSH_FPS));
  const frameBytes = estimateLwUsbFrameBytes(pixelCount);
  if (!frameBytes) return requestedFps;
  const serialBytesPerSecond = (Math.max(9600, Number(baudRate) || DEFAULT_LWUSB_BAUD_RATE) / 10) * Math.max(0.1, Math.min(0.95, utilization));
  return Math.max(1, Math.min(requestedFps, Math.floor(serialBytesPerSecond / frameBytes) || 1));
}
