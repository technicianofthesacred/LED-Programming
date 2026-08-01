import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { createCloudLibraryClient, CloudLibraryError } from '../lib/cloudLibraryClient.js';
import { canonicalLibraryBackupFileName, isLibraryBackup } from '../lib/libraryBackup.js';
import { downloadJsonFile, downloadTextFile } from '../lib/downloadFile.js';
import { canonicalProjectFileName } from '../lib/projectFiles.js';
import { createProjectId, migrateProject } from '../lib/projectModel.js';
import { listProjectLibraryRecords } from '../lib/projectStorage.js';
import {
  WORKSPACE_ASSETS_EVENT,
  WORKSPACE_ASSETS_VERSION,
  readWorkspaceAssets,
  writeWorkspaceAssets,
} from '../lib/workspaceAssets.js';
import { useProject } from './ProjectContext.jsx';

const ACTIVE_REMOTE_KEY = 'lw_cloud_active_project_v1';
const BROWSER_CLAIMS_KEY = 'lw_cloud_claimed_browser_projects_v1';
const WORKSPACE_ASSET_HEADS_KEY = 'lw_cloud_workspace_asset_heads_v1';
const CLOUD_SAVE_DEBOUNCE_MS = 900;
const CLOUD_RETRY_MS = 2500;
const WORKSPACE_ASSET_DEBOUNCE_MS = 220;
const WORKSPACE_ASSET_KINDS = ['custom-patterns', 'pattern-lab-drafts'];

const CloudLibraryContext = createContext(null);

function canUseWorkspaceAssets(session) {
  return session?.status === 'authenticated'
    && !session.mustChangePassword
    && (session.role === 'owner' || session.role === 'worker');
}

function readActiveRemoteAssociation() {
  try {
    const raw = localStorage.getItem(ACTIVE_REMOTE_KEY);
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      if (value && typeof value.id === 'string' && value.id) {
        return {
          id: value.id,
          revision: Number.isInteger(value.revision) && value.revision >= 1 ? value.revision : null,
        };
      }
    } catch {
      // Migrate the original ID-only association below.
    }
    return { id: String(raw), revision: null };
  } catch {
    return null;
  }
}

function writeActiveRemoteAssociation(project) {
  try {
    if (project?.id && Number.isInteger(project.revision)) {
      localStorage.setItem(ACTIVE_REMOTE_KEY, JSON.stringify({ id: project.id, revision: project.revision }));
    }
    else localStorage.removeItem(ACTIVE_REMOTE_KEY);
  } catch {
    // Cloud association still works for this tab when storage is unavailable.
  }
}

function readClaimedBrowserProjectIds() {
  try {
    const value = JSON.parse(localStorage.getItem(BROWSER_CLAIMS_KEY) || '[]');
    return new Set(Array.isArray(value) ? value.filter(id => typeof id === 'string' && id) : []);
  } catch {
    return new Set();
  }
}

function writeClaimedBrowserProjectIds(ids) {
  try {
    localStorage.setItem(BROWSER_CLAIMS_KEY, JSON.stringify([...ids]));
  } catch {
    // Claim still succeeds online; the offer may reappear in this browser.
  }
}

