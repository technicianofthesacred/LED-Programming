import { authenticateAccessRequest } from './_shared/auth.js';
import { handleLibraryRequest } from './_shared/router.js';
import { createD1R2LibraryStore } from './_shared/store.js';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function configuredMaxBytes(env) {
  const value = Number(env?.MAX_LIBRARY_BODY_BYTES);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_BYTES;
}

export async function handleLibraryPagesRequest(context, authOptions) {
  let identity = null;
  try {
    identity = await authenticateAccessRequest(context.request, context.env, authOptions);
  } catch {
    identity = null;
  }
  const maxBytes = configuredMaxBytes(context.env);
  const store = createD1R2LibraryStore(context.env, {
    maxBytes,
    requestId: crypto.randomUUID(),
  });
  return handleLibraryRequest({
    request: context.request,
    identity,
    maxBytes,
    store,
  });
}

export function onRequest(context) {
  return handleLibraryPagesRequest(context);
}
