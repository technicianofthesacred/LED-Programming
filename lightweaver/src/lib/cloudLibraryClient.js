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
    if (responseType === 'blob') return response.blob();
    if (!jsonContentType(response)) {
      throw new CloudLibraryError('invalid_response', 'The project library returned an invalid response.', {
        status: response.status,
      });
    }
    try {
      return await response.json();
    } catch (cause) {
      throw new CloudLibraryError('invalid_response', 'The project library returned invalid JSON.', {
        status: response.status,
        cause,
      });
    }
  }

  const client = {
    async getSession() {
      return (await send('session')).session;
    },

    async listProjects({ state = 'active' } = {}) {
      return (await send('projects', { searchParams: { state } })).projects;
    },

    async createProject({ title, project }, { requestId: mutationRequestId } = {}) {
      return (await send('projects', {
        method: 'POST',
        body: { title, project },
        mutationRequestId,
      })).project;
    },

    async readProject(id) {
      return (await send(`projects/${encodeURIComponent(id)}`)).project;
    },

    async updateProject(id, { baseRevision, title, project }, { requestId: mutationRequestId } = {}) {
      const body = { baseRevision, project };
      if (title !== undefined) body.title = title;
      return (await send(`projects/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body,
        mutationRequestId,
      })).project;
    },

    async duplicateProject(id, { title } = {}, { requestId: mutationRequestId } = {}) {
      const body = title === undefined ? {} : { title };
      return (await send(`projects/${encodeURIComponent(id)}/duplicate`, {
        method: 'POST',
        body,
        mutationRequestId,
      })).project;
    },

    async setArchived(id, archived, { baseRevision }, { requestId: mutationRequestId } = {}) {
      return (await send(`projects/${encodeURIComponent(id)}/${archived ? 'archive' : 'unarchive'}`, {
        method: 'POST',
        body: { baseRevision },
        mutationRequestId,
      })).project;
    },

    async archiveProject(id, input, options) {
      return client.setArchived(id, true, input, options);
    },

    async unarchiveProject(id, input, options) {
      return client.setArchived(id, false, input, options);
    },

    async deleteProject(id, { baseRevision, confirmation }, { requestId: mutationRequestId } = {}) {
      return send(`projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { baseRevision, confirmation },
        mutationRequestId,
      });
    },

    async listRevisions(id) {
      return (await send(`projects/${encodeURIComponent(id)}/revisions`)).revisions;
    },

    async restoreRevision(id, revision, { baseRevision }, { requestId: mutationRequestId } = {}) {
      return (await send(`projects/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}/restore`, {
        method: 'POST',
        body: { baseRevision },
        mutationRequestId,
      })).project;
    },

    async readAsset(kind) {
      return (await send(`assets/${encodeURIComponent(kind)}`)).asset;
    },

    async writeAsset(kind, { baseRevision, value }, { requestId: mutationRequestId } = {}) {
      return (await send(`assets/${encodeURIComponent(kind)}`, {
        method: 'PUT',
        body: { baseRevision, value },
        mutationRequestId,
      })).asset;
    },

    downloadBackup() {
      return send('backup', { responseType: 'blob' });
    },

    async restoreBackup(backup, { requestId: mutationRequestId } = {}) {
      return (await send('restore', {
        method: 'POST',
        body: backup,
        mutationRequestId,
      })).summary;
    },
  };

  client.session = client.getSession;
  client.exportBackup = client.downloadBackup;
  client.importBackup = client.restoreBackup;
  return client;
}
