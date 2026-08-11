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
import { AccountStoreError } from './accountStore.js';
import {
  FirmwareUpdateGrantUnavailableError,
  FirmwareUpdateGrantValidationError,
} from './firmwareUpdateGrant.js';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const SAFE_STORE_ERRORS = {
  backup_too_large: [413, 'The project library is too large for one backup response.'],
  idempotency_conflict: [409, 'The idempotency key was already accepted.'],
  invalid_project: [400, 'The project is not a supported Lightweaver project.'],
  invalid_assignment: [400, 'Assignments require an active customer and official project.'],
  forbidden: [403, 'This library operation is not allowed.'],
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

function redirectResponse(location) {
  return new Response(null, {
    status: 302,
    headers: {
      'cache-control': 'no-store',
      location,
    },
  });
}

function sanitizedStudioReturnPath(request) {
  const url = new URL(request.url);
  const candidate = url.searchParams.get('returnTo');
  if (!candidate
    || !candidate.startsWith('/')
    || candidate.startsWith('//')
    || candidate.includes('\\')
    || /[\u0000-\u0020\u007f]/.test(candidate)
    || /%(?:0a|0d)/i.test(candidate)) return '/';
  try {
    const resolved = new URL(candidate, url.origin);
    if (resolved.origin !== url.origin) return '/';
    return `${resolved.pathname}${resolved.search}${resolved.hash}` || '/';
  } catch {
    return '/';
  }
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
  const actor = isNativeIdentity(identity)
    ? { ...identity, email: `${identity.displayName} (${identity.username})` }
    : identity;
  return { actor, idempotencyKey: requestId };
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

function isAccessIdentity(identity) {
  return identity
    && typeof identity.email === 'string'
    && typeof identity.subject === 'string'
    && (identity.role === 'owner' || identity.role === 'worker');
}

function isNativeIdentity(identity) {
  return identity
    && typeof identity.accountId === 'string'
    && typeof identity.username === 'string'
    && typeof identity.displayName === 'string'
    && typeof identity.subject === 'string'
    && typeof identity.mustChangePassword === 'boolean'
    && (identity.role === 'owner' || identity.role === 'worker' || identity.role === 'customer');
}

function isIdentity(identity) {
  return isAccessIdentity(identity) || isNativeIdentity(identity);
}

function publicSession(identity) {
  return isNativeIdentity(identity)
    ? {
        username: identity.username,
        displayName: identity.displayName,
        role: identity.role,
        mustChangePassword: identity.mustChangePassword,
      }
    : { email: identity.email, role: identity.role };
}

function requireSameOrigin(request) {
  return request.headers.get('origin') === new URL(request.url).origin;
}

export async function handleLibraryRequest({
  request,
  identity,
  store,
  accountStore,
  firmwareUpdateGrantIssuer,
  maxBytes = DEFAULT_MAX_BYTES,
  maxBackupBytes = DEFAULT_MAX_BACKUP_BYTES,
}) {
  const requestId = requestIdentifier(request);
  try {
    if (!isIdentity(identity)) {
      return errorResponse(401, 'unauthenticated', 'Authentication is required.', requestId);
    }

    const segments = parsePath(request);
    if (!segments) return errorResponse(404, 'not_found', 'The requested library route was not found.', requestId);
    const { method } = request;

    if (segments.length === 1 && segments[0] === 'session') {
      if (method !== 'GET') return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      if (isAccessIdentity(identity) && !store) {
        return errorResponse(503, 'library_unavailable', 'The project library is unavailable.', requestId);
      }
      return jsonResponse({ session: publicSession(identity) });
    }

    if (isNativeIdentity(identity) && identity.mustChangePassword) {
      return errorResponse(
        403,
        'password_change_required',
        'Change the temporary password before using the project library.',
        requestId,
      );
    }

    if (segments.length === 1 && segments[0] === 'login') {
      if (method !== 'GET') return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      return redirectResponse(sanitizedStudioReturnPath(request));
    }

    if (method !== 'GET' && method !== 'HEAD' && !requireSameOrigin(request)) {
      return errorResponse(403, 'invalid_origin', 'The request origin is not allowed.', requestId);
    }

    if (segments.length === 1 && segments[0] === 'firmware-update-grant') {
      if (method !== 'POST') {
        return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      }
      if (identity.role !== 'owner') {
        return errorResponse(403, 'forbidden', 'Only an authenticated owner may authorize firmware updates.', requestId);
      }
      if (typeof firmwareUpdateGrantIssuer !== 'function') {
        return errorResponse(503, 'update_grant_unavailable', 'Firmware update authorization is unavailable.', requestId);
      }
      const body = await readJson(request, 4096);
      if (typeof body.grantPayload !== 'string' || Object.keys(body).length !== 1) {
        throw new LibraryValidationError('invalid_request', 'An exact firmware update grant payload is required.');
      }
      return jsonResponse(await firmwareUpdateGrantIssuer(body.grantPayload, {
        studioOrigin: new URL(request.url).origin,
      }));
    }

    if (segments.length >= 1 && segments[0] === 'accounts') {
      if (!accountStore) {
        return errorResponse(503, 'account_unavailable', 'Account access is unavailable.', requestId);
      }

      if (segments.length === 2 && segments[1] === 'bootstrap') {
        if (method !== 'POST') {
          return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
        }
        if (!isAccessIdentity(identity) || identity.role !== 'owner') {
          return errorResponse(403, 'forbidden', 'Only the verified Access owner may create the first native owner.', requestId);
        }
        if (!requireSameOrigin(request)) {
          return errorResponse(403, 'invalid_origin', 'The request origin is not allowed.', requestId);
        }
        const body = await readJson(request, maxBytes);
        const account = await accountStore.bootstrapOwner({
          username: body.username,
          displayName: body.displayName,
          temporaryPassword: body.temporaryPassword,
        });
        return jsonResponse({ account }, 201);
      }

      if (!isNativeIdentity(identity) || identity.role !== 'owner') {
        return errorResponse(403, 'forbidden', 'Only a native owner may manage accounts.', requestId);
      }

      if (segments.length === 3 && segments[2] === 'assignments') {
        if (!store) {
          return errorResponse(503, 'library_unavailable', 'The project library is unavailable.', requestId);
        }
        const targetAccount = await accountStore.getAccount(segments[1]);
        if (method === 'GET') {
          return jsonResponse({
            assignments: await store.listCustomerAssignments({ targetAccount, identity }),
          });
        }
        if (method === 'POST') {
          const body = await readJson(request, maxBytes);
          const result = await store.assignCustomerProject({
            targetAccount,
            projectId: body.projectId,
            ...mutationContext(identity, requestId),
          });
          return jsonResponse({ assignment: result.assignment }, result.created ? 201 : 200);
        }
        return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      }

      if (segments.length === 4 && segments[2] === 'assignments') {
        if (method !== 'DELETE') {
          return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
        }
        if (!store) {
          return errorResponse(503, 'library_unavailable', 'The project library is unavailable.', requestId);
        }
        const targetAccount = await accountStore.getAccount(segments[1]);
        return jsonResponse(await store.unassignCustomerProject({
          targetAccount,
          projectId: segments[3],
          ...mutationContext(identity, requestId),
        }));
      }

      if (segments.length === 1) {
        if (method === 'GET') {
          return jsonResponse({ accounts: await accountStore.listAccounts() });
        }
        if (method === 'POST') {
          if (!requireSameOrigin(request)) {
            return errorResponse(403, 'invalid_origin', 'The request origin is not allowed.', requestId);
          }
          const body = await readJson(request, maxBytes);
          const account = await accountStore.createAccount({
            username: body.username,
            displayName: body.displayName,
            role: body.role,
            temporaryPassword: body.temporaryPassword,
          });
          return jsonResponse({ account }, 201);
        }
        return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      }

      if (segments.length === 3) {
        if (method !== 'POST') {
          return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
        }
        if (!requireSameOrigin(request)) {
          return errorResponse(403, 'invalid_origin', 'The request origin is not allowed.', requestId);
        }
        const id = segments[1];
        if (segments[2] === 'reset' && id === identity.accountId) {
          return errorResponse(
            409,
            'use_change_password',
            'Use Change Password for your own account.',
            requestId,
          );
        }
        const body = await readJson(request, maxBytes);
        let account;
        if (segments[2] === 'reset') {
          account = await accountStore.resetPassword({
            id,
            temporaryPassword: body.temporaryPassword,
          });
        } else if (segments[2] === 'status') {
          account = await accountStore.setAccountStatus({ id, status: body.status });
        } else if (segments[2] === 'role') {
          account = await accountStore.setAccountRole({ id, role: body.role });
        } else {
          return errorResponse(404, 'not_found', 'The requested library route was not found.', requestId);
        }
        return jsonResponse({ account });
      }

      return errorResponse(404, 'not_found', 'The requested library route was not found.', requestId);
    }

    if (!store) return errorResponse(503, 'library_unavailable', 'The project library is unavailable.', requestId);

    if (segments.length === 1 && segments[0] === 'projects') {
      if (method === 'GET') {
        const state = new URL(request.url).searchParams.get('state') || 'active';
        if (state !== 'active' && state !== 'archived') {
          throw new LibraryValidationError('invalid_request', 'Project state must be active or archived.');
        }
        return jsonResponse({ projects: await store.listProjects({ state, identity }) });
      }
      if (method === 'POST') {
        if (identity.role === 'customer') {
          return errorResponse(403, 'forbidden', 'Customers cannot create shared projects.', requestId);
        }
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
      if (identity.role === 'customer') {
        return errorResponse(403, 'forbidden', 'Customers cannot duplicate projects.', requestId);
      }
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
      if (identity.role === 'customer') {
        return errorResponse(403, 'forbidden', 'Customers cannot archive projects.', requestId);
      }
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

    if (segments.length === 3 && segments[0] === 'projects' && segments[2] === 'drafts') {
      if (method !== 'GET') return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      if (identity.role !== 'owner') {
        return errorResponse(403, 'forbidden', 'Only owners may review customer drafts.', requestId);
      }
      return jsonResponse({ drafts: await store.listProjectDrafts({ officialId: segments[1], identity }) });
    }

    if (segments.length === 3 && segments[0] === 'projects' && segments[2] === 'promote') {
      if (method !== 'POST') return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      if (identity.role !== 'owner') {
        return errorResponse(403, 'forbidden', 'Only owners may promote customer drafts.', requestId);
      }
      const body = await readJson(request, maxBytes);
      const result = await store.promoteDraft({
        draftId: segments[1],
        officialBaseRevision: validateBaseRevision(body.officialBaseRevision),
        draftBaseRevision: validateBaseRevision(body.draftBaseRevision),
        ...mutationContext(identity, requestId),
      });
      return jsonResponse({ project: result });
    }

    if (segments.length === 5
      && segments[0] === 'projects'
      && segments[2] === 'revisions'
      && segments[4] === 'restore') {
      if (method !== 'POST') return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      if (identity.role === 'customer') {
        return errorResponse(403, 'forbidden', 'Customers cannot restore project revisions.', requestId);
      }
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
      if (identity.role === 'customer') {
        return errorResponse(403, 'forbidden', 'Customers cannot access workspace assets.', requestId);
      }
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
      if (identity.role === 'customer') {
        return errorResponse(403, 'forbidden', 'Customers cannot export the shared library.', requestId);
      }
      if (method !== 'GET') return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.', requestId);
      return jsonResponse(await store.exportBackup({ identity }));
    }

    if (segments.length === 1 && segments[0] === 'restore') {
      if (identity.role === 'customer') {
        return errorResponse(403, 'forbidden', 'Customers cannot import the shared library.', requestId);
      }
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
    if (error instanceof AccountStoreError) {
      return errorResponse(error.status || 400, error.code || 'invalid_request', error.message, requestId);
    }
    if (error instanceof FirmwareUpdateGrantValidationError) {
      return errorResponse(400, 'invalid_request', error.message, requestId);
    }
    if (error instanceof FirmwareUpdateGrantUnavailableError) {
      return errorResponse(503, 'update_grant_unavailable', 'Firmware update authorization is unavailable.', requestId);
    }
    return errorResponse(500, 'internal_error', 'The project library request could not be completed.', requestId);
  }
}
