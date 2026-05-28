import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LWSEQ_HEADER_BYTES, makeStandalonePackage } from '../src/lib/standaloneController.js';

const execFileAsync = promisify(execFile);
const projectDir = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'lightweaver-standalone-'));
const packagePath = join(root, 'package.json');
const outputDir = join(root, 'sd');

const pkg = makeStandalonePackage({
  projectName: 'Bench Piece',
  outputs: [{ id: 'main', pin: 16, pixels: 1 }],
  sequenceFilename: '001-bench.lwseq',
  frames: [[{ r: 10, g: 20, b: 30 }]],
  fps: 24,
  led: { colorOrder: 'RGB' },
});
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
assert.equal(sequence.length, LWSEQ_HEADER_BYTES + 3);
assert.equal(sequence.subarray(0, 6).toString('utf8'), 'LWSEQ1');
assert.deepEqual([...sequence.subarray(LWSEQ_HEADER_BYTES)], [10, 20, 30]);

console.log('standalone-package-unpack passed');
