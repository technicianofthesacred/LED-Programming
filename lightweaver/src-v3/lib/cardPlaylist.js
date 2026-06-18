import { DEFAULT_CARD_PATTERN_BANK } from './cardRuntimeContract.js';

export const CARD_PLAYLIST_LIMIT = 32;

const PATTERN_BY_ID = new Map(DEFAULT_CARD_PATTERN_BANK.map(pattern => [pattern.id, pattern]));

export function normalizeCardPlaylist(playlist = [], {
  savedLooks = [],
  fallbackPatternIds = [],
  allowEmpty = false,
} = {}) {
  const savedLookById = new Map((Array.isArray(savedLooks) ? savedLooks : [])
    .filter(Boolean)
    .map(look => [sanitizeId(look.id), look]));
  const input = Array.isArray(playlist) ? playlist : [];
  const normalized = [];
  const usedIds = new Set();

  const pushPattern = (item = {}, index = normalized.length) => {
    const patternId = sanitizeId(item.patternId || item.pattern || item.preset || item.id);
    const pattern = PATTERN_BY_ID.get(patternId);
    if (!pattern) return;
    const requestedId = sanitizeId(item.id || patternId);
    normalized.push({
      id: uniqueId(requestedId || patternId, usedIds),
      type: 'pattern',
      patternId,
      label: String(item.label || pattern.label || titleFromId(patternId)),
      enabled: item.enabled !== false,
      createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : index,
    });
  };

  const pushCombo = (item = {}, index = normalized.length) => {
    const lookId = sanitizeId(item.lookId || item.comboId || item.id);
    const savedLook = savedLookById.get(lookId);
    if (!savedLook) return;
    const requestedId = sanitizeId(item.id || `combo-${lookId}`);
    const baseId = requestedId === lookId ? `combo-${lookId}` : requestedId;
    normalized.push({
      id: uniqueId(baseId, usedIds),
      type: 'combo',
      lookId,
      label: String(item.label || savedLook.label || titleFromId(lookId)),
      enabled: item.enabled !== false,
      createdAt: Number.isFinite(Number(item.createdAt)) ? Number(item.createdAt) : index,
    });
  };

  input.forEach((item, index) => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'combo' || item.lookId || item.comboId) {
      pushCombo(item, index);
      return;
    }
    pushPattern(item, index);
  });

  if (!normalized.length) {
    const fallbackIds = uniqueStrings(fallbackPatternIds).length
      ? uniqueStrings(fallbackPatternIds)
      : allowEmpty ? [] : DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id);
    fallbackIds.forEach((patternId, index) => pushPattern({ patternId }, index));
  }

  return normalized.slice(0, CARD_PLAYLIST_LIMIT);
}

export function playlistFromPatternCycleIds(patternCycleIds = [], {
  startupPatternId = '',
} = {}) {
  return normalizeCardPlaylist([], {
    fallbackPatternIds: [
      startupPatternId,
      ...(Array.isArray(patternCycleIds) ? patternCycleIds : []),
    ].filter(Boolean),
  });
}

export function isDefaultPatternCycle(ids = []) {
  const normalized = uniqueStrings(ids);
  const defaults = DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id);
  return normalized.length === defaults.length && normalized.every((id, index) => id === defaults[index]);
}

export function isImplicitDefaultPatternPlaylist(playlist = []) {
  const input = Array.isArray(playlist) ? playlist : [];
  const defaults = DEFAULT_CARD_PATTERN_BANK.map(pattern => pattern.id);
  if (input.length !== defaults.length) return false;
  return input.every((item, index) => {
    const patternId = sanitizeId(item?.patternId || item?.pattern || item?.preset || item?.id);
    const createdAt = Number(item?.createdAt);
    const defaultCreatedAt = !Number.isFinite(createdAt) || createdAt === index;
    return patternId === defaults[index] &&
      (!item?.type || item.type === 'pattern') &&
      item?.enabled !== false &&
      defaultCreatedAt;
  });
}

export function deriveLegacyPatternCycleIds(playlist = []) {
  return uniqueStrings((Array.isArray(playlist) ? playlist : [])
    .filter(item => item?.type === 'pattern' && item.enabled !== false)
    .map(item => item.patternId));
}

export function derivePlaylistLookIds(playlist = []) {
  return uniqueStrings((Array.isArray(playlist) ? playlist : [])
    .filter(item => item?.enabled !== false)
    .map(item => item.id));
}

export function playlistContainsPattern(playlist = [], patternId = '') {
  const id = sanitizeId(patternId);
  return (Array.isArray(playlist) ? playlist : [])
    .some(item => item?.type === 'pattern' && item.patternId === id);
}

export function playlistContainsCombo(playlist = [], lookId = '') {
  const id = sanitizeId(lookId);
  return (Array.isArray(playlist) ? playlist : [])
    .some(item => item?.type === 'combo' && item.lookId === id);
}

export function playlistLabels(playlist = [], limit = 3) {
  return (Array.isArray(playlist) ? playlist : [])
    .filter(item => item?.enabled !== false)
    .slice(0, limit)
    .map(item => item.label || item.patternId || item.lookId || item.id);
}

export function makePatternPlaylistItem(patternId = '') {
  const id = sanitizeId(patternId);
  const pattern = PATTERN_BY_ID.get(id);
  if (!pattern) return null;
  return {
    id,
    type: 'pattern',
    patternId: id,
    label: pattern.label || titleFromId(id),
    enabled: true,
    createdAt: Date.now(),
  };
}

export function makeComboPlaylistItem(savedLook = {}) {
  const lookId = sanitizeId(savedLook.id);
  if (!lookId) return null;
  return {
    id: `combo-${lookId}`,
    type: 'combo',
    lookId,
    label: savedLook.label || titleFromId(lookId),
    enabled: true,
    createdAt: Date.now(),
  };
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const id = sanitizeId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function uniqueId(base = 'playlist-item', usedIds) {
  const cleanBase = sanitizeId(base) || 'playlist-item';
  let candidate = cleanBase;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${cleanBase}-${suffix++}`;
  }
  usedIds.add(candidate);
  return candidate;
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
