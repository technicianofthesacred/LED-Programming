import assert from 'node:assert/strict';
import test from 'node:test';
import { clearProductionPhysicalState, readProductionPhysicalState, saveProductionPhysicalState } from './productionPhysicalPersistence.js';

class Storage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const state = () => ({
  runId: 'run_0000000000000001', jobDigest: 'a'.repeat(64), cardId: 'lw-aabbccddeeff',
  wiringRevision: 2, wiringDigest: 'b'.repeat(64),
  physicalConfig: { led: { pixels: 5, colorOrder: 'GRB', maxMilliamps: 1500, outputs: [{ id: 'out1', pin: 16, pixels: 5, direction: 'forward', segments: [{ id: 'outer', count: 5, direction: 'forward' }] }] }, zones: [] },
  results: { outer: { observation: 'correct', workerConfirmed: true, observedAt: '2026-01-01T00:00:00.000Z' } },
});

test('physical run state restores only for the exact run, job, card, revision, and wiring digest', () => {
  const storage = new Storage();
  saveProductionPhysicalState(state(), { storage });
  assert.deepEqual(readProductionPhysicalState(state(), { storage }), state());
  for (const mismatch of [{ runId: 'run_other_00000001' }, { cardId: 'lw-other' }, { wiringRevision: 3 }, { wiringDigest: 'c'.repeat(64) }]) {
    assert.equal(readProductionPhysicalState({ ...state(), ...mismatch }, { storage }), null);
  }
  clearProductionPhysicalState({ storage });
  assert.equal(readProductionPhysicalState(state(), { storage }), null);
});

test('physical run persistence rejects secrets, corrupt checksums, and oversized data', () => {
  const storage = new Storage();
  assert.throws(() => saveProductionPhysicalState({ ...state(), physicalConfig: { ...state().physicalConfig, password: 'secret' } }, { storage }), /unsupported|secret/i);
  saveProductionPhysicalState(state(), { storage });
  const [key] = storage.values.keys();
  storage.setItem(key, `${storage.getItem(key)}broken`);
  assert.equal(readProductionPhysicalState(state(), { storage }), null);
  assert.throws(() => saveProductionPhysicalState({ ...state(), physicalConfig: { ...state().physicalConfig, padding: 'x'.repeat(70_000) } }, { storage }), /limit|unsupported/i);
});
