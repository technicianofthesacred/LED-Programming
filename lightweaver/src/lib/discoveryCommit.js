// Committing a discovery run into a project-shaped record the rest of Studio
// already understands. Discovery never writes anything itself; here its findings
// are turned into the three values a project needs built from either a fresh
// bench walk (discoveryProjectParts) or a card that is already provisioned but
// has no matching local project file (projectSkeletonFromCardStatus). Both are
// pure — no fetch, no localStorage, no React — so they are unit-testable.
import {
  discoveryPortRoleUpdates,
  namedColorOrderFromChannelMap,
} from './stripDiscovery.js';
import {
  PORT_ROLE_STRIP,
  PORT_ROLE_UNUSED,
  normalizePortRoles,
} from './portRoles.js';
import { normalizeUsbLedColorOrder } from './usbLedColorOrder.js';

// One entry per discovered strip port, in the shape standaloneController.led.
// outputs expects (cardRuntimeProject.js): id, pin, pixels. Ports with no pixel
// count, and ports whose role is not a strip, are omitted entirely.
function outputsFromStrips(portRoles) {
  return portRoles
    .filter(entry => entry.role === PORT_ROLE_STRIP && entry.pixelCount > 0)
    .map(entry => ({ id: `strip-${entry.pin}`, pin: entry.pin, pixels: entry.pixelCount }));
}

/**
 * The project parts a discovery session has landed on: the port roles exactly
 * as portRoles.js would persist them, the named colour order the proof measured
 * (empty when unheard), and one output per confirmed strip port.
 */
export function discoveryProjectParts(session, channelProof) {
  const portRoles = normalizePortRoles(discoveryPortRoleUpdates(session));
  return {
    portRoles,
    colorOrder: namedColorOrderFromChannelMap(channelProof?.channelMap),
    outputs: outputsFromStrips(portRoles),
  };
}

/**
 * A project skeleton reconstructed from a live card's /api/status response,
 * used when a provisioned card is found but no matching project file exists
 * locally. Empty / '' values when the card reports nothing.
 */
export function projectSkeletonFromCardStatus(status = {}) {
  const reportedOutputs = Array.isArray(status?.outputs) ? status.outputs : [];
  const portRoles = normalizePortRoles(reportedOutputs.map(entry => ({
    pin: entry?.pin,
    role: entry?.pixels > 0 ? PORT_ROLE_STRIP : PORT_ROLE_UNUSED,
    pixelCount: entry?.pixels,
    controlKind: '',
  })));
  return {
    portRoles,
    colorOrder: normalizeUsbLedColorOrder(status?.outputColor?.colorOrder, ''),
    outputs: outputsFromStrips(portRoles),
  };
}