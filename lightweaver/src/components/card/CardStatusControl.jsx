import React from 'react';

// The footer's card status label IS the lifecycle diagnosis — one authority
// (deriveCardLifecycle) instead of a second raw-link ladder here. The
// `confirming` lifecycle state now supplies "Checking card" where the deleted
// fallback ladder used to derive it from the raw link.
export function CardStatusControl({ link, lifecycle, onOpen, open = false, dialogId = 'card-connection-center' }) {
  const status = lifecycle.label;
  const connected = status === 'Connected';
  const accessibleName = connected
    ? `${link.card?.name || 'Lightweaver'} · Connected`
    : `Connect Lightweaver · ${status}`;

  return (
    <>
      <button
        type="button"
        className={`card-status-control is-${status.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`}
        onClick={onOpen}
        aria-label={accessibleName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        data-testid="card-link-status"
      >
        <span className="card-status-dot" aria-hidden="true" />
        <span className="card-status-copy">
          <span className="card-status-name">{connected ? (link.card?.name || 'Lightweaver') : 'Lightweaver'}</span>
          <span className="card-status-state">{status}</span>
        </span>
      </button>
      <span className="card-status-announcement" role="status" aria-live="polite" aria-atomic="true">
        {status}
      </span>
    </>
  );
}
