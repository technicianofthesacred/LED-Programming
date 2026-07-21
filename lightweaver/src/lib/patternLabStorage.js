import { PATTERN_LAB_RECIPE_VERSION, assertPatternLabJsonSafe, normalizePatternLabRecipe } from './patternLabRecipe.js';

export const PATTERN_LAB_DRAFTS_KEY = 'lw_pattern_lab_drafts_v1';
export const PATTERN_LAB_DRAFTS_BACKUP_KEY = 'lw_pattern_lab_drafts_v1_backup';

function defaultStorage() {
  try {
    if ('window' in globalThis) return globalThis.window?.localStorage || null;
    if ('localStorage' in globalThis) return globalThis.localStorage || null;
  } catch {
    return null;
  }
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

export function readPatternLabDraftState(options = {}) {
  const storage = storageFrom(options);
  if (!storage) return { status: 'unavailable', drafts: [] };
  let recoveryFailed = false;
  for (const key of [PATTERN_LAB_DRAFTS_KEY, PATTERN_LAB_DRAFTS_BACKUP_KEY]) {
    let raw;
    try {
      raw = storage.getItem(key);
    } catch {
      return { status: 'unavailable', drafts: [] };
    }
    if (!raw) continue;
    try {
      return { status: 'restored', drafts: normalizeEnvelope(JSON.parse(raw)) };
    } catch {
      recoveryFailed = true;
      // The other private copy may still contain the user's drafts.
    }
  }
  return { status: recoveryFailed ? 'unrecoverable' : 'empty', drafts: [] };
}

export function readPatternLabDrafts(options = {}) {
  return readPatternLabDraftState(options).drafts;
}

export function writePatternLabDrafts(drafts, options = {}) {
  const storage = storageFrom(options);
  if (!storage) return false;
  if (!Array.isArray(drafts)) throw new TypeError('Pattern Lab drafts must be an array');

  // Validate and normalize the complete next snapshot before either live copy changes.
  const normalized = drafts.map(normalizePatternLabRecipe);
  assertPatternLabJsonSafe(normalized);
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
  assertPatternLabJsonSafe(normalized);
  const state = readPatternLabDraftState(options);
  if (state.status === 'unavailable') {
    throw new Error('Pattern Lab private storage is unavailable');
  }
  if (state.status === 'unrecoverable') {
    throw new Error('Cannot save Pattern Lab draft because existing drafts could not be recovered');
  }
  const current = state.drafts;
  const written = writePatternLabDrafts([normalized, ...current.filter(item => item.id !== normalized.id)], options);
  if (written === false) throw new Error('Pattern Lab private storage is unavailable');
  return normalized;
}

export function deletePatternLabDraft(id, options = {}) {
  const current = readPatternLabDrafts(options);
  const next = current.filter(item => item.id !== String(id));
  if (next.length === current.length) return false;
  writePatternLabDrafts(next, options);
  return true;
}
