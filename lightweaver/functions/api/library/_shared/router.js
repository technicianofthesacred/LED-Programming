import {
  DEFAULT_MAX_BACKUP_BYTES,
  LibraryValidationError,
  validateAssetKind,
  validateBaseRevision,
  validateMasterBackup,
  validatePortableProject,
  validateProjectTitle,
  validateWorkspaceAsset,
} from './validation.js';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const SAFE_STORE_ERRORS = {
  backup_too_large: [413, 'The project library is too large for one backup response.'],
  idempotency_conflict: [409, 'The idempotency key was already accepted.'],
  invalid_project: [400, 'The project is not a supported Lightweaver project.'],
  not_found: [404, 'The requested library record was not found.'],
  revision_conflict: [409, 'The library record changed since it was opened.'],
  revision_not_found: [404, 'The requested revision was not found.'],
};
const NO_STORE_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
};

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...NO_STORE_HEADERS, ...headers },
  });
}

function errorResponse(status, code, message, requestId) {
  return jsonResponse({
    error: {
      code,
      message: String(message).slice(0, 200),
      requestId,
    },
  }, status);
}

function requestIdentifier(request) {
  const supplied = request.headers.get('x-lightweaver-request');
  return supplied && /^[a-zA-Z0-9_-]{1,128}$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

async function readJson(request, maxBytes) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new LibraryValidationError('invalid_request', 'A JSON request body is required.', 415);
  }
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new LibraryValidationError('payload_too_large', 'The JSON payload is too large.', 413);
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new LibraryValidationError('payload_too_large', 'The JSON payload is too large.', 413);
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('object required');
    }
    return value;
  } catch {
    throw new LibraryValidationError('invalid_request', 'The request body must be a JSON object.');
  }
}

function mutationContext(identity, requestId) {
  return { actor: identity, idempotencyKey: requestId };
}

function parsePath(request) {
  const pathname = new URL(request.url).pathname;
  const prefix = '/api/library';
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  try {
    return pathname.slice(prefix.length).split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
  } catch {
    throw new LibraryValidationError('invalid_request', 'The library route is malformed.');
  }
}

function isIdentity(identity) {
  return identity
    && typeof identity.email === 'string'
    && typeof identity.subject === 'string'
    && (identity.role === 'owner' || identity.role === 'worker');
}

