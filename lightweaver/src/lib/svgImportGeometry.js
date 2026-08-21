// svgImportGeometry.js — the wiring layer between a freshly parsed SVG
// document and `measureLayers()` in layoutGeometry.js.
//
// WHY THIS EXISTS. `measureLayers()`/`shapeToD()` read raw geometry
// attributes (`d`, `cx/cy/r`, `points`, …) off whatever elements
// `querySelectorAll('path, rect, circle, …')` returns. That reader is
// correct only for a tree that has no `transform` attributes and no `<use>`
// instancing left in it:
//
//   * a `<g transform="rotate(60 200 200)">` is silently ignored, so its
//     contents import at the wrong coordinates;
//   * `<use>` matches none of those selectors, so a mandala drawn the
//     normal way — one wedge plus five rotated `<use>` clones — imports as
//     ONE SIXTH of itself, five wedges missing, with no error.
//
// `flattenSvgDocument()` (svgFlatten.js) produces exactly the tree that
// reader needs: every `<use>` expanded, every primitive converted to a
// `<path>`, every ancestor transform baked into the `d`. This module runs
// it in place on the parsed document and then clears away the parts of the
// tree the BROWSER never renders but `querySelectorAll` would still hand to
// the measurer.
//
// That last step is the piece flattening alone does not cover.
// `flattenSvgDocument` deliberately leaves `<defs>`/`<symbol>` untouched —
// it must, since `<use>` targets live there and are read during expansion.
// But once expansion is done, the definition subtrees are dead weight whose
// geometry is (a) never drawn on screen and (b) still in its own
// un-flattened coordinate space. Measuring them would draw a ghost copy of
// every reused motif at the wrong place. `<clipPath>`/`<mask>` are the same
// story: their shapes bound other shapes, they are not artwork.
//
// FAILURE POSTURE. Preparation never throws and never blocks an import. If
// anything goes wrong the caller is told to fall back to the raw parsed
// document — which is precisely the behaviour that shipped before this
// module existed, so a bad prepare can only ever return the old result, not
// a worse one.

import { flattenSvgDocument } from './svgFlatten.js';

// Subtrees the renderer never paints on their own. Removed AFTER `<use>`
// expansion has already read whatever it needed out of them.
const NON_RENDERED_TAGS = new Set(['defs', 'symbol', 'clippath', 'mask']);

function tagOf(el) {
  const raw = (el && (el.tagName || el.localName)) || '';
  return String(raw).replace(/^[^:]+:/, '').toLowerCase();
}

export function removeNonRenderedSubtrees(root) {
  let removed = 0;
  const visit = (node) => {
    for (const child of Array.from(node.children || [])) {
      if (NON_RENDERED_TAGS.has(tagOf(child))) {
        node.removeChild?.(child);
        removed += 1;
        continue;
      }
      visit(child);
    }
  };
  if (root) visit(root);
  return removed;
}

// prepareSvgDocumentForImport(doc, opts) -> { ok, root, warnings[], reason? }
//
// Mutates `doc` in place, so the caller keeps handing the SAME document to
// `measureLayers(doc)` it would have handed over before. `ok: false` means
// "measure the document as-is" — the document is still usable, it just did
// not get the benefit of flattening.
export function prepareSvgDocumentForImport(doc, opts = {}) {
  const warnings = [];
  try {
    const result = flattenSvgDocument(doc, opts);
    if (!result?.ok) {
      return { ok: false, root: null, warnings, reason: result?.reason || 'SVG could not be flattened.' };
    }
    warnings.push(...(result.warnings || []));
    removeNonRenderedSubtrees(result.root);
    return { ok: true, root: result.root, warnings };
  } catch (err) {
    return {
      ok: false,
      root: null,
      warnings,
      reason: `SVG could not be flattened: ${err?.message || err}`,
    };
  }
}
