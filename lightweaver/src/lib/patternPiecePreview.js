import { PALETTE_DEFAULT } from '../data.js';
import { expandPatchBoard, normalizePatchBoard } from './patchBoard.js';
import { applyLookColorModifiers } from './previewColorModifiers.js';

export const PATTERN_PREVIEW_UI_STORAGE_PREFIX = 'lw_pattern_piece_preview_v1:';

function storageFor(storage) {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

function previewStorageKey(projectId) {
  return `${PATTERN_PREVIEW_UI_STORAGE_PREFIX}${String(projectId || 'default')}`;
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatViewBoxNumber(value) {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/**
 * Turn independently addressable patch-board targets into virtual preview
 * strips. A virtual strip is one exact patch range, so split/reversed ranges
 * keep their real LED count, geometry, and physical order.
 */
export function buildPatternPreviewSegments({
  strips = [],
  patchBoard = null,
  targets = [],
  resolvePatternId = patternId => patternId,
  paletteForPattern = () => PALETTE_DEFAULT,
} = {}) {
  const board = normalizePatchBoard(patchBoard, strips);
  const expanded = expandPatchBoard(board, strips);
  const pixelsByPatchId = new Map();
  for (const pixel of expanded.pixels) {
    if (!pixel?.patchId || pixel.inactive) continue;
    if (!pixelsByPatchId.has(pixel.patchId)) pixelsByPatchId.set(pixel.patchId, []);
    pixelsByPatchId.get(pixel.patchId).push(pixel);
  }

  return (targets || [])
    .filter(target => target?.kind === 'section' && target.id)
    .map(target => {
      const pixels = pixelsByPatchId.get(target.id) || [];
      if (!pixels.length) return null;
      const look = { ...(target.look || {}) };
      const sourcePatternId = String(look.patternId || 'aurora');
      const patternId = resolvePatternId(sourcePatternId) || sourcePatternId;
      return {
        id: target.id,
        label: String(target.label || target.id),
        targetId: target.id,
        sourcePatternId,
        patternId,
        pixels: pixels.map((pixel, index) => ({
          x: finite(pixel.x, 0),
          y: finite(pixel.y, 0),
          index,
          sourceLed: pixel.sourceLed,
          stripId: pixel.stripId,
        })),
        brightness: finite(look.brightness, 1),
        speed: finite(look.speed, 1),
        // Card hue shift is part of the firmware-faithful visual post-pass.
        // Leaving the frame-engine degree shift at zero prevents double use.
        hueShift: 0,
        visualLook: look,
        palette: paletteForPattern(sourcePatternId) || PALETTE_DEFAULT,
      };
    })
    .filter(Boolean);
}

/** Return a tight, padded SVG viewBox around the supplied preview segments. */
export function fitPreviewViewBox(segments = [], fallbackViewBox = '0 0 640 400') {
  const points = (segments || []).flatMap(segment => segment?.pixels || []);
  if (!points.length) return fallbackViewBox;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    const x = finite(point?.x, NaN);
    const y = finite(point?.y, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) return fallbackViewBox;

  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const padding = Math.max(4, Math.max(width, height) * 0.08);
  return [
    minX - padding,
    minY - padding,
    width + padding * 2,
    height + padding * 2,
  ].map(formatViewBoxNumber).join(' ');
}

/** Apply each virtual segment's firmware color post-pass to its pixel slice. */
export function applyPatternPreviewSegmentLooks(pixels = [], segments = [], tMs = 0) {
  let offset = 0;
  for (const segment of segments || []) {
    const count = segment?.pixels?.length || segment?.pts?.length || 0;
    if (count > 0) {
      applyLookColorModifiers(pixels.slice(offset, offset + count), tMs, segment.visualLook || {});
    }
    offset += count;
  }
  return pixels;
}

export function readPatternPreviewUiState({ projectId, targetIds = [], storage = null } = {}) {
  const validTargetIds = (targetIds || []).filter(Boolean);
  const fallbackTargetId = validTargetIds[0] || '';
  let parsed = null;
  try {
    const raw = storageFor(storage)?.getItem(previewStorageKey(projectId));
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  const rememberedTargetId = String(parsed?.lastTargetId || '');
  return {
    mode: parsed?.mode === 'piece' ? 'piece' : 'strip',
    lastTargetId: validTargetIds.includes(rememberedTargetId)
      ? rememberedTargetId
      : fallbackTargetId,
    restored: Boolean(parsed),
  };
}

export function writePatternPreviewUiState({ projectId, state, storage = null } = {}) {
  try {
    storageFor(storage)?.setItem(previewStorageKey(projectId), JSON.stringify({
      mode: state?.mode === 'piece' ? 'piece' : 'strip',
      lastTargetId: String(state?.lastTargetId || ''),
    }));
  } catch {
    // Preview preferences are optional UI state; storage failure must not block
    // pattern authoring or touch the project document.
  }
}
