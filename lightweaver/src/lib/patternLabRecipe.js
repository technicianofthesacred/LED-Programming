export const PATTERN_LAB_RECIPE_VERSION = 1;
export const PATTERN_LAB_MAX_LAYERS = 3;

const DEFAULT_PALETTE = ['#1a0c05', '#8f3f18', '#f0a04a', '#ffe1a3'];
const DEFAULT_MACROS = { color: 0.5, movement: 0.5, shape: 0.5, texture: 0.5, energy: 0.5 };
const DEFAULT_EVOLUTION = { enabled: true, character: 'slow-bloom', durationSeconds: 600, change: 0.35 };
let fallbackId = 0;

function clone(value, ancestors = new WeakSet()) {
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) throw new TypeError('Pattern Lab recipe must be JSON-safe: cyclic value');
    if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Pattern Lab recipe must be JSON-safe: symbol key');
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError('Pattern Lab recipe must be JSON-safe: sparse array');
      }
    } else if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError('Pattern Lab recipe must be JSON-safe: non-plain object');
    }
    ancestors.add(value);
  }
  if (Array.isArray(value)) {
    const result = value.map(item => clone(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (value && typeof value === 'object') {
    const result = Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, clone(nested, ancestors)]));
    ancestors.delete(value);
    return result;
  }
  return value;
}

export function assertPatternLabJsonSafe(value) {
  const ancestors = new WeakSet();
  function visit(current, path) {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError(`Pattern Lab recipe must be JSON-safe: non-finite number at ${path}`);
      return;
    }
    if (typeof current !== 'object') throw new TypeError(`Pattern Lab recipe must be JSON-safe: ${typeof current} at ${path}`);
    if (ancestors.has(current)) throw new TypeError(`Pattern Lab recipe must be JSON-safe: cyclic value at ${path}`);
    if (Object.getOwnPropertySymbols(current).length) throw new TypeError(`Pattern Lab recipe must be JSON-safe: symbol key at ${path}`);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) throw new TypeError(`Pattern Lab recipe must be JSON-safe: sparse array at ${path}`);
      }
    }
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
      throw new TypeError(`Pattern Lab recipe must be JSON-safe: non-plain object at ${path}`);
    }
    ancestors.add(current);
    if (Array.isArray(current)) current.forEach((item, index) => visit(item, `${path}[${index}]`));
    else Object.entries(current).forEach(([key, nested]) => visit(nested, `${path}.${key}`));
    ancestors.delete(current);
  }
  visit(value, '$');
  return value;
}

function objectOr(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? clone(value) : clone(fallback);
}

function arrayOr(value, fallback = []) {
  return Array.isArray(value) ? clone(value) : clone(fallback);
}

function bounded(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function majorVersion(version) {
  const match = String(version ?? PATTERN_LAB_RECIPE_VERSION).match(/^\s*(\d+)/);
  return match ? Number(match[1]) : Number.NaN;
}

function cryptoSafeId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return `pattern-lab-${cryptoApi.randomUUID()}`;
  if (typeof cryptoApi?.getRandomValues === 'function') {
    const bytes = cryptoApi.getRandomValues(new Uint32Array(4));
    return `pattern-lab-${Array.from(bytes, value => value.toString(16).padStart(8, '0')).join('')}`;
  }
  fallbackId += 1;
  return `pattern-lab-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

export function normalizePatternLabRecipe(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Pattern Lab recipe must be an object');
  const major = majorVersion(input.version);
  if (major !== PATTERN_LAB_RECIPE_VERSION) {
    throw new RangeError(`Unsupported Pattern Lab recipe version: ${String(input.version)}`);
  }

  const source = clone(input);
  const id = String(source.id || '').trim();
  if (!id) throw new TypeError('Pattern Lab recipe ID is required');
  const base = { kind: 'lightweaver-pattern', patternId: 'aurora', params: {}, ...objectOr(source.base) };
  base.params = objectOr(base.params);

  let palette = arrayOr(source.palette, DEFAULT_PALETTE).filter(color => typeof color === 'string' && color.trim()).map(color => color.trim());
  if (!palette.length) palette = clone(DEFAULT_PALETTE);
  if (palette.length === 1) palette.push(palette[0]);
  palette = palette.slice(0, 8);

  const macroSource = objectOr(source.macros);
  const macros = { ...DEFAULT_MACROS, ...macroSource };
  for (const key of Object.keys(DEFAULT_MACROS)) macros[key] = bounded(macroSource[key], 0, 1, DEFAULT_MACROS[key]);

  const evolutionSource = objectOr(source.evolution);
  const evolution = { ...DEFAULT_EVOLUTION, ...evolutionSource };
  evolution.enabled = evolutionSource.enabled === undefined ? DEFAULT_EVOLUTION.enabled : Boolean(evolutionSource.enabled);
  evolution.character = String(evolutionSource.character || DEFAULT_EVOLUTION.character);
  evolution.durationSeconds = bounded(evolutionSource.durationSeconds, 300, 900, DEFAULT_EVOLUTION.durationSeconds);
  evolution.change = bounded(evolutionSource.change, 0, 1, DEFAULT_EVOLUTION.change);

  return {
    ...source,
    version: PATTERN_LAB_RECIPE_VERSION,
    id,
    name: String(source.name || 'Untitled evolution').trim() || 'Untitled evolution',
    base,
    palette,
    macros,
    evolution,
    seed: (Number.isFinite(Number(source.seed)) ? Math.trunc(Number(source.seed)) : 1) >>> 0,
    layers: arrayOr(source.layers).slice(0, PATTERN_LAB_MAX_LAYERS),
    targets: arrayOr(source.targets, [{ kind: 'whole-piece', id: 'all' }]),
    requirements: arrayOr(source.requirements),
    provenance: arrayOr(source.provenance),
  };
}

export function createPatternLabRecipe(overrides = {}) {
  return normalizePatternLabRecipe({
    version: PATTERN_LAB_RECIPE_VERSION,
    id: overrides.id || cryptoSafeId(),
    name: overrides.name || 'Untitled evolution',
    base: { kind: 'lightweaver-pattern', patternId: 'aurora', params: {} },
    palette: DEFAULT_PALETTE,
    macros: DEFAULT_MACROS,
    evolution: DEFAULT_EVOLUTION,
    seed: 1,
    layers: [],
    targets: [{ kind: 'whole-piece', id: 'all' }],
    requirements: [],
    provenance: [],
    ...overrides,
  });
}
