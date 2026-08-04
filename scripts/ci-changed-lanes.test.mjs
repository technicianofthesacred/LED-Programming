import assert from 'node:assert/strict';
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

test('UI-only changes select source and browser lanes', () => {
  assert.deepEqual(classifyChangedPaths(['lightweaver/src/v3/lw-pattern.jsx']), {
    source: true,
    browser: true,
    cloud: false,
    production: false,
    firmware: false,
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
