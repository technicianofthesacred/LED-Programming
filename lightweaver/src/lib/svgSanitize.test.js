import test from 'node:test';
import assert from 'node:assert/strict';

import {
  sanitizeSvgSource,
  sanitizeSvgStyle,
  isSafeSvgPaintValue,
  SAFE_SVG_ELEMENTS,
  SAFE_SVG_ATTRIBUTES,
  SVG_SANITIZE_MAX_SOURCE_BYTES,
  SVG_SANITIZE_MAX_ELEMENTS,
  SVG_SANITIZE_MAX_ATTR_CHARS,
} from './svgSanitize.js';

import { makeFakeDocumentImpl } from './svgDomStub.js';

const doc = makeFakeDocumentImpl();

test('sanitizeSvgSource: empty/null/undefined pass through untouched', () => {
  assert.deepEqual(sanitizeSvgSource(undefined, doc), { ok: true, svgSource: undefined });
  assert.deepEqual(sanitizeSvgSource(null, doc), { ok: true, svgSource: null });
  assert.deepEqual(sanitizeSvgSource('', doc), { ok: true, svgSource: '' });
});

test('sanitizeSvgSource: non-string input is rejected', () => {
  const result = sanitizeSvgSource(1234, doc);
  assert.equal(result.ok, false);
});

test('sanitizeSvgSource: oversized source is rejected before parsing', () => {
  const huge = `<svg>${'x'.repeat(SVG_SANITIZE_MAX_SOURCE_BYTES + 10)}</svg>`;
  const result = sanitizeSvgSource(huge, doc);
  assert.equal(result.ok, false);
  assert.match(result.reason, /2 MB/);
});

test('sanitizeSvgSource: malformed XML is rejected', () => {
  const result = sanitizeSvgSource('<svg><path d="M 0,0"></svg>', doc);
  assert.equal(result.ok, false);
  assert.match(result.reason, /valid XML/i);
});

test('sanitizeSvgSource: a non-svg root is rejected', () => {
  const result = sanitizeSvgSource('<div><path d="M 0,0"/></div>', doc);
  assert.equal(result.ok, false);
  assert.match(result.reason, /svg root/i);
});

test('sanitizeSvgSource: a clean well-formed SVG round-trips with its geometry intact', () => {
  const src = '<svg xmlns="http://www.w3.org/2000/svg"><path id="p1" d="M 0,0 L 10,10" fill="#ff0000"/></svg>';
  const result = sanitizeSvgSource(src, doc);
  assert.equal(result.ok, true);
  assert.match(result.svgSource, /<path/);
  assert.match(result.svgSource, /d="M 0,0 L 10,10"/);
  assert.match(result.svgSource, /fill="#ff0000"/);
});

test('sanitizeSvgSource: <use>/<symbol>/<defs> survive — svgFlatten needs them', () => {
  const src = '<svg><defs><symbol id="dot"><circle cx="0" cy="0" r="5"/></symbol></defs><use href="#dot" x="10" y="10"/></svg>';
  const result = sanitizeSvgSource(src, doc);
  assert.equal(result.ok, true);
  assert.match(result.svgSource, /<defs>/);
  assert.match(result.svgSource, /<symbol/);
  assert.match(result.svgSource, /<use/);
  assert.match(result.svgSource, /href="#dot"/);
});

test('sanitizeSvgSource: disallowed elements (script, foreignObject) are removed, siblings survive', () => {
  const src = '<svg><script>alert(1)</script><foreignObject><div>x</div></foreignObject><path d="M 0,0 L 1,1"/></svg>';
  const result = sanitizeSvgSource(src, doc);
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.svgSource, /script/i);
  assert.doesNotMatch(result.svgSource, /foreignObject/i);
  assert.match(result.svgSource, /<path/);
});

test('sanitizeSvgSource: on* event handler attributes are stripped', () => {
  const src = '<svg><path d="M 0,0" onclick="alert(1)"/></svg>';
  const result = sanitizeSvgSource(src, doc);
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.svgSource, /onclick/i);
});

test('sanitizeSvgSource: attributes not on the allowlist are stripped', () => {
  const src = '<svg><path d="M 0,0" data-evil="yes"/></svg>';
  const result = sanitizeSvgSource(src, doc);
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.svgSource, /data-evil/);
});

