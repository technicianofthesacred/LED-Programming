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

function readActiveRemoteId() {
  try {
    return String(localStorage.getItem(ACTIVE_REMOTE_KEY) || '');
  } catch {
    return '';
  }
}

function writeActiveRemoteId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_REMOTE_KEY, id);
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

export function CloudLibraryProvider({ children, client: suppliedClient }) {
  const client = useMemo(() => suppliedClient || createCloudLibraryClient(), [suppliedClient]);
  const {
    projectLifecycle,
    projectName,
    setProjectName,
    serializeProject,
    replaceProject,
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
  const saveTimerRef = useRef(null);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(false);
  const acknowledgedMarkerRef = useRef(null);
  const retryRef = useRef(null);
  const mountedRef = useRef(true);

  lifecycleRef.current = projectLifecycle;
  documentRef.current = serializeProject();
  activeRemoteRef.current = activeRemoteProject;
  sessionRef.current = session;

  const setActiveRemote = useCallback((project, acknowledgedMarker = null) => {
    activeRemoteRef.current = project;
    setActiveRemoteProject(project);
    writeActiveRemoteId(project?.id || '');
    acknowledgedMarkerRef.current = acknowledgedMarker;
  }, []);

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
      activeRemoteRef.current = associated;
      setActiveRemoteProject(associated);
    } else if (activeRemoteRef.current) {
      setActiveRemote(null);
    }
    return { active, archived };
  }, [client, setActiveRemote]);

  const loadSession = useCallback(async () => {
    setSession(current => ({ ...current, status: 'loading', error: null }));
    try {
      const identity = await client.getSession();
      if (!mountedRef.current) return;
      const authenticated = { status: 'authenticated', ...identity, error: null };
      sessionRef.current = authenticated;
      setSession(authenticated);
      const lists = await refreshProjects();
      const rememberedId = readActiveRemoteId();
      const remembered = [...lists.active, ...lists.archived].find(project => project.id === rememberedId);
      if (remembered) {
        try {
          const remote = await client.readProject(remembered.id);
          const marker = projectMarker(lifecycleRef.current);
          const matchesRecoveryCopy = canonicalJson(remote.document) === canonicalJson(documentRef.current);
          setActiveRemote(remote, matchesRecoveryCopy ? marker : null);
          setSyncStatus(matchesRecoveryCopy ? 'saved' : 'waiting');
        } catch (error) {
          setActiveRemote(null);
          setSyncError(normalizeError(error));
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
  }, [client, refreshProjects, setActiveRemote]);

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
      setOnline(true);
      setRefreshTick(value => value + 1);
    };
    const onOffline = () => {
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

  const performSaveRef = useRef(null);
  const performSave = useCallback(async (marker = projectMarker(lifecycleRef.current), document = documentRef.current) => {
    const remote = activeRemoteRef.current;
    if (!remote || sessionRef.current.status !== 'authenticated') return { ok: false, reason: 'unassociated' };
    if (conflict) return { ok: false, reason: 'conflict' };
    if (!online || navigator.onLine === false) {
      setSyncStatus('waiting');
      return { ok: false, reason: 'offline' };
    }
    if (inFlightRef.current) {
      queuedRef.current = true;
      return { ok: false, reason: 'queued' };
    }

    inFlightRef.current = true;
    setSyncStatus('saving');
    setSyncError(null);
    const remoteId = remote.id;
    const baseRevision = remote.revision;
    const capturedKey = markerKey(marker);
    try {
      const acknowledged = await client.updateProject(remoteId, {
        baseRevision,
        title: document.name || remote.title,
        project: document,
      });
      if (!mountedRef.current || activeRemoteRef.current?.id !== remoteId) return { ok: false, reason: 'replaced' };
      activeRemoteRef.current = acknowledged;
      setActiveRemoteProject(acknowledged);
      acknowledgedMarkerRef.current = marker;
      setProjectsByState(current => ({
        active: current.active.map(item => item.id === acknowledged.id ? acknowledged : item),
        archived: current.archived.map(item => item.id === acknowledged.id ? acknowledged : item),
      }));
      const currentMarker = projectMarker(lifecycleRef.current);
      if (markerKey(currentMarker) === capturedKey) {
        markProjectPersisted('cloud', marker);
        setSyncStatus('saved');
      } else {
        queuedRef.current = true;
        setSyncStatus('waiting');
      }
      return { ok: true, project: acknowledged };
    } catch (rawError) {
      const error = normalizeError(rawError);
      if (error.state === 'conflict') {
        setConflict({ remoteId, localDocument: documentRef.current, error });
        setSyncStatus('conflict');
      } else {
        setSyncError(error);
        setSyncStatus(error.state === 'offline' || navigator.onLine === false ? 'waiting' : 'error');
        clearTimeout(retryRef.current);
        retryRef.current = setTimeout(() => setRefreshTick(value => value + 1), CLOUD_RETRY_MS);
      }
      return { ok: false, reason: error.state, error };
    } finally {
      inFlightRef.current = false;
      if (queuedRef.current && !conflict) {
        queuedRef.current = false;
        setRefreshTick(value => value + 1);
      }
    }
  }, [client, conflict, markProjectPersisted, online]);
  performSaveRef.current = performSave;

  useEffect(() => {
    clearTimeout(saveTimerRef.current);
    const remote = activeRemoteProject;
    if (!remote || session.status !== 'authenticated' || conflict) return undefined;
    const currentMarker = projectMarker(projectLifecycle);
    const acknowledgedMarker = acknowledgedMarkerRef.current;
    if (acknowledgedMarker && markerKey(acknowledgedMarker) === markerKey(currentMarker)) {
      if (!inFlightRef.current) setSyncStatus('saved');
      return undefined;
    }
    if (acknowledgedMarker && currentMarker.generation < acknowledgedMarker.generation) return undefined;
    setSyncStatus(online ? 'pending' : 'waiting');
    if (!online) return undefined;
    const capturedMarker = currentMarker;
    const capturedDocument = structuredClone(documentRef.current);
    saveTimerRef.current = setTimeout(() => {
      void performSaveRef.current?.(capturedMarker, capturedDocument);
    }, CLOUD_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(saveTimerRef.current);
  }, [activeRemoteProject, conflict, online, projectLifecycle.editedRevision, projectLifecycle.generation, refreshTick, session.status]);

  const associateOpenedProject = useCallback(async (remote, { force = false } = {}) => {
    const result = await replaceProject(remote.document, force ? { confirmDiscard: () => true } : undefined);
    if (!result.ok) return result;
    const nextMarker = { generation: lifecycleRef.current.generation + 1, revision: 0 };
    setConflict(null);
    setSyncError(null);
    setActiveRemote(remote, nextMarker);
    setSyncStatus('saved');
    return { ok: true, project: remote };
  }, [replaceProject, setActiveRemote]);

  const createProject = useCallback(async (title) => {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) return { ok: false, reason: 'title-required' };
    try {
      const document = structuredClone(documentRef.current);
      const titleChanged = document.name !== cleanTitle;
      document.name = cleanTitle;
      const created = await client.createProject({ title: cleanTitle, project: document });
      const marker = projectMarker(lifecycleRef.current);
      const acknowledgedMarker = titleChanged ? { ...marker, revision: marker.revision + 1 } : marker;
      if (titleChanged) setProjectName(cleanTitle);
      setActiveRemote(created, acknowledgedMarker);
      markProjectPersisted('cloud', acknowledgedMarker);
      setSyncStatus('saved');
      setSyncError(null);
      await refreshProjects();
      return { ok: true, project: created };
    } catch (error) {
      setSyncError(normalizeError(error));
      return { ok: false, error: normalizeError(error) };
    }
  }, [client, markProjectPersisted, refreshProjects, setActiveRemote, setProjectName]);

  const openProject = useCallback(async (projectOrId, options) => {
    const id = typeof projectOrId === 'string' ? projectOrId : projectOrId.id;
    try {
      return await associateOpenedProject(await client.readProject(id), options);
    } catch (error) {
      setSyncError(normalizeError(error));
      return { ok: false, error: normalizeError(error) };
    }
  }, [associateOpenedProject, client]);

  const saveNow = useCallback(async () => {
    clearTimeout(saveTimerRef.current);
    const marker = projectMarker(lifecycleRef.current);
    if (acknowledgedMarkerRef.current && markerKey(acknowledgedMarkerRef.current) === markerKey(marker)) {
      setSyncStatus('saved');
      return { ok: true, project: activeRemoteRef.current, unchanged: true };
    }
    return performSave(marker, structuredClone(documentRef.current));
  }, [performSave]);

  const detachProject = useCallback(() => {
    clearTimeout(saveTimerRef.current);
    setConflict(null);
    setSyncError(null);
    setActiveRemote(null);
    setSyncStatus('idle');
  }, [setActiveRemote]);

  const renameProject = useCallback(async (project, title) => {
    const cleanTitle = String(title || '').trim();
    if (!cleanTitle) return { ok: false, reason: 'title-required' };
    try {
      clearTimeout(saveTimerRef.current);
      const isActive = activeRemoteRef.current?.id === project.id;
      const opened = isActive ? { ...project, document: structuredClone(documentRef.current) } : await client.readProject(project.id);
      const updated = await client.updateProject(project.id, {
        baseRevision: project.revision,
        title: cleanTitle,
        project: opened.document,
      });
      if (isActive) {
        setActiveRemote(updated, projectMarker(lifecycleRef.current));
        markProjectPersisted('cloud', projectMarker(lifecycleRef.current));
        setSyncStatus('saved');
      }
      await refreshProjects();
      return { ok: true, project: updated };
    } catch (error) {
      setSyncError(normalizeError(error));
      return { ok: false, error: normalizeError(error) };
    }
  }, [client, markProjectPersisted, refreshProjects, setActiveRemote]);

  const duplicateProject = useCallback(async (project, title) => {
    try {
      const duplicate = await client.duplicateProject(project.id, title ? { title } : undefined);
      await refreshProjects();
      return { ok: true, project: duplicate };
    } catch (error) {
      setSyncError(normalizeError(error));
      return { ok: false, error: normalizeError(error) };
    }
  }, [client, refreshProjects]);

  const changeArchiveState = useCallback(async (project, archived) => {
    try {
      const updated = await client.setArchived(project.id, archived, { baseRevision: project.revision });
      if (activeRemoteRef.current?.id === updated.id) {
        activeRemoteRef.current = updated;
        setActiveRemoteProject(updated);
      }
      await refreshProjects();
      return { ok: true, project: updated };
    } catch (error) {
      setSyncError(normalizeError(error));
      return { ok: false, error: normalizeError(error) };
    }
  }, [client, refreshProjects]);

  const archiveProject = useCallback(project => changeArchiveState(project, true), [changeArchiveState]);
  const unarchiveProject = useCallback(project => changeArchiveState(project, false), [changeArchiveState]);

  const deleteProject = useCallback(async (project) => {
    try {
      await client.deleteProject(project.id, { baseRevision: project.revision, confirmation: 'DELETE' });
      if (activeRemoteRef.current?.id === project.id) setActiveRemote(null);
      await refreshProjects();
      return { ok: true };
    } catch (error) {
      setSyncError(normalizeError(error));
      return { ok: false, error: normalizeError(error) };
    }
  }, [client, refreshProjects, setActiveRemote]);

  const listHistory = useCallback(project => client.listRevisions(project.id), [client]);

  const restoreHistory = useCallback(async (project, revision) => {
    try {
      await client.restoreRevision(project.id, revision, { baseRevision: project.revision });
      const restored = await client.readProject(project.id);
      await refreshProjects();
      return associateOpenedProject(restored, { force: true });
    } catch (error) {
      setSyncError(normalizeError(error));
      return { ok: false, error: normalizeError(error) };
    }
  }, [associateOpenedProject, client, refreshProjects]);

  const exportProject = useCallback(async project => {
    try {
      const opened = await client.readProject(project.id);
      // The network read completes after the click's transient user activation;
      // use the deterministic anchor path instead of reopening a native picker.
      return downloadJsonFile(canonicalProjectFileName(opened.title), opened.document, { preferPicker: false });
    } catch (error) {
      setSyncError(normalizeError(error));
      return false;
    }
  }, [client]);

  const importProject = useCallback(async candidate => {
    const project = migrateProject(candidate);
    if (!project || isLibraryBackup(candidate)) return { ok: false, reason: 'invalid' };
    try {
      const created = await client.createProject({ title: project.name || 'Imported project', project });
      await refreshProjects();
      return { ok: true, project: created };
    } catch (error) {
      setSyncError(normalizeError(error));
      return { ok: false, error: normalizeError(error) };
    }
  }, [client, refreshProjects]);

  const exportMaster = useCallback(async () => {
    try {
      const blob = await client.downloadBackup();
      return downloadTextFile(canonicalLibraryBackupFileName(new Date()), await blob.text(), {
        type: 'application/json',
        preferPicker: false,
      });
    } catch (error) {
      setSyncError(normalizeError(error));
      return false;
    }
  }, [client]);

  const restoreMaster = useCallback(async candidate => {
    if (!isLibraryBackup(candidate)) return { ok: false, reason: 'invalid' };
    try {
      const summary = await client.restoreBackup(candidate);
      await refreshProjects();
      return { ok: true, summary };
    } catch (error) {
      setSyncError(normalizeError(error));
      return { ok: false, error: normalizeError(error) };
    }
  }, [client, refreshProjects]);

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
      } catch {
        rejected += 1;
      }
    }
    writeClaimedBrowserProjectIds(claimedIds);
    setBrowserClaimRevision(value => value + 1);
    await refreshProjects();
    return { imported, rejected };
  }, [client, refreshProjects]);

  const resolveConflict = useCallback(async action => {
    const currentConflict = conflict;
    if (!currentConflict) return { ok: false, reason: 'no-conflict' };
    if (action === 'open-latest') {
      try {
        const latest = await client.readProject(currentConflict.remoteId);
        setConflict(null);
        return associateOpenedProject(latest, { force: true });
      } catch (error) {
        setSyncError(normalizeError(error));
        return { ok: false, error: normalizeError(error) };
      }
    }
    if (action === 'save-copy') {
      try {
        const localDocument = structuredClone(documentRef.current || currentConflict.localDocument);
        localDocument.id = createProjectId();
        localDocument.name = `${localDocument.name || projectName || 'Untitled Project'} copy`;
        const created = await client.createProject({ title: localDocument.name, project: localDocument });
        setConflict(null);
        await refreshProjects();
        await associateOpenedProject({ ...created, document: localDocument }, { force: true });
        return { ok: true, project: created };
      } catch (error) {
        setSyncError(normalizeError(error));
        return { ok: false, error: normalizeError(error) };
      }
    }
    return { ok: false, reason: 'unknown-action' };
  }, [associateOpenedProject, client, conflict, projectName, refreshProjects]);

  const claimedBrowserIds = readClaimedBrowserProjectIds();
  const browserProjects = listProjectLibraryRecords().filter(record => !claimedBrowserIds.has(record.id));
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
    restoreHistory, restoreMaster, saveNow, session, syncState, unarchiveProject,
  ]);

  return <CloudLibraryContext.Provider value={value}>{children}</CloudLibraryContext.Provider>;
}

export function useCloudLibrary() {
  const value = useContext(CloudLibraryContext);
  if (!value) throw new Error('useCloudLibrary must be used inside CloudLibraryProvider.');
  return value;
}
