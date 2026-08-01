import { useMemo, useRef, useState } from 'react';

import { isLibraryBackup } from '../../lib/libraryBackup.js';
import { useCloudLibrary } from '../../state/CloudLibraryContext.jsx';
import { CloudLibraryDialogPortal, ProjectHistoryDialog } from './ProjectHistoryDialog.jsx';

const MAX_PROJECT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MASTER_BACKUP_BYTES = 8 * 1024 * 1024;

function formatTime(value) {
  if (!value) return 'Not dated';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

async function readJsonFile(file) {
  return JSON.parse(await file.text());
}

export function ProjectLibraryPanel() {
  const library = useCloudLibrary();
  const [view, setView] = useState('active');
  const [query, setQuery] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [rename, setRename] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState('');
  const [historyProject, setHistoryProject] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const projectImportRef = useRef(null);
  const masterRestoreRef = useRef(null);
  const deleteDialogRef = useRef(null);
  const deleteCancelRef = useRef(null);

  const sourceProjects = view === 'archived' ? library.archivedProjects : library.activeProjects;
  const shownProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return sourceProjects;
    return sourceProjects.filter(project => project.title.toLocaleLowerCase().includes(normalized));
  }, [query, sourceProjects]);

  const run = async (key, action, success) => {
    setBusy(key);
    setNotice('');
    try {
      const result = await action();
      if (result?.ok === false) {
        setNotice(result.reason === 'invalid'
          ? 'That file is not a supported Lightweaver project or master backup.'
          : result.error?.message || 'The online library could not complete that action.');
        return result;
      }
      if (success) setNotice(typeof success === 'function' ? success(result) : success);
      return result;
    } finally {
      setBusy('');
    }
  };

  const create = async () => {
    const result = await run('create', () => library.createProject(newTitle), created => `Created ${created.project.title} online.`);
    if (result?.ok) setNewTitle('');
    if (result?.reason === 'title-required') setNotice('Give the project a useful title before saving it online.');
  };

  const beginHistory = async project => {
    setHistoryProject(project);
    setHistoryLoading(true);
    setHistory([]);
    try {
      setHistory(await library.listHistory(project));
    } catch (error) {
      setNotice(error?.message || 'Project history could not be loaded.');
      setHistoryProject(null);
    } finally {
      setHistoryLoading(false);
    }
  };

  const restoreRevision = async revision => {
    const project = historyProject;
    const result = await run(`restore-${revision}`, () => library.restoreHistory(project, revision), `Restored revision ${revision} as a new online revision.`);
    if (result?.ok) setHistoryProject(null);
  };

  const importIndividual = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_PROJECT_FILE_BYTES) {
      setNotice('Project files must be 2 MB or smaller.');
      return;
    }
    try {
      const candidate = await readJsonFile(file);
      await run('import-project', () => library.importProject(candidate), result => `Imported ${result.project.title}.`);
    } catch {
      setNotice('That project file could not be read.');
    }
  };

  const restoreMaster = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_MASTER_BACKUP_BYTES) {
      setNotice('Master backups must be 8 MB or smaller.');
      return;
    }
    try {
      const candidate = await readJsonFile(file);
      if (!isLibraryBackup(candidate)) {
        setNotice('That file is not a Lightweaver master backup.');
        return;
      }
      const result = await run('restore-master', () => library.restoreMaster(candidate));
      if (result?.ok) {
        setNotice(`Restored ${plural(result.summary.projectsCreated, 'project')} and ${plural(result.summary.assetsCreated, 'workspace asset')}`);
      }
    } catch {
      setNotice('That master backup could not be read.');
    }
  };

  const claimBrowserProjects = async () => {
    const result = await run('claim', library.claimBrowserProjects);
    if (!result) return;
    const rejected = result.rejected ? ` · ${plural(result.rejected, 'project')} could not be imported` : '';
    setNotice(`${plural(result.imported, 'browser project')} brought online${rejected}`);
  };

  const saveRename = async () => {
    const result = await run(`rename-${rename.project.id}`, () => library.renameProject(rename.project, rename.title), `Renamed project to ${rename.title}.`);
    if (result?.ok) setRename(null);
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    const result = await run(`delete-${target.id}`, () => library.deleteProject(target), `Deleted ${target.title} permanently.`);
    if (result?.ok) {
      setDeleteTarget(null);
      setDeleteConfirmation('');
    }
  };

  return (
    <div className="cloud-library" data-testid="project-library-panel">
      <div className="cloud-library-heading">
        <div>
          <span className="cloud-kicker">Private workspace</span>
          <h3>Online project library</h3>
        </div>
        {library.session.status === 'authenticated' && (
          <div className="cloud-identity">
            <strong>{library.session.email}</strong>
            <span>{library.session.role === 'owner' ? 'Owner' : 'Worker'}</span>
          </div>
        )}
      </div>

      {library.session.status === 'loading' && <p role="status">Checking online library access…</p>}
      {library.session.status === 'unauthenticated' && (
        <div className="cloud-library-guidance">
          <strong>Sign in to use the online project library</strong>
          <p>Your browser recovery copy is still working. Sign in through Lightweaver’s private access page to save across devices.</p>
          <button type="button" className="btn primary" onClick={library.signIn}>Sign in</button>
        </div>
      )}
      {library.session.status === 'error' && (
        <div className="cloud-library-guidance">
          <strong>The online library is unavailable</strong>
          <p>{library.session.error?.message || 'Your browser recovery copy is still safe.'}</p>
          <button type="button" className="btn" onClick={library.retrySession}>Try again</button>
        </div>
      )}

      {library.session.status === 'authenticated' && (
        <>
          <div className={`cloud-sync cloud-sync-${library.syncState.status}`} data-testid="cloud-sync-status" role="status">
            <span className="cloud-sync-dot" />
            <strong>{library.syncState.label}</strong>
            {!library.syncState.online && <span>Browser recovery continues while offline.</span>}
          </div>

          {library.syncState.conflict && (
            <div className="cloud-conflict">
              <div><strong>Both versions are safe.</strong><span>Choose which version to open; nothing will be overwritten silently.</span></div>
              <div className="set-actions">
                <button type="button" className="btn" onClick={() => run('open-latest', () => library.resolveConflict('open-latest'))}>Open latest</button>
                <button type="button" className="btn primary" onClick={() => run('save-copy', () => library.resolveConflict('save-copy'))}>Save as copy</button>
              </div>
            </div>
          )}

          <div className="cloud-create-row">
            <label htmlFor="cloud-new-project-title">Save this artwork online</label>
            <input
              id="cloud-new-project-title"
              className="pm-input"
              aria-label="Online project title"
              value={newTitle}
              onChange={event => setNewTitle(event.target.value)}
              placeholder="Artwork title"
              maxLength={160}
            />
            <button type="button" className="btn primary" disabled={busy === 'create'} onClick={create}>Create online project</button>
          </div>

          <div className="cloud-library-tools">
            <button type="button" className="btn" onClick={() => projectImportRef.current?.click()}>Import project</button>
            <input ref={projectImportRef} data-testid="cloud-project-import" type="file" accept=".lw.json,.lwproj.json,.json" hidden onChange={importIndividual} />
            <button type="button" className="btn" onClick={library.exportMaster}>Download master backup</button>
            <button type="button" className="btn" onClick={() => masterRestoreRef.current?.click()}>Restore master backup</button>
            <input ref={masterRestoreRef} data-testid="cloud-master-restore" type="file" accept=".lw-library.json,.json" hidden onChange={restoreMaster} />
            {library.browserProjects.length > 0 && (
              <button type="button" className="btn" disabled={busy === 'claim'} onClick={claimBrowserProjects}>Bring browser projects online</button>
            )}
          </div>

          <div className="cloud-library-filter">
            <div className="mini-seg" role="group" aria-label="Project state">
              <button type="button" aria-label="Active projects" aria-pressed={view === 'active'} className={view === 'active' ? 'on' : ''} onClick={() => setView('active')}>Active</button>
              <button type="button" aria-label="Archived projects" aria-pressed={view === 'archived'} className={view === 'archived' ? 'on' : ''} onClick={() => setView('archived')}>Archived</button>
            </div>
            <input className="pm-input" type="search" aria-label="Search online projects" placeholder="Search projects" value={query} onChange={event => setQuery(event.target.value)} />
          </div>

          <div className="cloud-project-list">
            {shownProjects.length === 0 ? (
              <div className="set-lib-empty">{query ? 'No projects match this search.' : `No ${view} projects online yet.`}</div>
            ) : shownProjects.map(project => (
              <article className={`cloud-project-row${library.activeRemoteProject?.id === project.id ? ' is-active' : ''}`} data-testid="cloud-project-row" key={project.id}>
                <div className="cloud-project-main">
                  {rename?.project.id === project.id ? (
                    <div className="cloud-rename">
                      <input autoFocus className="pm-input" aria-label="Rename project" maxLength={160} value={rename.title} onChange={event => setRename({ project, title: event.target.value })} />
                      <button type="button" className="btn primary ghost-sm" onClick={saveRename}>Save name</button>
                      <button type="button" className="btn ghost-sm" onClick={() => setRename(null)}>Cancel</button>
                    </div>
                  ) : <strong>{project.title}</strong>}
                  <span>{formatTime(project.updatedAt)} · {project.lastEditor || 'Unknown editor'} · revision {project.revision}</span>
                </div>
                <div className="cloud-project-actions">
                  <button type="button" className="btn ghost-sm" onClick={() => run(`open-${project.id}`, () => library.openProject(project))}>Open</button>
                  <button type="button" className="btn ghost-sm" onClick={() => setRename({ project, title: project.title })}>Rename</button>
                  <button type="button" className="btn ghost-sm" onClick={() => run(`duplicate-${project.id}`, () => library.duplicateProject(project))}>Duplicate</button>
                  <button type="button" className="btn ghost-sm" onClick={() => beginHistory(project)}>History</button>
                  <button type="button" className="btn ghost-sm" onClick={() => library.exportProject(project)}>Export</button>
                  {project.archived ? (
                    <button type="button" className="btn ghost-sm" onClick={() => run(`unarchive-${project.id}`, () => library.unarchiveProject(project))}>Unarchive</button>
                  ) : (
                    <button type="button" className="btn ghost-sm" onClick={() => run(`archive-${project.id}`, () => library.archiveProject(project))}>Archive</button>
                  )}
                  {project.archived && library.session.role === 'owner' && (
                    <button type="button" className="btn ghost-sm danger" onClick={() => { setDeleteTarget(project); setDeleteConfirmation(''); }}>Delete permanently</button>
                  )}
                </div>
              </article>
            ))}
          </div>
          {notice && <p className="cloud-library-notice" role="status">{notice}</p>}
        </>
      )}

      {historyProject && (
        <ProjectHistoryDialog
          project={historyProject}
          revisions={history}
          loading={historyLoading}
          onClose={() => setHistoryProject(null)}
          onRestore={restoreRevision}
        />
      )}

      {deleteTarget && (
        <CloudLibraryDialogPortal
          dialogRef={deleteDialogRef}
          initialFocusRef={deleteCancelRef}
          onClose={() => {
            setDeleteTarget(null);
            setDeleteConfirmation('');
          }}
        >
          <div className="cloud-library-backdrop">
            <section ref={deleteDialogRef} className="cloud-library-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-delete-title">
            <span className="cloud-kicker">Owner-only permanent action</span>
            <h2 id="cloud-delete-title">Delete {deleteTarget.title} permanently?</h2>
            <p>This removes the archived project and all of its online history. Download a backup first if it may be needed later.</p>
            <label htmlFor="cloud-delete-confirmation">Type <strong>{deleteTarget.title}</strong> to confirm</label>
            <input id="cloud-delete-confirmation" className="pm-input" aria-label="Type project title to confirm" value={deleteConfirmation} onChange={event => setDeleteConfirmation(event.target.value)} />
            <div className="set-actions">
              <button ref={deleteCancelRef} type="button" className="btn" onClick={() => { setDeleteTarget(null); setDeleteConfirmation(''); }}>Cancel</button>
              <button type="button" className="btn danger" disabled={deleteConfirmation !== deleteTarget.title} onClick={confirmDelete}>Delete permanently</button>
            </div>
            </section>
          </div>
        </CloudLibraryDialogPortal>
      )}
    </div>
  );
}
