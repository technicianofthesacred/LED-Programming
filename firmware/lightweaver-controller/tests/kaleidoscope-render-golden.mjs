import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(resolve(os.tmpdir(), 'lw-kaleidoscope-render-'));
try {
  const binary = resolve(temp, 'kaleidoscope-render-golden');
  execFileSync('c++', [
    '-std=c++17', '-Wall', '-Wextra', '-Werror',
    '-I', resolve(import.meta.dirname, 'host-stubs'),
    '-I', resolve(root, 'src'),
    resolve(root, 'src/LightweaverPatterns.cpp'),
    resolve(import.meta.dirname, 'kaleidoscope-render-golden.cpp'),
    '-o', binary,
  ], { stdio: 'inherit' });
  execFileSync(binary, { stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log('kaleidoscope host-render golden tests passed');
