import { canPushDirectlyToCard, cardHostToUrl, readStoredCardHost } from './cardConnection.js';
import { normalizeCardVisualLook } from './cardVisualLook.js';
import { CardPushError } from './cardPushClient.js';

function isMixedContentBlocked() {
  return !canPushDirectlyToCard(typeof window !== 'undefined' ? window.location.protocol : 'https:');
}

export function buildLivePreviewControlPayload(look = {}) {
  const normalized = normalizeCardVisualLook(look);
  return {
    cancelStream: true,
    ...(look.zone ? { zone: String(look.zone) } : {}),
    patternId: normalized.patternId,
    brightness: normalized.brightness,
    speed: normalized.speed,
    hueShift: normalized.hueShift,
    hue: normalized.customHue,
    saturation: normalized.customSaturation,
    breathe: normalized.customBreathe,
    drift: normalized.customDrift,
  };
}

async function readCardZones(host, timeoutMs = 1200) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(`${cardHostToUrl(host)}/api/zones`, { signal: ctrl.signal });
    if (!response.ok) return null;
    return await response.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
}

function zoneExists(zonesPayload, zoneId = '') {
  if (!zoneId || !Array.isArray(zonesPayload?.zones)) return false;
  return zonesPayload.zones.some(zone => String(zone?.id || '') === zoneId);
}

function hasCardZones(zonesPayload) {
  return Array.isArray(zonesPayload?.zones) && zonesPayload.zones.length > 0;
}

export async function pushLivePreviewToCard(look, options = {}) {
  const host = options.host || readStoredCardHost();
  let previewLook = look;
  let previewZoneFallback = null;
  if (options.fallbackMissingZoneToAll && look?.zone) {
    try {
      const zonesPayload = await readCardZones(host, Math.min(options.timeoutMs || 2500, 1200));
      if (hasCardZones(zonesPayload) && !zoneExists(zonesPayload, String(look.zone))) {
        const { zone: requestedZone, ...fallbackLook } = look;
        previewLook = fallbackLook;
        previewZoneFallback = {
          requestedZone: String(requestedZone),
          availableZones: zonesPayload.zones.map(zone => String(zone?.id || '')).filter(Boolean),
        };
      }
    } catch {
      // If the zone probe fails, keep the original targeted request so the
      // normal connection error path can report the real card reachability issue.
    }
  }
  const url = `${cardHostToUrl(host)}/api/control`;
  const body = JSON.stringify(buildLivePreviewControlPayload(previewLook));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 2500);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new CardPushError('http', `card returned ${response.status}: ${text || 'no body'}`);
    }
    const json = await response.json().catch(() => ({ ok: true }));
    return previewZoneFallback
      ? { ...json, previewZoneFallback: true, ...previewZoneFallback }
      : json;
  } catch (error) {
    if (error instanceof CardPushError) throw error;
    if (isMixedContentBlocked()) {
      throw new CardPushError(
        'mixed-content',
        'Browser blocked the local card connection. Open the Studio from localhost or copy the config to the card page.',
        error,
      );
    }
    if (error?.name === 'AbortError') {
      throw new CardPushError('offline', `Timed out reaching ${cardHostToUrl(host)}`, error);
    }
    throw new CardPushError('offline', `Could not reach ${cardHostToUrl(host)}`, error);
  } finally {
    clearTimeout(timer);
  }
}
