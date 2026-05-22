import { PATTERNS as BUILT_IN_PATTERNS } from './patterns-library.js';
import { loadCustomPatterns } from './customPatterns.js';

export function listBuiltInPatterns() {
  return BUILT_IN_PATTERNS;
}

export function listPatterns(options = {}) {
  return [...loadCustomPatterns(options), ...BUILT_IN_PATTERNS];
}

export function getPatternById(id, options = {}) {
  return listPatterns(options).find(pattern => pattern.id === id) || null;
}

export function getPatternCode(id, options = {}) {
  return getPatternById(id, options)?.code || '';
}

export function isBuiltInPattern(id) {
  return BUILT_IN_PATTERNS.some(pattern => pattern.id === id);
}
