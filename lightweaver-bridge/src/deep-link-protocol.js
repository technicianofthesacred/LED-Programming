'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OPERATIONS = Object.freeze([
  'install-current-release', 'recover-current-release', 'inspect-compatible-card', 'release-usb', 'restart-card',
]);
const RESULT_STATUSES = Object.freeze([
  'awaiting-card-acknowledgement', 'recoverable-failure', 'needs-safe-recovery', 'usb-ownership-uncertain',
]);
const CALLBACK_ORIGIN = 'https://led.mandalacodes.com';
const CALLBACK_PATH = '/';
const TARGET = 'lightweaver-controller-esp32s3';
const NONCE_TTL_MS = 300_000;
const NONCE_STORE_MAX_BYTES = 16_384;
const NONCE_STORE_MAX_RECORDS = 64;
const RESULT_STORE_MAX_BYTES = 4_096;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RECEIPT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CARD_PATTERN = /^lw-[a-f0-9]{12}$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const BUILD_PATTERN = /^[a-f0-9]{40}$/;
const LAUNCH_PATTERN = /^lightweaver:\/\/run\?operation=([a-z-]+)&nonce=([A-Za-z0-9_-]{43})&version=1$/;
const ACKNOWLEDGEMENT_PATTERN = /^lightweaver:\/\/ack\?receipt=([A-Za-z0-9_-]{43})&version=1$/;
const RETURN_CODE_PATTERN = /^LW1-([A-Za-z0-9_-]{1,900})$/;

function validateNonce(nonce) {
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) throw new TypeError('Invalid launch nonce');
  const bytes = Buffer.from(nonce, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== nonce) throw new TypeError('Invalid launch nonce');
  return nonce;
}

function parseLaunchUrl(value) {
  if (typeof value !== 'string' || value.length > 256 || value.includes('%') || value.includes('+')) throw new TypeError('Invalid launch URL');
  const match = LAUNCH_PATTERN.exec(value);
  if (!match || !OPERATIONS.includes(match[1])) throw new TypeError('Invalid launch URL');
  return Object.freeze({ operation: match[1], nonce: validateNonce(match[2]), version: 1 });
}

function validateReceipt(receipt) {
  if (typeof receipt !== 'string' || !RECEIPT_PATTERN.test(receipt)) throw new TypeError('Invalid acknowledgement receipt');
  const bytes = Buffer.from(receipt, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== receipt) throw new TypeError('Invalid acknowledgement receipt');
  return receipt;
}

function parseAcknowledgementUrl(value) {
  if (typeof value !== 'string' || value.length > 128 || value.includes('%') || value.includes('+')) throw new TypeError('Invalid acknowledgement URL');
  const match = ACKNOWLEDGEMENT_PATTERN.exec(value);
  if (!match) throw new TypeError('Invalid acknowledgement URL');
  return Object.freeze({ receipt: validateReceipt(match[1]), version: 1 });
}

function findLaunchUrlInArgv(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  const candidates = argv.filter(value => typeof value === 'string' && value.toLowerCase().startsWith('lightweaver:'));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) throw new Error('Exactly one launch URL is allowed');
  parseLaunchUrl(candidates[0]);
  return candidates[0];
}

function findProtocolUrlInArgv(argv) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');
  const candidates = argv.filter(value => typeof value === 'string' && value.toLowerCase().startsWith('lightweaver:'));
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) throw new Error('Exactly one protocol URL is allowed');
  try { parseLaunchUrl(candidates[0]); } catch (launchError) {
    try { parseAcknowledgementUrl(candidates[0]); } catch { throw launchError; }
  }
  return candidates[0];
}

function parseStore(raw, now) {
  let source;
  try { source = JSON.parse(raw); } catch { throw new Error('Nonce replay store is invalid'); }
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || Object.keys(source).sort().join(',') !== 'records,version' || source.version !== 1
    || !Array.isArray(source.records) || source.records.length > NONCE_STORE_MAX_RECORDS) {
    throw new Error('Nonce replay store is invalid');
  }
  const records = source.records.map(record => {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).sort().join(',') !== 'expiresAt,hash,operation'
      || !/^[a-f0-9]{64}$/.test(record.hash) || !OPERATIONS.includes(record.operation)
      || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0) throw new Error('Nonce replay store is invalid');
    return record;
  });
  return records.filter(record => record.expiresAt > now);
}

