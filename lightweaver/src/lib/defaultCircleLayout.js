export const DEFAULT_CIRCLE_LAYOUT_ID = 'default-circle-v1';
export const DEFAULT_CIRCLE_TOTAL_PIXELS = 44;
export const DEFAULT_CIRCLE_SECTION_COUNT = 2;
export const DEFAULT_CIRCLE_VIEW_BOX = '0 0 640 400';
export const DEFAULT_CIRCLE_SECTION_LIMIT = 10;
export const DEFAULT_CIRCLE_PIXEL_LIMIT = 2048;

const DEFAULT_SECTION_NAMES = [
  'Outer circle',
  'Inner circle',
  'Ring 3',
  'Ring 4',
  'Ring 5',
  'Ring 6',
  'Ring 7',
  'Ring 8',
  'Ring 9',
  'Ring 10',
];

const DEFAULT_SECTION_ROLES = [
  'outer',
  'inner',
  'ring-3',
  'ring-4',
  'ring-5',
  'ring-6',
  'ring-7',
  'ring-8',
  'ring-9',
  'ring-10',
];

// Warm earthy default palette (amber / terracotta / sage range) so the
// default rings glow warm like the v3 Layout mockup — no cold blue/magenta.
const DEFAULT_SECTION_COLORS = [
  'oklch(80% 0.130 72)',
  'oklch(78% 0.140 40)',
  'oklch(74% 0.075 168)',
  'oklch(80% 0.110 95)',
  'oklch(78% 0.150 30)',
  'oklch(72% 0.090 150)',
  'oklch(80% 0.120 130)',
  'oklch(76% 0.140 12)',
  'oklch(80% 0.130 60)',
  'oklch(74% 0.095 110)',
];

function clampInteger(value, min, max, fallback) {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function clampHardwarePixelCount(value, fallback = DEFAULT_CIRCLE_TOTAL_PIXELS) {
  return clampInteger(value, 1, DEFAULT_CIRCLE_PIXEL_LIMIT, fallback);
}

export function clampHardwareSectionCount(value, fallback = DEFAULT_CIRCLE_SECTION_COUNT) {
  return clampInteger(value, 1, DEFAULT_CIRCLE_SECTION_LIMIT, fallback);
}

export function distributePixels(totalPixels = DEFAULT_CIRCLE_TOTAL_PIXELS, sectionCount = DEFAULT_CIRCLE_SECTION_COUNT) {
  const total = clampHardwarePixelCount(totalPixels);
  const count = clampHardwareSectionCount(sectionCount);
  const base = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0));
}

function parseViewBox(viewBox = DEFAULT_CIRCLE_VIEW_BOX) {
  const parts = String(viewBox || DEFAULT_CIRCLE_VIEW_BOX).trim().split(/[\s,]+/).map(Number);
  return {
    x: Number.isFinite(parts[0]) ? parts[0] : 0,
    y: Number.isFinite(parts[1]) ? parts[1] : 0,
    w: Number.isFinite(parts[2]) && parts[2] > 0 ? parts[2] : 640,
    h: Number.isFinite(parts[3]) && parts[3] > 0 ? parts[3] : 400,
  };
}

function circlePath(cx, cy, r) {
  return `M ${(cx - r).toFixed(3)},${cy.toFixed(3)} A ${r.toFixed(3)},${r.toFixed(3)} 0 1 0 ${(cx + r).toFixed(3)},${cy.toFixed(3)} A ${r.toFixed(3)},${r.toFixed(3)} 0 1 0 ${(cx - r).toFixed(3)},${cy.toFixed(3)} Z`;
}

function circlePixels(cx, cy, r, count) {
  return Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? 0 : index / count;
    const angle = -Math.PI / 2 + t * Math.PI * 2;
    return {
      x: Number((cx + Math.cos(angle) * r).toFixed(3)),
      y: Number((cy + Math.sin(angle) * r).toFixed(3)),
      index,
    };
  });
}

function sectionId(index) {
  if (index === 0) return 'default-outer-circle';
  if (index === 1) return 'default-inner-circle';
  return `default-ring-${index + 1}`;
}

export function createDefaultCircleLayout({
  totalPixels = DEFAULT_CIRCLE_TOTAL_PIXELS,
  sectionCount = DEFAULT_CIRCLE_SECTION_COUNT,
  sectionPixelCounts = null,
  viewBox = DEFAULT_CIRCLE_VIEW_BOX,
} = {}) {
  const pixelCounts = Array.isArray(sectionPixelCounts) && sectionPixelCounts.length
    ? sectionPixelCounts
        .slice(0, DEFAULT_CIRCLE_SECTION_LIMIT)
        .map(value => clampHardwarePixelCount(value, 1))
    : distributePixels(totalPixels, sectionCount);
  const count = clampHardwareSectionCount(pixelCounts.length);
  const vb = parseViewBox(viewBox);
  const cx = vb.x + vb.w / 2;
  const cy = vb.y + vb.h / 2;
  const maxRadius = Math.min(vb.w, vb.h) * 0.36;
  const minRadius = Math.min(vb.w, vb.h) * 0.16;
  const step = count <= 1 ? 0 : (maxRadius - minRadius) / (count - 1);

  return pixelCounts.slice(0, count).map((pixels, index) => {
    const r = maxRadius - step * index;
    const id = sectionId(index);
    return {
      id,
      name: DEFAULT_SECTION_NAMES[index] || `Ring ${index + 1}`,
      pathData: circlePath(cx, cy, r),
      svgLength: Math.PI * 2 * r,
      pixelCount: pixels,
      pixels: circlePixels(cx, cy, r, pixels),
      color: DEFAULT_SECTION_COLORS[index % DEFAULT_SECTION_COLORS.length],
      x: 0,
      y: 0,
      emit: 'omni',
      angle: 0,
      reversed: false,
      speed: 1,
      brightness: 1,
      hueShift: 0,
      patternId: null,
      generatedLayout: DEFAULT_CIRCLE_LAYOUT_ID,
      layoutRole: DEFAULT_SECTION_ROLES[index] || `ring-${index + 1}`,
    };
  });
}

export function isDefaultCircleLayout(strips = []) {
  return Array.isArray(strips) &&
    strips.length > 0 &&
    strips.every(strip => strip?.generatedLayout === DEFAULT_CIRCLE_LAYOUT_ID);
}

export function countsFromDefaultCircleLayout(strips = []) {
  return Array.isArray(strips)
    ? strips.map(strip => clampHardwarePixelCount(strip?.pixelCount ?? strip?.pixels?.length, 1))
    : [];
}
