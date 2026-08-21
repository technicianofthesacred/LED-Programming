// svgImportGeometry.test.js — the import path's contract, driven end to end
// through the REAL `measureLayers()` reader (not a stand-in for it), so
// these tests fail if the wiring is removed, reordered, or bypassed.
//
// `measureLayers` needs two DOM things: a document to hang `querySelector`
// off (supplied by svgDomStub's FakeDOMParser) and a global `document` for
// `measurePathLen`'s throwaway <path>. The stub's element has no
// `getTotalLength`, so `measurePathLen` returns 0 — that is fine here:
// every assertion below is about path GEOMETRY (which coordinates ended up
// in `d`), never about measured arc length, which is the browser's job and
// is covered in tests/workflow.spec.ts.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeDOMParser, FakeDocument } from './svgDomStub.js';
import { prepareSvgDocumentForImport } from './svgImportGeometry.js';
import { measureLayers } from './layoutGeometry.js';

globalThis.document = globalThis.document || new FakeDocument(null);

function parse(source) {
  return new FakeDOMParser().parseFromString(source);
}

// Every straight-line point in a `d` string. The fixtures below use only
// M/L/Z on purpose so a coordinate assertion reads as coordinates.
function pointsOf(pathData) {
  const out = [];
  const re = /([ML])\s*(-?[\d.eE+]+)[,\s]+(-?[\d.eE+]+)/g;
  let m;
  while ((m = re.exec(pathData))) out.push({ x: Number(m[2]), y: Number(m[3]) });
  return out;
}

function boundsOf(pathData) {
  const pts = pointsOf(pathData);
  return {
    minX: Math.min(...pts.map(p => p.x)),
    maxX: Math.max(...pts.map(p => p.x)),
    minY: Math.min(...pts.map(p => p.y)),
    maxY: Math.max(...pts.map(p => p.y)),
    count: pts.length,
  };
}

function hasPointNear(pathData, x, y, eps = 0.5) {
  return pointsOf(pathData).some(p => Math.abs(p.x - x) <= eps && Math.abs(p.y - y) <= eps);
}

// One 60-degree wedge of a mandala, pointing due right from the centre at
// (200,200): a spike reaching x=300 with a little width in y.
const WEDGE = 'M 200,200 L 300,180 L 300,220 Z';

// The six orientations that wedge takes in a six-fold piece. Rotating
// (300,180) about (200,200) by k*60 degrees.
function rotated(x, y, deg, cx = 200, cy = 200) {
  const r = (deg * Math.PI) / 180;
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * Math.cos(r) - dy * Math.sin(r), y: cy + dx * Math.sin(r) + dy * Math.cos(r) };
}

// ── The owner's actual file shape ───────────────────────────────────────────

// One wedge drawn once, five <use> clones rotated around the centre, all
// inside a single named layer. This is what a vector editor produces when
// you build a mandala the natural way.
const MANDALA_IN_ONE_LAYER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
  <g id="cuts" data-name="Cuts">
    <g id="wedge-0"><path d="${WEDGE}"/></g>
    <use href="#wedge-0" transform="rotate(60 200 200)"/>
    <use href="#wedge-0" transform="rotate(120 200 200)"/>
    <use href="#wedge-0" transform="rotate(180 200 200)"/>
    <use href="#wedge-0" transform="rotate(240 200 200)"/>
    <use href="#wedge-0" transform="rotate(300 200 200)"/>
  </g>
</svg>`;

test('a six-fold mandala imports whole, not as one sixth of itself', () => {
  const doc = parse(MANDALA_IN_ONE_LAYER);

  // Before wiring: the five <use> clones match no shape selector at all.
  const before = measureLayers(doc);
  assert.equal(before.length, 1);
  assert.equal(before[0].subPaths.length, 1, 'unflattened import sees only the one drawn wedge');

  const doc2 = parse(MANDALA_IN_ONE_LAYER);
  const prepared = prepareSvgDocumentForImport(doc2);
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.warnings, []);

  const after = measureLayers(doc2);
  assert.equal(after.length, 1, 'still one named layer');
  assert.equal(after[0].subPaths.length, 6, 'all six wedges are present');

  // And each one is where the artwork actually draws it.
  for (const deg of [0, 60, 120, 180, 240, 300]) {
    const tip = rotated(300, 180, deg);
    assert.ok(
      hasPointNear(after[0].pathData, tip.x, tip.y),
      `wedge at ${deg} degrees should reach (${tip.x.toFixed(1)}, ${tip.y.toFixed(1)})`,
    );
  }

  // The whole ring, not a right-hand sliver of it.
  const bounds = boundsOf(after[0].pathData);
  assert.ok(bounds.minX < 110, `left edge ${bounds.minX} should reach the far side of the centre`);
  assert.ok(bounds.maxX > 290);
  assert.ok(bounds.minY < 120);
  assert.ok(bounds.maxY > 280);
});

// The same piece built with each wedge as its own top-level group — the
// other idiom real files use. Here every wedge becomes its own layer.
const MANDALA_AS_TOP_LEVEL_USES = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
  <g id="wedge-0"><path d="${WEDGE}"/></g>
  <g transform="rotate(60 200 200)"><use href="#wedge-0"/></g>
  <use href="#wedge-0" transform="rotate(120 200 200)"/>
  <use href="#wedge-0" transform="rotate(180 200 200)"/>
  <g transform="rotate(240 200 200)"><use href="#wedge-0"/></g>
  <g transform="rotate(300 200 200)"><use href="#wedge-0"/></g>
</svg>`;