export async function handleLibraryRequest({
  request,
  identity,
  store,
  maxBytes = DEFAULT_MAX_BYTES,
  maxBackupBytes = DEFAULT_MAX_BACKUP_BYTES,
}) {
  const requestId = requestIdentifier(request);
  try {
    if (!isIdentity(identity)) {
      return errorResponse(401, 'unauthenticated', 'Authentication is required.', requestId);
    }
    if (!store) return errorResponse(503, 'library_unavailable', 'The project library is unavailable.', requestId);

    const segments = parsePath(request);
    if (!segments) return errorResponse(404, 'not_found', 'The requested library route was not found.', requestId);
    const { method } = request;

    if (segments.length === 1 && segments[0] === 'session') {
      if (method !== 'GET') return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      return jsonResponse({ session: { email: identity.email, role: identity.role } });
    }

    if (segments.length === 1 && segments[0] === 'projects') {
      if (method === 'GET') {
        const state = new URL(request.url).searchParams.get('state') || 'active';
        if (state !== 'active' && state !== 'archived') {
          throw new LibraryValidationError('invalid_request', 'Project state must be active or archived.');
        }
        return jsonResponse({ projects: await store.listProjects({ state, identity }) });
      }
      if (method === 'POST') {
        const body = await readJson(request, maxBytes);
        const project = validatePortableProject(body.project, { maxBytes });
        const result = await store.createProject({
          title: validateProjectTitle(body.title || project.name),
          project,
          ...mutationContext(identity, requestId),
        });
        return jsonResponse({ project: result }, 201);
      }
      return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
    }

    if (segments.length === 2 && segments[0] === 'projects') {
      const id = segments[1];
      if (method === 'GET') return jsonResponse({ project: await store.readProject({ id, identity }) });
      if (method === 'PUT') {
        const body = await readJson(request, maxBytes);
        const project = validatePortableProject(body.project, { maxBytes });
        const result = await store.updateProject({
          id,
          baseRevision: validateBaseRevision(body.baseRevision),
          title: body.title === undefined ? undefined : validateProjectTitle(body.title),
          project,
          ...mutationContext(identity, requestId),
        });
        return jsonResponse({ project: result });
      }
      if (method === 'DELETE') {
        if (identity.role !== 'owner') {
          return errorResponse(403, 'forbidden', 'Only the library owner may permanently delete projects.', requestId);
        }
        const body = await readJson(request, maxBytes);
        if (body.confirmation !== 'DELETE') {
          throw new LibraryValidationError('invalid_request', 'Explicit delete confirmation is required.');
        }
        const result = await store.deleteProject({
          id,
          baseRevision: validateBaseRevision(body.baseRevision),
          ...mutationContext(identity, requestId),
        });
        return jsonResponse(result);
      }
      return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
    }

    if (segments.length === 3 && segments[0] === 'projects' && segments[2] === 'duplicate') {
      if (method !== 'POST') return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      const body = await readJson(request, maxBytes);
      const result = await store.duplicateProject({
        id: segments[1],
        title: body.title === undefined ? undefined : validateProjectTitle(body.title),
        ...mutationContext(identity, requestId),
      });
      return jsonResponse({ project: result }, 201);
    }

    if (segments.length === 3
      && segments[0] === 'projects'
      && (segments[2] === 'archive' || segments[2] === 'unarchive')) {
      if (method !== 'POST') return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      const body = await readJson(request, maxBytes);
      const result = await store.setArchived({
        id: segments[1],
        archived: segments[2] === 'archive',
        baseRevision: validateBaseRevision(body.baseRevision),
        ...mutationContext(identity, requestId),
      });
      return jsonResponse({ project: result });
    }

    if (segments.length === 3 && segments[0] === 'projects' && segments[2] === 'revisions') {
      if (method !== 'GET') return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      return jsonResponse({ revisions: await store.listRevisions({ id: segments[1], identity }) });
    }

    if (segments.length === 5
      && segments[0] === 'projects'
      && segments[2] === 'revisions'
      && segments[4] === 'restore') {
      if (method !== 'POST') return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      const revision = Number(segments[3]);
      if (!Number.isInteger(revision) || revision < 1) {
        throw new LibraryValidationError('invalid_request', 'A valid revision number is required.');
      }
      const body = await readJson(request, maxBytes);
      const result = await store.restoreRevision({
        id: segments[1],
        revision,
        baseRevision: validateBaseRevision(body.baseRevision),
        ...mutationContext(identity, requestId),
      });
      return jsonResponse({ project: result });
    }

    if (segments.length === 2 && segments[0] === 'assets') {
      const kind = validateAssetKind(segments[1]);
      if (method === 'GET') return jsonResponse({ asset: await store.readAsset({ kind, identity }) });
      if (method === 'PUT') {
        const body = await readJson(request, maxBytes);
        const result = await store.writeAsset({
          kind,
          value: validateWorkspaceAsset(kind, body.value, { maxBytes }),
          baseRevision: validateBaseRevision(body.baseRevision),
          ...mutationContext(identity, requestId),
        });
        return jsonResponse({ asset: result });
      }
      return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
    }

    if (segments.length === 1 && segments[0] === 'backup') {
      if (method !== 'GET') return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      return jsonResponse(await store.exportBackup({ identity }));
    }

    if (segments.length === 1 && segments[0] === 'restore') {
      if (method !== 'POST') return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      const body = await readJson(request, maxBackupBytes);
      const backup = validateMasterBackup(body, {
        maxBackupBytes,
        maxEntryBytes: maxBytes,
      });
      const summary = await store.importBackup({
        backup,
        ...mutationContext(identity, requestId),
      });
      return jsonResponse({ summary });
    }

    return errorResponse(404, 'not_found', 'The requested library route was not found.', requestId);
  } catch (error) {
    if (error instanceof LibraryValidationError) {
      return errorResponse(error.status || 400, error.code || 'invalid_request', error.message, requestId);
    }
    if (Object.hasOwn(SAFE_STORE_ERRORS, error?.code)) {
      const [status, message] = SAFE_STORE_ERRORS[error.code];
      return errorResponse(status, error.code, message, requestId);
    }
    return errorResponse(500, 'internal_error', 'The project library request could not be completed.', requestId);
  }
}
