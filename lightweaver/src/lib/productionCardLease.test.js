import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertProductionCardLease,
  captureProductionCardLease,
  productionCardAuthority,
} from './productionCardLease.js';

const expectedCardId = 'lw-aabbccddeeff';
const signedFirmware = { expectedFirmwareVersion: '1.0.0', expectedBuildId: 'a'.repeat(40) };

function link(overrides = {}) {
  return {
    state: 'connected-bridge',
    transport: 'bridge',
    host: '192.168.18.70',
    card: { id: expectedCardId },
    expectedCard: { id: expectedCardId },
    cardBlank: false,
    validatedBootId: 'boot-1',
    operationGeneration: 7,
    bridgeLifecycle: 12,
    readiness: {
      app: 'Lightweaver', cardId: expectedCardId, firmwareVersion: '1.0.0',
      buildId: 'a'.repeat(40), bootId: 'boot-1', commandReady: true,
      runtimePhase: 'ready', knownGoodProject: true, outputReady: true,
    },
    ...overrides,
  };
}

test('runtime authority requires an exact command-ready current lifecycle', () => {
  assert.equal(productionCardAuthority(link(), expectedCardId, { mutation: 'runtime' }).ok, false);
  assert.equal(productionCardAuthority(link(), expectedCardId, { mutation: 'runtime', ...signedFirmware }).ok, true);
  assert.equal(productionCardAuthority(link({
    readiness: { ...link().readiness, firmwareVersion: '0.9.0', buildId: '0'.repeat(40) },
  }), expectedCardId, { mutation: 'runtime', ...signedFirmware }).ok, false);
  assert.equal(productionCardAuthority(link({ state: 'revalidating' }), expectedCardId, { mutation: 'runtime' }).ok, false);
  assert.equal(productionCardAuthority(link({ card: { id: 'lw-other' } }), expectedCardId, { mutation: 'runtime' }).ok, false);
  assert.equal(productionCardAuthority(link({ validatedBootId: '' }), expectedCardId, { mutation: 'runtime' }).ok, false);
});

test('identity authority permits exact read-only firmware evidence without granting mutation', () => {
  const oldFactory = link({
    cardBlank: true,
    readiness: {
      app: 'Lightweaver', cardId: expectedCardId, firmwareVersion: '0.9.0',
      buildId: '0'.repeat(40), bootId: 'boot-1', commandReady: false,
      runtimePhase: 'factory', knownGoodProject: false, outputReady: false,
    },
  });
  const authority = productionCardAuthority(oldFactory, expectedCardId, { mutation: 'identity' });
  assert.equal(authority.ok, true);
  const lease = captureProductionCardLease(oldFactory, expectedCardId, { mutation: 'identity' });
  assert.doesNotThrow(() => assertProductionCardLease(lease, oldFactory, { mutation: 'identity' }));
  assert.equal(productionCardAuthority(oldFactory, expectedCardId, { mutation: 'config', ...signedFirmware }).ok, false);
  assert.equal(productionCardAuthority(oldFactory, expectedCardId, { mutation: 'runtime' }).ok, false);
  assert.equal(productionCardAuthority({ ...oldFactory, state: 'revalidating' }, expectedCardId, { mutation: 'identity' }).ok, false);
  assert.equal(productionCardAuthority({ ...oldFactory, readiness: { ...oldFactory.readiness, cardId: 'lw-other' } }, expectedCardId, { mutation: 'identity' }).ok, false);
});

test('observed identity authority can name a different verified card without granting expected-card authority', () => {
  const observedCardId = 'lw-112233445566';
  const observed = link({
    card: { id: observedCardId },
    readiness: { ...link().readiness, cardId: observedCardId },
  });
  const authority = productionCardAuthority(observed, expectedCardId, { mutation: 'observed-identity' });
  assert.equal(authority.ok, true);
  assert.equal(authority.observedCardId, observedCardId);
  assert.equal(productionCardAuthority(observed, expectedCardId, { mutation: 'identity' }).ok, false);
  assert.equal(productionCardAuthority(observed, expectedCardId, { mutation: 'config', ...signedFirmware }).ok, false);

  const lease = captureProductionCardLease(observed, observedCardId, { mutation: 'observed-identity' });
  assert.doesNotThrow(() => assertProductionCardLease(lease, observed, { mutation: 'observed-identity' }));
  assert.throws(() => assertProductionCardLease(lease, {
    ...observed,
    readiness: { ...observed.readiness, cardId: 'lw-another-card' },
  }, { mutation: 'observed-identity' }), /not ready/i);
});

