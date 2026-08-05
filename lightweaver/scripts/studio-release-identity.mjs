import { execFileSync } from 'node:child_process';

import { assertStudioSourceRevision, studioReleaseFromRevision } from '../src/lib/studioRelease.js';

function defaultReadGitHead(cwd) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// Total commit count, which is EXACTLY the number GitHub prints as "N Commits"
// at the top of the repository's file list. The owner's question is "is the
// site running what is on GitHub?", and that only works if the number on screen
// and the number on GitHub are the same number. Do not switch this to
// --first-parent for prettier increments: neat +1 steps are worthless if they
// match nothing the owner can see.
function defaultReadGitBuildNumber(cwd, sourceRevision) {
  return execFileSync('git', ['rev-list', '--count', sourceRevision], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function resolveStudioSourceRevision({
  env = process.env,
  readGitHead = defaultReadGitHead,
  cwd = process.cwd(),
} = {}) {
  const sourceRevision = String(
    env.LIGHTWEAVER_SOURCE_REVISION
      || env.GITHUB_SHA
      || readGitHead(cwd),
  ).trim();
  return assertStudioSourceRevision(sourceRevision);
}

export function resolveStudioBuildNumber({
  env = process.env,
  readGitBuildNumber = defaultReadGitBuildNumber,
  cwd = process.cwd(),
  sourceRevision,
} = {}) {
  const raw = String(
    env.LIGHTWEAVER_BUILD_NUMBER
      || readGitBuildNumber(cwd, sourceRevision),
  ).trim();
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error('Studio release buildNumber must be a positive integer');
  }
  return Number(raw);
}

export function resolveStudioReleaseIdentity(options = {}) {
  const sourceRevision = resolveStudioSourceRevision(options);
  return studioReleaseFromRevision(
    sourceRevision,
    resolveStudioBuildNumber({ ...options, sourceRevision }),
  );
}
