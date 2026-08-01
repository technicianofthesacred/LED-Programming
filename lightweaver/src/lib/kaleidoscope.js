export const KALEIDOSCOPE_REFLECTION_POINTS_VERSION = 1;

function integer(value) {
  return Number.isInteger(value);
}

function modulo(value, modulus) {
  return ((value % modulus) + modulus) % modulus;
}

function error(code, message) {
  return { code, message };
}

function automaticPoint(startLed, pointIndex, pixelCount, pointCount) {
  return modulo(startLed + Math.round(pointIndex * pixelCount / pointCount), pixelCount);
}

export function createDefaultKaleidoscope(pixelCount, startLed = 0) {
  if (!integer(pixelCount) || pixelCount < 2) throw new RangeError('Kaleidoscope requires at least 2 LEDs.');
  const pointCount = Math.min(4, pixelCount);
  return {
    enabled: true,
    pointCount,
    startLed: modulo(Math.round(Number(startLed) || 0), pixelCount),
    offsets: Array(pointCount).fill(0),
  };
}

export function deriveReflectionPointIndices(mapping, pixelCount) {
  if (!mapping || !integer(pixelCount) || pixelCount < 1) return [];
  return Array.from({ length: mapping.pointCount }, (_, pointIndex) => modulo(
    automaticPoint(mapping.startLed, pointIndex, pixelCount, mapping.pointCount)
      + mapping.offsets[pointIndex],
    pixelCount,
  ));
}

function orderedPointError(points, pixelCount) {
  let travelled = 0;
  for (let index = 0; index < points.length; index += 1) {
    const distance = modulo(points[(index + 1) % points.length] - points[index], pixelCount);
    if (distance === 0) return error('point-collision', 'A reflection point cannot collide with its neighbor.');
    travelled += distance;
  }
  return travelled === pixelCount
    ? null
    : error('point-crossing', 'A reflection point cannot cross its neighbor.');
}

export function validateKaleidoscope(mapping, pixelCount) {
  if (mapping == null || mapping?.enabled === false) return { ok: true, value: null, errors: [] };
  const errors = [];
  if (!integer(pixelCount) || pixelCount < 2) errors.push(error('pixel-count', 'Kaleidoscope requires at least 2 LEDs.'));
  if (!mapping || mapping.enabled !== true) errors.push(error('mapping-shape', 'Kaleidoscope metadata must be enabled explicitly.'));
  const pointCount = mapping?.pointCount;
  if (!integer(pointCount) || pointCount < 2 || pointCount > pixelCount) {
    errors.push(error('point-count', `Reflection point count must be an integer from 2 through ${pixelCount}.`));
  }
  if (!integer(mapping?.startLed) || mapping.startLed < 0 || mapping.startLed >= pixelCount) {
    errors.push(error('start-led', `Starting LED must be an integer from 0 through ${Math.max(0, pixelCount - 1)}.`));
  }
  if (!Array.isArray(mapping?.offsets) || mapping.offsets.length !== pointCount
    || mapping.offsets.some(offset => !integer(offset) || Math.abs(offset) > pixelCount - 1)) {
    errors.push(error('offsets', 'Kaleidoscope offsets must contain one bounded integer per reflection point.'));
  }
  if (errors.length) return { ok: false, value: null, errors };
  const value = {
    enabled: true,
    pointCount,
    startLed: mapping.startLed,
    offsets: [...mapping.offsets],
  };
  const orderError = orderedPointError(deriveReflectionPointIndices(value, pixelCount), pixelCount);
  if (orderError) return { ok: false, value: null, errors: [orderError] };
  return { ok: true, value, errors: [] };
}

export function normalizeKaleidoscope(mapping, pixelCount) {
  const validation = validateKaleidoscope(mapping, pixelCount);
  if (!validation.ok || !validation.value) {
    return { enabled: false, value: null, points: [], errors: validation.errors };
  }
  return {
    enabled: true,
    value: validation.value,
    points: deriveReflectionPointIndices(validation.value, pixelCount),
    errors: [],
  };
}

export function setKaleidoscopePointCount(mapping, pixelCount, pointCount) {
  if (!integer(pointCount) || pointCount < 2 || pointCount > pixelCount) {
    throw new RangeError(`Reflection point count must be an integer from 2 through ${pixelCount}.`);
  }
  const current = validateKaleidoscope(mapping, pixelCount);
  if (!current.ok || !current.value) throw new RangeError(current.errors[0]?.message || 'Invalid Kaleidoscope mapping.');
  return { ...current.value, pointCount, offsets: Array(pointCount).fill(0) };
}

