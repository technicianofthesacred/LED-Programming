import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  assertReleaseProvenance,
  assertLegacyRouteRemoved,
  assertStudioRoot,
  parseStudioBuildGraph,
  resolveProductionUrls,
  verifyStudioBuildGraph,
} from './productionDeploymentCheck.js';

const response = (status, body = '', contentType = 'text/html') => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : null },
  text: async () => body,
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const graph = files => JSON.stringify({ schemaVersion: 1, files });
const fileEntry = (path, body) => {
  const bytes = Buffer.from(body);
  return { path, bytes: bytes.byteLength, sha256: sha256(bytes) };
};

function graphFetch(graphBody, files = {}, statuses = {}) {
  const requests = [];
  return {
    requests,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({ url: url.href, init });
      if (url.pathname === '/studio-build-graph.json') {
        return new Response(graphBody, { status: statuses[url.pathname] ?? 200 });
      }
      const body = files[url.pathname.slice(1)];
      return new Response(body ?? 'missing', { status: statuses[url.pathname] ?? (body === undefined ? 404 : 200) });
    },
  };
}

test('one PROD_ORIGIN derives every production check URL', () => {
  assert.deepEqual(resolveProductionUrls({ PROD_ORIGIN: 'https://preview.example.test/path' }), {
    studioUrl: 'https://preview.example.test/',
    productionSetupUrl: 'https://preview.example.test/#screen=production',
    legacyDesignUrl: 'https://preview.example.test/design',
    firmwareUrl: 'https://preview.example.test/firmware/lightweaver-controller-esp32s3-factory.bin',
    manifestUrl: 'https://preview.example.test/firmware/release-manifest.json',
    signatureUrl: 'https://preview.example.test/firmware/release-manifest.sig',
    provenanceUrl: 'https://preview.example.test/firmware/release-provenance.json',
    productionJobIndexUrl: 'https://preview.example.test/production/jobs/index.json',
    studioBuildGraphUrl: 'https://preview.example.test/studio-build-graph.json',
  });
});

test('Studio build graph accepts a sorted exact root and asset set', () => {
  const files = [
    fileEntry('assets/production-123.js', 'production'),
    fileEntry('assets/studio-123.css', 'style'),
    fileEntry('assets/studio-123.js', 'studio'),
    fileEntry('index.html', '<div id="root">'),
  ];
  assert.deepEqual(parseStudioBuildGraph(graph(files)), { schemaVersion: 1, files });
});

test('Studio build graph rejects malformed structure and unsafe paths', () => {
  const validIndex = fileEntry('index.html', 'root');
  const validJs = fileEntry('assets/studio.js', 'js');
  const malformed = [
    ['', /not valid JSON/],
    ['[]', /object/],
    [JSON.stringify({ schemaVersion: 2, files: [validJs, validIndex] }), /schemaVersion/],
    [graph([validJs]), /index\.html/],
    [graph([validIndex]), /JavaScript/],
    [graph([validIndex, validJs]), /sorted/],
    [graph([validJs, validJs, validIndex]), /duplicate/],
    [graph([{ ...validJs, path: '../studio.js' }, validIndex]), /normalized root-relative/],
    [graph([{ ...validJs, path: '/assets/studio.js' }, validIndex]), /normalized root-relative/],
    [graph([{ ...validJs, path: 'https://evil.test/studio.js' }, validIndex]), /normalized root-relative/],
    [graph([{ ...validJs, path: 'assets\\studio.js' }, validIndex]), /normalized root-relative/],
    [graph([{ ...validJs, path: 'assets/../studio.js' }, validIndex]), /normalized root-relative/],
    [graph([{ ...validJs, path: 'studio-build-graph.json' }, validIndex]), /must not list itself/],
    [graph([{ ...validJs, bytes: -1 }, validIndex]), /byte size/],
    [graph([{ ...validJs, bytes: 1.5 }, validIndex]), /byte size/],
    [graph([{ ...validJs, sha256: 'A'.repeat(64) }, validIndex]), /lowercase SHA-256/],
    [graph([{ ...validJs, sha256: 'a'.repeat(63) }, validIndex]), /lowercase SHA-256/],
  ];
  for (const [body, expected] of malformed) {
    assert.throws(() => parseStudioBuildGraph(body), expected, body);
  }
});

test('live graph verification fetches every listed file from the graph origin with no-store', async () => {
  const bodies = {
    'assets/studio.css': 'style',
    'assets/studio.js': 'studio',
    'index.html': '<div id="root">',
  };
  const entries = Object.entries(bodies).map(([path, body]) => fileEntry(path, body));
  const harness = graphFetch(graph(entries), bodies);
  const result = await verifyStudioBuildGraph(harness.fetch, webcrypto, 'https://example.test/studio-build-graph.json');
  assert.deepEqual(result.graph.files, entries);
  assert.deepEqual(harness.requests.map(request => new URL(request.url).pathname), [
    '/studio-build-graph.json', '/assets/studio.css', '/assets/studio.js', '/index.html',
  ]);
  assert.ok(harness.requests.every(request => request.init.cache === 'no-store'));
});

test('live graph verification detects a stale root loader', async () => {
  const expected = {
    'assets/studio.js': 'studio',
    'index.html': '<script src="/assets/studio.js">',
  };
  const entries = Object.entries(expected).map(([path, body]) => fileEntry(path, body));
  const harness = graphFetch(graph(entries), { ...expected, 'index.html': '<script src="/assets/old.js">' });
  await assert.rejects(
    verifyStudioBuildGraph(harness.fetch, webcrypto, 'https://example.test/studio-build-graph.json'),
    /index\.html.*expected .*sha256.*actual .*sha256/s,
  );
});

