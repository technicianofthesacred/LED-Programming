export const PRODUCTION_RECORDS_PRIMARY_KEY = 'lw_production_records_v1_primary';
export const PRODUCTION_RECORDS_BACKUP_KEY = 'lw_production_records_v1_backup';
export const MAX_PRODUCTION_RECORDS = 250;
export const MAX_PRODUCTION_RECORDS_BYTES = 512 * 1024;

const FIELDS = Object.freeze([
  'runId', 'jobId', 'jobDigest', 'artwork', 'batch', 'cardId', 'firmwareVersion',
  'firmwareBuildId', 'projectRevision', 'projectFingerprint', 'restoredControls',
  'physicalResults', 'activationConfirmed', 'workerId', 'passedAt',
]);
const FIELD_SET = new Set(FIELDS);
const CONTROL_SET = new Set(['encoder', 'previous', 'next', 'blackout', 'brightness', 'statusLed']);
const encoder = new TextEncoder();

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

function checksum(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function text(value, label, { pattern, max = 160 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function validateProductionRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Production record is invalid');
  for (const key of Object.keys(record)) if (!FIELD_SET.has(key)) throw new Error(`Production record has unsupported field ${key}`);
  for (const field of FIELDS) if (!(field in record)) throw new Error(`Production record is missing ${field}`);
  text(record.runId, 'Run ID', { pattern: /^[A-Za-z0-9_-]{16,96}$/ });
  text(record.jobId, 'Job ID', { pattern: /^[A-Za-z0-9._-]{3,96}$/ });
  text(record.jobDigest, 'Job digest', { pattern: /^[a-f0-9]{64}$/ });
  text(record.artwork, 'Artwork');
  text(record.batch, 'Batch');
  text(record.cardId, 'Card ID', { pattern: /^[A-Za-z0-9._:-]{3,64}$/ });
  text(record.firmwareVersion, 'Firmware version', { max: 48 });
  text(record.firmwareBuildId, 'Firmware build ID', { pattern: /^[A-Za-z0-9._-]{7,64}$/ });
  if (!Number.isSafeInteger(record.projectRevision) || record.projectRevision < 0) throw new Error('Project revision is invalid');
  text(record.projectFingerprint, 'Project fingerprint', { pattern: /^[a-f0-9]{16,64}$/ });
  if (!Array.isArray(record.restoredControls) || record.restoredControls.length > CONTROL_SET.size || record.restoredControls.some(value => !CONTROL_SET.has(value))) throw new Error('Restored controls are invalid');
  if (!Array.isArray(record.physicalResults) || record.physicalResults.length === 0 || record.physicalResults.length > 16 || record.physicalResults.some(value => (
    !value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'output,result'
    || !((typeof value.output === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value.output))
      || (Number.isSafeInteger(value.output) && value.output >= 1 && value.output <= 16))
    || value.result !== 'correct'
  ))) throw new Error('Physical results are required');
  if (record.activationConfirmed !== true) throw new Error('Activation confirmation is required');
  text(record.workerId, 'Worker identifier', { max: 80 });
  text(record.passedAt, 'Pass timestamp', { max: 40 });
  if (!Number.isFinite(Date.parse(record.passedAt))) throw new Error('Pass timestamp is invalid');
  return structuredClone(record);
}

function encode(records) {
  const payload = JSON.stringify(records);
  const envelope = JSON.stringify({ version: 1, checksum: checksum(payload), payload });
  if (encoder.encode(envelope).byteLength > MAX_PRODUCTION_RECORDS_BYTES) throw new Error('Production records exceed the local storage limit');
  return envelope;
}

function decode(raw) {
  try {
    const envelope = JSON.parse(raw || 'null');
    if (envelope?.version !== 1 || typeof envelope.payload !== 'string' || checksum(envelope.payload) !== envelope.checksum) return null;
    const records = JSON.parse(envelope.payload);
    if (!Array.isArray(records) || records.length > MAX_PRODUCTION_RECORDS) return null;
    return records.map(validateProductionRecord);
  } catch { return null; }
}

export function readProductionRecords({ storage = defaultStorage() } = {}) {
  if (!storage?.getItem) return [];
  return decode(storage.getItem(PRODUCTION_RECORDS_PRIMARY_KEY))
    || decode(storage.getItem(PRODUCTION_RECORDS_BACKUP_KEY))
    || [];
}

export function appendProductionRecord(record, { storage = defaultStorage() } = {}) {
  if (!storage?.setItem) throw new Error('Local production record storage is unavailable');
  const safe = validateProductionRecord(record);
  const current = readProductionRecords({ storage });
  if (current.some(item => item.runId === safe.runId)) throw new Error('This run already has a pass record');
  const next = [...current, safe].slice(-MAX_PRODUCTION_RECORDS);
  const encoded = encode(next);
  storage.setItem(PRODUCTION_RECORDS_BACKUP_KEY, encoded);
  if (storage.getItem(PRODUCTION_RECORDS_BACKUP_KEY) !== encoded) throw new Error('Production record backup verification failed');
  storage.setItem(PRODUCTION_RECORDS_PRIMARY_KEY, encoded);
  if (storage.getItem(PRODUCTION_RECORDS_PRIMARY_KEY) !== encoded) throw new Error('Production record primary verification failed');
  return safe;
}

export function productionRecordsJson({ storage = defaultStorage() } = {}) {
  return JSON.stringify({
    format: 'lightweaver-production-records',
    version: 1,
    notice: 'These records were stored locally in this browser.',
    records: readProductionRecords({ storage }),
  }, null, 2);
}

function csv(value) {
  const raw = String(value ?? '');
  // Spreadsheet applications can execute cells beginning with these formula
  // sigils, including after whitespace. Keep exported workshop facts inert.
  const safe = /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function productionRecordsCsv({ storage = defaultStorage() } = {}) {
  const columns = ['runId', 'jobId', 'jobDigest', 'artwork', 'batch', 'cardId', 'firmwareVersion', 'firmwareBuildId', 'projectRevision', 'projectFingerprint', 'restoredControls', 'physicalResults', 'activationConfirmed', 'workerId', 'passedAt'];
  const rows = readProductionRecords({ storage }).map(record => columns.map(column => csv(
    Array.isArray(record[column]) ? JSON.stringify(record[column]) : record[column],
  )).join(','));
  return [columns.map(csv).join(','), ...rows].join('\r\n');
}
