import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_IDENTITY_STORAGE_KEY,
  compareCardIdentity,
  adoptExpectedCardIdentity,
  forgetExpectedCardIdentity,
  normalizeCardIdentity,
  normalizeCardProjectEvidence,
  cardBuildLabel,
  persistCardIdentity,
  readPersistedCardIdentity,
  GENERIC_SETUP_NETWORK_LABEL,
  setupNetworkLabelForCardId,
  setupNetworkSsidForCardId,
} from './cardIdentity.js';

const firmwareInfo = {
  app: 'Lightweaver',
  cardId: 'lw-001122aabbcc',
  piece: { id: 'front-mandala', name: 'Front Mandala' },
  firmwareVersion: '1.4.0',
  buildId: 'abc123',
  buildNumber: 411,
  bridgeVersion: 1,
  outputs: [
    { id: 'left', gpio: 16, count: 44 },
    { id: 'right', pin: 17, pixels: 12 },
  ],
  limits: { pixels: 1024, outputs: 4, looks: 32 },
  wifi: { hostname: 'lightweaver-aabbcc', ip: '192.168.18.70' },
  projectRevision: 7,
  projectFingerprint: 'a'.repeat(16),
  productionJobId: 'job-42',
  productionJobDigest: 'b'.repeat(64),
};

test('normalizes firmware info into stable card identity and output summary', () => {
  assert.deepEqual(normalizeCardIdentity(firmwareInfo, '192.168.18.70'), {
    id: 'lw-001122aabbcc',
    name: 'Front Mandala',
    firmwareVersion: '1.4.0',
    buildId: 'abc123',
    buildNumber: 411,
    bridgeVersion: 1,
    host: '192.168.18.70',
    hostname: 'lightweaver-aabbcc',
    address: '192.168.18.70',
    outputs: [
      { id: 'left', gpio: 16, count: 44 },
      { id: 'right', gpio: 17, count: 12 },
    ],
    outputCount: 2,
    pixelCount: 56,
    gpioSummary: 'GPIO 16 · 44, GPIO 17 · 12',
    limits: { pixels: 1024, outputs: 4, looks: 32 },
    projectId: 'front-mandala',
    projectRevision: 7,
    projectFingerprint: 'a'.repeat(16),
    productionJobId: 'job-42',
    productionJobDigest: 'b'.repeat(64),
  });
});

test('preserves the exact installed piece id as card project evidence', () => {
  const evidence = normalizeCardProjectEvidence(firmwareInfo);
  assert.equal(evidence.projectId, 'front-mandala');
  assert.equal(normalizeCardIdentity(firmwareInfo).projectId, 'front-mandala');
});

test('normalizes status payloads and rejects missing or wrong identities', () => {
  const status = normalizeCardIdentity({
    cardId: 'lw-aabbccddeeff',
    piece: { name: 'Gallery piece', hostname: 'lightweaver-ddeeff' },
    led: { pixels: 90 },
    outputs: [{ gpio: 21, count: 90 }],
    firmwareVersion: '2.0.0',
  }, 'http://lightweaver-ddeeff.local/');
  assert.equal(status.id, 'lw-aabbccddeeff');
  assert.equal(status.host, 'lightweaver-ddeeff.local');
  assert.equal(status.pixelCount, 90);
  assert.deepEqual(compareCardIdentity({ id: status.id }, status), { ok: true, reason: '' });
  assert.deepEqual(compareCardIdentity({ id: status.id }, {}), { ok: false, reason: 'missing-identity' });
  assert.deepEqual(compareCardIdentity({ id: status.id }, { id: 'lw-other' }), { ok: false, reason: 'wrong-card' });
});

test('accepts only the canonical blank project identity pair from factory firmware', () => {
  const blank = {
    app: 'Lightweaver', cardId: 'lw-aabbccddeeff',
    firmwareVersion: '0.9.0', buildId: 'a'.repeat(40),
    projectRevision: 0, projectFingerprint: '', productionJobId: '', productionJobDigest: '',
  };
  assert.deepEqual(normalizeCardProjectEvidence(blank), {
    app: 'Lightweaver', cardId: 'lw-aabbccddeeff',
    firmwareVersion: '0.9.0', buildId: 'a'.repeat(40),
    projectRevision: 0,
  });
  assert.throws(() => normalizeCardProjectEvidence({
    ...blank, projectRevision: 1,
  }), /invalid project fingerprint/i);
  assert.throws(() => normalizeCardProjectEvidence({
    ...blank, projectRevision: '0',
  }), /invalid project revision/i);
  assert.throws(() => normalizeCardProjectEvidence({
    ...blank, projectRevision: undefined, projectFingerprint: 'b'.repeat(16),
  }), /invalid project revision/i);
});

