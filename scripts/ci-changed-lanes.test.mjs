import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  classifyChangedPaths,
  firmwareBundleOnly,
  resolveChangedPaths,
} from './ci-changed-lanes.mjs';

const allLanes = {
  source: true,
  browser: true,
  cloud: true,
  production: true,
  firmware: true,
  artifact: true,
};

// A signed card release is on demand, not a tax on every visual change: the
// firmware lane still runs its TESTS for Studio changes (a bundle that no
// longer fits must fail on the pull request), but the signer and the site
// deploy read firmwareBundleOnly so a colour tweak neither mints a release nor
// waits twenty minutes for one.
test('Studio-only changes are firmware-sensitive for tests but produce no signed release', () => {
  assert.equal(firmwareBundleOnly(['lightweaver/src/v3/lw-pattern.jsx']), true);
  assert.equal(firmwareBundleOnly(['lightweaver/src/lib/cardProjectResolver.js']), true);
  assert.equal(classifyChangedPaths(['lightweaver/src/v3/lw-pattern.jsx']).firmware, true);
});

test('real firmware changes still produce a signed release automatically', () => {
  assert.equal(firmwareBundleOnly(['firmware/lightweaver-controller/src/main.cpp']), false);
  assert.equal(firmwareBundleOnly(['firmware/lightweaver-controller/platformio.ini']), false);
  assert.equal(firmwareBundleOnly(['scripts/sign-release-artifacts.mjs']), false);
});

test('a VERSION bump is the on-demand card release trigger', () => {
  assert.equal(firmwareBundleOnly(['firmware/lightweaver-controller/VERSION']), false);
  // Bundled with Studio work: still a real release, so the whole merge signs.
  assert.equal(firmwareBundleOnly([
    'firmware/lightweaver-controller/VERSION',
    'lightweaver/src/v3/lw-pattern.jsx',
  ]), false);
});

test('changes that never touch firmware are not bundle-only either', () => {
  assert.equal(firmwareBundleOnly(['README.md']), false);
  assert.equal(firmwareBundleOnly(['lightweaver/functions/api/library/session.js']), false);
  assert.equal(firmwareBundleOnly([]), false);
});

test('the conservative everything-runs answer never skips a release', () => {
  assert.equal(firmwareBundleOnly(['lightweaver/src/v3/lw-pattern.jsx'], { conservative: true }), false);
});

test('shared Studio UI changes select source, browser, and firmware-sensitive lanes', () => {
  assert.deepEqual(classifyChangedPaths(['lightweaver/src/v3/lw-pattern.jsx']), {
    source: true,
    browser: true,
    cloud: false,
    production: false,
    firmware: true,
    artifact: false,
  });
});

test('Studio domain libraries select source, browser, and firmware-sensitive lanes', () => {
  assert.deepEqual(classifyChangedPaths(['lightweaver/src/lib/cardProjectResolver.js']), {
    source: true,
    browser: true,
    cloud: false,
    production: false,
    firmware: true,
    artifact: false,
  });
});

test('every shared-source card target and card bundle input is firmware-sensitive', () => {
  for (const path of [
    'lightweaver/src/v3/lw-pattern.jsx',
    'lightweaver/src/components/card/CardConnectionCenter.jsx',
    'lightweaver/src/card-main.jsx',
    'lightweaver/card.html',
    'lightweaver/scripts/build-card-studio.mjs',
    'firmware/lightweaver-controller/src/LightweaverCardStudio.cpp',
  ]) {
    assert.equal(classifyChangedPaths([path]).firmware, true, `${path} must rebuild the combined firmware`);
  }
});

test('firmware source selects firmware and production contracts without browser suites', () => {
  assert.deepEqual(classifyChangedPaths(['firmware/lightweaver-controller/src/LightweaverWeb.cpp']), {
    source: false,
    browser: false,
    cloud: false,
    production: true,
    firmware: true,
    artifact: false,
  });
});

test('canonical firmware VERSION changes select firmware and production contracts', () => {
  assert.deepEqual(classifyChangedPaths(['firmware/lightweaver-controller/VERSION']), {
    source: false,
    browser: false,
    cloud: false,
    production: true,
    firmware: true,
    artifact: false,
  });
});

test('preserving update release tooling and schemas are firmware-sensitive', () => {
  for (const path of [
    'scripts/build-firmware-update-ticket.mjs',
    'scripts/firmware-update-release.test.mjs',
    'release/firmware-update-ticket.schema.json',
  ]) {
    const lanes = classifyChangedPaths([path]);
    assert.equal(lanes.firmware, true, `${path} must enter protected firmware signing`);
    assert.equal(lanes.production, true, `${path} must run production contracts`);
  }
});

test('preserving update and boot firmware contracts select the bounded firmware lane', () => {
  for (const path of [
    'firmware/lightweaver-controller/tests/firmware-update-ticket.mjs',
    'firmware/lightweaver-controller/tests/firmware-update-state.mjs',
    'firmware/lightweaver-controller/tests/firmware-update-web-contract.mjs',
    'firmware/lightweaver-controller/tests/firmware-boot-health.mjs',
  ]) {
    assert.deepEqual(classifyChangedPaths([path]), {
      source: false,
      browser: false,
      cloud: false,
      production: true,
      firmware: true,
      artifact: false,
    });
  }
});