export function nudgeKaleidoscopeStart(mapping, pixelCount, delta) {
  const current = validateKaleidoscope(mapping, pixelCount);
  if (!current.ok || !current.value) throw new RangeError(current.errors[0]?.message || 'Invalid Kaleidoscope mapping.');
  return { ...current.value, startLed: modulo(current.value.startLed + Math.trunc(Number(delta) || 0), pixelCount) };
}

export function nudgeKaleidoscopePoint(mapping, pixelCount, pointIndex, delta) {
  const current = validateKaleidoscope(mapping, pixelCount);
  if (!current.ok || !current.value) return { ok: false, value: mapping, error: current.errors[0] };
  if (!integer(pointIndex) || pointIndex < 0 || pointIndex >= current.value.pointCount) {
    return { ok: false, value: current.value, error: error('point-index', 'Choose a valid reflection point.') };
  }
  const offsets = [...current.value.offsets];
  offsets[pointIndex] += Math.trunc(Number(delta) || 0);
  const next = validateKaleidoscope({ ...current.value, offsets }, pixelCount);
  if (!next.ok) return { ok: false, value: current.value, error: next.errors[0] };
  return { ok: true, value: next.value, error: null };
}

function mappingFromOrderedPoints(points, pointCount, startLed, pixelCount) {
  return {
    enabled: true,
    pointCount,
    startLed,
    offsets: points.map((point, index) => (
      point - automaticPoint(startLed, index, pixelCount, pointCount)
    )),
  };
}

function orderFromStart(points, startLed, pixelCount) {
  return [...points].sort((a, b) => modulo(a - startLed, pixelCount) - modulo(b - startLed, pixelCount));
}

export function reverseKaleidoscope(mapping, pixelCount) {
  const current = validateKaleidoscope(mapping, pixelCount);
  if (!current.ok || !current.value) return mapping;
  const startLed = pixelCount - 1 - current.value.startLed;
  const transformed = deriveReflectionPointIndices(current.value, pixelCount)
    .map(point => pixelCount - 1 - point);
  const ordered = orderFromStart(transformed, startLed, pixelCount);
  const candidate = mappingFromOrderedPoints(ordered, current.value.pointCount, startLed, pixelCount);
  return validateKaleidoscope(candidate, pixelCount).value || createDefaultKaleidoscope(pixelCount, startLed);
}

function projectIndex(index, oldPixelCount, newPixelCount) {
  return modulo(Math.round(index * newPixelCount / oldPixelCount), newPixelCount);
}

export function reprojectKaleidoscope(mapping, oldPixelCount, newPixelCount) {
  const current = validateKaleidoscope(mapping, oldPixelCount);
  if (!current.ok || !current.value || newPixelCount < 2) return { value: null, resetPointIndices: [] };
  const pointCount = Math.min(current.value.pointCount, newPixelCount);
  const startLed = projectIndex(current.value.startLed, oldPixelCount, newPixelCount);
  const targets = deriveReflectionPointIndices(current.value, oldPixelCount)
    .slice(0, pointCount)
    .map(point => projectIndex(point, oldPixelCount, newPixelCount));
  let candidate = mappingFromOrderedPoints(targets, pointCount, startLed, newPixelCount);
  let validation = validateKaleidoscope(candidate, newPixelCount);
  if (validation.ok) return { value: validation.value, resetPointIndices: [] };

  const resetPointIndices = [];
  for (let attempt = 0; attempt < pointCount && !validation.ok; attempt += 1) {
    const points = deriveReflectionPointIndices(candidate, newPixelCount);
    let resetIndex = -1;
    for (let index = 0; index < pointCount; index += 1) {
      const next = (index + 1) % pointCount;
      if (points[index] === points[next]) {
        resetIndex = candidate.offsets[next] !== 0 ? next : index;
        break;
      }
    }
    if (resetIndex < 0) resetIndex = candidate.offsets.findIndex(offset => offset !== 0);
    if (resetIndex < 0) break;
    candidate = {
      ...candidate,
      offsets: candidate.offsets.map((offset, index) => index === resetIndex ? 0 : offset),
    };
    resetPointIndices.push(resetIndex);
    validation = validateKaleidoscope(candidate, newPixelCount);
  }
  if (validation.ok) {
    return { value: validation.value, resetPointIndices: [...new Set(resetPointIndices)].sort((a, b) => a - b) };
  }
  const value = { enabled: true, pointCount, startLed, offsets: Array(pointCount).fill(0) };
  return {
    value,
    resetPointIndices: Array.from(new Set([
      ...resetPointIndices,
      ...candidate.offsets.flatMap((offset, index) => offset === 0 ? [] : [index]),
    ])).sort((a, b) => a - b),
  };
}

