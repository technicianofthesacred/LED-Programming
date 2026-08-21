// svgSanitize.js
//
// PORTED, not rewritten, from led-art-mapper/app/src/project-format.js
// (originally `sanitizeMapperSvgSource`, `sanitizeSvgStyle`,
// `isSafeSvgPaintValue`, and the SAFE_SVG_* allowlists around
// project-format.js:482-545). The element/attribute/style-property
// allowlists, the 2 MB source cap, the 10000-element cap, and the
// per-attribute 64 KB cap are all unchanged in value and behavior from the
// mapper's copy. This is deliberately the same trust boundary applied to a
// second import path (Studio's layout SVG import via svgFlatten.js), not a
// fork of it — if the allowlists ever need to change, change both copies
// together and re-diff them.
//
// <use>/<symbol>/<defs> stay allowlisted on purpose, unlike everything else
// that isn't directly renderable: svgFlatten.js (sibling module) expands
// every <use> against its <symbol>/<defs> target *before* anything reads
// geometry out of the tree, so those elements must survive sanitization
// even though nothing renders them on their own.
//
// No dependencies, no DOM assumed at module scope. `documentImpl` is
// injectable (defaults to `globalThis.document`) so this runs against a
// real browser document today and a minimal stub under `node --test` — see
// svgDomStub.js, which is exercised by svgSanitize.test.js.
//
// Intended wiring (not implemented here — a later pass owns
// layoutGeometry.js / useLayoutImport.js): run sanitizeSvgSource() on the
// raw imported SVG text FIRST, before handing anything to
// flattenSvgDocument() in svgFlatten.js. Sanitize strips everything
// unsafe; flatten only ever has to reason about geometry.

export const SVG_SANITIZE_MAX_SOURCE_BYTES = 2 * 1024 * 1024; // mirrors MAPPER_MAX_SVG_SOURCE_BYTES
export const SVG_SANITIZE_MAX_ELEMENTS = 10000; // mirrors MAX_SVG_ELEMENTS
export const SVG_SANITIZE_MAX_ATTR_CHARS = 64 * 1024; // mirrors MAPPER_MAX_PATH_DATA_CHARS

export const SAFE_SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask',
  'title', 'desc', 'text', 'tspan',
]);

export const SAFE_SVG_ATTRIBUTES = new Set([
  'xmlns', 'xmlns:xlink', 'id', 'class', 'data-name',
  'viewbox', 'preserveaspectratio', 'transform',
  'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height',
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'display', 'visibility',
  'clip-path', 'mask',
  'offset', 'stop-color', 'stop-opacity',
  'gradientunits', 'gradienttransform', 'spreadmethod', 'fx', 'fy', 'fr',
  'font-family', 'font-size', 'font-style', 'font-weight', 'text-anchor',
  'href', 'xlink:href', 'style',
]);

export const SAFE_SVG_STYLE_PROPERTIES = new Set([
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'display', 'visibility', 'clip-path', 'mask',
  'stop-color', 'stop-opacity',
  'font-family', 'font-size', 'font-style', 'font-weight', 'text-anchor',
]);

function isSvgSourceWithinByteLimit(value, maxBytes) {
  if (typeof value !== 'string') return false;
  if (value.length > maxBytes) return false;
  return new TextEncoder().encode(value).byteLength <= maxBytes;
}

export function isSafeSvgPaintValue(value) {
  if (
    !value
    || value.length > 512
    || /(?:javascript:|expression\s*\(|@import|https?:|data:)/i.test(value)
  ) return false;
  const urls = [...value.matchAll(/url\s*\(([^)]*)\)/gi)];
  return urls.every(match => /^#[-\w:.]+$/.test(match[1].trim().replace(/^['"]|['"]$/g, '')));
}

export function sanitizeSvgStyle(style) {
  const declarations = [];
  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':');
    if (separator < 1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (!SAFE_SVG_STYLE_PROPERTIES.has(property) || !isSafeSvgPaintValue(value)) continue;
    declarations.push(`${property}:${value}`);
  }
  return declarations.join(';');
}

export function sanitizeSvgSource(svgSource, documentImpl = globalThis.document) {
  if (svgSource === undefined || svgSource === null || svgSource === '') {
    return { ok: true, svgSource };
  }
  if (
    typeof svgSource !== 'string'
    || !isSvgSourceWithinByteLimit(svgSource, SVG_SANITIZE_MAX_SOURCE_BYTES)
  ) {
    return { ok: false, reason: 'SVG artwork exceeds the 2 MB import limit.' };
  }
  const DOMParserImpl = documentImpl?.defaultView?.DOMParser ?? globalThis.DOMParser;
  const XMLSerializerImpl = documentImpl?.defaultView?.XMLSerializer ?? globalThis.XMLSerializer;
  if (!DOMParserImpl || !XMLSerializerImpl) {
    return { ok: false, reason: 'SVG artwork validation is unavailable.' };
  }
  if ((svgSource.match(/</g)?.length ?? 0) > SVG_SANITIZE_MAX_ELEMENTS * 2) {
    return { ok: false, reason: `SVG artwork exceeds the ${SVG_SANITIZE_MAX_ELEMENTS}-element limit.` };
  }

  const parsed = new DOMParserImpl().parseFromString(svgSource, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) {
    return { ok: false, reason: 'SVG artwork is not valid XML.' };
  }
  const root = parsed.documentElement;
  if (root?.localName?.toLowerCase() !== 'svg') {
    return { ok: false, reason: 'SVG artwork has no valid SVG root.' };
  }
  const elements = [root, ...root.querySelectorAll('*')];
  if (elements.length > SVG_SANITIZE_MAX_ELEMENTS) {
    return { ok: false, reason: `SVG artwork exceeds the ${SVG_SANITIZE_MAX_ELEMENTS}-element limit.` };
  }

  for (const element of elements) {
    const elementName = element.localName.toLowerCase();
    if (!SAFE_SVG_ELEMENTS.has(elementName)) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const attributeName = attribute.name.toLowerCase();
      if (
        attributeName.startsWith('on')
        || !SAFE_SVG_ATTRIBUTES.has(attributeName)
        || attribute.value.length > SVG_SANITIZE_MAX_ATTR_CHARS
      ) {
        element.removeAttributeNode(attribute);
        continue;
      }
      if (attributeName === 'href' || attributeName === 'xlink:href') {
        if (!/^#[A-Za-z_][\w:.-]*$/.test(attribute.value.trim())) {
          element.removeAttributeNode(attribute);
        }
        continue;
      }
      if (attributeName === 'style') {
        const sanitizedStyle = sanitizeSvgStyle(attribute.value);
        if (sanitizedStyle) element.setAttribute('style', sanitizedStyle);
        else element.removeAttributeNode(attribute);
        continue;
      }
      if (['fill', 'stroke', 'clip-path', 'mask'].includes(attributeName)) {
        if (!isSafeSvgPaintValue(attribute.value)) element.removeAttributeNode(attribute);
      }
    }
  }

  const sanitizedSvgSource = new XMLSerializerImpl().serializeToString(root);
  if (!isSvgSourceWithinByteLimit(sanitizedSvgSource, SVG_SANITIZE_MAX_SOURCE_BYTES)) {
    return { ok: false, reason: 'Sanitized SVG artwork exceeds the 2 MB import limit.' };
  }
  return { ok: true, svgSource: sanitizedSvgSource };
}
