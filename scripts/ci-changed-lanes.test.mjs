import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  classifyChangedPaths,
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
