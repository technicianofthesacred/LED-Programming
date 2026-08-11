import { authenticateAccessRequest } from './_shared/auth.js';
import { readSessionCookie } from './_shared/accountAuth.js';
import { createD1AccountStore } from './_shared/accountStore.js';
import { createFirmwareUpdateGrantIssuer } from './_shared/firmwareUpdateGrant.js';
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

export async function handleLibraryPagesRequest(context, options = {}) {
  const { accountStore: injectedAccountStore, ...authOptions } = options;
  const accountStore = injectedAccountStore || createD1AccountStore(context.env);
  let identity = null;
  const token = readSessionCookie(context.request);
  if (accountStore && token) {
    try {
      identity = await accountStore.authenticateSession(token);
    } catch {
      identity = null;
    }
  }
  if (!identity) {
    try {
      const accessIdentity = await authenticateAccessRequest(
        context.request,
        context.env,
        authOptions,
      );
      if (accessIdentity.role === 'owner') {
        identity = accessIdentity;
      } else if (accountStore) {
        const accounts = await accountStore.listAccounts();
        identity = accounts.some(account => account.role === 'owner') ? null : accessIdentity;
      } else {
        identity = accessIdentity;
      }
    } catch {
      identity = null;
    }
  }
  const maxBytes = configuredMaxBytes(context.env);
  const firmwareUpdateGrantIssuer = createFirmwareUpdateGrantIssuer(context.env);
  const store = createD1R2LibraryStore(context.env, {
    maxBytes,
    maxBackupBytes: configuredPositiveInteger(context.env, 'MAX_LIBRARY_BACKUP_BYTES'),
    maxBackupRevisions: configuredPositiveInteger(context.env, 'MAX_LIBRARY_BACKUP_REVISIONS'),
    requestId: crypto.randomUUID(),
  });
  return handleLibraryRequest({
    request: context.request,
    identity,
    accountStore,
    firmwareUpdateGrantIssuer,
    maxBytes,
    store,
  });
}

export function onRequest(context) {
  return handleLibraryPagesRequest(context);
}
