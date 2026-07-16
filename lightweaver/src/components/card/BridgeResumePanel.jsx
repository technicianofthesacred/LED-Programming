import React from 'react';
import { CardCommissioningPanel } from './CardCommissioningPanel.jsx';

const DESTRUCTIVE = new Set(['install-current-release', 'recover-current-release']);

function identityStatus(result, link) {
  if (result?.status !== 'awaiting-card-acknowledgement') return { state: 'not-applicable', message: '' };
  if (!link?.card?.id) return { state: 'missing', message: 'Reconnect the card so Studio can verify its identity.' };
  if (!result.cardId || link.card.id !== result.cardId) return { state: 'wrong-card', message: `Studio expected ${result.cardId || 'the installed card'}, but ${link.card.id} answered.` };
  if (DESTRUCTIVE.has(result.operation) && link.card.firmwareVersion !== result.firmwareVersion) return { state: 'wrong-version', message: `Studio expected firmware ${result.firmwareVersion}, but the card reports ${link.card.firmwareVersion || 'no version'}.` };
  if (DESTRUCTIVE.has(result.operation) && link.card.buildId !== result.buildId) return { state: 'wrong-build', message: 'The card firmware build does not match the build verified by Bridge.' };
  return { state: 'acknowledged', message: 'Studio verified the exact installed card and firmware build.' };
}

const FAILURE_COPY = {
  'recoverable-failure': { title: 'Bridge could not finish this action', body: 'Check the USB cable and card power, then retry the same action.' },
  'needs-safe-recovery': { title: 'The card needs safe recovery', body: 'Keep the card powered. Start recovery again; do not unplug it while firmware is changing.' },
  'usb-ownership-uncertain': { title: 'USB may still be in use', body: 'Close other serial tools and card installers, reconnect the USB cable, then retry.' },
};

export function BridgeResumePanel({ result, link, onReconnect, onRetry, onDismiss, onComplete }) {
  if (!result) return null;
  if (result.kind === 'complete') {
    return <div className="bridge-resume" role="status"><h3>Lightweaver is ready</h3><p>Card setup and physical verification are complete.</p><button type="button" className="btn primary" onClick={onDismiss}>Done</button></div>;
  }
  if (result.kind === 'failure' || result.kind === 'handoff') {
    return <div className="bridge-resume" role="status"><h3>{result.kind === 'failure' ? 'Bridge return needs attention' : 'Bridge return pending'}</h3><p>{result.message}</p><button type="button" className="btn" onClick={onDismiss}>Dismiss</button></div>;
  }
  if (result.status === 'awaiting-card-acknowledgement') {
    return <CardCommissioningPanel result={result} link={link} onReconnect={onReconnect} onComplete={onComplete} />;
  }
  const copy = FAILURE_COPY[result.status] || FAILURE_COPY['recoverable-failure'];
  return (
    <div className="bridge-resume" role="status" data-result-status={result.status}>
      <h3>{copy.title}</h3><p>{copy.body}</p>
      <div className="card-connection-actions">
        {onRetry && <button type="button" className="btn primary" onClick={() => onRetry(result.status === 'needs-safe-recovery' ? 'recover-current-release' : result.operation)}>Try again</button>}
        <button type="button" className="btn" onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  );
}

export { identityStatus };
