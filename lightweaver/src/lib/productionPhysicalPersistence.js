export const PRODUCTION_PHYSICAL_STATE_KEY = 'lw_production_physical_state_v1';
const MAX_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const EXACT_KEYS = new Set(['cardId', 'jobDigest', 'physicalConfig', 'results', 'runId', 'wiringDigest', 'wiringRevision']);
const FORBIDDEN = /(password|secret|token|credential|serial|private|auth)/i;

function storageDefault() { try { return globalThis.localStorage || null; } catch { return null; } }
function checksum(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, '0');
}
function hasForbiddenKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  return Object.entries(value).some(([key, nested]) => FORBIDDEN.test(key) || hasForbiddenKey(nested));
}
function valid(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !EXACT_KEYS.has(key) || FORBIDDEN.test(key))) throw new Error('Physical run state contains unsupported fields.');
  if (!/^[A-Za-z0-9_-]{16,96}$/.test(value.runId || '') || !/^[a-f0-9]{64}$/.test(value.jobDigest || '') || !/^[A-Za-z0-9._:-]{3,64}$/.test(value.cardId || '')) throw new Error('Physical run correlation is invalid.');
  if (!Number.isSafeInteger(value.wiringRevision) || value.wiringRevision < 1 || !/^[a-f0-9]{64}$/.test(value.wiringDigest || '')) throw new Error('Physical wiring evidence is invalid.');
  const raw = JSON.stringify(value);
  if (hasForbiddenKey(value) || encoder.encode(raw).byteLength > MAX_BYTES) throw new Error('Physical run state exceeds its safe storage limit or contains a secret.');
  return JSON.parse(raw);
}

export function saveProductionPhysicalState(value, { storage = storageDefault() } = {}) {
  if (!storage?.setItem) throw new Error('Physical run storage is unavailable.');
  const safe = valid(value);
  const payload = JSON.stringify(safe);
  storage.setItem(PRODUCTION_PHYSICAL_STATE_KEY, JSON.stringify({ version: 1, checksum: checksum(payload), payload }));
  return safe;
}

export function readProductionPhysicalState(expected, { storage = storageDefault() } = {}) {
  try {
    const envelope = JSON.parse(storage?.getItem?.(PRODUCTION_PHYSICAL_STATE_KEY) || 'null');
    if (envelope?.version !== 1 || typeof envelope.payload !== 'string' || checksum(envelope.payload) !== envelope.checksum) return null;
    const value = valid(JSON.parse(envelope.payload));
    return ['runId', 'jobDigest', 'cardId', 'wiringRevision', 'wiringDigest'].every(key => value[key] === expected[key]) ? value : null;
  } catch { return null; }
}

export function clearProductionPhysicalState({ storage = storageDefault() } = {}) { storage?.removeItem?.(PRODUCTION_PHYSICAL_STATE_KEY); }
