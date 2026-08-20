// Splitting one drawn strip into two.
//
// The inverse of "Combine into one strip": a single reel becomes two named
// strips that still run in the same order on the same output, so an owner can
// map one continuous run across two layers of the artwork and light them
// independently.

// A cut divides a physical reel, so the LED total never changes. An odd count
// gives the extra light to the first half (41 → 21 + 20), matching where an
// owner would actually cut a reel of 41.
export function planStripSplitCounts(pixelCount) {
  const total = Math.max(0, Math.trunc(Number(pixelCount) || 0));
  if (total < 2) return null;
  const head = Math.ceil(total / 2);
  return { head, tail: total - head, total };
}

// Where along the path the cut falls, as a 0..1 fraction of its length.
// `reversed` strips are sampled end-first, so their first half is the far end
// of the path and the fraction is mirrored.
export function splitFractionForCounts(counts, reversed = false) {
  if (!counts) return null;
  const fraction = counts.head / counts.total;
  return reversed ? 1 - fraction : fraction;
}

// Trace part of a path as a path of its own. Sampled densely rather than cut
// analytically, so half of a circle still draws as an arc and not as a chord.
export function pathSegment(pathData, fromFraction, toFraction, { spacing = 3, minPoints = 24 } = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  element.setAttribute('d', String(pathData || ''));
  if (typeof element.getTotalLength !== 'function') return null;
  const total = element.getTotalLength();
  if (!(total > 0)) return null;
  const from = Math.max(0, Math.min(1, Number(fromFraction)));
  const to = Math.max(0, Math.min(1, Number(toFraction)));
  if (!(to > from)) return null;
  const span = (to - from) * total;
  const steps = Math.max(minPoints, Math.ceil(span / spacing));
  const points = [];
  for (let i = 0; i <= steps; i += 1) {
    const point = element.getPointAtLength((from + (to - from) * (i / steps)) * total);
    points.push(`${point.x.toFixed(2)},${point.y.toFixed(2)}`);
  }
  return `M ${points.join(' L ')}`;
}

// The two path halves in LED order: `head` holds LED 1 onward, `tail` the rest.
export function splitStripPaths(pathData, counts, reversed = false, options = {}) {
  const cut = splitFractionForCounts(counts, reversed);
  if (cut == null) return null;
  // Reversed strips run end-first, so the head of the LED run is the tail of
  // the path and the two segments swap sides of the cut.
  const head = reversed
    ? pathSegment(pathData, cut, 1, options)
    : pathSegment(pathData, 0, cut, options);
  const tail = reversed
    ? pathSegment(pathData, 0, cut, options)
    : pathSegment(pathData, cut, 1, options);
  if (!head || !tail) return null;
  return { head, tail };
}

// "Ring" already taken → "Ring 2", then "Ring 3". Keeps the original row's
// name untouched so nothing the owner has labelled gets renamed underneath them.
export function nextSplitName(baseName, takenNames = []) {
  const taken = new Set(takenNames);
  const base = String(baseName || 'Strip').trim() || 'Strip';
  let suffix = 2;
  while (taken.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}
