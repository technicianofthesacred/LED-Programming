import {
  CUSTOM_PATTERNS_KEY,
  CUSTOM_PATTERN_REVISIONS_KEY,
} from './customPatterns.js';
import {
  PATTERN_LAB_RECIPE_VERSION,
  assertPatternLabJsonSafe,
  normalizePatternLabRecipe,
} from './patternLabRecipe.js';
import {
  PATTERN_LAB_DRAFTS_BACKUP_KEY,
  PATTERN_LAB_DRAFTS_KEY,
} from './patternLabStorage.js';

export const WORKSPACE_ASSETS_VERSION = 1;
export const WORKSPACE_ASSETS_EVENT = 'lw:workspace-assets-changed';
export const WORKSPACE_ASSETS_POINTER_KEY = 'lw_workspace_assets_current_v1';
export const WORKSPACE_ASSETS_SNAPSHOT_PREFIX = 'lw_workspace_assets_snapshot_v1:';
const WORKSPACE_ASSETS_FORMAT = 'lightweaver.workspace-assets';

function defaultStorage() {
  try {
    return globalThis.window?.localStorage || globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function resolveStorage(storage) {
  return storage === undefined ? defaultStorage() : storage;
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonClone(value, label) {
  try {
    assertPatternLabJsonSafe(value);
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError();
    return JSON.parse(text);
  } catch {
    throw new TypeError(`${label} must be JSON-safe.`);
  }
}

function normalizeCustomPattern(value, label = 'Custom pattern') {
  const clone = jsonClone(value, label);
  if (!isRecord(clone)
    || typeof clone.id !== 'string'
    || !clone.id.trim()
    || typeof clone.name !== 'string'
    || !clone.name.trim()
    || typeof clone.code !== 'string') {
    throw new TypeError(`${label} must contain a non-empty id and name plus string code.`);
  }
  return clone;
}

function normalizeCustomPatterns(value) {
  if (!Array.isArray(value)) throw new TypeError('Custom patterns must be an array.');
  const seen = new Set();
  return value.map((item, index) => {
    const pattern = normalizeCustomPattern(item, `Custom pattern ${index + 1}`);
    if (seen.has(pattern.id)) throw new TypeError(`Custom pattern id ${pattern.id} is duplicated.`);
    seen.add(pattern.id);
    return pattern;
  });
}

function normalizeCustomPatternRevisions(value) {
  if (!isRecord(value)) throw new TypeError('Custom pattern revisions must be an object.');
  const normalized = {};
  for (const [id, revisions] of Object.entries(value)) {
    if (!id || !Array.isArray(revisions)) {
      throw new TypeError('Each custom pattern revision history must be an array.');
    }
    normalized[id] = revisions.map((item, index) => {
      const revision = normalizeCustomPattern(item, `Custom pattern revision ${id} #${index + 1}`);
      if (revision.id !== id) {
        throw new TypeError(`Custom pattern revision ${id} must preserve its pattern id.`);
      }
      return revision;
    });
  }
  return normalized;
}

function normalizePatternLabDrafts(value) {
  if (!Array.isArray(value)) throw new TypeError('Pattern Lab drafts must be an array.');
  const normalized = value.map(normalizePatternLabRecipe);
  assertPatternLabJsonSafe(normalized);
  const seen = new Set();
  for (const draft of normalized) {
    if (seen.has(draft.id)) throw new TypeError(`Pattern Lab draft id ${draft.id} is duplicated.`);
    seen.add(draft.id);
  }
  return normalized;
}

function normalizeSnapshot(value) {
  if (!isRecord(value) || value.version !== WORKSPACE_ASSETS_VERSION) {
    throw new TypeError(`Workspace assets must use version ${WORKSPACE_ASSETS_VERSION}.`);
  }
  return {
    version: WORKSPACE_ASSETS_VERSION,
    customPatterns: normalizeCustomPatterns(value.customPatterns),
    customPatternRevisions: normalizeCustomPatternRevisions(value.customPatternRevisions),
    patternLabDrafts: normalizePatternLabDrafts(value.patternLabDrafts),
  };
}

function parseStored(storage, key, fallback, label) {
  const raw = storage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new TypeError(`${label} storage is not valid JSON.`);
  }
}

function readPatternLabEnvelope(storage) {
  let failure = null;
  for (const key of [PATTERN_LAB_DRAFTS_KEY, PATTERN_LAB_DRAFTS_BACKUP_KEY]) {
    const raw = storage.getItem(key);
    if (!raw) continue;
    try {
      const envelope = JSON.parse(raw);
      if (!isRecord(envelope) || !Array.isArray(envelope.drafts)) throw new TypeError();
      const version = Number(envelope.version);
      if (version !== 1 && version !== PATTERN_LAB_RECIPE_VERSION) {
        throw new RangeError(`Unsupported Pattern Lab draft version: ${String(envelope.version)}`);
      }
      return envelope.drafts;
    } catch (error) {
      failure = error;
    }
  }
  if (failure instanceof RangeError) throw failure;
  if (failure) throw new TypeError('Pattern Lab draft storage could not be recovered.');
  return [];
}

function dispatchWorkspaceAssetsEvent(options = {}) {
  if (options.dispatch === false || typeof globalThis.window?.dispatchEvent !== 'function') return;
  try {
    globalThis.window.dispatchEvent(new CustomEvent(WORKSPACE_ASSETS_EVENT));
  } catch {}
}

function snapshotStorageKey() {
  const id = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${WORKSPACE_ASSETS_SNAPSHOT_PREFIX}${id}`;
}

function readCommittedSnapshot(storage) {
  const pointer = storage.getItem(WORKSPACE_ASSETS_POINTER_KEY);
  if (!pointer) return null;
  if (!pointer.startsWith(WORKSPACE_ASSETS_SNAPSHOT_PREFIX)) {
    throw new TypeError('Workspace asset snapshot pointer is invalid.');
  }
  const raw = storage.getItem(pointer);
  if (!raw) throw new TypeError('Committed workspace asset snapshot is missing.');
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new TypeError('Committed workspace asset snapshot is not valid JSON.');
  }
  if (!isRecord(envelope)
    || envelope.format !== WORKSPACE_ASSETS_FORMAT
    || envelope.version !== WORKSPACE_ASSETS_VERSION) {
    throw new TypeError('Committed workspace asset snapshot is unsupported.');
  }
  return normalizeSnapshot(envelope.snapshot);
}

export function readWorkspaceAssets(storage) {
  const target = resolveStorage(storage);
  if (!target) {
    return {
      version: WORKSPACE_ASSETS_VERSION,
      customPatterns: [],
      customPatternRevisions: {},
      patternLabDrafts: [],
    };
  }
  const committed = readCommittedSnapshot(target);
  if (committed) return committed;
  return normalizeSnapshot({
    version: WORKSPACE_ASSETS_VERSION,
    customPatterns: parseStored(target, CUSTOM_PATTERNS_KEY, [], 'Custom pattern'),
    customPatternRevisions: parseStored(target, CUSTOM_PATTERN_REVISIONS_KEY, {}, 'Custom pattern revision'),
    patternLabDrafts: readPatternLabEnvelope(target),
  });
}

export function writeWorkspaceAssets(snapshot, storage, options = {}) {
  const normalized = normalizeSnapshot(snapshot);
  const target = resolveStorage(storage);
  if (!target) throw new Error('Workspace asset storage is unavailable.');

  const patternLabEnvelope = JSON.stringify({
    version: PATTERN_LAB_RECIPE_VERSION,
    drafts: normalized.patternLabDrafts,
  });
  const legacyWrites = new Map([
    [CUSTOM_PATTERNS_KEY, JSON.stringify(normalized.customPatterns)],
    [CUSTOM_PATTERN_REVISIONS_KEY, JSON.stringify(normalized.customPatternRevisions)],
    [PATTERN_LAB_DRAFTS_KEY, patternLabEnvelope],
    [PATTERN_LAB_DRAFTS_BACKUP_KEY, patternLabEnvelope],
  ]);
  const previousPointer = target.getItem(WORKSPACE_ASSETS_POINTER_KEY);
  const nextPointer = snapshotStorageKey();
  const envelope = JSON.stringify({
    format: WORKSPACE_ASSETS_FORMAT,
    version: WORKSPACE_ASSETS_VERSION,
    snapshot: normalized,
  });

  target.setItem(nextPointer, envelope);
  try {
    target.setItem(WORKSPACE_ASSETS_POINTER_KEY, nextPointer);
  } catch (error) {
    try { target.removeItem(nextPointer); } catch {}
    throw error;
  }

  // Existing custom-pattern and Pattern Lab readers remain compatible. These
  // mirrors are non-authoritative, so a quota failure cannot create a hybrid
  // workspace state after the pointer has committed the complete snapshot.
  for (const [key, text] of legacyWrites) {
    try { target.setItem(key, text); } catch {}
  }
  if (previousPointer && previousPointer !== nextPointer) {
    try { target.removeItem(previousPointer); } catch {}
  }

  dispatchWorkspaceAssetsEvent(options);
  return normalized;
}
