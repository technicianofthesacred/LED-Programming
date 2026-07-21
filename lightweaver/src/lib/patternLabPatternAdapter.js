import { PALETTE_DEFAULT } from '../data.js';
import { blendPatternLabColors } from './patternLabCompositor.js';
import { normalizePalette, renderPixelFrame } from './frameEngine.js';
import { createPatternLabRecipe, normalizePatternLabRecipe } from './patternLabRecipe.js';
import { applyPatternLabTransform, samplePatternLabMask } from './patternLabTransforms.js';
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

function layerTransforms(layer) {
  if (Array.isArray(layer?.transforms)) return layer.transforms;
  return layer?.transform ? [layer.transform] : [];
}

function layerTargetMatches(layer, strip) {
  const target = layer?.target;
  if (!target || target.kind === 'whole-piece' || target.kind === 'all') return true;
  if (target.kind === 'section') return String(target.id || '') === String(strip?.id || '');
  throw new RangeError(`Unsupported Pattern Lab layer target: ${String(target.kind)}`);
}

function geometryBounds(strips, declared) {
  if (declared && Number.isFinite(declared.minX) && Number.isFinite(declared.minY)
    && Number.isFinite(declared.range) && declared.range > 0) return declared;
  const points = (strips || []).flatMap(strip => strip?.pts || []);
  if (!points.length) return { minX: 0, minY: 0, range: 1 };
  const xs = points.map(point => Number(point.x) || 0);
  const ys = points.map(point => Number(point.y) || 0);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    range: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.001),
  };
}

function prepareLayerGeometry(strips, layer, declaredBounds) {
  const transforms = layerTransforms(layer);
  const bounds = geometryBounds(strips, declaredBounds);
  const coordinates = [];
  const transformed = (strips || []).map(strip => ({
    ...strip,
    pts: (strip.pts || []).map(point => {
      const normalized = {
        ...point,
        x: (point.x - bounds.minX) / bounds.range,
        y: (point.y - bounds.minY) / bounds.range,
      };
      coordinates.push({
        ...normalized,
        stripId: strip.id,
        stripProgress: point.stripProgress ?? point.p,
        targetMatched: layerTargetMatches(layer, strip),
      });
      const changed = applyPatternLabTransform(normalized, transforms);
      return {
        ...point,
        x: bounds.minX + changed.x * bounds.range,
        y: bounds.minY + changed.y * bounds.range,
      };
    }),
  }));
  return { strips: transformed, coordinates, bounds };
}

function renderRecipeLayer(layer, renderContext, fallbackPalette) {
  const generator = layer?.generator;
  if (generator?.kind !== 'lightweaver-pattern') {
    throw new RangeError(`Unsupported Pattern Lab layer generator: ${String(generator?.kind)}`);
  }
  requireBuiltInPattern(generator.patternId);
  const geometry = prepareLayerGeometry(renderContext.strips, layer, renderContext.normBounds);
  const frame = renderPixelFrame({
    ...renderContext,
    strips: geometry.strips,
    patternId: generator.patternId,
    params: generator.params || {},
    paletteNorm: normalizePalette(sourcePalette(layer.palette || fallbackPalette)),
    normBounds: geometry.bounds,
  });
  return { ...geometry, frame };
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
  let frame = renderPixelFrame({
    ...renderContext,
    patternId: normalized.base.patternId,
    params: normalized.base.params,
    paletteNorm: normalizePalette(normalized.palette),
  });
  for (const layer of normalized.layers) {
    const rendered = renderRecipeLayer(layer, renderContext, normalized.palette);
    if (rendered.frame.pixels.length !== frame.pixels.length
      || rendered.coordinates.length !== frame.pixels.length) {
      throw new RangeError('Pattern Lab layer output does not match the base geometry');
    }
    frame = {
      ...frame,
      pixels: frame.pixels.map((backdrop, index) => {
        const coordinate = rendered.coordinates[index];
        const mask = coordinate.targetMatched
          ? samplePatternLabMask(layer.mask || { kind: 'none' }, coordinate)
          : 0;
        return blendPatternLabColors(
          backdrop,
          rendered.frame.pixels[index],
          layer.blendMode || 'normal',
          (layer.opacity ?? 1) * mask,
        );
      }),
    };
  }
  return frame;
}
