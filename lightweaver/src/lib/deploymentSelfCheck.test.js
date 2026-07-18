import test from 'node:test';
import assert from 'node:assert/strict';
import { DEPLOYMENT_CHECKS, runDeploymentSelfCheck } from './deploymentSelfCheck.js';

const passingReleaseSet = {
  release: {
    manifest: {
      firmwareVersion: '1.0.0',
      buildId: 'a'.repeat(40),
      provenance: { sourceRevision: 'b'.repeat(40) },
    },
  },
  jobIndex: { jobs: [{ url: '/production/jobs/x' }] },
  jobs: [],
};

test('all checks green produces ok with a bounded summary', async () => {
  const outcome = await runDeploymentSelfCheck({
    fetchImpl: () => { throw new Error('fetch must not be called when verifiers are injected'); },
    cryptoImpl: {},
    verifyReleaseSet: async () => passingReleaseSet,
    verifyCachePolicies: async () => {},
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.results.length, DEPLOYMENT_CHECKS.length);
  assert.ok(outcome.results.every(result => result.ok && result.label));
  assert.equal(outcome.summary.firmwareVersion, '1.0.0');
  assert.equal(outcome.summary.buildId, 'a'.repeat(40));
  assert.equal(outcome.summary.sourceRevision, 'b'.repeat(40));
  assert.equal(outcome.summary.jobCount, 1);
});

test('a failed release verification fails overall, skips cache checks, and keeps only the first line', async () => {
  const outcome = await runDeploymentSelfCheck({
    verifyReleaseSet: async () => {
      throw new Error('Production firmware manifest answered HTTP 404 at\n  /firmware/release-manifest.json\n  secret-second-line');
    },
    verifyCachePolicies: async () => { throw new Error('must not run'); },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.summary, null);
  const release = outcome.results.find(result => result.id === 'release-set');
  assert.equal(release.ok, false);
  assert.match(release.detail, /HTTP 404/);
  assert.ok(!release.detail.includes('secret-second-line'));
  const cache = outcome.results.find(result => result.id === 'cache-policies');
  assert.equal(cache.ok, false);
  assert.match(cache.detail, /Skipped/);
});

test('a cache-policy failure alone still reports the verified release summary', async () => {
  const outcome = await runDeploymentSelfCheck({
    verifyReleaseSet: async () => passingReleaseSet,
    verifyCachePolicies: async () => { throw new Error('Mutable production asset must use no-store: /firmware/release-manifest.json'); },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.results.find(result => result.id === 'release-set').ok, true);
  assert.match(outcome.results.find(result => result.id === 'cache-policies').detail, /no-store/);
  assert.equal(outcome.summary.firmwareVersion, '1.0.0');
});
