const DEFAULT_CHAIN_ID = 'main';

export const DEFAULT_PLAYBACK = Object.freeze({
  patternId: null,
  speed: 1,
  brightness: 1,
  hueShift: 0,
  enabled: true,
});

const clone = value => JSON.parse(JSON.stringify(value));

const byId = items => new Map((items || []).map(item => [item.id, item]));

const numberOr = (value, fallback) => Number.isFinite(value) ? value : fallback;

const ledIndexOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
};

const patchIdForStrip = strip => `patch-${strip.id}`;

const maxLedForStrip = strip => Math.max(0, (strip.pixelCount ?? strip.pixels?.length ?? 1) - 1);

const isGeneratedStripPatch = patch =>
  patch.source?.type === 'strip' &&
  (patch.source.autoRange === true || (
    patch.source.autoRange == null &&
    patch.id === `patch-${patch.source.stripId}` &&
    patch.source.startLed === 0
  ));

const patchForStrip = strip => ({
  id: patchIdForStrip(strip),
  name: strip.name || strip.id,
  groupId: null,
  source: {
    type: 'strip',
    stripId: strip.id,
    startLed: 0,
    endLed: maxLedForStrip(strip),
    autoRange: true,
  },
  output: { mode: strip.visible === false ? 'off' : 'normal' },
  playback: {
    patternId: null,
    speed: strip.speed ?? null,
    brightness: strip.brightness ?? null,
    hueShift: strip.hueShift ?? null,
    enabled: strip.visible === false ? false : null,
  },
});

export function createDefaultPatchBoard(strips = []) {
  const patches = strips.map(strip => patchForStrip(strip));

  return {
    physicalLocked: false,
    chains: [{
      id: DEFAULT_CHAIN_ID,
      name: 'Main physical strip',
      rowIds: patches.map(patch => patch.id),
    }],
    groups: [],
    patches,
  };
}

function ensureStripPatches(board, strips) {
  const chain = board.chains[0];
  const liveStripIds = new Set(strips.map(strip => strip.id));
  const removedPatchIds = new Set();

  board.patches = board.patches.filter(patch => {
    const shouldPrune = patch.source?.type === 'strip' &&
      isGeneratedStripPatch(patch) &&
      !liveStripIds.has(patch.source.stripId);
    if (shouldPrune) removedPatchIds.add(patch.id);
    return !shouldPrune;
  });

  board.chains.forEach(item => {
    item.rowIds = item.rowIds.filter(rowId => !removedPatchIds.has(rowId));
  });

  const stripIdsWithPatch = new Set(
    board.patches
      .filter(patch => patch.source?.type === 'strip')
      .map(patch => patch.source.stripId),
  );
  const patchesById = byId(board.patches);

  for (const strip of strips) {
    const defaultPatch = patchesById.get(patchIdForStrip(strip));
    if (defaultPatch?.source?.type === 'strip' && isGeneratedStripPatch(defaultPatch)) {
      defaultPatch.source.stripId = strip.id;
      defaultPatch.source.startLed = 0;
      defaultPatch.source.endLed = maxLedForStrip(strip);
      defaultPatch.source.autoRange = true;
    }

    if (stripIdsWithPatch.has(strip.id)) continue;
    const patch = patchForStrip(strip);
    board.patches.push(patch);
    chain.rowIds.push(patch.id);
    stripIdsWithPatch.add(strip.id);
  }

  normalizeSegmentedStripRanges(board, strips);
}

export function normalizePatchBoard(board, strips = []) {
  if (!board || !Array.isArray(board.patches) || !Array.isArray(board.chains)) {
    return createDefaultPatchBoard(strips);
  }

  const copy = clone(board);
  copy.physicalLocked = copy.physicalLocked === true;
  copy.groups = Array.isArray(copy.groups) ? copy.groups : [];
  copy.patches = Array.isArray(copy.patches) ? copy.patches : [];
  copy.chains = copy.chains.length
    ? copy.chains.map(chain => ({
        id: chain.id || DEFAULT_CHAIN_ID,
        name: chain.name || 'Main physical strip',
        rowIds: Array.isArray(chain.rowIds) ? chain.rowIds : [],
      }))
    : [{ id: DEFAULT_CHAIN_ID, name: 'Main physical strip', rowIds: copy.patches.map(p => p.id) }];
  if (arguments.length > 1) ensureStripPatches(copy, strips);

  return copy;
}

