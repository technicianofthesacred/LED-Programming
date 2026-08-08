import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'lw-restart-fallback-'));

try {
  const binary = join(dir, 'restart-fallback-policy');
  execFileSync(process.env.CXX || 'c++', [
    '-std=c++11', '-Wall', '-Wextra', '-Werror',
    'restart-fallback-policy.cpp',
    '-o', binary,
  ], { cwd: new URL('.', import.meta.url), stdio: 'inherit' });
  execFileSync(binary, { stdio: 'inherit' });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const runtimeApi = readFileSync(resolve(root, 'src/LightweaverRuntimeApi.h'), 'utf8');
const web = readFileSync(resolve(root, 'src/LightweaverWeb.cpp'), 'utf8');
const main = readFileSync(resolve(root, 'src/main.cpp'), 'utf8');

assert.match(runtimeApi, /void\s+runtimeArmConfigRestartFallback\(\s*\)\s*;/,
  'the config-save fallback must have an explicit runtime API');
assert.match(main, /void\s+runtimeArmConfigRestartFallback\(\s*\)[\s\S]*armConfigRestartFallback\(millis\(\)\)/,
  'the runtime API must arm the host-tested policy from the current millis timestamp');

const loopStart = main.indexOf('void loop()');
const loopEnd = main.indexOf('\n}', loopStart);
assert.notEqual(loopStart, -1, 'firmware should define loop');
const loopBody = main.slice(loopStart, loopEnd + 2);
const restartHold = loopBody.slice(loopBody.indexOf('if (restartTransitionPending)'));
assert.match(restartHold,
  /configRestartFallbackDue\([\s\S]*configRestartFallbackState[\s\S]*millis\(\)[\s\S]*delay\(50\)[\s\S]*ESP\.restart\(\)/,
  'loop must reboot only after the wrap-safe config fallback policy is due');
assert.match(restartHold, /delay\(10\)[\s\S]*return/,
  'a pending restart must keep its existing dark hold before the fallback is due');

console.log('restart-fallback-policy tests passed');
