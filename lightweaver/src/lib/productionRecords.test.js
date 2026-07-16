import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PRODUCTION_RECORDS,
  PRODUCTION_RECORDS_BACKUP_KEY,
  PRODUCTION_RECORDS_PRIMARY_KEY,
  appendProductionRecord,
  productionRecordsCsv,
  productionRecordsJson,
  readProductionRecords,
} from './productionRecords.js';

class Storage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

const record = (n = 1) => ({
  runId: `run_${String(n).padStart(16, '0')}`,
  jobId: `job-${n}`,
  jobDigest: String(n % 10).repeat(64),
  artwork: `Artwork ${n}`,
  batch: 'July',
  cardId: `lw-card-${n}`,
  firmwareVersion: '1.2.3',
  firmwareBuildId: 'a'.repeat(40),
  projectRevision: n,
  projectFingerprint: 'b'.repeat(32),
  restoredControls: ['encoder', 'brightness'],
  physicalResults: [{ boundaryId: 'outer-run', result: 'correct', count: 44, pin: 16, direction: 'forward', colorOrder: 'GRB' }],
  activationConfirmed: true,
  workerId: 'AR',
  passedAt: new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString(),
});

const legacyRecord = (n = 1) => ({
  ...record(n),
  physicalResults: [{ output: 1, result: 'correct' }, { output: 'out2', result: 'correct' }],
});

function checksum(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function encodedRecords(records) {
  const payload = JSON.stringify(records);
  return JSON.stringify({ version: 1, checksum: checksum(payload), payload });
}

test('production pass records survive a corrupt primary through the backup copy', () => {
  const storage = new Storage();
  appendProductionRecord(record(), { storage });
  storage.setItem('lw_production_records_v1_primary', '{broken');
  assert.deepEqual(readProductionRecords({ storage }), [record()]);
});

test('checksum-valid v1 pass records remain readable from primary and backup storage', () => {
  const primary = new Storage();
  primary.setItem(PRODUCTION_RECORDS_PRIMARY_KEY, encodedRecords([legacyRecord()]));
  assert.deepEqual(readProductionRecords({ storage: primary }), [legacyRecord()]);

  const backup = new Storage();
  backup.setItem(PRODUCTION_RECORDS_PRIMARY_KEY, '{broken');
  backup.setItem(PRODUCTION_RECORDS_BACKUP_KEY, encodedRecords([legacyRecord(2)]));
  assert.deepEqual(readProductionRecords({ storage: backup }), [legacyRecord(2)]);
});

test('appending an enriched pass retains and exports strict legacy records in the same collection', () => {
  const storage = new Storage();
  storage.setItem(PRODUCTION_RECORDS_PRIMARY_KEY, encodedRecords([legacyRecord()]));
  appendProductionRecord(record(2), { storage });
  assert.deepEqual(readProductionRecords({ storage }), [legacyRecord(), record(2)]);
  assert.deepEqual(JSON.parse(productionRecordsJson({ storage })).records, [legacyRecord(), record(2)]);
  const output = productionRecordsCsv({ storage });
  assert.match(output, /\[\{""output"":1,""result"":""correct""\}/);
  assert.match(output, /boundaryId.*outer-run.*count.*44/);
});

test('production pass records are bounded and reject duplicate run IDs', () => {
  const storage = new Storage();
  appendProductionRecord(record(1), { storage });
  assert.throws(() => appendProductionRecord(record(1), { storage }), /already has a pass record/i);
  for (let n = 2; n <= MAX_PRODUCTION_RECORDS + 2; n += 1) appendProductionRecord(record(n), { storage });
  const records = readProductionRecords({ storage });
  assert.equal(records.length, MAX_PRODUCTION_RECORDS);
  assert.equal(records.at(-1).jobId, `job-${MAX_PRODUCTION_RECORDS + 2}`);
});

test('exports only the bounded workshop facts as JSON and CSV', () => {
  const storage = new Storage();
  appendProductionRecord({ ...record(), artwork: 'Moon, "gold"' }, { storage });
  const json = JSON.parse(productionRecordsJson({ storage }));
  assert.equal(json.records.length, 1);
  assert.equal(json.notice, 'These records were stored locally in this browser.');
  assert.deepEqual(json.records[0].physicalResults, record().physicalResults);
  const exportedCsv = productionRecordsCsv({ storage });
  assert.match(exportedCsv, /"Moon, ""gold"""/);
  assert.match(exportedCsv, /outer-run.*count.*44.*pin.*16.*direction.*forward.*colorOrder.*GRB/);
  assert.doesNotMatch(exportedCsv, /password|serialPath|rawError/i);
});

test('invalid, secret, and incomplete records fail closed', () => {
  const storage = new Storage();
  assert.throws(() => appendProductionRecord({ ...record(), password: 'secret' }, { storage }), /unsupported field/i);
  assert.throws(() => appendProductionRecord({ ...record(), cardId: '' }, { storage }), /card ID/i);
  assert.throws(() => appendProductionRecord({ ...record(), activationConfirmed: false }, { storage }), /activation confirmation/i);
  assert.throws(() => appendProductionRecord({ ...record(), physicalResults: [{ boundaryId: 'outer-run', result: 'correct' }] }, { storage }), /physical results/i);
  assert.throws(() => appendProductionRecord({ ...record(), physicalResults: [{ ...record().physicalResults[0], password: 'secret' }] }, { storage }), /physical results/i);
  assert.throws(() => appendProductionRecord({ ...legacyRecord(), physicalResults: [{ output: 1, result: 'correct', password: 'secret' }] }, { storage }), /physical results/i);
});

test('CSV exports neutralize spreadsheet formulas, including after whitespace', () => {
  const storage = new Storage();
  appendProductionRecord({ ...record(), artwork: '=HYPERLINK("https://evil")', batch: ' +SUM(1,2)', workerId: '@worker' }, { storage });
  const output = productionRecordsCsv({ storage });
  assert.match(output, /"'=HYPERLINK\(""https:\/\/evil""\)"/);
  assert.match(output, /"' \+SUM\(1,2\)"/);
  assert.match(output, /"'@worker"/);
});