function createNonceStore({ userDataPath, now = Date.now } = {}) {
  if (typeof userDataPath !== 'string' || !userDataPath) throw new TypeError('A userData path is required');
  const file = path.join(userDataPath, 'launch-nonces.json');
  function readRecords(timestamp) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > NONCE_STORE_MAX_BYTES) throw new Error('Nonce replay store is too large');
      return parseStore(fs.readFileSync(file, 'utf8'), timestamp);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw new Error(`Nonce replay protection unavailable: ${error.message}`);
    }
  }
  function writeRecords(records) {
    const data = JSON.stringify({ version: 1, records });
    if (Buffer.byteLength(data) > NONCE_STORE_MAX_BYTES) throw new Error('Nonce replay protection unavailable: store is too large');
    const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
      try { fs.chmodSync(file, 0o600); } catch (error) { if (process.platform !== 'win32') throw error; }
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch {}
      throw new Error(`Nonce replay protection unavailable: ${error.message}`);
    }
  }
  return Object.freeze({
    consume(request) {
      const timestamp = now();
      if (!request || !OPERATIONS.includes(request.operation)) throw new TypeError('Invalid launch operation');
      const nonce = validateNonce(request.nonce);
      if (!Number.isSafeInteger(request.expiresAt) || request.expiresAt <= timestamp || request.expiresAt > timestamp + NONCE_TTL_MS) {
        throw new TypeError('Invalid launch expiry');
      }
      const hash = crypto.createHash('sha256').update(nonce, 'utf8').digest('hex');
      const records = readRecords(timestamp);
      if (records.some(record => record.hash === hash)) throw new Error('Launch nonce replay rejected');
      records.push({ hash, operation: request.operation, expiresAt: request.expiresAt });
      records.sort((a, b) => a.expiresAt - b.expiresAt);
      writeRecords(records.slice(-NONCE_STORE_MAX_RECORDS));
    },
  });
}

function createLaunchRouter({
  consumeNonce, deliver, now = Date.now, canAccept = () => true,
  createContext = () => crypto.randomBytes(16).toString('hex'),
} = {}) {
  if (typeof consumeNonce !== 'function' || typeof deliver !== 'function') throw new TypeError('Launch router dependencies are required');
  if (typeof canAccept !== 'function' || typeof createContext !== 'function') throw new TypeError('Launch router dependencies are required');
  let ready = false;
  let active = null;
  let claimed = false;
  function clearActive() {
    active = null;
    claimed = false;
  }
  function deliverActive() {
    if (!active) return;
    if (active.expiresAt <= now()) {
      clearActive();
      throw new Error('Queued launch request expired');
    }
    deliver(active);
  }
  function route(value) {
    const parsed = parseLaunchUrl(value);
    if (active && active.expiresAt <= now()) clearActive();
    if (active) throw new Error('Another launch request is active or pending');
    if (!canAccept(parsed)) throw new Error('Bridge is busy with another local workflow');
    const context = createContext();
    if (typeof context !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(context)) throw new Error('Invalid launch workflow context');
    active = Object.freeze({ ...parsed, expiresAt: now() + NONCE_TTL_MS, context });
    claimed = false;
    try { consumeNonce(active); } catch (error) { clearActive(); throw error; }
    if (ready) deliverActive();
    return active;
  }
  return Object.freeze({
    route,
    setReady() { ready = true; deliverActive(); },
    claim(operation) {
      if (!active || active.expiresAt <= now()) {
        const error = new Error('This website request expired. Return to Studio and try again.');
        error.code = 'launch-expired';
        throw error;
      }
      if (active.operation !== operation) throw new Error('Claimed operation does not match the pending launch');
      if (claimed) throw new Error('Launch request was already claimed');
      claimed = true;
      return active.context;
    },
    dismissExpired() {
      if (!active || active.expiresAt > now()) return false;
      clearActive();
      return true;
    },
    complete() { clearActive(); },
    get active() { return active; },
  });
}

