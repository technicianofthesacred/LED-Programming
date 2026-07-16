import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProductionDiagnostic,
  classifyProductionPhysicalFailure,
  classifyProductionFailure,
  inferProductionFailure,
} from './productionRecovery.js';

const CASES = [
  ['charge-only-cable', 'LW-USB-101', 'retry-usb', 'no', 'yes'],
  ['port-busy', 'LW-USB-102', 'retry-usb', 'no', 'yes'],
  ['linux-permissions', 'LW-USB-103', 'retry-usb', 'no', 'yes'],
  ['missing-driver', 'LW-USB-104', 'retry-usb', 'no', 'yes'],
  ['multiple-cards', 'LW-USB-105', 'retry-usb', 'no', 'yes'],
  ['unsupported-card', 'LW-USB-106', 'retry-usb', 'no', 'yes'],
  ['disconnect-phase', 'LW-USB-107', 'release-usb', 'unknown', 'unknown'],
  ['usb-ownership-uncertain', 'LW-USB-108', 'release-usb', 'unknown', 'unknown'],
  ['wrong-card-reconnect', 'LW-CARD-201', 'reconnect-expected-card', 'no', 'yes'],
  ['card-page-unavailable', 'LW-CARD-202', 'reconnect-expected-card', 'no', 'yes'],
  ['restore-failure', 'LW-LOAD-301', 'verify-restore', 'unknown', 'yes'],
  ['restore-readback-mismatch', 'LW-LOAD-302', 'retry-restore', 'unknown', 'yes'],
  ['physical-failure', 'LW-LIGHT-401', 'rerun-physical', 'no', 'yes'],
  ['signed-release-failure', 'LW-FW-501', 'retry-signed-release', 'no', 'yes'],
];

test('every production failure has stable facts and exactly one safest action', () => {
  for (const [kind, supportCode, actionId, cardChanged, usbReleased] of CASES) {
    const recovery = classifyProductionFailure(kind);
    assert.equal(recovery.kind, kind);
    assert.equal(recovery.supportCode, supportCode);
    assert.equal(recovery.cardChanged, cardChanged);
    assert.equal(recovery.usbReleased, usbReleased);
    assert.equal(recovery.action.id, actionId);
    assert.equal(typeof recovery.action.label, 'string');
    assert.ok(recovery.action.label.length > 4);
    assert.equal(Object.keys(recovery).filter(key => key === 'action').length, 1);
    assert.match(recovery.whatHappened, /\S/);
  }
});

test('recovery never recommends firmware installation without exact mismatch evidence', () => {
  for (const [kind] of CASES) {
    const withoutEvidence = classifyProductionFailure(kind);
    assert.notEqual(withoutEvidence.action.id, 'install-firmware', kind);
  }
  assert.equal(classifyProductionFailure('firmware-mismatch', {
    firmwareEvidence: { exactCard: true, installedVersion: '0.9.0', installedBuildId: 'old', targetVersion: '1.0.0', targetBuildId: 'new' },
  }).action.id, 'reinspect-firmware-mismatch');
  assert.notEqual(classifyProductionFailure('firmware-mismatch', {
    firmwareEvidence: { exactCard: false, installedVersion: '0.9.0', targetVersion: '1.0.0' },
  }).action.id, 'install-firmware');
});

test('uncertain USB release always outranks later recovery and requires a safe release', () => {
  for (const kind of ['wrong-card-reconnect', 'unsupported-card', 'disconnect-phase']) {
    const recovery = classifyProductionFailure(kind, { usbReleased: 'unknown' });
    assert.equal(recovery.usbReleased, 'unknown');
    assert.equal(recovery.action.id, 'release-usb');
    assert.match(recovery.action.label, /Release USB/i);
  }
});

test('a different USB card is classified as wrong-card regardless of workflow phase', () => {
  for (const phase of ['connect-card', 'inspect', 'reconnect', 'restore']) {
    const recovery = inferProductionFailure(new Error('Wrong card. Reconnect lw-expected; this card is lw-other.'), { phase, usbReleased: 'yes' });
    assert.equal(recovery.kind, 'wrong-card-reconnect');
    assert.equal(recovery.action.id, 'reconnect-expected-card');
  }
});

