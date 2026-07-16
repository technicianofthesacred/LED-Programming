import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createBridgeResultChannel, resumeBridgeReturnCode } from '../../lib/bridgeLaunch.js';
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
import { adoptDiscoveredDirectCard, connectCardLink } from '../../lib/cardLink.js';
import {
  SECURE_INSTALLER_URL,
  detectPlatformCapabilities,
} from '../../lib/platformCapabilities.js';
import { BridgeResumePanel } from './BridgeResumePanel.jsx';

function platformCapabilities() {
  if (typeof window === 'undefined') return detectPlatformCapabilities();
  return detectPlatformCapabilities({
    secureContext: window.isSecureContext,
    topLevel: window.top === window.self,
    serial: navigator.serial,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}

function goToInstall() {
  window.location.hash = 'screen=flash&mode=install';
}

const SETUP_HOST = '192.168.4.1';
const NEUTRAL_FIRST_RUN_REASONS = new Set(['never-connected', 'card-unreachable']);

export function CardConnectionCenter({
  open,
  link,
  onClose,
  onConnectCard = connectCardLink,
  onLaunchBridge,
  bridgeResult,
  onClearBridgeResult,
  recoverLights,
  setupEvidence = {},
}) {
  const panelRef = useRef(null);
  const restoreFocusRef = useRef(null);
  const shouldRestoreFocusRef = useRef(false);
  const [intent, setIntent] = useState('');
  const [failure, setFailure] = useState('');
  const [host, setHost] = useState(readStoredCardHost);
  const [bridgeLaunchState, setBridgeLaunchState] = useState('idle');
  const [bridgeReturnCode, setBridgeReturnCode] = useState('');
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
    discoveredCard: link.discoveredCard,
    ...flowEvidence,
  });

  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement;
    shouldRestoreFocusRef.current = false;
    setFailure('');
    setIntent('');
    setBridgeLaunchState('idle');
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
    if (!bridgeResult) return;
    setBridgeLaunchState('idle');
    window.setTimeout(() => panelRef.current?.focus(), 0);
  }, [bridgeResult]);

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
    if (next.route !== 'setup-network') connect();
  };

  const chooseBlankCard = () => {
    setIntent('blank-card');
    if (capabilities.canWebSerialInstall) openInstall();
  };

  const useDiscoveredCard = async () => {
    try {
      if (link.transport === 'direct' && link.discoveredCard?.id) {
        await adoptDiscoveredDirectCard();
      } else {
        rePairDiscoveredCardBridgeIdentity(link.host);
      }
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

  const launchBridge = async (operation) => {
    if (bridgeLaunchState === 'opening' || bridgeLaunchState === 'working' || bridgeLaunchState === 'return-pending') return;
    onClearBridgeResult?.();
    setFailure('');
    setBridgeLaunchState('opening');
    try {
      await onLaunchBridge?.(operation);
      setBridgeLaunchState('working');
    } catch {
      setBridgeLaunchState('idle');
      setFailure('Studio could not save the project and open Bridge. Save the project, then try again.');
    }
  };

  const resumeReturnCode = async (event) => {
    event.preventDefault();
    setFailure('');
    setBridgeLaunchState('return-pending');
    const channel = createBridgeResultChannel();
    try {
      await resumeBridgeReturnCode(bridgeReturnCode, { publish: result => channel.publish(result) });
      setBridgeReturnCode('');
    } catch {
      setBridgeLaunchState('working');
      setFailure('That return code is invalid, expired, already used, or belongs to another browser profile. Copy the current code from Bridge and try again in the original Studio tab.');
    } finally { channel.close(); }
  };

  const bridgeOperation = action.id === 'needs-safe-recovery' ? 'recover-current-release' : 'install-current-release';
  const bridgeBusy = ['opening', 'working', 'return-pending'].includes(bridgeLaunchState);
  const effectiveActionId = action.id;
  const bridgeLifecycleState = bridgeLaunchState === 'idle' && action.id === 'install-native-bridge'
    ? 'installer-unavailable' : bridgeLaunchState;
  const showManualReturn = !capabilities.canWebSerialInstall
    && ['launch-native-bridge', 'install-native-bridge', 'needs-card-update', 'needs-safe-recovery'].includes(action.id);

  const initialChoice = !intent
    && link.state === 'disconnected'
    && (!link.activity || link.activity === 'idle')
    && NEUTRAL_FIRST_RUN_REASONS.has(link.reason)
    && !hasKnownCard;
  const setupSteps = action.id === 'recoverable-failure' && action.route === 'setup-network';

  const renderPrimaryAction = () => {
    switch (action.id) {
      case 'ready-local-card':
        return <button type="button" className="btn primary" onClick={closeAndRestore}>Done</button>;
      case 'ready-browser-usb':
        return <button type="button" className="btn primary" onClick={openInstall}>Start installation</button>;
      case 'escape-insecure-card-frame':
        return (
          <a className="btn primary" href={SECURE_INSTALLER_URL} target="_blank" rel="noopener noreferrer">
            Open secure installer
          </a>
        );
      case 'needs-card-update':
        return capabilities.canWebSerialInstall
          ? <button type="button" className="btn primary" onClick={openInstall}>Update card</button>
          : <button type="button" className="btn primary" onClick={() => launchBridge('install-current-release')} disabled={bridgeBusy}>Open Lightweaver Bridge</button>;
      case 'launch-native-bridge':
        return <button type="button" className="btn primary" onClick={() => launchBridge(bridgeOperation)} disabled={bridgeBusy}>{bridgeBusy ? 'Opening Lightweaver Bridge…' : 'Open Lightweaver Bridge'}</button>;
      case 'install-native-bridge':
        return <button type="button" className="btn primary" onClick={() => launchBridge(bridgeOperation)} disabled={bridgeBusy}>Try Lightweaver Bridge again</button>;
      case 'handoff-supported-device':
        return null;
      case 'wrong-card':
        return <button type="button" className="btn primary" onClick={() => connect()}>Reconnect expected card</button>;
      case 'recoverable-failure':
        return (
          <button
            type="button"
            className="btn primary"
            onClick={() => connect(setupSteps ? SETUP_HOST : '', { bridge: setupSteps })}
            disabled={action.primaryDisabled}
          >
            {setupSteps ? 'Continue' : action.primaryLabel}
          </button>
        );
      case 'needs-safe-recovery':
        return capabilities.canWebSerialInstall
          ? <button type="button" className="btn primary" onClick={openInstall}>Start safe recovery</button>
          : <button type="button" className="btn primary" onClick={() => launchBridge('recover-current-release')} disabled={bridgeBusy}>Open Lightweaver Bridge</button>;
      default:
        return null;
    }
  };

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

      {bridgeResult ? (
        <BridgeResumePanel
          result={bridgeResult}
          link={link}
          onReconnect={() => connect()}
          onRetry={launchBridge}
          onDismiss={onClearBridgeResult}
          onComplete={() => onClearBridgeResult?.('complete')}
          recoverLights={recoverLights}
        />
      ) : initialChoice ? (
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
        <div className="card-connection-action" data-action-id={effectiveActionId} aria-live="polite" aria-busy={(action.busy || bridgeBusy) || undefined}>
          <h3>{bridgeLifecycleState === 'opening' ? 'Opening Lightweaver Bridge' : bridgeLifecycleState === 'working' ? 'Working in Lightweaver Bridge' : bridgeLifecycleState === 'return-pending' ? 'Return pending' : bridgeLifecycleState === 'installer-unavailable' ? 'Signed Bridge installer unavailable' : action.title}</h3>
          <p>{bridgeLifecycleState === 'opening' ? 'Studio sent the secure launch request.' : bridgeLifecycleState === 'working' ? 'Keep this original Studio tab open while Bridge works. If the result opens in another browser or profile, paste its return code below.' : bridgeLifecycleState === 'return-pending' ? 'Studio is validating the one-time return and asking Bridge to clear its saved result.' : action.explanation}</p>
          {(effectiveActionId === 'install-native-bridge') && (
            <p>A verified signed installer is not yet available. No unsigned download is offered. Use secure browser USB or continue on a supported computer.</p>
          )}
          {action.id === 'needs-safe-recovery' && !capabilities.canWebSerialInstall && (
            <p>Keep the card powered while Bridge performs safe recovery.</p>
          )}
          {action.id === 'needs-card-update' && !capabilities.canWebSerialInstall && (
            <p>Keep the card powered while Bridge installs the current release.</p>
          )}

          {showManualReturn && (
            <form onSubmit={resumeReturnCode} className="bridge-return-code-form">
              <label htmlFor="bridge-return-code">Return code from Bridge</label>
              <input id="bridge-return-code" value={bridgeReturnCode} onChange={event => setBridgeReturnCode(event.target.value)} autoComplete="off" spellCheck="false" maxLength={904} />
              <button type="submit" className="btn" disabled={!bridgeReturnCode.trim() || bridgeLaunchState === 'return-pending'}>Resume in this tab</button>
            </form>
          )}

          {setupSteps && (
            <ol className="card-setup-steps">
              <li>Power the Lightweaver card.</li>
              <li>Join the <strong>Lightweaver-XXXX</strong> Wi-Fi network.</li>
              <li>Finish setup, return to Studio, then press Continue.</li>
            </ol>
          )}

          {action.id === 'ready-local-card' && link.card && (
            <dl className="card-acknowledged-facts">
              {link.card.name && <><dt>Name</dt><dd>{link.card.name}</dd></>}
              {link.card.pixelCount > 0 && <><dt>Pixels</dt><dd>{link.card.pixelCount}</dd></>}
              {link.card.gpioSummary && <><dt>Outputs</dt><dd>{link.card.gpioSummary}</dd></>}
              {link.card.firmwareVersion && <><dt>Firmware</dt><dd>{link.card.firmwareVersion}{link.card.buildId ? ` · ${link.card.buildId}` : ''}</dd></>}
            </dl>
          )}

          <div className="card-connection-actions">
            {renderPrimaryAction()}
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
