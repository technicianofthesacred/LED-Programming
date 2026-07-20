import { hexToCardColor, normalizeCardVisualLook } from './cardVisualLook.js';
import { resolvePatternLabMacros } from './patternLabMacros.js';
import { normalizePatternLabRecipe } from './patternLabRecipe.js';
import { isBuiltInPattern } from './patternRegistry.js';
import { normalizeSavedLooks } from './sectionLookModel.js';

function clone(value) {
  return structuredClone(value);
}

function slug(value, fallback = 'pattern-lab-asset') {
  return String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function blocked(code, message, detail = null) {
  return {
    kind: 'blocked',
    reasons: [{ code, message, ...(detail ? { detail: String(detail) } : {}) }],
  };
}

function lookFromRecipe(recipe) {
  const technical = resolvePatternLabMacros(recipe);
  const paletteColor = recipe.palette[Math.min(recipe.palette.length - 1, Math.floor(recipe.palette.length / 2))];
  const color = hexToCardColor(paletteColor);
  const defaultLook = normalizeCardVisualLook({
    patternId: recipe.base.patternId,
    brightness: technical.energy.brightness,
    speed: technical.movement.speedMultiplier,
    hueShift: Math.round(technical.color.warmth * 18),
    customHue: color.customHue,
    customSaturation: Math.round(technical.color.saturation * 255),
  });
  const sectionLooks = Object.fromEntries((recipe.targets || [])
    .filter(target => target?.kind === 'section' && String(target.id || '').trim())
    .map(target => [slug(target.id), defaultLook]));
  return normalizeSavedLooks([{
    id: slug(recipe.name),
    label: recipe.name,
    defaultLook,
    sectionLooks,
    updatedAt: 0,
  }])[0];
}

export function createPatternLabHandoff({
  recipe,
  compatibility,
  sequencePackage = null,
  manifest = null,
  cancelled = false,
  exportError = null,
} = {}) {
  if (cancelled) return blocked('cancelled', 'Use in Project was canceled.');
  if (exportError) return blocked('export-failed', 'The Pattern Lab export did not finish.', exportError.message || exportError);
  if (!compatibility || typeof compatibility !== 'object') {
    return blocked('compatibility-missing', 'Run card compatibility before using this pattern in the project.');
  }
  let normalized;
  try {
    normalized = normalizePatternLabRecipe(recipe);
  } catch (error) {
    return blocked('recipe-invalid', 'The Pattern Lab recipe is invalid.', error.message || error);
  }

  if (compatibility.classification === 'live-on-card') {
    if (normalized.base.kind !== 'lightweaver-pattern' || !isBuiltInPattern(normalized.base.patternId)) {
      return blocked('look-unsupported', 'This recipe cannot become a native card look.');
    }
    return { kind: 'look', look: lookFromRecipe(normalized) };
  }

  if (compatibility.classification === 'bake-to-card') {
    if (!sequencePackage || typeof sequencePackage !== 'object' || !manifest || typeof manifest !== 'object') {
      return blocked('bake-required', 'Bake the complete sequence before adding it to the project.');
    }
    try {
      return { kind: 'sequence', package: clone(sequencePackage), manifest: clone(manifest) };
    } catch (error) {
      return blocked('bake-invalid', 'The baked sequence package is invalid.', error.message || error);
    }
  }

  const reasons = Array.isArray(compatibility.reasons) && compatibility.reasons.length
    ? clone(compatibility.reasons)
    : [{ code: 'unsupported', message: 'This recipe does not have a safe project handoff yet.' }];
  return { kind: 'blocked', reasons };
}

function uniqueId(preferred, used) {
  const base = slug(preferred);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate) || isBuiltInPattern(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

export function applyPatternLabHandoff(controller = {}, result = {}) {
  if (!result || result.kind === 'blocked') return controller;
  const source = clone(controller || {});
  if (result.kind === 'look') {
    const existing = normalizeSavedLooks(source.looks);
    const used = new Set(existing.map(look => look.id));
    const nextLook = clone(result.look);
    nextLook.id = uniqueId(nextLook.label || nextLook.id, used);
    const looks = normalizeSavedLooks([nextLook, ...existing]);
    return {
      ...source,
      defaultLook: clone(nextLook.defaultLook),
      activeLookId: nextLook.id,
      looks,
    };
  }
  if (result.kind === 'sequence') {
    const existing = Array.isArray(source.sequenceAssets) ? clone(source.sequenceAssets) : [];
    const used = new Set(existing.map(asset => String(asset?.id || '')));
    const label = String(result.manifest?.name || result.manifest?.recipeName || 'Pattern Lab sequence');
    const id = uniqueId(label, used);
    return {
      ...source,
      sequenceAssets: [{
        id,
        label,
        package: clone(result.package),
        manifest: clone(result.manifest),
      }, ...existing],
    };
  }
  return controller;
}
