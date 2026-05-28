import {
  WLED_ENCODER_ACTIONS,
  normalizeWledPhysicalControls,
} from './wledControlContract.js';
import {
  adjustRotaryBrightness,
  getNextRotaryCyclePatternId,
  makeDefaultRotaryCycleIds,
  normalizeRotaryPatternCycle,
} from './rotaryPatternCycle.js';

export function parseUsbRotaryInputLine(rawLine = '') {
  const source = String(rawLine || '').trim();
  if (!source) return null;

  const text = source.replace(/\s+/g, ' ').toLowerCase();
  const hasInputContext = /\b(lwusb\s+)?(rotary|encoder|knob|enc|button|push)\b/.test(text);
  if (!hasInputContext) return null;

  if (/\b(release|released|up)\b/.test(text)) return null;
  if (/\b(press|pressed|push|pushed|click|clicked|button)\b/.test(text)) {
    return { type: 'press' };
  }

  const valueMatch = text.match(/\b(?:turn|dir|direction|delta|step|move)=(-?\d+|cw|ccw|clockwise|counterclockwise|counter-clockwise|left|right)\b/);
  const value = valueMatch?.[1] || '';
  if (/-1|ccw|counterclockwise|counter-clockwise|left/.test(value) || /\bccw\b|\bcounter-?clockwise\b|\bleft\b/.test(text)) {
    return { type: 'rotate', turn: 'counterclockwise' };
  }
  if (/^\+?1$|cw|clockwise|right/.test(value) || /\bcw\b|\bclockwise\b|\bright\b/.test(text)) {
    return { type: 'rotate', turn: 'clockwise' };
  }
  if (/\benc(?:oder)?\s*-/.test(text) || /\bknob\s*-/.test(text)) {
    return { type: 'rotate', turn: 'counterclockwise' };
  }
  if (/\benc(?:oder)?\s*\+/.test(text) || /\bknob\s*\+/.test(text)) {
    return { type: 'rotate', turn: 'clockwise' };
  }

  return null;
}

export function selectFreshUsbRotaryEvents(events = [], {
  lastEventId = 0,
  startedAt = 0,
} = {}) {
  const normalizedLastId = Math.max(0, Number(lastEventId) || 0);
  const normalizedStartedAt = Math.max(0, Number(startedAt) || 0);
  const eligible = Array.isArray(events)
    ? events.filter(event => {
      const id = Number(event?.id) || 0;
      if (!id) return false;
      if (normalizedStartedAt && Number(event.at) && Number(event.at) < normalizedStartedAt) return false;
      return true;
    })
    : [];

  const latestEventId = eligible.reduce((max, event) => Math.max(max, Number(event.id) || 0), 0);
  const cursor = latestEventId > 0 && latestEventId < normalizedLastId
    ? 0
    : normalizedLastId;
  const freshEvents = eligible.filter(event => (Number(event.id) || 0) > cursor);
  const nextLastEventId = freshEvents.reduce(
    (max, event) => Math.max(max, Number(event.id) || 0),
    latestEventId > 0 && latestEventId < normalizedLastId ? latestEventId : normalizedLastId,
  );

  return {
    events: freshEvents,
    lastEventId: nextLastEventId,
  };
}

export function resolveRotaryInputAction({
  event = null,
  currentBrightness = 1,
  currentPatternId = '',
  showClips = [],
  physicalControls = {},
  knownPatternIds = new Set(),
  requireEnabled = true,
} = {}) {
  const controls = normalizeWledPhysicalControls(physicalControls);
  const encoder = controls.encoder;
  if ((requireEnabled && !encoder.enabled) || !event?.type) return null;

  if (event.type === 'rotate') {
    if (encoder.rotateAction !== WLED_ENCODER_ACTIONS.BRIGHTNESS || !event.turn) return null;
    return {
      type: 'brightness',
      brightness: adjustRotaryBrightness({
        currentBrightness,
        rotateDirection: encoder.rotateDirection,
        turn: event.turn,
        step: encoder.brightnessStep / 255,
      }),
    };
  }

  if (event.type === 'press') {
    if (encoder.pressAction !== WLED_ENCODER_ACTIONS.NEXT_PRESET) return null;
    const storedCycle = normalizeRotaryPatternCycle(encoder.patternCycleIds, knownPatternIds);
    const cycleIds = storedCycle.length
      ? storedCycle
      : makeDefaultRotaryCycleIds({
        activePatternId: currentPatternId,
        showClips,
        knownPatternIds,
      });
    const patternId = getNextRotaryCyclePatternId(cycleIds, currentPatternId, knownPatternIds);
    return patternId ? { type: 'pattern', patternId } : null;
  }

  return null;
}
