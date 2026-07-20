const TAU = Math.PI * 2;
const DEFAULT_CENTER = Object.freeze({ x: 0.5, y: 0.5 });

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value, minimum)));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function clampByte(value) {
  return Math.round(clamp(value, 0, 255));
}

function fract(value) {
  const number = finite(value);
  return number - Math.floor(number);
}

function triangle(value) {
  const phase = fract(value);
  return phase < 0.5 ? phase * 2 : 2 - phase * 2;
}

function pointCenter(value) {
  return {
    x: finite(value?.x, DEFAULT_CENTER.x),
    y: finite(value?.y, DEFAULT_CENTER.y),
  };
}

function rotatePoint(coordinates, angle, center) {
  const dx = finite(coordinates.x) - center.x;
  const dy = finite(coordinates.y) - center.y;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    ...coordinates,
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine,
  };
}

function axisValues(coordinates, axis, mapper) {
  const result = { ...coordinates };
  if (axis === 'x' || axis === 'both') result.x = mapper(finite(coordinates.x), 'x');
  if (axis === 'y' || axis === 'both') result.y = mapper(finite(coordinates.y), 'y');
  return result;
}

export function applyPatternLabTransform(coordinates = {}, transform = {}) {
  if (Array.isArray(transform)) {
    return transform.reduce((current, item) => applyPatternLabTransform(current, item), { ...coordinates });
  }

  const kind = transform.kind || transform.type || 'none';
  const center = pointCenter(transform.center);
  const axis = transform.axis || 'both';

  if (kind === 'none') return { ...coordinates };
  if (kind === 'mirror') {
    return axisValues(coordinates, axis, (value, dimension) => {
      const pivot = dimension === 'y' ? center.y : center.x;
      return pivot - Math.abs(value - pivot);
    });
  }
  if (kind === 'repeat') {
    const count = Math.max(1, Math.round(finite(transform.count, 2)));
    const phase = finite(transform.phase);
    return axisValues(coordinates, axis, value => fract(value * count + phase));
  }
  if (kind === 'fold') {
    const count = Math.max(1, Math.round(finite(transform.count, 1)));
    const phase = finite(transform.phase);
    return axisValues(coordinates, axis, value => triangle(value * count + phase));
  }
  if (kind === 'rotate') {
    const angle = transform.radians == null
      ? finite(transform.degrees, finite(transform.turns) * 360) * Math.PI / 180
      : finite(transform.radians);
    return rotatePoint(coordinates, angle, center);
  }
  if (kind === 'twist') {
    const dx = finite(coordinates.x) - center.x;
    const dy = finite(coordinates.y) - center.y;
    const radius = Math.sqrt(dx * dx + dy * dy);
    return rotatePoint(coordinates, TAU * finite(transform.turns, 1) * radius, center);
  }
  if (kind === 'kaleidoscope') {
    const dx = finite(coordinates.x) - center.x;
    const dy = finite(coordinates.y) - center.y;
    const radius = Math.sqrt(dx * dx + dy * dy);
    const slices = Math.max(2, Math.min(32, Math.round(finite(transform.slices, 6))));
    const sector = TAU / slices;
    const shifted = fract(Math.atan2(dy, dx) / TAU + finite(transform.phase)) * TAU;
    const within = shifted % sector;
    const folded = within <= sector / 2 ? within : sector - within;
    return {
      ...coordinates,
      x: center.x + Math.cos(folded) * radius,
      y: center.y + Math.sin(folded) * radius,
    };
  }
  throw new RangeError(`Unsupported Pattern Lab transform: ${kind}`);
}

export function resolvePatternLabCoordinate(coordinates = {}, options = {}) {
  const center = pointCenter(options.center);
  const space = options.space || 'strip-progress';
  let value;

  if (space === 'strip-progress' || space === 'local') {
    value = finite(coordinates.stripProgress ?? coordinates.p);
  } else if (space === 'x' || space === 'global-x') {
    value = finite(coordinates.x);
  } else if (space === 'y' || space === 'global-y') {
    value = finite(coordinates.y);
  } else {
    const dx = finite(coordinates.x) - center.x;
    const dy = finite(coordinates.y) - center.y;
    if (space === 'radius' || space === 'polar-radius') {
      const maximum = Math.max(1e-9, finite(options.maxRadius, Math.SQRT1_2));
      value = clamp01(Math.sqrt(dx * dx + dy * dy) / maximum);
    } else if (space === 'angle' || space === 'polar-angle') {
      value = fract(Math.atan2(dy, dx) / TAU);
    } else {
      throw new RangeError(`Unsupported Pattern Lab coordinate space: ${space}`);
    }
  }

  const direction = options.direction ?? coordinates.direction;
  if (direction === 'reverse' || Number(direction) < 0) value = 1 - value;
  const phase = finite(options.phase ?? coordinates.phaseOffset);
  return phase === 0 ? clamp01(value) : fract(value + phase);
}

