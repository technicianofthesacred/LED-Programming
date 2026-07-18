import { DEFAULT_CONTROLLER_POWER } from './controllerProfiles.js';

// Shared supply settings for the Size & Power / Wire power readouts
// (docs/wiring-sizing-ui-redesign.md changes 15/16 + review follow-up).
// The user-set supply size and per-LED draw persist on
// standaloneController.led so both panels compute the same budget and a
// custom PSU survives mode switches and project reloads (extra `led` keys
// round-trip through defaultStandaloneController's spread).

export function positiveOrDefault(raw, fallback) {
  const value = parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function readPowerSupplySettings(controller) {
  return {
    psuAmps: positiveOrDefault(controller?.led?.psuAmps, DEFAULT_CONTROLLER_POWER.psuAmps),
    milliampsPerPixel: positiveOrDefault(
      controller?.led?.milliampsPerPixel,
      DEFAULT_CONTROLLER_POWER.milliampsPerPixel,
    ),
  };
}

export function withPowerSupplySettings(controller, { psuAmps, milliampsPerPixel }) {
  return {
    ...controller,
    led: {
      ...(controller?.led || {}),
      psuAmps,
      milliampsPerPixel,
    },
  };
}
