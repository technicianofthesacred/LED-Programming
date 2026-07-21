export const PRODUCTION_RUN_STATES = Object.freeze([
  'select-job', 'connect-card', 'inspect', 'install', 'reconnect', 'restore',
  'verify-card', 'check-lights', 'record', 'complete', 'recovery',
]);
export const PRODUCTION_RUN_COMMIT_A_KEY = 'lw_production_run_v1_commit_a';
export const PRODUCTION_RUN_COMMIT_B_KEY = 'lw_production_run_v1_commit_b';
export const PRODUCTION_RUN_COMMIT_KEY = PRODUCTION_RUN_COMMIT_A_KEY;
export const PRODUCTION_RUN_SLOT_A_KEY = 'lw_production_run_v1_a';
export const PRODUCTION_RUN_SLOT_B_KEY = 'lw_production_run_v1_b';
export const PRODUCTION_RUN_STORAGE_KEY = PRODUCTION_RUN_SLOT_A_KEY;
export const PRODUCTION_RUN_BACKUP_STORAGE_KEY = PRODUCTION_RUN_SLOT_B_KEY;
export const MAX_PRODUCTION_RUN_BYTES = 16 * 1024;
export const PRODUCTION_RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const STATE_SET = new Set(PRODUCTION_RUN_STATES);
const NEXT = Object.freeze({
  'select-job': ['connect-card'],
  'connect-card': ['inspect'],
  inspect: ['install', 'restore'],
  install: ['reconnect'],
  reconnect: ['inspect', 'restore'],
  restore: ['verify-card'],
  'verify-card': ['check-lights', 'restore'],
  'check-lights': ['record'],
  record: ['complete'],
  complete: [],
  recovery: ['connect-card', 'inspect', 'reconnect', 'restore', 'check-lights'],
});
const SAFE_KEYS = Object.freeze([
  'version', 'generation', 'runId', 'flowId', 'jobDigest', 'expectedCardId', 'state',
  'operationId', 'createdAt', 'updatedAt', 'expiresAt', 'supportCode', 'cardChanged', 'usbReleased',
  'recoveryAction', 'recoveryReturnState',
]);
const FORBIDDEN_KEY = /(wifi|ssid|password|credential|serial(path|number)|firmware(bytes|image|binary)|raw(error|exception)|stack|project(payload|snapshot)|nonce)/i;
const encoder = new TextEncoder();
const queues = new WeakMap();
const RECOVERY_RULES = Object.freeze({
  'inspect-card': { target: 'connect-card', sources: ['connect-card', 'inspect', 'reconnect', 'restore', 'verify-card', 'check-lights'] },
  'release-usb': { target: 'connect-card', sources: ['connect-card', 'inspect', 'install', 'reconnect', 'restore', 'verify-card', 'check-lights'] },
  'reconnect-card': { target: 'reconnect', sources: ['install', 'reconnect'] },
  'restore-project': { target: 'restore', sources: ['restore', 'verify-card', 'check-lights', 'record'] },
  'rerun-lights': { target: 'check-lights', sources: ['check-lights', 'record'] },
  'signed-firmware-recovery': { target: 'connect-card', sources: ['inspect', 'install', 'reconnect', 'restore', 'verify-card', 'check-lights'] },
});
const CARD_REQUIRED_STATES = new Set(['install', 'reconnect', 'restore', 'verify-card', 'check-lights', 'record', 'complete']);

function defaultStorage() {
  try { return globalThis.localStorage || globalThis.window?.localStorage || null; } catch { return null; }
}

function defaultLockManager() {
  try { return globalThis.navigator?.locks || null; } catch { return null; }
}

function id(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,96}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function randomId(prefix) {
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure production run identity generation is unavailable');
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function cleanCardId(value) {
  if (value === '') return '';
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{3,64}$/.test(value)) throw new Error('Expected card ID is invalid');
  return value;
}