export function mainChain(board) {
  return normalizePatchBoard(board).chains[0];
}

function mutableMainChain(board) {
  if (!Array.isArray(board.chains)) {
    board.chains = [];
  }

  if (!board.chains.length) {
    board.chains.push({
      id: DEFAULT_CHAIN_ID,
      name: 'Main physical strip',
      rowIds: Array.isArray(board.patches) ? board.patches.map(patch => patch.id) : [],
    });
  }

  const chain = board.chains[0];
  chain.id = chain.id || DEFAULT_CHAIN_ID;
  chain.name = chain.name || 'Main physical strip';
  if (!Array.isArray(chain.rowIds)) {
    chain.rowIds = [];
  }
  return chain;
}

export function resolvePatchPlayback(patch, board, globalPlayback = DEFAULT_PLAYBACK) {
  const groupsById = byId(board.groups);
  const group = patch.groupId ? groupsById.get(patch.groupId) : null;
  const groupPlayback = group?.playback || {};
  const patchPlayback = patch.playback || {};

  return {
    patternId: patchPlayback.patternId ?? groupPlayback.patternId ?? globalPlayback.patternId ?? DEFAULT_PLAYBACK.patternId,
    speed: patchPlayback.speed ?? groupPlayback.speed ?? globalPlayback.speed ?? DEFAULT_PLAYBACK.speed,
    brightness: patchPlayback.brightness ?? groupPlayback.brightness ?? globalPlayback.brightness ?? DEFAULT_PLAYBACK.brightness,
    hueShift: patchPlayback.hueShift ?? groupPlayback.hueShift ?? globalPlayback.hueShift ?? DEFAULT_PLAYBACK.hueShift,
    enabled: patchPlayback.enabled ?? groupPlayback.enabled ?? globalPlayback.enabled ?? DEFAULT_PLAYBACK.enabled,
  };
}

function sourceLedRange(startLed, endLed) {
  const start = ledIndexOrNull(startLed);
  const end = ledIndexOrNull(endLed);
  if (start === null || end === null) return [];
  const step = start <= end ? 1 : -1;
  const values = [];
  for (let led = start; step > 0 ? led <= end : led >= end; led += step) {
    values.push(led);
  }
  return values;
}

function sourceLedRangeWithinBounds(startLed, endLed, minLed, maxLed) {
  const start = ledIndexOrNull(startLed);
  const end = ledIndexOrNull(endLed);
  if (start === null || end === null || maxLed < minLed) return [];
  const step = start <= end ? 1 : -1;
  const boundedStart = step > 0 ? Math.max(start, minLed) : Math.min(start, maxLed);
  const boundedEnd = step > 0 ? Math.min(end, maxLed) : Math.max(end, minLed);
  if (step > 0 ? boundedStart > boundedEnd : boundedStart < boundedEnd) return [];

  const values = [];
  for (let led = boundedStart; step > 0 ? led <= boundedEnd : led >= boundedEnd; led += step) {
    values.push(led);
  }
  return values;
}

function stripLedBounds(strip) {
  return { minLed: 0, maxLed: (strip.pixels?.length ?? strip.pixelCount ?? 0) - 1 };
}

function validStripRange(source, strip) {
  const startLed = ledIndexOrNull(source?.startLed);
  const endLed = ledIndexOrNull(source?.endLed);
  if (startLed === null || endLed === null) {
    return { valid: false, reason: 'malformed', startLed, endLed };
  }

  const { minLed, maxLed } = stripLedBounds(strip);
  if (startLed < minLed || endLed < minLed || startLed > maxLed || endLed > maxLed) {
    return { valid: false, reason: 'out-of-range', startLed, endLed, maxLed };
  }

  return { valid: true, startLed, endLed, maxLed };
}

