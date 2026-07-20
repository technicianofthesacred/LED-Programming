export const PATTERN_LAB_BLEND_MODES = Object.freeze([
  'normal',
  'add',
  'screen',
  'multiply',
  'lighten',
  'mask',
]);

const MAX_LAYERS = 3;

function clamp(value, minimum, maximum) {
  const number = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(number) ? number : minimum));
}

function clampByte(value) {
  return Math.round(clamp(value, 0, 255));
}

function normalizeColor(color) {
  return {
    r: clampByte(color?.r),
    g: clampByte(color?.g),
    b: clampByte(color?.b),
  };
}

function blendChannel(backdrop, source, mode) {
  if (mode === 'normal') return source;
  if (mode === 'add') return backdrop + source;
  if (mode === 'screen') return 255 - ((255 - backdrop) * (255 - source) / 255);
  if (mode === 'multiply') return backdrop * source / 255;
  if (mode === 'lighten') return Math.max(backdrop, source);
  return backdrop;
}

export function blendPatternLabColors(backdrop, source, mode = 'normal', opacity = 1) {
  if (!PATTERN_LAB_BLEND_MODES.includes(mode)) {
    throw new RangeError(`Unsupported Pattern Lab blend mode: ${mode}`);
  }

  const base = normalizeColor(backdrop);
  const layer = normalizeColor(source);
  const alpha = clamp(opacity, 0, 1);
  let blended;

  if (mode === 'mask') {
    const luminance = (layer.r * 0.2126 + layer.g * 0.7152 + layer.b * 0.0722) / 255;
    blended = {
      r: base.r * luminance,
      g: base.g * luminance,
      b: base.b * luminance,
    };
  } else {
    blended = {
      r: blendChannel(base.r, layer.r, mode),
      g: blendChannel(base.g, layer.g, mode),
      b: blendChannel(base.b, layer.b, mode),
    };
  }

  return {
    r: clampByte(base.r + (blended.r - base.r) * alpha),
    g: clampByte(base.g + (blended.g - base.g) * alpha),
    b: clampByte(base.b + (blended.b - base.b) * alpha),
  };
}

export function compositePatternLabLayers(layers, background = { r: 0, g: 0, b: 0 }) {
  if (!Array.isArray(layers)) throw new TypeError('Pattern Lab layers must be an array');
  if (layers.length > MAX_LAYERS) throw new RangeError('Pattern Lab supports at most 3 layers');
  return layers.reduce(
    (color, layer) => blendPatternLabColors(
      color,
      layer?.color,
      layer?.blendMode || 'normal',
      layer?.opacity ?? 1,
    ),
    normalizeColor(background),
  );
}
