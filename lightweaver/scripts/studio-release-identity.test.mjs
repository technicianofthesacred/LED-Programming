import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
  const options = { env: { LIGHTWEAVER_SOURCE_REVISION: EXPLICIT } };
  assert.deepEqual(resolveStudioReleaseIdentity(options), resolveStudioReleaseIdentity(options));
  assert.deepEqual(resolveStudioReleaseIdentity(options), {
    schemaVersion: 1,
    sourceRevision: EXPLICIT,
    buildId: EXPLICIT.slice(0, 12),
  });
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
