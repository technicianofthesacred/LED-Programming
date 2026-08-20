// THE Projects surface — one panel, opened from the top bar, that owns every
// project persistence question: what the current project is and where it is
// saved, the browser library (open/rename/duplicate/delete, with the 24-record
// cap made visible), the online library (ProjectLibraryPanel, moved here from
// Preferences intact — signed out it renders its sign-in panel right here),
// import/export of portable project files, and the automatic recovery copy.
//
// Deliberately NOT here: card-project adoption. Card Home owns "use the
// project on this card" — a project offer here would be a second Load surface
// for the same guarded adoption, the exact duplication phases 4-5 removed.
//
// The panel is a NON-modal sheet: the workspace stays live beside it, so the
// owner can rename the project in Preferences or hit Save in the top bar while
// watching the library react. Dialogs the panel spawns (history, delete
// confirm, replace confirm) are modal portals that stack above it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../../state/ProjectContext.jsx';
import { useCloudLibrary } from '../../state/CloudLibraryContext.jsx';
import {
  PROJECT_LIBRARY_CHANGED_EVENT,
  PROJECT_LIBRARY_LIMIT,
  deleteProjectLibraryRecord,
  duplicateProjectLibraryRecord,
  listProjectLibraryRecords,
  readActiveProjectLibraryRecordId,
  renameProjectLibraryRecordGuarded,
} from '../../lib/projectStorage.js';
import { ProjectLibraryPanel } from './ProjectLibraryPanel.jsx';

// Preferences (and any other surface) asks the shell to open the panel by
// dispatching this event — the same pattern the Connect panel uses.
export const OPEN_PROJECTS_PANEL_EVENT = 'lightweaver-open-projects-panel';

export function requestProjectsPanel() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_PROJECTS_PANEL_EVENT));
}

