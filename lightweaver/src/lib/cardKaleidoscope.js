import { validateKaleidoscope } from './kaleidoscope.js';

export const CARD_KALEIDOSCOPE_MAX_MAPPINGS = 32;
export const CARD_KALEIDOSCOPE_MAX_SPANS_PER_MAPPING = 4;
export const CARD_KALEIDOSCOPE_MAX_AGGREGATE_OFFSETS = 1024;

const compileError = (code, stripId, message) => ({ code, stripId, message });

function stripPixelCount(strip) {
  return Math.max(0, Math.trunc(Number(
    strip?.pixelCount ?? strip?.pixels?.length ?? strip?.leds ?? 0,
  )));
}

function zoneContainsPixel(zone, pixelIndex) {
  return (zone?.ranges || []).some(range => (
    Number.isInteger(range?.start)
    && Number.isInteger(range?.count)
    && pixelIndex >= range.start
    && pixelIndex < range.start + range.count
  ));
}

function compressSpans(pixels) {
  const spans = [];
  let previous = null;
  for (const pixel of pixels) {
    const span = spans[spans.length - 1];
    const sourceStep = previous ? pixel.sourceLed - previous.sourceLed : 0;
    const continues = previous
      && pixel.index === previous.index + 1
      && pixel.outputId === previous.outputId
      && (sourceStep === 1 || sourceStep === -1)
      && (span.count === 1 || span.sourceStep === sourceStep);
    if (continues) {
      if (span.count === 1) span.sourceStep = sourceStep;
      span.count += 1;
    } else {
      spans.push({
        start: pixel.index,
        count: 1,
        sourceStart: pixel.sourceLed,
        sourceStep: 1,
      });
    }
    previous = pixel;
  }
  return spans;
}

function exactSourceCoverage(pixels, pixelCount) {
  if (pixels.length !== pixelCount) return false;
  const counts = Array(pixelCount).fill(0);
  for (const pixel of pixels) {
    if (!Number.isInteger(pixel.sourceLed) || pixel.sourceLed < 0 || pixel.sourceLed >= pixelCount) {
      return false;
    }
    counts[pixel.sourceLed] += 1;
  }
  return counts.every(count => count === 1);
}

export function compileCardKaleidoscopeMappings({ strips = [], pixels = [], zones = [] } = {}) {
  const errors = [];
  const mappings = [];
  let aggregateOffsets = 0;
  const enabledStrips = strips.filter(strip => strip?.kaleidoscope?.enabled === true);

  if (enabledStrips.length > CARD_KALEIDOSCOPE_MAX_MAPPINGS) {
    errors.push(compileError(
      'kaleidoscope-mapping-limit',
      '',
      `Card runtime supports at most ${CARD_KALEIDOSCOPE_MAX_MAPPINGS} Kaleidoscope mappings.`,
    ));
  }

  for (const strip of enabledStrips) {
    const stripId = String(strip?.id || '');
    const pixelCount = stripPixelCount(strip);
    const validation = validateKaleidoscope(strip.kaleidoscope, pixelCount);
    if (!validation.ok || !validation.value) {
      errors.push(compileError(
        'kaleidoscope-invalid',
        stripId,
        validation.errors[0]?.message || `Strip ${stripId} has invalid Kaleidoscope metadata.`,
      ));
      continue;
    }

    aggregateOffsets += validation.value.offsets.length;
    const sourcePixels = pixels
      .filter(pixel => pixel?.stripId === stripId && pixel?.inactive !== true)
      .sort((left, right) => left.index - right.index);
    if (!exactSourceCoverage(sourcePixels, pixelCount)) {
      errors.push(compileError(
        'kaleidoscope-source-coverage',
        stripId,
        `Strip ${stripId} must map every source LED exactly once for standalone Kaleidoscope playback.`,
      ));
      continue;
    }

    const zoneIds = new Set();
    let zoneCoverageExact = true;
    for (const pixel of sourcePixels) {
      const matches = zones.filter(zone => zoneContainsPixel(zone, pixel.index));
      if (matches.length !== 1) zoneCoverageExact = false;
      for (const zone of matches) zoneIds.add(String(zone.id || ''));
    }
    if (!zoneCoverageExact || zoneIds.size !== 1 || zoneIds.has('')) {
      errors.push(compileError(
        'kaleidoscope-zone-coverage',
        stripId,
        `Strip ${stripId} must belong to exactly one runtime zone.`,
      ));
      continue;
    }

    const spans = compressSpans(sourcePixels);
    if (spans.length > CARD_KALEIDOSCOPE_MAX_SPANS_PER_MAPPING) {
      errors.push(compileError(
        'kaleidoscope-span-limit',
        stripId,
        `Strip ${stripId} needs ${spans.length} spans; card runtime supports ${CARD_KALEIDOSCOPE_MAX_SPANS_PER_MAPPING}.`,
      ));
      continue;
    }

    mappings.push({
      id: stripId,
      zoneId: [...zoneIds][0],
      pixelCount,
      pointCount: validation.value.pointCount,
      startLed: validation.value.startLed,
      offsets: [...validation.value.offsets],
      spans,
    });
  }

  if (aggregateOffsets > CARD_KALEIDOSCOPE_MAX_AGGREGATE_OFFSETS) {
    errors.push(compileError(
      'kaleidoscope-offset-limit',
      '',
      `Card runtime supports at most ${CARD_KALEIDOSCOPE_MAX_AGGREGATE_OFFSETS} aggregate reflection-point offsets.`,
    ));
  }

  return { ok: errors.length === 0, mappings, errors };
}

export function runtimeConfigUsesKaleidoscope(runtimePackageOrConfig = {}) {
  const config = runtimePackageOrConfig?.config && typeof runtimePackageOrConfig.config === 'object'
    ? runtimePackageOrConfig.config
    : runtimePackageOrConfig;
  return Array.isArray(config?.kaleidoscopeMappings) && config.kaleidoscopeMappings.length > 0;
}