function validate(run, { allowGenerationZero = false } = {}) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error('Production run is invalid');
  for (const key of Object.keys(run)) {
    if (FORBIDDEN_KEY.test(key) || !SAFE_KEYS.includes(key)) throw new Error(`Production run field ${key} is not persistable or unsupported`);
  }
  if (run.version !== 1) throw new Error('Production run version is unsupported');
  id(run.runId, 'Run ID');
  id(run.flowId, 'Flow ID');
  if (!/^[a-f0-9]{64}$/.test(run.jobDigest || '')) throw new Error('Production run job digest is invalid');
  cleanCardId(run.expectedCardId);
  id(run.operationId, 'Operation ID');
  if (!STATE_SET.has(run.state)) throw new Error('Production run state is invalid');
  if (!Number.isSafeInteger(run.generation) || run.generation < (allowGenerationZero ? 0 : 1)) throw new Error('Production run generation is invalid');
  for (const field of ['createdAt', 'updatedAt']) if (!Number.isFinite(run[field]) || run[field] < 0) throw new Error(`Production run ${field} is invalid`);
  if (!Number.isFinite(run.expiresAt) || run.expiresAt !== run.createdAt + PRODUCTION_RUN_TTL_MS) throw new Error('Production run expiry is invalid');
  if (typeof run.supportCode !== 'string' || !/^[A-Z0-9-]{0,48}$/.test(run.supportCode)) throw new Error('Production run support code is not persistable');
  if (typeof run.cardChanged !== 'boolean' || typeof run.usbReleased !== 'boolean') throw new Error('Production run recovery flags are invalid');
  if (typeof run.recoveryAction !== 'string' || (run.recoveryAction && !(run.recoveryAction in RECOVERY_RULES))) throw new Error('Production run recovery action is invalid');
  if (typeof run.recoveryReturnState !== 'string' || (run.recoveryReturnState && !STATE_SET.has(run.recoveryReturnState))) throw new Error('Production run recovery return state is invalid');
  if (run.state === 'recovery') {
    if (!run.recoveryAction || run.recoveryReturnState !== RECOVERY_RULES[run.recoveryAction]?.target) throw new Error('Production run recovery evidence is invalid');
  } else if (run.recoveryAction || run.recoveryReturnState) throw new Error('Production run recovery evidence is invalid outside recovery');
  if (CARD_REQUIRED_STATES.has(run.state) && !run.expectedCardId) throw new Error(`Production run ${run.state} requires an expected card`);
  return run;
}

export function createProductionRun({ runId = randomId('run'), flowId = randomId('flow'), jobDigest, now = Date.now() } = {}) {
  return validate({
    version: 1,
    generation: 0,
    runId: id(runId, 'Run ID'),
    flowId: id(flowId, 'Flow ID'),
    jobDigest,
    expectedCardId: '',
    operationId: randomId('op'),
    state: 'select-job',
    createdAt: Number(now),
    updatedAt: Number(now),
    expiresAt: Number(now) + PRODUCTION_RUN_TTL_MS,
    supportCode: '',
    cardChanged: false,
    usbReleased: true,
    recoveryAction: '',
    recoveryReturnState: '',
  }, { allowGenerationZero: true });
}

function requireCorrelation(run, correlation) {
  for (const field of ['runId', 'flowId', 'jobDigest', 'operationId', 'generation']) {
    if (correlation?.[field] !== run[field]) throw new Error(`Production run correlation mismatch: ${field}`);
  }
  if (correlation?.expectedCardId !== run.expectedCardId) {
    throw new Error('Production run correlation mismatch: expected card');
  }
}

export function transitionProductionRun(run, nextState, {
  correlation,
  expectedCardId,
  supportCode = '',
  cardChanged = run?.cardChanged ?? false,
  usbReleased = run?.usbReleased ?? true,
  recoveryAction = '',
  now = Date.now(),
} = {}) {
  validate(run, { allowGenerationZero: true });
  if (Number(now) > run.expiresAt) throw new Error('Production run has expired');
  requireCorrelation(run, correlation);
  if (!STATE_SET.has(nextState)) throw new Error('Production run state is invalid');
  if (nextState === 'recovery') {
    if (run.state === 'complete') throw new Error('A completed production run cannot enter recovery');
    const rule = RECOVERY_RULES[recoveryAction];
    if (!rule) throw new Error('A typed production recovery action is required');
    if (!rule.sources.includes(run.state)) throw new Error(`Recovery action ${recoveryAction} is not valid from ${run.state}`);
  } else if (run.state === 'recovery') {
    if (nextState !== run.recoveryReturnState) throw new Error('Production recovery can return only to its evidence-valid state');
  } else if (!NEXT[run.state].includes(nextState)) throw new Error(`Invalid production run transition from ${run.state} to ${nextState}`);
  const nextCardId = expectedCardId === undefined ? run.expectedCardId : cleanCardId(expectedCardId);
  if (run.expectedCardId && nextCardId !== run.expectedCardId) throw new Error('Production run expected card cannot change');
  if (!run.expectedCardId && nextCardId && nextState !== 'inspect') throw new Error('Production run expected card must be established during inspect');
  return validate({
    ...run,
    expectedCardId: nextCardId,
    state: nextState,
    operationId: randomId('op'),
    updatedAt: Math.max(Number(now), run.updatedAt),
    supportCode: String(supportCode || '').slice(0, 48),
    cardChanged: Boolean(cardChanged),
    usbReleased: Boolean(usbReleased),
    recoveryAction: nextState === 'recovery' ? recoveryAction : '',
    recoveryReturnState: nextState === 'recovery' ? RECOVERY_RULES[recoveryAction].target : '',
  }, { allowGenerationZero: true });
}

