// Guard: the firmware binary the public Studio flashes (from led.mandalacodes.com)
// must not be older than the firmware source.
//
// The website serves and flashes
//   lightweaver/public/firmware/lightweaver-controller-esp32s3-factory.bin
// to the card at 0x0. If firmware source lands AFTER that binary was last built,
// every freshly-flashed card runs OLD firmware — the exact "it works but not
// fully" failure mode (missing reconnect recovery, connectivity hardening, etc).
// This guard fails the launch gate until the binary is rebuilt from current src.
//
// Rebuild with:
//   firmware/lightweaver-controller/scripts/build-factory-bin.sh
// (needs the ESP32 toolchain + network access to the PlatformIO registry — a dev
// machine or CI runner, not the sandboxed agent environment).

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const binRel = 'lightweaver/public/firmware/lightweaver-controller-esp32s3-factory.bin';
const watch = [
  'firmware/lightweaver-controller/src',
  'firmware/lightweaver-controller/platformio.ini',
];

function git(args) {
  return execSync(`git ${args}`, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

// Skip gracefully outside a git checkout (e.g. a release tarball) — freshness can
// only be reasoned about when history is available.
let insideGit = false;
try {
  insideGit = git('rev-parse --is-inside-work-tree') === 'true';
} catch {
  insideGit = false;
}
if (!insideGit) {
  console.log('factory-bin-freshness skipped (no git history available)');
  process.exit(0);
}

assert.ok(existsSync(resolve(repoRoot, binRel)), `${binRel} should exist — the website flashes it`);

const binCommit = git(`log -1 --format=%H -- ${binRel}`);
assert.ok(binCommit, `${binRel} should be committed so its freshness is trackable`);

const newerCount = Number(git(`rev-list --count ${binCommit}..HEAD -- ${watch.join(' ')}`) || '0');

if (newerCount > 0) {
  const commits = git(`log --format="  %h %s" ${binCommit}..HEAD -- ${watch.join(' ')}`)
    .split('\n')
    .filter(Boolean)
    .slice(0, 8)
    .join('\n');
  assert.fail(
    `Stale flashed firmware: ${newerCount} firmware source commit(s) landed after the ` +
      `factory binary (${binCommit.slice(0, 7)}) was last built. Cards flashed from the ` +
      `website would run OLD firmware.\n` +
      `Rebuild + commit the binary:\n` +
      `  firmware/lightweaver-controller/scripts/build-factory-bin.sh\n` +
      `Newer firmware commits:\n${commits}`,
  );
}

console.log('factory-bin-freshness tests passed');