function callbackEntries(request, result, receipt) {
  validateNonce(request?.nonce);
  if (request?.version !== 1 || !result || !RESULT_STATUSES.includes(result.status)) throw new TypeError('Invalid callback result');
  const allowed = new Set(['status', 'code', 'cardId', 'firmwareVersion', 'buildId', 'target', 'verification', 'physicalOutput', 'nonce', 'receipt', 'version']);
  if (Object.keys(result).some(key => !allowed.has(key))) throw new TypeError('Invalid callback result fields');
  const code = TOKEN_PATTERN.test(result.code || '') ? result.code : 'bridge-operation-failed';
  if (result.target !== TARGET || !['flash-verified', 'not-verified'].includes(result.verification)
    || result.physicalOutput !== 'unconfirmed') throw new TypeError('Invalid callback result');
  const success = result.status === 'awaiting-card-acknowledgement';
  const flashSuccess = success && result.verification === 'flash-verified';
  const maintenanceSuccess = success && result.verification === 'not-verified' && code === 'operation-complete';
  if (!flashSuccess && !maintenanceSuccess && success) throw new TypeError('Invalid callback result');
  if (flashSuccess && (!CARD_PATTERN.test(result.cardId || '') || !SEMVER_PATTERN.test(result.firmwareVersion || '')
    || !BUILD_PATTERN.test(result.buildId || ''))) throw new TypeError('Invalid callback identity');
  if (maintenanceSuccess && result.cardId !== undefined && !CARD_PATTERN.test(result.cardId)) throw new TypeError('Invalid callback identity');
  const entries = [['status', result.status], ['code', code]];
  if (flashSuccess) entries.push(['cardId', result.cardId], ['firmwareVersion', result.firmwareVersion], ['buildId', result.buildId]);
  else if (maintenanceSuccess && result.cardId) entries.push(['cardId', result.cardId]);
  entries.push(['target', TARGET], ['verification', result.verification], ['physicalOutput', 'unconfirmed'], ['nonce', request.nonce]);
  if (receipt !== undefined) entries.push(['receipt', validateReceipt(receipt)]);
  entries.push(['version', '1']);
  return entries;
}

function buildCallbackUrl(request, result, receipt) {
  const params = new URLSearchParams(callbackEntries(request, result, receipt));
  const url = `${CALLBACK_ORIGIN}${CALLBACK_PATH}#bridge-result?${params.toString()}`;
  if (url.length > 1024) throw new Error('Callback URL is too large');
  return url;
}

function validateCallbackUrl(value) {
  if (typeof value !== 'string' || value.length > 1024) throw new TypeError('Invalid callback URL');
  const url = new URL(value);
  if (url.origin !== CALLBACK_ORIGIN || url.pathname !== CALLBACK_PATH || url.search || !url.hash.startsWith('#bridge-result?')) throw new TypeError('Invalid callback URL');
  const params = new URLSearchParams(url.hash.slice('#bridge-result?'.length));
  const object = Object.fromEntries(params);
  if ([...params.keys()].length !== new Set(params.keys()).size) throw new TypeError('Invalid callback fields');
  const rebuilt = buildCallbackUrl({ nonce: object.nonce, version: Number(object.version) }, object, object.receipt);
  if (rebuilt !== value) throw new TypeError('Invalid callback fields');
  object.version = 1;
  return Object.freeze(object);
}

function buildReturnCode(request, result, receipt) {
  const payload = new URLSearchParams(callbackEntries(request, result, receipt)).toString();
  const encoded = Buffer.from(payload, 'utf8').toString('base64url');
  const code = `LW1-${encoded}`;
  if (code.length > 904) throw new Error('Return code is too large');
  return code;
}

function parseReturnCode(value) {
  if (typeof value !== 'string' || value.length > 904) throw new TypeError('Invalid return code');
  const match = RETURN_CODE_PATTERN.exec(value.trim());
  if (!match) throw new TypeError('Invalid return code');
  const payload = Buffer.from(match[1], 'base64url');
  if (payload.toString('base64url') !== match[1] || payload.length > 675) throw new TypeError('Invalid return code');
  const params = new URLSearchParams(payload.toString('utf8'));
  const object = Object.fromEntries(params);
  if ([...params.keys()].length !== new Set(params.keys()).size) throw new TypeError('Invalid return code');
  const rebuilt = buildReturnCode({ nonce: object.nonce, version: Number(object.version) }, object, object.receipt);
  if (rebuilt !== value.trim()) throw new TypeError('Invalid return code');
  object.version = 1;
  return Object.freeze(object);
}

