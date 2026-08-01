export const LIBRARY_BACKUP_FORMAT = 'lightweaver.library-backup';
export const LIBRARY_BACKUP_VERSION = 1;
export const LIBRARY_BACKUP_EXTENSION = '.lw-library.json';

export function canonicalLibraryBackupFileName(date = new Date()) {
  const value = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  if (!Number.isFinite(value.getTime())) throw new TypeError('A valid date is required for a library backup name.');
  return `${value.toISOString().slice(0, 10)}-lightweaver-master${LIBRARY_BACKUP_EXTENSION}`;
}

export function isLibraryBackup(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && value.format === LIBRARY_BACKUP_FORMAT
    && value.version === LIBRARY_BACKUP_VERSION
    && typeof value.exportedAt === 'string'
    && Number.isFinite(Date.parse(value.exportedAt))
    && Array.isArray(value.projects)
    && Array.isArray(value.workspaceAssets);
}
