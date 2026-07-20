import { PALETTE_DEFAULT } from '../data.js';
import { normalizePalette, renderPixelFrame } from './frameEngine.js';
import { createPatternLabRecipe, normalizePatternLabRecipe } from './patternLabRecipe.js';
import { parseParamsFromCode } from './patternParams.js';
import { getPatternById, isBuiltInPattern } from './patternRegistry.js';

const RECIPE_OWNED_RENDER_KEYS = [
  'activeFn',
  'blendAmount',
  'blendFn',
  'blendPatternId',
  'blendType',
  'paletteNorm',
  'params',
  'patternId',
];

function requireBuiltInPattern(patternId) {
  const pattern = getPatternById(patternId);
  if (!pattern) throw new RangeError(`Unknown pattern: ${patternId}`);
  if (!isBuiltInPattern(patternId)) {
    throw new RangeError(`Pattern Lab recipes require a built-in pattern: ${patternId}`);
  }
  return pattern;
}

function sourcePalette(palette) {
  const hasColor = Array.isArray(palette)
    && palette.some(color => typeof color === 'string' && color.trim());
  return hasColor ? palette : PALETTE_DEFAULT;
}

export function recipeFromPattern(patternId, context = {}) {
  const pattern = requireBuiltInPattern(patternId);

  return createPatternLabRecipe({
    name: pattern.name,
    base: {
      kind: 'lightweaver-pattern',
      patternId,
      params: Object.fromEntries(
        parseParamsFromCode(pattern.code).map(param => [param.name, param.value]),
      ),
    },
    palette: sourcePalette(context.palette),
    provenance: [{ source: 'lightweaver', patternId }],
  });
}

export function renderPatternLabRecipeFrame(recipe, context = {}) {
  const normalized = normalizePatternLabRecipe(recipe);
  requireBuiltInPattern(normalized.base.patternId);

  const renderContext = { ...context };
  for (const key of RECIPE_OWNED_RENDER_KEYS) delete renderContext[key];

  // The legacy stateless renderer has no seed input. Ignoring recipe.seed here
  // preserves its exact output; Pattern Lab evolution consumes seed separately.
  return renderPixelFrame({
    ...renderContext,
    patternId: normalized.base.patternId,
    params: normalized.base.params,
    paletteNorm: normalizePalette(normalized.palette),
  });
}
