import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const testSource = resolve(import.meta.dirname, 'output-policy.cpp');
const tempDir = mkdtempSync(join(tmpdir(), 'lightweaver-output-policy-'));
const testBinary = join(tempDir, 'output-policy');

try {
  execFileSync('c++', ['-std=c++17', testSource, '-o', testBinary], {
    stdio: 'inherit',
  });
  execFileSync(testBinary, { stdio: 'inherit' });
  console.log('output-policy tests passed');
} finally {
  rmSync(tempDir, { force: true, recursive: true });
}
