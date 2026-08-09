export const ONLINE_STUDIO_URL = 'https://led.mandalacodes.com/';
export const CARD_LOCAL_STUDIO_PATH = '/studio/';

function normalizedOrigin(value) {
  try { return new URL(String(value)).origin; } catch { return ''; }
}

export function detectRuntimeMode({
  origin = globalThis.location?.origin || '',
  secureContext = globalThis.isSecureContext === true,
} = {}) {
  const publicOrigin = normalizedOrigin(ONLINE_STUDIO_URL);
  const actualOrigin = normalizedOrigin(origin);
  const publicHttps = actualOrigin === publicOrigin && secureContext;
  return Object.freeze({
    kind: publicHttps ? 'public-https' : 'card-local',
    transport: publicHttps ? 'direct-lna' : 'local-origin',
    secureTools: publicHttps,
    onlineStudioUrl: ONLINE_STUDIO_URL,
  });
}

const SECURE_TOOL_ROUTES = Object.freeze({
  flash: '#screen=flash',
  microphone: '#screen=show&tool=microphone',
  provenance: '#screen=card&section=firmware',
});

export function onlineStudioToolUrl(tool) {
  const route = SECURE_TOOL_ROUTES[String(tool || '')];
  if (!route) throw new TypeError('Unknown secure tool route.');
  return new URL(route, ONLINE_STUDIO_URL).href;
}

export function handBackToOnlineStudio(tool, { locationRef = globalThis.location } = {}) {
  const url = onlineStudioToolUrl(tool);
  if (typeof locationRef?.assign !== 'function') throw new TypeError('Same-tab navigation is unavailable.');
  locationRef.assign(url);
  return url;
}

export function cardLocalSecureToolForHash(hash = globalThis.location?.hash || '') {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const screen = params.get('screen') || '';
  const section = params.get('section') || '';
  const tool = params.get('tool') || '';
  if (screen === 'flash' || (screen === 'card' && section === 'install')) return 'flash';
  if (screen === 'show' && tool === 'microphone') return 'microphone';
  if (screen === 'card' && section === 'firmware') return 'provenance';
  return '';
}

export function installCardSecureToolHandback({
  locationRef = globalThis.location,
  eventTarget = globalThis,
} = {}) {
  const handBackIfNeeded = () => {
    const tool = cardLocalSecureToolForHash(locationRef?.hash || '');
    if (!tool) return false;
    handBackToOnlineStudio(tool, { locationRef });
    return true;
  };
  eventTarget?.addEventListener?.('hashchange', handBackIfNeeded);
  handBackIfNeeded();
  return () => eventTarget?.removeEventListener?.('hashchange', handBackIfNeeded);
}
