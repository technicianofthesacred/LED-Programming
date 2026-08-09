import { useMemo, useRef, useState } from 'react';
import { useCloudLibrary } from '../../state/CloudLibraryContext.jsx';
import { CloudLibraryDialogPortal } from './ProjectHistoryDialog.jsx';

export function ProjectLoadDialog({ browserProjects, onClose, onImport, onOpenBrowserProject, onOpenFailure, onOpenPreferences }) {
  const library = useCloudLibrary();
  const [query, setQuery] = useState('');
  const dialogRef = useRef(null);
  const searchRef = useRef(null);
  const closeRef = useRef(null);
  const signedIn = library.session.status === 'authenticated';
  const projects = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return library.activeProjects;
    return library.activeProjects.filter(project => project.title.toLocaleLowerCase().includes(needle));
  }, [library.activeProjects, query]);
  const browserMatches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return browserProjects;
    return browserProjects.filter(project => project.name.toLocaleLowerCase().includes(needle));
  }, [browserProjects, query]);

  const openProject = async project => {
    const opening = library.openProject(project);
    onClose();
    const result = await opening;
    if (!result?.ok && !['cancelled', 'superseded'].includes(result?.reason)) onOpenFailure(result);
  };

  const openBrowserProject = async project => {
    const opening = onOpenBrowserProject(project);
    onClose();
    const result = await opening;
    if (!result?.ok && !['cancelled', 'superseded'].includes(result?.reason)) onOpenFailure(result);
  };

  return (
    <CloudLibraryDialogPortal
      dialogRef={dialogRef}
      initialFocusRef={signedIn || browserProjects.length ? searchRef : closeRef}
      onClose={onClose}
    >
      <div className="cloud-library-backdrop">
        <section
          ref={dialogRef}
          className="cloud-library-dialog topbar-project-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="topbar-load-title"
        >
          <div className="cloud-dialog-heading">
            <div>
              <span className="cloud-kicker">Online library</span>
              <h2 id="topbar-load-title">Load project</h2>
            </div>
            <button ref={closeRef} type="button" className="btn ghost-sm topbar-dialog-close" aria-label="Close Load project" onClick={onClose}>×</button>
          </div>

          {(signedIn || browserProjects.length > 0) && (
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
          <div className="topbar-project-source">
            <h3>On this device</h3>
            <div className="topbar-project-list">
              {browserMatches.map(project => (
                <div className="topbar-project-row" key={project.id}>
                  <span>{project.name}</span>
                  <button
                    type="button"
                    className="btn ghost-sm"
                    aria-label={`Open ${project.name}`}
                    onClick={() => void openBrowserProject(project)}
                  >
                    Open
                  </button>
                </div>
              ))}
              {!browserMatches.length && <p className="topbar-project-empty">No browser projects match.</p>}
            </div>
          </div>
          {signedIn ? (
            <div className="topbar-project-source">
              <h3>Online library</h3>
              <div className="topbar-project-list">
                {projects.map(project => (
                  <div className="topbar-project-row" key={project.id}>
                    <span>{project.title}</span>
                    <button
                      type="button"
                      className="btn ghost-sm"
                      aria-label={`Open ${project.title}`}
                      onClick={() => void openProject(project)}
                    >
                      Open
                    </button>
                  </div>
                ))}
                {!projects.length && <p className="topbar-project-empty">No active projects match.</p>}
              </div>
            </div>
          ) : library.session.status === 'loading' ? (
            <p>Checking your online library…</p>
          ) : (
            <div className="topbar-project-signed-out">
              <p>Sign in from Preferences to open online projects.</p>
              <button type="button" className="btn primary" onClick={() => { onClose(); onOpenPreferences(); }}>Open Preferences</button>
            </div>
          )}
          <div className="topbar-project-secondary">
            <button type="button" className="btn" onClick={() => { onClose(); onImport(); }}>Import from computer</button>
          </div>
        </section>
      </div>
    </CloudLibraryDialogPortal>
  );
}

export function ProjectSaveDialog({ projectName, onClose }) {
  const library = useCloudLibrary();
  const [title, setTitle] = useState(projectName || 'Untitled project');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef(null);
  const titleRef = useRef(null);

  const save = async event => {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError('Enter a project title.');
      return;
    }
    setSaving(true);
    setError('');
    const result = await library.createProject(cleanTitle);
    setSaving(false);
    if (result.ok) onClose({ saved: true, project: result.project });
    else if (result.reason === 'stale-session') setError('Your session changed. Sign in again from Preferences.');
    else setError(result.error?.message || 'The project could not be saved online.');
  };

  return (
    <CloudLibraryDialogPortal dialogRef={dialogRef} initialFocusRef={titleRef} onClose={() => onClose({ saved: false })}>
      <div className="cloud-library-backdrop">
        <section
          ref={dialogRef}
          className="cloud-library-dialog topbar-project-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="topbar-save-title"
        >
          <div className="cloud-dialog-heading">
            <div>
              <span className="cloud-kicker">First online save</span>
              <h2 id="topbar-save-title">Save project online</h2>
              <p>Name this project once. Future saves will add revisions automatically.</p>
            </div>
            <button type="button" className="btn ghost-sm topbar-dialog-close" aria-label="Close Save project" onClick={() => onClose({ saved: false })}>×</button>
          </div>
          <form onSubmit={save}>
            <label className="topbar-project-title">
              <span>Project title</span>
              <input ref={titleRef} className="pm-input" aria-label="Project title" value={title} onChange={event => setTitle(event.target.value)} />
            </label>
            {error && <p className="cloud-library-notice" role="alert">{error}</p>}
            <div className="set-actions">
              <button type="button" className="btn" onClick={() => onClose({ saved: false })}>Cancel</button>
              <button type="submit" className="btn primary" disabled={saving || !title.trim()}>{saving ? 'Saving…' : 'Save online'}</button>
            </div>
          </form>
        </section>
      </div>
    </CloudLibraryDialogPortal>
  );
}
