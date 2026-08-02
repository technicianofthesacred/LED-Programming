import { execFileSync } from 'node:child_process';

import { studioReleaseFromRevision } from '../src/lib/studioRelease.js';

function defaultReadGitHead(cwd) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
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
  return studioReleaseFromRevision(sourceRevision).sourceRevision;
}

export function resolveStudioReleaseIdentity(options = {}) {
  return studioReleaseFromRevision(resolveStudioSourceRevision(options));
}