function expandStripPatch(patch, strip, startIndex, resolvedPlayback) {
  const rangeInfo = validStripRange(patch.source, strip);
  if (rangeInfo.reason === 'malformed') return [];

  const pixels = [];
  const range = sourceLedRangeWithinBounds(
    rangeInfo.startLed,
    rangeInfo.endLed,
    0,
    rangeInfo.maxLed,
  );
  for (const sourceLed of range) {
    const sourcePixel = strip.pixels?.[sourceLed];
    if (!sourcePixel) continue;
    const inactive = patch.output?.mode === 'off' || resolvedPlayback.enabled === false;
    pixels.push({
      ...sourcePixel,
      x: sourcePixel.x + (strip.offsetX || 0),
      y: sourcePixel.y + (strip.offsetY || 0),
      index: startIndex + pixels.length,
      patchId: patch.id,
      patchName: patch.name,
      stripId: strip.id,
      sourceLed,
      inactive,
      playback: resolvedPlayback,
    });
  }
  return pixels;
}

function expandOffPatch(patch, startIndex) {
  const count = Math.max(0, Math.trunc(numberOr(patch.source?.ledCount, 0)));
  return Array.from({ length: count }, (_, offset) => ({
    x: 0,
    y: 0,
    index: startIndex + offset,
    patchId: patch.id,
    patchName: patch.name,
    stripId: null,
    sourceLed: null,
    inactive: true,
    playback: { ...DEFAULT_PLAYBACK, enabled: false },
  }));
}

export function expandPatchBoard(board, strips = [], globalPlayback = DEFAULT_PLAYBACK) {
  const normalized = normalizePatchBoard(board, strips);
  const patchesById = byId(normalized.patches);
  const stripsById = byId(strips);
  const chain = mainChain(normalized);
  const pixels = [];
  const rows = [];
  const warnings = validatePatchBoard(normalized, strips);

  for (const rowId of chain.rowIds) {
    const patch = patchesById.get(rowId);
    if (!patch) continue;

    let rowPixels = [];
    if (patch.source?.type === 'off') {
      rowPixels = expandOffPatch(patch, pixels.length);
    } else if (patch.source?.type === 'strip') {
      const strip = stripsById.get(patch.source.stripId);
      if (strip) {
        const playback = resolvePatchPlayback(patch, normalized, globalPlayback);
        rowPixels = expandStripPatch(patch, strip, pixels.length, playback);
      }
    }

    rows.push({ patchId: patch.id, startIndex: pixels.length, count: rowPixels.length });
    pixels.push(...rowPixels);
  }

  pixels.forEach((pixel, index) => {
    pixel.index = index;
  });

  return { pixels, rows, warnings };
}

export function updatePatchRange(board, patchId, startLed, endLed) {
  if (board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch ranges.');
  }
  const patch = board.patches.find(p => p.id === patchId);
  if (!patch || patch.source?.type !== 'strip') return board;
  const start = ledIndexOrNull(startLed);
  const end = ledIndexOrNull(endLed);
  if (start === null || end === null) {
    throw new Error('Patch ranges must use finite LED indexes.');
  }
  patch.source.startLed = start;
  patch.source.endLed = end;
  patch.source.autoRange = false;
  delete patch.source.stripPixelCount;
  return board;
}

export function movePatch(board, patchId, direction) {
  if (board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch order.');
  }
  const chain = mutableMainChain(board);
  const index = chain.rowIds.indexOf(patchId);
  if (index < 0) return board;
  const next = direction === 'up' ? index - 1 : index + 1;
  if (next < 0 || next >= chain.rowIds.length) return board;
  const [id] = chain.rowIds.splice(index, 1);
  chain.rowIds.splice(next, 0, id);
  return board;
}

function patchForStripSegment(strip, startLed, endLed, segmentIndex, segmentCount) {
  const isFullStrip = startLed === 0 && endLed === maxLedForStrip(strip) && segmentCount === 1;
  const source = {
    type: 'strip',
    stripId: strip.id,
    startLed,
    endLed,
    autoRange: isFullStrip,
  };
  if (!isFullStrip) {
    source.stripPixelCount = maxLedForStrip(strip) + 1;
  }

  return {
    id: isFullStrip ? patchIdForStrip(strip) : `patch-${strip.id}-${startLed}-${endLed}`,
    name: isFullStrip
      ? (strip.name || strip.id)
      : `${strip.name || strip.id} ${segmentIndex + 1}`,
    groupId: null,
    source,
    output: { mode: strip.visible === false ? 'off' : 'normal' },
    playback: {
      patternId: null,
      speed: strip.speed ?? null,
      brightness: strip.brightness ?? null,
      hueShift: strip.hueShift ?? null,
      enabled: strip.visible === false ? false : null,
    },
  };
}

