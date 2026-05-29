// Client for pushing a runtime config from the designer to a live Lightweaver
// card. Mirrors the firmware's /api/config POST endpoint.
//
// Hostname resolution: the designer remembers the most recently used card.
// Mixed-content is a real concern when the designer runs on HTTPS (it does,
// at led.mandalacodes.com/design) - fetches to plain HTTP local hosts will
// be blocked by the browser. The client surfaces that as a typed error the
// UI handles by showing a copy-paste fallback.

import {
  canPushDirectlyToCard,
  cardHostToUrl,
  readStoredCardHost,
  writeStoredCardHost,
} from './cardConnection.js';

export function getCardHostname() {
  return readStoredCardHost();
}

export function setCardHostname(host) {
  return writeStoredCardHost(host);
}

export class CardPushError extends Error {
  constructor(reason, message, cause) {
    super(message);
    this.reason = reason; // 'mixed-content' | 'offline' | 'http' | 'unknown'
    if (cause instanceof Error) this.cause = cause;
  }
}

function isMixedContentBlocked() {
  return !canPushDirectlyToCard(typeof window !== 'undefined' ? window.location.protocol : 'https:');
}

// POST the runtime config to the card. Returns the parsed JSON echo on
// success; throws CardPushError on failure with a typed reason.
export async function pushConfigToCard(runtimePackage, options = {}) {
  const host = options.host || getCardHostname();
  const url = `${cardHostToUrl(host)}/api/config`;
  const body = JSON.stringify(runtimePackage.config || runtimePackage);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs || 6000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new CardPushError('http', `card returned ${r.status}: ${text || 'no body'}`);
    }
    return await r.json().catch(() => ({ ok: true }));
  } catch (err) {
    if (err instanceof CardPushError) throw err;
    if (isMixedContentBlocked()) {
      throw new CardPushError(
        'mixed-content',
        'Browser blocked the connection (mixed content). Use the copy-paste fallback or open the designer over plain HTTP.',
        err,
      );
    }
    if (err && err.name === 'AbortError') {
      throw new CardPushError('offline', `Timed out reaching ${cardHostToUrl(host)}`, err);
    }
    throw new CardPushError('offline', `Could not reach ${cardHostToUrl(host)}`, err);
  } finally {
    clearTimeout(timer);
  }
}
