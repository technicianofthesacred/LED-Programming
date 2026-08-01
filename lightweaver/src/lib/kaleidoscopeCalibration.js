import { createPatternLabPreviewSession } from './patternLabPreviewSession.js';
import { createCardFrameStream } from './cardFrameStream.js';

function redHex(level) {
  return `${Math.max(0, Math.min(255, Math.round(level))).toString(16).padStart(2, '0')}0000`;
}

export function buildKaleidoscopeCalibrationFrame({
  compiledWiring,
  stripId,
  pointIndices = [],
  selectedPointIndex = null,
  pulse = 0,
} = {}) {
  const points = new Set(pointIndices);
  const selectedLed = Number.isInteger(selectedPointIndex) ? pointIndices[selectedPointIndex] : null;
  const selectedLevel = 128 + 127 * Math.max(0, Math.min(1, Number(pulse) || 0));
  return (compiledWiring?.pixels || []).map(pixel => {
    if (pixel?.inactive || pixel?.stripId !== stripId || !points.has(pixel.sourceLed)) return '000000';
    return pixel.sourceLed === selectedLed ? redHex(selectedLevel) : '800000';
  });
}

export function createKaleidoscopeCalibrationSession(options = {}) {
  let physicalDelivered = false;
  let lastStatus = { state: 'idle', active: false, error: null, restored: null };
  const publish = patch => {
    lastStatus = { ...lastStatus, ...patch, physicalDelivered };
    options.onStateChange?.(lastStatus);
  };
  const streamFactory = options.createStream || (streamOptions => createCardFrameStream(streamOptions));
  const session = createPatternLabPreviewSession({
    ...options,
    fallbackLook: options.fallbackLook || {},
    onStateChange: status => publish(status),
    createStream: streamOptions => streamFactory({
      ...streamOptions,
      onHealth: health => {
        if (health?.delivered === true) {
          physicalDelivered = true;
          publish({ state: 'live', active: true, error: null });
        } else if (health?.delivered === false) {
          physicalDelivered = false;
        }
        streamOptions.onHealth?.(health);
      },
    }),
  });
  return {
    ...session,
    push(frame) {
      const accepted = session.push(frame);
      if (!accepted) {
        physicalDelivered = false;
        publish({
          state: session.status().state,
          active: session.status().active,
          error: new Error('Physical calibration frame push was not accepted.'),
        });
      }
      return accepted;
    },
    status() {
      return { ...session.status(), physicalDelivered };
    },
  };
}
