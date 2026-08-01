import { isLibraryBackup } from './libraryBackup.js';
import { migrateProject } from './projectModel.js';

const ERROR_STATES = new Map([
  [401, 'sign-in'],
  [403, 'permission'],
  [409, 'conflict'],
]);

export class CloudLibraryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CloudLibraryError';
    this.code = code;
    this.details = { ...details };
    Object.assign(this, details);
    this.state = details.state || ERROR_STATES.get(details.status) || 'error';
  }
}

function requestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `lw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function apiUrl(baseUrl, path, searchParams) {
  const base = String(baseUrl || '/api/library').replace(/\/+$/, '');
  const suffix = path ? `/${String(path).replace(/^\/+/, '')}` : '';
  const query = searchParams ? new URLSearchParams(searchParams).toString() : '';
  return `${base}${suffix}${query ? `?${query}` : ''}`;
}

async function errorFromResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const remote = payload?.error;
  return new CloudLibraryError(
    typeof remote?.code === 'string' ? remote.code : 'request_failed',
    typeof remote?.message === 'string' ? remote.message : `Library request failed (${response.status}).`,
    {
      status: response.status,
      requestId: typeof remote?.requestId === 'string' ? remote.requestId : null,
    },
  );
}

function jsonContentType(response) {
  return (response.headers.get('content-type') || '').toLowerCase().startsWith('application/json');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isProjectMetadata(value) {
  return isRecord(value)
    && typeof value.id === 'string'
    && Boolean(value.id)
    && typeof value.title === 'string'
    && Boolean(value.title.trim())
    && typeof value.archived === 'boolean'
    && Number.isInteger(value.revision)
    && value.revision >= 1;
}

function isSession(value) {
  return isRecord(value)
    && typeof value.email === 'string'
    && Boolean(value.email)
    && (value.role === 'owner' || value.role === 'worker');
}

function isRevision(value) {
  return isRecord(value)
    && Number.isInteger(value.revision)
    && value.revision >= 1;
}

function isAsset(value) {
  return isRecord(value)
    && typeof value.kind === 'string'
    && Boolean(value.kind)
    && Number.isInteger(value.revision)
    && value.revision >= 1
    && value.value !== null
    && typeof value.value === 'object';
}

function isPortableProjectDocument(value) {
  if (!isRecord(value)) return false;
  try {
    return migrateProject(structuredClone(value)) !== null;
  } catch {
    return false;
  }
}

function invalidResponse(status, cause) {
  return new CloudLibraryError('invalid_response', 'The project library returned an invalid response.', {
    status,
    cause,
  });
}

function resultField(payload, field, predicate, status) {
  const value = isRecord(payload) ? payload[field] : undefined;
  if (!predicate(value)) throw invalidResponse(status);
  return value;
}

export function createCloudLibraryClient({
  fetchImpl = fetch,
  baseUrl = '/api/library',
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');

  async function send(path, {
    method = 'GET',
    body,
    searchParams,
    mutationRequestId,
    responseType = 'json',
  } = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['x-lightweaver-request'] = mutationRequestId || requestId();
    }

    let response;
    try {
      response = await fetchImpl(apiUrl(baseUrl, path, searchParams), {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new CloudLibraryError('network_error', 'The project library could not be reached.', {
        state: 'offline',
        cause,
      });
    }

    if (!response.ok) throw await errorFromResponse(response);
    if (!jsonContentType(response)) {
      throw invalidResponse(response.status);
    }
    let text;
    let payload;
    try {
      text = await response.text();
      payload = JSON.parse(text);
    } catch (cause) {
      throw invalidResponse(response.status, cause);
    }
    if (responseType === 'backup') {
      if (!isLibraryBackup(payload)) throw invalidResponse(response.status);
      return new Blob([text], { type: 'application/json' });
    }
    return { payload, status: response.status };
  }

  const client = {
    async getSession() {
      const result = await send('session');
      return resultField(result.payload, 'session', isSession, result.status);
    },

    async listProjects({ state = 'active' } = {}) {
      const result = await send('projects', { searchParams: { state } });
      return resultField(result.payload, 'projects', value => (
        Array.isArray(value) && value.every(isProjectMetadata)
      ), result.status);
    },

    async createProject({ title, project }, { requestId: mutationRequestId } = {}) {
      const result = await send('projects', {
        method: 'POST',
        body: { title, project },
        mutationRequestId,
      });
      return resultField(result.payload, 'project', isProjectMetadata, result.status);
    },

    async readProject(id) {
      const result = await send(`projects/${encodeURIComponent(id)}`);
      return resultField(result.payload, 'project', value => (
        isProjectMetadata(value) && isPortableProjectDocument(value.document)
      ), result.status);
    },

    async updateProject(id, { baseRevision, title, project }, { requestId: mutationRequestId } = {}) {
      const body = { baseRevision, project };
      if (title !== undefined) body.title = title;
      const result = await send(`projects/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body,
        mutationRequestId,
      });
      return resultField(result.payload, 'project', isProjectMetadata, result.status);
    },

    async duplicateProject(id, { title } = {}, { requestId: mutationRequestId } = {}) {
      const body = title === undefined ? {} : { title };
      const result = await send(`projects/${encodeURIComponent(id)}/duplicate`, {
        method: 'POST',
        body,
        mutationRequestId,
      });
      return resultField(result.payload, 'project', isProjectMetadata, result.status);
    },

    async setArchived(id, archived, { baseRevision }, { requestId: mutationRequestId } = {}) {
      const result = await send(`projects/${encodeURIComponent(id)}/${archived ? 'archive' : 'unarchive'}`, {
        method: 'POST',
        body: { baseRevision },
        mutationRequestId,
      });
      return resultField(result.payload, 'project', isProjectMetadata, result.status);
    },

    async archiveProject(id, input, options) {
      return client.setArchived(id, true, input, options);
    },

    async unarchiveProject(id, input, options) {
      return client.setArchived(id, false, input, options);
    },

    async deleteProject(id, { baseRevision, confirmation }, { requestId: mutationRequestId } = {}) {
      const result = await send(`projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { baseRevision, confirmation },
        mutationRequestId,
      });
      if (!isRecord(result.payload) || result.payload.deleted !== true) {
        throw invalidResponse(result.status);
      }
      return result.payload;
    },

    async listRevisions(id) {
      const result = await send(`projects/${encodeURIComponent(id)}/revisions`);
      return resultField(result.payload, 'revisions', value => (
        Array.isArray(value) && value.every(isRevision)
      ), result.status);
    },

    async restoreRevision(id, revision, { baseRevision }, { requestId: mutationRequestId } = {}) {
      const result = await send(`projects/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}/restore`, {
        method: 'POST',
        body: { baseRevision },
        mutationRequestId,
      });
      return resultField(result.payload, 'project', isProjectMetadata, result.status);
    },

    async readAsset(kind) {
      const result = await send(`assets/${encodeURIComponent(kind)}`);
      return resultField(result.payload, 'asset', value => (
        isAsset(value) && value.kind === kind
      ), result.status);
    },

    async writeAsset(kind, { baseRevision, value }, { requestId: mutationRequestId } = {}) {
      const result = await send(`assets/${encodeURIComponent(kind)}`, {
        method: 'PUT',
        body: { baseRevision, value },
        mutationRequestId,
      });
      return resultField(result.payload, 'asset', asset => (
        isAsset(asset) && asset.kind === kind
      ), result.status);
    },

    downloadBackup() {
      return send('backup', { responseType: 'backup' });
    },

    async restoreBackup(backup, { requestId: mutationRequestId } = {}) {
      const result = await send('restore', {
        method: 'POST',
        body: backup,
        mutationRequestId,
      });
      return resultField(result.payload, 'summary', value => (
        isRecord(value)
        && Number.isInteger(value.projectsCreated)
        && value.projectsCreated >= 0
        && Number.isInteger(value.assetsCreated)
        && value.assetsCreated >= 0
      ), result.status);
    },
  };

  client.session = client.getSession;
  client.exportBackup = client.downloadBackup;
  client.importBackup = client.restoreBackup;
  return client;
}
