export const CARD_IDENTITY_STORAGE_KEY = 'lw_card_identity_v1';

function cleanText(value, maxLength = 128) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeHost(value) {
  const text = cleanText(value, 255);
  if (!text) return '';
  try {
    return new URL(text.includes('://') ? text : `http://${text}`).hostname.toLowerCase();
  } catch {
    return text.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();
  }
}

function normalizeOutputs(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).map((item = {}) => ({
    ...(cleanText(item.id, 64) ? { id: cleanText(item.id, 64) } : {}),
    gpio: Number.isFinite(Number(item.gpio ?? item.pin)) ? Number(item.gpio ?? item.pin) : null,
    count: Math.max(0, Number(item.count ?? item.pixels) || 0),
  })).filter(item => item.gpio !== null || item.count > 0);
}

export function normalizeCardIdentity(payload = {}, host = '') {
  const source = payload && typeof payload === 'object' ? payload : {};
  const resolvedHost = normalizeHost(host || source.host || source.wifi?.ip || source.wifi?.hostname || source.piece?.hostname);
  const hostnameCandidate = cleanText(source.hostname || source.wifi?.hostname || source.piece?.hostname, 253).toLowerCase();
  const hostname = hostnameCandidate === 'lightweaver' || hostnameCandidate === 'lightweaver.local'
    ? '' : hostnameCandidate;
  const addressCandidate = cleanText(source.address || source.wifi?.ip || resolvedHost, 64);
  const address = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(addressCandidate) ? addressCandidate : '';
  const outputs = normalizeOutputs(source.outputs || source.configuredOutputs);
  const reportedPixels = Math.max(0, Number(source.pixelCount ?? source.pixels ?? source.led?.pixels) || 0);
  const outputPixels = outputs.reduce((sum, output) => sum + output.count, 0);
  const pixelCount = outputPixels || reportedPixels;
  return {
    id: cleanText(source.cardId || source.id || source.pieceId || source.piece?.cardId, 64),
    name: cleanText(source.cardName || source.name || source.pieceName || source.piece?.name, 128) || 'Lightweaver',
    firmwareVersion: cleanText(source.firmwareVersion, 48),
    buildId: cleanText(source.buildId || source.firmwareBuild || source.build, 96),
    bridgeVersion: Math.max(0, Number(source.bridgeVersion) || 0),
    host: resolvedHost,
    hostname,
    address,
    outputs,
    outputCount: outputs.length,
    pixelCount,
    gpioSummary: outputs
      .filter(output => output.gpio !== null)
      .map(output => `GPIO ${output.gpio} · ${output.count}`)
      .join(', '),
    limits: source.limits && typeof source.limits === 'object' ? { ...source.limits } : {},
  };
}

export function compareCardIdentity(expected = {}, actual = {}) {
  const expectedId = cleanText(expected?.id || expected?.cardId, 64);
  const actualId = cleanText(actual?.id || actual?.cardId, 64);
  if (!expectedId || !actualId) return { ok: false, reason: 'missing-identity' };
  if (expectedId !== actualId) return { ok: false, reason: 'wrong-card' };
  return { ok: true, reason: '' };
}

function defaultStorage() {
  try {
    return globalThis?.window?.localStorage || globalThis?.localStorage || null;
  } catch {
    return null;
  }
}

function cardIdentityError(reason, message) {
  const error = new Error(message);
  error.reason = reason;
  return error;
}

export function persistCardIdentity(identity = {}, {
  storage = defaultStorage(),
  acknowledgedAt = new Date().toISOString(),
} = {}) {
  if (!storage?.setItem || !cleanText(identity.id, 64)) return false;
  const stable = {
    version: 1,
    id: cleanText(identity.id, 64),
    name: cleanText(identity.name, 128),
    hostname: cleanText(identity.hostname, 253).toLowerCase(),
    address: /^\d{1,3}(?:\.\d{1,3}){3}$/.test(cleanText(identity.address, 64)) ? cleanText(identity.address, 64) : '',
    firmwareVersion: cleanText(identity.firmwareVersion, 48),
    buildId: cleanText(identity.buildId, 96),
    acknowledgedAt: cleanText(acknowledgedAt, 64),
  };
  try {
    storage.setItem(CARD_IDENTITY_STORAGE_KEY, JSON.stringify(stable));
    return true;
  } catch {
    return false;
  }
}

export function readPersistedCardIdentity({ storage = defaultStorage() } = {}) {
  if (!storage?.getItem) return null;
  try {
    const value = JSON.parse(storage.getItem(CARD_IDENTITY_STORAGE_KEY) || 'null');
    return value?.version === 1 && cleanText(value.id, 64) ? value : null;
  } catch {
    return null;
  }
}

export function adoptExpectedCardIdentity(identity = {}, options = {}) {
  return persistCardIdentity(identity, options);
}

export function forgetExpectedCardIdentity({ storage = defaultStorage() } = {}) {
  if (!storage?.removeItem) return false;
  try {
    storage.removeItem(CARD_IDENTITY_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function requireExpectedCardIdentity(actual = {}, {
  expected = null,
  storage = defaultStorage(),
} = {}) {
  const remembered = expected || readPersistedCardIdentity({ storage });
  if (!remembered?.id) {
    throw cardIdentityError('identity-missing', 'Pair this Lightweaver card before sending hardware commands.');
  }
  const comparison = compareCardIdentity(remembered, actual);
  if (!comparison.ok) {
    throw cardIdentityError(
      comparison.reason,
      comparison.reason === 'wrong-card'
        ? 'The card at this address is not the Lightweaver paired with this Studio.'
        : 'The card did not report a stable identity.',
    );
  }
  return actual;
}

export async function verifyExpectedCardAtHost(host, {
  fetchImpl = (...args) => fetch(...args),
  storage = defaultStorage(),
  expected = null,
  timeoutMs = 1500,
} = {}) {
  const resolvedHost = normalizeHost(host);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let lastPayload = null;
    for (const endpoint of ['firmware-info', 'status']) {
      const response = await fetchImpl(`http://${resolvedHost}/api/${endpoint}`, { signal: ctrl.signal });
      if (!response?.ok) continue;
      lastPayload = await response.json().catch(() => null);
      const identity = normalizeCardIdentity(lastPayload || {}, resolvedHost);
      if (identity.id) return requireExpectedCardIdentity(identity, { expected, storage });
    }
    throw cardIdentityError(
      lastPayload ? 'identity-missing' : 'firmware-too-old',
      'This card firmware cannot provide the stable identity required for hardware commands.',
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function guardDirectCardMutation(host, options = {}) {
  // Pure Node contract tests inject transports without a browser identity
  // store. Browser hardware paths always have window/localStorage and enforce.
  const storage = options.storage ?? defaultStorage();
  if (!storage && typeof window === 'undefined') return null;
  return verifyExpectedCardAtHost(host, { ...options, storage });
}
