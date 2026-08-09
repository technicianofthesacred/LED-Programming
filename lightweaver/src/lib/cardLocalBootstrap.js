import { CARD_TRANSPORTS, connectCardTransport } from './cardTransport.js';
import { createCardProjectRepository } from './cardProjectRepository.js';

export async function bootstrapCardLocalAuthority({
  host = globalThis.location?.hostname || '',
  connectImpl = connectCardTransport,
} = {}) {
  const authority = await connectImpl({
    host,
    expectedCardId: '',
    transport: CARD_TRANSPORTS.LOCAL,
  });
  if (!authority?.connected || authority.transport !== CARD_TRANSPORTS.LOCAL) {
    throw new Error(authority?.reason || 'card-local-authority-unavailable');
  }
  return authority;
}

export async function authorizeCardLocalProject({
  authority,
  repositoryFactory = createCardProjectRepository,
} = {}) {
  if (!authority?.issueOwnerCapability) throw new TypeError('Card-local authority is required.');
  await authority.issueOwnerCapability({
    commissioningProof: 'card-local-physical-confirmation',
    expectedProjectHead: authority.projectHead || '',
  });
  const repository = repositoryFactory({ authority });
  const projects = await repository.list();
  const current = projects.find(project => project?.head === (authority.projectHead || '')) || projects[0] || null;
  const envelope = current?.projectId ? await repository.read(current.projectId) : null;
  return Object.freeze({ repository, envelope });
}
