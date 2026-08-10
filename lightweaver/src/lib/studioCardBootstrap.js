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

  persistIdentity({
    ...expectedCard,
    ...authority.card,
    id: authority.cardId,
    address: authority.host,
    bootId: authority.bootId,
    buildId: authority.buildId,
  }, { acknowledgedAt: new Date().toISOString() });
  return authority;
}
