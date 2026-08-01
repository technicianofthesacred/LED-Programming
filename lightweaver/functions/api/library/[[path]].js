import { authenticateAccessRequest } from './_shared/auth.js';
import { handleLibraryRequest } from './_shared/router.js';
import { createD1R2LibraryStore } from './_shared/store.js';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function configuredMaxBytes(env) {
  const value = Number(env?.MAX_LIBRARY_BODY_BYTES);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_BYTES;
}

function configuredPositiveInteger(env, name) {
  const value = Number(env?.[name]);
  return Number.isInteger(value) && value > 0 ? value : undefined;
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
    maxBackupBytes: configuredPositiveInteger(context.env, 'MAX_LIBRARY_BACKUP_BYTES'),
    maxBackupRevisions: configuredPositiveInteger(context.env, 'MAX_LIBRARY_BACKUP_REVISIONS'),
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
