import assert from 'node:assert/strict';
import test from 'node:test';

import { MANIFEST_PATH, VERSION_PATH, releaseOwed } from './ci-release-owed.mjs';

function reader(files) {
  return (_root, relativePath) => {
    if (!(relativePath in files)) throw new Error(`missing ${relativePath}`);
    return files[relativePath];
  };
}

function withVersions(current, published) {
  return reader({
    [VERSION_PATH]: current,
    [MANIFEST_PATH]: JSON.stringify({ firmwareVersion: published }),
  });
}

test('a version ahead of the published release is owed one', () => {
  const { owed } = releaseOwed({ read: withVersions('1.1.28', '1.1.27') });
  assert.equal(owed, true);
});

test('the exact case lost on 2026-08-21: the bump landed, the signer skipped, a later run picks it up', () => {
  // The merge that bumped VERSION is long gone from the diff by now; only the
  // committed state remains, and that is enough.
  const { owed, reason } = releaseOwed({ read: withVersions('1.1.28', '1.1.27') });
  assert.equal(owed, true);
  assert.match(reason, /a signed release is owed/);
});

test('once the signer publishes, nothing is owed — so this cannot loop', () => {
  const { owed } = releaseOwed({ read: withVersions('1.1.28', '1.1.28') });
  assert.equal(owed, false);
});

test('a published release ahead of the working version is not owed', () => {
  const { owed } = releaseOwed({ read: withVersions('1.1.27', '1.1.28') });
  assert.equal(owed, false);
});

test('a minor bump counts, not just a patch bump', () => {
  assert.equal(releaseOwed({ read: withVersions('1.2.0', '1.1.99') }).owed, true);
  assert.equal(releaseOwed({ read: withVersions('2.0.0', '1.9.9') }).owed, true);
});

test('an unreadable version file attempts the release rather than losing it', () => {
  const { owed, reason } = releaseOwed({ read: reader({}) });
  assert.equal(owed, true);
  assert.match(reason, /rather than losing it/);
});

test('an unreadable published manifest attempts the release rather than losing it', () => {
  const { owed, reason } = releaseOwed({ read: reader({ [VERSION_PATH]: '1.1.28' }) });
  assert.equal(owed, true);
  assert.match(reason, /rather than losing it/);
});

test('a malformed published version attempts the release rather than losing it', () => {
  const { owed } = releaseOwed({
    read: reader({ [VERSION_PATH]: '1.1.28', [MANIFEST_PATH]: JSON.stringify({ firmwareVersion: 'nightly' }) }),
  });
  assert.equal(owed, true);
});

test('the real repository state answers without throwing', () => {
  const { owed, reason } = releaseOwed();
  assert.equal(typeof owed, 'boolean');
  assert.ok(reason.length > 0);
});
