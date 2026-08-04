import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyCardReadiness,
  normalizeCardReadiness,
} from './cardReadiness.js';

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

test('normalizes readiness evidence without inventing boolean or identity values', () => {
  const normalized = normalizeCardReadiness({
    app: 'Lightweaver',
    provisioningContractVersion: 1,
    cardId: `  ${CARD_ID}  `,
    firmwareVersion: ' 1.0.0 ',
    buildId: ` ${'a'.repeat(40)} `,
    bootId: ' boot-1 ',
    runtimePhase: ' ready ',
    knownGoodProject: 'true',
    commandReady: 1,
    outputReady: false,
  });

  assert.equal(normalized.cardId, CARD_ID);
  assert.equal(normalized.bootId, 'boot-1');
  assert.equal(normalized.runtimePhase, 'ready');
  assert.equal(normalized.knownGoodProject, null);
  assert.equal(normalized.commandReady, null);
  assert.equal(normalized.outputReady, false);
  assert.equal(normalized.identityValid, true);
  assert.equal(Object.isFrozen(normalized), true);
});

test('missing readiness evidence and old payloads fail closed as checking', () => {
  const requiredFields = [
    'knownGoodProject',
    'commandReady',
    'outputReady',
    'bootId',
    'provisioningContractVersion',
  ];

  for (const field of requiredFields) {
    const payload = readyEnvelope();
    delete payload[field];
    const result = classifyCardReadiness(payload, { expectedCardId: CARD_ID });
    assert.equal(result.state, 'checking', field);
    assert.equal(result.connected, false, field);
    assert.equal(result.blank, null, field);
  }

  const oldPayload = {
    app: 'Lightweaver',
    cardId: CARD_ID,
    firmwareVersion: '1.0.0',
    buildId: 'old-build',
    mode: 'run',
  };
  const oldResult = classifyCardReadiness(oldPayload, { expectedCardId: CARD_ID });
  assert.equal(oldResult.state, 'checking');
  assert.equal(oldResult.blank, null);
});

test('invalid Lightweaver identity and unsupported contracts remain checking', () => {
  const invalidIdentities = [
    { app: 'OtherProduct' },
    { cardId: '' },
    { cardId: `lw-${'a'.repeat(62)}` },
    { firmwareVersion: '' },
    { firmwareVersion: 'v'.repeat(49) },
    { buildId: '' },
    { buildId: 'b'.repeat(97) },
  ];
  for (const override of invalidIdentities) {
    const result = classifyCardReadiness(readyEnvelope(override), { expectedCardId: CARD_ID });
    assert.equal(result.state, 'checking', JSON.stringify(override));
    assert.equal(result.connected, false, JSON.stringify(override));
  }

  const unsupported = classifyCardReadiness(readyEnvelope({ provisioningContractVersion: 2 }), {
    expectedCardId: CARD_ID,
  });
  assert.equal(unsupported.state, 'checking');
  assert.equal(unsupported.connected, false);
});

test('only corroborated factory evidence is blank', () => {
  const result = classifyCardReadiness(readyEnvelope({
    runtimePhase: 'factory',
    knownGoodProject: false,
    commandReady: false,
    outputReady: false,
    mode: 'factory-flash',
    source: 'defaults',
  }), { expectedCardId: CARD_ID });

  assert.equal(result.state, 'blank');
  assert.equal(result.blank, true);
  assert.equal(result.connected, false);
});

test('reachable factory defaults remain blank during an abandoned WiFi handoff', () => {
  const result = classifyCardReadiness(readyEnvelope({
    runtimePhase: 'recovering',
    knownGoodProject: false,
    commandReady: false,
    outputReady: false,
    mode: 'factory-flash',
    source: 'defaults',
    projectId: '',
    projectFingerprint: '',
    wifi: {
      transition: 'handoff-abandoned',
      transitionPending: true,
      handoffGeneration: 1,
      apActive: false,
      stationIp: '192.168.18.70',
    },
  }), { expectedCardId: CARD_ID });

  assert.equal(result.state, 'blank');
  assert.equal(result.blank, true);
  assert.equal(result.patternAccess, 'blank');
  assert.equal(result.connected, false);
});

