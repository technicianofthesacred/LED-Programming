export const WORKSPACE_ASSETS_VERSION = 1;
export const WORKSPACE_ASSETS_POINTER_KEY = 'lw_workspace_assets_current_v1';
export const WORKSPACE_ASSETS_SNAPSHOT_PREFIX = 'lw_workspace_assets_snapshot_v1:';

const WORKSPACE_ASSETS_FORMAT = 'lightweaver.workspace-assets';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function snapshotStorageKey() {
  const id = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${WORKSPACE_ASSETS_SNAPSHOT_PREFIX}${id}`;
}

export function readCommittedWorkspaceSnapshot(storage) {
  if (!storage) return null;
  const pointer = storage.getItem(WORKSPACE_ASSETS_POINTER_KEY);
  if (!pointer) return null;
  if (!pointer.startsWith(WORKSPACE_ASSETS_SNAPSHOT_PREFIX)) {
    throw new TypeError('Workspace asset snapshot pointer is invalid.');
  }
  const raw = storage.getItem(pointer);
  if (!raw) throw new TypeError('Committed workspace asset snapshot is missing.');
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    throw new TypeError('Committed workspace asset snapshot is not valid JSON.');
  }
  if (!isRecord(envelope)
    || envelope.format !== WORKSPACE_ASSETS_FORMAT
    || envelope.version !== WORKSPACE_ASSETS_VERSION
    || !isRecord(envelope.snapshot)
    || envelope.snapshot.version !== WORKSPACE_ASSETS_VERSION) {
    throw new TypeError('Committed workspace asset snapshot is unsupported.');
  }
  return envelope.snapshot;
}

export function commitWorkspaceSnapshot(snapshot, storage) {
  if (!storage) throw new Error('Workspace asset storage is unavailable.');
  const previousPointer = storage.getItem(WORKSPACE_ASSETS_POINTER_KEY);
  const nextPointer = snapshotStorageKey();
  const envelope = JSON.stringify({
    format: WORKSPACE_ASSETS_FORMAT,
    version: WORKSPACE_ASSETS_VERSION,
    snapshot,
  });

  storage.setItem(nextPointer, envelope);
  try {
    storage.setItem(WORKSPACE_ASSETS_POINTER_KEY, nextPointer);
  } catch (error) {
    try { storage.removeItem(nextPointer); } catch {}
    throw error;
  }
  if (previousPointer && previousPointer !== nextPointer) {
    try { storage.removeItem(previousPointer); } catch {}
  }
  return nextPointer;
}

export function updateCommittedWorkspaceSnapshot(storage, update) {
  const current = readCommittedWorkspaceSnapshot(storage);
  if (!current) return false;
  const next = update(structuredClone(current));
  commitWorkspaceSnapshot(next, storage);
  return true;
}
