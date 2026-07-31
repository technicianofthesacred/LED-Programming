import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'lightweaver-look-mode-policy-'));
const binary = join(tempDir, 'look-mode-policy');

try {
  execFileSync('c++', [
    '-std=c++17',
    resolve(import.meta.dirname, 'look-mode-policy.cpp'),
    '-o', binary,
  ], { stdio: 'inherit' });
  execFileSync(binary, [], { stdio: 'inherit' });
  console.log('look mode policy tests passed');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
