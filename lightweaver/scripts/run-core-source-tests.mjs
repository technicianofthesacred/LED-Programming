import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const expectedFreshnessCommand = 'node ../firmware/lightweaver-controller/tests/factory-bin-freshness.mjs';

// The only proof a freshly flashed card can still be rescued. A blank card has
// outputCount 0 and every readiness flag false, so nothing else in the suite
// exercises it: if one of these drops out of test:core, the staging exemption
// or the output allocation clamp can be reverted and every gate stays green
// right up to the moment an owner flashes a card and it never lights.
const REQUIRED_CORE_TESTS = Object.freeze([
  // Firmware applies a blank card's first config instead of staging it.
  'node ../firmware/lightweaver-controller/tests/blank-card-first-config.mjs',
  // Output pixel counts are clamped before the runtime allocates for them.
  'node ../firmware/lightweaver-controller/tests/runtime-output-allocation-clamp.mjs',
  // The pin menu and -DLW_MAX_PIXELS still match the hardware contract.
  'node tests/hardware-capability-contract.mjs',
  // The runtime still reports whether its LED output is actually ready, which
  // is what lets Studio tell "the card answered" apart from "the strip is lit".
  'node ../firmware/lightweaver-controller/tests/output-readiness-diagnostics.mjs',
]);

// Browser-lane counterpart: the end-to-end walk from a blank card to a lit
// strip. It is a Playwright spec, so it cannot live in test:core — assert it
// stays in the script CI actually runs rather than only in the local gate.
const REQUIRED_BROWSER_SPEC = 'tests/strip-discovery.spec.ts';

export function sourceCoreCommands(packageJson) {
  const commands = String(packageJson?.scripts?.['test:core'] || '').split(' && ').filter(Boolean);
  assert.ok(commands.length > 1, 'test:core must contain source contracts followed by the factory freshness gate');
  assert.equal(
    commands.at(-1),
    expectedFreshnessCommand,
    'test:core must end with the exact factory binary freshness gate before CI may omit it',
  );
  for (const required of REQUIRED_CORE_TESTS) {
    assert.ok(
      commands.includes(required),
      `test:core must keep the blank-card rescue proof "${required}"`,
    );
  }
  assert.ok(
    String(packageJson?.scripts?.['ci:browser-smoke'] || '').includes(REQUIRED_BROWSER_SPEC),
    `ci:browser-smoke must keep the blank-card rescue spec "${REQUIRED_BROWSER_SPEC}"`,
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