function sliceStripIntoPatchesInternal(board, strip, cutIndexes = []) {
  const maxLed = maxLedForStrip(strip);
  if (maxLed < 0) return board;

  const cuts = [...new Set((cutIndexes || [])
    .map(value => ledIndexOrNull(value))
    .filter(value => value !== null && value >= 0 && value < maxLed))]
    .sort((a, b) => a - b);

  const ranges = [];
  let startLed = 0;
  for (const cut of cuts) {
    ranges.push([startLed, cut]);
    startLed = cut + 1;
  }
  ranges.push([startLed, maxLed]);

  const oldStripPatches = board.patches
    .filter(patch => patch.source?.type === 'strip' && patch.source.stripId === strip.id);
  const oldPatchesById = byId(oldStripPatches);
  const nextPatches = ranges.map(([start, end], index) =>
    patchForStripSegment(strip, start, end, index, ranges.length));
  nextPatches.forEach(patch => {
    const oldPatchId = matchingPatchIdForSpan(oldStripPatches, patchSpan(patch));
    const oldPatch = oldPatchesById.get(oldPatchId);
    if (!oldPatch) return;
    patch.groupId = oldPatch.groupId ?? null;
    patch.output = oldPatch.output ? clone(oldPatch.output) : patch.output;
    patch.playback = oldPatch.playback ? clone(oldPatch.playback) : patch.playback;
  });
  const selectedPatchIds = new Set(
    oldStripPatches.map(patch => patch.id),
  );
  const firstPatchIndex = board.patches.findIndex(
    patch => patch.source?.type === 'strip' && patch.source.stripId === strip.id,
  );
  const retainedPatches = board.patches.filter(
    patch => !(patch.source?.type === 'strip' && patch.source.stripId === strip.id),
  );
  const insertPatchIndex = firstPatchIndex >= 0 ? firstPatchIndex : retainedPatches.length;
  retainedPatches.splice(insertPatchIndex, 0, ...nextPatches);
  board.patches = retainedPatches;

  const chain = mutableMainChain(board);
  const firstRowIndex = chain.rowIds.findIndex(rowId => selectedPatchIds.has(rowId));
  chain.rowIds = chain.rowIds.filter(rowId => !selectedPatchIds.has(rowId));
  const insertRowIndex = firstRowIndex >= 0 ? firstRowIndex : chain.rowIds.length;
  chain.rowIds.splice(insertRowIndex, 0, ...nextPatches.map(patch => patch.id));
  return board;
}

export function sliceStripIntoPatches(board, strip, cutIndexes = []) {
  if (board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch ranges.');
  }
  return sliceStripIntoPatchesInternal(board, strip, cutIndexes);
}

function patchSpan(patch) {
  if (patch?.source?.type !== 'strip') return null;
  const start = ledIndexOrNull(patch.source.startLed);
  const end = ledIndexOrNull(patch.source.endLed);
  if (start === null || end === null) return null;
  return { min: Math.min(start, end), max: Math.max(start, end) };
}

function stripPatchesInVisualOrder(board, stripId) {
  return board.patches
    .filter(patch => patch.source?.type === 'strip' && patch.source.stripId === stripId)
    .sort((a, b) => (patchSpan(a)?.min ?? 0) - (patchSpan(b)?.min ?? 0));
}

function spanOverlapLength(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.min(a.max, b.max) - Math.max(a.min, b.min) + 1);
}

function matchingPatchIdForSpan(patches, span) {
  let bestPatchId = null;
  let bestOverlap = 0;
  for (const patch of patches) {
    const overlap = spanOverlapLength(patchSpan(patch), span);
    if (overlap > bestOverlap) {
      bestPatchId = patch.id;
      bestOverlap = overlap;
    }
  }
  return bestPatchId;
}

function matchingPatchesForSpan(patches, span) {
  if (!span) return { patches: [], preserveDirection: false };
  const containedPatches = patches.filter(patch => {
    const nextSpan = patchSpan(patch);
    return spanOverlapLength(nextSpan, span) > 0 &&
      nextSpan.min >= span.min &&
      nextSpan.max <= span.max;
  });

  if (containedPatches.length) return { patches: containedPatches, preserveDirection: true };
  const patchId = matchingPatchIdForSpan(patches, span);
  const patch = patches.find(item => item.id === patchId);
  return { patches: patch ? [patch] : [], preserveDirection: false };
}

