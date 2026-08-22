// "Pair this card" must mean the same thing wherever the owner presses it.
//
// The pairing sequence used to live only inside the Connection Center, so the
// Setup screen's own primary button could do nothing but open that panel and
// ask for the same click again under a second vocabulary. Owners reported
// that as the flow's worst step: a screen that has already found the card,
// whose "Pair this card" only produces another window saying a card was
// found. This module is the one sequence; both surfaces call it.

import {
  adoptDiscoveredCardBridgeIdentity,
  getCardBridgeState,
  rePairDiscoveredCardBridgeIdentity,
} from './cardBridge.js';
import { normalizeCardHost, readStoredCardHost } from './cardConnection.js';
import { readPersistedCardIdentity } from './cardIdentity.js';
import { adoptDiscoveredDirectCard } from './cardLink.js';

export const PAIR_STALE_HOST = 'stale-host';

// Resolves rather than throws: every caller renders the failure, and a thrown
// rejection crossing two screens was how one of them ended up silent.
export async function pairDiscoveredCard(link = {}, {
  adoptDirect = adoptDiscoveredDirectCard,
  adoptBridge = adoptDiscoveredCardBridgeIdentity,
  rePairBridge = rePairDiscoveredCardBridgeIdentity,
  readIdentity = readPersistedCardIdentity,
} = {}) {
  try {
    if (link.transport === 'direct' && link.discoveredCard?.id) {
      await adoptDirect();
    } else if (readIdentity()?.id) {
      await rePairBridge(link.host);
    } else {
      await adoptBridge(link.host);
    }
    return { ok: true };
  } catch (error) {
    if (error?.reason === PAIR_STALE_HOST) {
      return {
        ok: false,
        reason: PAIR_STALE_HOST,
        takeoverHost: normalizeCardHost(getCardBridgeState().host || link.host || readStoredCardHost()),
        message: 'Studio found the card through an earlier connection. Take over that connection to use the card in this Studio.',
      };
    }
    return {
      ok: false,
      reason: 'failed',
      takeoverHost: '',
      message: error?.message || 'Studio could not pair this card.',
    };
  }
}
