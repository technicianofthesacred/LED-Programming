export const LIBRARY_BACKUP_FORMAT = 'lightweaver.library-backup';
export const LIBRARY_BACKUP_VERSION = 1;

export function createLibraryBackup({ exportedAt, projects, workspaceAssets }) {
  return {
    format: LIBRARY_BACKUP_FORMAT,
    version: LIBRARY_BACKUP_VERSION,
    exportedAt,
    projects,
    workspaceAssets,
  };
}
