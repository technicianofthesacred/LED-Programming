import { normalizePatchBoard } from './patchBoard.js';
import { normalizeCardVisualLook } from './cardVisualLook.js';

export const ALL_SECTIONS_TARGET_ID = 'all';
export const MAX_SAVED_LOOKS = 12;
export const COMPOUND_PATTERN_TYPE = 'compound-pattern';

export function normalizeSectionVisualLook(look = {}) {
  return normalizeCardVisualLook(look);
}

export function deriveSectionTargets({
  strips = [],
  patchBoard = null,
  defaultLook = {},
} = {}) {
  const board = normalizePatchBoard(patchBoard, strips);
  const totalPixels = totalStripPixels(strips);
  const fallbackLook = normalizeSectionVisualLook(defaultLook);
  const stripOffsets = stripPixelOffsets(strips);
  const stripById = new Map(strips.map(strip => [strip.id, strip]));

  const targets = [{
    id: ALL_SECTIONS_TARGET_ID,
    zoneId: '',
    kind: 'all',
    label: 'All sections',
    pixelCount: totalPixels,
    look: fallbackLook,
  }];

  for (const patch of board.patches || []) {
    if (patch?.source?.type !== 'strip' || patch.output?.mode === 'off') continue;
    const strip = stripById.get(patch.source.stripId);
    const pixelCount = countPatchPixels(patch);
    const offset = stripOffsets.get(patch.source.stripId) || 0;
    const startLed = Number.isFinite(Number(patch.source.startLed)) ? Math.trunc(Number(patch.source.startLed)) : 0;
    targets.push({
      id: patch.id,
      zoneId: sanitizeId(patch.id),
      patchId: patch.id,
      stripId: patch.source.stripId,
      kind: 'section',
      label: String(patch.name || strip?.name || patch.id || 'Section'),
      pixelCount,
      start: offset + Math.max(0, startLed),
      end: offset + Math.max(0, startLed) + Math.max(0, pixelCount - 1),
      look: lookFromPatchPlayback(patch.playback, fallbackLook),
    });
  }

  return targets;
}

export function applyLookToPatchBoard({
  patchBoard = null,
  strips = [],
  targetId = ALL_SECTIONS_TARGET_ID,
  look = {},
} = {}) {
  const board = normalizePatchBoard(patchBoard, strips);
  const nextLook = normalizeSectionVisualLook(look);
  const isAll = !targetId || targetId === ALL_SECTIONS_TARGET_ID;
  const normalizedTarget = sanitizeId(targetId);

  for (const patch of board.patches || []) {
    if (patch?.source?.type !== 'strip' || patch.output?.mode === 'off') continue;
    const matches = isAll || patch.id === targetId || sanitizeId(patch.id) === normalizedTarget;
    if (!matches) continue;
    patch.playback = lookToPlayback(nextLook, patch.playback);
  }

  return normalizePatchBoard(board, strips);
}

export function normalizeSavedLooks(looks = []) {
  if (!Array.isArray(looks)) return [];
  const seen = new Set();
  const normalized = [];

  for (const look of looks) {
    if (!look || typeof look !== 'object') continue;
    const id = sanitizeId(look.id || look.label || `look-${normalized.length + 1}`);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push({
      id,
      type: COMPOUND_PATTERN_TYPE,
      label: String(look.label || titleFromId(id)),
      defaultLook: normalizeSectionVisualLook(look.defaultLook || look.look || {}),
      sectionLooks: normalizeSectionLooks(look.sectionLooks || look.zones || {}),
      updatedAt: Number.isFinite(Number(look.updatedAt)) ? Number(look.updatedAt) : 0,
    });
    if (normalized.length >= MAX_SAVED_LOOKS) break;
  }

  return normalized;
}