function createPendingResultStore({ userDataPath, now = Date.now } = {}) {
  if (typeof userDataPath !== 'string' || !userDataPath) throw new TypeError('A userData path is required');
  const file = path.join(userDataPath, 'pending-studio-result.json');
  function remove() { try { fs.unlinkSync(file); } catch (error) { if (error?.code !== 'ENOENT') throw error; } }
  function validate(record) {
    if (!record || Object.keys(record).sort().join(',') !== 'receipt,request,result'
      || !record.request || !OPERATIONS.includes(record.request.operation)
      || Object.keys(record.request).sort().join(',') !== 'context,createdAt,expiresAt,nonce,operation,version'
      || record.request.version !== 1 || !Number.isSafeInteger(record.request.createdAt) || record.request.createdAt < 0
      || !Number.isSafeInteger(record.request.expiresAt) || record.request.expiresAt <= record.request.createdAt
      || record.request.expiresAt - record.request.createdAt > NONCE_TTL_MS
      || typeof record.request.context !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.request.context)) {
      throw new Error('Pending Studio result is invalid');
    }
    validateNonce(record.request.nonce);
    validateReceipt(record.receipt);
    buildReturnCode(record.request, record.result, record.receipt);
    return record;
  }
  function load() {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > RESULT_STORE_MAX_BYTES) throw new Error('Pending Studio result is too large');
      const parsed = validate(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (parsed.request.expiresAt <= now()) { remove(); return null; }
      return Object.freeze({ ...parsed, request: Object.freeze(parsed.request), result: Object.freeze(parsed.result) });
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new Error('Pending Studio result is invalid');
      throw error;
    }
  }
  return Object.freeze({
    load,
    save(record) {
      validate(record);
      const data = JSON.stringify(record);
      if (Buffer.byteLength(data) > RESULT_STORE_MAX_BYTES) throw new Error('Pending Studio result is too large');
      fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(temporary, data, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
        try { fs.chmodSync(file, 0o600); } catch (error) { if (process.platform !== 'win32') throw error; }
      } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
    },
    acknowledge(receipt) {
      validateReceipt(receipt);
      const record = load();
      if (!record || !crypto.timingSafeEqual(Buffer.from(record.receipt), Buffer.from(receipt))) return false;
      remove();
      return true;
    },
  });
}

function registerProtocolClient(app, { defaultApp = process.defaultApp, execPath = process.execPath, entryPath = process.argv[1] } = {}) {
  if (!app || typeof app.setAsDefaultProtocolClient !== 'function') throw new TypeError('Electron app is required');
  return defaultApp
    ? app.setAsDefaultProtocolClient('lightweaver', execPath, [path.resolve(entryPath)])
    : app.setAsDefaultProtocolClient('lightweaver');
}

function createSafeCallbackOpener({ openExternal } = {}) {
  if (typeof openExternal !== 'function') throw new TypeError('A URL opener is required');
  return Object.freeze({
    async open(request, result, receipt) {
      const callback = buildCallbackUrl(request, result, receipt);
      const validated = validateCallbackUrl(callback);
      if (buildCallbackUrl({ nonce: validated.nonce, version: validated.version }, validated, validated.receipt) !== callback) {
        throw new Error('Callback URL revalidation failed');
      }
      await openExternal(callback);
    },
  });
}

function resultMatchesOperation(operation, result) {
  if (!OPERATIONS.includes(operation) || !result || !RESULT_STATUSES.includes(result.status)) return false;
  if (result.status !== 'awaiting-card-acknowledgement') return true;
  const destructive = operation === 'install-current-release' || operation === 'recover-current-release';
  return destructive
    ? result.verification === 'flash-verified' && result.code !== 'operation-complete'
    : result.verification === 'not-verified' && result.code === 'operation-complete';
}

