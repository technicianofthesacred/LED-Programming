import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  assertLegacyRouteRemoved,
  assertStudioRoot,
  resolveProductionUrls,
} from './productionDeploymentCheck.js';

const response = (status, body = '', contentType = 'text/html') => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: name => name.toLowerCase() === 'content-type' ? contentType : null },
  text: async () => body,
});

test('one PROD_ORIGIN derives every production check URL', () => {
  assert.deepEqual(resolveProductionUrls({ PROD_ORIGIN: 'https://preview.example.test/path' }), {
    studioUrl: 'https://preview.example.test/',
    legacyDesignUrl: 'https://preview.example.test/design',
    firmwareUrl: 'https://preview.example.test/firmware/lightweaver-controller-esp32s3-factory.bin',
    manifestUrl: 'https://preview.example.test/firmware/release-manifest.json',
    signatureUrl: 'https://preview.example.test/firmware/release-manifest.sig',
  });
});

test('mutable firmware metadata cannot be cached while immutable releases can be cached forever', async () => {
  const headers = await readFile(resolve(import.meta.dirname, '../../public/_headers'), 'utf8');
  for (const path of [
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
