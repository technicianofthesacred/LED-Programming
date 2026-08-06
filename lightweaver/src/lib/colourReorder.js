// The colour step is a reorder, not a quiz (T11).
//
// The card lights the strip with three blocks — red, then green, then blue —
// driven under the named order the card reports (declaredOrder, default 'GRB').
// The owner looks at the strip and drags three chips into the order they
// actually see: seenIds[0] is what the first SENT block (red) rendered as, and
// so on. That single answer fixes the strip's true wiring.

import { COLOR_ORDERS } from './usbLedColorOrder.js';

export const COLOUR_PROBE_BLOCKS = [
  { id: 'red', hex: 'FF0000' },
  { id: 'green', hex: '00FF00' },
  { id: 'blue', hex: '0000FF' },
];

const COLOUR_IDS = COLOUR_PROBE_BLOCKS.map(block => block.id);

export function buildColourProbeFrame(pixelCount) {
  const count = Math.trunc(Number(pixelCount));
  if (!Number.isSafeInteger(count) || count <= 0) return [];
  const base = Math.floor(count / 3);
  const remainder = count % 3;
  const sizes = [base, base, base];
  for (let index = 0; index < remainder; index += 1) sizes[index] += 1;
  const frame = [];
  sizes.forEach((size, index) => {
    const hex = COLOUR_PROBE_BLOCKS[index].hex;
    for (let pixel = 0; pixel < size; pixel += 1) frame.push(hex);
  });
  return frame;
}

const LETTER_FOR_COLOUR_ID = Object.freeze({ red: 'R', green: 'G', blue: 'B' });
const COLOUR_ID_FOR_LETTER = Object.freeze({ R: 'red', G: 'green', B: 'blue' });

// Work it out by composing permutations, never a lookup table:
//   - the card serializes a hex colour under the DECLARED order D, so a block's
//     red amount lands on byte position D.indexOf('R'), its green amount on
//     D.indexOf('G'), its blue amount on D.indexOf('B');
//   - the physical strip maps byte position k to its TRUE channel T[k];
//   - so the red SENT block renders as colour T[D.indexOf('R')], the green block
//     as T[D.indexOf('G')], the blue block as T[D.indexOf('B')].
// Holding D fixed, every candidate true order predicts a seen order, and the
// owner's drag is the measurement: return the ONE candidate that reproduces it.
// When D and T are the same permutation the prediction is exactly red, green,
// blue, so seeing that falls out as D itself.
function predictedSeenOrder(declaredOrder, trueOrder) {
  return COLOUR_IDS.map(id => COLOUR_ID_FOR_LETTER[trueOrder[declaredOrder.indexOf(LETTER_FOR_COLOUR_ID[id])]]);
}

export function colourOrderFromSeenOrder(seenIds, declaredOrder = 'GRB') {
  const declared = String(declaredOrder || '').trim().toUpperCase();
  if (!COLOR_ORDERS.includes(declared)) return '';
  if (!Array.isArray(seenIds) || seenIds.length !== COLOUR_IDS.length) return '';
  if (seenIds.some(id => !COLOUR_IDS.includes(id))) return '';
  if (new Set(seenIds).size !== COLOUR_IDS.length) return '';
  for (const candidate of COLOR_ORDERS) {
    const predicted = predictedSeenOrder(declared, candidate);
    if (predicted.every((colour, index) => colour === seenIds[index])) return candidate;
  }
  return '';
}
