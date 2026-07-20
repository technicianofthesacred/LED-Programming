import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { bakePatternLabRecipe } from '../src/lib/lwseqBake.js';
import { LWSEQ_HEADER_BYTES, makeStandalonePackage } from '../src/lib/standaloneController.js';

const execFileAsync = promisify(execFile);
const projectDir = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'lightweaver-standalone-'));
const packagePath = join(root, 'package.json');
const outputDir = join(root, 'sd');

const recipe = {
  version: 1,
  id: 'bench-bake',
  name: 'Bench Piece',
  base: { kind: 'lightweaver-pattern', patternId: 'gradient', params: {} },
  palette: ['#000000', '#0a141e'],
  macros: { color: 0.5, movement: 0.5, shape: 0.5, texture: 0.5, energy: 0.5 },
  evolution: { enabled: false, character: 'slow-bloom', durationSeconds: 300, change: 0.35 },
  seed: 7,
  layers: [],
  targets: [{ kind: 'whole-piece', id: 'all' }],
  requirements: [],
  provenance: [],
};
const strips = [{ id: 'main', name: 'Main', pixels: [{ x: 0, y: 0 }] }];
const wiring = {
  version: 1,
  locked: true,
  verified: true,
  outputs: [{ id: 'main', name: 'Main', pin: 16, runIds: ['main-run'] }],
  runs: [{
    id: 'main-run',
    type: 'strip',
    verified: true,
    source: { stripId: 'main', from: 0, to: 0 },
    directionPolicy: 'fixed',
    physicalDirection: 'source-forward',
    seamLed: null,
  }],
};
const baked = await bakePatternLabRecipe({ recipe, strips, wiring, fps: 1 });
const frames = Array.from({ length: baked.sidecar.frameCount }, (_, frameIndex) => {
  const offset = LWSEQ_HEADER_BYTES + frameIndex * 3;
  return [{ r: baked.bytes[offset], g: baked.bytes[offset + 1], b: baked.bytes[offset + 2] }];
});
const pkg = makeStandalonePackage({
  projectName: 'Bench Piece',
  outputs: [{ id: 'main', pin: 16, pixels: 1 }],
  sequenceFilename: '001-bench.lwseq',
  frames,
  fps: 1,
  led: { colorOrder: 'RGB' },
});
pkg.files['/sequences/001-bench.lwseq.json'] = `${baked.sidecarJson}\n`;
await writeFile(packagePath, JSON.stringify(pkg, null, 2));

const { stdout } = await execFileAsync(process.execPath, [
  'scripts/unpack-standalone-package.mjs',
  packagePath,
  outputDir,
], { cwd: projectDir });

assert.match(stdout, /Wrote lightweaver.json/);
const profile = JSON.parse(await readFile(join(outputDir, 'lightweaver.json'), 'utf8'));
assert.equal(profile.piece.name, 'Bench Piece');
assert.equal(profile.mode || profile.runtimeMode, 'sd-sequence');
assert.equal(profile.led.colorOrder, 'RGB');
assert.equal(profile.outputs[0].pin, 16);
const sequence = await readFile(join(outputDir, 'sequences', '001-bench.lwseq'));
assert.equal(sequence.length, LWSEQ_HEADER_BYTES + 3 * 300);
assert.equal(sequence.subarray(0, 6).toString('utf8'), 'LWSEQ1');
assert.deepEqual([...sequence], [...baked.bytes]);
const sidecarText = await readFile(join(outputDir, 'sequences', '001-bench.lwseq.json'), 'utf8');
assert.equal(sidecarText, `${baked.sidecarJson}\n`);
const sidecar = JSON.parse(sidecarText);
assert.deepEqual(sidecar, baked.sidecar);
assert.equal(sidecar.lwseqSha256, createHash('sha256').update(sequence).digest('hex'));

console.log('standalone-package-unpack passed');