function sourceRunsReverse(patch) {
  const start = ledIndexOrNull(patch?.source?.startLed);
  const end = ledIndexOrNull(patch?.source?.endLed);
  return start !== null && end !== null && start > end;
}

function orientPatchSource(patch, reverse) {
  const span = patchSpan(patch);
  if (!span) return;
  patch.source.startLed = reverse ? span.max : span.min;
  patch.source.endLed = reverse ? span.min : span.max;
  patch.source.autoRange = false;
}

function hasContiguousNaturalStripRows(rowIds, stripIds) {
  if (!stripIds.length) return false;
  const stripIdSet = new Set(stripIds);
  const firstIndex = rowIds.findIndex(rowId => stripIdSet.has(rowId));
  if (firstIndex < 0) return false;
  const rowSlice = rowIds.slice(firstIndex, firstIndex + stripIds.length);
  return rowSlice.length === stripIds.length &&
    rowSlice.every((rowId, index) => rowId === stripIds[index]) &&
    rowIds.filter(rowId => stripIdSet.has(rowId)).length === stripIds.length;
}

export function sliceStripIntoPatchesPreservingRoute(board, strip, cutIndexes, options = {}) {
  if (options.respectLock !== false && board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch ranges.');
  }
  const oldStripPatches = stripPatchesInVisualOrder(board, strip.id);
  const oldStripIds = oldStripPatches.map(patch => patch.id);
  const oldStripIdSet = new Set(oldStripIds);
  const oldChain = mutableMainChain(board);
  const oldRowIds = [...oldChain.rowIds];
  const hasNaturalRoute = hasContiguousNaturalStripRows(oldRowIds, oldStripIds) &&
    oldStripPatches.every(patch => !sourceRunsReverse(patch));

  sliceStripIntoPatchesInternal(board, strip, cutIndexes);
  if (hasNaturalRoute) return board;

  const nextStripPatches = stripPatchesInVisualOrder(board, strip.id);
  const currentPatchIds = new Set(board.patches.map(patch => patch.id));
  const oldPatchesById = byId(oldStripPatches);
  const nextRowIds = [];
  for (const rowId of oldRowIds) {
    if (!oldStripIdSet.has(rowId)) {
      if (currentPatchIds.has(rowId) && !nextRowIds.includes(rowId)) nextRowIds.push(rowId);
      continue;
    }

    const oldPatch = oldPatchesById.get(rowId);
    const match = matchingPatchesForSpan(nextStripPatches, patchSpan(oldPatch));
    const matchedPatches = sourceRunsReverse(oldPatch) ? [...match.patches].reverse() : match.patches;
    for (const nextPatch of matchedPatches) {
      if (match.preserveDirection) orientPatchSource(nextPatch, sourceRunsReverse(oldPatch));
      if (!nextRowIds.includes(nextPatch.id)) nextRowIds.push(nextPatch.id);
    }
  }
  mutableMainChain(board).rowIds = nextRowIds;
  return board;
}

function normalizeSegmentedStripRanges(board, strips) {
  for (const strip of strips) {
    const patches = stripPatchesInVisualOrder(board, strip.id);
    if (patches.length <= 1) continue;
    let expectedStart = 0;
    let hasResizableCoverage = true;
    let savedMaxLed = -1;
    for (const patch of patches) {
      const span = patchSpan(patch);
      if (!span || span.min !== expectedStart) {
        hasResizableCoverage = false;
        break;
      }
      const savedPixelCount = ledIndexOrNull(patch.source?.stripPixelCount);
      if (savedPixelCount !== null && savedPixelCount > 0) {
        savedMaxLed = Math.max(savedMaxLed, savedPixelCount - 1);
      }
      expectedStart = span.max + 1;
    }
    if (!hasResizableCoverage) continue;
    const maxLed = maxLedForStrip(strip);
    const coverageEnd = expectedStart - 1;
    const coversSavedStrip = savedMaxLed >= 0 && coverageEnd === savedMaxLed;
    const coversCurrentStrip = coverageEnd === maxLed;
    const needsBoundsShrink = coverageEnd > maxLed;
    if (!coversSavedStrip && !coversCurrentStrip && !needsBoundsShrink) continue;
    const cuts = patches
      .slice(0, -1)
      .map(patch => patchSpan(patch)?.max)
      .filter(value => Number.isFinite(value) && value < maxLed);
    sliceStripIntoPatchesPreservingRoute(board, strip, cuts, { respectLock: false });
  }
}

