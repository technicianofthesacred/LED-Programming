import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateStudioBuildGraph } from './generate-studio-build-graph.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('generator writes deterministic hashes for index and every Vite JS/CSS asset', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lightweaver-build-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets', 'lazy'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<script src="/assets/studio.js"></script>');
  await writeFile(join(root, 'assets', 'studio.js'), 'import("./lazy/production.js")');
  await writeFile(join(root, 'assets', 'lazy', 'production.js'), 'export const production = true;');
  await writeFile(join(root, 'assets', 'studio.css'), 'body{color:#fff}');
  await writeFile(join(root, 'assets', 'ignored.png'), 'not part of Studio code graph');
  await writeFile(join(root, 'assets', 'studio.js.map'), 'not deployed integrity surface');

  const first = await generateStudioBuildGraph(root);
  const firstBytes = await readFile(join(root, 'studio-build-graph.json'));
  const second = await generateStudioBuildGraph(root);
  const secondBytes = await readFile(join(root, 'studio-build-graph.json'));

  assert.deepEqual(first, second);
  assert.deepEqual(first.files.map(file => file.path), [
    'assets/lazy/production.js',
    'assets/studio.css',
    'assets/studio.js',
    'index.html',
  ]);
  assert.deepEqual(first.files[0], {
    path: 'assets/lazy/production.js',
    bytes: Buffer.byteLength('export const production = true;'),
    sha256: sha256(Buffer.from('export const production = true;')),
  });
  assert.deepEqual(firstBytes, secondBytes);
  assert.equal(firstBytes.at(-1), 0x0a, 'graph must end with one newline');
  assert.deepEqual(JSON.parse(firstBytes), first);
});

test('generator refuses an incomplete staged Studio', async t => {
  const root = await mkdtemp(join(tmpdir(), 'lightweaver-build-graph-incomplete-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<div id="root"></div>');
  await assert.rejects(generateStudioBuildGraph(root), /at least one JavaScript asset/);
});
