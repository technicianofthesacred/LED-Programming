import React, { useEffect, useMemo, useRef, useState } from 'react';
import { rePairDiscoveredCardBridgeIdentity } from '../../lib/cardBridge.js';
import {
  CARD_HOST_CHANGED_EVENT,
  isLocalCardHost,
  normalizeCardHost,
  readStoredCardHost,
  writeStoredCardHost,
} from '../../lib/cardConnection.js';
import { nextCardConnectionAction } from '../../lib/cardConnectionFlow.js';
import { readPersistedCardIdentity } from '../../lib/cardIdentity.js';
import { connectCardLink } from '../../lib/cardLink.js';
import { detectPlatformCapabilities } from '../../lib/platformCapabilities.js';

function platformCapabilities() {
  if (typeof window === 'undefined') return detectPlatformCapabilities();
  return detectPlatformCapabilities({
    secureContext: window.isSecureContext,
    serial: navigator.serial,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}

function goToInstall() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.set('screen', 'flash');
  params.set('mode', 'install');
  window.location.hash = params.toString();
}

const SETUP_HOST = '192.168.4.1';
const NEUTRAL_FIRST_RUN_REASONS = new Set(['never-connected', 'card-unreachable']);

export function CardConnectionCenter({ open, link, onClose, onConnectCard = connectCardLink, setupEvidence = {} }) {
  const panelRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const shouldRestoreFocusRef = useRef(false);
  const [intent, setIntent] = useState('');
  const [failure, setFailure] = useState('');
  const [host, setHost] = useState(readStoredCardHost);
  const capabilities = useMemo(platformCapabilities, [open]);
  const rememberedCard = readPersistedCardIdentity();
  const hasKnownCard = Boolean(link.card?.id || link.expectedCard?.id || rememberedCard?.id);
  const hasSetupHost = [host, link.host, setupEvidence.host].includes(SETUP_HOST);
  const flowEvidence = {
    setupNetwork: hasSetupHost ? { available: true, ssid: 'Lightweaver-XXXX' } : setupEvidence.setupNetwork,
    setupMode: setupEvidence.mode,
  };
  const actionLink = intent === 'blank-card' && link.reason !== 'wrong-card'
    ? { state: 'disconnected', reason: link.reason }
    : link;
  const flowIntent = intent || (hasKnownCard ? 'working-card' : '');
  const action = nextCardConnectionAction({
    link: actionLink,
    intent: flowIntent,
    capabilities,
    rememberedCard,
    ...flowEvidence,
  });

  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement;
    shouldRestoreFocusRef.current = false;
    setFailure('');
    setIntent('');
    const timer = window.setTimeout(() => panelRef.current?.focus(), 0);
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        shouldRestoreFocusRef.current = true;
        onClose();
      }
    };
    const onPointerDown = (event) => {
      if (!panelRef.current?.contains(event.target)) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
      if (shouldRestoreFocusRef.current) restoreFocusRef.current?.focus?.();
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const syncHost = () => setHost(readStoredCardHost());
    syncHost();
    window.addEventListener(CARD_HOST_CHANGED_EVENT, syncHost);
    return () => window.removeEventListener(CARD_HOST_CHANGED_EVENT, syncHost);
  }, [open]);

  if (!open) return null;

  const closeAndRestore = () => {
    shouldRestoreFocusRef.current = true;
    onClose();
  };

  const openInstall = () => {
    shouldRestoreFocusRef.current = false;
    onClose();
    goToInstall();
  };

  const connect = (rawHost = '', { bridge = false } = {}) => {
    setFailure('');
    const targetHost = normalizeCardHost(rawHost || readStoredCardHost());
    if (!isLocalCardHost(targetHost)) {
      setFailure('Enter a valid local Lightweaver hostname before connecting.');
      return;
    }
    const result = bridge ? connectCardLink(targetHost) : onConnectCard(targetHost);
    if (!result) setFailure('The browser could not open the card page. Allow popups, then try again.');
  };

  const chooseWorkingCard = () => {
    setIntent('working-card');
    const next = nextCardConnectionAction({
      link,
      intent: 'working-card',
      capabilities,
      rememberedCard,
      ...flowEvidence,
    });
    if (next.id !== 'open-setup-network') connect();
  };

  const chooseBlankCard = () => {
    setIntent('blank-card');
    if (capabilities.canWebSerialInstall) openInstall();
  };

  const useDiscoveredCard = () => {
    try {
      rePairDiscoveredCardBridgeIdentity(link.host);
      setFailure('');
    } catch (error) {
      setFailure(error?.message || 'Studio could not pair this card.');
    }
  };

  const saveHost = (event) => {
    event.preventDefault();
    const normalizedHost = normalizeCardHost(host);
    if (!isLocalCardHost(normalizedHost)) {
      setFailure('Enter a valid local Lightweaver hostname.');
      return;
    }
    setHost(writeStoredCardHost(normalizedHost));
    setFailure('');
  };

  const initialChoice = !intent
    && link.state === 'disconnected'
    && (!link.activity || link.activity === 'idle')
    && NEUTRAL_FIRST_RUN_REASONS.has(link.reason)
    && !hasKnownCard;
  const setupSteps = action.id === 'open-setup-network';

  return (
    <section
      ref={panelRef}
      id="card-connection-center"
      className="card-connection-center"
      role="dialog"
      aria-modal="false"
      aria-labelledby="card-connection-title"
      tabIndex={-1}
    >
      <header className="card-connection-head">
        <div>
          <p className="card-connection-kicker">Card connection</p>
          <h2 id="card-connection-title">Connect Lightweaver</h2>
        </div>
        <button type="button" className="card-connection-close" onClick={closeAndRestore} aria-label="Close connection center">×</button>
      </header>

      {initialChoice ? (
        <div className="card-condition-choices">
          <p>Look at the card and its LEDs, then choose what you see.</p>
          <button type="button" className="card-condition-choice" onClick={chooseWorkingCard}>
            <strong>My card already lights up</strong>
            <span>The card has power and the connected LEDs can light.</span>
          </button>
          <button type="button" className="card-condition-choice" onClick={chooseBlankCard}>
            <strong>Blank or not responding</strong>
            <span>The card is new, dark, or does not react after power is connected.</span>
          </button>
        </div>
      ) : (
        <div className="card-connection-action" aria-live="polite" aria-busy={action.busy || undefined}>
          <h3>{action.title}</h3>
          <p>{action.explanation}</p>

          {setupSteps && (
            <ol className="card-setup-steps">
              <li>Power the Lightweaver card.</li>
              <li>Join the <strong>Lightweaver-XXXX</strong> Wi-Fi network.</li>
              <li>Finish setup, return to Studio, then press Continue.</li>
            </ol>
          )}

          {action.id === 'connected' && link.card && (
            <dl className="card-acknowledged-facts">
              {link.card.name && <><dt>Name</dt><dd>{link.card.name}</dd></>}
              {link.card.pixelCount > 0 && <><dt>Pixels</dt><dd>{link.card.pixelCount}</dd></>}
              {link.card.gpioSummary && <><dt>Outputs</dt><dd>{link.card.gpioSummary}</dd></>}
              {link.card.firmwareVersion && <><dt>Firmware</dt><dd>{link.card.firmwareVersion}{link.card.buildId ? ` · ${link.card.buildId}` : ''}</dd></>}
            </dl>
          )}

          <div className="card-connection-actions">
            {action.id === 'connected' ? (
              <button type="button" className="btn primary" onClick={closeAndRestore}>Done</button>
            ) : action.id === 'web-serial-install' ? (
              <button type="button" className="btn primary" onClick={openInstall}>Start installation</button>
            ) : action.id === 'supported-browser-handoff' || action.id === 'supported-device-handoff' ? null : (
              <button
                type="button"
                className="btn primary"
                onClick={() => connect(setupSteps ? SETUP_HOST : '', { bridge: setupSteps })}
                disabled={action.primaryDisabled}
              >
                {setupSteps ? 'Continue' : action.primaryLabel}
              </button>
            )}
            {action.secondaryAction?.id === 'adopt-discovered-card' && (
              <button type="button" className="btn" onClick={useDiscoveredCard}>Use this card instead</button>
            )}
          </div>
        </div>
      )}

      {failure && <p className="card-connection-failure" role="alert">{failure}</p>}

      <details className="card-connection-details">
        <summary>Connection details</summary>
        <form onSubmit={saveHost}>
          <label htmlFor="card-connection-host">Card hostname</label>
          <div>
            <input
              id="card-connection-host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              autoComplete="off"
              spellCheck="false"
            />
            <button type="submit" className="btn">Save</button>
          </div>
        </form>
      </details>
    </section>
  );
}