function checksum(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function encode(run) {
  const payload = JSON.stringify(run);
  const envelope = JSON.stringify({ version: 1, checksum: checksum(payload), payload });
  if (encoder.encode(envelope).byteLength > MAX_PRODUCTION_RUN_BYTES) throw new Error('Production run exceeds the bounded persistence limit');
  return envelope;
}

function decode(value) {
  try {
    const envelope = JSON.parse(value || 'null');
    if (envelope?.version !== 1 || checksum(envelope.payload) !== envelope.checksum) return null;
    return validate(JSON.parse(envelope.payload));
  } catch { return null; }
}

function readMarker(storage, key) {
  try {
    const raw = storage.getItem(key);
    const marker = JSON.parse(raw || 'null');
    return marker?.version === 1 && ['a', 'b'].includes(marker.slot) && Number.isSafeInteger(marker.generation) ? marker : null;
  } catch { return null; }
}

function markers(storage) {
  return [
    { key: PRODUCTION_RUN_COMMIT_A_KEY, raw: storage.getItem(PRODUCTION_RUN_COMMIT_A_KEY), marker: readMarker(storage, PRODUCTION_RUN_COMMIT_A_KEY) },
    { key: PRODUCTION_RUN_COMMIT_B_KEY, raw: storage.getItem(PRODUCTION_RUN_COMMIT_B_KEY), marker: readMarker(storage, PRODUCTION_RUN_COMMIT_B_KEY) },
  ];
}

export function inspectProductionRun({ storage = defaultStorage(), now = Date.now() } = {}) {
  if (!storage?.getItem) return { run: null, recovered: false, committedGeneration: null };
  try {
    const slots = {
      a: decode(storage.getItem(PRODUCTION_RUN_SLOT_A_KEY)),
      b: decode(storage.getItem(PRODUCTION_RUN_SLOT_B_KEY)),
    };
    const markerRecords = markers(storage);
    const validMarkers = markerRecords.map(record => record.marker).filter(Boolean);
    const activeMarkers = validMarkers.filter(marker => !slots[marker.slot] || Number(now) <= slots[marker.slot].expiresAt);
    const committedGeneration = activeMarkers.reduce((highest, marker) => Math.max(highest, marker.generation), -1);
    const candidates = activeMarkers
      .map(marker => ({ marker, run: slots[marker.slot] }))
      .filter(candidate => candidate.run?.generation === candidate.marker.generation && Number(now) <= candidate.run.expiresAt)
      .sort((left, right) => right.marker.generation - left.marker.generation);
    const run = candidates[0]?.run || null;
    const invalidMarkerPresent = markerRecords.some(record => record.raw !== null && !record.marker);
    const recovered = Boolean(run) && (run.generation < committedGeneration || invalidMarkerPresent);
    if (!run) return { run: null, recovered: invalidMarkerPresent, committedGeneration: committedGeneration < 0 ? null : committedGeneration };
    return { run, recovered, committedGeneration: committedGeneration < 0 ? null : committedGeneration };
  } catch { return { run: null, recovered: false, committedGeneration: null }; }
}

export function readProductionRun(options = {}) {
  return inspectProductionRun(options).run;
}

function persist(run, storage, current) {
  const encoded = encode(run);
  const currentMarker = markers(storage).map(record => record.marker)
    .filter(marker => marker && current?.generation === marker.generation)
    .sort((left, right) => right.generation - left.generation)[0];
  const currentSlot = currentMarker?.slot;
  const slot = current ? (currentSlot === 'a' ? 'b' : 'a') : 'a';
  const slotKey = slot === 'a' ? PRODUCTION_RUN_SLOT_A_KEY : PRODUCTION_RUN_SLOT_B_KEY;
  const markerKey = slot === 'a' ? PRODUCTION_RUN_COMMIT_A_KEY : PRODUCTION_RUN_COMMIT_B_KEY;
  storage.setItem(slotKey, encoded);
  if (storage.getItem(slotKey) !== encoded) throw new Error('Production run slot verification failed');
  const marker = JSON.stringify({ version: 1, slot, generation: run.generation });
  try {
    storage.setItem(markerKey, marker);
    if (storage.getItem(markerKey) !== marker) throw new Error('Production run commit verification failed');
  } catch (error) {
    try {
      if (typeof storage.removeItem === 'function') storage.removeItem(slotKey);
      if (storage.getItem(slotKey) !== null) storage.setItem(slotKey, '{uncommitted');
    } catch { try { storage.setItem(slotKey, '{uncommitted'); } catch {} }
    throw error;
  }
  return run;
}

async function fallbackLock(storage, callback) {
  const previous = queues.get(storage) || Promise.resolve();
  const next = previous.catch(() => {}).then(callback);
  queues.set(storage, next.catch(() => {}));
  return next;
}

export async function updateProductionRunAtomically(mutator, {
  storage = defaultStorage(),
  lockManager = defaultLockManager(),
  indexedDB = globalThis.indexedDB,
  now = Date.now(),
} = {}) {
  if (!storage?.getItem || !storage?.setItem) throw new Error('Production run storage is unavailable');
  const update = () => {
    const current = readProductionRun({ storage, now });
    const candidate = mutator(current);
    if (candidate?.then) throw new Error('Production run mutation must be synchronous for atomic persistence');
    validate(candidate, { allowGenerationZero: true });
    const run = validate({ ...candidate, generation: (current?.generation || 0) + 1 });
    return persist(run, storage, current);
  };
  if (lockManager?.request) return lockManager.request('lightweaver-production-run-v1', update);
  if (indexedDB?.open) return withIndexedDbLock(indexedDB, update);
  if (typeof window !== 'undefined') throw new Error('Atomic production run coordination is unavailable in this browser');
  return fallbackLock(storage, update);
}

function withIndexedDbLock(indexedDB, callback) {
  return new Promise((resolve, reject) => {
    let db;
    let tx;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) try { tx?.abort(); } catch {}
      try { db?.close(); } catch {}
      if (error) reject(error); else resolve(result);
    };
    const timeout = setTimeout(() => finish(new Error('Production run coordinator timed out')), 2000);
    let open;
    try { open = indexedDB.open('lightweaver-production-run-v1', 1); }
    catch (error) { finish(error); return; }
    open.onblocked = () => finish(new Error('Production run coordinator database is blocked'));
    open.onupgradeneeded = () => {
      try { if (!open.result.objectStoreNames.contains('mutex')) open.result.createObjectStore('mutex'); }
      catch (error) { finish(error); }
    };
    open.onerror = () => finish(open.error || new Error('Production run coordinator could not open'));
    open.onsuccess = () => {
      if (settled) { try { open.result?.close(); } catch {} return; }
      db = open.result;
      let store;
      try {
        tx = db.transaction('mutex', 'readwrite');
        store = tx.objectStore('mutex');
      } catch (error) { finish(error); return; }
      let result;
      let failure;
      let request;
      try { request = store.get('run'); }
      catch (error) { finish(error); return; }
      request.onerror = () => { failure = request.error; try { tx.abort(); } catch {} };
      request.onsuccess = () => {
        try {
          result = callback();
          if (result?.then) throw new Error('Production run coordinator callback must be synchronous');
          store.put(randomId('fence'), 'run');
        } catch (error) { failure = error; try { tx.abort(); } catch {} }
      };
      tx.oncomplete = () => finish(null, result);
      tx.onabort = tx.onerror = () => finish(failure || tx.error || new Error('Production run coordinator failed'));
    };
  });
}
