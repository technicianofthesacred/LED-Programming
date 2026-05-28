export const COLOR_ORDERS = ['RGB', 'GRB', 'BRG', 'BGR', 'RBG', 'GBR'];

export function normalizeUsbLedColorOrder(value, fallback = 'RGB') {
  const order = String(value || '').trim().toUpperCase();
  return COLOR_ORDERS.includes(order) ? order : fallback;
}

export function makeUsbLedColorOrderCommand(value) {
  return `ORDER ${normalizeUsbLedColorOrder(value)}`;
}

export function nextUsbLedColorOrder(value) {
  const current = normalizeUsbLedColorOrder(value);
  const index = COLOR_ORDERS.indexOf(current);
  return COLOR_ORDERS[(index + 1) % COLOR_ORDERS.length];
}

export function makeUsbLedCalibrationPixels(pixelCount = 30) {
  const count = Math.max(1, Math.min(300, Number.parseInt(pixelCount, 10) || 30));
  return Array.from({ length: count }, (_, index) => {
    const section = Math.floor((index * 3) / count);
    if (section === 0) return { r: 255, g: 0, b: 0 };
    if (section === 1) return { r: 0, g: 255, b: 0 };
    return { r: 0, g: 0, b: 255 };
  });
}