export function cutsForStrip(board, stripId) {
  const normalized = normalizePatchBoard(board);
  const patches = stripPatchesInVisualOrder(normalized, stripId);

  return patches.slice(0, -1)
    .map(patch => patchSpan(patch)?.max)
    .filter(value => Number.isFinite(value));
}

export function nudgeStripCut(board, strip, cutLed, delta) {
  if (board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch ranges.');
  }
  const step = Math.sign(Number(delta) || 0);
  if (step === 0) return board;

  const cuts = cutsForStrip(board, strip.id);
  const index = cuts.indexOf(ledIndexOrNull(cutLed));
  if (index < 0) return board;

  const maxLed = maxLedForStrip(strip);
  const previousLimit = index === 0 ? 0 : cuts[index - 1] + 1;
  const nextLimit = index === cuts.length - 1 ? maxLed - 1 : cuts[index + 1] - 1;
  const nextCut = cuts[index] + step;
  if (nextCut < previousLimit || nextCut > nextLimit) return board;

  const nextCuts = [...cuts];
  nextCuts[index] = nextCut;
  return sliceStripIntoPatchesPreservingRoute(board, strip, nextCuts);
}

export function deleteStripCut(board, strip, cutLed) {
  if (board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch ranges.');
  }
  const cut = ledIndexOrNull(cutLed);
  const cuts = cutsForStrip(board, strip.id);
  if (!cuts.includes(cut)) return board;
  const nextCuts = cuts.filter(value => value !== cut);
  return sliceStripIntoPatchesPreservingRoute(board, strip, nextCuts);
}

export function applyPatchRouteOrder(board, patchIds = []) {
  if (board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch order.');
  }
  const patchesById = byId(board.patches);
  const patchIdSet = new Set(board.patches.map(patch => patch.id));
  const uniqueIds = [];
  for (const patchId of patchIds) {
    if (!patchIdSet.has(patchId) || uniqueIds.includes(patchId)) continue;
    uniqueIds.push(patchId);
  }
  const chain = mutableMainChain(board);
  const remainingStripIds = [...uniqueIds];
  const nextRowIds = [];
  for (const rowId of chain.rowIds) {
    const patch = patchesById.get(rowId);
    if (!patch) continue;
    if (patch.source?.type === 'strip') {
      if (remainingStripIds.length) nextRowIds.push(remainingStripIds.shift());
      continue;
    }
    if (!nextRowIds.includes(rowId)) nextRowIds.push(rowId);
  }
  nextRowIds.push(...remainingStripIds);
  chain.rowIds = nextRowIds;
  return board;
}

export function addOffPatch(board, ledCount = 1) {
  if (board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch order.');
  }
  const id = `off-${Date.now().toString(36)}`;
  const patch = {
    id,
    name: `Off ${Math.max(1, Math.trunc(ledCount))} LEDs`,
    groupId: null,
    source: { type: 'off', ledCount: Math.max(1, Math.trunc(ledCount)) },
    output: { mode: 'off' },
    playback: {},
  };
  board.patches.push(patch);
  mutableMainChain(board).rowIds.push(id);
  return patch;
}

// ── Chain-order primitives ───────────────────────────────────────────────
// The chain (`chains[0].rowIds`) is the physical wire order and the sole
// authority for pixel addressing. These pure helpers read/reorder the chain
// without ever consulting the `strips[]` array order for offsets.

// Number of LED addresses a strip patch reserves, resolved exactly the way
// expandStripPatch (and therefore expandPatchBoard) resolves them: clamp the
// stored range to the strip bounds and count the LEDs it walks.
function stripPatchAddressSpan(patch, strip) {
  if (!strip) return 0;
  const rangeInfo = validStripRange(patch.source, strip);
  if (rangeInfo.reason === 'malformed') return 0;
  return sourceLedRangeWithinBounds(rangeInfo.startLed, rangeInfo.endLed, 0, rangeInfo.maxLed).length;
}

