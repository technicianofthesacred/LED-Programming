import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'lw-connectivity-'));
try {
  const binary = join(dir, 'connectivity-policy');
  execFileSync(process.env.CXX || 'c++', [
    '-std=c++17',
    'connectivity-policy.cpp',
    '-o', binary,
  ], { cwd: new URL('.', import.meta.url), stdio: 'inherit' });
  execFileSync(binary, { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