test('wedges duplicated at the top level each become their own layer, all six of them', () => {
  const doc = parse(MANDALA_AS_TOP_LEVEL_USES);
  assert.equal(prepareSvgDocumentForImport(doc).ok, true);
  const layers = measureLayers(doc);

  assert.equal(layers.length, 6, 'six wedges, six layers');
  for (const layer of layers) {
    assert.ok(layer.pathData, `layer "${layer.name}" must carry geometry, not an empty string`);
  }

  const everything = layers.map(l => l.pathData).join(' ');
  for (const deg of [0, 60, 120, 180, 240, 300]) {
    const tip = rotated(300, 180, deg);
    assert.ok(hasPointNear(everything, tip.x, tip.y), `missing the wedge at ${deg} degrees`);
  }
});

// ── Transforms on ordinary groups ───────────────────────────────────────────

test('a transformed group lands at the coordinates it is drawn at', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <g id="moved" data-name="Moved" transform="translate(100 50)">
    <rect x="0" y="0" width="10" height="20"/>
  </g>
</svg>`;

  const raw = measureLayers(parse(source));
  assert.ok(hasPointNear(raw[0].pathData, 0, 0), 'unwired reader places the rect at the origin');

  const doc = parse(source);
  assert.equal(prepareSvgDocumentForImport(doc).ok, true);
  const layers = measureLayers(doc);
  const bounds = boundsOf(layers[0].pathData);
  assert.equal(bounds.minX, 100);
  assert.equal(bounds.maxX, 110);
  assert.equal(bounds.minY, 50);
  assert.equal(bounds.maxY, 70);
});

test('nested group transforms compose, innermost last', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <g id="outer" data-name="Outer" transform="translate(200 200)">
    <g transform="rotate(90)">
      <path d="M 0,0 L 50,0"/>
    </g>
  </g>
</svg>`;
  const doc = parse(source);
  assert.equal(prepareSvgDocumentForImport(doc).ok, true);
  const [layer] = measureLayers(doc);
  assert.ok(hasPointNear(layer.pathData, 200, 200));
  assert.ok(hasPointNear(layer.pathData, 200, 250), 'rotate(90) sends "right" to "down"');
});

// ── The regression guard: ordinary flat artwork must not move ──────────────

const FLAT_ARTWORK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300">
  <g id="bg-layer" data-name="Background">
    <path d="M 20,20 L 380,20 L 380,280 L 20,280 Z"/>
  </g>
  <g id="line-layer" data-name="Line">
    <path d="M 60,230 L 340,230"/>
    <path d="M 60,240 L 340,240"/>
  </g>
  <g id="shapes-layer" data-name="Shapes">
    <rect x="10" y="10" width="30" height="40"/>
    <polygon points="100,100 140,100 120,140"/>
    <line x1="0" y1="0" x2="9" y2="9"/>
  </g>
</svg>`;

test('a flat SVG with no transforms and no <use> imports exactly as it did before', () => {
  const before = measureLayers(parse(FLAT_ARTWORK));

  const doc = parse(FLAT_ARTWORK);
  assert.equal(prepareSvgDocumentForImport(doc).ok, true);
  const after = measureLayers(doc);

  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i += 1) {
    assert.equal(after[i].layerId, before[i].layerId);
    assert.equal(after[i].name, before[i].name);
    assert.equal(after[i].subPaths.length, before[i].subPaths.length);
    // Not "equivalent" — byte-for-byte identical. An untransformed <path>
    // must come through untouched, so the `d` an exporter wrote is the `d`
    // that gets stored. (rect/polygon/line are converted to paths by the
    // same algorithm the old reader used, so they match verbatim too.)
    assert.equal(after[i].pathData, before[i].pathData);
    assert.deepEqual(
      after[i].subPaths.map(p => p.pathData),
      before[i].subPaths.map(p => p.pathData),
    );
  }
});

test('layer names and ids survive, including the Inkscape label fallback', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">
  <g id="ink-layer" inkscape:label="Cut lines"><path d="M 0,0 L 10,10"/></g>
  <g id="plain"><path d="M 0,0 L 20,20"/></g>
</svg>`;
  const doc = parse(source);
  assert.equal(prepareSvgDocumentForImport(doc).ok, true);
  const layers = measureLayers(doc);
  assert.equal(layers[0].name, 'Cut lines');
  assert.equal(layers[0].layerId, 'ink-layer');
  assert.equal(layers[1].name, 'plain');
});