function createBoundedResultCoordinator({ launchRouter, openCallback, resultStore, onPersisted = () => {}, randomBytes = crypto.randomBytes, now = Date.now } = {}) {
  if (!launchRouter || typeof openCallback !== 'function' || typeof onPersisted !== 'function') throw new TypeError('Result coordinator dependencies are required');
  let pendingResult = resultStore?.load?.() ?? null;
  let deliveryPromise = null;

  function expiryError() {
    const error = new Error('The Studio return window expired; open Studio manually to continue');
    error.code = 'launch-expired';
    return error;
  }

  function clearExpired(request) {
    if (!request || request.expiresAt <= now()) {
      const expiredReceipt = pendingResult?.receipt;
      pendingResult = null;
      if (expiredReceipt) resultStore?.acknowledge?.(expiredReceipt);
      if (request) launchRouter.complete();
      throw expiryError();
    }
  }

  function deliverPending() {
    if (deliveryPromise) return deliveryPromise;
    const pending = pendingResult;
    if (!pending) return Promise.resolve(false);
    try { clearExpired(pending.request); } catch (error) { return Promise.reject(error); }
    deliveryPromise = (async () => {
      try {
        await openCallback(pending.request, pending.result, pending.receipt);
      } catch {
        const error = new Error('Could not return the result to Studio; retry without rerunning the card operation');
        error.code = 'callback-delivery-failed';
        throw error;
      }
      return Object.freeze({ state: 'return-pending', returnCode: buildReturnCode(pending.request, pending.result, pending.receipt) });
    })().finally(() => { deliveryPromise = null; });
    return deliveryPromise;
  }

  return Object.freeze({
    async complete(completedOperation, result, context) {
      const request = launchRouter.active;
      if (!request) return false;
      clearExpired(request);
      if (request.operation !== completedOperation) throw new Error('Completed operation does not match the pending launch');
      if (request.context !== context) throw new Error('Completed workflow context does not match the pending launch');
      if (pendingResult) throw new Error('A callback result is already pending delivery');
      if (!resultMatchesOperation(completedOperation, result)) throw new TypeError('Callback result does not match the pending operation');
      buildCallbackUrl(request, result);
      const receipt = randomBytes(32).toString('base64url');
      validateReceipt(receipt);
      pendingResult = Object.freeze({ request, result: Object.freeze({ ...result }), receipt });
      resultStore?.save?.(pendingResult);
      try {
        onPersisted(Object.freeze({ receipt, operation: request.operation, result: pendingResult.result }));
      } catch (error) {
        resultStore?.acknowledge?.(receipt);
        pendingResult = null;
        throw error;
      }
      return deliverPending();
    },
    retry: deliverPending,
    acknowledgementContext(receipt) {
      validateReceipt(receipt);
      if (!pendingResult || pendingResult.receipt !== receipt) return null;
      return Object.freeze({
        receipt,
        operation: pendingResult.request.operation,
        result: Object.freeze({ ...pendingResult.result }),
      });
    },
    acknowledge(receipt, beforeAcknowledge = () => true) {
      let acknowledged = false;
      if (pendingResult?.receipt === receipt) {
        if (beforeAcknowledge(Object.freeze({ receipt, operation: pendingResult.request.operation, result: pendingResult.result })) !== true) return false;
        acknowledged = resultStore?.acknowledge ? resultStore.acknowledge(receipt) : true;
        if (acknowledged) pendingResult = null;
      } else if (resultStore?.acknowledge) acknowledged = resultStore.acknowledge(receipt);
      if (acknowledged) launchRouter.complete();
      return acknowledged;
    },
    get returnCode() { return pendingResult ? buildReturnCode(pendingResult.request, pendingResult.result, pendingResult.receipt) : null; },
    get pendingContext() {
      return pendingResult ? Object.freeze({ receipt: pendingResult.receipt, operation: pendingResult.request.operation, result: pendingResult.result }) : null;
    },
    get hasPendingResult() { return pendingResult !== null; },
  });
}

module.exports = {
  CALLBACK_ORIGIN, NONCE_STORE_MAX_BYTES, NONCE_TTL_MS, OPERATIONS, RESULT_STATUSES,
  buildCallbackUrl, buildReturnCode, createBoundedResultCoordinator, createLaunchRouter, createNonceStore, createPendingResultStore,
  createSafeCallbackOpener, findLaunchUrlInArgv, findProtocolUrlInArgv, parseAcknowledgementUrl, parseLaunchUrl, parseReturnCode,
  registerProtocolClient, validateCallbackUrl, validateNonce,
};
