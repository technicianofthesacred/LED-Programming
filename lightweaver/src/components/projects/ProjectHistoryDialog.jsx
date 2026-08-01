import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function useCloudDialogLifecycle({ open, backdropRef, dialogRef, initialFocusRef, onClose }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const previousFocus = document.activeElement;
    const backdrop = backdropRef.current;
    const background = [...(backdrop?.parentElement?.children || [])]
      .filter(element => element !== backdrop)
      .map(element => ({
        element,
        inert: element.inert,
        ariaHidden: element.getAttribute('aria-hidden'),
      }));
    for (const { element } of background) {
      element.inert = true;
      element.setAttribute('aria-hidden', 'true');
    }
    const focusFrame = window.requestAnimationFrame(() => initialFocusRef.current?.focus());
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [...(dialogRef.current?.querySelectorAll(FOCUSABLE) || [])]
        .filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener('keydown', onKeyDown);
      for (const { element, inert, ariaHidden } of background) {
        element.inert = inert;
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
      }
      window.requestAnimationFrame(() => {
        if (previousFocus?.isConnected) previousFocus.focus?.();
      });
    };
  }, [backdropRef, dialogRef, initialFocusRef, open]);
}

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
  const backdropRef = useRef(null);
  const dialogRef = useRef(null);
  useCloudDialogLifecycle({
    open: Boolean(project),
    backdropRef,
    dialogRef,
    initialFocusRef: closeRef,
    onClose,
  });

  if (!project) return null;
  return (
    <div ref={backdropRef} className="cloud-library-backdrop">
      <section ref={dialogRef} className="cloud-library-dialog" role="dialog" aria-modal="true" aria-labelledby="cloud-history-title">
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