function smoothstep(value) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function maskFalloff(distance, extent, softness) {
  const outer = Math.max(0, finite(extent));
  const feather = clamp(softness, 0, outer);
  if (outer === 0) return distance <= 1e-12 ? 1 : 0;
  if (distance >= outer - 1e-12) return 0;
  const inner = outer - feather;
  if (feather === 0 || distance <= inner) return 1;
  return 1 - smoothstep((distance - inner) / feather);
}

function distanceToSegment(point, start, end) {
  const dx = finite(end.x) - finite(start.x);
  const dy = finite(end.y) - finite(start.y);
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-18) return Math.hypot(finite(point.x) - finite(start.x), finite(point.y) - finite(start.y));
  const projection = clamp(
    ((finite(point.x) - finite(start.x)) * dx + (finite(point.y) - finite(start.y)) * dy) / lengthSquared,
    0,
    1,
  );
  return Math.hypot(
    finite(point.x) - (finite(start.x) + projection * dx),
    finite(point.y) - (finite(start.y) + projection * dy),
  );
}

function distanceToPath(point, path) {
  if (!Array.isArray(path) || path.length < 2) return Number.POSITIVE_INFINITY;
  let distance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < path.length; index += 1) {
    distance = Math.min(distance, distanceToSegment(point, path[index - 1], path[index]));
  }
  return distance;
}

export function samplePatternLabMask(mask = {}, coordinates = {}) {
  const kind = mask.kind || mask.type || 'none';
  let value;

  if (kind === 'none') value = 1;
  else if (kind === 'linear') {
    const angle = finite(mask.angle) * Math.PI / 180;
    const projection = finite(coordinates.x) * Math.cos(angle) + finite(coordinates.y) * Math.sin(angle);
    value = maskFalloff(Math.abs(projection - finite(mask.offset, 0.5)), finite(mask.width, 0.5), finite(mask.softness, 0.1));
  } else if (kind === 'radial') {
    const center = pointCenter(mask.center);
    value = maskFalloff(
      Math.hypot(finite(coordinates.x) - center.x, finite(coordinates.y) - center.y),
      finite(mask.radius, 0.5),
      finite(mask.softness, 0.1),
    );
  } else if (kind === 'anchor') {
    const anchor = coordinates.anchors?.[mask.anchorId] || mask.anchor || DEFAULT_CENTER;
    value = maskFalloff(
      Math.hypot(finite(coordinates.x) - finite(anchor.x, 0.5), finite(coordinates.y) - finite(anchor.y, 0.5)),
      finite(mask.radius, 0.25),
      finite(mask.softness, 0.05),
    );
  } else if (kind === 'path') {
    const distance = Number.isFinite(coordinates.pathDistance)
      ? coordinates.pathDistance
      : distanceToPath(coordinates, mask.path);
    value = maskFalloff(distance, finite(mask.width, 0.1), finite(mask.softness, 0.05));
  } else {
    throw new RangeError(`Unsupported Pattern Lab mask: ${kind}`);
  }

  return mask.invert ? 1 - value : value;
}

function cloneColor(color) {
  if (color && typeof color === 'object') return { ...color };
  return color;
}

function colorToRgb(color) {
  if (typeof color === 'string') {
    const hex = color.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(hex)) {
      return {
        r: Number.parseInt(hex[0] + hex[0], 16),
        g: Number.parseInt(hex[1] + hex[1], 16),
        b: Number.parseInt(hex[2] + hex[2], 16),
      };
    }
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      const number = Number.parseInt(hex, 16);
      return { r: number >> 16, g: (number >> 8) & 255, b: number & 255 };
    }
  }
  if (Array.isArray(color)) return { r: clampByte(color[0]), g: clampByte(color[1]), b: clampByte(color[2]) };
  return {
    r: clampByte(color?.r),
    g: clampByte(color?.g),
    b: clampByte(color?.b),
  };
}

function normalizedPaletteStops(stops) {
  if (!Array.isArray(stops) || stops.length === 0) return [];
  const denominator = Math.max(1, stops.length - 1);
  return stops.map((stop, index) => {
    const source = typeof stop === 'string' ? { color: stop } : (stop || {});
    return {
      ...source,
      position: clamp01(source.position ?? index / denominator),
      color: cloneColor(source.color),
    };
  }).sort((left, right) => left.position - right.position);
}

function moveColorsIntoPositionSlots(stops, ordered) {
  const positions = stops.map(stop => stop.position);
  return ordered.map((stop, index) => ({ ...stop, color: cloneColor(stop.color), position: positions[index] }));
}

export function reorderPaletteStops(stops, fromIndex, toIndex) {
  const normalized = normalizedPaletteStops(stops);
  if (!normalized.length) return [];
  const from = Math.round(clamp(fromIndex, 0, normalized.length - 1));
  const to = Math.round(clamp(toIndex, 0, normalized.length - 1));
  const reordered = normalized.map(stop => ({ ...stop, color: cloneColor(stop.color) }));
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  return moveColorsIntoPositionSlots(normalized, reordered);
}

