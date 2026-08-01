import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { createCloudLibraryClient, CloudLibraryError } from '../lib/cloudLibraryClient.js';
import { canonicalLibraryBackupFileName, isLibraryBackup } from '../lib/libraryBackup.js';
import { downloadJsonFile, downloadTextFile } from '../lib/downloadFile.js';
import { canonicalProjectFileName } from '../lib/projectFiles.js';
import { createProjectId, migrateProject } from '../lib/projectModel.js';
import { listProjectLibraryRecords } from '../lib/projectStorage.js';
import { useProject } from './ProjectContext.jsx';

const ACTIVE_REMOTE_KEY = 'lw_cloud_active_project_v1';
const BROWSER_CLAIMS_KEY = 'lw_cloud_claimed_browser_projects_v1';
const CLOUD_SAVE_DEBOUNCE_MS = 900;
const CLOUD_RETRY_MS = 2500;

const CloudLibraryContext = createContext(null);

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

  const [session, setSession] = useState({ status: 'loading', email: '', role: null, error: null });
  const [projectsByState, setProjectsByState] = useState({ active: [], archived: [] });
  const [activeRemoteProject, setActiveRemoteProject] = useState(null);
  const [syncStatus, setSyncStatus] = useState('idle');
  const [syncError, setSyncError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const [refreshTick, setRefreshTick] = useState(0);
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
      ? { status: 'unauthenticated', email: '', role: null, error }
      : { status: 'error', email: '', role: null, error };
    sessionRef.current = next;
    if (!mountedRef.current) return;
    setSession(next);
    setProjectsByState({ active: [], archived: [] });
  }, []);

  const handleLibraryError = useCallback(rawError => {
    const error = normalizeError(rawError);
    if (isAuthenticationError(error)) demoteSession(error);
    else if (mountedRef.current) setSyncError(error);
    return error;
  }, [demoteSession]);

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
    if (mountedRef.current) setSession(current => ({ ...current, status: 'loading', error: null }));
    try {
      const identity = await client.getSession();
      if (!mountedRef.current) return;
      const authenticated = { status: 'authenticated', ...identity, error: null };
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
        ? { status: 'unauthenticated', email: '', role: null, error }
        : { status: 'error', email: '', role: null, error };
      sessionRef.current = next;
      setSession(next);
      setProjectsByState({ active: [], archived: [] });
      setSyncStatus(error.state === 'offline' ? 'waiting' : 'idle');
    }
  }, [client, handleLibraryError, markProjectPersisted, refreshProjects, setActiveRemote, setCurrentConflict]);

  useEffect(() => {
    mountedRef.current = true;
    void loadSession();
    return () => {
      mountedRef.current = false;
      clearTimeout(saveTimerRef.current);
      clearTimeout(retryRef.current);
    };
  }, [loadSession]);

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
    };
    const onOffline = () => {
      onlineRef.current = false;
      setOnline(false);
      if (activeRemoteRef.current) setSyncStatus('waiting');
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

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
      await refreshProjects();
      return { ok: true, summary };
    } catch (error) {
      const normalized = handleLibraryError(error);
      return { ok: false, error: normalized };
    }
  }, [client, handleLibraryError, refreshProjects]);

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
    browserProjects,
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
    claimBrowserProjects,
    resolveConflict,
  }), [
    activeRemoteProject, archiveProject, browserProjects, claimBrowserProjects, createProject,
    deleteProject, duplicateProject, exportMaster, exportProject, importProject, listHistory,
    detachProject, loadSession, openProject, projectsByState, refreshProjects, renameProject, resolveConflict,
    restoreHistory, restoreMaster, saveNow, session, signIn, syncState, unarchiveProject,
  ]);

  return <CloudLibraryContext.Provider value={value}>{children}</CloudLibraryContext.Provider>;
}

export function useCloudLibrary() {
  const value = useContext(CloudLibraryContext);
  if (!value) throw new Error('useCloudLibrary must be used inside CloudLibraryProvider.');
  return value;
}
