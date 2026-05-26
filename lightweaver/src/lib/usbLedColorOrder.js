export const COLOR_ORDERS = ['RGB', 'GRB', 'BRG', 'BGR', 'RBG', 'GBR'];

export function normalizeUsbLedColorOrder(value, fallback = 'RGB') {
  const order = String(value || '').trim().toUpperCase();
  return COLOR_ORDERS.includes(order) ? order : fallback;
}

export function makeUsbLedColorOrderCommand(value) {
  return `ORDER ${normalizeUsbLedColorOrder(value)}`;
}
