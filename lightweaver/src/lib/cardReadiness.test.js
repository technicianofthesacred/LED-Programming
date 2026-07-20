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

test('factory evidence is blank even when the command API is alive', () => {
  for (const payload of [
    readyEnvelope({ runtimePhase: 'factory', knownGoodProject: false }),
    readyEnvelope({ runtimePhase: 'ready', knownGoodProject: false }),
  ]) {
    const result = classifyCardReadiness(payload, { expectedCardId: CARD_ID });
    assert.equal(result.state, 'blank');
    assert.equal(result.blank, true);
    assert.equal(result.connected, false);
  }
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