test('signed generated releases select only the artifact lane', () => {
  assert.deepEqual(classifyChangedPaths([
    'lightweaver/public/firmware/release-manifest.json',
    'lightweaver/public/production/jobs/index.json',
  ]), {
    source: false,
    browser: false,
    cloud: false,
    production: false,
    firmware: false,
    artifact: true,
  });
});

test('bot release commit treats regenerated canonical job source as artifact-only', () => {
  const paths = [
    'lightweaver/public/firmware/release-manifest.json',
    'lightweaver/public/production/jobs/index.json',
    'release/job-sources/bench-fixture-44.json',
  ];
  assert.equal(classifyChangedPaths(paths).firmware, true, 'human job-source edits must still sign');
  assert.deepEqual(classifyChangedPaths(paths, { generatedRelease: true }), {
    source: false,
    browser: false,
    cloud: false,
    production: false,
    firmware: false,
    artifact: true,
  });
});

test('cloud and production paths select their bounded browser lanes', () => {
  assert.deepEqual(classifyChangedPaths(['lightweaver/functions/api/library/session.js']), {
    source: true,
    browser: false,
    cloud: true,
    production: false,
    firmware: false,
    artifact: false,
  });
  assert.deepEqual(classifyChangedPaths(['lightweaver/tests/production-setup.spec.ts']), {
    source: true,
    browser: false,
    cloud: false,
    production: true,
    firmware: false,
    artifact: false,
  });
});

test('workflow and classifier configuration changes conservatively select every lane', () => {
  assert.deepEqual(classifyChangedPaths(['.github/workflows/test.yml']), allLanes);
  assert.deepEqual(classifyChangedPaths(['scripts/ci-changed-lanes.mjs']), allLanes);
});

test('an unavailable push base selects every lane instead of silently skipping checks', () => {
  assert.deepEqual(resolveChangedPaths({
    explicitPaths: [],
    before: '0'.repeat(40),
    head: 'a'.repeat(40),
  }), { paths: [], conservative: true });
});

test('deleting a tracked firmware input still selects the firmware lane', async () => {
  const repository = await mkdtemp(resolve(tmpdir(), 'lightweaver-ci-delete-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Lightweaver CI'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'ci@example.invalid'], { cwd: repository });
    const source = resolve(repository, 'firmware/lightweaver-controller/src/Deleted.cpp');
    await mkdir(resolve(repository, 'firmware/lightweaver-controller/src'), { recursive: true });
    await writeFile(source, '// tracked\n');
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repository });
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    await rm(source);
    execFileSync('git', ['add', '-u'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'delete fixture'], { cwd: repository });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    const resolved = resolveChangedPaths({ before, head, cwd: repository });
    assert.deepEqual(resolved, {
      paths: ['firmware/lightweaver-controller/src/Deleted.cpp'],
      conservative: false,
    });
    assert.equal(classifyChangedPaths(resolved.paths).firmware, true);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
});

test('unknown release-surface paths conservatively run source validation', () => {
  assert.deepEqual(classifyChangedPaths(['docs/deployment-checklist.md']), {
    source: true,
    browser: false,
    cloud: false,
    production: false,
    firmware: false,
    artifact: false,
  });
});

test('a proven-unchanged card bundle drops the firmware lane for Studio paths only', () => {
  const studioPaths = [
    ['lightweaver/src/v3/lw-setup.jsx'],
    ['lightweaver/src/lib/cardLifecycle.js'],
    ['lightweaver/scripts/build-card-studio.mjs'],
    ['lightweaver/vite.config.js'],
    ['lightweaver/card.html'],
  ];
  for (const paths of studioPaths) {
    assert.equal(classifyChangedPaths(paths).firmware, true, `${paths[0]} stays firmware-sensitive without the fact`);
    assert.equal(classifyChangedPaths(paths, { cardBundleUnchanged: true }).firmware, false, `${paths[0]} drops firmware with the fact`);
    assert.equal(classifyChangedPaths(paths, { cardBundleUnchanged: true }).source, true, `${paths[0]} still runs source`);
  }
  // Hard firmware paths are never dropped by the bundle fact.
  for (const paths of [
    ['firmware/lightweaver-controller/src/main.cpp'],
    ['firmware/lightweaver-controller/VERSION'],
    ['packages/installer-core/src/constants.js'],
    ['scripts/sign-release-artifacts.mjs'],
  ]) {
    assert.equal(classifyChangedPaths(paths, { cardBundleUnchanged: true }).firmware, true, `${paths[0]} ignores the bundle fact`);
  }
  // Mixed diffs keep the firmware lane through the hard path.
  assert.equal(classifyChangedPaths(
    ['lightweaver/src/v3/lw-setup.jsx', 'firmware/lightweaver-controller/src/main.cpp'],
    { cardBundleUnchanged: true },
  ).firmware, true);
  // The conservative everything-runs answer is never weakened.
  assert.equal(classifyChangedPaths([], { conservative: true, cardBundleUnchanged: true }).firmware, true);
});