export function reprojectStripKaleidoscope(strip, newPixelCount) {
  const oldPixelCount = Math.max(0, Math.trunc(Number(strip?.pixelCount) || 0));
  const nextPixelCount = Math.max(0, Math.trunc(Number(newPixelCount) || 0));
  if (!strip || nextPixelCount === oldPixelCount) return { strip, resetPointIndices: [] };
  if (!strip.kaleidoscope) {
    return { strip: { ...strip, pixelCount: nextPixelCount }, resetPointIndices: [] };
  }
  const { value, resetPointIndices } = reprojectKaleidoscope(
    strip.kaleidoscope,
    oldPixelCount,
    nextPixelCount,
  );
  const next = { ...strip, pixelCount: nextPixelCount };
  if (value) next.kaleidoscope = value;
  else delete next.kaleidoscope;
  return { strip: next, resetPointIndices };
}

function deriveReflectionPixelContextRaw(compiledContext, sourceLed) {
  const pixelCount = Math.max(1, Math.trunc(compiledContext?.pixelCount || 0));
  const points = compiledContext?.points || [];
  const led = modulo(Math.trunc(sourceLed), pixelCount);
  const exactPoint = points.indexOf(led);
  const segment = exactPoint >= 0
    ? exactPoint
    : points.findIndex((point, index) => {
      const length = modulo(points[(index + 1) % points.length] - point, pixelCount);
      return modulo(led - point, pixelCount) < length;
    });
  const safeSegment = segment < 0 ? 0 : segment;
  const start = points[safeSegment] ?? 0;
  const nextIndex = (safeSegment + 1) % Math.max(1, points.length);
  const end = points[nextIndex] ?? start;
  const length = Math.max(1, modulo(end - start, pixelCount));
  const fromStart = exactPoint >= 0 ? 0 : modulo(led - start, pixelCount);
  const reflectionProgress = fromStart / length;
  const fromEnd = length - fromStart;
  const tie = exactPoint < 0 && fromStart === fromEnd;
  return {
    reflectionProgress,
    kaleidoscopeProgress: safeSegment % 2 === 0 ? reflectionProgress : 1 - reflectionProgress,
    reflectionDistance: Math.min(1, Math.min(fromStart, fromEnd) / (length / 2)),
    reflectionSegment: safeSegment,
    reflectionPoint: exactPoint >= 0 ? exactPoint : tie ? null : (fromStart < fromEnd ? safeSegment : nextIndex),
    isReflectionPoint: exactPoint >= 0,
  };
}

export function compileKaleidoscopePixelContext(mapping, pixelCount) {
  const normalized = normalizeKaleidoscope(mapping, pixelCount);
  if (!normalized.enabled) return null;
  const compiled = {
    pixelCount,
    mapping: normalized.value,
    points: normalized.points,
    pixelContexts: [],
  };
  compiled.pixelContexts = Array(pixelCount);
  compiled.points.forEach((start, reflectionSegment) => {
    const nextIndex = (reflectionSegment + 1) % compiled.points.length;
    const end = compiled.points[nextIndex];
    const length = modulo(end - start, pixelCount);
    for (let fromStart = 0; fromStart < length; fromStart += 1) {
      const sourceLed = modulo(start + fromStart, pixelCount);
      const isReflectionPoint = fromStart === 0;
      const fromEnd = length - fromStart;
      const reflectionProgress = fromStart / length;
      const tie = !isReflectionPoint && fromStart === fromEnd;
      compiled.pixelContexts[sourceLed] = {
        reflectionProgress,
        kaleidoscopeProgress: reflectionSegment % 2 === 0 ? reflectionProgress : 1 - reflectionProgress,
        reflectionDistance: Math.min(1, Math.min(fromStart, fromEnd) / (length / 2)),
        reflectionSegment,
        reflectionPoint: isReflectionPoint
          ? reflectionSegment
          : tie ? null : (fromStart < fromEnd ? reflectionSegment : nextIndex),
        isReflectionPoint,
      };
    }
  });
  return compiled;
}

export function deriveReflectionPixelContext(compiledContext, sourceLed) {
  const pixelCount = Math.max(1, Math.trunc(compiledContext?.pixelCount || 0));
  const led = modulo(Math.trunc(sourceLed), pixelCount);
  return compiledContext?.pixelContexts?.[led]
    || deriveReflectionPixelContextRaw(compiledContext, led);
}
