import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generateServiceWorker } from '../scripts/generate-service-worker.mjs';

test('generated public worker is deterministic, offline-first for shell, and never caches APIs or foreign origins', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lw-windowless-sw-'));
  try {
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), '<main>Lightweaver Studio</main>');
    await writeFile(join(directory, 'assets', 'main-a1b2c3d4.js'), 'console.log("studio")');
    await writeFile(join(directory, 'manifest.webmanifest'), '{"name":"Lightweaver Studio"}');
    await writeFile(join(directory, 'studio-release.json'), JSON.stringify({
      schemaVersion: 1,
      sourceRevision: 'a'.repeat(40),
      buildId: 'a'.repeat(40),
      buildNumber: 1216,
    }));

    const first = await generateServiceWorker({ distDir: directory });
    const firstBytes = await readFile(join(directory, 'sw.js'));
    const second = await generateServiceWorker({ distDir: directory });
    const secondBytes = await readFile(join(directory, 'sw.js'));

    assert.deepEqual(first, second);
    assert.deepEqual(firstBytes, secondBytes, 'same build must produce byte-identical worker');
    const worker = secondBytes.toString('utf8');
    assert.match(worker, /request\.method !== 'GET'/);
    assert.match(worker, /url\.origin !== self\.location\.origin/);
    assert.match(worker, /url\.pathname\.startsWith\('\/api\/'\)/);
    assert.match(worker, /request\.mode === 'navigate'/);
    assert.match(worker, /networkFirst\(request, '\/index\.html'\)/);
    assert.match(worker, /networkFirst\(request, '\/studio-release\.json'\)/);
    assert.match(worker, /cacheFirst\(request\)/);
    assert.match(worker, /SKIP_WAITING/);
    assert.doesNotMatch(worker, /install[\s\S]{0,300}skipWaiting\(/, 'install must leave updates waiting');
    assert.ok(first.precache.includes('/assets/main-a1b2c3d4.js'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
