export const DEFAULT_CARD_HOST = 'lightweaver.local';
export const CARD_HOST_STORAGE_KEY = 'lw_chip_card_host';
export const CARD_HOST_CHANGED_EVENT = 'lightweaver-card-host-changed';
export const CARD_HOST_FALLBACKS = ['lightweaver.local', '192.168.18.70', '192.168.4.1'];

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
      window.localStorage.setItem(CARD_HOST_STORAGE_KEY, host);
      window.dispatchEvent?.(new CustomEvent(CARD_HOST_CHANGED_EVENT, { detail: { host } }));
    } catch {
      /* quota */
    }
  }
  return host;
}

export function candidateCardHosts(preferredHost = '') {
  const preferred = normalizeCardHost(preferredHost || readStoredCardHost());
  const hosts = [preferred, ...CARD_HOST_FALLBACKS.map(normalizeCardHost)];
  return [...new Set(hosts.filter(Boolean))];
}

export async function discoverCardStatus({
  preferredHost = '',
  timeoutMs = 900,
  persist = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  const hosts = candidateCardHosts(preferredHost);
  let lastError = null;
  for (const host of hosts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${cardHostToUrl(host)}/api/status`, { signal: ctrl.signal });
      if (!response?.ok) throw new Error(`status ${response?.status || 'failed'}`);
      const status = await response.json().catch(() => ({ ok: true }));
      if (status?.ok === false) throw new Error(status.error || 'card not ok');
      if (persist) writeStoredCardHost(host);
      return {
        connected: true,
        host,
        url: cardHostToUrl(host),
        status,
      };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    connected: false,
    host: hosts[0] || DEFAULT_CARD_HOST,
    url: cardHostToUrl(hosts[0] || DEFAULT_CARD_HOST),
    error: lastError,
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
