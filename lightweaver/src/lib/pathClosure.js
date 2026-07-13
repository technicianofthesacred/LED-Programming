export function isClosedPathData(pathData = '', explicit = undefined) {
  if (typeof explicit === 'boolean') return explicit;
  const value = String(pathData || '').trim();
  if (!value) return false;
  if (/[zZ]\s*$/.test(value)) return true;
  if (typeof document === 'undefined') return false;
  try {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', value);
    const length = path.getTotalLength();
    if (!(length > 0)) return false;
    const first = path.getPointAtLength(0);
    const last = path.getPointAtLength(length);
    return Math.hypot(first.x - last.x, first.y - last.y) <= Math.max(1e-6, length * 1e-6);
  } catch {
    return false;
  }
}