test('live graph verification detects a stale lazy Production chunk not named by root HTML', async () => {
  const expected = {
    'assets/production.js': 'new-production-screen',
    'assets/studio.js': 'root-loader',
    'index.html': '<script src="/assets/studio.js">',
  };
  const entries = Object.entries(expected).map(([path, body]) => fileEntry(path, body));
  const harness = graphFetch(graph(entries), { ...expected, 'assets/production.js': 'old-production-screen' });
  await assert.rejects(
    verifyStudioBuildGraph(harness.fetch, webcrypto, 'https://example.test/studio-build-graph.json'),
    /assets\/production\.js.*expected .*actual /s,
  );
});

test('live graph verification cannot skip a missing graph or asset', async () => {
  const entries = [fileEntry('assets/studio.js', 'studio'), fileEntry('index.html', 'root')];
  const missingGraph = graphFetch('', {}, { '/studio-build-graph.json': 404 });
  await assert.rejects(
    verifyStudioBuildGraph(missingGraph.fetch, webcrypto, 'https://example.test/studio-build-graph.json'),
    /graph answered HTTP 404/,
  );
  const missingAsset = graphFetch(graph(entries), { 'index.html': 'root' });
  await assert.rejects(
    verifyStudioBuildGraph(missingAsset.fetch, webcrypto, 'https://example.test/studio-build-graph.json'),
    /assets\/studio\.js answered HTTP 404/,
  );
});

test('live graph verification reports the first lexicographic mismatch deterministically', async () => {
  const expected = {
    'assets/a.js': 'new-a',
    'assets/z.js': 'new-z',
    'index.html': 'root',
  };
  const entries = Object.entries(expected).map(([path, body]) => fileEntry(path, body));
  const harness = graphFetch(graph(entries), {
    ...expected,
    'assets/a.js': 'old-a',
    'assets/z.js': 'old-z-that-also-has-a-different-size',
  });
  await assert.rejects(
    verifyStudioBuildGraph(harness.fetch, webcrypto, 'https://example.test/studio-build-graph.json'),
    error => error.message.includes('assets/a.js') && !error.message.includes('assets/z.js'),
  );
});

test('mutable firmware metadata cannot be cached while immutable releases can be cached forever', async () => {
  const headers = await readFile(resolve(import.meta.dirname, '../../public/_headers'), 'utf8');
  for (const path of [
    '/studio-build-graph.json',
    '/firmware/release-manifest.json',
    '/firmware/release-manifest.sig',
    '/firmware/release-provenance.json',
    '/firmware/lightweaver-controller-esp32s3-factory.bin',
  ]) {
    assert.match(headers, new RegExp(`${path.replaceAll('.', '\\.')}\n  Cache-Control: no-store`));
  }
  assert.match(headers, /\/firmware\/releases\/\*\n  Cache-Control: public, max-age=31536000, immutable/);
});

test('Studio root must contain the root application shell', async () => {
  await assert.doesNotReject(assertStudioRoot(response(200, '<div id="root"></div>'), 'https://example.test/'));
  await assert.rejects(assertStudioRoot(response(200, '<h1>Other site</h1>'), 'https://example.test/'), /does not contain/);
  await assert.rejects(assertStudioRoot(response(500), 'https://example.test/'), /HTTP 500/);
});

test('removed design route requires the branded 404 response', async () => {
  await assert.doesNotReject(assertLegacyRouteRemoved(response(404, '<title>Page not found · Lightweaver</title>'), 'https://example.test/design'));
  for (const status of [200, 301, 403, 429, 500]) {
    await assert.rejects(
      assertLegacyRouteRemoved(response(status, '<title>Page not found · Lightweaver</title>'), 'https://example.test/design'),
      new RegExp(`expected HTTP 404, received ${status}`),
    );
  }
  await assert.rejects(assertLegacyRouteRemoved(response(404, 'generic proxy error'), 'https://example.test/design'), /not the Lightweaver 404/);
});

test('published provenance must identify the exact signed firmware release', async () => {
  const manifest = {
    buildId: 'a'.repeat(40), firmwareVersion: '1.0.0', target: 'esp32-s3-n16r8',
    image: { url: '/firmware/releases/1.0.0/a/image.bin', size: 123, sha256: 'b'.repeat(64) },
    provenance: { platformio: '6.1.19', sourceRevision: 'a'.repeat(40) },
  };
  const provenance = {
    schemaVersion: 1, sourceRevision: 'a'.repeat(40), buildId: 'a'.repeat(40),
    firmwareVersion: '1.0.0', target: 'esp32-s3-n16r8', image: manifest.image,
    workflowRun: '42', toolchain: { sourceRevision: 'a'.repeat(40), platformio: '6.1.19' },
  };
  await assert.doesNotReject(assertReleaseProvenance(
    response(200, JSON.stringify(provenance), 'application/json'), manifest, 'https://example.test/firmware/release-provenance.json',
  ));
  await assert.rejects(assertReleaseProvenance(
    response(200, JSON.stringify({ ...provenance, buildId: 'c'.repeat(40) }), 'application/json'), manifest, 'https://example.test/provenance',
  ), /does not match the signed manifest/);
  await assert.rejects(assertReleaseProvenance(
    response(200, JSON.stringify({ ...provenance, toolchain: { ...provenance.toolchain, platformio: 'untrusted' } }), 'application/json'), manifest, 'https://example.test/provenance',
  ), /does not match the signed manifest/);
  await assert.rejects(assertReleaseProvenance(response(404), manifest, 'https://example.test/provenance'), /HTTP 404/);
});