test('factory recovery classification still fails closed for configured, wrong, and incomplete cards', () => {
  const recoveringConfigured = classifyCardReadiness(readyEnvelope({
    runtimePhase: 'recovering',
    knownGoodProject: true,
    commandReady: false,
    outputReady: false,
    mode: 'run',
    source: 'internal-flash',
    projectId: 'configured-piece',
    projectFingerprint: 'b'.repeat(16),
  }), { expectedCardId: CARD_ID });
  assert.equal(recoveringConfigured.state, 'not-ready');
  assert.equal(recoveringConfigured.blank, false);

  const wrongCard = classifyCardReadiness(readyEnvelope({
    cardId: 'lw-112233445566',
    runtimePhase: 'recovering',
    knownGoodProject: false,
    commandReady: false,
    outputReady: false,
    mode: 'factory-flash',
    source: 'defaults',
  }), { expectedCardId: CARD_ID });
  assert.equal(wrongCard.state, 'identity-mismatch');
  assert.equal(wrongCard.blank, null);

  const incomplete = readyEnvelope({
    runtimePhase: 'recovering',
    knownGoodProject: false,
    commandReady: false,
    outputReady: false,
    mode: 'factory-flash',
    source: 'defaults',
  });
  delete incomplete.provisioningContractVersion;
  const incompleteResult = classifyCardReadiness(incomplete, { expectedCardId: CARD_ID });
  assert.equal(incompleteResult.state, 'checking');
  assert.equal(incompleteResult.blank, null);
});

test('non-factory and partial factory evidence stays in recovery', () => {
  for (const override of [
    { runtimePhase: 'recovering', knownGoodProject: true, commandReady: false },
    { runtimePhase: 'recovering', knownGoodProject: false, commandReady: false },
    { runtimePhase: 'factory', knownGoodProject: false, commandReady: true, mode: 'factory-flash', source: 'defaults' },
    { runtimePhase: 'factory', knownGoodProject: false, commandReady: false, source: 'defaults' },
    { runtimePhase: 'factory', knownGoodProject: false, commandReady: false, mode: 'factory-flash' },
  ]) {
    const result = classifyCardReadiness(readyEnvelope(override), { expectedCardId: CARD_ID });
    assert.equal(result.state, 'not-ready', JSON.stringify(override));
    assert.equal(result.patternAccess, 'recovery', JSON.stringify(override));
    assert.equal(result.blank, false, JSON.stringify(override));
  }
});

test('pattern access permits card effects only for exact ready evidence', () => {
  const ready = classifyCardReadiness(readyEnvelope(), { expectedCardId: CARD_ID });
  const incomplete = classifyCardReadiness(readyEnvelope({ outputReady: false }), {
    expectedCardId: CARD_ID,
  });

  assert.equal(ready.patternAccess, 'ready');
  assert.equal(incomplete.patternAccess, 'recovery');
});

test('an unexpected exact card ID is an identity mismatch', () => {
  const result = classifyCardReadiness(readyEnvelope({ cardId: 'lw-112233445566' }), {
    expectedCardId: CARD_ID,
  });
  assert.equal(result.state, 'identity-mismatch');
  assert.equal(result.cardId, 'lw-112233445566');
  assert.equal(result.connected, false);
});

test('a changed boot ID revalidates before becoming connected', () => {
  const result = classifyCardReadiness(readyEnvelope({ bootId: 'boot-2' }), {
    expectedCardId: CARD_ID,
    previousBootId: 'boot-1',
  });
  assert.equal(result.state, 'revalidating');
  assert.equal(result.bootId, 'boot-2');
  assert.equal(result.connected, false);
});

test('incomplete runtime readiness is not ready', () => {
  for (const override of [
    { runtimePhase: 'recovering' },
    { knownGoodProject: false },
    { commandReady: false },
    { outputReady: false },
  ]) {
    const result = classifyCardReadiness(readyEnvelope(override), { expectedCardId: CARD_ID });
    assert.equal(result.state, 'not-ready', JSON.stringify(override));
    assert.equal(result.connected, false, JSON.stringify(override));
  }
});

test('only complete fresh readiness evidence for the expected card is connected', () => {
  const result = classifyCardReadiness(readyEnvelope(), { expectedCardId: CARD_ID });
  assert.equal(result.state, 'connected');
  assert.equal(result.connected, true);
  assert.equal(result.blank, false);
  assert.equal(result.cardId, CARD_ID);
  assert.equal(result.bootId, 'boot-1');
  assert.equal(result.runtimePhase, 'ready');
  assert.equal(typeof result.reason, 'string');
  assert.equal(Object.isFrozen(result), true);
});

test('exact expected firmware and build are part of live readiness', () => {
  const status = readyEnvelope();
  assert.equal(classifyCardReadiness(status, {
    expectedCard: {
      id: status.cardId,
      firmwareVersion: status.firmwareVersion,
      buildId: status.buildId,
    },
  }).connected, true);
  assert.equal(classifyCardReadiness(status, {
    expectedCard: { id: status.cardId, firmwareVersion: '0.9.0', buildId: status.buildId },
  }).reason, 'unexpected-firmware-version');
  assert.equal(classifyCardReadiness(status, {
    expectedCard: { id: status.cardId, firmwareVersion: status.firmwareVersion, buildId: 'old-build' },
  }).reason, 'unexpected-firmware-build');
});
