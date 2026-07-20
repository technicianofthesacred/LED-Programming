import { normalizePalette, renderPixelFrame } from './frameEngine.js';
import { createPatternLabRecipe, normalizePatternLabRecipe } from './patternLabRecipe.js';
import { parseParamsFromCode } from './patternParams.js';
import { getPatternById } from './patternRegistry.js';

export function recipeFromPattern(patternId, context = {}) {
  const pattern = getPatternById(patternId);
  if (!pattern) throw new RangeError(`Unknown pattern: ${patternId}`);

  return createPatternLabRecipe({
    name: pattern.name,
    base: {
      kind: 'lightweaver-pattern',
      patternId,
      params: Object.fromEntries(
        parseParamsFromCode(pattern.code).map(param => [param.name, param.value]),
      ),
    },
    palette: context.palette,
    provenance: [{ source: 'lightweaver', patternId }],
  });
}

export function renderPatternLabRecipeFrame(recipe, context = {}) {
  const normalized = normalizePatternLabRecipe(recipe);
  return renderPixelFrame({
    ...context,
    patternId: normalized.base.patternId,
    params: normalized.base.params,
    paletteNorm: normalizePalette(normalized.palette),
  });
}
