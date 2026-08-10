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
import { createDefaultPatchBoard } from './patchBoard.js';

// One entry per discovered strip port, in the shape standaloneController.led.
// outputs expects (cardRuntimeProject.js): id, pin, pixels. Ports with no pixel
// count, and ports whose role is not a strip, are omitted entirely.
function outputsFromStrips(portRoles) {
  return portRoles
    .filter(entry => entry.role === PORT_ROLE_STRIP && entry.pixelCount > 0)
    .map(entry => ({ id: `strip-${entry.pin}`, pin: entry.pin, pixels: entry.pixelCount }));
}

function provisionalLayoutFromOutputs(outputs) {
  const strips = outputs.map((output, index) => {
    const count = Math.max(1, Math.trunc(Number(output.pixels) || 1));
    const startX = 80;
    const y = 100 + index * 90;
    const span = count * 2;
    const endX = startX + span;
    const pixels = Array.from({ length: count }, (_, pixelIndex) => ({
      x: count === 1 ? startX : startX + (span * pixelIndex) / (count - 1),
      y,
      index: pixelIndex,
    }));
    return {
      id: output.id,
      name: `GPIO ${output.pin}`,
      pathData: `M ${startX} ${y} L ${endX} ${y}`,
      closed: false,
      svgLength: span,
      pixelCount: count,
      pixels,
      color: 'oklch(80% 0.13 72)',
      x: 0,
      y: 0,
      emit: 'omni',
      angle: 0,
      reversed: false,
      speed: 1,
      brightness: 1,
      hueShift: 0,
      patternId: null,
    };
  });
  const runs = outputs.map(output => ({
    id: `run-${output.id}`,
    type: 'strip',
    source: { stripId: output.id, from: 0, to: output.pixels - 1 },
    directionPolicy: 'flexible',
    physicalDirection: 'source-forward',
    seamLed: null,
    verified: false,
  }));
  const wiringOutputs = outputs.map((output, index) => ({
    id: `out${index + 1}`,
    name: `GPIO ${output.pin}`,
    pin: output.pin,
    runIds: [`run-${output.id}`],
  }));
  return {
    strips,
    patchBoard: createDefaultPatchBoard(strips),
    wiring: {
      version: 1,
      locked: false,
      verified: false,
      controllerAnchor: null,
      outputs: wiringOutputs,
      runs,
    },
  };
}

/**
 * The project parts a discovery session has landed on: the port roles exactly
 * as portRoles.js would persist them, the named colour order the proof measured
 * (empty when unheard), and one output per confirmed strip port.
 */
export function discoveryProjectParts(session, channelProof) {
  const portRoles = normalizePortRoles(discoveryPortRoleUpdates(session));
  const outputs = outputsFromStrips(portRoles);
  return {
    portRoles,
    colorOrder: namedColorOrderFromChannelMap(channelProof?.channelMap),
    outputs,
    ...provisionalLayoutFromOutputs(outputs),
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
  const verified = status?.knownGoodProject === true && status?.outputReady === true;
  const strips = [];
  const runs = [];
  const wiringOutputs = [];
  for (const [outputIndex, output] of reportedOutputs.entries()) {
    const outputPixels = Math.max(0, Math.trunc(Number(output?.pixels) || 0));
    if (!outputPixels) continue;
    const outputId = /^out\d+$/i.test(String(output?.id || '')) ? String(output.id) : `out${outputIndex + 1}`;
    const reportedSegments = Array.isArray(output?.segments) && output.segments.length
      ? output.segments
      : [{ id: `run-strip-${strips.length + 1}`, count: outputPixels, direction: 'forward' }];
    const runIds = [];
    for (const segment of reportedSegments) {
      const count = Math.max(0, Math.trunc(Number(segment?.count) || 0));
      if (!count) continue;
      const runId = String(segment?.id || `run-strip-${strips.length + 1}`);
      const stripId = runId.replace(/^run-/, '') || `strip-${strips.length + 1}`;
      const y = 100 + strips.length * 70;
      const startX = 80;
      const endX = 560;
      const span = endX - startX;
      const pixels = Array.from({ length: count }, (_, index) => ({
        x: count === 1 ? startX : startX + (span * index) / (count - 1),
        y,
        index,
      }));
      strips.push({
        id: stripId,
        name: reportedSegments.length === 1 ? (status?.piece?.name || 'Line') : `Line ${strips.length + 1}`,
        pathData: `M ${startX} ${y} L ${endX} ${y}`,
        closed: false,
        svgLength: span,
        pixelCount: count,
        pixels,
        color: 'oklch(80% 0.13 72)',
        x: 0,
        y: 0,
        emit: 'omni',
        angle: 0,
        reversed: segment?.direction === 'reverse',
        speed: 1,
        brightness: 1,
        hueShift: 0,
        patternId: null,
      });
      runs.push({
        id: runId,
        type: 'strip',
        source: { stripId, from: 0, to: count - 1 },
        directionPolicy: 'flexible',
        physicalDirection: segment?.direction === 'reverse' ? 'source-reverse' : 'source-forward',
        seamLed: null,
        verified,
      });
      runIds.push(runId);
    }
    wiringOutputs.push({
      id: outputId,
      name: String(output?.name || `Output ${outputIndex + 1}`),
      pin: Number(output?.pin),
      runIds,
    });
  }
  const patchBoard = createDefaultPatchBoard(strips);
  patchBoard.physicalLocked = verified;
  return {
    portRoles,
    colorOrder: normalizeUsbLedColorOrder(status?.led?.colorOrder || status?.outputColor?.colorOrder, ''),
    led: {
      ...(status?.led?.type ? { type: String(status.led.type) } : {}),
      ...(Number.isSafeInteger(Number(status?.led?.maxMilliamps ?? status?.maxMilliamps))
        ? { maxMilliamps: Number(status?.led?.maxMilliamps ?? status?.maxMilliamps) }
        : {}),
    },
    outputs: reportedOutputs
      .filter(output => Number(output?.pixels) > 0)
      .map(output => ({
        id: /^out\d+$/i.test(String(output?.id || '')) ? String(output.id) : `strip-${output.pin}`,
        pin: Number(output.pin),
        pixels: Math.trunc(Number(output.pixels)),
      })),
    strips,
    patchBoard,
    wiring: {
      version: 1,
      locked: verified,
      verified,
      controllerAnchor: null,
      outputs: wiringOutputs,
      runs,
    },
  };
}
