import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const expectedFreshnessCommand = 'node ../firmware/lightweaver-controller/tests/factory-bin-freshness.mjs';

export function sourceCoreCommands(packageJson) {
  const commands = String(packageJson?.scripts?.['test:core'] || '').split(' && ').filter(Boolean);
  assert.ok(commands.length > 1, 'test:core must contain source contracts followed by the factory freshness gate');
  assert.equal(
    commands.at(-1),
    expectedFreshnessCommand,
    'test:core must end with the exact factory binary freshness gate before CI may omit it',
  );
  return commands.slice(0, -1);
}

function run() {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  for (const command of sourceCoreCommands(packageJson)) {
    const result = spawnSync(command, {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      shell: true,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run();
}
