import { CARD_HARDWARE_CONTRACT } from './cardHardwareContract.js';

// What each physical card port is being used for. The card has four output
// ports (CARD_HARDWARE_CONTRACT.outputPins); the owner may hang a strip off
// one, a physical control off another, and leave the rest empty. Recording the
// intent separately from the card config is what lets discovery ask "which of
// these four should I go looking for pixels on?" before any project exists.
export const PORT_ROLE_STRIP = 'strip';
export const PORT_ROLE_CONTROL = 'control';
export const PORT_ROLE_UNUSED = 'unused';

export const PORT_ROLES = Object.freeze([PORT_ROLE_STRIP, PORT_ROLE_CONTROL, PORT_ROLE_UNUSED]);

// Control hardware the owner can hang off a port. Kept open-ended on purpose:
// a future module (a voice module, say) claiming a port is just another kind.
export const PORT_CONTROL_KINDS = Object.freeze(['knob', 'slider', 'button']);

// The firmware addresses pixels through `uint16_t totalPixels` and
// `uint16_t OutputConfig.start` (LightweaverTypes.h), so a count above 65535
// cannot be represented at all — that is the one hard bound here. Every softer
// limit (LW_MAX_PIXELS, refresh rate, power) is a WARNING owned by consumers:
// the owner's rule is "if I need more power I will wire more power", so this
// model never rejects a large strip.
export const PORT_MAX_PIXEL_COUNT = 65535;

export function defaultPortRoles(outputPins = CARD_HARDWARE_CONTRACT.outputPins) {
  return resolveOutputPins(outputPins).map(pin => ({
    pin,
    role: PORT_ROLE_UNUSED,
    pixelCount: 0,
    controlKind: '',
  }));
}

// Always returns a complete, valid entry for every contract pin, in pin order.
// Anything unrecognized collapses to the safe "unused, zero pixels" default
// rather than throwing, because this runs on persisted project data that may
// predate the field entirely or have been hand-edited.
export function normalizePortRoles(raw, { outputPins } = {}) {
  const pins = resolveOutputPins(outputPins);
  const byPin = new Map();
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const pin = Number(entry.pin);
      // A saved role for a pin this card cannot drive is dropped, not carried:
      // the pin menu is a compile-time switch in addLedsForPin(), so a port
      // that is not in the contract has no physical port to describe.
      if (!Number.isInteger(pin) || !pins.includes(pin)) continue;
      if (!byPin.has(pin)) byPin.set(pin, entry);
    }
  }

  return pins.map(pin => {
    const entry = byPin.get(pin);
    if (!entry) return { pin, role: PORT_ROLE_UNUSED, pixelCount: 0, controlKind: '' };
    return {
      pin,
      role: PORT_ROLES.includes(entry.role) ? entry.role : PORT_ROLE_UNUSED,
      pixelCount: clampPixelCount(entry.pixelCount),
      // The kind is validated but deliberately NOT cleared when the role is not
      // 'control': role and kind are answered in separate UI steps, and wiping
      // the kind mid-edit would throw away an answer the owner already gave.
      controlKind: PORT_CONTROL_KINDS.includes(entry.controlKind) ? entry.controlKind : '',
    };
  });
}

// Ports that actually carry pixels. A port marked 'strip' with a count of zero
// is a port whose strip has not been measured yet — it is not a strip a caller
// can build frames for, so it is excluded here.
export function stripPorts(portRoles) {
  if (!Array.isArray(portRoles)) return [];
  return portRoles.filter(entry => (
    entry
    && entry.role === PORT_ROLE_STRIP
    && Number.isInteger(entry.pixelCount)
    && entry.pixelCount > 0
  ));
}

export function totalStripPixels(portRoles) {
  return stripPorts(portRoles).reduce((sum, entry) => sum + entry.pixelCount, 0);
}

function resolveOutputPins(outputPins) {
  const source = Array.isArray(outputPins) ? outputPins : CARD_HARDWARE_CONTRACT.outputPins;
  const pins = [];
  for (const value of source) {
    const pin = Number(value);
    if (!Number.isInteger(pin) || pin < 0) continue;
    if (pins.includes(pin)) continue;
    pins.push(pin);
  }
  return pins.length ? pins : [...CARD_HARDWARE_CONTRACT.outputPins];
}

function clampPixelCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(PORT_MAX_PIXEL_COUNT, Math.trunc(number)));
}
