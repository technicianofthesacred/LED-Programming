import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCardLink,
  getCardLinkState,
  getSharedCardLink,
  initialCardLinkState,
  invalidateCardLinkOperationLease,
  isCardLinkConnected,
  reportDirectCardStatus,
  reduceCardLink,
} from './cardLink.js';

const CARD_ID = 'lw-aabbccddeeff';

function readyEnvelope(overrides = {}) {
  return {
    app: 'Lightweaver',
    provisioningContractVersion: 1,
    cardId: CARD_ID,
    firmwareVersion: '1.0.0',
    buildId: 'a'.repeat(40),
    bootId: 'boot-1',
    runtimePhase: 'ready',
    knownGoodProject: true,
    commandReady: true,
    outputReady: true,
    ...overrides,
  };
}

test('live card helper rejects transport-only state and accepts complete fresh readiness', () => {
  const transportOnly = {
    state: 'connected-direct',
    card: { id: CARD_ID },
  };
  assert.equal(isCardLinkConnected(transportOnly), false);
  assert.equal(isCardLinkConnected({
    ...transportOnly,
    readiness: readyEnvelope(),
  }), true);
});

test('live card reducer preserves unknown blank state instead of inventing configured', () => {
  const bridge = reduceCardLink(initialCardLinkState('lightweaver.local'), {
    type: 'card-verified',
    via: 'bridge',
    host: 'lightweaver.local',
    card: { id: CARD_ID },
  });
  assert.equal(bridge.cardBlank, null);
  assert.equal(isCardLinkConnected(bridge), false);

  const direct = reduceCardLink(initialCardLinkState('lightweaver.local'), {
    type: 'direct-status',
    connected: true,
    host: 'lightweaver.local',
    card: { id: CARD_ID },
    expectedCard: { id: CARD_ID },
  });
  assert.equal(direct.cardBlank, null);
  assert.equal(isCardLinkConnected(direct), false);
});

test('live reducer carries readiness evidence into the shared helper', () => {
  const direct = reduceCardLink(initialCardLinkState('lightweaver.local'), {
    type: 'direct-status',
    connected: true,
    host: 'lightweaver.local',
    card: { id: CARD_ID },
    expectedCard: { id: CARD_ID },
    blank: false,
    readiness: readyEnvelope(),
  });
  assert.equal(isCardLinkConnected(direct), true);
});

test('direct status reporting feeds the fresh envelope to live consumers', (t) => {
  t.after(() => getSharedCardLink().destroy());
  reportDirectCardStatus({
    connected: true,
    host: 'lightweaver.local',
    card: { id: CARD_ID },
    status: readyEnvelope(),
    allowAdopt: true,
  });
  assert.equal(isCardLinkConnected(getCardLinkState()), true);
  assert.equal(getCardLinkState().cardBlank, false);

  reportDirectCardStatus({
    connected: true,
    host: 'lightweaver.local',
    card: { id: CARD_ID },
    status: {
      app: 'Lightweaver', cardId: CARD_ID,
      firmwareVersion: '1.0.0', buildId: 'old-build',
    },
    allowAdopt: true,
  });
  assert.equal(getCardLinkState().cardBlank, null);
  assert.equal(isCardLinkConnected(getCardLinkState()), false);

  reportDirectCardStatus({
    connected: true,
    host: 'lightweaver.local',
    card: { id: CARD_ID },
    status: readyEnvelope({ runtimePhase: 'factory', knownGoodProject: false }),
    allowAdopt: true,
  });
  assert.equal(getCardLinkState().cardBlank, null, 'first complete recovery envelope only establishes its boot candidate');
  reportDirectCardStatus({
    connected: true,
    host: 'lightweaver.local',
    card: { id: CARD_ID },
    status: readyEnvelope({ runtimePhase: 'factory', knownGoodProject: false }),
    allowAdopt: true,
  });
  assert.equal(getCardLinkState().cardBlank, true);
  assert.equal(isCardLinkConnected(getCardLinkState()), false);
});

test('an exact operation lease loss demotes only the lifecycle that failed', (t) => {
  const link = createCardLink({ host: '192.168.18.70', directPingIntervalMs: 0 });
  t.after(() => link.destroy());
  link.dispatch({
    type: 'direct-status', connected: true, host: '192.168.18.70',
    card: { id: CARD_ID }, expectedCard: { id: CARD_ID }, readiness: readyEnvelope(),
  });
  const current = link.getState();
  const lease = {
    expectedCardId: CARD_ID,
    host: current.host,
    transport: 'direct',
    bridgeLifecycle: null,
    operationGeneration: current.operationGeneration,
    validatedBootId: current.validatedBootId,
  };

  assert.equal(invalidateCardLinkOperationLease(lease, { link, reason: 'production-config-timeout' }), true);
  assert.equal(link.getState().state, 'revalidating');
  assert.equal(link.getState().reason, 'production-config-timeout');
  assert.equal(link.getState().cardBlank, null);
  assert.equal(link.getState().operationGeneration, lease.operationGeneration + 1);

  link.dispatch({
    type: 'direct-status', connected: true, host: '192.168.18.70',
    card: { id: CARD_ID }, expectedCard: { id: CARD_ID }, readiness: readyEnvelope({ bootId: 'boot-2' }),
  });
  link.dispatch({
    type: 'direct-status', connected: true, host: '192.168.18.70',
    card: { id: CARD_ID }, expectedCard: { id: CARD_ID }, readiness: readyEnvelope({ bootId: 'boot-2' }),
  });
  const revalidated = link.getState();
  assert.equal(revalidated.state, 'connected-direct');
  assert.equal(invalidateCardLinkOperationLease(lease, { link, reason: 'stale-operation' }), false);
  assert.equal(link.getState(), revalidated, 'an old operation cannot demote a newer card lifecycle');
});
