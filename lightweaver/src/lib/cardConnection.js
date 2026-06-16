export const DEFAULT_CARD_HOST = 'lightweaver.local';
export const CARD_HOST_STORAGE_KEY = 'lw_chip_card_host';
export const CARD_HOST_HISTORY_STORAGE_KEY = 'lw_chip_card_host_history';
export const CARD_HOST_CHANGED_EVENT = 'lightweaver-card-host-changed';
export const CARD_HOST_FALLBACKS = ['lightweaver.local', '192.168.4.1'];
export const CARD_CONNECTION_MISS_LIMIT = 3;
export const CARD_HOST_HISTORY_LIMIT = 8;

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
    return normalizeCardHost(window.localStorage.getItem(CARD_HOST_STORAGE_KEY) || DEFAULT_CARD_HOST);
  } catch {
    return DEFAULT_CARD_HOST;
  }
}

export function writeStoredCardHost(rawHost = '') {
  const host = normalizeCardHost(rawHost);
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
      ? [...new Set(parsed.map(normalizeCardHost).filter(Boolean))].slice(0, CARD_HOST_HISTORY_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function rememberCardHost(rawHost = '') {
  const host = normalizeCardHost(rawHost);
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

export function candidateCardHosts(preferredHost = '') {
  const preferred = normalizeCardHost(preferredHost || readStoredCardHost());
  const history = readStoredCardHostHistory();
  const hosts = [preferred, ...history, ...CARD_HOST_FALLBACKS.map(normalizeCardHost)];
  return [...new Set(hosts.filter(Boolean))];
}

function hostFromStatus(status, fallbackHost) {
  return normalizeCardHost(
    status?.wifi?.ip ||
    status?.ip ||
    status?.network?.ip ||
    fallbackHost,
  );
}

async function probeCardStatusHost(host, { timeoutMs, persist, fetchImpl, controllers }) {
  const ctrl = new AbortController();
  controllers.push(ctrl);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${cardHostToUrl(host)}/api/status`, { signal: ctrl.signal });
    if (!response?.ok) throw new Error(`status ${response?.status || 'failed'}`);
    const status = await response.json().catch(() => ({ ok: true }));
    if (status?.ok === false) throw new Error(status.error || 'card not ok');
    const connectedHost = hostFromStatus(status, host);
    rememberCardHost(connectedHost);
    if (host !== connectedHost) rememberCardHost(host);
    if (persist) writeStoredCardHost(connectedHost);
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

export async function discoverCardStatus({
  preferredHost = '',
  timeoutMs = 900,
  persist = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  const hosts = candidateCardHosts(preferredHost);
  const controllers = [];
  try {
    const found = await Promise.any(hosts.map(host => probeCardStatusHost(host, {
      timeoutMs,
      persist,
      fetchImpl,
      controllers,
    })));
    controllers.forEach(ctrl => ctrl.abort());
    return found;
  } catch (error) {
    controllers.forEach(ctrl => ctrl.abort());
    const errors = Array.isArray(error?.errors) ? error.errors : [error];
    const lastError = errors.find(Boolean) || error;
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
      error: null,
      checkedAt: now,
      missCount: 0,
      lastConnectedAt: now,
    };
  }

  const misses = Math.max(0, Number(previous.missCount || 0)) + 1;
  const stillInGrace = Boolean(previous.connected) && misses < Math.max(1, missLimit);
  return {
    checking: false,
    connected: stillInGrace,
    reconnecting: true,
    host: fallbackHost,
    status: previous.status || null,
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
