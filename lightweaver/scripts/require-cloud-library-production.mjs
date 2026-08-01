import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE_REQUIRED = [
  'PROJECTS_DB_DATABASE_ID',
  'PROJECTS_DB_DATABASE_NAME',
  'PROJECT_BLOBS_BUCKET_NAME',
  'MAX_LIBRARY_BODY_BYTES',
  'MAX_LIBRARY_BACKUP_BYTES',
  'MAX_LIBRARY_BACKUP_REVISIONS',
];
const ACCESS_REQUIRED = ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'OWNER_EMAILS'];

export class ProductionLibraryConfigurationError extends Error {
  constructor(names) {
    super(`Cloud library production deployment is blocked. Configure: ${names.join(', ')}.`);
    this.name = 'ProductionLibraryConfigurationError';
    this.names = names;
  }
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function readProductionLibraryConfiguration(env = process.env) {
  const values = Object.fromEntries(
    [...BASE_REQUIRED, ...ACCESS_REQUIRED].map(name => [name, env[name]?.trim() || '']),
  );
  const nativeAuthReady = env.LIGHTWEAVER_NATIVE_AUTH_READY === 'confirmed';
  values.LIGHTWEAVER_NATIVE_AUTH_READY = nativeAuthReady ? 'confirmed' : 'pending';
  const invalid = BASE_REQUIRED.filter(name => !values[name]);

  if (!nativeAuthReady) {
    invalid.push(...ACCESS_REQUIRED.filter(name => !values[name]));
  }

  if (env.LIGHTWEAVER_PRODUCTION_LIBRARY_READY !== 'confirmed') {
    invalid.push('LIGHTWEAVER_PRODUCTION_LIBRARY_READY=confirmed');
  }
  if (values.PROJECTS_DB_DATABASE_ID
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(values.PROJECTS_DB_DATABASE_ID)) {
    invalid.push('PROJECTS_DB_DATABASE_ID');
  }
  if (values.PROJECTS_DB_DATABASE_NAME
    && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(values.PROJECTS_DB_DATABASE_NAME)) {
    invalid.push('PROJECTS_DB_DATABASE_NAME');
  }
  if (values.PROJECT_BLOBS_BUCKET_NAME
    && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(values.PROJECT_BLOBS_BUCKET_NAME)) {
    invalid.push('PROJECT_BLOBS_BUCKET_NAME');
  }
  if (!nativeAuthReady && values.ACCESS_AUD && !/^[0-9a-f]{64}$/i.test(values.ACCESS_AUD)) {
    invalid.push('ACCESS_AUD');
  }
  if (!nativeAuthReady && values.ACCESS_TEAM_DOMAIN) {
    try {
      const url = new URL(values.ACCESS_TEAM_DOMAIN);
      if (url.protocol !== 'https:'
        || url.pathname !== '/'
        || url.username
        || url.password
        || url.search
        || url.hash
        || !url.hostname.endsWith('.cloudflareaccess.com')) {
        invalid.push('ACCESS_TEAM_DOMAIN');
      } else {
        values.ACCESS_TEAM_DOMAIN = url.origin;
      }
    } catch {
      invalid.push('ACCESS_TEAM_DOMAIN');
    }
  }
  if (!nativeAuthReady && values.OWNER_EMAILS) {
    const emails = values.OWNER_EMAILS.split(',').map(value => value.trim().toLowerCase());
    if (emails.some(value => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) {
      invalid.push('OWNER_EMAILS');
    } else {
      values.OWNER_EMAILS = emails.join(',');
    }
  }

  if (nativeAuthReady) {
    for (const name of ACCESS_REQUIRED) values[name] = '';
  }
  for (const name of [
    'MAX_LIBRARY_BODY_BYTES',
    'MAX_LIBRARY_BACKUP_BYTES',
    'MAX_LIBRARY_BACKUP_REVISIONS',
  ]) {
    const parsed = positiveInteger(values[name]);
    if (values[name] && parsed === null) invalid.push(name);
    if (parsed !== null) values[name] = String(parsed);
  }
  if (positiveInteger(values.MAX_LIBRARY_BACKUP_BYTES) !== null
    && positiveInteger(values.MAX_LIBRARY_BODY_BYTES) !== null
    && Number(values.MAX_LIBRARY_BACKUP_BYTES) < Number(values.MAX_LIBRARY_BODY_BYTES)) {
    invalid.push('MAX_LIBRARY_BACKUP_BYTES');
  }

  if (invalid.length) throw new ProductionLibraryConfigurationError([...new Set(invalid)]);
  return values;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  try {
    readProductionLibraryConfiguration();
  } catch (error) {
    console.error(error instanceof ProductionLibraryConfigurationError
      ? error.message
      : 'Cloud library production deployment is blocked.');
    process.exitCode = 1;
  }
}
