import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptWifiHandoff,
  isFinalStationHandoff,
} from './cardWifiHandoff.js';

const expectedCard = Object.freeze({
  id: 'lw-b0fe81f61b44',
  firmwareVersion: '1.0.0',
  buildId: 'build-exact-123',
});

function handoffStatus(overrides = {}) {
  const wifi = {
    transport: 'ap',
    transition: 'handoff-ready',
    transitionPending: true,
    apActive: true,
    stationIp: '192.168.18.70',
    handoffGeneration: 4,
    ...(overrides.wifi || {}),
  };
  return {
    app: 'Lightweaver',
    provisioningContractVersion: 1,
    cardId: expectedCard.id,
    firmwareVersion: expectedCard.firmwareVersion,
    buildId: expectedCard.buildId,
    bootId: 'boot-current',
    runtimePhase: 'factory',
    knownGoodProject: false,
    commandReady: false,
    outputReady: true,
    ...overrides,
    wifi,
  };
}

function accept(status = handoffStatus(), overrides = {}) {
  return acceptWifiHandoff({
    status,
    expectedCard,
    expectedBootId: 'boot-current',
    lastGeneration: 3,
    ...overrides,
  });
}

test('accepts complete exact-card factory handoff readiness', () => {
  assert.deepEqual(accept(), {
    host: '192.168.18.70',
    expectedCardId: expectedCard.id,
    expectedFirmwareVersion: expectedCard.firmwareVersion,
    expectedBuildId: expectedCard.buildId,
    expectedBootId: 'boot-current',
    handoffGeneration: 4,
  });
});

test('rejects missing and partial identity/readiness evidence', () => {
  for (const field of [
    'app',
    'provisioningContractVersion',
    'cardId',
    'firmwareVersion',
    'buildId',
    'bootId',
    'knownGoodProject',
    'commandReady',
    'outputReady',
  ]) {
    const status = handoffStatus();
    delete status[field];
    assert.equal(accept(status), null, `missing ${field} must fail closed`);
  }
  for (const field of ['transition', 'transitionPending', 'apActive', 'stationIp', 'handoffGeneration']) {
    const status = handoffStatus();
    delete status.wifi[field];
    assert.equal(accept(status), null, `missing wifi.${field} must fail closed`);
  }
  assert.equal(accept(handoffStatus(), { expectedCard: { id: expectedCard.id } }), null,
    'partial expected identity cannot establish correlation');
});

test('rejects wrong card, firmware, build, and current boot', () => {
  assert.equal(accept(handoffStatus({ cardId: 'lw-different' })), null);
  assert.equal(accept(handoffStatus({ firmwareVersion: '0.9.0' })), null);
  assert.equal(accept(handoffStatus({ buildId: 'wrong-build' })), null);
  assert.equal(accept(handoffStatus({ bootId: 'boot-changed' })), null);
});

test('compares raw bounded identity and boot evidence without trimming or truncation aliases', () => {
  assert.equal(accept(handoffStatus({ bootId: ' boot-current ' })), null);
  assert.equal(accept(handoffStatus(), { expectedBootId: ' boot-current ' }), null);
  assert.equal(accept(handoffStatus({ cardId: ` ${expectedCard.id}` })), null);
  assert.equal(accept(handoffStatus(), {
    expectedCard: { ...expectedCard, firmwareVersion: '1.0.0 ' },
  }), null);
  assert.equal(accept(handoffStatus({ buildId: `${expectedCard.buildId} ` })), null);

  const exactBoot = 'b'.repeat(96);
  assert.equal(accept(handoffStatus({ bootId: `${exactBoot}x` }), {
    expectedBootId: exactBoot,
  }), null, 'an overlength actual boot must not truncate to the expected boot');
  assert.equal(accept(handoffStatus({ bootId: exactBoot }), {
    expectedBootId: `${exactBoot}x`,
  }), null, 'an overlength expected boot must not truncate to the actual boot');

  const exactBuild = 'a'.repeat(96);
  assert.equal(accept(handoffStatus({ buildId: `${exactBuild}x` }), {
    expectedCard: { ...expectedCard, buildId: exactBuild },
  }), null, 'an overlength actual build must not truncate to the expected build');
});

test('requires the exact reachable handoff-ready AP state', () => {
  assert.equal(accept(handoffStatus({ wifi: { transition: 'station' } })), null);
  assert.equal(accept(handoffStatus({ wifi: { transitionPending: false } })), null);
  assert.equal(accept(handoffStatus({ wifi: { apActive: false } })), null);
});

test('rejects zero, stale, duplicate, and non-uint32 generations', () => {
  for (const generation of [0, 2, 3, -1, 1.5, 0x1_0000_0000, '4']) {
    assert.equal(
      accept(handoffStatus({ wifi: { handoffGeneration: generation } })),
      null,
      `generation ${generation} must fail closed`,
    );
  }
});

test('accepts only safe private station IPv4 targets', () => {
  for (const stationIp of [
    '192.168.4.1',
    '127.0.0.1',
    '169.254.2.3',
    '224.0.0.1',
    '8.8.8.8',
    '100.64.1.2',
    'lightweaver.local',
    '192.168.18.70:80',
    '192.168.18.999',
    ' 192.168.18.70/path ',
  ]) {
    assert.equal(
      accept(handoffStatus({ wifi: { stationIp } })),
      null,
      `${stationIp} must not become the station bridge target`,
    );
  }
  assert.equal(accept(handoffStatus({ wifi: { stationIp: '10.0.0.7' } })).host, '10.0.0.7');
  assert.equal(accept(handoffStatus({ wifi: { stationIp: '172.31.255.2' } })).host, '172.31.255.2');
});

test('final station correlation requires exact fresh status on the correlated station transport', () => {
  const correlation = accept();
  const status = handoffStatus({
    runtimePhase: 'factory',
    commandReady: true,
    wifi: {
      transport: 'station',
      transition: 'station',
      transitionPending: false,
      apActive: false,
      stationIp: correlation.host,
      ip: correlation.host,
      handoffGeneration: correlation.handoffGeneration,
    },
  });
  assert.equal(isFinalStationHandoff({ status, correlation }), true);

  const cases = [
    handoffStatus({ cardId: 'lw-different', wifi: status.wifi }),
    handoffStatus({ bootId: 'boot-changed', wifi: status.wifi }),
    handoffStatus({ wifi: { ...status.wifi, handoffGeneration: 5 } }),
    handoffStatus({ wifi: { ...status.wifi, transition: 'handoff-ready' } }),
    handoffStatus({ wifi: { ...status.wifi, transitionPending: true } }),
    handoffStatus({ wifi: { ...status.wifi, transport: 'ap' } }),
    handoffStatus({ wifi: { ...status.wifi, stationIp: '192.168.18.71' } }),
    handoffStatus({ wifi: { ...status.wifi, ip: '192.168.18.71' } }),
    handoffStatus({ commandReady: false, wifi: status.wifi }),
    handoffStatus({ commandReady: undefined, wifi: status.wifi }),
  ];
  for (const candidate of cases) {
    assert.equal(isFinalStationHandoff({ status: candidate, correlation }), false);
  }
  assert.equal(isFinalStationHandoff({
    status: { ...status, bootId: ` ${correlation.expectedBootId}` },
    correlation,
  }), false, 'final station boot comparison is exact and non-lossy');
});