// The chain's row order, falling back to patches-array order when a board has
// no chain yet (raw pre-normalization input). Never injects phantom rows.
export function chainRowIds(board) {
  const patches = Array.isArray(board?.patches) ? board.patches : [];
  const rowIds = board?.chains?.[0]?.rowIds;
  return Array.isArray(rowIds) && rowIds.length ? rowIds : patches.map(patch => patch.id);
}

// Map<patchId, startOffset> accumulated along the chain (rowIds order). A strip
// patch reserves its resolved LED span (clamped to strip bounds exactly like
// expandStripPatch); an off patch reserves its ledCount. Reads the board as
// given — strip patches are NOT auto-injected — so callers keep byte-identical
// address sets regardless of which strips[] they pass for span resolution.
export function chainPixelOffsets(board, strips = []) {
  const patchesById = byId(Array.isArray(board?.patches) ? board.patches : []);
  const stripsById = byId(strips);
  const offsets = new Map();
  let cursor = 0;
  for (const rowId of chainRowIds(board)) {
    const patch = patchesById.get(rowId);
    if (!patch) continue;
    offsets.set(patch.id, cursor);
    if (patch.source?.type === 'off') {
      cursor += Math.max(0, Math.trunc(numberOr(patch.source?.ledCount, 0)));
    } else if (patch.source?.type === 'strip') {
      cursor += stripPatchAddressSpan(patch, stripsById.get(patch.source.stripId));
    }
  }
  return offsets;
}

export function chainAddressCount(board, strips = []) {
  const patchesById = byId(Array.isArray(board?.patches) ? board.patches : []);
  const stripsById = byId(strips);
  let total = 0;
  for (const rowId of chainRowIds(board)) {
    const patch = patchesById.get(rowId);
    if (patch?.source?.type === 'off') {
      total += Math.max(0, Math.trunc(numberOr(patch.source.ledCount, 0)));
    } else if (patch?.source?.type === 'strip') {
      total += stripPatchAddressSpan(patch, stripsById.get(patch.source.stripId));
    }
  }
  return total;
}

// Strip ids in chain order, deduped (a split strip appears once, at its first
// occurrence). Any strip with no patch in the chain is appended at the end so
// UI lists never lose a strip.
export function orderedStripIdsFromChain(board, strips = []) {
  const normalized = normalizePatchBoard(board, strips);
  const patchesById = byId(normalized.patches);
  const chain = mainChain(normalized);
  const ordered = [];
  const seen = new Set();
  for (const rowId of chain.rowIds) {
    const patch = patchesById.get(rowId);
    if (patch?.source?.type !== 'strip') continue;
    const stripId = patch.source.stripId;
    if (seen.has(stripId)) continue;
    seen.add(stripId);
    ordered.push(stripId);
  }
  for (const strip of strips) {
    if (seen.has(strip.id)) continue;
    seen.add(strip.id);
    ordered.push(strip.id);
  }
  return ordered;
}

// Reads which strip a chain row belongs to, or null for off/unknown rows.
function stripIdForRow(patchesById, rowId) {
  const patch = patchesById.get(rowId);
  return patch?.source?.type === 'strip' ? patch.source.stripId : null;
}

// Re-lay a reordered strip-patch sequence back into the chain's strip slots,
// leaving off (non-strip) rows pinned to their positions. Mirrors the slot-fill
// approach in applyPatchRouteOrder.
function relayStripSlots(rowIds, patchesById, newStripPatchIds) {
  let cursor = 0;
  return rowIds.map(rowId => {
    if (stripIdForRow(patchesById, rowId) !== null) {
      return newStripPatchIds[cursor++] ?? rowId;
    }
    return rowId;
  });
}

