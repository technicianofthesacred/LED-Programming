import {
  readSessionCookie,
  serializeSessionCookie,
  serializeSessionCookieRemoval,
} from '../library/_shared/accountAuth.js';
import { createD1AccountStore } from '../library/_shared/accountStore.js';

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

function errorResponse(status, code, message) {
  return jsonResponse({ error: { code, message } }, status);
}

function publicSession(identity) {
  return {
    username: identity.username,
    displayName: identity.displayName,
    role: identity.role,
    mustChangePassword: identity.mustChangePassword,
  };
}

function parsePath(request) {
  const pathname = new URL(request.url).pathname;
  const prefix = '/api/account';
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  try {
    return pathname.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
}

function requireSameOrigin(request) {
  return request.headers.get('origin') === new URL(request.url).origin;
}

async function readJson(request) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('A JSON request body is required.'), {
      code: 'invalid_request',
      status: 415,
    });
  }
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch (error) {
    if (error?.code) throw error;
    throw Object.assign(new Error('The request body must be a JSON object.'), {
      code: 'invalid_request',
      status: 400,
    });
  }
}

async function handleAccountRequest(request, accountStore) {
  const segments = parsePath(request);
  if (!segments) return errorResponse(404, 'not_found', 'The requested account route was not found.');
  if (!accountStore) return errorResponse(503, 'account_unavailable', 'Account access is unavailable.');

  if (segments.length === 1 && segments[0] === 'login') {
    if (request.method !== 'POST') {
      return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.');
    }
    if (!requireSameOrigin(request)) {
      return errorResponse(403, 'invalid_origin', 'The request origin is not allowed.');
    }
    const body = await readJson(request);
    const verified = await accountStore.verifyLogin({
      username: body.username,
      password: body.password,
    });
    const session = await accountStore.createSession(verified.identity.accountId, {
      expectedGeneration: verified.observedGeneration,
    });
    return jsonResponse({ session: publicSession(verified.identity) }, 200, {
      'set-cookie': serializeSessionCookie(session.token),
    });
  }

  if (segments.length === 1 && segments[0] === 'session') {
    if (request.method !== 'GET') {
      return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.');
    }
    const token = readSessionCookie(request);
    const identity = token ? await accountStore.authenticateSession(token) : null;
    if (!identity) return errorResponse(401, 'unauthenticated', 'Authentication is required.');
    return jsonResponse({ session: publicSession(identity) });
  }

  if (segments.length === 1 && segments[0] === 'password') {
    if (request.method !== 'POST') {
      return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.');
    }
    if (!requireSameOrigin(request)) {
      return errorResponse(403, 'invalid_origin', 'The request origin is not allowed.');
    }
    const body = await readJson(request);
    const token = readSessionCookie(request);
    const authenticated = token
      ? await accountStore.authenticateSession(token, { includeGeneration: true })
      : null;
    if (!authenticated) return errorResponse(401, 'unauthenticated', 'Authentication is required.');

    const changed = await accountStore.changePassword({
      accountId: authenticated.identity.accountId,
      newPassword: body.password,
      expectedGeneration: authenticated.observedGeneration,
    });
    const replacement = await accountStore.createSession(changed.account.id, {
      expectedGeneration: changed.observedGeneration,
    });
    return jsonResponse({ session: publicSession(changed.account) }, 200, {
      'set-cookie': serializeSessionCookie(replacement.token),
    });
  }

  if (segments.length === 1 && segments[0] === 'logout') {
    if (request.method !== 'POST') {
      return errorResponse(405, 'method_not_allowed', 'The method is not allowed for this route.');
    }
    if (!requireSameOrigin(request)) {
      return errorResponse(403, 'invalid_origin', 'The request origin is not allowed.');
    }
    await readJson(request);
    const token = readSessionCookie(request);
    if (token) await accountStore.revokeSession(token);
    return jsonResponse({ loggedOut: true }, 200, {
      'set-cookie': serializeSessionCookieRemoval(),
    });
  }

  return errorResponse(404, 'not_found', 'The requested account route was not found.');
}

export async function handleAccountPagesRequest(context, options = {}) {
  const accountStore = options.accountStore || createD1AccountStore(context.env);
  try {
    return await handleAccountRequest(context.request, accountStore);
  } catch (error) {
    if (error?.code === 'invalid_credentials') {
      return errorResponse(401, 'invalid_credentials', 'Invalid username or password.');
    }
    if (error?.code && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
      return errorResponse(error.status, error.code, error.message);
    }
    return errorResponse(500, 'internal_error', 'The account request could not be completed.');
  }
}

export function onRequest(context) {
  return handleAccountPagesRequest(context);
}
