import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertStudioSourceRevision,
  formatStudioBuildLabel,
  getRunningStudioRelease,
  parseStudioRelease,
  serializeStudioRelease,
  studioReleaseFromRevision,
} from './studioRelease.js';

const REVISION = 'a'.repeat(40);
const RELEASE = Object.freeze({
  schemaVersion: 1,
  sourceRevision: REVISION,
  buildId: 'a'.repeat(12),
  buildNumber: 214,
});

test('Studio release derives one compact deterministic build ID from the full source revision', () => {
  assert.deepEqual(studioReleaseFromRevision(REVISION, 214), RELEASE);
  assert.deepEqual(getRunningStudioRelease(RELEASE), RELEASE);
});

test('Studio release carries a human-comparable build number', () => {
  assert.equal(formatStudioBuildLabel(RELEASE), 'Build 214');
  assert.ok(studioReleaseFromRevision(REVISION, 215).buildNumber > RELEASE.buildNumber);
  assert.equal(assertStudioSourceRevision(REVISION), REVISION);
  assert.throws(() => assertStudioSourceRevision('main'), /40 lowercase/);
});

test('Studio release serializes to canonical deterministic newline-terminated JSON', () => {
  const expected = `${JSON.stringify(RELEASE, null, 2)}\n`;
  assert.equal(serializeStudioRelease(RELEASE), expected);
  assert.equal(serializeStudioRelease(parseStudioRelease(expected)), expected);
});

test('Studio release parser accepts only the exact strict schema', () => {
  assert.deepEqual(parseStudioRelease(JSON.stringify(RELEASE)), RELEASE);
  for (const [value, expected] of [
    ['', /valid JSON/],
    ['[]', /object/],
    [{ schemaVersion: 1 }, /exactly/],
    [{ ...RELEASE, extra: true }, /exactly/],
    [{ ...RELEASE, schemaVersion: 2 }, /schemaVersion/],
    [{ ...RELEASE, sourceRevision: 'A'.repeat(40) }, /40 lowercase/],
    [{ ...RELEASE, sourceRevision: 'a'.repeat(39) }, /40 lowercase/],
    [{ ...RELEASE, buildId: 'b'.repeat(12) }, /first 12/],
    [{ ...RELEASE, buildId: 'a'.repeat(11) }, /first 12/],
    [{ ...RELEASE, buildNumber: 0 }, /positive integer/],
    [{ ...RELEASE, buildNumber: -1 }, /positive integer/],
    [{ ...RELEASE, buildNumber: 1.5 }, /positive integer/],
    [{ ...RELEASE, buildNumber: '214' }, /positive integer/],
  ]) {
    assert.throws(
      () => parseStudioRelease(typeof value === 'string' ? value : JSON.stringify(value)),
      expected,
      JSON.stringify(value),
    );
  }
});

test('running release fails closed when the bundle identity is unavailable', () => {
  assert.throws(() => getRunningStudioRelease(null), /embedded Studio release identity is unavailable/);
});
