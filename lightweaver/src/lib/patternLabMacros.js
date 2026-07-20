const MACRO_DEFAULT = 0.5;

const DEFINITIONS = Object.freeze({
  color: Object.freeze({
    primary: 'paletteTravel',
    fields: Object.freeze({ paletteTravel: [0, 1], warmth: [-1, 1], saturation: [0.55, 1] }),
  }),
  movement: Object.freeze({
    primary: 'speedMultiplier',
    fields: Object.freeze({ speedMultiplier: [0.25, 2], driftToPulse: [0, 1], modulationDepth: [0.05, 0.75] }),
  }),
  shape: Object.freeze({
    primary: 'spatialScale',
    fields: Object.freeze({ spatialScale: [0.5, 2.5], radialBias: [-1, 1], symmetryStrength: [0.15, 1] }),
  }),
  texture: Object.freeze({
    primary: 'detailScale',
    fields: Object.freeze({ detailScale: [0.5, 4], crispness: [0, 1], density: [0.15, 1] }),
  }),
  energy: Object.freeze({
    primary: 'brightness',
    fields: Object.freeze({ brightness: [0.15, 1], dynamicRange: [0.1, 1], rareEventStrength: [0, 0.8] }),
  }),
});

function round(value) {
  return Math.round(value * 1e12) / 1e12;
}

function clamp01(value, fallback = MACRO_DEFAULT) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function map(amount, range) {
  return round(range[0] + (range[1] - range[0]) * amount);
}

function unmap(value, range) {
  const number = Number(value);
  if (!Number.isFinite(number) || range[1] === range[0]) return MACRO_DEFAULT;
  return round(clamp01((number - range[0]) / (range[1] - range[0])));
}

export function resolvePatternLabMacros(recipeOrMacros = {}) {
  const source = recipeOrMacros?.macros && typeof recipeOrMacros.macros === 'object'
    ? recipeOrMacros.macros
    : recipeOrMacros;
  return Object.fromEntries(Object.entries(DEFINITIONS).map(([macro, definition]) => {
    const amount = clamp01(source?.[macro]);
    const technical = Object.fromEntries(
      Object.entries(definition.fields).map(([field, range]) => [field, map(amount, range)]),
    );
    return [macro, technical];
  }));
}

export function patternLabMacrosFromTechnicalValues(technicalValues = {}) {
  return Object.fromEntries(Object.entries(DEFINITIONS).map(([macro, definition]) => {
    const primaryRange = definition.fields[definition.primary];
    return [macro, unmap(technicalValues?.[macro]?.[definition.primary], primaryRange)];
  }));
}
