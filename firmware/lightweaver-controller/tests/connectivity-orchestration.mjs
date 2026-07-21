import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'lw-connectivity-orchestration-'));
try {
  const binary = join(dir, 'connectivity-orchestration');
  execFileSync(process.env.CXX || 'c++', [
    '-std=c++17',
    'connectivity-orchestration.cpp',
    '-o', binary,
  ], { cwd: new URL('.', import.meta.url), stdio: 'inherit' });
  execFileSync(binary, { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
