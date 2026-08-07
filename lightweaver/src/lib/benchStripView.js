// Sending one strip of a design to whatever card is plugged in.
//
// A piece being designed may be four hundred lights that do not exist yet, while
// the card on the desk drives one short test strip. To see a pattern in real
// light before the piece is built, ONE strip of the design is chosen and its
// lights are sent to the front of the attached strip.
//
// Nothing is scaled and nothing is compressed. A chosen strip longer than the
// attached one simply runs off the end — the card lights what it has, in the
// design's own order, at the design's own resolution. That keeps what the eye
// sees on the bench honest: these are the real colours at the real spacing,
// just fewer of them.
//
// The alternative — masking non-chosen strips in place — is kept too, because it
// is the right answer once the whole piece IS wired and only one circle should
// light. Both take the design's frame and the spatial template it was rendered
// against, and return a new frame; neither touches the design.

const OFF = '000000';

function templateStripIdAt(template, index) {
  const sample = template?.[index];
  return sample && typeof sample === 'object' ? sample.stripId ?? null : null;
}

/**
 * The strips a template actually carries samples for, in the order the physical
 * chain visits them. This is what a "show me this one on the bench" picker
 * should offer — a strip the frame has no samples for cannot be shown.
 */
export function templateStripIds(template) {
  const seen = [];
  const known = new Set();
  const list = Array.isArray(template) ? template : [];
  for (let index = 0; index < list.length; index += 1) {
    const stripId = templateStripIdAt(list, index);
    if (stripId == null || known.has(stripId)) continue;
    known.add(stripId);
    seen.push(stripId);
  }
  return seen;
}

/**
 * How many lights of the design belong to one strip.
 */
export function templateStripLength(template, stripId) {
  const list = Array.isArray(template) ? template : [];
  let count = 0;
  for (let index = 0; index < list.length; index += 1) {
    if (templateStripIdAt(list, index) === stripId) count += 1;
  }
  return count;
}

/**
 * Move one strip's lights to the front of the frame, in the design's own order,
 * so they land on the first physical lights of whatever strip is attached.
 *
 * The returned frame is the same length as the one given, padded with darkness,
 * so the card is never sent a different number of lights than it is configured
 * for. Returns the frame unchanged when the strip is unknown or not asked for.
 */
export function compactFrameToStrip(frame, template, stripId) {
  if (!Array.isArray(frame) || !stripId) return frame;
  const list = Array.isArray(template) ? template : [];
  const out = [];
  for (let index = 0; index < frame.length && index < list.length; index += 1) {
    if (templateStripIdAt(list, index) === stripId) out.push(frame[index]);
  }
  if (!out.length) return frame;
  while (out.length < frame.length) out.push(OFF);
  out.length = frame.length;
  return out;
}

/**
 * Darken every light that is not the chosen strip, leaving the rest exactly
 * where they are. For a piece that is fully wired and only wants one circle lit.
 */
export function maskFrameToStrip(frame, template, stripId) {
  if (!Array.isArray(frame) || !stripId) return frame;
  const list = Array.isArray(template) ? template : [];
  return frame.map((value, index) => (templateStripIdAt(list, index) === stripId ? value : OFF));
}

/**
 * The one entry point a streaming loop calls. `view` is either the whole design
 * or one strip shown in one of the two ways above.
 */
export function applyBenchStripView(frame, template, view) {
  if (!view || !view.stripId || view.mode === 'whole') return frame;
  if (view.mode === 'mask') return maskFrameToStrip(frame, template, view.stripId);
  return compactFrameToStrip(frame, template, view.stripId);
}
