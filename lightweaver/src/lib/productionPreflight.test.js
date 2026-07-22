import test from 'node:test';
import assert from 'node:assert/strict';

import * as cardConnection from './cardConnection.js';
import * as productionLease from './productionCardLease.js';

const CARD_ID = 'lw-aabbccddeeff';

function staleBuildHandoffReadyLink(overrides = {}) {
  return {
    state: 'connected-bridge', transport: 'bridge', host: 'lightweaver.local',
    card: { id: CARD_ID }, expectedCard: { id: CARD_ID },
    validatedBootId: 'boot-old-card', operationGeneration: 4, bridgeLifecycle: 9,
    readiness: {
      app: 'Lightweaver', cardId: CARD_ID, bootId: 'boot-old-card',
      firmwareVersion: '0.9.0', buildId: '3a5771a'.padEnd(40, '0'),
      commandReady: false, outputReady: true, knownGoodProject: false, runtimePhase: 'factory',
      wifi: {
        transport: 'station', transition: 'handoff-ready', transitionPending: true,
        apActive: true, stationIp: '192.168.18.70', ip: '192.168.18.70',
      },
    },
    ...overrides,
  };
}

test('read-only Production preflight falls back from a stale setup address to the stable card name', () => {
  assert.deepEqual(
    cardConnection.productionReadOnlyPreflightHosts?.('192.168.4.1'),
    ['192.168.4.1', 'lightweaver.local'],
  );
});

test('read-only Production preflight falls back symmetrically without accepting a public origin', () => {
  assert.deepEqual(
    cardConnection.productionReadOnlyPreflightHosts?.('lightweaver.local'),
    ['lightweaver.local', '192.168.4.1'],
  );
  assert.deepEqual(
    cardConnection.productionReadOnlyPreflightHosts?.('192.168.18.70'),
    ['192.168.18.70', '192.168.4.1'],
  );
  assert.deepEqual(
    cardConnection.productionReadOnlyPreflightHosts?.('https://example.com/card'),
    ['lightweaver.local', '192.168.4.1'],
  );
  assert.equal(cardConnection.PRODUCTION_READ_ONLY_PREFLIGHT_FALLBACK_MS, 5_000);
});

test('read-only preflight accepts exact USB identity on the fallback origin despite stale handoff-ready firmware', () => {
  assert.equal(
    productionLease.productionReadOnlyPreflightAuthority?.(
      staleBuildHandoffReadyLink(), CARD_ID, 'lightweaver.local',
    ).ok,
    true,
  );
});

test('read-only preflight rejects a wrong card and post-install runtime authority stays strict', () => {
  const wrongCard = staleBuildHandoffReadyLink({
    card: { id: 'lw-ffffffffffff' },
    readiness: {
      ...staleBuildHandoffReadyLink().readiness,
      cardId: 'lw-ffffffffffff',
    },
  });
  assert.equal(
    productionLease.productionReadOnlyPreflightAuthority?.(wrongCard, CARD_ID, 'lightweaver.local').ok,
    false,
  );
  assert.equal(productionLease.productionCardAuthority(staleBuildHandoffReadyLink(), CARD_ID, {
    mutation: 'runtime', expectedFirmwareVersion: '1.0.0', expectedBuildId: 'a'.repeat(40),
  }).ok, false);
});
