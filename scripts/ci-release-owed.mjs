#!/usr/bin/env node

// Is a signed card release OWED, regardless of what the latest merge touched?
//
// The lane classifier answers "did THIS merge change the card?" — a question
// that can only be asked in the seconds after a merge lands. On 2026-08-21 a
// merge bumped VERSION to 1.1.28, its release run was cancelled, and four
// minutes later an unrelated merge landed. That second merge was classified on
// its own diff, which touched no firmware, so the signer skipped and the owed
// release was lost with nothing left to remember it.
//
// This asks a question that stays true instead: does the repository's VERSION
// name a release the signer has not published yet? The published version is the
// one in the committed signed manifest, which the signer writes as part of
// publishing. So the answer self-heals — any later run picks the release back
// up, and it flips to false the moment the signer commits.
//
// Fail-closed means fail toward RELEASING here. A lost release is the defect
// being fixed; a spurious attempt is caught by the signer's own version check,
// which refuses loudly rather than publishing anything wrong.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compareVersions, parseVersion } from '../firmware/lightweaver-controller/scripts/firmware-version.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const VERSION_PATH = 'firmware/lightweaver-controller/VERSION';
export const MANIFEST_PATH = 'lightweaver/public/firmware/release-manifest.json';

function readTrimmed(root, relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8').replace(/\r?\n$/, '');
}

export function releaseOwed({ root = repoRoot, read = readTrimmed } = {}) {
  let current;
  try {
    current = read(root, VERSION_PATH);
    parseVersion(current);
  } catch (error) {
    return { owed: true, reason: `firmware VERSION is unreadable (${error.message}) — attempting the release rather than losing it` };
  }

  let published;
  try {
    published = JSON.parse(read(root, MANIFEST_PATH)).firmwareVersion;
    parseVersion(published);
  } catch (error) {
    return { owed: true, reason: `published release manifest is unreadable (${error.message}) — attempting the release rather than losing it` };
  }

  if (compareVersions(current, published) > 0) {
    return { owed: true, reason: `firmware ${current} is newer than the published ${published} — a signed release is owed` };
  }
  return { owed: false, reason: `firmware ${current} is already published — nothing owed` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { owed, reason } = releaseOwed();
  process.stderr.write(`ci-release-owed: ${reason}\n`);
  process.stdout.write(`${owed}\n`);
}
