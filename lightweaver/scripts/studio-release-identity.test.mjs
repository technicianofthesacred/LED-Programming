import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveStudioBuildNumber,
  resolveStudioReleaseIdentity,
  resolveStudioSourceRevision,
} from './studio-release-identity.mjs';

const EXPLICIT = '1'.repeat(40);
const GITHUB = '2'.repeat(40);
const HEAD = '3'.repeat(40);

test('Studio source revision uses explicit build input, then GitHub SHA, then checked-out HEAD', () => {
  let gitReads = 0;
  const readGitHead = () => {
    gitReads += 1;
    return HEAD;
  };

  assert.equal(resolveStudioSourceRevision({
    env: { LIGHTWEAVER_SOURCE_REVISION: EXPLICIT, GITHUB_SHA: GITHUB },
    readGitHead,
  }), EXPLICIT);
  assert.equal(gitReads, 0);

  assert.equal(resolveStudioSourceRevision({ env: { GITHUB_SHA: GITHUB }, readGitHead }), GITHUB);
  assert.equal(gitReads, 0);

  assert.equal(resolveStudioSourceRevision({ env: {}, readGitHead }), HEAD);
  assert.equal(gitReads, 1);
});

test('Studio release identity is deterministic for one source revision', () => {
  const options = {
    env: { LIGHTWEAVER_SOURCE_REVISION: EXPLICIT },
    readGitBuildNumber: () => '214\n',
  };
  assert.deepEqual(resolveStudioReleaseIdentity(options), resolveStudioReleaseIdentity(options));
  assert.deepEqual(resolveStudioReleaseIdentity(options), {
    schemaVersion: 1,
    sourceRevision: EXPLICIT,
    buildId: EXPLICIT.slice(0, 12),
    buildNumber: 214,
  });
});

test('Studio build number prefers the explicit input, then first-parent Git depth', () => {
  let counted = null;
  const readGitBuildNumber = (cwd, sourceRevision) => {
    counted = sourceRevision;
    return '214';
  };

  assert.equal(resolveStudioBuildNumber({
    env: { LIGHTWEAVER_BUILD_NUMBER: '5000' },
    readGitBuildNumber,
    sourceRevision: EXPLICIT,
  }), 5000);
  assert.equal(counted, null);

  assert.equal(resolveStudioBuildNumber({ env: {}, readGitBuildNumber, sourceRevision: EXPLICIT }), 214);
  assert.equal(counted, EXPLICIT);

  for (const raw of ['0', '-3', '2.5', 'v214', '']) {
    assert.throws(
      () => resolveStudioBuildNumber({ env: {}, readGitBuildNumber: () => raw, sourceRevision: EXPLICIT }),
      /positive integer/,
      raw,
    );
  }
});

test('Studio source revision rejects malformed explicit and Git values', () => {
  assert.throws(
    () => resolveStudioSourceRevision({ env: { LIGHTWEAVER_SOURCE_REVISION: 'main' } }),
    /40 lowercase/,
  );
  assert.throws(
    () => resolveStudioSourceRevision({ env: { GITHUB_SHA: 'A'.repeat(40) } }),
    /40 lowercase/,
  );
  assert.throws(
    () => resolveStudioSourceRevision({ env: {}, readGitHead: () => '' }),
    /40 lowercase/,
  );
});
