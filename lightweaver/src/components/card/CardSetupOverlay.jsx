import React, { useCallback, useEffect, useRef, useState } from 'react';
import { recoverCardLights, stopCardLights } from '../../lib/cardLiveControl.js';
import { StripDiscoveryPanel } from './StripDiscoveryPanel.jsx';

const SAFE_LIFECYCLE = Object.freeze({ phase: 'idle', busy: false, lighting: false });

function focusableElements(root) {
  return [...(root?.querySelectorAll?.(
    'button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  ) || [])].filter(element => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

export function CardSetupOverlay({
  cardHost = '',
  cardLink = null,
  onDismiss,
  onDisconnect,
  onComplete,
  go,
}) {
  const dialogRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const [lifecycle, setLifecycle] = useState(SAFE_LIFECYCLE);
  const [releaseState, setReleaseState] = useState('idle');
  const [releaseFailure, setReleaseFailure] = useState('');
  const [lightAction, setLightAction] = useState({ status: 'idle', message: '' });
  const protectedWork = lifecycle.busy
    || lifecycle.phase === 'bench-install'
    || lifecycle.phase === 'record'
    || lifecycle.lighting;
  const protectedWorkRef = useRef(protectedWork);
  protectedWorkRef.current = protectedWork;

  const dismiss = useCallback(() => {
    if (protectedWorkRef.current) return;
    // Dismissal is only a UI boundary. The passive local card page remains the
    // live bridge for Layout, install, Patterns, and later card commands.
    onDismiss?.();
  }, [onDismiss]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement;
    const timer = window.setTimeout(() => {
      const focusables = focusableElements(dialogRef.current);
      (focusables[0] || dialogRef.current)?.focus?.();
    }, 0);
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = focusableElements(dialogRef.current);
      if (!focusables.length) {
        event.preventDefault();
        dialogRef.current?.focus?.();
        return;
      }
      const first = focusables[0];
      const last = focusables.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      restoreFocusRef.current?.focus?.();
    };
  }, [dismiss]);

  const stopLights = async () => {
    if (lightAction.status === 'stopping' || !cardHost) return;
    setLightAction({ status: 'stopping', message: 'Stopping the lights…' });
    try {
      await stopCardLights({ host: cardHost, timeoutMs: 3200 });
      setLightAction({ status: 'stopped', message: 'Lights stopped and blackout confirmed by the card.' });
    } catch (error) {
      setLightAction({
        status: 'failed',
        message: error?.message || 'The card did not confirm that the lights stopped. Recover the last working setup.',
      });
    }
  };

  const recoverLights = async () => {
    if (lightAction.status === 'recovering' || !cardHost) return;
    setLightAction({ status: 'recovering', message: 'Recovering the last working setup…' });
    try {
      await recoverCardLights({}, { host: cardHost, timeoutMs: 3200 });
      setLightAction({ status: 'recovered', message: 'The card restored its last working light setup.' });
    } catch (error) {
      setLightAction({ status: 'failed', message: error?.message || 'The card could not recover the lights.' });
    }
  };

  const disconnect = async () => {
    if (protectedWork || releaseState === 'releasing') return;
    setReleaseState('releasing');
    setReleaseFailure('');
    try {
      await onDisconnect?.();
      setReleaseState('released');
    } catch (error) {
      setReleaseFailure(error?.message || 'Studio could not disconnect this card. Try again.');
      setReleaseState('idle');
    }
  };

  return (
    <div
      className="card-setup-backdrop"
      onPointerDown={event => { if (event.target === event.currentTarget) dismiss(); }}
    >
      <section
        ref={dialogRef}
        className="card-setup-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="card-setup-title"
        aria-describedby="card-setup-description"
        data-testid="card-setup-overlay"
        tabIndex={-1}
      >
        <header className="card-setup-overlay-head">
          <div>
            <h2 id="card-setup-title">Find and verify the lights</h2>
            <p id="card-setup-description">Identify each connected output, establish color, and prove exactly where its lights end.</p>
          </div>
          <button
            type="button"
            className="card-setup-overlay-close"
            aria-label={protectedWork ? 'Light check is active' : 'Close light check'}
            data-testid="card-setup-close"
            disabled={protectedWork}
            onClick={dismiss}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16">
              <path d="M5 5l10 10M15 5L5 15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="card-setup-overlay-body">
          <StripDiscoveryPanel
            cardHost={cardHost}
            cardLink={cardLink}
            go={go}
            embedded
            onLifecycleChange={setLifecycle}
            onComplete={onComplete}
          />
        </div>

        <footer className="card-setup-overlay-foot">
          <div className="card-setup-overlay-safety">
            <button
              type="button"
              className="btn"
              data-testid="card-setup-stop-lights"
              disabled={!cardHost || lightAction.status === 'stopping' || lightAction.status === 'recovering'}
              onClick={() => void stopLights()}
            >
              {lightAction.status === 'stopping' ? 'Stopping…' : 'Stop lights'}
            </button>
            {lightAction.status === 'failed' && (
              <button type="button" className="btn" data-testid="card-setup-recover-lights" onClick={() => void recoverLights()}>
                Recover lights
              </button>
            )}
          </div>
          <p>
            {protectedWork
              ? 'Keep this task and the card connection open while Studio checks the physical lights.'
              : 'Closing this task keeps the card connection ready for Layout, installation, and Patterns.'}
          </p>
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="card-setup-disconnect"
            disabled={protectedWork || releaseState === 'releasing'}
            onClick={() => void disconnect()}
          >
            {releaseState === 'releasing' ? 'Disconnecting…' : 'Disconnect card'}
          </button>
          {lightAction.message && <p className="card-setup-light-status" role="status">{lightAction.message}</p>}
          {releaseFailure && <p className="card-setup-release-error" role="alert">{releaseFailure}</p>}
        </footer>
      </section>
    </div>
  );
}

export default CardSetupOverlay;
