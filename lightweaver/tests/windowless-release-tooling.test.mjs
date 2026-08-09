import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '../..');

test('Pages routing sends bounded handoff requests to the ciphertext functions', async () => {
  const routes = JSON.parse(await readFile(resolve(repository, 'lightweaver/public/_routes.json')));
  assert.equal(routes.include.includes('/api/handoff'), true);
  assert.equal(routes.include.includes('/api/handoff/*'), true);
});

test('firmware manifest builder signs one combined firmware and local-Studio identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-windowless-release-'));
  try {
    const image = Buffer.from('combined-factory-image-with-card-studio');
    const publicRoot = join(root, 'public');
    const cardReleasePath = join(root, 'card-studio-release.json');
    await mkdir(publicRoot);
    await writeFile(join(root, 'factory.bin'), image);
    await writeFile(cardReleasePath, JSON.stringify({
      schemaVersion: 1, target: 'card-local', buildId: 'a'.repeat(40), buildNumber: 1216,
      projectSchema: { min: 3, max: 3 }, firmwareApi: { min: 1, max: 1 }, compression: 'br',
      totalSize: 33, maximumSize: 2_500_000, bundleSha256: '2'.repeat(64),
      assets: [{ route: '/studio/', brotli: { size: 33, sha256: '3'.repeat(64) } }],
    }));

    execFileSync(process.execPath, [resolve(repository, 'scripts/build-firmware-manifest.mjs'),
      '--image', join(root, 'factory.bin'), '--public-root', publicRoot,
      '--firmware-version', '1.2.3', '--build-id', 'a'.repeat(40), '--build-number', '1216',
      '--source-revision', 'a'.repeat(40), '--config-min', '1', '--config-max', '1',
      '--minimum-installer', '1.4.0', '--card-studio-release', cardReleasePath,
    ]);
    const built = JSON.parse(await readFile(join(publicRoot, 'firmware/release-manifest.json')));
    assert.equal(built.cardStudio.buildId, built.buildId);
    assert.equal(built.cardStudio.totalSize, 33);
    assert.deepEqual(built.image.cardStudioReadback, {
      offset: 0, size: built.image.size, sha256: built.image.sha256,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
