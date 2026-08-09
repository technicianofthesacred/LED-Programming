import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyFooterFirmwareStatus } from './footerFirmwareStatus.js';

const BUILD_ID = 'a'.repeat(40);
const OTHER_BUILD_ID = 'b'.repeat(40);
const RELEASE = { buildNumber: 1154, buildId: BUILD_ID };

test('footer firmware status requires both the numbered build and exact revision for current', () => {
  assert.deepEqual(classifyFooterFirmwareStatus({ buildNumber: 1154, buildId: BUILD_ID }, RELEASE), {
    state: 'current',
    installedBuildNumber: 1154,
    releaseBuildNumber: 1154,
    label: 'Card 1154 ✓',
    actionable: false,
  });
});

test('footer firmware status offers the verified release when the card has an older build', () => {
  assert.deepEqual(classifyFooterFirmwareStatus({ buildNumber: 1123, buildId: BUILD_ID }, RELEASE), {
    state: 'update-available',
    installedBuildNumber: 1123,
    releaseBuildNumber: 1154,
    label: 'Card 1123 → 1154',
    actionable: true,
  });
});

test('footer firmware status treats a same-number different revision as an available update', () => {
  assert.deepEqual(classifyFooterFirmwareStatus({ buildNumber: 1154, buildId: OTHER_BUILD_ID }, RELEASE), {
    state: 'update-available',
    installedBuildNumber: 1154,
    releaseBuildNumber: 1154,
    label: 'Card 1154 → 1154',
    actionable: true,
  });
});

test('footer firmware status offers a release to numbered-build legacy cards with a valid revision', () => {
  for (const installed of [
    { buildNumber: 0, buildId: BUILD_ID },
    { buildId: BUILD_ID },
  ]) {
    assert.deepEqual(classifyFooterFirmwareStatus(installed, RELEASE), {
      state: 'legacy',
      installedBuildNumber: null,
      releaseBuildNumber: 1154,
      label: 'Card legacy → 1154',
      actionable: true,
    });
  }
});

test('footer firmware status identifies newer card builds without offering a downgrade', () => {
  assert.deepEqual(classifyFooterFirmwareStatus({ buildNumber: 1160, buildId: BUILD_ID }, RELEASE), {
    state: 'development-build',
    installedBuildNumber: 1160,
    releaseBuildNumber: 1154,
    label: 'Card 1160 · release 1154',
    actionable: false,
  });
});

test('footer firmware status fails closed for missing or malformed verified releases', () => {
  for (const release of [undefined, {}, { buildNumber: 0, buildId: BUILD_ID }, { buildNumber: 1154, buildId: 'preview' }]) {
    assert.deepEqual(classifyFooterFirmwareStatus({ buildNumber: 1123, buildId: BUILD_ID }, release), {
      state: 'release-unknown',
      installedBuildNumber: 1123,
      releaseBuildNumber: null,
      label: 'Card 1123 · release unknown',
      actionable: false,
    });
  }
});

test('footer firmware status truthfully distinguishes an absent card from an unavailable release', () => {
  assert.deepEqual(classifyFooterFirmwareStatus(null, RELEASE), {
    state: 'disconnected',
    installedBuildNumber: null,
    releaseBuildNumber: 1154,
    label: 'Firmware 1154 available',
    actionable: false,
  });
  assert.deepEqual(classifyFooterFirmwareStatus(null, undefined), {
    state: 'disconnected',
    installedBuildNumber: null,
    releaseBuildNumber: null,
    label: 'Firmware release unknown',
    actionable: false,
  });
});

test('footer firmware status fails closed for malformed card identity without echoing its values', () => {
  for (const installed of [
    { buildNumber: '1123', buildId: BUILD_ID },
    { buildNumber: 1123, buildId: 'preview' },
    { buildNumber: -1, buildId: BUILD_ID },
  ]) {
    assert.deepEqual(classifyFooterFirmwareStatus(installed, RELEASE), {
      state: 'release-unknown',
      installedBuildNumber: null,
      releaseBuildNumber: 1154,
      label: 'Firmware release unknown',
      actionable: false,
    });
  }
});
