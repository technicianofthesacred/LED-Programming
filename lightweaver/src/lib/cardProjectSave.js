import { createCardProjectRepository } from './cardProjectRepository.js';
import { ProjectHeadConflictError } from './projectRepository.js';

function failureReason(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError') return 'cancelled';
  if (error?.status === 403 || error?.code === 'pairing-required' || error?.reason === 'pairing-required') return 'pairing-required';
  if (error instanceof ProjectHeadConflictError || error?.status === 409 || error?.code === 'head-conflict' || error?.reason === 'head-conflict') return 'head-conflict';
  if (error?.status === 507 || error?.code === 'quota-exceeded' || /(?:quota|storage is full|not enough space)/i.test(error?.message || '')) return 'quota-exceeded';
  return 'failed';
}

/**
 * The only path from a Studio gesture to a card project mutation. The caller
 * must collect the deliberate physical-pairing confirmation before invoking
 * this function; the card independently enforces that evidence when issuing
 * the short-lived capability.
 */
export async function saveProjectToCardFromGesture({
  authority,
  envelope,
  expectedHead = null,
  commissioningProof,
  repositoryFactory = createCardProjectRepository,
  signal,
  onProgress = () => {},
} = {}) {
  if (signal?.aborted) return { ok: false, reason: 'cancelled' };
  if (!authority?.issueOwnerCapability) return { ok: false, reason: 'disconnected' };
  try {
    await authority.issueOwnerCapability({ commissioningProof, expectedProjectHead: expectedHead });
    onProgress('pairing');
    if (signal?.aborted) return { ok: false, reason: 'cancelled' };
    onProgress('uploading');
    const repository = repositoryFactory({ authority });
    const saved = await repository.save(envelope, expectedHead, { signal });
    if (signal?.aborted) return { ok: false, reason: 'cancelled' };
    onProgress('verifying');
    onProgress('complete');
    return { ok: true, envelope: saved, source: repository.source || { kind: 'card', cardId: authority.cardId || '', label: `Lightweaver ${authority.cardId || 'card'}` } };
  } catch (error) {
    const reason = failureReason(error, signal);
    return {
      ok: false,
      reason,
      error,
      ...(reason === 'head-conflict' ? {
        currentHead: error?.currentHead || error?.details?.currentHead || null,
        choices: ['compare', 'keep-both', 'replace'],
      } : {}),
    };
  }
}