function markerKey(marker) {
  return `${marker.generation}:${marker.revision}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function workspaceAssetValue(snapshot, kind) {
  if (kind === 'custom-patterns') {
    return {
      version: WORKSPACE_ASSETS_VERSION,
      customPatterns: snapshot.customPatterns,
      customPatternRevisions: snapshot.customPatternRevisions,
    };
  }
  return {
    version: WORKSPACE_ASSETS_VERSION,
    patternLabDrafts: snapshot.patternLabDrafts,
  };
}

function emptyWorkspaceAssetValue(kind) {
  return kind === 'custom-patterns'
    ? { version: WORKSPACE_ASSETS_VERSION, customPatterns: [], customPatternRevisions: {} }
    : { version: WORKSPACE_ASSETS_VERSION, patternLabDrafts: [] };
}

function defaultWorkspaceAssetHeads() {
  return Object.fromEntries(WORKSPACE_ASSET_KINDS.map(kind => [kind, {
    revision: 0,
    valueHash: canonicalJson(emptyWorkspaceAssetValue(kind)),
  }]));
}

function readWorkspaceAssetHeads() {
  try {
    const value = JSON.parse(localStorage.getItem(WORKSPACE_ASSET_HEADS_KEY) || 'null');
    const defaults = defaultWorkspaceAssetHeads();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
    for (const kind of WORKSPACE_ASSET_KINDS) {
      const head = value[kind];
      if (Number.isInteger(head?.revision) && head.revision >= 0 && typeof head.valueHash === 'string') {
        defaults[kind] = { revision: head.revision, valueHash: head.valueHash };
      }
    }
    return defaults;
  } catch {
    return defaultWorkspaceAssetHeads();
  }
}

function writeWorkspaceAssetHeads(heads) {
  try {
    localStorage.setItem(WORKSPACE_ASSET_HEADS_KEY, JSON.stringify(heads));
  } catch {
    // The in-memory heads still keep this tab synchronized.
  }
}

function applyWorkspaceAssetValue(snapshot, kind, value) {
  if (kind === 'custom-patterns') {
    return {
      ...snapshot,
      customPatterns: value.customPatterns,
      customPatternRevisions: value.customPatternRevisions,
    };
  }
  return { ...snapshot, patternLabDrafts: value.patternLabDrafts };
}

function uniqueCollisionId(id, used) {
  const base = `${id}_local_copy`;
  let next = base;
  let suffix = 2;
  while (used.has(next)) {
    next = `${base}_${suffix}`;
    suffix += 1;
  }
  used.add(next);
  return next;
}

function localCopyName(name, used = new Set()) {
  const base = String(name || 'Untitled').replace(/ \(local copy(?: \d+)?\)$/, '');
  let next = `${base} (local copy)`;
  let suffix = 2;
  while (used.has(next)) {
    next = `${base} (local copy ${suffix})`;
    suffix += 1;
  }
  used.add(next);
  return next;
}

function mergeWorkspaceAssetConflict(kind, remoteValue, localValue) {
  if (kind === 'pattern-lab-drafts') {
    const remoteDrafts = Array.isArray(remoteValue.patternLabDrafts) ? remoteValue.patternLabDrafts : [];
    const localDrafts = Array.isArray(localValue.patternLabDrafts) ? localValue.patternLabDrafts : [];
    const used = new Set([...remoteDrafts, ...localDrafts].map(draft => draft.id));
    const usedNames = new Set([...remoteDrafts, ...localDrafts].map(draft => draft.name));
    const remoteById = new Map(remoteDrafts.map(draft => [draft.id, draft]));
    const additions = [];
    for (const draft of localDrafts) {
      const remote = remoteById.get(draft.id);
      if (!remote) {
        used.add(draft.id);
        additions.push(draft);
      } else if (canonicalJson(remote) !== canonicalJson(draft)) {
        additions.push({
          ...draft,
          id: uniqueCollisionId(draft.id, used),
          name: localCopyName(draft.name, usedNames),
        });
      }
    }
    return {
      version: WORKSPACE_ASSETS_VERSION,
      patternLabDrafts: [...remoteDrafts, ...additions],
    };
  }

  const remotePatterns = Array.isArray(remoteValue.customPatterns) ? remoteValue.customPatterns : [];
  const localPatterns = Array.isArray(localValue.customPatterns) ? localValue.customPatterns : [];
  const remoteRevisions = remoteValue.customPatternRevisions || {};
  const localRevisions = localValue.customPatternRevisions || {};
  const remoteOwnedIds = new Set([
    ...remotePatterns.map(pattern => pattern.id),
    ...Object.keys(remoteRevisions),
  ]);
  const used = new Set([...remoteOwnedIds, ...localPatterns.map(pattern => pattern.id)]);
  const usedNames = new Set([...remotePatterns, ...localPatterns].map(pattern => pattern.name));
  const remoteById = new Map(remotePatterns.map(pattern => [pattern.id, pattern]));
  const patterns = [...remotePatterns];
  const revisions = structuredClone(remoteRevisions);
  for (const pattern of localPatterns) {
    const remote = remoteById.get(pattern.id);
    if (!remoteOwnedIds.has(pattern.id)) {
      used.add(pattern.id);
      patterns.push(pattern);
      if (Array.isArray(localRevisions[pattern.id])) revisions[pattern.id] = localRevisions[pattern.id];
      continue;
    }
    const revisionsDiffer = canonicalJson(remoteRevisions[pattern.id] || [])
      !== canonicalJson(localRevisions[pattern.id] || []);
    if (remote && canonicalJson(remote) === canonicalJson(pattern) && !revisionsDiffer) continue;
    const copyId = uniqueCollisionId(pattern.id, used);
    const copyName = localCopyName(pattern.name, usedNames);
    patterns.push({ ...pattern, id: copyId, name: copyName });
    revisions[copyId] = (Array.isArray(localRevisions[pattern.id]) ? localRevisions[pattern.id] : [])
      .map(revision => ({ ...revision, id: copyId, name: copyName }));
  }
  return {
    version: WORKSPACE_ASSETS_VERSION,
    customPatterns: patterns,
    customPatternRevisions: revisions,
  };
}

function projectMarker(lifecycle) {
  return {
    generation: lifecycle.generation,
    revision: lifecycle.editedRevision,
  };
}

function markerIsNewer(marker, acknowledgedMarker) {
  if (!acknowledgedMarker) return true;
  return marker.generation > acknowledgedMarker.generation
    || (marker.generation === acknowledgedMarker.generation && marker.revision > acknowledgedMarker.revision);
}

function syncLabel(status) {
  if (status === 'saved') return 'Saved online';
  if (status === 'saving') return 'Saving online';
  if (status === 'conflict') return 'Online conflict';
  if (status === 'waiting' || status === 'pending') return 'Waiting to save online';
  if (status === 'error') return 'Online save needs attention';
  return 'Not saved online';
}

function normalizeError(error) {
  if (error instanceof CloudLibraryError) return error;
  return new CloudLibraryError('unexpected_error', error?.message || 'The online project library could not complete that action.');
}

function mutationRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `lw-cloud-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isTransientError(error) {
  return error?.state === 'offline' || (Number.isInteger(error?.status) && error.status >= 500);
}

function isAuthenticationError(error) {
  return error?.status === 401 || error?.status === 403 || error?.state === 'sign-in' || error?.state === 'permission';
}

function signInUrl() {
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const configured = String(import.meta.env.VITE_LIBRARY_LOGIN_URL || '').trim();
  let target;
  try {
    target = new URL(configured || '/api/library/login', window.location.origin);
  } catch {
    target = new URL('/api/library/login', window.location.origin);
  }
  if (target.origin !== window.location.origin && target.protocol !== 'https:') {
    target = new URL('/api/library/login', window.location.origin);
  }
  target.searchParams.set('returnTo', returnTo);
  return target.href;
}

export function CloudLibraryProvider({ children, client: suppliedClient }) {
  const client = useMemo(() => suppliedClient || createCloudLibraryClient(), [suppliedClient]);
  const {
    projectLifecycle,
    projectName,
    setProjectName,
    serializeProject,
    replaceProject,
    requestReplacementConfirmation,
    markProjectPersisted,
  } = useProject();

  const [session, setSession] = useState({ status: 'loading', username: '', displayName: '', role: null, error: null });
  const [projectsByState, setProjectsByState] = useState({ active: [], archived: [] });
  const [activeRemoteProject, setActiveRemoteProject] = useState(null);
  const [syncStatus, setSyncStatus] = useState('idle');
  const [syncError, setSyncError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [workspaceAssets, setWorkspaceAssets] = useState({
    status: 'loading',
    ready: false,
    conflict: null,
    error: null,
    generation: 0,
  });
  const [, setBrowserClaimRevision] = useState(0);

  const lifecycleRef = useRef(projectLifecycle);
  const documentRef = useRef(null);
  const activeRemoteRef = useRef(activeRemoteProject);
  const sessionRef = useRef(session);
  const conflictRef = useRef(conflict);
  const saveTimerRef = useRef(null);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const acknowledgedMarkerRef = useRef(null);
  const retryRef = useRef(null);
  const mountedRef = useRef(true);
  const openOperationRef = useRef(0);
  const onlineRef = useRef(online);
  const pendingSaveOperationRef = useRef(null);
  const performSaveRef = useRef(null);
  const activeRemoteEpochRef = useRef(0);
  const workspaceAssetHeadsRef = useRef(readWorkspaceAssetHeads());
  const workspaceAssetConflictsRef = useRef(new Map());
  const workspaceAssetLoadOperationRef = useRef(0);
  const workspaceAssetEpochsRef = useRef(Object.fromEntries(
    WORKSPACE_ASSET_KINDS.map(kind => [kind, 0]),
  ));
  const workspaceAssetsLoadedRef = useRef(false);
  const workspaceAssetTimerRef = useRef(null);
  const workspaceAssetRetryRef = useRef(null);
  const workspaceAssetInFlightRef = useRef(false);
  const workspaceAssetQueuedRef = useRef(false);
  const pendingWorkspaceAssetOperationsRef = useRef(null);
  const performWorkspaceAssetSyncRef = useRef(null);
  const loadWorkspaceAssetsRef = useRef(null);

  lifecycleRef.current = projectLifecycle;
  documentRef.current = serializeProject();
  activeRemoteRef.current = activeRemoteProject;
  sessionRef.current = session;
  conflictRef.current = conflict;
  onlineRef.current = online;

  const waitForLocalEdit = useCallback(async (previousMarker, predicate) => {
    for (let frame = 0; frame < 6; frame += 1) {
      await new Promise(resolve => window.requestAnimationFrame(resolve));
      const marker = projectMarker(lifecycleRef.current);
      if (predicate()
        && marker.generation === previousMarker.generation
        && marker.revision > previousMarker.revision) return true;
    }
    return false;
  }, []);

  const resumeAfterSupersededSave = useCallback(acknowledgedMarker => {
    if (!mountedRef.current || conflictRef.current) return;
    const currentMarker = projectMarker(lifecycleRef.current);
    if (markerIsNewer(currentMarker, acknowledgedMarker)) {
      queuedRef.current = true;
      setSyncStatus('waiting');
      setRefreshTick(value => value + 1);
    } else if (acknowledgedMarker && markerKey(currentMarker) === markerKey(acknowledgedMarker)) {
      queuedRef.current = false;
      setSyncStatus('saved');
    }
  }, []);

  const setActiveRemote = useCallback((project, acknowledgedMarker = null) => {
    const pending = pendingSaveOperationRef.current;
    const pendingWasSuperseded = Boolean(pending && project
      && pending.remoteId === project.id
      && pending.baseRevision !== project.revision);
    if (!project || activeRemoteRef.current?.id !== project.id || pendingWasSuperseded) {
      pendingSaveOperationRef.current = null;
      queuedRef.current = false;
      clearTimeout(retryRef.current);
    }
    activeRemoteEpochRef.current += 1;
    activeRemoteRef.current = project;
    setActiveRemoteProject(project);
    writeActiveRemoteAssociation(project);
    acknowledgedMarkerRef.current = acknowledgedMarker;
    if (pendingWasSuperseded) resumeAfterSupersededSave(acknowledgedMarker);
  }, [resumeAfterSupersededSave]);

  const setCurrentConflict = useCallback(next => {
    conflictRef.current = next;
    setConflict(next);
  }, []);

  const demoteSession = useCallback(error => {
    clearTimeout(saveTimerRef.current);
    clearTimeout(retryRef.current);
    pendingSaveOperationRef.current = null;
    queuedRef.current = false;
    const next = error?.status === 401 || error?.state === 'sign-in'
      ? { status: 'unauthenticated', username: '', displayName: '', role: null, error }
      : { status: 'error', username: '', displayName: '', role: null, error };
    sessionRef.current = next;
    if (!mountedRef.current) return;
    setSession(next);
    setProjectsByState({ active: [], archived: [] });
    setActiveRemote(null);
  }, [setActiveRemote]);

  const handleLibraryError = useCallback(rawError => {
    const error = normalizeError(rawError);
    if (isAuthenticationError(error)) demoteSession(error);
    else if (mountedRef.current) setSyncError(error);
    return error;
  }, [demoteSession]);

  const setWorkspaceAssetStatus = useCallback(patch => {
    if (!mountedRef.current) return;
    setWorkspaceAssets(current => ({ ...current, ...patch }));
  }, []);

  const publishWorkspaceAssetConflicts = useCallback((patch = {}) => {
    if (!mountedRef.current) return;
    const conflict = workspaceAssetConflictsRef.current.values().next().value || null;
    setWorkspaceAssets(current => ({
      ...current,
      status: conflict ? 'conflict' : (patch.status || current.status),
      conflict,
      ...patch,
      ...(conflict ? { status: 'conflict', conflict } : {}),
    }));
  }, []);

  const performWorkspaceAssetSync = useCallback(async suppliedOperations => {
    if (!canUseWorkspaceAssets(sessionRef.current)) return { ok: false, reason: 'disabled' };
    if (!workspaceAssetsLoadedRef.current) {
      workspaceAssetQueuedRef.current = true;
      return { ok: false, reason: 'not-ready' };
    }
    if (workspaceAssetInFlightRef.current) {
      workspaceAssetQueuedRef.current = true;
      return { ok: false, reason: 'queued' };
    }

    let operations = suppliedOperations || pendingWorkspaceAssetOperationsRef.current;
    if (!operations) {
      let snapshot;
      try {
        snapshot = readWorkspaceAssets();
      } catch (error) {
        setWorkspaceAssetStatus({ status: 'error', error: normalizeError(error) });
        return { ok: false, reason: 'local-assets-invalid', error };
      }
      operations = WORKSPACE_ASSET_KINDS.flatMap(kind => {
        if (workspaceAssetConflictsRef.current.has(kind)) return [];
        const value = workspaceAssetValue(snapshot, kind);
        const valueHash = canonicalJson(value);
        const head = workspaceAssetHeadsRef.current[kind];
        return valueHash === head.valueHash ? [] : [{
          kind,
          baseRevision: head.revision,
          value,
          valueHash,
          requestId: mutationRequestId(),
          epoch: workspaceAssetEpochsRef.current[kind],
        }];
      });
    }
    operations = operations.filter(operation => !workspaceAssetConflictsRef.current.has(operation.kind));
    if (!operations.length) {
      pendingWorkspaceAssetOperationsRef.current = null;
      publishWorkspaceAssetConflicts({ status: 'saved', error: null });
      return { ok: true, unchanged: true };
    }
    pendingWorkspaceAssetOperationsRef.current = operations;
    if (!onlineRef.current || navigator.onLine === false) {
      setWorkspaceAssetStatus({ status: 'waiting', error: null });
      return { ok: false, reason: 'offline' };
    }

    workspaceAssetInFlightRef.current = true;
    setWorkspaceAssetStatus({ status: 'saving', error: null });
    let encounteredConflict = false;
    try {
      for (let index = 0; index < operations.length; index += 1) {
        const operation = operations[index];
        if (operation.epoch !== workspaceAssetEpochsRef.current[operation.kind]) {
          pendingWorkspaceAssetOperationsRef.current = operations.slice(index + 1);
          continue;
        }
        try {
          const acknowledged = await client.writeAsset(operation.kind, {
            baseRevision: operation.baseRevision,
            value: operation.value,
          }, { requestId: operation.requestId });
          if (!canUseWorkspaceAssets(sessionRef.current)) {
            pendingWorkspaceAssetOperationsRef.current = null;
            return { ok: false, reason: 'disabled' };
          }
          if (operation.epoch === workspaceAssetEpochsRef.current[operation.kind]) {
            workspaceAssetHeadsRef.current[operation.kind] = {
              revision: acknowledged.revision,
              valueHash: operation.valueHash,
            };
            writeWorkspaceAssetHeads(workspaceAssetHeadsRef.current);
          }
          pendingWorkspaceAssetOperationsRef.current = operations.slice(index + 1);
        } catch (rawError) {
          let error = normalizeError(rawError);
          if (!mountedRef.current) return { ok: false, reason: 'unmounted', error };
          if (!canUseWorkspaceAssets(sessionRef.current)) {
            pendingWorkspaceAssetOperationsRef.current = null;
            return { ok: false, reason: 'disabled' };
          }
          if (operation.epoch !== workspaceAssetEpochsRef.current[operation.kind]) {
            pendingWorkspaceAssetOperationsRef.current = operations.slice(index + 1);
            continue;
          }
          if (error.code === 'idempotency_conflict') {
            let remote;
            try {
              remote = await client.readAsset(operation.kind);
            } catch (readError) {
              const normalizedReadError = normalizeError(readError);
              pendingWorkspaceAssetOperationsRef.current = operations.slice(index);
              setWorkspaceAssetStatus({ status: 'error', error: normalizedReadError });
              return { ok: false, reason: normalizedReadError.state, error: normalizedReadError };
            }
            if (operation.epoch !== workspaceAssetEpochsRef.current[operation.kind]) {
              pendingWorkspaceAssetOperationsRef.current = operations.slice(index + 1);
              continue;
            }
            if (canonicalJson(remote.value) === operation.valueHash) {
              workspaceAssetHeadsRef.current[operation.kind] = {
                revision: remote.revision,
                valueHash: operation.valueHash,
              };
              writeWorkspaceAssetHeads(workspaceAssetHeadsRef.current);
              pendingWorkspaceAssetOperationsRef.current = operations.slice(index + 1);
              continue;
            }
            error = new CloudLibraryError(
              'revision_conflict',
              'Workspace assets differ from the online library.',
              { status: 409 },
            );
            workspaceAssetConflictsRef.current.set(operation.kind, {
              kind: operation.kind,
              remote: structuredClone(remote),
            });
            encounteredConflict = true;
            pendingWorkspaceAssetOperationsRef.current = operations
              .slice(index + 1)
              .filter(next => !workspaceAssetConflictsRef.current.has(next.kind));
            publishWorkspaceAssetConflicts({ error });
            continue;
          }
          if (error.state === 'conflict') {
            let remote;
            try {
              remote = await client.readAsset(operation.kind);
            } catch (readError) {
              const normalizedReadError = normalizeError(readError);
              pendingWorkspaceAssetOperationsRef.current = operations.slice(index);
              setWorkspaceAssetStatus({ status: 'error', error: normalizedReadError });
              return { ok: false, reason: normalizedReadError.state, error: normalizedReadError };
            }
            if (operation.epoch !== workspaceAssetEpochsRef.current[operation.kind]) {
              pendingWorkspaceAssetOperationsRef.current = operations.slice(index + 1);
              continue;
            }
            workspaceAssetConflictsRef.current.set(operation.kind, {
              kind: operation.kind,
              remote: structuredClone(remote),
            });
            encounteredConflict = true;
            pendingWorkspaceAssetOperationsRef.current = operations
              .slice(index + 1)
              .filter(next => !workspaceAssetConflictsRef.current.has(next.kind));
            publishWorkspaceAssetConflicts({ error });
            continue;
          }
          if (isAuthenticationError(error)) {
            pendingWorkspaceAssetOperationsRef.current = null;
            demoteSession(error);
            setWorkspaceAssetStatus({ status: 'error', error });
            return { ok: false, reason: error.state, error };
          }
          pendingWorkspaceAssetOperationsRef.current = operations.slice(index);
          if (isTransientError(error) || navigator.onLine === false) {
            setWorkspaceAssetStatus({ status: 'waiting', error });
            clearTimeout(workspaceAssetRetryRef.current);
            workspaceAssetRetryRef.current = setTimeout(() => {
              if (mountedRef.current) void performWorkspaceAssetSyncRef.current?.(
                pendingWorkspaceAssetOperationsRef.current,
              );
            }, CLOUD_RETRY_MS);
          } else {
            setWorkspaceAssetStatus({ status: 'error', error });
          }
          return { ok: false, reason: error.state, error };
        }
      }
      pendingWorkspaceAssetOperationsRef.current = null;
      publishWorkspaceAssetConflicts({ status: 'saved', error: encounteredConflict ? undefined : null });
      return encounteredConflict ? { ok: false, reason: 'conflict' } : { ok: true };
    } finally {
      workspaceAssetInFlightRef.current = false;
      if (mountedRef.current && workspaceAssetQueuedRef.current && !pendingWorkspaceAssetOperationsRef.current) {
        workspaceAssetQueuedRef.current = false;
        clearTimeout(workspaceAssetTimerRef.current);
        workspaceAssetTimerRef.current = setTimeout(() => {
          void performWorkspaceAssetSyncRef.current?.();
        }, WORKSPACE_ASSET_DEBOUNCE_MS);
      }
    }
  }, [client, demoteSession, publishWorkspaceAssetConflicts, setWorkspaceAssetStatus]);
  performWorkspaceAssetSyncRef.current = performWorkspaceAssetSync;

  const queueWorkspaceAssetSync = useCallback(() => {
    if (!canUseWorkspaceAssets(sessionRef.current)) return;
    workspaceAssetQueuedRef.current = true;
    if (!workspaceAssetsLoadedRef.current) return;
    if (workspaceAssetConflictsRef.current.size === WORKSPACE_ASSET_KINDS.length) {
      publishWorkspaceAssetConflicts();
      return;
    }
    publishWorkspaceAssetConflicts({ status: onlineRef.current ? 'pending' : 'waiting', error: null });
    clearTimeout(workspaceAssetTimerRef.current);
    if (!onlineRef.current || navigator.onLine === false) return;
    workspaceAssetTimerRef.current = setTimeout(() => {
      workspaceAssetQueuedRef.current = false;
      void performWorkspaceAssetSyncRef.current?.();
    }, WORKSPACE_ASSET_DEBOUNCE_MS);
  }, [publishWorkspaceAssetConflicts]);

  const loadWorkspaceAssets = useCallback(async ({ force = false, replaceLocal = false } = {}) => {
    if (!canUseWorkspaceAssets(sessionRef.current)) return { ok: true, disabled: true };
    if (!force && workspaceAssetsLoadedRef.current) return { ok: true, unchanged: true };
    const loadOperation = ++workspaceAssetLoadOperationRef.current;
    setWorkspaceAssetStatus({ status: 'loading', ready: false, error: null });
    try {
      readWorkspaceAssets();
    } catch (error) {
      setWorkspaceAssetStatus({ status: 'error', ready: true, error: normalizeError(error) });
      return { ok: false, reason: 'local-assets-invalid', error };
    }

    try {
      const remoteEntries = await Promise.all(WORKSPACE_ASSET_KINDS.map(async kind => {
        try {
          return [kind, await client.readAsset(kind)];
        } catch (rawError) {
          const error = normalizeError(rawError);
          if (error.status === 404) return [kind, null];
          throw error;
        }
      }));
      if (!canUseWorkspaceAssets(sessionRef.current)) return { ok: true, disabled: true };
      if (!mountedRef.current) return { ok: false, reason: 'unmounted' };
      if (loadOperation !== workspaceAssetLoadOperationRef.current) {
        return { ok: false, reason: 'superseded' };
      }
      const currentSnapshot = readWorkspaceAssets();
      let nextSnapshot = currentSnapshot;
      let shouldSync = false;
      const installedKinds = new Set();
      const nextHeads = structuredClone(workspaceAssetHeadsRef.current);
      const nextConflicts = replaceLocal
        ? new Map()
        : new Map(workspaceAssetConflictsRef.current);
      for (const [kind, remote] of remoteEntries) {
        const localValue = workspaceAssetValue(currentSnapshot, kind);
        const localValueHash = canonicalJson(localValue);
        const acknowledged = workspaceAssetHeadsRef.current[kind];
        const localIsDirty = localValueHash !== acknowledged.valueHash;
        if (remote) {
          const remoteValueHash = canonicalJson(remote.value);
          if (replaceLocal || !localIsDirty || localValueHash === remoteValueHash) {
            nextSnapshot = applyWorkspaceAssetValue(nextSnapshot, kind, remote.value);
            nextHeads[kind] = { revision: remote.revision, valueHash: remoteValueHash };
            nextConflicts.delete(kind);
            installedKinds.add(kind);
          } else if (remote.revision === acknowledged.revision) {
            // The online head has not advanced; this is a valid local/offline edit.
            nextConflicts.delete(kind);
            shouldSync = true;
          } else {
            nextConflicts.set(kind, {
              kind,
              remote: structuredClone(remote),
            });
          }
        } else {
          const emptyHash = canonicalJson(emptyWorkspaceAssetValue(kind));
          nextHeads[kind] = { revision: 0, valueHash: emptyHash };
          nextConflicts.delete(kind);
          installedKinds.add(kind);
          if (localValueHash !== emptyHash) shouldSync = true;
        }
      }
      if (loadOperation !== workspaceAssetLoadOperationRef.current) {
        return { ok: false, reason: 'superseded' };
      }
      writeWorkspaceAssets(nextSnapshot, undefined, { dispatch: false });
      workspaceAssetHeadsRef.current = nextHeads;
      workspaceAssetConflictsRef.current = nextConflicts;
      for (const kind of installedKinds) workspaceAssetEpochsRef.current[kind] += 1;
      writeWorkspaceAssetHeads(workspaceAssetHeadsRef.current);
      workspaceAssetsLoadedRef.current = true;
      if (nextConflicts.size) {
        publishWorkspaceAssetConflicts({
          ready: true,
          error: new CloudLibraryError(
            'revision_conflict',
            'Workspace assets differ from the online library.',
            { status: 409 },
          ),
        });
        setWorkspaceAssets(current => ({ ...current, generation: current.generation + 1 }));
        if (shouldSync) queueWorkspaceAssetSync();
        return { ok: false, reason: 'conflict' };
      }
      setWorkspaceAssets(current => ({
        ...current,
        status: 'saved',
        ready: true,
        conflict: null,
        error: null,
        generation: current.generation + 1,
      }));
      if (shouldSync) queueWorkspaceAssetSync();
      return { ok: true };
    } catch (rawError) {
      const error = normalizeError(rawError);
      if (!mountedRef.current) return { ok: false, reason: 'unmounted', error };
      if (loadOperation !== workspaceAssetLoadOperationRef.current) {
        return { ok: false, reason: 'superseded', error };
      }
      if (isAuthenticationError(error)) demoteSession(error);
      const status = isTransientError(error) || navigator.onLine === false ? 'waiting' : 'error';
      setWorkspaceAssetStatus({ status, ready: true, error });
      if (status === 'waiting') {
        clearTimeout(workspaceAssetRetryRef.current);
        workspaceAssetRetryRef.current = setTimeout(() => {
          if (mountedRef.current) void loadWorkspaceAssetsRef.current?.({ force: true });
        }, CLOUD_RETRY_MS);
      }
      return { ok: false, reason: error.state, error };
    }
  }, [client, demoteSession, publishWorkspaceAssetConflicts, queueWorkspaceAssetSync, setWorkspaceAssetStatus]);
  loadWorkspaceAssetsRef.current = loadWorkspaceAssets;

  const refreshProjects = useCallback(async () => {
    const [active, archived] = await Promise.all([
      client.listProjects({ state: 'active' }),
      client.listProjects({ state: 'archived' }),
    ]);
    if (!mountedRef.current) return { active, archived };
    setProjectsByState({ active, archived });
    const associatedId = activeRemoteRef.current?.id;
    const associated = [...active, ...archived].find(project => project.id === associatedId) || null;
    if (associated) {
      if (associated.revision === activeRemoteRef.current?.revision) {
        activeRemoteRef.current = associated;
        setActiveRemoteProject(associated);
      } else if (!conflictRef.current) {
        const nextConflict = {
          remoteId: associated.id,
          localDocument: structuredClone(documentRef.current),
          reason: 'remote-revision-changed',
        };
        setCurrentConflict(nextConflict);
        setSyncStatus('conflict');
      }
    } else if (activeRemoteRef.current) {
      setActiveRemote(null);
    }
    return { active, archived };
  }, [client, setActiveRemote, setCurrentConflict]);

  const loadSession = useCallback(async () => {
    if (mountedRef.current) {
      const loading = { ...sessionRef.current, status: 'loading', error: null };
      sessionRef.current = loading;
      setSession(loading);
    }
    try {
      let identity;
      try {
        identity = typeof client.getAccountSession === 'function'
          ? await client.getAccountSession()
          : await client.getSession();
      } catch (accountError) {
        const normalizedAccountError = normalizeError(accountError);
        if (!isAuthenticationError(normalizedAccountError)) throw normalizedAccountError;
        try {
          const transitional = await client.getSession();
          if (!mountedRef.current) return;
          if (transitional?.email && transitional.role === 'owner') {
            const bootstrap = { status: 'bootstrap', ...transitional, error: null };
            sessionRef.current = bootstrap;
            setSession(bootstrap);
            setProjectsByState({ active: [], archived: [] });
            setWorkspaceAssets(current => ({
              ...current,
              status: 'local',
              ready: true,
              error: null,
              generation: current.generation + 1,
            }));
            return;
          }
        } catch (transitionalError) {
          const normalizedTransitionalError = normalizeError(transitionalError);
          if (!isAuthenticationError(normalizedTransitionalError)) throw normalizedTransitionalError;
        }
        throw normalizedAccountError;
      }
      if (!mountedRef.current) return;
      if (identity.mustChangePassword) {
        const forced = { status: 'password-change', ...identity, error: null };
        sessionRef.current = forced;
        setSession(forced);
        setProjectsByState({ active: [], archived: [] });
        setActiveRemote(null);
        setWorkspaceAssets(current => ({
          ...current,
          status: 'local',
          ready: true,
          error: null,
          generation: current.generation + 1,
        }));
        return;
      }
      const authenticated = { status: 'authenticated', ...identity, error: null };
      sessionRef.current = authenticated;
      setSession(authenticated);
      const assetResult = identity.role === 'customer'
        ? { ok: true, disabled: true }
        : await loadWorkspaceAssets();
      if (identity.role === 'customer') {
        workspaceAssetsLoadedRef.current = false;
        setWorkspaceAssets(current => ({
          ...current,
          status: 'disabled',
          ready: true,
          conflict: null,
          error: null,
          generation: current.generation + 1,
        }));
      }
      if (!mountedRef.current || isAuthenticationError(assetResult?.error)) return;
      sessionRef.current = authenticated;
      setSession(authenticated);
      const lists = await refreshProjects();
      if (!mountedRef.current) return;
      const rememberedAssociation = readActiveRemoteAssociation();
      const remembered = [...lists.active, ...lists.archived].find(project => project.id === rememberedAssociation?.id);
      if (remembered) {
        try {
          const remote = await client.readProject(remembered.id);
          if (!mountedRef.current) return;
          const marker = projectMarker(lifecycleRef.current);
          const matchesRecoveryCopy = canonicalJson(remote.document) === canonicalJson(documentRef.current);
          const matchesRememberedRevision = rememberedAssociation.revision === null
            ? matchesRecoveryCopy
            : rememberedAssociation.revision === remote.revision;
          if (matchesRecoveryCopy && matchesRememberedRevision) {
            setCurrentConflict(null);
            setActiveRemote(remote, marker);
            markProjectPersisted('cloud', marker);
            setSyncStatus('saved');
          } else {
            const nextConflict = {
              remoteId: remote.id,
              remoteRevision: remote.revision,
              remoteDocument: structuredClone(remote.document),
              localDocument: structuredClone(documentRef.current),
              reason: 'bootstrap-divergence',
            };
            setActiveRemote(remote, null);
            setCurrentConflict(nextConflict);
            setSyncStatus('conflict');
          }
        } catch (error) {
          if (!mountedRef.current) return;
          setActiveRemote(null);
          handleLibraryError(error);
          setSyncStatus('error');
        }
      }
    } catch (rawError) {
      if (!mountedRef.current) return;
      const error = normalizeError(rawError);
      const next = error.state === 'sign-in'
        ? { status: 'unauthenticated', username: '', displayName: '', role: null, error }
        : { status: 'error', username: '', displayName: '', role: null, error };
      sessionRef.current = next;
      setSession(next);
      setProjectsByState({ active: [], archived: [] });
      setSyncStatus(error.state === 'offline' ? 'waiting' : 'idle');
      setWorkspaceAssets(current => ({
        ...current,
        status: error.state === 'offline' ? 'waiting' : 'local',
        ready: true,
        error: error.state === 'offline' ? error : null,
        generation: current.generation + 1,
      }));
    }
  }, [client, handleLibraryError, loadWorkspaceAssets, markProjectPersisted, refreshProjects, setActiveRemote, setCurrentConflict]);

  useEffect(() => {
    mountedRef.current = true;
    void loadSession();
    return () => {
      mountedRef.current = false;
      clearTimeout(saveTimerRef.current);
      clearTimeout(retryRef.current);
      clearTimeout(workspaceAssetTimerRef.current);
      clearTimeout(workspaceAssetRetryRef.current);
    };
  }, [loadSession]);

  useEffect(() => {
    const onWorkspaceAssetsChanged = () => queueWorkspaceAssetSync();
    window.addEventListener(WORKSPACE_ASSETS_EVENT, onWorkspaceAssetsChanged);
    return () => window.removeEventListener(WORKSPACE_ASSETS_EVENT, onWorkspaceAssetsChanged);
  }, [queueWorkspaceAssetSync]);

  useEffect(() => {
    document.documentElement.dataset.workspaceAssetsReady = workspaceAssets.ready ? 'true' : 'false';
    return () => { delete document.documentElement.dataset.workspaceAssetsReady; };
  }, [workspaceAssets.ready]);

  useEffect(() => {
    const onOnline = () => {
      onlineRef.current = true;
      setOnline(true);
      const pending = pendingSaveOperationRef.current;
      if (pending) {
        clearTimeout(retryRef.current);
        void performSaveRef.current?.(pending);
      } else {
        setRefreshTick(value => value + 1);
      }
      clearTimeout(workspaceAssetRetryRef.current);
      if (canUseWorkspaceAssets(sessionRef.current)) {
        if (!workspaceAssetsLoadedRef.current) void loadWorkspaceAssetsRef.current?.({ force: true });
        else if (pendingWorkspaceAssetOperationsRef.current) {
          void performWorkspaceAssetSyncRef.current?.(pendingWorkspaceAssetOperationsRef.current);
        } else if (workspaceAssetQueuedRef.current) {
          workspaceAssetQueuedRef.current = false;
          void performWorkspaceAssetSyncRef.current?.();
        }
      }
    };
    const onOffline = () => {
      onlineRef.current = false;
      setOnline(false);
      if (activeRemoteRef.current) setSyncStatus('waiting');
      if (workspaceAssetQueuedRef.current || pendingWorkspaceAssetOperationsRef.current) {
        setWorkspaceAssetStatus({ status: 'waiting' });
      }
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [setWorkspaceAssetStatus]);

  const performSave = useCallback(async suppliedOperation => {
    const remote = activeRemoteRef.current;
    if (!remote || sessionRef.current.status !== 'authenticated') return { ok: false, reason: 'unassociated' };
    if (conflictRef.current) return { ok: false, reason: 'conflict' };
    if (!onlineRef.current || navigator.onLine === false) {
      if (mountedRef.current) setSyncStatus('waiting');
      return { ok: false, reason: 'offline' };
    }

    const operation = suppliedOperation || {
      remoteId: remote.id,
      baseRevision: remote.revision,
      activeRemoteEpoch: activeRemoteEpochRef.current,
      marker: projectMarker(lifecycleRef.current),
      document: structuredClone(documentRef.current),
      requestId: mutationRequestId(),
    };
    const clearPendingOperation = () => {
      if (pendingSaveOperationRef.current?.requestId === operation.requestId) {
        pendingSaveOperationRef.current = null;
        clearTimeout(retryRef.current);
      }
    };
    const operationIsCurrent = () => mountedRef.current
      && activeRemoteRef.current?.id === operation.remoteId
      && activeRemoteRef.current?.revision === operation.baseRevision
      && activeRemoteEpochRef.current === operation.activeRemoteEpoch;
    const replacedResult = error => {
      clearPendingOperation();
      resumeAfterSupersededSave(acknowledgedMarkerRef.current);
      return { ok: false, reason: 'replaced', ...(error ? { error } : {}) };
    };
    if (!operationIsCurrent()) return replacedResult();
    if (inFlightRef.current) {
      queuedRef.current = true;
      return { ok: false, reason: 'queued' };
    }
    inFlightRef.current = true;
    if (mountedRef.current) {
      setSyncStatus('saving');
      setSyncError(null);
    }
    const capturedKey = markerKey(operation.marker);
    let completed = false;
    const acknowledge = acknowledged => {
      if (!operationIsCurrent()) return false;
      completed = true;
      clearPendingOperation();
      activeRemoteRef.current = acknowledged;
      setActiveRemoteProject(acknowledged);
      writeActiveRemoteAssociation(acknowledged);
      acknowledgedMarkerRef.current = operation.marker;
      setProjectsByState(current => ({
        active: current.active.map(item => item.id === acknowledged.id ? acknowledged : item),
        archived: current.archived.map(item => item.id === acknowledged.id ? acknowledged : item),
      }));
      const currentMarker = projectMarker(lifecycleRef.current);
      markProjectPersisted('cloud', operation.marker);
      if (markerKey(currentMarker) === capturedKey) {
        setSyncStatus('saved');
      } else {
        queuedRef.current = true;
        setSyncStatus('waiting');
      }
      setSyncError(null);
      return true;
    };
    try {
      const acknowledged = await client.updateProject(operation.remoteId, {
        baseRevision: operation.baseRevision,
        title: operation.document.name || remote.title,
        project: operation.document,
      }, { requestId: operation.requestId });
      if (!acknowledge(acknowledged)) {
        return replacedResult();
      }
      return { ok: true, project: acknowledged };
    } catch (rawError) {
      let error = normalizeError(rawError);
      if (!mountedRef.current) return { ok: false, reason: 'unmounted', error };
      if (!operationIsCurrent()) return replacedResult(error);
      if (error.code === 'idempotency_conflict') {
        try {
          const latest = await client.readProject(operation.remoteId);
          if (!operationIsCurrent()) return replacedResult(error);
          const expectedTitle = operation.document.name || remote.title;
          const matchesAcceptedSave = latest.revision === operation.baseRevision + 1
            && latest.title === expectedTitle
            && canonicalJson(latest.document) === canonicalJson(operation.document);
          if (matchesAcceptedSave && acknowledge(latest)) {
            return { ok: true, project: latest, reconciled: true };
          }
        } catch (readError) {
          error = normalizeError(readError);
          if (!mountedRef.current) return { ok: false, reason: 'unmounted', error };
          if (!operationIsCurrent()) return replacedResult(error);
        }
      }
      if (error.state === 'conflict') {
        clearPendingOperation();
        setCurrentConflict({ remoteId: operation.remoteId, localDocument: structuredClone(documentRef.current), error });
        setSyncStatus('conflict');
      } else if (isAuthenticationError(error)) {
        clearPendingOperation();
        setSyncError(error);
        demoteSession(error);
      } else {
        setSyncError(error);
        if (isTransientError(error) || navigator.onLine === false) {
          pendingSaveOperationRef.current = operation;
          setSyncStatus('waiting');
          clearTimeout(retryRef.current);
          retryRef.current = setTimeout(() => {
            if (!mountedRef.current || conflictRef.current) return;
            const pending = pendingSaveOperationRef.current;
            if (pending) void performSaveRef.current?.(pending);
          }, CLOUD_RETRY_MS);
        } else {
          clearPendingOperation();
          setSyncStatus('error');
        }
      }
      return { ok: false, reason: error.state, error };
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current && completed && queuedRef.current && !conflictRef.current) {
        queuedRef.current = false;
        setRefreshTick(value => value + 1);
      }
    }
  }, [client, demoteSession, markProjectPersisted, resumeAfterSupersededSave, setCurrentConflict]);
  performSaveRef.current = performSave;

  useEffect(() => {
    clearTimeout(saveTimerRef.current);
    const remote = activeRemoteProject;
    if (!remote || session.status !== 'authenticated' || conflict) return undefined;
    const currentMarker = projectMarker(projectLifecycle);
    const pendingOperation = pendingSaveOperationRef.current;
    if (pendingOperation) {
      if (markerKey(pendingOperation.marker) !== markerKey(currentMarker)) queuedRef.current = true;
      if (!inFlightRef.current) setSyncStatus('waiting');
      return undefined;
    }
    const acknowledgedMarker = acknowledgedMarkerRef.current;
    if (acknowledgedMarker && markerKey(acknowledgedMarker) === markerKey(currentMarker)) {
      if (!inFlightRef.current) setSyncStatus('saved');
      return undefined;
    }
    if (acknowledgedMarker && currentMarker.generation < acknowledgedMarker.generation) return undefined;
    setSyncStatus(online ? 'pending' : 'waiting');
    if (!online) return undefined;
    const operation = {
      remoteId: remote.id,
      baseRevision: remote.revision,
      activeRemoteEpoch: activeRemoteEpochRef.current,
      marker: currentMarker,
      document: structuredClone(documentRef.current),
      requestId: mutationRequestId(),
    };
    saveTimerRef.current = setTimeout(() => {
      if (mountedRef.current) void performSaveRef.current?.(operation);
    }, CLOUD_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(saveTimerRef.current);
  }, [activeRemoteProject, conflict, online, projectLifecycle.editedRevision, projectLifecycle.generation, refreshTick, session.status]);

  const associateOpenedProject = useCallback(async (remote, { force = false } = {}) => {
    const result = await replaceProject(remote.document, force ? { confirmDiscard: () => true } : undefined);
    if (!result.ok || !mountedRef.current) return result;
    const nextMarker = { generation: lifecycleRef.current.generation + 1, revision: 0 };
    setCurrentConflict(null);
    setSyncError(null);
    setActiveRemote(remote, nextMarker);
    markProjectPersisted('cloud', nextMarker);
    setSyncStatus('saved');
    return { ok: true, project: remote };
  }, [markProjectPersisted, replaceProject, setActiveRemote, setCurrentConflict]);

  const createProject = useCallback(async (title) => {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) return { ok: false, reason: 'title-required' };
    openOperationRef.current += 1;
    const previousMarker = projectMarker(lifecycleRef.current);
    const titleChanged = documentRef.current.name !== cleanTitle;
    if (titleChanged) setProjectName(cleanTitle);
    try {
      const capturedLocalEdit = !titleChanged
        || await waitForLocalEdit(previousMarker, () => documentRef.current.name === cleanTitle);
      if (!mountedRef.current) return { ok: false, reason: 'unmounted' };
      if (!capturedLocalEdit) return { ok: false, reason: 'local-state-not-ready' };
      const capturedMarker = projectMarker(lifecycleRef.current);
      const document = structuredClone(documentRef.current);
      document.name = cleanTitle;
      const created = await client.createProject(
        { title: cleanTitle, project: document },
        { requestId: mutationRequestId() },
      );
      if (!mountedRef.current) return { ok: false, reason: 'unmounted' };
      if (lifecycleRef.current.generation !== capturedMarker.generation) {
        await refreshProjects();
        return { ok: true, project: created, associated: false };
      }
      setCurrentConflict(null);
      setActiveRemote(created, capturedMarker);
      markProjectPersisted('cloud', capturedMarker);
      const currentMarker = projectMarker(lifecycleRef.current);
      if (markerKey(currentMarker) === markerKey(capturedMarker)) setSyncStatus('saved');
      else {
        queuedRef.current = true;
        setSyncStatus('waiting');
        setRefreshTick(value => value + 1);
      }
      setSyncError(null);
      await refreshProjects();
      return { ok: true, project: created };
    } catch (error) {
      const normalized = handleLibraryError(error);
      return { ok: false, error: normalized };
    }
  }, [client, handleLibraryError, markProjectPersisted, refreshProjects, setActiveRemote, setCurrentConflict, setProjectName, waitForLocalEdit]);

  const openProject = useCallback(async (projectOrId, options) => {
    const id = typeof projectOrId === 'string' ? projectOrId : projectOrId.id;
    const operation = ++openOperationRef.current;
    const capturedMarker = projectMarker(lifecycleRef.current);
    try {
      const remote = await client.readProject(id);
      if (!mountedRef.current || operation !== openOperationRef.current) return { ok: false, reason: 'superseded' };
      const currentMarker = projectMarker(lifecycleRef.current);
      const changedDuringRead = markerKey(currentMarker) !== markerKey(capturedMarker);
      if (changedDuringRead && !options?.force) {
        const confirmed = await requestReplacementConfirmation({
          currentName: documentRef.current?.name,
          incomingName: remote.document?.name,
        });
        if (!mountedRef.current || operation !== openOperationRef.current) return { ok: false, reason: 'superseded' };
        if (!confirmed) return { ok: false, reason: 'cancelled' };
        const result = await associateOpenedProject(remote, { force: true });
        if (result.ok) openOperationRef.current += 1;
        return result;
      }
      const result = await associateOpenedProject(remote, options);
      if (result.ok) openOperationRef.current += 1;
      return result;
    } catch (error) {
      const normalized = operation === openOperationRef.current ? handleLibraryError(error) : normalizeError(error);
      return { ok: false, error: normalized };
    }
  }, [associateOpenedProject, client, handleLibraryError, requestReplacementConfirmation]);

  const saveNow = useCallback(async () => {
    clearTimeout(saveTimerRef.current);
    const marker = projectMarker(lifecycleRef.current);
    if (acknowledgedMarkerRef.current && markerKey(acknowledgedMarkerRef.current) === markerKey(marker)) {
      setSyncStatus('saved');
      return { ok: true, project: activeRemoteRef.current, unchanged: true };
    }
    const remote = activeRemoteRef.current;
    if (!remote) return { ok: false, reason: 'unassociated' };
    return performSave({
      remoteId: remote.id,
      baseRevision: remote.revision,
      activeRemoteEpoch: activeRemoteEpochRef.current,
      marker,
      document: structuredClone(documentRef.current),
      requestId: mutationRequestId(),
    });
  }, [performSave]);

  const detachProject = useCallback(() => {
    openOperationRef.current += 1;
    clearTimeout(saveTimerRef.current);
    clearTimeout(retryRef.current);
    setCurrentConflict(null);
    setSyncError(null);
    setActiveRemote(null);
    setSyncStatus('idle');
  }, [setActiveRemote, setCurrentConflict]);

  const renameProject = useCallback(async (project, title) => {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) return { ok: false, reason: 'title-required' };
    const isActive = activeRemoteRef.current?.id === project.id;
    let capturedMarker;
    let opened;
    if (isActive) {
      const previousMarker = projectMarker(lifecycleRef.current);
      const titleChanged = documentRef.current.name !== cleanTitle;
      if (titleChanged) setProjectName(cleanTitle);
      const capturedLocalEdit = !titleChanged
        || await waitForLocalEdit(previousMarker, () => documentRef.current.name === cleanTitle);
      if (!mountedRef.current) return { ok: false, reason: 'unmounted' };
      if (!capturedLocalEdit) return { ok: false, reason: 'local-state-not-ready' };
      capturedMarker = projectMarker(lifecycleRef.current);
      const document = structuredClone(documentRef.current);
      document.name = cleanTitle;
      opened = { ...activeRemoteRef.current, document };
    }
    try {
      clearTimeout(saveTimerRef.current);
      if (!opened) opened = await client.readProject(project.id);
      const updated = await client.updateProject(project.id, {
        baseRevision: opened.revision,
        title: cleanTitle,
        project: { ...opened.document, name: cleanTitle },
      }, { requestId: mutationRequestId() });
      if (!mountedRef.current) return { ok: false, reason: 'unmounted' };
      if (isActive
        && activeRemoteRef.current?.id === project.id
        && activeRemoteRef.current?.revision === opened.revision
        && lifecycleRef.current.generation === capturedMarker.generation) {
        setActiveRemote(updated, capturedMarker);
        markProjectPersisted('cloud', capturedMarker);
        const currentMarker = projectMarker(lifecycleRef.current);
        if (markerKey(currentMarker) === markerKey(capturedMarker)) setSyncStatus('saved');
        else {
          queuedRef.current = true;
          setSyncStatus('waiting');
          setRefreshTick(value => value + 1);
        }
      }
      await refreshProjects();
      return { ok: true, project: updated };
    } catch (error) {
      const normalized = handleLibraryError(error);
      return { ok: false, error: normalized };
    }
  }, [client, handleLibraryError, markProjectPersisted, refreshProjects, setActiveRemote, setProjectName, waitForLocalEdit]);

  const duplicateProject = useCallback(async (project, title) => {
    try {
      const duplicate = await client.duplicateProject(project.id, title ? { title } : undefined);
      await refreshProjects();
      return { ok: true, project: duplicate };
    } catch (error) {
      const normalized = handleLibraryError(error);
      return { ok: false, error: normalized };
    }
  }, [client, handleLibraryError, refreshProjects]);

  const changeArchiveState = useCallback(async (project, archived) => {
    try {
      const updated = await client.setArchived(project.id, archived, { baseRevision: project.revision });
      if (activeRemoteRef.current?.id === updated.id) {
        setActiveRemote(updated, acknowledgedMarkerRef.current);
      }
      await refreshProjects();
      return { ok: true, project: updated };
    } catch (error) {
      const normalized = handleLibraryError(error);
      return { ok: false, error: normalized };
    }
  }, [client, handleLibraryError, refreshProjects, setActiveRemote]);

  const archiveProject = useCallback(project => changeArchiveState(project, true), [changeArchiveState]);
  const unarchiveProject = useCallback(project => changeArchiveState(project, false), [changeArchiveState]);

  const deleteProject = useCallback(async (project) => {
    try {
      await client.deleteProject(project.id, { baseRevision: project.revision, confirmation: 'DELETE' });
      if (activeRemoteRef.current?.id === project.id) setActiveRemote(null);
      await refreshProjects();
      return { ok: true };
    } catch (error) {
      const normalized = handleLibraryError(error);
      return { ok: false, error: normalized };
    }
  }, [client, handleLibraryError, refreshProjects, setActiveRemote]);

  const listHistory = useCallback(async project => {
    try {
      return await client.listRevisions(project.id);
    } catch (error) {
      throw handleLibraryError(error);
    }
  }, [client, handleLibraryError]);

  const restoreHistory = useCallback(async (project, revision) => {
    try {
      await client.restoreRevision(project.id, revision, { baseRevision: project.revision });
      const restored = await client.readProject(project.id);
      await refreshProjects();
      return associateOpenedProject(restored, { force: true });
    } catch (error) {
      const normalized = handleLibraryError(error);
      return { ok: false, error: normalized };
    }
  }, [associateOpenedProject, client, handleLibraryError, refreshProjects]);

  const exportProject = useCallback(async project => {
    try {
      const opened = await client.readProject(project.id);
      // The network read completes after the click's transient user activation;
      // use the deterministic anchor path instead of reopening a native picker.
      return downloadJsonFile(canonicalProjectFileName(opened.title), opened.document, { preferPicker: false });
    } catch (error) {
      handleLibraryError(error);
      return false;
    }
  }, [client, handleLibraryError]);

  const importProject = useCallback(async candidate => {
    const project = migrateProject(candidate);
    if (!project || isLibraryBackup(candidate)) return { ok: false, reason: 'invalid' };
    try {
      const created = await client.createProject({ title: project.name || 'Imported project', project });
      await refreshProjects();
      return { ok: true, project: created };
    } catch (error) {
      const normalized = handleLibraryError(error);
      return { ok: false, error: normalized };
    }
  }, [client, handleLibraryError, refreshProjects]);

  const exportMaster = useCallback(async () => {
    try {
      const blob = await client.downloadBackup();
      return downloadTextFile(canonicalLibraryBackupFileName(new Date()), await blob.text(), {
        type: 'application/json',
        preferPicker: false,
      });
    } catch (error) {
      handleLibraryError(error);
      return false;
    }
  }, [client, handleLibraryError]);

  const restoreMaster = useCallback(async candidate => {
    if (!isLibraryBackup(candidate)) return { ok: false, reason: 'invalid' };
    try {
      const summary = await client.restoreBackup(candidate);
      const [, assetsResult] = await Promise.all([
        refreshProjects(),
        loadWorkspaceAssets({ force: true, replaceLocal: true }),
      ]);
      if (!assetsResult?.ok) {
        return { ok: false, reason: assetsResult?.reason || 'asset-refresh', error: assetsResult?.error };
      }
      return { ok: true, summary };
    } catch (error) {
      const normalized = handleLibraryError(error);
      return { ok: false, error: normalized };
    }
  }, [client, handleLibraryError, loadWorkspaceAssets, refreshProjects]);

  const resolveWorkspaceAssetConflict = useCallback(async action => {
    const currentConflict = workspaceAssets.conflict;
    if (!currentConflict) return { ok: false, reason: 'no-conflict' };
    if (action !== 'keep-both') return { ok: false, reason: 'unknown-action' };
    try {
      const snapshot = readWorkspaceAssets();
      const localValue = workspaceAssetValue(snapshot, currentConflict.kind);
      const mergedValue = mergeWorkspaceAssetConflict(
        currentConflict.kind,
        currentConflict.remote.value,
        localValue,
      );
      const mergedSnapshot = applyWorkspaceAssetValue(snapshot, currentConflict.kind, mergedValue);
      writeWorkspaceAssets(mergedSnapshot, undefined, { dispatch: false });
      workspaceAssetHeadsRef.current[currentConflict.kind] = {
        revision: currentConflict.remote.revision,
        valueHash: canonicalJson(currentConflict.remote.value),
      };
      writeWorkspaceAssetHeads(workspaceAssetHeadsRef.current);
      workspaceAssetConflictsRef.current.delete(currentConflict.kind);
      const remainingOperations = (pendingWorkspaceAssetOperationsRef.current || [])
        .filter(operation => operation.kind !== currentConflict.kind);
      pendingWorkspaceAssetOperationsRef.current = remainingOperations.length ? remainingOperations : null;
      publishWorkspaceAssetConflicts({ status: 'pending', error: null });
      setWorkspaceAssets(current => ({ ...current, generation: current.generation + 1 }));
      return performWorkspaceAssetSync();
    } catch (error) {
      const normalized = normalizeError(error);
      setWorkspaceAssetStatus({ status: 'error', error: normalized });
      return { ok: false, reason: normalized.state, error: normalized };
    }
  }, [performWorkspaceAssetSync, publishWorkspaceAssetConflicts, setWorkspaceAssetStatus, workspaceAssets.conflict]);

  const claimBrowserProjects = useCallback(async () => {
    const claimedIds = readClaimedBrowserProjectIds();
    const records = listProjectLibraryRecords().filter(record => !claimedIds.has(record.id));
    let imported = 0;
    let rejected = 0;
    for (const record of records) {
      const project = migrateProject(record.project);
      if (!project) {
        rejected += 1;
        continue;
      }
      try {
        await client.createProject({ title: record.name || project.name, project });
        imported += 1;
        claimedIds.add(record.id);
      } catch (error) {
        const normalized = handleLibraryError(error);
        rejected += 1;
        if (isAuthenticationError(normalized)) break;
      }
    }
    writeClaimedBrowserProjectIds(claimedIds);
    setBrowserClaimRevision(value => value + 1);
    if (sessionRef.current.status === 'authenticated') await refreshProjects();
    return { imported, rejected };
  }, [client, handleLibraryError, refreshProjects]);

  const resolveConflict = useCallback(async action => {
    const currentConflict = conflict;
    if (!currentConflict) return { ok: false, reason: 'no-conflict' };
    if (action === 'open-latest') {
      return openProject(currentConflict.remoteId, { force: true });
    }
    if (action === 'save-copy') {
      const capturedMarker = projectMarker(lifecycleRef.current);
      try {
        const localDocument = structuredClone(documentRef.current || currentConflict.localDocument);
        localDocument.id = createProjectId();
        localDocument.name = `${localDocument.name || projectName || 'Untitled Project'} copy`;
        const created = await client.createProject(
          { title: localDocument.name, project: localDocument },
          { requestId: mutationRequestId() },
        );
        if (!mountedRef.current) return { ok: false, reason: 'unmounted' };
        setCurrentConflict(null);
        await refreshProjects();
        if (markerKey(projectMarker(lifecycleRef.current)) === markerKey(capturedMarker)) {
          await associateOpenedProject({ ...created, document: localDocument }, { force: true });
        }
        return { ok: true, project: created };
      } catch (error) {
        const normalized = handleLibraryError(error);
        return { ok: false, error: normalized };
      }
    }
    return { ok: false, reason: 'unknown-action' };
  }, [associateOpenedProject, client, conflict, handleLibraryError, openProject, projectName, refreshProjects, setCurrentConflict]);

  const claimedBrowserIds = readClaimedBrowserProjectIds();
  const browserProjects = listProjectLibraryRecords().filter(record => !claimedBrowserIds.has(record.id));
  const login = useCallback(async credentials => {
    try {
      const identity = await client.login(credentials);
      if (!mountedRef.current) return { ok: false, reason: 'unmounted' };
      const next = {
        status: identity.mustChangePassword ? 'password-change' : 'loading',
        ...identity,
        error: null,
      };
      sessionRef.current = next;
      setSession(next);
      if (!identity.mustChangePassword) await loadSession();
      return { ok: true, session: identity };
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
  }, [client, loadSession]);

  const bootstrapOwner = useCallback(async input => {
    try {
      await client.bootstrapOwner(input);
      const identity = await client.login({ username: input.username, password: input.temporaryPassword });
      if (!mountedRef.current) return { ok: false, reason: 'unmounted' };
      const next = { status: 'password-change', ...identity, error: null };
      sessionRef.current = next;
      setSession(next);
      return { ok: true, session: identity };
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
  }, [client]);

  const changePassword = useCallback(async password => {
    try {
      await client.changePassword(password);
      await loadSession();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
  }, [client, loadSession]);

  const logout = useCallback(async () => {
    try {
      await client.logout();
    } catch (error) {
      const normalized = normalizeError(error);
      if (!isAuthenticationError(normalized)) return { ok: false, error: normalized };
    }
    openOperationRef.current += 1;
    workspaceAssetLoadOperationRef.current += 1;
    clearTimeout(saveTimerRef.current);
    clearTimeout(retryRef.current);
    clearTimeout(workspaceAssetTimerRef.current);
    clearTimeout(workspaceAssetRetryRef.current);
    pendingSaveOperationRef.current = null;
    pendingWorkspaceAssetOperationsRef.current = null;
    queuedRef.current = false;
    workspaceAssetQueuedRef.current = false;
    workspaceAssetsLoadedRef.current = false;
    setCurrentConflict(null);
    setSyncError(null);
    setSyncStatus('idle');
    setActiveRemote(null);
    setProjectsByState({ active: [], archived: [] });
    const signedOut = { status: 'unauthenticated', username: '', displayName: '', role: null, error: null };
    sessionRef.current = signedOut;
    setSession(signedOut);
    setWorkspaceAssets(current => ({
      ...current,
      status: 'local',
      ready: true,
      conflict: null,
      error: null,
      generation: current.generation + 1,
    }));
    return { ok: true };
  }, [client, setActiveRemote, setCurrentConflict]);

  const accountAction = useCallback(async action => {
    try {
      return { ok: true, value: await action() };
    } catch (error) {
      return { ok: false, error: normalizeError(error) };
    }
  }, []);

  const listAccounts = useCallback(() => accountAction(() => client.listAccounts()), [accountAction, client]);
  const createAccount = useCallback(input => accountAction(() => client.createAccount(input)), [accountAction, client]);
  const resetAccountPassword = useCallback((id, password) => accountAction(() => client.resetAccountPassword(id, password)), [accountAction, client]);
  const setAccountStatus = useCallback((id, status) => accountAction(() => client.setAccountStatus(id, status)), [accountAction, client]);
  const setAccountRole = useCallback((id, role) => accountAction(() => client.setAccountRole(id, role)), [accountAction, client]);
  const listAssignments = useCallback(id => accountAction(() => client.listAssignments(id)), [accountAction, client]);
  const assignProject = useCallback((id, projectId) => accountAction(() => client.assignProject(id, projectId)), [accountAction, client]);
  const unassignProject = useCallback((id, projectId) => accountAction(() => client.unassignProject(id, projectId)), [accountAction, client]);
  const listProjectDrafts = useCallback(async project => {
    const result = await accountAction(async () => {
      const [drafts, accounts] = await Promise.all([
        client.listProjectDrafts(project.id),
        client.listAccounts(),
      ]);
      const byId = new Map(accounts.map(account => [account.id, account]));
      return drafts.map(draft => ({ ...draft, customer: byId.get(draft.draftOwnerAccountId) || null }));
    });
    return result;
  }, [accountAction, client]);
  const promoteDraft = useCallback(async (official, draft) => {
    const result = await accountAction(() => client.promoteDraft(draft.id, {
      officialBaseRevision: official.revision,
      draftBaseRevision: draft.revision,
    }));
    if (result.ok) await refreshProjects();
    return result;
  }, [accountAction, client, refreshProjects]);

  const signIn = useCallback(() => {
    window.location.assign(signInUrl());
  }, []);
  const syncState = useMemo(() => ({
    status: syncStatus,
    label: syncLabel(syncStatus),
    error: syncError,
    conflict,
    online,
  }), [conflict, online, syncError, syncStatus]);

  const value = useMemo(() => ({
    session,
    projects: [...projectsByState.active, ...projectsByState.archived],
    activeProjects: projectsByState.active,
    archivedProjects: projectsByState.archived,
    activeRemoteProject,
    syncState,
    workspaceAssets,
    browserProjects,
    login,
    logout,
    bootstrapOwner,
    changePassword,
    listAccounts,
    createAccount,
    resetAccountPassword,
    setAccountStatus,
    setAccountRole,
    listAssignments,
    assignProject,
    unassignProject,
    listProjectDrafts,
    promoteDraft,
    signIn,
    retrySession: loadSession,
    refreshProjects,
    createProject,
    openProject,
    saveNow,
    detachProject,
    renameProject,
    duplicateProject,
    archiveProject,
    unarchiveProject,
    deleteProject,
    listHistory,
    restoreHistory,
    exportProject,
    importProject,
    exportMaster,
    restoreMaster,
    resolveWorkspaceAssetConflict,
    claimBrowserProjects,
    resolveConflict,
  }), [
    accountAction, activeRemoteProject, archiveProject, assignProject, bootstrapOwner, browserProjects,
    changePassword, claimBrowserProjects, createAccount, createProject, deleteProject, duplicateProject,
    exportMaster, exportProject, importProject, listAccounts, listAssignments, listHistory, listProjectDrafts, login, logout,
    detachProject, loadSession, openProject, projectsByState, refreshProjects, renameProject, resolveConflict,
    promoteDraft, resetAccountPassword, resolveWorkspaceAssetConflict, restoreHistory, restoreMaster, saveNow,
    session, setAccountRole, setAccountStatus, signIn, syncState, unarchiveProject, unassignProject, workspaceAssets,
  ]);

  return <CloudLibraryContext.Provider value={value}>{children}</CloudLibraryContext.Provider>;
}

export function useCloudLibrary() {
  const value = useContext(CloudLibraryContext);
  if (!value) throw new Error('useCloudLibrary must be used inside CloudLibraryProvider.');
  return value;
}
