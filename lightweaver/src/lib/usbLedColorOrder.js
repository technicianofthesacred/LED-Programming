import { DEFAULT_LWUSB_MAX_PIXELS } from './usbLedFrame.js';

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
  const count = Math.max(1, Math.min(DEFAULT_LWUSB_MAX_PIXELS, Number.parseInt(pixelCount, 10) || 30));
  return Array.from({ length: count }, (_, index) => {
    const section = Math.floor((index * 3) / count);
    if (section === 0) return { r: 255, g: 0, b: 0 };
    if (section === 1) return { r: 0, g: 255, b: 0 };
    return { r: 0, g: 0, b: 255 };
  });
}

// --- Color-order solver -----------------------------------------------------
// Firmware writes the wire bytes in the configured order's sequence, and the
// strip lights channel trueOrder[i] with whatever arrived at wire position i.
// So sending one pure logical channel shows: trueOrder[configured.indexOf(X)].
// One answer pins one slot of trueOrder (6 candidates -> 2); a second answer
// pins another and forces the third. Two answers always solve it exactly, which
// is why the check is two taps and never a cycle through all six orders.

export function observedChannel(configured, trueOrder, logical) {
  const order = normalizeUsbLedColorOrder(configured);
  const real = normalizeUsbLedColorOrder(trueOrder);
  const index = order.indexOf(String(logical || '').toUpperCase());
  return index >= 0 ? real[index] : '';
}

// observations maps a logical channel to the channel the owner reported seeing,
// e.g. { R: 'B' } after the red question.
export function colorOrderCandidates(configured, observations = {}) {
  const entries = Object.entries(observations).filter(([, seen]) => seen);
  return COLOR_ORDERS.filter(trueOrder => entries.every(
    ([logical, seen]) => observedChannel(configured, trueOrder, logical) === String(seen).toUpperCase(),
  ));
}

// The answers worth offering for the next question, given the answers so far.
// Three for the red question, always exactly two for the green one.
export function colorOrderAnswers(configured, observations, logical) {
  const seen = colorOrderCandidates(configured, observations)
    .map(trueOrder => observedChannel(configured, trueOrder, logical));
  return [...new Set(seen)].filter(Boolean);
}

// The one order consistent with every answer, or '' while still ambiguous.
export function solveColorOrder(configured, observations) {
  const candidates = colorOrderCandidates(configured, observations);
  return candidates.length === 1 ? candidates[0] : '';
}
