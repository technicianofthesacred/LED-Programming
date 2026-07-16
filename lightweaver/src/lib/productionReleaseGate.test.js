import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const gate = await import('./productionReleaseGate.js').catch(() => ({}));

test('production release gate exposes semantic release and cache verification', () => {
  assert.equal(typeof gate.verifyProductionReleaseSet, 'function');
  assert.equal(typeof gate.verifyProductionCachePolicies, 'function');
});

test('semantic gate verifies the staged signed set and rejects provenance tampering', async () => {
  const publicRoot = resolve(import.meta.dirname, '../../public');
  const fileFetch = async input => {
    const pathname = decodeURIComponent(new URL(String(input), 'https://staged.lightweaver.invalid').pathname);
    const candidate = resolve(publicRoot, `.${pathname}`);
    assert.ok(candidate.startsWith(`${publicRoot}${sep}`));
    if (!existsSync(candidate)) return new Response('Not found', { status: 404 });
    const bytes = readFileSync(candidate);
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } });
  };
  const verified = await gate.verifyProductionReleaseSet(fileFetch, webcrypto);
  assert.equal(verified.release.bytes.byteLength, verified.release.manifest.image.size);
  assert.equal(verified.jobs.length, verified.jobIndex.jobs.length);

  const tamperedFetch = async (input, init) => {
    if (String(input).endsWith('release-provenance.json')) {
      const provenance = JSON.parse(readFileSync(resolve(publicRoot, 'firmware/release-provenance.json'), 'utf8'));
      provenance.buildId = '0'.repeat(40);
      return new Response(JSON.stringify(provenance), { status: 200 });
    }
    return fileFetch(input, init);
  };
  await assert.rejects(gate.verifyProductionReleaseSet(tamperedFetch, webcrypto), /does not match the signed manifest/);
});

test('cache verification prefers HEAD and falls back to bounded GET', async () => {
  assert.equal(typeof gate.verifyProductionCachePolicies, 'function');
  const calls = [];
  let cancelled = false;
  const response = (status, cacheControl) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => name.toLowerCase() === 'cache-control' ? cacheControl : null },
    body: { cancel: async () => { cancelled = true; } },
  });
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init.method || 'GET', init.headers?.Range || '']);
    if (/index\.json|release-(?:manifest|provenance)|lightweaver-controller-esp32s3-factory\.bin$/.test(String(url)) && !String(url).includes('/releases/')) return response(200, 'no-store');
    if ((init.method || 'GET') === 'HEAD') return response(405, null);
    return response(206, 'public, max-age=31536000, immutable');
  };

  await gate.verifyProductionCachePolicies(fetchImpl, {
    release: { manifest: { image: { url: '/firmware/releases/1.0.0/a/image.bin' } } },
    jobIndex: { jobs: [{ url: '/production/jobs/a.lwjob.json' }] },
  });

  assert.ok(calls.some(([url, method]) => url.endsWith('index.json') && method === 'HEAD'));
  assert.ok(calls.some(([url, method, range]) => url.endsWith('image.bin') && method === 'GET' && range === 'bytes=0-0'));
  assert.equal(cancelled, true);
});

test('cache verification rejects caching on mutable release metadata', async () => {
  assert.equal(typeof gate.verifyProductionCachePolicies, 'function');
  const response = cacheControl => ({ ok: true, status: 200, headers: { get: () => cacheControl }, body: { cancel: async () => {} } });
  await assert.rejects(
    gate.verifyProductionCachePolicies(async () => response('public, max-age=60'), {
      release: { manifest: { image: { url: '/firmware/releases/1.0.0/a/image.bin' } } }, jobIndex: { jobs: [] },
    }),
    /must use no-store/,
  );
});

test('cache verification rejects short caching on content-addressed artifacts', async () => {
  const response = cacheControl => ({ ok: true, status: 200, headers: { get: () => cacheControl }, body: { cancel: async () => {} } });
  const fetchImpl = async url => response(String(url).includes('/releases/') ? 'public, max-age=60, immutable' : 'no-store');
  await assert.rejects(
    gate.verifyProductionCachePolicies(fetchImpl, {
      release: { manifest: { image: { url: '/firmware/releases/1.0.0/a/image.bin' } } }, jobIndex: { jobs: [] },
    }),
    /one-year immutable caching/,
  );
});