// Move every patch belonging to each dragged strip as one contiguous block
// (each strip keeps its internal split order) to immediately after the target
// strip's last row. Off rows keep their positions. Returns a new board.
export function moveStripRowsInChain(board, draggedStripIds = [], targetStripId = null) {
  const next = normalizePatchBoard(board);
  const chain = mutableMainChain(next);
  const patchesById = byId(next.patches);
  const rowIds = [...chain.rowIds];

  const draggedSet = new Set((draggedStripIds || []).filter(id => id != null));
  if (!draggedSet.size || targetStripId == null || draggedSet.has(targetStripId)) {
    return next;
  }

  const stripPatchIds = rowIds.filter(rowId => stripIdForRow(patchesById, rowId) !== null);
  const draggedBlock = stripPatchIds.filter(rowId => draggedSet.has(stripIdForRow(patchesById, rowId)));
  if (!draggedBlock.length) return next;
  const remaining = stripPatchIds.filter(rowId => !draggedSet.has(stripIdForRow(patchesById, rowId)));

  let insertAfter = -1;
  remaining.forEach((rowId, index) => {
    if (stripIdForRow(patchesById, rowId) === targetStripId) insertAfter = index;
  });
  if (insertAfter < 0) return next;

  const newStripPatchIds = [
    ...remaining.slice(0, insertAfter + 1),
    ...draggedBlock,
    ...remaining.slice(insertAfter + 1),
  ];
  chain.rowIds = relayStripSlots(rowIds, patchesById, newStripPatchIds);
  return next;
}

// Rebuild the chain so strip rows follow the strips[] array order (each strip's
// split patches ordered by ascending LED span). Off rows stay at their slots.
// Bypasses physicalLocked the way sliceStripIntoPatchesPreservingRoute does.
// Returns a new board.
export function migrateChainToStripOrder(board, strips = []) {
  const next = normalizePatchBoard(board, strips);
  const chain = mutableMainChain(next);
  const patchesById = byId(next.patches);
  const seen = new Set();
  chain.rowIds = chain.rowIds.filter(rowId => {
    if (!patchesById.has(rowId) || seen.has(rowId)) return false;
    seen.add(rowId);
    return true;
  });
  return next;
}

export function validatePatchBoard(board, strips = []) {
  const normalized = normalizePatchBoard(board, strips);
  const stripsById = byId(strips);
  const warnings = [];
  const seenSourceLeds = new Set();

  if (!normalized.physicalLocked) {
    warnings.push({
      code: 'physical-map-unlocked',
      message: 'Physical map is unlocked, so setup edits can still change exported LED addresses.',
    });
  }

  for (const patch of normalized.patches) {
    if (patch.source?.type === 'off') {
      if (!Number.isFinite(patch.source.ledCount) || patch.source.ledCount <= 0) {
        warnings.push({
          code: 'off-count-invalid',
          patchId: patch.id,
          message: `${patch.name} must reserve at least one LED address.`,
        });
      }
      warnings.push({
        code: 'off-block',
        patchId: patch.id,
        message: `${patch.name} reserves ${patch.source.ledCount} LED addresses and outputs black in Lightweaver live output.`,
      });
      continue;
    }

    if (patch.source?.type !== 'strip') continue;
    const strip = stripsById.get(patch.source.stripId);
    if (!strip) {
      warnings.push({
        code: 'missing-source',
        patchId: patch.id,
        message: `${patch.name} references a missing source strip.`,
      });
      continue;
    }

    const rangeInfo = validStripRange(patch.source, strip);
    if (rangeInfo.reason === 'malformed') {
      warnings.push({
        code: 'range-invalid',
        patchId: patch.id,
        message: `${patch.name} has malformed LED range endpoints.`,
      });
      continue;
    }

    if (rangeInfo.reason === 'out-of-range') {
      warnings.push({
        code: 'endpoint-out-of-range',
        patchId: patch.id,
        message: `${patch.name} uses LEDs ${patch.source.startLed}-${patch.source.endLed}, but ${strip.name || strip.id} has LEDs 0-${rangeInfo.maxLed}.`,
      });
    }

    for (const led of sourceLedRangeWithinBounds(rangeInfo.startLed, rangeInfo.endLed, 0, rangeInfo.maxLed)) {
      const key = `${patch.source.stripId}:${led}`;
      if (seenSourceLeds.has(key)) {
        warnings.push({
          code: 'overlap',
          patchId: patch.id,
          message: `${patch.name} reuses ${patch.source.stripId} LED ${led}, so that coordinate will be stacked in export.`,
        });
        break;
      }
      seenSourceLeds.add(key);
    }
  }

  return warnings;
}
