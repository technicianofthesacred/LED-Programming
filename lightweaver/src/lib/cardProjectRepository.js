import { canonicalProjectJson, ProjectHeadConflictError, sha256Canonical, validateProjectEnvelope } from './projectRepository.js';

export const CARD_PROJECT_MAX_CHUNK_BYTES = 2048;

function abortError() {
  const error = new Error('Project upload was cancelled.');
  error.name = 'AbortError';
  return error;
}

function requireCapability(authority) {
  const capability = String(authority?.ownerCapability || '').trim();
  if (!capability) throw new Error('A current owner capability is required to change projects on this card.');
  return capability;
}

function base64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function queryId(projectId) {
  return encodeURIComponent(String(projectId));
}

function ownerHeaders(authority, capability, expectedHead = authority.ownerCapabilityExpectedHead) {
  return {
    'X-Lightweaver-Card-Id': String(authority.cardId || ''),
    'X-Lightweaver-Boot-Id': String(authority.bootId || ''),
    'X-Lightweaver-Owner-Session': String(authority.ownerSessionId || ''),
    'X-Lightweaver-Operation-Generation': String(authority.operationGeneration || 0),
    'X-Lightweaver-Expected-Head': String(expectedHead || ''),
    'X-Lightweaver-Capability': capability,
  };
}

function mutationBinding(authority, capability, expectedHead) {
  return {
    cardId: String(authority.cardId || ''),
    bootId: String(authority.bootId || ''),
    ownerSessionId: String(authority.ownerSessionId || ''),
    operationGeneration: Number(authority.operationGeneration || 0),
    expectedHead: expectedHead || '',
    capability,
  };
}

export function createCardProjectRepository({ authority, maxChunkBytes = CARD_PROJECT_MAX_CHUNK_BYTES } = {}) {
  if (!authority?.request) throw new TypeError('A verified card transport authority is required.');
  const source = Object.freeze({ kind: 'card', cardId: authority.cardId || '', label: `Lightweaver ${authority.cardId || 'card'}` });
  return Object.freeze({
    source,
    async list() {
      const capability = requireCapability(authority);
      const result = await authority.request('/api/projects/list', { headers: ownerHeaders(authority, capability) });
      return Array.isArray(result) ? result : (result?.projects || []);
    },
    async read(projectId) {
      const capability = requireCapability(authority);
      const result = await authority.request(`/api/projects/read?id=${queryId(projectId)}`, { headers: ownerHeaders(authority, capability) });
      return result ? validateProjectEnvelope(result.envelope || result) : null;
    },
    async save(envelope, expectedHead = null, { signal } = {}) {
      const capability = requireCapability(authority);
      if ((authority.ownerCapabilityExpectedHead || null) !== (expectedHead || null)) {
        throw new Error('Owner capability is bound to a different project head. Pair again before saving.');
      }
      const headers = ownerHeaders(authority, capability, expectedHead);
      const binding = mutationBinding(authority, capability, expectedHead);
      if (signal?.aborted) throw abortError();
      const valid = validateProjectEnvelope(envelope);
      const bytes = new TextEncoder().encode(canonicalProjectJson(valid));
      const transferHash = sha256Canonical(valid);
      const preflight = await authority.request('/api/projects/preflight', {
        method: 'POST',
        body: {
          ...binding,
          projectId: valid.projectId,
          totalBytes: bytes.byteLength,
          contentHash: valid.contentHash,
          transferHash,
          expectedHead,
        }, headers,
      });
      if (preflight?.ok === false) {
        const error = new Error(preflight.message || 'The card cannot safely store this project.');
        error.code = preflight.reason || 'preflight-failed';
        throw error;
      }
      if (signal?.aborted) throw abortError();
      const requestedChunk = Number(preflight?.chunkSize) || maxChunkBytes;
      const chunkSize = Math.max(1, Math.min(maxChunkBytes, requestedChunk));
      const begun = await authority.request('/api/projects/begin', {
        method: 'POST',
        body: {
          ...binding,
          projectId: valid.projectId,
          totalBytes: bytes.byteLength,
          chunkSize,
          contentHash: valid.contentHash,
          transferHash,
          expectedHead,
        }, headers,
      });
      if (begun?.ok === false) throw new Error(begun.error || 'The card did not start the project upload.');
      for (let offset = 0, index = 0; offset < bytes.byteLength; offset += chunkSize, index++) {
        if (signal?.aborted) throw abortError();
        const chunk = bytes.slice(offset, Math.min(bytes.byteLength, offset + chunkSize));
        await authority.request('/api/projects/chunk', {
          method: 'POST',
          headers,
          body: { ...binding, projectId: valid.projectId, chunkIndex: index, data: base64(chunk) },
        });
      }
      if (signal?.aborted) throw abortError();
      const committed = await authority.request('/api/projects/commit', {
        method: 'POST',
        headers,
        body: { ...binding, projectId: valid.projectId, contentHash: valid.contentHash, transferHash },
      });
      if (committed?.head && committed.head !== valid.contentHash) throw new Error('Card project head did not match the uploaded project.');
      if (committed?.capabilityHeadAdvanced === false) throw new Error('The card saved the project but the editing permission expired. Pair again before continuing.');
      authority.advanceOwnerCapabilityHead?.(committed?.head || valid.contentHash);
      const readbackHeaders = ownerHeaders(authority, requireCapability(authority), committed?.head || valid.contentHash);
      const readback = await authority.request(`/api/projects/read?id=${queryId(valid.projectId)}`, { headers: readbackHeaders });
      const verified = validateProjectEnvelope(readback?.envelope || readback);
      if (verified.contentHash !== valid.contentHash) throw new Error('Card project readback hash did not match.');
      return verified;
    },
    async remove(projectId, expectedHead) {
      const ownerCapability = requireCapability(authority);
      if ((authority.ownerCapabilityExpectedHead || null) !== (expectedHead || null)) {
        throw new Error('Owner capability is bound to a different project head. Pair again before deleting.');
      }
      const headers = ownerHeaders(authority, ownerCapability, expectedHead);
      const result = await authority.request('/api/projects/delete', {
        method: 'POST', headers,
        body: { ...mutationBinding(authority, ownerCapability, expectedHead), projectId: String(projectId) },
      });
      if (result?.reason === 'head-conflict') throw new ProjectHeadConflictError(result.currentHead || null);
      return result;
    },
    watch(listener) { return authority.watch?.(listener) || (() => {}); },
  });
}
