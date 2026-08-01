export function WorkspaceNotice({ notice, onDismiss, onReview }) {
  if (!notice) return null;
  return (
    <aside
      className={`workspace-notice workspace-notice-${notice.kind || 'info'}`}
      data-testid="workspace-notice"
      role={notice.kind === 'error' || notice.kind === 'conflict' ? 'alert' : 'status'}
      aria-live={notice.persistent ? 'assertive' : 'polite'}
      aria-label="Workspace notice"
    >
      <span>{notice.message}</span>
      <div className="workspace-notice-actions">
        {notice.review && <button type="button" onClick={onReview}>Review</button>}
        <button type="button" aria-label="Dismiss notice" onClick={onDismiss}>×</button>
      </div>
    </aside>
  );
}