export function saveCurrentLookToController(controller = {}, {
  label = 'Saved Look',
  lookId = '',
  defaultLook = {},
  targets = [],
} = {}) {
  const id = sanitizeId(lookId || label || `look-${Date.now()}`) || `look-${Date.now()}`;
  const saved = {
    id,
    type: COMPOUND_PATTERN_TYPE,
    label: String(label || titleFromId(id)),
    defaultLook: normalizeSectionVisualLook(defaultLook),
    sectionLooks: sectionLooksFromTargets(targets),
    updatedAt: Date.now(),
  };
  const existing = normalizeSavedLooks(controller.looks);
  const looks = [
    saved,
    ...existing.filter(look => look.id !== saved.id),
  ].slice(0, MAX_SAVED_LOOKS);

  return {
    ...(controller || {}),
    defaultLook: saved.defaultLook,
    activeLookId: saved.id,
    looks,
  };
}

export function applySavedLookToPatchBoard({
  patchBoard = null,
  strips = [],
  savedLook = {},
} = {}) {
  const look = normalizeSavedLooks([{ id: 'applied-look', ...savedLook }])[0];
  if (!look) return normalizePatchBoard(patchBoard, strips);

  let board = applyLookToPatchBoard({
    patchBoard,
    strips,
    targetId: ALL_SECTIONS_TARGET_ID,
    look: look.defaultLook,
  });

  for (const [targetId, sectionLook] of Object.entries(look.sectionLooks || {})) {
    board = applyLookToPatchBoard({
      patchBoard: board,
      strips,
      targetId,
      look: sectionLook,
    });
  }

  return normalizePatchBoard(board, strips);
}

export function targetLabel(target) {
  return target?.kind === 'all' ? 'All sections' : String(target?.label || 'Section');
}

function lookFromPatchPlayback(playback = {}, fallbackLook = {}) {
  return normalizeSectionVisualLook({
    ...fallbackLook,
    ...(hasExplicit(playback.patternId) ? { patternId: playback.patternId } : {}),
    ...(hasExplicit(playback.brightness) ? { brightness: playback.brightness } : {}),
    ...(hasExplicit(playback.speed) ? { speed: playback.speed } : {}),
    ...(hasExplicit(playback.hueShift) ? { hueShift: playback.hueShift } : {}),
    ...(hasExplicit(playback.customHue) ? { customHue: playback.customHue } : {}),
    ...(hasExplicit(playback.customSaturation) ? { customSaturation: playback.customSaturation } : {}),
    ...(hasExplicit(playback.customBreathe) ? { customBreathe: playback.customBreathe } : {}),
    ...(hasExplicit(playback.customDrift) ? { customDrift: playback.customDrift } : {}),
  });
}

function lookToPlayback(look, previous = {}) {
  return {
    ...(previous || {}),
    patternId: look.patternId,
    brightness: look.brightness,
    speed: look.speed,
    hueShift: look.hueShift,
    customHue: look.customHue,
    customSaturation: look.customSaturation,
    customBreathe: look.customBreathe,
    customDrift: look.customDrift,
  };
}

function sectionLooksFromTargets(targets = []) {
  return Object.fromEntries(
    (targets || [])
      .filter(target => target?.kind === 'section' && target.id)
      .map(target => [target.id, normalizeSectionVisualLook(target.look)]),
  );
}

function normalizeSectionLooks(sectionLooks = {}) {
  if (!sectionLooks || typeof sectionLooks !== 'object') return {};
  return Object.fromEntries(
    Object.entries(sectionLooks)
      .map(([id, look]) => [sanitizeId(id), normalizeSectionVisualLook(look)])
      .filter(([id]) => Boolean(id)),
  );
}

function totalStripPixels(strips = []) {
  return strips.reduce((sum, strip) => sum + (strip.pixelCount || strip.pixels?.length || 0), 0);
}

function stripPixelOffsets(strips = []) {
  const offsets = new Map();
  let cursor = 0;
  for (const strip of strips) {
    offsets.set(strip.id, cursor);
    cursor += strip.pixelCount || strip.pixels?.length || 0;
  }
  return offsets;
}

function countPatchPixels(patch) {
  const start = Number(patch?.source?.startLed);
  const end = Number(patch?.source?.endLed);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.abs(Math.trunc(end) - Math.trunc(start)) + 1;
}

function hasExplicit(value) {
  return value !== undefined && value !== null && value !== '';
}

function sanitizeId(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleFromId(id = '') {
  return String(id || '')
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
