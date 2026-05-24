const DEFAULT_CHAIN_ID = 'main';

export const DEFAULT_PLAYBACK = Object.freeze({
  patternId: null,
  speed: 1,
  brightness: 1,
  hueShift: 0,
  enabled: true,
});

const patchIdForStrip = strip => `patch-${strip.id}`;

const clone = value => JSON.parse(JSON.stringify(value));

const byId = items => new Map((items || []).map(item => [item.id, item]));

const numberOr = (value, fallback) => Number.isFinite(value) ? value : fallback;

export function createDefaultPatchBoard(strips = []) {
  const patches = strips.map(strip => ({
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
  }));

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

  return copy;
}

export function mainChain(board) {
  return normalizePatchBoard(board).chains[0];
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
  const start = Math.trunc(startLed);
  const end = Math.trunc(endLed);
  const step = start <= end ? 1 : -1;
  const values = [];
  for (let led = start; step > 0 ? led <= end : led >= end; led += step) {
    values.push(led);
  }
  return values;
}

function expandStripPatch(patch, strip, startIndex, resolvedPlayback) {
  const pixels = [];
  const range = sourceLedRange(patch.source.startLed, patch.source.endLed);
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
  patch.source.startLed = Math.trunc(startLed);
  patch.source.endLed = Math.trunc(endLed);
  return board;
}

export function movePatch(board, patchId, direction) {
  if (board.physicalLocked) {
    throw new Error('Unlock setup mode before changing physical patch order.');
  }
  const chain = mainChain(board);
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
  mainChain(board).rowIds.push(id);
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

    const maxLed = (strip.pixels?.length ?? strip.pixelCount ?? 0) - 1;
    if (patch.source.startLed < 0 || patch.source.endLed < 0 || patch.source.startLed > maxLed || patch.source.endLed > maxLed) {
      warnings.push({
        code: 'endpoint-out-of-range',
        patchId: patch.id,
        message: `${patch.name} uses LEDs ${patch.source.startLed}-${patch.source.endLed}, but ${strip.name || strip.id} has LEDs 0-${maxLed}.`,
      });
      continue;
    }

    for (const led of sourceLedRange(patch.source.startLed, patch.source.endLed)) {
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
