import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { packageCardStudio } from '../scripts/build-card-studio.mjs';

test('card packager hashes compressed bytes and emits deterministic release identity and firmware table', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-windowless-card-'));
  const rawDir = join(root, 'raw');
  const outputDir = join(root, 'bundle');
  const headerPath = join(root, 'LightweaverCardStudioBundle.h');
  try {
    await mkdir(join(rawDir, 'assets'), { recursive: true });
    await writeFile(join(rawDir, 'index.html'), '<div id="root"></div><script type="module" src="/studio/assets/card-a1b2c3d4.js"></script>');
    await writeFile(join(rawDir, 'assets', 'card-a1b2c3d4.js'), 'globalThis.LIGHTWEAVER_CARD_STUDIO=true;');

    const options = {
      rawDir,
      outputDir,
      headerPath,
      identity: {
        buildId: 'b'.repeat(40), buildNumber: 1216,
        projectSchema: { min: 3, max: 3 }, firmwareApi: { min: 1, max: 1 },
      },
      maximumBytes: 100_000,
    };
    const first = await packageCardStudio(options);
    const firstHeader = await readFile(headerPath);
    const second = await packageCardStudio(options);
    const secondHeader = await readFile(headerPath);

    assert.deepEqual(first.release, second.release);
    assert.deepEqual(firstHeader, secondHeader);
    assert.equal(first.release.target, 'card-local');
    assert.deepEqual(first.release.projectSchema, { min: 3, max: 3 });
    assert.deepEqual(first.release.firmwareApi, { min: 1, max: 1 });
    assert.ok(first.release.totalSize > 0 && first.release.totalSize <= 100_000);
    for (const asset of first.release.assets) {
      const compressed = await readFile(join(outputDir, `${asset.file}.br`));
      assert.equal(createHash('sha256').update(compressed).digest('hex'), asset.brotli.sha256);
      assert.equal(compressed.byteLength, asset.brotli.size);
    }
    const header = firstHeader.toString('utf8');
    for (const symbol of [
      'LW_CARD_STUDIO_BUILD_ID', 'LW_CARD_STUDIO_BUILD_NUMBER',
      'LW_CARD_STUDIO_PROJECT_SCHEMA_MIN', 'LW_CARD_STUDIO_PROJECT_SCHEMA_MAX',
      'LW_CARD_STUDIO_FIRMWARE_API_MIN', 'LW_CARD_STUDIO_FIRMWARE_API_MAX',
      'LW_CARD_STUDIO_TOTAL_SIZE', 'LW_CARD_STUDIO_BUNDLE_SHA256',
      'LW_CARD_STUDIO_ASSET_COUNT', 'LW_CARD_STUDIO_ASSETS',
    ]) assert.match(header, new RegExp(symbol));
    assert.doesNotMatch(header, /inline constexpr/, 'generated firmware header must compile cleanly under the project C++11 toolchain');
    assert.doesNotMatch(header, /sourceMappingURL/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('card packager rejects source maps, external asset URLs, and oversized firmware payloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-windowless-card-reject-'));
  const rawDir = join(root, 'raw');
  try {
    await mkdir(rawDir);
    await writeFile(join(rawDir, 'index.html'), '<script src="https://cdn.example.invalid/studio.js"></script>');
    await assert.rejects(() => packageCardStudio({
      rawDir, outputDir: join(root, 'out'), headerPath: join(root, 'bundle.h'),
      identity: { buildId: 'c'.repeat(40), buildNumber: 1, projectSchema: { min: 1, max: 1 }, firmwareApi: { min: 1, max: 1 } },
      maximumBytes: 10_000,
    }), /external asset URL/);

    await writeFile(join(rawDir, 'index.html'), '<main>ok</main>');
    await writeFile(join(rawDir, 'main.js.map'), '{}');
    await assert.rejects(() => packageCardStudio({
      rawDir, outputDir: join(root, 'out'), headerPath: join(root, 'bundle.h'),
      identity: { buildId: 'c'.repeat(40), buildNumber: 1, projectSchema: { min: 1, max: 1 }, firmwareApi: { min: 1, max: 1 } },
      maximumBytes: 1,
    }), /source map/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
