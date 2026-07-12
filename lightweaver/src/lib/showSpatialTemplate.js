import {
  RINGS,
  TOTAL_PIXELS,
  ringOf,
  rfOf,
  angOf,
} from './mandalaEngine.js';
import { expandPatchBoard } from './patchBoard.js';

const TAU = Math.PI * 2;

function polarAngle(x, y) {
  const angle = Math.atan2(y, x);
  return angle < 0 ? angle + TAU : angle;
}

function validPoints(strip) {
  if (!Array.isArray(strip?.pixels)) return [];
  return strip.pixels.filter((point) => (
    Number.isFinite(point?.x) && Number.isFinite(point?.y)
  ));
}

function normalizeStrips(strips) {
  return Array.isArray(strips) ? strips : [];
}

function normalizeHidden(hidden) {
  return hidden && typeof hidden === 'object' ? hidden : {};
}

export function createMandalaSpatialTemplate() {
  return Array.from({ length: TOTAL_PIXELS }, (_, outputIndex) => {
    const stripIndex = ringOf[outputIndex];
    const ring = RINGS[stripIndex];
    const stripProgress = (outputIndex - ring.start) / (ring.count - 1);
    const radius = rfOf[outputIndex];
    const angle = angOf[outputIndex];
    return {
      outputIndex,
      stripId: `ring-${stripIndex + 1}`,
      stripIndex,
      stripProgress,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      radius,
      angle,
    };
  });
}

export function hasUsableConnectedLayout(strips = [], hidden = {}) {
  const sourceStrips = normalizeStrips(strips);
  const hiddenById = normalizeHidden(hidden);
  return sourceStrips.some((strip) => (
    strip && !hiddenById[strip.id] && !strip.hidden && validPoints(strip).length > 0
  ));
}

export function createConnectedSpatialTemplate(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const strips = normalizeStrips(source.strips);
  const hidden = normalizeHidden(source.hidden);
  const usePhysicalChain = source.patchBoard && typeof source.patchBoard === 'object';
  const physicalStrips = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  if (usePhysicalChain) {
    const stripIndexById = new Map(strips.map((strip, index) => [strip?.id, index]));
    const stripById = new Map(strips.map(strip => [strip?.id, strip]));
    const expanded = expandPatchBoard(source.patchBoard, strips).pixels;
    const points = expanded.map(pixel => {
      const strip = stripById.get(pixel.stripId);
      const inactive = pixel.inactive || pixel.stripId == null || hidden[pixel.stripId]
        || strip?.hidden
        || !Number.isFinite(pixel.x) || !Number.isFinite(pixel.y);
      if (inactive) return { inactive: true, x: 0, y: 0, stripId: null, stripIndex: -1, stripProgress: 0 };
      const count = strip?.pixels?.length || 1;
      return {
        inactive: false,
        x: pixel.x,
        y: pixel.y,
        stripId: pixel.stripId,
        stripIndex: stripIndexById.get(pixel.stripId) ?? 0,
        stripProgress: count > 1 ? pixel.sourceLed / (count - 1) : 0,
      };
    });
    physicalStrips.push({ physicalPoints: points });
    for (const point of points) {
      if (point.inactive) continue;
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }

  for (let stripIndex = 0; !usePhysicalChain && stripIndex < strips.length; stripIndex += 1) {
    const strip = strips[stripIndex];
    if (!strip || hidden[strip.id] || strip.hidden) continue;
    const points = validPoints(strip);
    if (points.length === 0) continue;
    physicalStrips.push({ strip, stripIndex, points });
    for (const point of points) {
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.y > maxY) maxY = point.y;
    }
  }

  if (physicalStrips.length === 0) return [];

  const range = Math.max(maxX - minX, maxY - minY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const scale = range > 0 ? 2 / range : 0;
  const samples = [];

  if (usePhysicalChain) {
    for (const point of physicalStrips[0].physicalPoints) {
      const x = point.inactive || !Number.isFinite(range) ? 0 : (point.x - centerX) * scale;
      const y = point.inactive || !Number.isFinite(range) ? 0 : (point.y - centerY) * scale;
      samples.push({
        outputIndex: samples.length,
        stripId: point.stripId,
        stripIndex: point.stripIndex,
        stripProgress: point.stripProgress,
        x,
        y,
        radius: Math.hypot(x, y),
        angle: polarAngle(x, y),
      });
    }
    return samples;
  }

  for (const { strip, stripIndex, points: stripPoints } of physicalStrips) {
    for (let pixelIndex = 0; pixelIndex < stripPoints.length; pixelIndex += 1) {
      const point = stripPoints[pixelIndex];
      const x = (point.x - centerX) * scale;
      const y = (point.y - centerY) * scale;
      samples.push({
        outputIndex: samples.length,
        stripId: strip.id,
        stripIndex,
        stripProgress: stripPoints.length > 1 ? pixelIndex / (stripPoints.length - 1) : 0,
        x,
        y,
        radius: Math.hypot(x, y),
        angle: polarAngle(x, y),
      });
    }
  }

  return samples;
}
