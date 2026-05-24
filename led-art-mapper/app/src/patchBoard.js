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

const patchForStrip = strip => ({
  id: patchIdForStrip(strip),
  name: strip.name || strip.id,
  groupId: null,
  source: {
    type: 'strip',
    stripId: strip.id,
    startLed: 0,
    endLed: Math.max(0, (strip.pixelCount ?? strip.pixels?.length ?? 1) - 1),
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
  const stripIdsWithPatch = new Set(
    board.patches
      .filter(patch => patch.source?.type === 'strip')
      .map(patch => patch.source.stripId),
  );

  for (const strip of strips) {
    if (stripIdsWithPatch.has(strip.id)) continue;
    const patch = patchForStrip(strip);
    board.patches.push(patch);
    chain.rowIds.push(patch.id);
    stripIdsWithPatch.add(strip.id);
  }
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
  ensureStripPatches(copy, strips);

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
  if (!rangeInfo.valid) return [];

  const pixels = [];
  const range = sourceLedRange(rangeInfo.startLed, rangeInfo.endLed);
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
      continue;
    }

    for (const led of sourceLedRange(rangeInfo.startLed, rangeInfo.endLed)) {
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
