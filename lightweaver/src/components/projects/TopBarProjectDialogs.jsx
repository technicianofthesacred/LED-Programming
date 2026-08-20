import { useRef, useState } from 'react';
import { useCloudLibrary } from '../../state/CloudLibraryContext.jsx';
import { CloudLibraryDialogPortal } from './ProjectHistoryDialog.jsx';

// The top-bar Load dialog that used to live here was replaced by the one
// Projects panel (ProjectsPanel.jsx) — browser library, online library,
// import/export, and the recovery copy in one surface.

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
    else if (result.reason === 'stale-session') setError('Your session changed. Sign in again from Projects.');
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
