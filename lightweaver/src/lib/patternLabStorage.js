import { PATTERN_LAB_RECIPE_VERSION, normalizePatternLabRecipe } from './patternLabRecipe.js';

export const PATTERN_LAB_DRAFTS_KEY = 'lw_pattern_lab_drafts_v1';
export const PATTERN_LAB_DRAFTS_BACKUP_KEY = 'lw_pattern_lab_drafts_v1_backup';

function defaultStorage() {
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

function storageFrom(options) {
  return Object.hasOwn(options, 'storage') ? options.storage : defaultStorage();
}

function normalizeEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Pattern Lab draft envelope must be an object');
  if (Number(value.version) !== PATTERN_LAB_RECIPE_VERSION) throw new RangeError(`Unsupported Pattern Lab draft version: ${String(value.version)}`);
  if (!Array.isArray(value.drafts)) throw new TypeError('Pattern Lab draft envelope must contain drafts');
  return value.drafts.map(normalizePatternLabRecipe);
}

export function readPatternLabDrafts(options = {}) {
  const storage = storageFrom(options);
  if (!storage) return [];
  for (const key of [PATTERN_LAB_DRAFTS_KEY, PATTERN_LAB_DRAFTS_BACKUP_KEY]) {
    try {
      const raw = storage.getItem(key);
      if (!raw) continue;
      return normalizeEnvelope(JSON.parse(raw));
    } catch {
      // The other private copy may still contain the user's drafts.
    }
  }
  return [];
}

export function writePatternLabDrafts(drafts, options = {}) {
  const storage = storageFrom(options);
  if (!storage) return false;
  if (!Array.isArray(drafts)) throw new TypeError('Pattern Lab drafts must be an array');

  // Validate and normalize the complete next snapshot before either live copy changes.
  const normalized = drafts.map(normalizePatternLabRecipe);
  const text = JSON.stringify({ version: PATTERN_LAB_RECIPE_VERSION, drafts: normalized });
  storage.setItem(PATTERN_LAB_DRAFTS_KEY, text);
  try {
    storage.setItem(PATTERN_LAB_DRAFTS_BACKUP_KEY, text);
  } catch {
    // A successful primary write remains useful when storage is nearly full.
  }
  return normalized;
}

export function savePatternLabDraft(draft, options = {}) {
  const normalized = normalizePatternLabRecipe(draft);
  const current = readPatternLabDrafts(options);
  writePatternLabDrafts([normalized, ...current.filter(item => item.id !== normalized.id)], options);
  return normalized;
}

export function deletePatternLabDraft(id, options = {}) {
  const current = readPatternLabDrafts(options);
  const next = current.filter(item => item.id !== String(id));
  if (next.length === current.length) return false;
  writePatternLabDrafts(next, options);
  return true;
}
