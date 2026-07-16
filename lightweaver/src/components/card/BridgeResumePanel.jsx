import React, { useEffect, useMemo, useState } from 'react';
import { recoverCardLights } from '../../lib/cardLiveControl.js';

const DESTRUCTIVE = new Set(['install-current-release', 'recover-current-release']);

function identityStatus(result, link) {
  if (result?.status !== 'awaiting-card-acknowledgement') return { state: 'not-applicable', message: '' };
  if (!link?.card?.id) return { state: 'missing', message: 'Reconnect the card so Studio can verify its identity.' };
  if (!result.cardId) return { state: 'missing', message: 'The Bridge result did not include a card identity. Reconnect and retry the operation.' };
  if (link.card.id !== result.cardId) return { state: 'wrong-card', message: `Studio expected ${result.cardId}, but ${link.card.id} answered. Connect the installed card.` };
  if (DESTRUCTIVE.has(result.operation)) {
    if (!link.card.firmwareVersion) return { state: 'missing-version', message: 'The card did not report its firmware version. Reconnect before continuing.' };
    if (link.card.firmwareVersion !== result.firmwareVersion) return { state: 'wrong-version', message: `Studio expected firmware ${result.firmwareVersion}, but the card reports ${link.card.firmwareVersion}.` };
    if (!link.card.buildId) return { state: 'missing-build', message: 'The card did not report its firmware build. Reconnect before continuing.' };
    if (link.card.buildId !== result.buildId) return { state: 'wrong-build', message: 'The card firmware build does not match the build verified by Bridge.' };
  }
  return { state: 'acknowledged', message: 'Studio verified the card identity. Now check the physical lights.' };
}

const FAILURE_COPY = {
  'recoverable-failure': {
    title: 'Bridge could not finish this action',
    body: 'Check the USB cable and card power, then retry the same action.',
  },
  'needs-safe-recovery': {
    title: 'The card needs safe recovery',
    body: 'Keep the card powered. Start recovery again; do not unplug it while firmware is changing.',
  },
  'usb-ownership-uncertain': {
    title: 'USB may still be in use',
    body: 'Close other serial tools and card installers, reconnect the USB cable, then retry.',
  },
};

export function BridgeResumePanel({
  result,
  link,
  onReconnect,
  onRetry,
  onDismiss,
  onComplete,
  recoverLights = recoverCardLights,
}) {
  const [lightState, setLightState] = useState('idle');
  const [failure, setFailure] = useState('');
  const identity = useMemo(() => identityStatus(result, link), [result, link]);

  useEffect(() => {
    setLightState('idle');
    setFailure('');
  }, [result]);

  if (!result) return null;
  if (result.kind === 'complete') {
    return (
      <div className="bridge-resume" role="status">
        <h3>Lightweaver is ready</h3>
        <p>Card identity and visible warm-white lights are confirmed.</p>
        <div className="card-connection-actions"><button type="button" className="btn primary" onClick={onDismiss}>Done</button></div>
      </div>
    );
  }
  if (result.kind === 'failure') {
    return (
      <div className="bridge-resume" role="status">
        <h3>Bridge return needs attention</h3>
        <p>{result.message}</p>
        <div className="card-connection-actions"><button type="button" className="btn" onClick={onDismiss}>Dismiss</button></div>
      </div>
    );
  }
  if (result.kind === 'handoff') {
    return (
      <div className="bridge-resume" role="status">
        <h3>Bridge return pending</h3>
        <p>{result.message}</p>
        <div className="card-connection-actions"><button type="button" className="btn" onClick={onDismiss}>Dismiss</button></div>
      </div>
    );
  }
  if (result.status !== 'awaiting-card-acknowledgement') {
    const copy = FAILURE_COPY[result.status] || FAILURE_COPY['recoverable-failure'];
    return (
      <div className="bridge-resume" role="status" data-result-status={result.status}>
        <h3>{copy.title}</h3>
        <p>{copy.body}</p>
        <div className="card-connection-actions">
          {onRetry && <button type="button" className="btn primary" onClick={() => onRetry(result.status === 'needs-safe-recovery' ? 'recover-current-release' : result.operation)}>Try again</button>}
          <button type="button" className="btn" onClick={onDismiss}>Dismiss</button>
        </div>
      </div>
    );
  }

  const reconnecting = link?.state === 'connecting' || link?.state === 'reconnecting-bridge';
  const runLightCheck = async () => {
    if (lightState !== 'idle' || identity.state !== 'acknowledged') return;
    setLightState('checking');
    setFailure('');
    try {
      await recoverLights(
        { patternId: 'warm-white', brightness: 1, syncZones: true },
        { host: link.host, expectedCardId: result.cardId, timeoutMs: 3200, restartCard: true },
      );
      setLightState('confirm');
    } catch {
      setFailure('Studio could not prepare a visible warm-white frame. Reconnect the card, then run the light check again.');
      setLightState('idle');
    }
  };

  return (
    <div className="bridge-resume" role="status" data-result-status={result.status}>
      <h3>Firmware installed — verify the card</h3>
      <p>{identity.message}</p>
      {lightState === 'confirm' ? (
        <>
          <p className="bridge-physical-question">Are the lights warm white?</p>
          <div className="card-connection-actions">
            <button type="button" className="btn primary" onClick={() => { setLightState('complete'); onComplete?.(); }}>Yes, they are warm white</button>
            <button type="button" className="btn" onClick={() => setLightState('failed')}>No</button>
          </div>
        </>
      ) : lightState === 'failed' ? (
        <>
          <p>The card answered, but the physical lights did not show the expected color. Reconnect, then recover the current release.</p>
          <div className="card-connection-actions">
            <button type="button" className="btn primary" onClick={() => onRetry?.('recover-current-release')}>Recover current release</button>
            <button type="button" className="btn" onClick={onReconnect}>Reconnect</button>
          </div>
        </>
      ) : (
        <div className="card-connection-actions">
          {identity.state === 'acknowledged' ? (
            <button type="button" className="btn primary" onClick={runLightCheck} disabled={lightState === 'checking'}>
              {lightState === 'checking' ? 'Running light check…' : 'Run light check'}
            </button>
          ) : (
            <button type="button" className="btn primary" onClick={onReconnect} disabled={reconnecting}>
              {reconnecting ? 'Reconnecting…' : 'Reconnect card'}
            </button>
          )}
        </div>
      )}
      {failure && <p className="card-connection-failure" role="alert">{failure}</p>}
    </div>
  );
}

export { identityStatus };
