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
    patternId: normalized.patternId,
    brightness: normalized.brightness,
    hue: normalized.customHue,
    saturation: normalized.customSaturation,
    breathe: normalized.customBreathe,
    drift: normalized.customDrift,
  };
}

export async function pushLivePreviewToCard(look, options = {}) {
  const host = options.host || readStoredCardHost();
  const url = `${cardHostToUrl(host)}/api/control`;
  const body = JSON.stringify(buildLivePreviewControlPayload(look));
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
    return await response.json().catch(() => ({ ok: true }));
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
