export const CUSTOM_PATTERNS_KEY = 'lw_custom_patterns';
export const CUSTOM_PATTERN_REVISIONS_KEY = 'lw_custom_pattern_revisions';
export const CUSTOM_PATTERNS_EVENT = 'lw:custom-updated';

function getStorage(storage) {
  if (storage) return storage;
  if (typeof localStorage !== 'undefined') return localStorage;
  return null;
}

function safeReadJson(key, fallback, storage) {
  const target = getStorage(storage);
  if (!target) return fallback;
  try {
    const value = target.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function safeWriteJson(key, value, storage) {
  const target = getStorage(storage);
  if (!target) return;
  try {
    target.setItem(key, JSON.stringify(value));
  } catch {}
}

function dispatchCustomPatternsEvent(options = {}) {
  if (options.dispatch === false || typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(CUSTOM_PATTERNS_EVENT));
  } catch {}
}

export function buildCustomPatternId(name = '') {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (slug) return `custom_${slug}`;
  return `custom_${Math.random().toString(36).slice(2, 10)}`;
}

export function previewFromPalette(palette = []) {
  const colors = Array.isArray(palette) ? palette.filter(Boolean) : [];
  if (colors.length >= 2) return `linear-gradient(135deg,${colors.join(',')})`;
  return 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
}

export function loadCustomPatterns(options = {}) {
  const patterns = safeReadJson(CUSTOM_PATTERNS_KEY, [], options.storage);
  return Array.isArray(patterns) ? patterns : [];
}

export function writeCustomPatterns(patterns, options = {}) {
  safeWriteJson(CUSTOM_PATTERNS_KEY, Array.isArray(patterns) ? patterns : [], options.storage);
  dispatchCustomPatternsEvent(options);
}

export function buildCustomPatternEntry(pattern = {}) {
  const name = String(pattern.name || 'Untitled Pattern').trim() || 'Untitled Pattern';
  return {
    ...pattern,
    id: pattern.id || buildCustomPatternId(name),
    name,
    code: String(pattern.code || ''),
    preview: pattern.preview || previewFromPalette(pattern.palette),
    custom: true,
  };
}

export function saveCustomPattern(pattern, options = {}) {
  const entry = buildCustomPatternEntry(pattern);
  const previous = loadCustomPatterns(options).filter(item => item.id !== entry.id);
  writeCustomPatterns([entry, ...previous], options);
  return entry;
}

export function updateCustomPattern(id, updates = {}, options = {}) {
  const current = loadCustomPatterns(options);
  const existing = current.find(pattern => pattern.id === id);
  if (!existing) return saveCustomPattern({ ...updates, id }, options);

  const revisions = safeReadJson(CUSTOM_PATTERN_REVISIONS_KEY, {}, options.storage);
  const nextRevisions = revisions && typeof revisions === 'object' && !Array.isArray(revisions) ? revisions : {};
  nextRevisions[id] = [existing, ...(Array.isArray(nextRevisions[id]) ? nextRevisions[id] : [])];
  safeWriteJson(CUSTOM_PATTERN_REVISIONS_KEY, nextRevisions, options.storage);

  const merged = { ...existing, ...updates, id };
  if (updates.palette && !Object.hasOwn(updates, 'preview')) delete merged.preview;
  const updated = buildCustomPatternEntry(merged);
  writeCustomPatterns(current.map(pattern => pattern.id === id ? updated : pattern), options);
  return updated;
}

export function deleteCustomPattern(id, options = {}) {
  writeCustomPatterns(loadCustomPatterns(options).filter(pattern => pattern.id !== id), options);
}