test('preserves bounded Kaleidoscope capability and exact applied mapping evidence', () => {
  const mapping = {
    id: 'outer', zoneId: 'outer', pixelCount: 8,
    pointCount: 4, startLed: 0, offsets: [0, 0, 0, 0],
    spans: [{ start: 0, count: 8, sourceStart: 0, sourceStep: 1 }],
  };
  const evidence = normalizeCardProjectEvidence({
    app: 'Lightweaver', cardId: 'lw-aabbccddeeff',
    firmwareVersion: '2.0.0', buildId: 'build-kaleidoscope',
    outputs: [{ id: 'out1', pin: 16, pixels: 8 }],
    capabilities: { kaleidoscopeReflectionPoints: 1, futureCapability: 999 },
    kaleidoscopeMappings: [mapping],
  });

  assert.deepEqual(evidence.capabilities, { kaleidoscopeReflectionPoints: 1 });
  assert.deepEqual(evidence.kaleidoscopeMappings, [mapping]);
  assert.throws(() => normalizeCardProjectEvidence({
    app: 'Lightweaver', cardId: 'lw-aabbccddeeff',
    firmwareVersion: '2.0.0', buildId: 'build-kaleidoscope',
    outputs: [{ pin: 16, pixels: 8 }],
    capabilities: { kaleidoscopeReflectionPoints: 1 },
    kaleidoscopeMappings: Array.from({ length: 33 }, (_, index) => ({ ...mapping, id: `outer-${index}` })),
  }), /at most 32/i);
});

test('persists only stable nonsecret identity and connection hints under a versioned key', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const acknowledgedAt = '2026-07-14T12:00:00.000Z';
  persistCardIdentity({
    ...normalizeCardIdentity(firmwareInfo, '192.168.18.70'),
    password: 'never-store-me',
    wifi: { ssid: 'private', password: 'secret' },
    rawNvs: 'secret bytes',
  }, { storage, acknowledgedAt });

  assert.ok(values.has(CARD_IDENTITY_STORAGE_KEY));
  const serialized = values.get(CARD_IDENTITY_STORAGE_KEY);
  assert.doesNotMatch(serialized, /never-store-me|private|secret bytes|password|ssid|rawNvs/i);
  assert.deepEqual(readPersistedCardIdentity({ storage }), {
    version: 1,
    id: 'lw-001122aabbcc',
    name: 'Front Mandala',
    hostname: 'lightweaver-aabbcc',
    address: '192.168.18.70',
    firmwareVersion: '1.4.0',
    buildId: 'abc123',
    buildNumber: 411,
    acknowledgedAt,
  });
});

test('card build label prefers the comparable number and falls back to the revision', () => {
  assert.equal(cardBuildLabel({ buildNumber: 411, buildId: 'a'.repeat(40) }), 'Build 411');
  assert.equal(cardBuildLabel({ buildNumber: 0, buildId: 'a'.repeat(40) }), `Build ${'a'.repeat(12)}`);
  assert.equal(cardBuildLabel({ buildNumber: -3, buildId: 'abc123' }), 'Build abc123');
  assert.equal(cardBuildLabel({}), '');
});

test('storage helpers are safe without a browser', () => {
  assert.equal(readPersistedCardIdentity({ storage: null }), null);
  assert.equal(persistCardIdentity({ id: 'lw-a' }, { storage: null }), false);
});

test('explicit adoption and forgetting re-pairs without silent replacement', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  assert.equal(adoptExpectedCardIdentity({ id: 'lw-first', name: 'First' }, { storage }), true);
  assert.equal(readPersistedCardIdentity({ storage }).id, 'lw-first');
  assert.equal(forgetExpectedCardIdentity({ storage }), true);
  assert.equal(readPersistedCardIdentity({ storage }), null);
  assert.equal(adoptExpectedCardIdentity({ id: 'lw-second', name: 'Second' }, { storage }), true);
  assert.equal(readPersistedCardIdentity({ storage }).id, 'lw-second');
});

test('the setup hotspot SSID is derived from the firmware card id, not invented', () => {
  // Firmware: apSsid() = "Lightweaver-" + %04X of (mac & 0xffff);
  // runtimeCardId() = "lw-" + %012llx of (mac & 0xffffffffffff). The low 16
  // bits are the last four hex characters of the card id.
  assert.equal(setupNetworkSsidForCardId('lw-aabbccddeeff'), 'Lightweaver-EEFF');
  assert.equal(setupNetworkSsidForCardId('lw-001122aabbcc'), 'Lightweaver-BBCC');
  assert.equal(setupNetworkSsidForCardId('lw-00000000000f'), 'Lightweaver-000F');
  // Uppercase input still yields the firmware's uppercase suffix.
  assert.equal(setupNetworkSsidForCardId('LW-AABBCCDDEEFF'), 'Lightweaver-EEFF');
  // Object form, as held on link.card / flow.expectedCard.
  assert.equal(setupNetworkSsidForCardId({ id: 'lw-aabbccddeeff' }), 'Lightweaver-EEFF');
});

test('a card id without the firmware shape never fabricates an SSID', () => {
  for (const value of ['', null, undefined, 'lw-gallery-card', 'lw-remembered-card', 'lw-aabbccddeef', 'lw-aabbccddeeffa', 'aabbccddeeff', 'Lightweaver-EEFF']) {
    assert.equal(setupNetworkSsidForCardId(value), '', `expected no SSID for ${String(value)}`);
  }
});

test('the copy label falls back to a description instead of a fake network name', () => {
  assert.equal(setupNetworkLabelForCardId('lw-aabbccddeeff'), 'Lightweaver-EEFF');
  assert.equal(setupNetworkLabelForCardId('lw-gallery-card'), GENERIC_SETUP_NETWORK_LABEL);
  assert.equal(setupNetworkLabelForCardId(''), GENERIC_SETUP_NETWORK_LABEL);
  assert.match(GENERIC_SETUP_NETWORK_LABEL, /starts with/);
  assert.doesNotMatch(GENERIC_SETUP_NETWORK_LABEL, /XXXX/);
});
