import {
  RINGS,
  TOTAL_PIXELS,
  ringOf,
  rfOf,
  angOf,
} from './mandalaEngine.js';

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
  return strips.some((strip) => (
    strip && !hidden[strip.id] && !strip.hidden && validPoints(strip).length > 0
  ));
}

export function createConnectedSpatialTemplate({ strips = [], hidden = {} } = {}) {
  const physicalStrips = strips.flatMap((strip, stripIndex) => {
    if (!strip || hidden[strip.id] || strip.hidden) return [];
    const points = validPoints(strip);
    if (points.length === 0) return [];
    return [{ strip, stripIndex, points }];
  });
  const points = physicalStrips.flatMap(({ points: stripPoints }) => stripPoints);
  if (points.length === 0) return [];

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const range = Math.max(maxX - minX, maxY - minY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const scale = range > 0 ? 2 / range : 0;
  const samples = [];

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
