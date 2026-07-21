import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'lw-connectivity-'));
try {
  for (const source of [
    'connectivity-policy.cpp',
    'connectivity-orchestration.cpp',
  ]) {
    const binary = join(dir, source.replace(/\.cpp$/, ''));
    execFileSync(process.env.CXX || 'c++', [
      '-std=c++17',
      source,
      '-o', binary,
    ], { cwd: new URL('.', import.meta.url), stdio: 'inherit' });
    execFileSync(binary, { stdio: 'inherit' });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
