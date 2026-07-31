import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const script = fileURLToPath(new URL('./unpack-standalone-package.mjs', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'lightweaver-unpack-'));
try {
  const bytes = Buffer.from('verified sequence bytes');
  const packagePath = join(root, 'package.json');
  const output = join(root, 'card');
  await writeFile(packagePath, JSON.stringify({
    format: 'standalone-controller-package',
    files: {
      '/lightweaver.json': { version: 1, looks: [{ mode: 'sequence', file: '/sequences/demo.lwseq', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] },
      '/sequences/demo.lwseq': { encoding: 'base64', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), data: bytes.toString('base64') },
    },
  }));
  let run = spawnSync(process.execPath, [script, packagePath, output], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(await readFile(join(output, 'sequences/demo.lwseq')), bytes);

  const tampered = JSON.parse(await readFile(packagePath, 'utf8'));
  tampered.files['/sequences/demo.lwseq'].data = Buffer.from('tampered').toString('base64');
  await writeFile(packagePath, JSON.stringify(tampered));
  run = spawnSync(process.execPath, [script, packagePath, join(root, 'tampered')], { encoding: 'utf8' });
  assert.notEqual(run.status, 0, 'tampered sequence package must be rejected');
  assert.match(run.stderr, /sha256|bytes/i);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('standalone package integrity tests passed');
