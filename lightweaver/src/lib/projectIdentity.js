// The one place a project id is normalized for comparison across the Studio /
// card boundary.
//
// The card sanitizes every id it stores (`sanitizeId` in cardRuntimeContract.js)
// before writing it to NVS, so a Studio project named `Ocean Mandala` comes back
// from /api/status as `ocean-mandala`. Any Studio-side equality check against a
// card-reported project id has to cross that same boundary, or a correctly
// installed card reads as a permanent project mismatch — which is exactly the
// "Needs attention → Continue in Setup → Find my card" loop this exists to stop.
export function sanitizeProjectId(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