test('physical observations receive stable support codes and one bounded next action', () => {
  const expected = {
    'nothing-lit': ['LW-LIGHT-411', 'retry-physical-stream'],
    'wrong-color': ['LW-LIGHT-412', 'open-physical-correction'],
    'wrong-start-end': ['LW-LIGHT-413', 'open-physical-correction'],
    'wrong-count': ['LW-LIGHT-414', 'open-physical-correction'],
    'wrong-output': ['LW-LIGHT-415', 'open-physical-correction'],
    'flashing-or-frozen': ['LW-LIGHT-416', 'retry-physical-stream'],
  };
  for (const [observation, [code, action]] of Object.entries(expected)) {
    const recovery = classifyProductionPhysicalFailure(observation);
    assert.equal(recovery.supportCode, code);
    assert.equal(recovery.action.id, action);
    assert.equal(recovery.cardChanged, 'no');
    assert.equal(recovery.usbReleased, 'yes');
  }
});

test('browser and transport errors map to bounded worker-safe classifications without retaining raw errors', () => {
  const examples = [
    [new DOMException('No port selected', 'NotFoundError'), { phase: 'connect-card' }, 'multiple-cards'],
    [new DOMException('Failed to open serial port: Access denied', 'NetworkError'), { phase: 'connect-card' }, 'port-busy'],
    [new Error('Permission denied opening /dev/ttyUSB0'), { phase: 'connect-card', os: 'linux' }, 'linux-permissions'],
    [new Error('USB serial driver was not found'), { phase: 'connect-card' }, 'missing-driver'],
    [new Error('ESP32-C3 is not supported'), { phase: 'inspect' }, 'unsupported-card'],
    [new Error('The same card could not be verified'), { phase: 'reconnect' }, 'wrong-card-reconnect'],
    [new Error('Response lost after card accepted restore'), { phase: 'restore' }, 'restore-failure'],
  ];
  for (const [error, context, expected] of examples) {
    const result = inferProductionFailure(error, context);
    assert.equal(result.kind, expected);
    assert.doesNotMatch(JSON.stringify(result), /ttyUSB0|Response lost|Access denied|ESP32-C3/);
  }
});

test('diagnostic export has an exact redacted allowlist and a hard byte bound', () => {
  const diagnostic = buildProductionDiagnostic({
    app: 'Lightweaver', version: '0.1.0', os: 'linux', arch: 'x86_64',
    supportCode: 'LW-USB-103', phase: 'connect-card', firmwareTarget: 'esp32-s3-n16r8@1.0.0+f5625d59',
    vid: 0x303a, pid: 0x1001,
    host: 'lightweaver.local', cardId: 'lw-secret', jobId: 'moon-batch-7', workerId: 'AR',
    rawError: 'Permission denied /dev/ttyUSB0', secret: 'never',
  });
  assert.deepEqual(Object.keys(diagnostic), ['app', 'version', 'os', 'arch', 'supportCode', 'phase', 'firmwareTarget', 'vid', 'pid']);
  assert.deepEqual(diagnostic, {
    app: 'Lightweaver', version: '0.1.0', os: 'linux', arch: 'x86_64',
    supportCode: 'LW-USB-103', phase: 'connect-card', firmwareTarget: 'esp32-s3-n16r8@1.0.0+f5625d59',
    vid: '0x303a', pid: '0x1001',
  });
  assert.ok(new TextEncoder().encode(JSON.stringify(diagnostic)).byteLength <= 1024);
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|moon|worker|ttyUSB|lightweaver\.local/i);
});

test('diagnostic export normalizes hostile values instead of leaking arbitrary text', () => {
  const diagnostic = buildProductionDiagnostic({
    app: 'Lightweaver\nsecret', version: 'v'.repeat(5000), os: '/Users/name', arch: 'x86<script>',
    supportCode: 'not valid secret', phase: 'restore with token', firmwareTarget: 'target\npassword',
    vid: -1, pid: 999999,
  });
  assert.deepEqual(diagnostic, {
    app: 'Lightweaver', version: 'unknown', os: 'unknown', arch: 'unknown', supportCode: 'LW-UNKNOWN-900',
    phase: 'unknown', firmwareTarget: 'unknown', vid: 'unknown', pid: 'unknown',
  });
});
