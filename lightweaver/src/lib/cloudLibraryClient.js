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
  if (!isRecord(value)) return false;
  if (typeof value.email === 'string' && Boolean(value.email)) {
    return value.role === 'owner' || value.role === 'worker';
  }
  return typeof value.username === 'string'
    && Boolean(value.username)
    && typeof value.displayName === 'string'
    && Boolean(value.displayName.trim())
    && (value.role === 'owner' || value.role === 'worker' || value.role === 'customer')
    && typeof value.mustChangePassword === 'boolean';
}

function isNativeSession(value) {
  return isSession(value) && typeof value.username === 'string';
}

function isAccount(value) {
  return isRecord(value)
    && typeof value.id === 'string'
    && Boolean(value.id)
    && typeof value.username === 'string'
    && Boolean(value.username)
    && typeof value.displayName === 'string'
    && Boolean(value.displayName.trim())
    && (value.role === 'owner' || value.role === 'worker' || value.role === 'customer')
    && (value.status === 'active' || value.status === 'disabled')
    && typeof value.mustChangePassword === 'boolean'
    && typeof value.createdAt === 'string'
    && Boolean(value.createdAt)
    && typeof value.updatedAt === 'string'
    && Boolean(value.updatedAt);
}

function isDraftMetadata(value) {
  return isProjectMetadata(value)
    && typeof value.draftOfProjectId === 'string'
    && Boolean(value.draftOfProjectId)
    && typeof value.draftOwnerAccountId === 'string'
    && Boolean(value.draftOwnerAccountId)
    && typeof value.officialTitle === 'string'
    && Boolean(value.officialTitle.trim());
}

function isAssignment(value) {
  return isRecord(value)
    && typeof value.customerId === 'string'
    && Boolean(value.customerId)
    && typeof value.projectId === 'string'
    && Boolean(value.projectId)
    && typeof value.draftProjectId === 'string'
    && Boolean(value.draftProjectId)
    && typeof value.assignedAt === 'string'
    && Boolean(value.assignedAt)
    && isDraftMetadata(value.project)
    && value.project.id === value.draftProjectId
    && value.project.draftOfProjectId === value.projectId
    && value.project.draftOwnerAccountId === value.customerId;
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
    requestBaseUrl = baseUrl,
  } = {}) {
    const headers = { accept: 'application/json' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['x-lightweaver-request'] = mutationRequestId || requestId();
    }

    let response;
    try {
      response = await fetchImpl(apiUrl(requestBaseUrl, path, searchParams), {
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

    if (path === 'session' && response.status === 204) {
      throw new CloudLibraryError('unauthenticated', 'Sign in to use the online project library.', {
        status: 401,
        state: 'sign-in',
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
    async login({ username, password }) {
      const result = await send('login', {
        method: 'POST',
        body: { username, password },
        requestBaseUrl: '/api/account',
      });
      return resultField(result.payload, 'session', isNativeSession, result.status);
    },

    async getAccountSession() {
      const result = await send('session', { requestBaseUrl: '/api/account' });
      return resultField(result.payload, 'session', isNativeSession, result.status);
    },

    async changePassword(password) {
      const result = await send('password', {
        method: 'POST',
        body: { password },
        requestBaseUrl: '/api/account',
      });
      return resultField(result.payload, 'session', isNativeSession, result.status);
    },

    async logout() {
      const result = await send('logout', {
        method: 'POST',
        body: {},
        requestBaseUrl: '/api/account',
      });
      if (!isRecord(result.payload) || result.payload.loggedOut !== true) throw invalidResponse(result.status);
      return result.payload;
    },

    async getSession() {
      const result = await send('session');
      return resultField(result.payload, 'session', isSession, result.status);
    },

    async bootstrapOwner(input) {
      const result = await send('accounts/bootstrap', { method: 'POST', body: input });
      return resultField(result.payload, 'account', isAccount, result.status);
    },

    async listAccounts() {
      const result = await send('accounts');
      return resultField(result.payload, 'accounts', value => (
        Array.isArray(value) && value.every(isAccount)
      ), result.status);
    },

    async createAccount(input) {
      const result = await send('accounts', { method: 'POST', body: input });
      return resultField(result.payload, 'account', isAccount, result.status);
    },

    async resetAccountPassword(id, temporaryPassword) {
      const result = await send(`accounts/${encodeURIComponent(id)}/reset`, {
        method: 'POST',
        body: { temporaryPassword },
      });
      return resultField(result.payload, 'account', isAccount, result.status);
    },

    async setAccountStatus(id, status) {
      const result = await send(`accounts/${encodeURIComponent(id)}/status`, {
        method: 'POST',
        body: { status },
      });
      return resultField(result.payload, 'account', isAccount, result.status);
    },

    async setAccountRole(id, role) {
      const result = await send(`accounts/${encodeURIComponent(id)}/role`, {
        method: 'POST',
        body: { role },
      });
      return resultField(result.payload, 'account', isAccount, result.status);
    },

    async listAssignments(accountId) {
      const result = await send(`accounts/${encodeURIComponent(accountId)}/assignments`);
      return resultField(result.payload, 'assignments', value => (
        Array.isArray(value) && value.every(isAssignment)
      ), result.status);
    },

    async assignProject(accountId, projectId) {
      const result = await send(`accounts/${encodeURIComponent(accountId)}/assignments`, {
        method: 'POST',
        body: { projectId },
      });
      return resultField(result.payload, 'assignment', isAssignment, result.status);
    },

    async unassignProject(accountId, projectId) {
      const result = await send(`accounts/${encodeURIComponent(accountId)}/assignments/${encodeURIComponent(projectId)}`, {
        method: 'DELETE',
        body: {},
      });
      if (!isRecord(result.payload) || result.payload.unassigned !== true) throw invalidResponse(result.status);
      return result.payload;
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

    async listProjectDrafts(officialId) {
      const result = await send(`projects/${encodeURIComponent(officialId)}/drafts`);
      return resultField(result.payload, 'drafts', value => (
        Array.isArray(value) && value.every(isDraftMetadata)
      ), result.status);
    },

    async promoteDraft(draftId, { officialBaseRevision, draftBaseRevision }, { requestId: mutationRequestId } = {}) {
      const result = await send(`projects/${encodeURIComponent(draftId)}/promote`, {
        method: 'POST',
        body: { officialBaseRevision, draftBaseRevision },
        mutationRequestId,
      });
      return resultField(result.payload, 'project', isProjectMetadata, result.status);
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