export function rotatePaletteStops(stops, amount = 1) {
  const normalized = normalizedPaletteStops(stops);
  if (!normalized.length) return [];
  const shift = ((Math.round(finite(amount)) % normalized.length) + normalized.length) % normalized.length;
  if (shift === 0) return moveColorsIntoPositionSlots(normalized, normalized);
  const rotated = [...normalized.slice(-shift), ...normalized.slice(0, -shift)];
  return moveColorsIntoPositionSlots(normalized, rotated);
}

function mixColor(left, right, amount) {
  const a = colorToRgb(left);
  const b = colorToRgb(right);
  const mix = clamp01(amount);
  return {
    r: clampByte(a.r + (b.r - a.r) * mix),
    g: clampByte(a.g + (b.g - a.g) * mix),
    b: clampByte(a.b + (b.b - a.b) * mix),
  };
}

export function migratePaletteStops(stops, amount) {
  const normalized = normalizedPaletteStops(stops);
  if (!normalized.length) return [];
  return normalized.map((stop, index) => ({
    ...stop,
    color: mixColor(stop.color, normalized[(index + 1) % normalized.length].color, amount),
  }));
}

export function samplePaletteStops(stops, progress, options = {}) {
  const normalized = normalizedPaletteStops(stops);
  if (!normalized.length) return { r: 0, g: 0, b: 0 };
  if (normalized.length === 1) return colorToRgb(normalized[0].color);

  const interpolation = options.interpolation || 'smooth';
  let sample = clamp01(progress);
  if (interpolation === 'banded') {
    const bands = Math.max(2, Math.min(64, Math.round(finite(options.bands, normalized.length))));
    sample = Math.round(sample * (bands - 1)) / (bands - 1);
  } else if (interpolation !== 'smooth' && interpolation !== 'stepped') {
    throw new RangeError(`Unsupported palette interpolation: ${interpolation}`);
  }

  if (sample <= normalized[0].position) return colorToRgb(normalized[0].color);
  for (let index = 1; index < normalized.length; index += 1) {
    const right = normalized[index];
    if (sample <= right.position) {
      const left = normalized[index - 1];
      if (interpolation === 'stepped' && sample < right.position) return colorToRgb(left.color);
      const span = Math.max(1e-9, right.position - left.position);
      return mixColor(left.color, right.color, (sample - left.position) / span);
    }
  }
  return colorToRgb(normalized.at(-1).color);
}

function rgbToHsl(color) {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const lightness = (maximum + minimum) / 2;
  if (maximum === minimum) return { h: 0, s: 0, l: lightness };
  const difference = maximum - minimum;
  const saturation = lightness > 0.5
    ? difference / (2 - maximum - minimum)
    : difference / (maximum + minimum);
  let hue;
  if (maximum === r) hue = (g - b) / difference + (g < b ? 6 : 0);
  else if (maximum === g) hue = (b - r) / difference + 2;
  else hue = (r - g) / difference + 4;
  return { h: hue / 6, s: saturation, l: lightness };
}

function hueChannel(p, q, value) {
  let t = value;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb({ h, s, l }) {
  if (s === 0) {
    const gray = clampByte(l * 255);
    return { r: gray, g: gray, b: gray };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: clampByte(hueChannel(p, q, h + 1 / 3) * 255),
    g: clampByte(hueChannel(p, q, h) * 255),
    b: clampByte(hueChannel(p, q, h - 1 / 3) * 255),
  };
}

function adjustColor(color, options) {
  const original = colorToRgb(color);
  const [rawMinimum, rawMaximum] = Array.isArray(options.saturationBounds)
    ? options.saturationBounds
    : [0, 1];
  const minimum = clamp01(Math.min(rawMinimum, rawMaximum));
  const maximum = clamp01(Math.max(rawMinimum, rawMaximum));
  const hsl = rgbToHsl(original);
  hsl.s = clamp(hsl.s * clamp(options.saturation ?? 1, 0, 2), minimum, maximum);
  const saturated = hslToRgb(hsl);
  const warmth = clamp(options.warmth ?? 0, -1, 1);
  if (warmth >= 0) {
    return {
      r: clampByte(saturated.r + (255 - saturated.r) * 0.2 * warmth),
      g: clampByte(saturated.g + (255 - saturated.g) * 0.08 * warmth),
      b: clampByte(saturated.b * (1 - 0.25 * warmth)),
    };
  }
  const cool = -warmth;
  return {
    r: clampByte(saturated.r * (1 - 0.2 * cool)),
    g: clampByte(saturated.g + (255 - saturated.g) * 0.04 * cool),
    b: clampByte(saturated.b + (255 - saturated.b) * 0.2 * cool),
  };
}

export function adjustPaletteStops(stops, options = {}) {
  return normalizedPaletteStops(stops).map(stop => ({
    ...stop,
    color: adjustColor(stop.color, options),
  }));
}

export function applyIncandescentCooling(color, intensity) {
  const source = colorToRgb(color);
  const level = clamp01(intensity);
  return {
    r: clampByte(source.r * level),
    g: clampByte(source.g * level * (0.55 + 0.45 * level)),
    b: clampByte(source.b * level * (0.2 + 0.8 * level)),
  };
}
