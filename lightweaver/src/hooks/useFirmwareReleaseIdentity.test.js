import assert from 'node:assert/strict';
import test from 'node:test';

import { createFirmwareReleaseIdentityLifecycle } from './useFirmwareReleaseIdentity.js';

const release = (buildNumber, buildId = 'a'.repeat(40)) => ({ buildNumber, buildId });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('loads a verified manifest from the initial loading state', async () => {
  const states = [];
  const lifecycle = createFirmwareReleaseIdentityLifecycle({
    loadManifest: async () => release(1154),
    onChange: state => states.push(state),
  });

  assert.deepEqual(lifecycle.getState(), { state: 'loading', manifest: null, error: '' });
  await lifecycle.reload('studio-1155');

  assert.deepEqual(lifecycle.getState(), { state: 'verified', manifest: release(1154), error: '' });
  assert.deepEqual(states.at(-1), lifecycle.getState());
});

test('fails closed with a bounded release-unknown reason', async () => {
  const lifecycle = createFirmwareReleaseIdentityLifecycle({
    loadManifest: async () => { throw new Error('signature details that must not reach the footer'); },
  });

  await lifecycle.reload('studio-1155');

  assert.deepEqual(lifecycle.getState(), {
    state: 'release-unknown',
    manifest: null,
    error: 'release-verification-failed',
  });
});

test('a new Studio identity reloads while an unchanged identity is deduplicated', async () => {
  let calls = 0;
  const lifecycle = createFirmwareReleaseIdentityLifecycle({
    loadManifest: async () => release(1154 + calls++),
  });

  await lifecycle.reload('studio-a');
  await lifecycle.reload('studio-a');
  await lifecycle.reload('studio-b');

  assert.equal(calls, 2);
  assert.equal(lifecycle.getState().manifest.buildNumber, 1155);
});

test('online retry reloads a previously unavailable release', async () => {
  let calls = 0;
  const lifecycle = createFirmwareReleaseIdentityLifecycle({
    loadManifest: async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return release(1154);
    },
  });

  await lifecycle.reload('studio-a');
  await lifecycle.retry();

  assert.equal(calls, 2);
  assert.equal(lifecycle.getState().state, 'verified');
});

test('a stale promise cannot overwrite a newer Studio release load', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const lifecycle = createFirmwareReleaseIdentityLifecycle({
    loadManifest: () => (++calls === 1 ? first.promise : second.promise),
  });

  const stale = lifecycle.reload('studio-a');
  const current = lifecycle.reload('studio-b');
  second.resolve(release(1154, 'b'.repeat(40)));
  await current;
  first.resolve(release(1123, 'c'.repeat(40)));
  await stale;

  assert.deepEqual(lifecycle.getState().manifest, release(1154, 'b'.repeat(40)));
});