function formatRecoveryTime(lastSaved) {
  if (!lastSaved) return 'No recovery copy yet';
  return `Recovery copy ${new Date(lastSaved).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function describeAssociation({ activeRemoteProject, browserRecord, persistedDestination }) {
  if (activeRemoteProject) return `Saved online as ${activeRemoteProject.title}`;
  if (browserRecord) return `Saved in this browser as ${browserRecord.name}`;
  if (persistedDestination === 'file') return 'Exported as a project file';
  if (persistedDestination === 'card') return 'Saved on the card';
  return 'Not saved yet';
}

export function ProjectsPanel({
  open,
  onClose,
  onOpenBrowserProject,
  onOpenFailure,
  onImport,
  onExport,
  onLibraryMutated,
}) {
  const {
    projectName,
    serializeProject,
    projectLifecycle,
    projectLifecycleLabel,
    projectHasUnsavedChanges,
    lastSaved,
    autosaveStatus,
  } = useProject();
  const library = useCloudLibrary();
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState(() => listProjectLibraryRecords());
  const [renaming, setRenaming] = useState(null);
  const [rowNotice, setRowNotice] = useState('');
  const closeRef = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const sync = () => setRecords(listProjectLibraryRecords());
    sync();
    setQuery('');
    setRenaming(null);
    setRowNotice('');
    window.addEventListener(PROJECT_LIBRARY_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(PROJECT_LIBRARY_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [open]);

  // Focus lands in the panel on open (search when there is one, else the
  // close control) and returns to whatever opened it on close — the panel is
  // non-modal, so this is the whole keyboard contract.
  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = typeof document !== 'undefined' ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      (searchRef.current || closeRef.current)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.requestAnimationFrame(() => {
        if (previousFocus?.isConnected) previousFocus.focus?.();
      });
    };
  }, [open]);

  // Escape closes the panel while focus is inside it. Deliberately NOT a
  // window listener: the panel is non-modal, so an Escape aimed at the
  // workspace (deselect in Layout, cancel a draw) must keep meaning that.
  // Events from modal portals the panel spawned (history, delete confirm)
  // propagate through the React tree but their targets live outside the
  // panel's DOM, so the containment check leaves those dialogs to their own
  // Escape handling.
  const sectionRef = useRef(null);
  const onPanelKeyDown = event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (!(event.target instanceof Node) || !sectionRef.current?.contains(event.target)) return;
    event.stopPropagation();
    onClose();
  };

  const shownRecords = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return records;
    return records.filter(record => record.name.toLocaleLowerCase().includes(needle));
  }, [records, query]);

  if (!open) return null;

  const currentProjectId = serializeProject().id;
  const activeRecordId = readActiveProjectLibraryRecordId();
  const browserRecord = !library.activeRemoteProject && activeRecordId
    ? records.find(record => record.id === activeRecordId && record.project?.id === currentProjectId) || null
    : null;
  const atCapacity = records.length >= PROJECT_LIBRARY_LIMIT;

  const openRecord = async record => {
    onClose();
    const result = await onOpenBrowserProject(record);
    if (!result?.ok && !['cancelled', 'superseded'].includes(result?.reason)) onOpenFailure(result);
  };

  const saveRename = async () => {
    const target = renaming;
    if (!target) return;
    const result = await renameProjectLibraryRecordGuarded(target.id, target.name);
    if (!result.ok) {
      setRowNotice(result.reason === 'invalid-name'
        ? 'Give the project a name before saving it.'
        : 'The browser copy could not be renamed. Try again.');
      return;
    }
    setRenaming(null);
    setRowNotice('');
    onLibraryMutated?.();
  };

  const duplicateRecord = record => {
    try {
      const copy = duplicateProjectLibraryRecord(record.id);
      setRowNotice(copy ? '' : 'That browser copy is no longer available.');
    } catch {
      setRowNotice('The browser copy could not be duplicated.');
    }
    onLibraryMutated?.();
  };

  const deleteRecord = record => {
    if (!window.confirm(`Delete "${record.name}" from this browser? This only removes the browser copy.`)) return;
    try {
      deleteProjectLibraryRecord(record.id);
      setRowNotice('');
    } catch {
      setRowNotice('The browser copy could not be deleted.');
    }
    onLibraryMutated?.();
  };

  return (
    <section
      ref={sectionRef}
      className="projects-panel"
      role="dialog"
      aria-label="Projects"
      data-testid="projects-panel"
      onKeyDown={onPanelKeyDown}
    >
      <div className="cloud-dialog-heading">
        <div>
          <span className="cloud-kicker">One place for every copy</span>
          <h2>Projects</h2>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="btn ghost-sm topbar-dialog-close"
          aria-label="Close Projects"
          onClick={onClose}
        >×</button>
      </div>

      <div className="projects-current" data-testid="projects-current">
        <div className="projects-current-name">
          <strong>{projectName || 'Untitled'}</strong>
          {projectHasUnsavedChanges && (
            <span className="proj-dirty" data-testid="projects-current-dirty" role="img" aria-label="Unsaved changes" title="Unsaved changes" />
          )}
          {projectLifecycleLabel && <span className="proj-status">{projectLifecycleLabel}</span>}
        </div>
        <span className="projects-current-association" data-testid="projects-association">
          {describeAssociation({
            activeRemoteProject: library.activeRemoteProject,
            browserRecord,
            persistedDestination: projectLifecycle?.persistedDestination,
          })}
        </span>
      </div>

      <div className="topbar-project-source">
        <div className="projects-source-heading">
          <h3>On this device</h3>
          {records.length >= 20 && (
            <span className="projects-cap" data-testid="browser-library-cap">
              {records.length} of {PROJECT_LIBRARY_LIMIT} saved
            </span>
          )}
        </div>
        {records.length > 0 && (
          <label className="topbar-project-search">
            <span className="sr-only">Search projects</span>
            <input
              ref={searchRef}
              type="search"
              className="pm-input"
              aria-label="Search projects"
              placeholder="Search projects"
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
          </label>
        )}
        <div className="topbar-project-list">
          {shownRecords.map(record => (
            <div className="topbar-project-row" data-testid="browser-project-row" key={record.id}>
              {renaming?.id === record.id ? (
                <div className="cloud-rename">
                  <input
                    autoFocus
                    className="pm-input"
                    aria-label="Rename browser project"
                    maxLength={160}
                    value={renaming.name}
                    onChange={event => setRenaming({ id: record.id, name: event.target.value })}
                    onKeyDown={event => {
                      if (event.key === 'Enter') { event.preventDefault(); void saveRename(); }
                      else if (event.key === 'Escape') { event.stopPropagation(); setRenaming(null); }
                    }}
                  />
                  <button type="button" className="btn primary ghost-sm" onClick={() => void saveRename()}>Save name</button>
                  <button type="button" className="btn ghost-sm" onClick={() => setRenaming(null)}>Cancel</button>
                </div>
              ) : (
                <>
                  <span>{record.name}</span>
                  <div className="projects-row-actions">
                    <button type="button" className="btn ghost-sm" aria-label={`Open ${record.name}`} onClick={() => void openRecord(record)}>Open</button>
                    <button type="button" className="btn ghost-sm" aria-label={`Rename ${record.name}`} onClick={() => { setRowNotice(''); setRenaming({ id: record.id, name: record.name }); }}>Rename</button>
                    <button
                      type="button"
                      className="btn ghost-sm"
                      aria-label={`Duplicate ${record.name}`}
                      disabled={atCapacity}
                      title={atCapacity ? `This browser keeps at most ${PROJECT_LIBRARY_LIMIT} projects — delete one first.` : undefined}
                      onClick={() => duplicateRecord(record)}
                    >Duplicate</button>
                    <button type="button" className="btn ghost-sm danger" aria-label={`Delete ${record.name}`} onClick={() => deleteRecord(record)}>Delete</button>
                  </div>
                </>
              )}
            </div>
          ))}
          {!shownRecords.length && (
            <p className="topbar-project-empty">
              {records.length ? 'No browser projects match.' : 'No projects saved in this browser yet.'}
            </p>
          )}
        </div>
        {rowNotice && <p className="cloud-library-notice" role="alert">{rowNotice}</p>}
      </div>

      <div className="topbar-project-secondary">
        <button type="button" className="btn" onClick={() => { onClose(); onImport(); }}>Import from computer</button>
        <button type="button" className="btn" onClick={onExport}>Export to computer</button>
      </div>

      <div className="topbar-project-source projects-recovery">
        <h3>Recovery copy</h3>
        <div className="set-recovery" data-testid="autosave-status">
          <span>
            {formatRecoveryTime(lastSaved)}
            {autosaveStatus?.restoredFrom ? ` · restored from ${autosaveStatus.restoredFrom === 'legacy' ? 'an older Studio save' : 'the recovery copy'} this session` : ''}
            {' — the automatic backup Studio keeps while you work, not your saved project'}
          </span>
          {autosaveStatus?.quarantine && (
            <span className="set-recovery-warn" data-testid="autosave-quarantine">
              A saved copy from a newer or damaged Studio session could not be opened. It was preserved untouched so support can recover it.
              <button type="button" className="btn ghost-sm" onClick={() => autosaveStatus.dismissQuarantine()}>Dismiss</button>
            </span>
          )}
        </div>
      </div>

      <div className="projects-online">
        <ProjectLibraryPanel />
      </div>
    </section>
  );
}
