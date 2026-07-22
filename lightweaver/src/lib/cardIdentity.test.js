import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CARD_IDENTITY_STORAGE_KEY,
  compareCardIdentity,
  adoptExpectedCardIdentity,
  forgetExpectedCardIdentity,
  normalizeCardIdentity,
  normalizeCardProjectEvidence,
  persistCardIdentity,
  readPersistedCardIdentity,
} from './cardIdentity.js';

const firmwareInfo = {
  app: 'Lightweaver',
  cardId: 'lw-001122aabbcc',
  piece: { name: 'Front Mandala' },
  firmwareVersion: '1.4.0',
  buildId: 'abc123',
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
    projectRevision: 7,
    projectFingerprint: 'a'.repeat(16),
    productionJobId: 'job-42',
    productionJobDigest: 'b'.repeat(64),
  });
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
    acknowledgedAt,
  });
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
