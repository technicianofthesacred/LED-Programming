import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'lightweaver-control-transaction-'));
const binary = join(tempDir, 'control-transaction-policy');

try {
  execFileSync('c++', [
    '-std=c++17',
    resolve(import.meta.dirname, 'control-transaction-policy.cpp'),
    '-o', binary,
  ], { stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit' });
  console.log('control transaction policy tests passed');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
