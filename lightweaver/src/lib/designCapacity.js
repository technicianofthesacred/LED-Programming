// The design and the card are two different things, and they are never merged.
//
// `strips[]` is the piece being designed. It may be a 400-light mandala that has
// not been built yet. `portRoles[]` is whatever hardware happens to be plugged in
// right now — often a small development card with one 41-light test strip on it,
// used to see a pattern in real light before the real piece exists.
//
// A card smaller than the design is the NORMAL state during development, not an
// error. Nothing here reconciles the two: it only reports the relationship so a
// screen can say "lights 42-400 are not attached yet" instead of leaving a dark
// strip looking like a fault.
//
// The one place the drawing is allowed to follow the card is a brand-new project
// whose placeholder line nobody has touched — see shouldRescaleDrawing.
import { PORT_ROLE_STRIP } from './portRoles.js';

function pixelCountOf(strip) {
  const value = Number(strip?.pixelCount);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Total lights the design calls for, across every strip in the drawing.
 */
export function designPixelTotal(strips) {
  return (Array.isArray(strips) ? strips : []).reduce((sum, strip) => sum + pixelCountOf(strip), 0);
}

/**
 * The strip ports a counting walk has measured on the card that is attached now,
 * one entry per GPIO carrying a real length.
 */
export function measuredStripPorts(portRoles) {
  return (Array.isArray(portRoles) ? portRoles : []).filter(entry => entry
    && entry.role === PORT_ROLE_STRIP
    && Number.isInteger(entry.pin)
    && Number.isInteger(entry.pixelCount)
    && entry.pixelCount > 0);
}

/**
 * Total lights physically counted on the attached card.
 */
export function cardPixelTotal(portRoles) {
  return measuredStripPorts(portRoles).reduce((sum, entry) => sum + entry.pixelCount, 0);
}

/**
 * How the attached card relates to the design.
 *
 *   state: 'unmeasured' — nothing has been counted, so nothing can be said
 *          'short'      — the card has fewer lights than the design (a development
 *                         card, or a piece only partly wired). Normal.
 *          'matched'    — the card has exactly the design's lights
 *          'over'       — more lights are attached than the design uses
 *
 * `attached` / `unattached` split the design at the card's capacity, so a screen
 * can name the lights that will not come on yet.
 */
export function describeCardCapacity({ strips = [], portRoles = [] } = {}) {
  const designPixels = designPixelTotal(strips);
  const cardPixels = cardPixelTotal(portRoles);
  if (cardPixels <= 0) {
    return { state: 'unmeasured', designPixels, cardPixels: 0, attached: 0, unattached: designPixels };
  }
  const attached = Math.min(designPixels, cardPixels);
  const unattached = Math.max(0, designPixels - cardPixels);
  let state = 'matched';
  if (cardPixels < designPixels) state = 'short';
  else if (cardPixels > designPixels) state = 'over';
  return { state, designPixels, cardPixels, attached, unattached };
}

/**
 * May a counting walk reshape the drawing to the length it just measured?
 *
 * Only when the drawing is still the untouched factory placeholder, or when the
 * owner asked for it by pressing a button. `starterPending` is cleared by any
 * geometry or LED-count edit, so it means exactly "nobody has drawn this yet".
 *
 * Anything looser destroys work: an earlier version also accepted "the project
 * has no imported SVG", and since drawing strips by hand never sets svgText, a
 * hand-drawn 400-light design was silently rescaled down to the bench card's count.
 */
export function shouldRescaleDrawing({ starterPending = false, force = false } = {}) {
  return force === true || starterPending === true;
}

/**
 * Split `count` lights across the existing strips in their current proportions.
 *
 * Every shape is KEPT and scaled — deleting one instead would leave the wiring
 * plan and the zones pointing at something that no longer exists, and the card
 * refuses the whole project over it. Returns null when there is nothing to do.
 */
export function planStripCountShares(strips, count) {
  const list = Array.isArray(strips) ? strips : [];
  if (!list.length) return null;
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count < list.length) return null; // every shape must keep at least one light
  const total = list.reduce((sum, strip) => sum + pixelCountOf(strip), 0);
  if (total === count) return null;
  const shares = list.map(strip => Math.max(1, Math.round(
    ((pixelCountOf(strip) || 1) / (total || list.length)) * count,
  )));
  let drift = count - shares.reduce((sum, share) => sum + share, 0);
  // Rounding leaves the shares a little over or under; walk them back one light
  // at a time, never below one, until they add up to exactly what was counted.
  for (let pass = 0; drift !== 0 && pass < shares.length * 2; pass += 1) {
    const index = pass % shares.length;
    const step = drift > 0 ? 1 : -1;
    if (shares[index] + step >= 1) { shares[index] += step; drift -= step; }
  }
  return drift === 0 ? shares : null;
}