test('an exact blank card grants config-only authority', () => {
  const blank = link({
    cardBlank: true,
    handoffFlowId: 'flow_1234567890123456',
    readiness: {
      app: 'Lightweaver', cardId: expectedCardId, firmwareVersion: '1.0.0',
      buildId: 'a'.repeat(40), bootId: 'boot-1', commandReady: false,
      runtimePhase: 'factory', knownGoodProject: false, outputReady: false,
    },
  });
  assert.equal(productionCardAuthority(blank, expectedCardId, { mutation: 'config', ...signedFirmware }).ok, true);
  assert.equal(productionCardAuthority(blank, expectedCardId, { mutation: 'runtime' }).ok, false);
  assert.equal(productionCardAuthority({ ...blank, handoffFlowId: '' }, expectedCardId, { mutation: 'config', ...signedFirmware }).ok, false);
  assert.equal(productionCardAuthority(blank, expectedCardId, { mutation: 'config' }).ok, false);
  assert.equal(productionCardAuthority({
    ...blank,
    readiness: { ...blank.readiness, firmwareVersion: '0.9.0', buildId: '0'.repeat(40) },
  }, expectedCardId, { mutation: 'config', ...signedFirmware }).ok, false);

  const directOldFactory = {
    ...blank,
    state: 'connected-direct', transport: 'direct', bridgeLifecycle: null, handoffFlowId: '',
    readiness: { ...blank.readiness, firmwareVersion: '0.9.0', buildId: '0'.repeat(40) },
  };
  assert.equal(productionCardAuthority(directOldFactory, expectedCardId, { mutation: 'identity' }).ok, true);
  assert.equal(productionCardAuthority(directOldFactory, expectedCardId, { mutation: 'config', ...signedFirmware }).ok, false);
});

test('a lease is revoked by host, boot, lifecycle, identity, generation, or readiness loss', () => {
  const current = link();
  const lease = captureProductionCardLease(current, expectedCardId, { mutation: 'runtime', ...signedFirmware });
  assert.doesNotThrow(() => assertProductionCardLease(lease, current, { mutation: 'runtime', ...signedFirmware }));
  for (const changed of [
    { host: '192.168.18.71' },
    { validatedBootId: 'boot-2' },
    { bridgeLifecycle: 13 },
    { card: { id: 'lw-other' } },
    { operationGeneration: 8 },
    { state: 'revalidating' },
  ]) {
    assert.throws(
      () => assertProductionCardLease(lease, link(changed), { mutation: 'runtime', ...signedFirmware }),
      /card link changed|not ready/i,
    );
  }
});

test('direct leases bind the direct lifecycle without inventing bridge authority', () => {
  const direct = link({ state: 'connected-direct', transport: 'direct', bridgeLifecycle: null });
  const lease = captureProductionCardLease(direct, expectedCardId, { mutation: 'runtime', ...signedFirmware });
  assert.equal(lease.bridgeLifecycle, null);
  assert.doesNotThrow(() => assertProductionCardLease(lease, direct, { mutation: 'runtime', ...signedFirmware }));
});

test('post-config bridge readback can rebind an exact handoff after an expected lifecycle change', () => {
  const revalidating = link({
    state: 'connecting', card: null, cardBlank: null, readiness: null,
    bridgeLifecycle: 13, operationGeneration: 8,
    handoffBridgeLifecycle: 13,
    handoffFlowId: 'flow_1234567890123456',
    handoffCorrelation: {
      host: '192.168.18.70', expectedCardId,
      expectedBootId: 'boot-1', handoffGeneration: 5,
    },
  });
  const lease = captureProductionCardLease(revalidating, expectedCardId, { mutation: 'readback' });
  assert.equal(lease.bridgeLifecycle, 13);
  assert.doesNotThrow(() => assertProductionCardLease(lease, revalidating, { mutation: 'readback' }));
  assert.throws(() => assertProductionCardLease(lease, { ...revalidating, operationGeneration: 9 }, { mutation: 'readback' }), /changed/i);
});
