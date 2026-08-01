import { useEffect, useRef } from 'react';

function formatRevisionTime(value) {
  if (!value) return 'Time unavailable';
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ProjectHistoryDialog({ project, revisions, loading, onClose, onRestore }) {
  const closeRef = useRef(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!project) return null;
  return (
    <div className="cloud-library-backdrop">
      <section className="cloud-library-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-history-title">
        <div className="cloud-dialog-heading">
          <div>
            <span className="cloud-kicker">Immutable revisions</span>
            <h2 id="cloud-history-title">Project history</h2>
            <p>{project.title}</p>
          </div>
          <button ref={closeRef} type="button" className="btn ghost-sm" onClick={onClose}>Close</button>
        </div>
        {loading ? <p role="status">Loading history…</p> : (
          <div className="cloud-history-list">
            {revisions.map(revision => (
              <div className="cloud-history-row" key={revision.revision} data-testid={`history-revision-${revision.revision}`}>
                <div>
                  <strong>Revision {revision.revision}</strong>
                  <span>{formatRevisionTime(revision.createdAt)} · {revision.editor || 'Unknown editor'}{revision.archived ? ' · archived' : ''}</span>
                </div>
                <button
                  type="button"
                  className="btn ghost-sm"
                  disabled={revision.revision === project.revision}
                  onClick={() => onRestore(revision.revision)}
                >
                  {revision.revision === project.revision ? 'Current' : 'Restore'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