// ── Pathological references degrade, they do not hang ──────────────────────

test('a <use> pointing at another <use> expands both', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <g id="art" data-name="Art">
    <g id="base"><path d="M 0,0 L 10,0"/></g>
    <g id="pair"><use href="#base" transform="translate(0 100)"/></g>
    <use href="#pair" transform="translate(200 0)"/>
  </g>
</svg>`;
  const doc = parse(source);
  const prepared = prepareSvgDocumentForImport(doc);
  assert.equal(prepared.ok, true);
  const everything = measureLayers(doc).map(l => l.pathData).join(' ');
  assert.ok(hasPointNear(everything, 10, 0), 'the original');
  assert.ok(hasPointNear(everything, 10, 100), 'the nested clone');
  assert.ok(hasPointNear(everything, 210, 100), 'the clone of the clone');
});

test('a self-referential <use> is dropped with a warning instead of hanging', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <g id="art" data-name="Art">
    <g id="loop"><path d="M 0,0 L 10,0"/><use href="#loop"/></g>
  </g>
</svg>`;
  const doc = parse(source);
  const prepared = prepareSvgDocumentForImport(doc);
  assert.equal(prepared.ok, true);
  assert.ok(prepared.warnings.some(w => /cycle/i.test(w)), `expected a cycle warning, got ${JSON.stringify(prepared.warnings)}`);
  const [layer] = measureLayers(doc);
  assert.ok(hasPointNear(layer.pathData, 10, 0), 'the real geometry still imports');
});

test('a mutually cyclic pair of <use> references terminates', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <g id="art" data-name="Art">
    <g id="a"><path d="M 0,0 L 10,0"/><use href="#b"/></g>
    <g id="b"><path d="M 0,50 L 10,50"/><use href="#a"/></g>
  </g>
</svg>`;
  const doc = parse(source);
  const prepared = prepareSvgDocumentForImport(doc);
  assert.equal(prepared.ok, true);
  const [layer] = measureLayers(doc);
  assert.ok(layer.pathData.length > 0);
  assert.ok(layer.pathData.length < 20000, 'a cycle must not blow the geometry up');
});

test('a <use> pointing at a missing id is dropped with a warning', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <g id="art" data-name="Art">
    <path d="M 0,0 L 10,0"/>
    <use href="#not-here" transform="translate(50 0)"/>
  </g>
</svg>`;
  const doc = parse(source);
  const prepared = prepareSvgDocumentForImport(doc);
  assert.equal(prepared.ok, true);
  assert.ok(prepared.warnings.some(w => /missing id "#not-here"/.test(w)), JSON.stringify(prepared.warnings));
  const [layer] = measureLayers(doc);
  assert.equal(pointsOf(layer.pathData).length, 2);
});

// ── Definition subtrees are references, not artwork ────────────────────────

test('a wedge defined in <defs> is measured once per visible copy, never as a ghost at the definition coordinates', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <defs>
    <g id="wedge-0"><path d="${WEDGE}"/></g>
  </defs>
  <g id="cuts" data-name="Cuts">
    <use href="#wedge-0"/>
    <use href="#wedge-0" transform="rotate(180 200 200)"/>
  </g>
</svg>`;
  const doc = parse(source);
  assert.equal(prepareSvgDocumentForImport(doc).ok, true);
  const layers = measureLayers(doc);
  assert.equal(layers.length, 1, 'the <defs> block must not become a layer of its own');
  assert.equal(layers[0].subPaths.length, 2, 'exactly the two visible copies');
  assert.ok(hasPointNear(layers[0].pathData, 300, 180));
  assert.ok(hasPointNear(layers[0].pathData, 100, 220));
});

test('a <symbol> target is unwrapped rather than imported as an extra layer', () => {
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <symbol id="motif"><path d="M 0,0 L 10,0"/></symbol>
  <g id="cuts" data-name="Cuts">
    <use href="#motif" x="100" y="100"/>
  </g>
</svg>`;
  const doc = parse(source);
  assert.equal(prepareSvgDocumentForImport(doc).ok, true);
  const layers = measureLayers(doc);
  assert.equal(layers.length, 1);
  assert.ok(hasPointNear(layers[0].pathData, 110, 100));
});

// ── Failure posture ────────────────────────────────────────────────────────

test('a document with no <svg> root reports not-ok and leaves the caller free to carry on', () => {
  const doc = parse('<notsvg><path d="M 0,0 L 1,1"/></notsvg>');
  const prepared = prepareSvgDocumentForImport(doc);
  assert.equal(prepared.ok, false);
  assert.match(prepared.reason, /svg/i);
});

test('preparation never throws, whatever it is handed', () => {
  for (const junk of [null, undefined, {}, 42, 'a string']) {
    const prepared = prepareSvgDocumentForImport(junk);
    assert.equal(prepared.ok, false);
    assert.equal(typeof prepared.reason, 'string');
  }
});
