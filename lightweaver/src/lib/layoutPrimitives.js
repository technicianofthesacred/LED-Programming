export const STARTER_PRIMITIVES = Object.freeze([
  { key: 'line', label: 'Line' },
  { key: 'circle', label: 'Circle' },
  { key: 'square', label: 'Square' },
  { key: 'free', label: 'Free draw' },
]);

export const DEFAULT_STARTER_PIXEL_COUNT = 37;

function parseViewBox(viewBox = '0 0 640 400') {
  const values = String(viewBox).trim().split(/[\s,]+/).map(Number);
  return {
    x: Number.isFinite(values[0]) ? values[0] : 0,
    y: Number.isFinite(values[1]) ? values[1] : 0,
    w: Number.isFinite(values[2]) && values[2] > 0 ? values[2] : 640,
    h: Number.isFinite(values[3]) && values[3] > 0 ? values[3] : 400,
  };
}

const n = value => Number(value.toFixed(3));

export function createPrimitiveStripDefinition({
  type,
  viewBox = '0 0 640 400',
  pixelCount = DEFAULT_STARTER_PIXEL_COUNT,
  id = 'strip-1',
  color = 'oklch(78% 0.14 40)',
} = {}) {
  const vb = parseViewBox(viewBox);
  const cx = vb.x + vb.w / 2;
  const cy = vb.y + vb.h / 2;
  const shortSide = Math.min(vb.w, vb.h);
  let pathData;
  let svgLength;
  let closed = false;
  let name;

  if (type === 'circle') {
    const radius = shortSide * 0.27;
    pathData = `M ${n(cx - radius)} ${n(cy)} A ${n(radius)} ${n(radius)} 0 1 0 ${n(cx + radius)} ${n(cy)} A ${n(radius)} ${n(radius)} 0 1 0 ${n(cx - radius)} ${n(cy)} Z`;
    svgLength = Math.PI * 2 * radius;
    closed = true;
    name = 'Circle';
  } else if (type === 'square') {
    const side = shortSide * 0.54;
    const left = cx - side / 2;
    const top = cy - side / 2;
    pathData = `M ${n(left)} ${n(top)} H ${n(left + side)} V ${n(top + side)} H ${n(left)} Z`;
    svgLength = side * 4;
    closed = true;
    name = 'Square';
  } else {
    const halfWidth = vb.w * 0.3;
    pathData = `M ${n(cx - halfWidth)} ${n(cy)} L ${n(cx + halfWidth)} ${n(cy)}`;
    svgLength = halfWidth * 2;
    name = 'Line';
  }

  return {
    id,
    sourceLayerId: null,
    sourcePathId: null,
    name,
    pathData,
    svgLength,
    closed,
    pixelCount: Math.max(1, Math.round(Number(pixelCount) || DEFAULT_STARTER_PIXEL_COUNT)),
    color,
    x: 0,
    y: 0,
    emit: closed ? 'omni' : 'dir',
    angle: 0,
    reversed: false,
    speed: 1,
    brightness: 1,
    hueShift: 0,
    patternId: null,
  };
}