test('sanitizeSvgSource: an oversized attribute value is stripped', () => {
  const long = 'M ' + '0,0 '.repeat(SVG_SANITIZE_MAX_ATTR_CHARS);
  const src = `<svg><path d="${long}"/></svg>`;
  const result = sanitizeSvgSource(src, doc);
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.svgSource, /d="/);
});

test('sanitizeSvgSource: href only allows local fragment references', () => {
  const localOk = '<svg><use href="#dot"/></svg>';
  const okResult = sanitizeSvgSource(localOk, doc);
  assert.match(okResult.svgSource, /href="#dot"/);

  const external = '<svg><use href="https://evil.example/payload.svg#x"/></svg>';
  const badResult = sanitizeSvgSource(external, doc);
  assert.doesNotMatch(badResult.svgSource, /href=/);
});

test('sanitizeSvgSource: style attribute keeps only safe declarations', () => {
  const src = '<svg><path d="M 0,0" style="fill:red;behavior:url(evil.htc);opacity:0.5"/></svg>';
  const result = sanitizeSvgSource(src, doc);
  assert.equal(result.ok, true);
  assert.match(result.svgSource, /fill:red/);
  assert.match(result.svgSource, /opacity:0.5/);
  assert.doesNotMatch(result.svgSource, /behavior/);
});

test('sanitizeSvgSource: a style attribute that sanitizes to nothing is removed entirely', () => {
  const src = '<svg><path d="M 0,0" style="behavior:url(evil.htc)"/></svg>';
  const result = sanitizeSvgSource(src, doc);
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.svgSource, /style=/);
});

test('sanitizeSvgSource: fill/stroke with a javascript: or data: URL is stripped', () => {
  const src = '<svg><path d="M 0,0" fill="url(javascript:alert(1))" stroke="#00ff00"/></svg>';
  const result = sanitizeSvgSource(src, doc);
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.svgSource, /fill=/);
  assert.match(result.svgSource, /stroke="#00ff00"/);
});

test('sanitizeSvgSource: element-count cap is enforced', () => {
  const many = Array.from({ length: SVG_SANITIZE_MAX_ELEMENTS + 5 }, (_, i) => `<path id="p${i}" d="M 0,0"/>`).join('');
  const src = `<svg>${many}</svg>`;
  const result = sanitizeSvgSource(src, doc);
  assert.equal(result.ok, false);
  assert.match(result.reason, /element limit/);
});

test('sanitizeSvgSource: without an injected DOMParser/XMLSerializer, fails cleanly', () => {
  const result = sanitizeSvgSource('<svg><path d="M 0,0"/></svg>', { defaultView: {} });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unavailable/i);
});

// ── helpers ported alongside the sanitizer ──────────────────────────────────

test('isSafeSvgPaintValue: rejects javascript:/data:/http(s): and long values', () => {
  assert.equal(isSafeSvgPaintValue('#ff0000'), true);
  assert.equal(isSafeSvgPaintValue('javascript:alert(1)'), false);
  assert.equal(isSafeSvgPaintValue('data:text/html,evil'), false);
  assert.equal(isSafeSvgPaintValue('https://example.com/x.png'), false);
  assert.equal(isSafeSvgPaintValue('x'.repeat(600)), false);
  assert.equal(isSafeSvgPaintValue('url(#gradient1)'), true);
  assert.equal(isSafeSvgPaintValue('url(https://evil.example/x)'), false);
});

test('sanitizeSvgStyle: drops unsafe properties and unsafe values, keeps the rest', () => {
  assert.equal(sanitizeSvgStyle('fill:red;color:blue'), 'fill:red'); // 'color' not allowlisted
  assert.equal(sanitizeSvgStyle('fill:url(javascript:x);opacity:1'), 'opacity:1');
  assert.equal(sanitizeSvgStyle(''), '');
});

test('allowlists include what svgFlatten needs and exclude script-relevant elements', () => {
  assert.equal(SAFE_SVG_ELEMENTS.has('use'), true);
  assert.equal(SAFE_SVG_ELEMENTS.has('symbol'), true);
  assert.equal(SAFE_SVG_ELEMENTS.has('defs'), true);
  assert.equal(SAFE_SVG_ELEMENTS.has('script'), false);
  assert.equal(SAFE_SVG_ELEMENTS.has('foreignobject'), false);
  assert.equal(SAFE_SVG_ATTRIBUTES.has('transform'), true);
  assert.equal(SAFE_SVG_ATTRIBUTES.has('onclick'), false);
});
