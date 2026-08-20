import { candidateCardHosts, readStoredCardHost } from './cardConnection.js';
import { readPersistedCardIdentity, persistCardIdentity } from './cardIdentity.js';
import { bootstrapCardLink, isCardLinkConnected } from './cardLink.js';
import { connectCardTransport } from './cardTransport.js';

// Restore the exact card Studio already paired with. Bridge handoffs retain
// priority; ordinary public-Studio reloads use one read-only local status GET.
export async function bootstrapStudioCardConnection({
  bootstrapLink = bootstrapCardLink,
  connectTransport = connectCardTransport,
  readIdentity = readPersistedCardIdentity,
  readHost = readStoredCardHost,
  candidateHosts = candidateCardHosts,
  persistIdentity = persistCardIdentity,
  isConnected = isCardLinkConnected,
} = {}) {
  const bridgeState = await bootstrapLink();
  if (isConnected(bridgeState)) return bridgeState;

  const expectedCard = readIdentity();
  if (!expectedCard?.id) return bridgeState;

  const hosts = candidateHosts(readHost(), expectedCard);
  let authority = null;
  for (const host of hosts) {
    authority = await connectTransport({ host, expectedCardId: expectedCard.id });
    if (authority?.connected) break;
  }
  if (!authority?.connected) return bridgeState;

  // Restoring a pairing refreshes where the card is and which boot answered.
  // It must NOT re-learn the card's FIRMWARE identity. A remembered build that
  // no longer matches the live one is the signal that the owner reflashed this
  // card (ui-repair B1), and the connection center exists to offer "keep the
  // new firmware" rather than silently adopt it — which is only possible while
  // Studio still remembers what it paired with. The previous
  // `buildId: authority.buildId` read a field a transport authority has never
  // published (createTransportAuthority exposes host/cardId/bootId, no build),
  // so every reload persisted an empty build and permanently disarmed that
  // detection.
  persistIdentity({
    ...expectedCard,
    ...authority.card,
    id: authority.cardId,
    address: authority.host,
    bootId: authority.bootId,
    firmwareVersion: expectedCard.firmwareVersion || authority.card?.firmwareVersion || '',
    buildId: expectedCard.buildId || authority.card?.buildId || '',
  }, { acknowledgedAt: new Date().toISOString() });
  return authority;
}
