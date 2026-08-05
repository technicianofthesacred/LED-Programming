import { execFileSync } from 'node:child_process';

import { assertStudioSourceRevision, studioReleaseFromRevision } from '../src/lib/studioRelease.js';

function defaultReadGitHead(cwd) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// First-parent depth, so one merge to main advances the number by exactly one
// regardless of how many commits the branch carried. That is what makes the
// footer beacon readable as "build 214, then 215, then 216".
function defaultReadGitBuildNumber(cwd, sourceRevision) {
  return execFileSync('git', ['rev-list', '--count', '--first-parent', sourceRevision], {
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
