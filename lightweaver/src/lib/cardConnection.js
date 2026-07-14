import { persistCardIdentity, readPersistedCardIdentity } from './cardIdentity.js';

export const DEFAULT_CARD_HOST = 'lightweaver.local';
export const CARD_HOST_STORAGE_KEY = 'lw_chip_card_host';
export const CARD_HOST_HISTORY_STORAGE_KEY = 'lw_chip_card_host_history';
export const CARD_HOST_CHANGED_EVENT = 'lightweaver-card-host-changed';
export const CARD_HOST_FALLBACKS = ['lightweaver.local', '192.168.4.1'];
export const CARD_CONNECTION_MISS_LIMIT = 3;
export const CARD_HOST_HISTORY_LIMIT = 8;
export const CARD_SPECIFIC_DISCOVERY_HEAD_START_MS = 180;

function stripProtocolAndPath(rawHost = '') {
  const value = String(rawHost || '').trim().toLowerCase();
  if (!value) return '';
  if (/^https?:\/\//.test(value)) {
    try {
      return new URL(value).host;
    } catch {
      return value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    }
  }
  return value.replace(/\/.*$/, '');
}

function isIpv4(host = '') {
  const bare = host.replace(/:\d+$/, '');
  const parts = bare.split('.');
  if (parts.length !== 4) return false;
  return parts.every(part => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function cleanLocalLabel(label = '') {
  return String(label || '')
    .replace(/\.local$/i, '')
    .replace(/[^a-z0-9-]/gi, '')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

export function normalizeCardHost(rawHost = '') {
  const host = stripProtocolAndPath(rawHost);
  if (!host) return DEFAULT_CARD_HOST;
  if (isIpv4(host)) return host;
  if (host.endsWith('.local')) {
    const label = cleanLocalLabel(host);
    return label ? `${label}.local` : DEFAULT_CARD_HOST;
  }
  if (!host.includes('.') && !host.includes(':')) {
    const label = cleanLocalLabel(host);
    return label ? `${label}.local` : DEFAULT_CARD_HOST;
  }
  return host;
}

export function cardHostToUrl(rawHost = '') {
  return `http://${normalizeCardHost(rawHost)}`;
}

// A card lives on the local network: an RFC1918 / loopback IPv4 address, or a
// `.local` mDNS name. We refuse to treat anything else (e.g. a public hostname
// supplied via the `cardHost` URL param) as a card origin, so the bridge can
// never be steered into sending privileged control/config/reboot messages to an
// attacker-controlled origin.
function isPrivateIpv4(bare = '') {
  const parts = bare.split('.');
  if (parts.length !== 4 || !parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) {
    return false;
  }
  const [a, b] = parts.map(Number);
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 127) return true;                      // loopback
  if (a === 192 && b === 168) return true;         // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 169 && b === 254) return true;         // link-local 169.254.0.0/16
  return false;
}

export function isLocalCardHost(rawHost = '') {
  const host = stripProtocolAndPath(rawHost);
  if (!host) return false;
  const bare = host.replace(/:\d+$/, '');
  if (bare === 'localhost') return true;
  if (isIpv4(bare)) return isPrivateIpv4(bare);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)*\.local$/i.test(bare);
}

export function readStoredCardHost() {
  if (typeof window === 'undefined') return DEFAULT_CARD_HOST;
  try {
    const host = normalizeCardHost(window.localStorage.getItem(CARD_HOST_STORAGE_KEY) || DEFAULT_CARD_HOST);
    return isLocalCardHost(host) ? host : DEFAULT_CARD_HOST;
  } catch {
    return DEFAULT_CARD_HOST;
  }
}

export function writeStoredCardHost(rawHost = '') {
  const host = normalizeCardHost(rawHost);
  if (!isLocalCardHost(host)) return readStoredCardHost();
  if (typeof window !== 'undefined') {
    try {
      const previous = normalizeCardHost(window.localStorage.getItem(CARD_HOST_STORAGE_KEY) || DEFAULT_CARD_HOST);
      if (previous === host) return host;
      window.localStorage.setItem(CARD_HOST_STORAGE_KEY, host);
      window.dispatchEvent?.(new CustomEvent(CARD_HOST_CHANGED_EVENT, { detail: { host } }));
    } catch {
      /* quota */
    }
  }
  return host;
}

export function readStoredCardHostHistory() {
  if (typeof window === 'undefined') return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CARD_HOST_HISTORY_STORAGE_KEY) || '[]');
    return Array.isArray(parsed)
      ? [...new Set(parsed.map(normalizeCardHost).filter(isLocalCardHost))].slice(0, CARD_HOST_HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function rememberCardHost(rawHost = '') {
  const host = normalizeCardHost(rawHost);
  if (!isLocalCardHost(host)) return readStoredCardHost();
  if (typeof window !== 'undefined') {
    try {
      const next = [host, ...readStoredCardHostHistory().filter(item => item !== host)]
        .slice(0, CARD_HOST_HISTORY_LIMIT);
      window.localStorage.setItem(CARD_HOST_HISTORY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* quota */
    }
  }
  return host;
}

function cardSpecificHosts(expectedCard = null) {
  if (!expectedCard?.id) return [];
  const normalizedHostname = expectedCard.hostname ? normalizeCardHost(expectedCard.hostname) : '';
  const hostname = isLocalCardHost(normalizedHostname) ? normalizedHostname : '';
  const normalizedAddress = expectedCard.address ? normalizeCardHost(expectedCard.address) : '';
  const address = isIpv4(normalizedAddress) && isLocalCardHost(normalizedAddress) ? normalizedAddress : '';
  return [...new Set([hostname, address].filter(Boolean))];
}

export function candidateCardHosts(preferredHost = '', expectedCard = readPersistedCardIdentity()) {
  const normalizedPreferred = normalizeCardHost(preferredHost || readStoredCardHost());
  const preferred = isLocalCardHost(normalizedPreferred) ? normalizedPreferred : DEFAULT_CARD_HOST;
  const history = readStoredCardHostHistory();
  const hosts = [
    ...cardSpecificHosts(expectedCard),
    preferred,
    ...history,
    ...CARD_HOST_FALLBACKS.map(normalizeCardHost),
  ];
  return [...new Set(hosts.filter(Boolean))];
}

function hostFromStatus(status, fallbackHost) {
  const candidate = normalizeCardHost(
    status?.wifi?.ip ||
    status?.ip ||
    status?.network?.ip ||
    fallbackHost,
  );
  return isLocalCardHost(candidate) ? candidate : normalizeCardHost(fallbackHost);
}

function statusCardId(status = {}) {
  return String(status?.cardId || status?.id || status?.pieceId || status?.piece?.cardId || '').trim();
}

async function probeCardStatusHost(host, { timeoutMs, fetchImpl, controllers, expectedCard }) {
  const ctrl = new AbortController();
  controllers.push(ctrl);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${cardHostToUrl(host)}/api/status`, { signal: ctrl.signal });
    if (!response?.ok) throw new Error(`status ${response?.status || 'failed'}`);
    const status = await response.json().catch(() => ({ ok: true }));
    if (status?.ok === false) throw new Error(status.error || 'card not ok');
    const connectedHost = hostFromStatus(status, host);
    const reportedId = statusCardId(status);
    if (expectedCard?.id && reportedId !== expectedCard.id) {
      const error = new Error(reportedId
        ? 'A different Lightweaver card answered at this address.'
        : 'This Lightweaver card did not report a stable identity.');
      error.reason = reportedId ? 'wrong-card' : 'identity-missing';
      error.discoveredResult = {
        connected: false,
        host: connectedHost,
        url: cardHostToUrl(connectedHost),
        reason: error.reason,
        detectedStatus: status,
        error,
      };
      throw error;
    }
    return {
      connected: true,
      host: connectedHost,
      url: cardHostToUrl(connectedHost),
      status,
    };
  } finally {
    clearTimeout(timer);
  }
}

function persistSelectedWinner(found, { persist, expectedCard }) {
  if (!persist || !expectedCard?.id || statusCardId(found?.status) !== expectedCard.id) return found;
  // Discovery spans network awaits. Re-read authority at commit time: a
  // successful reply for card A must not write its address after the user has
  // paired card B while A was still in flight.
  const currentExpected = readPersistedCardIdentity();
  if (!currentExpected?.id || currentExpected.id !== expectedCard.id) return found;
  const host = normalizeCardHost(found.host);
  if (!isLocalCardHost(host)) return found;
  rememberCardHost(host);
  writeStoredCardHost(host);
  if (isIpv4(host)) {
    persistCardIdentity({ ...currentExpected, address: host });
  }
  return found;
}

export async function discoverCardStatus({
  preferredHost = '',
  expectedCard = readPersistedCardIdentity(),
  timeoutMs = 900,
  persist = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  const hosts = candidateCardHosts(preferredHost, expectedCard);
  const specificHosts = cardSpecificHosts(expectedCard);
  const fallbackHosts = hosts.filter(host => !specificHosts.includes(host));
  const controllers = [];
  const priorErrors = [];
  const probe = host => probeCardStatusHost(host, {
    timeoutMs,
    fetchImpl,
    controllers,
    expectedCard,
  });
  try {
    let attempts = specificHosts.map(probe);
    if (attempts.length && fallbackHosts.length) {
      let timer;
      const firstTier = Promise.any(attempts);
      const headStart = await Promise.race([
        firstTier.then(found => ({ found }), error => ({ error })),
        new Promise(resolve => {
          timer = setTimeout(() => resolve({ fallback: true }), CARD_SPECIFIC_DISCOVERY_HEAD_START_MS);
        }),
      ]);
      clearTimeout(timer);
      if (headStart.found) {
        controllers.forEach(ctrl => ctrl.abort());
        return persistSelectedWinner(headStart.found, { persist, expectedCard });
      }
      if (headStart.error) {
        priorErrors.push(...(Array.isArray(headStart.error?.errors) ? headStart.error.errors : [headStart.error]));
      }
      // A short head start preserves the preferred route without turning two
      // stale remembered hints into a multi-second onboarding stall. If those
      // probes are merely slow (rather than failed), keep them in the race.
      attempts = headStart.fallback ? [...attempts, ...fallbackHosts.map(probe)] : fallbackHosts.map(probe);
    } else if (!attempts.length) {
      attempts = fallbackHosts.map(probe);
    }
    const found = await Promise.any(attempts);
    controllers.forEach(ctrl => ctrl.abort());
    return persistSelectedWinner(found, { persist, expectedCard });
  } catch (error) {
    controllers.forEach(ctrl => ctrl.abort());
    const failures = [
      ...priorErrors,
      ...(Array.isArray(error?.errors) ? error.errors : [error]),
    ];
    const discoveredMismatch = failures.find(item => item?.discoveredResult)?.discoveredResult;
    if (discoveredMismatch) return discoveredMismatch;
    const lastError = failures.find(Boolean) || error;
    return {
      connected: false,
      host: hosts[0] || DEFAULT_CARD_HOST,
      url: cardHostToUrl(hosts[0] || DEFAULT_CARD_HOST),
      error: lastError,
    };
  }
}

export function reduceCardConnectionState(previous = {}, result = {}, {
  now = Date.now(),
  missLimit = CARD_CONNECTION_MISS_LIMIT,
} = {}) {
  const fallbackHost = normalizeCardHost(previous.host || result.host || DEFAULT_CARD_HOST);
  if (result.connected) {
    const host = normalizeCardHost(result.host || fallbackHost);
    return {
      checking: false,
      connected: true,
      reconnecting: false,
      host,
      status: result.status || previous.status || null,
      detectedStatus: null,
      reason: '',
      allowAdopt: Boolean(result.allowAdopt),
      error: null,
      checkedAt: now,
      missCount: 0,
      lastConnectedAt: now,
    };
  }

  const misses = Math.max(0, Number(previous.missCount || 0)) + 1;
  const identityFailure = result.reason === 'wrong-card' || result.reason === 'identity-missing';
  const stillInGrace = !identityFailure && Boolean(previous.connected) && misses < Math.max(1, missLimit);
  return {
    checking: false,
    connected: stillInGrace,
    reconnecting: true,
    host: fallbackHost,
    status: previous.status || null,
    detectedStatus: result.detectedStatus || previous.detectedStatus || null,
    reason: result.reason || previous.reason || '',
    allowAdopt: false,
    error: result.error || previous.error || null,
    checkedAt: now,
    missCount: misses,
    lastConnectedAt: previous.lastConnectedAt || 0,
  };
}

export function canPushDirectlyToCard(protocol = '') {
  const currentProtocol = protocol || (typeof window !== 'undefined' ? window.location.protocol : '');
  return currentProtocol === 'http:' || currentProtocol === 'file:';
}

export function cardLoadMethodForProtocol(protocol = '') {
  if (canPushDirectlyToCard(protocol)) {
    return {
      mode: 'local-direct',
      directPush: true,
      label: 'Direct push available',
    };
  }
  return {
    mode: 'copy-download',
    directPush: false,
    label: 'Copy or download',
  };
}
