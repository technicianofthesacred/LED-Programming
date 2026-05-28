export function normalizeRotaryPatternCycle(ids = [], knownPatternIds = new Set()) {
  const known = toKnownSet(knownPatternIds);
  const output = [];
  (Array.isArray(ids) ? ids : []).forEach((value) => {
    const id = String(value || '').trim();
    if (!id || output.includes(id)) return;
    if (known.size > 0 && !known.has(id)) return;
    output.push(id);
  });
  return output;
}

export function makeDefaultRotaryCycleIds({
  activePatternId = '',
  showClips = [],
  knownPatternIds = new Set(),
} = {}) {
  return normalizeRotaryPatternCycle([
    activePatternId,
    ...showClips.map(clip => clip?.patternId),
  ], knownPatternIds);
}

export function insertPatternInCycle(cycleIds = [], patternId = '', targetIndex = null, knownPatternIds = new Set()) {
  const known = toKnownSet(knownPatternIds);
  const id = String(patternId || '').trim();
  const current = normalizeRotaryPatternCycle(cycleIds, known);
  if (!id || (known.size > 0 && !known.has(id))) return current;

  const withoutDragged = current.filter(item => item !== id);
  const index = Number.isFinite(Number(targetIndex))
    ? Math.max(0, Math.min(withoutDragged.length, Number(targetIndex)))
    : withoutDragged.length;
  return [
    ...withoutDragged.slice(0, index),
    id,
    ...withoutDragged.slice(index),
  ];
}

export function getNextRotaryCyclePatternId(cycleIds = [], currentPatternId = '', knownPatternIds = new Set()) {
  const cycle = normalizeRotaryPatternCycle(cycleIds, knownPatternIds);
  if (!cycle.length) return null;
  const current = String(currentPatternId || '').trim();
  const currentIndex = cycle.indexOf(current);
  return cycle[currentIndex >= 0 ? (currentIndex + 1) % cycle.length : 0];
}

export function adjustRotaryBrightness({
  currentBrightness = 1,
  rotateDirection = 'clockwise-brighter',
  turn = 'clockwise',
  step = 0.08,
} = {}) {
  const normalizedTurn = String(turn || '').toLowerCase();
  const clockwiseBrightens = rotateDirection !== 'clockwise-dimmer';
  const shouldBrighten = normalizedTurn === 'clockwise'
    ? clockwiseBrightens
    : !clockwiseBrightens;
  const next = Number(currentBrightness) + (shouldBrighten ? Number(step) : -Number(step));
  return roundBrightness(Math.max(0, Math.min(1, Number.isFinite(next) ? next : 1)));
}

function toKnownSet(knownPatternIds = new Set()) {
  if (knownPatternIds instanceof Set) return knownPatternIds;
  if (Array.isArray(knownPatternIds)) return new Set(knownPatternIds);
  return new Set();
}

function roundBrightness(value) {
  return Math.round(value * 1000) / 1000;
}
