import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createBridgeResultChannel, resumeBridgeReturnCode } from '../../lib/bridgeLaunch.js';
import { STRIP_DISCOVERY_LABEL, STRIP_DISCOVERY_ROUTE } from '../../lib/cardAction.js';
import {
  acquireCardBridgeFromGesture,
  adoptDiscoveredCardBridgeIdentity,
  getCardBridgeState,
  rePairDiscoveredCardBridgeIdentity,
} from '../../lib/cardBridge.js';
import {
  CARD_HOST_CHANGED_EVENT,
  isLocalCardHost,
  normalizeCardHost,
  ordinaryCardRecoveryHost,
  readStoredCardHost,
  writeStoredCardHost,
} from '../../lib/cardConnection.js';
import { nextCardConnectionAction } from '../../lib/cardConnectionFlow.js';
import { cardBuildLabel, readPersistedCardIdentity, setupNetworkLabelForCardId } from '../../lib/cardIdentity.js';
import { adoptDiscoveredDirectCard, connectCardLink } from '../../lib/cardLink.js';
import { connectCardTransport, getActiveCardTransportAuthority } from '../../lib/cardTransport.js';
import { classifyFooterFirmwareStatus } from '../../lib/footerFirmwareStatus.js';
import {
  SECURE_INSTALLER_URL,
  detectPlatformCapabilities,
} from '../../lib/platformCapabilities.js';
import { getActiveUsbInspection, releaseActiveUsbInspection } from '../../lib/usbInspection.js';
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

function goToLayout() {
  window.location.hash = 'screen=layout';
}

function goToStripDiscovery() {
  window.location.hash = STRIP_DISCOVERY_ROUTE;
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
  firmwareStatus,
  firmwareRelease,
  onOpenFirmwareUpdate,
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
  const [takeoverHost, setTakeoverHost] = useState('');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [directAttempt, setDirectAttempt] = useState(null);
  const [directBusy, setDirectBusy] = useState(false);
  const [usbInspection, setUsbInspection] = useState(null);
  const [usbReleaseState, setUsbReleaseState] = useState('idle');
  const [capabilityBusy, setCapabilityBusy] = useState(false);
  const [capabilityReady, setCapabilityReady] = useState(false);
  const capabilities = useMemo(platformCapabilities, [open]);
  const rememberedCard = readPersistedCardIdentity();
  const hasKnownCard = Boolean(link.card?.id || link.expectedCard?.id || rememberedCard?.id);
  const hasSetupHost = [host, link.host, setupEvidence.host].includes(SETUP_HOST);
  // The card's real hotspot name is derivable from its card id (same eFuse MAC
  // as the firmware's apSsid()). Nothing here is guaranteed to know the card
  // yet — a blank or unreachable card has no id — so this falls back to a
  // description of the network rather than naming one that may not exist.
  const setupNetworkLabel = setupNetworkLabelForCardId(
    link.card?.id || link.expectedCard?.id || link.discoveredCard?.id || rememberedCard?.id || '',
  );
  const flowEvidence = {
    // Evidence only: a stored setup-host proves the setup network is in play.
    // It carries no SSID because Studio has not observed one — the copy below
    // derives the real name from card identity when it has it.
    setupNetwork: hasSetupHost ? { available: true } : setupEvidence.setupNetwork,
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
  const showFirmwareUpdate = action.id === 'ready-local-card'
    && firmwareStatus?.state === 'update-available';
  const incompatibleFirmware = directAttempt?.reason === 'firmware-incompatible'
    ? directAttempt.observedCard : null;
  const connectedIdentity = directAttempt?.connected ? (directAttempt.card || link.card) : null;
  const directIdentity = incompatibleFirmware || connectedIdentity;
  const directFirmwareStatus = classifyFooterFirmwareStatus(directIdentity, firmwareRelease);
  const showDirectFirmwareUpdate = directAttempt?.connected
    && directFirmwareStatus.state === 'update-available';

  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement;
    shouldRestoreFocusRef.current = false;
    setFailure('');
    setIntent('');
    setBridgeLaunchState('idle');
    const activeAuthority = getActiveCardTransportAuthority();
    setDirectAttempt(activeAuthority);
    setDirectBusy(false);
    setUsbInspection(getActiveUsbInspection());
    setUsbReleaseState('idle');
    setCapabilityBusy(false);
    setCapabilityReady(Boolean(activeAuthority?.ownerCapability));
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

  const openLayout = () => {
    shouldRestoreFocusRef.current = false;
    onClose();
    goToLayout();
  };

  // A card with no project on it used to be sent to Layout, which is a dead end:
  // Layout's install button needs a bench LED check, the check sends 'frame'
  // messages, and the bridge refuses frames while the card reports
  // playbackReady=false — which is exactly what a card with no project reports.
  // Discovery is the only entrance that works from here.
  const openStripDiscovery = () => {
    shouldRestoreFocusRef.current = false;
    onClose();
    goToStripDiscovery();
  };

  const restartUsbCardForWifi = async () => {
    if (usbReleaseState === 'restarting') return;
    setFailure('');
    setUsbReleaseState('restarting');
    try {
      const result = await releaseActiveUsbInspection();
      if (!result.released) {
        setUsbReleaseState('error');
        return;
      }
      setUsbInspection(null);
      setDirectAttempt(null);
      setUsbReleaseState('restarted');
    } catch {
      setUsbReleaseState('error');
    }
  };

  const connect = async (rawHost = '', { bridge = false } = {}) => {
    setFailure('');
    const activeUsbInspection = getActiveUsbInspection();
    if (!bridge && activeUsbInspection) {
      setUsbInspection(activeUsbInspection);
      return null;
    }
    const targetHost = normalizeCardHost(rawHost || readStoredCardHost());
    if (!isLocalCardHost(targetHost)) {
      setFailure('Enter a valid local Lightweaver hostname before connecting.');
      return;
    }
    if (bridge) {
      const result = connectCardLink(targetHost);
      if (!result) setFailure('The browser could not open the legacy card page. Allow popups, then try again.');
      return result;
    }
    setDirectBusy(true);
    try {
      const result = await connectCardTransport({
        host: targetHost,
        expectedCardId: rememberedCard?.id || link.expectedCard?.id || '',
      });
      setDirectAttempt(result);
      if (result.connected) {
        setCapabilityReady(Boolean(result.ownerCapability));
        setFailure('');
        return result;
      }
      if (result.reason === 'wrong-card') {
        setFailure(`Wrong card: expected ${result.expectedCardId || 'the paired card'}, but found ${result.observedCardId || 'another Lightweaver'}. Writes remain blocked.`);
      } else if (result.reason === 'firmware-incompatible' && result.observedCard?.id) {
        const version = result.observedCard.firmwareVersion ? ` firmware v${result.observedCard.firmwareVersion}` : ' firmware';
        const build = cardBuildLabel(result.observedCard);
        setFailure(`Found card ${result.observedCard.id} running${version}${build ? ` · ${build}` : ''}, but it cannot provide the exact safety evidence this Studio requires. Update this card to continue.`);
      } else if (result.reason === 'direct-unavailable') {
        setFailure('Studio received no reply from the card. It cannot yet tell whether the cause is Wi-Fi or local-network permission, or older firmware. Nothing has been changed.');
      } else {
        setFailure('Studio could not reach the card directly. Check that this device is on the same Wi-Fi and that local-network access is allowed.');
      }
      return result;
    } finally {
      setDirectBusy(false);
    }
  };

  const enableLiveControl = async () => {
    if (!directAttempt?.connected || capabilityBusy) return;
    setCapabilityBusy(true);
    setFailure('');
    try {
      await directAttempt.issueOwnerCapability({ commissioningProof: 'owner-confirmed-physical-control' });
      setCapabilityReady(true);
    } catch (error) {
      setCapabilityReady(false);
      setFailure(error?.status === 403
        ? 'Pairing was not confirmed. Touch a physical control on this card, then choose Enable live control again.'
        : (error?.message || 'The card could not authorize live control.'));
    } finally {
      setCapabilityBusy(false);
    }
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

  const chooseFactoryBeacon = () => {
    setIntent('factory-beacon');
    setFailure('');
  };

  const chooseBlankCard = () => {
    setIntent('blank-card');
    if (capabilities.canWebSerialInstall) openInstall();
  };

  const pairDiscoveredBridgeCard = async (targetHost) => {
    if (!readPersistedCardIdentity()?.id) {
      await adoptDiscoveredCardBridgeIdentity(targetHost);
    } else {
      await rePairDiscoveredCardBridgeIdentity(targetHost);
    }
  };

  const useDiscoveredCard = async () => {
    setPairingBusy(true);
    try {
      if (link.transport === 'direct' && link.discoveredCard?.id) {
        await adoptDiscoveredDirectCard();
      } else {
        await pairDiscoveredBridgeCard(link.host);
      }
      setTakeoverHost('');
      setFailure('');
    } catch (error) {
      if (error?.reason === 'stale-host') {
        const activeHost = normalizeCardHost(getCardBridgeState().host || link.host || readStoredCardHost());
        setTakeoverHost(activeHost);
        setFailure('Studio found the card through an earlier connection. Take over that connection to use the card in this Studio.');
      } else {
        setTakeoverHost('');
        setFailure(error?.message || 'Studio could not pair this card.');
      }
    } finally {
      setPairingBusy(false);
    }
  };

  const takeOverConnection = async () => {
    if (!takeoverHost || pairingBusy) return;
    setPairingBusy(true);
    setFailure('Taking over the card connection…');
    try {
      // Acquisition must begin synchronously inside this click so the browser
      // permits the named card-page window to be reclaimed. Discovery is
      // read-only; the explicit pair/re-pair below still performs an uncached
      // status verification before persisting card identity.
      const attempt = acquireCardBridgeFromGesture(takeoverHost, {
        timeoutMs: 15000,
        acceptDiscovered: true,
      });
      await attempt.ready;
      await pairDiscoveredBridgeCard(takeoverHost);
      setTakeoverHost('');
      setFailure('');
    } catch (error) {
      setFailure(error?.message || 'Studio could not take over this card connection.');
    } finally {
      setPairingBusy(false);
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
    if (bridgeLaunchState === 'opening' || bridgeLaunchState === 'waiting-for-bridge' || bridgeLaunchState === 'return-pending') return;
    onClearBridgeResult?.();
    setFailure('');
    setBridgeLaunchState('opening');
    try {
      await onLaunchBridge?.(operation);
      setBridgeLaunchState('waiting-for-bridge');
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
      setBridgeLaunchState('waiting-for-bridge');
      setFailure('That return code is invalid, expired, already used, or belongs to another browser profile. Copy the current code from Bridge and try again in the original Studio tab.');
    } finally { channel.close(); }
  };

  const bridgeOperation = action.id === 'needs-safe-recovery' ? 'recover-current-release' : 'install-current-release';
  const bridgeBusy = ['opening', 'waiting-for-bridge', 'return-pending'].includes(bridgeLaunchState);
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
  const stableRecoveryHost = ordinaryCardRecoveryHost(link.host || host, rememberedCard);
  const ordinaryRetry = action.id === 'recoverable-failure' && action.route === 'local-card-recovery';
  const setupRecovery = ordinaryRetry
    && normalizeCardHost(link.host || host) === stableRecoveryHost;
  const showSetupSteps = setupSteps || setupRecovery;

  const renderPrimaryAction = () => {
    switch (action.id) {
      case 'ready-local-card':
        return <button type="button" className="btn primary" onClick={closeAndRestore}>Done</button>;
      case 'pair-local-card':
        return <button type="button" className="btn primary" onClick={useDiscoveredCard} disabled={pairingBusy}>{pairingBusy ? 'Connecting…' : 'Connect'}</button>;
      case 'card-needs-project':
        return (
          <>
            <button type="button" className="btn primary" data-testid="connection-find-strips" onClick={openStripDiscovery}>
              {STRIP_DISCOVERY_LABEL}
            </button>
            {/* Kept as the secondary path for an owner who already knows the
                strip counts and only wants to draw. It stays honest about the
                order: nothing installs until the strips are known. */}
            <button type="button" className="btn" onClick={openLayout}>Start layout</button>
          </>
        );
      case 'ready-browser-usb':
        return <button type="button" className="btn primary" onClick={openInstall}>Start installation</button>;
      case 'escape-insecure-card-frame':
        // Stable named target ('lightweaver-studio', the same name the firmware
        // card page uses for its Studio opens) so repeated clicks reuse one
        // Studio tab instead of minting a new unnamed tab each time.
        return (
          <a className="btn primary" href={SECURE_INSTALLER_URL} target="lightweaver-studio" rel="noopener noreferrer">
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
          <>
            <button
              type="button"
              className="btn primary"
              onClick={() => connect(
                showSetupSteps ? SETUP_HOST : (ordinaryRetry ? stableRecoveryHost : ''),
                { bridge: showSetupSteps || ordinaryRetry },
              )}
              disabled={action.primaryDisabled}
            >
              {setupRecovery ? 'Continue after joining' : setupSteps ? 'Continue' : ordinaryRetry ? 'Look for the card again' : action.primaryLabel}
            </button>
            {setupRecovery && (
              <button type="button" className="btn" onClick={() => connect(stableRecoveryHost, { bridge: true })}>
                Try local network again
              </button>
            )}
            {ordinaryRetry && !setupRecovery && (
              <button type="button" className="btn" onClick={chooseFactoryBeacon}>
                Eight lights flash twice, then pause
              </button>
            )}
          </>
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

      {usbInspection && (
        <div className="card-windowless-connect" data-testid="active-usb-inspection">
          <h3>Card is in USB install mode</h3>
          <p>
            Card {usbInspection.cardId} is currently held for a USB firmware install.
            {' '}Its Wi-Fi is temporarily off. This does not mean its firmware is out of date.
          </p>
          <div className="card-connection-actions">
            <button type="button" className="btn primary" onClick={closeAndRestore}>Continue firmware update</button>
            <button type="button" className="btn" onClick={restartUsbCardForWifi} disabled={usbReleaseState === 'restarting'}>
              {usbReleaseState === 'restarting' ? 'Restarting card…' : 'Restart card for Wi-Fi connection'}
            </button>
          </div>
          {usbReleaseState === 'error' && (
            <p role="alert">Studio could not release USB safely. Close other serial tools, then try restarting this card again.</p>
          )}
        </div>
      )}

      {!usbInspection && (!['connected-direct', 'connected-bridge'].includes(link.state) || directAttempt?.connected) && (
        <div className="card-windowless-connect" data-testid="windowless-card-connect">
          <h3>{directAttempt?.connected ? 'Live control permission' : 'Connect this card'}</h3>
          <p>{directAttempt?.connected
            ? 'Touch a physical card control, then enable a short-lived permission for live previews and Stop on this exact card.'
            : 'Your browser may ask whether Lightweaver Studio can find devices on your local network. Choose Allow so Studio can verify this exact card.'}</p>
          {usbReleaseState === 'restarted' && (
            <p role="status">Card restarted. Its Wi-Fi may take a moment. Try again when the card rejoins the network.</p>
          )}
          <div className="card-connection-actions">
            {directAttempt?.connected ? (
              <button type="button" className="btn primary" onClick={enableLiveControl} disabled={capabilityBusy || capabilityReady}>
                {capabilityBusy ? 'Confirming…' : capabilityReady ? 'Live control enabled' : 'Enable live control'}
              </button>
            ) : (
              <button type="button" className="btn primary" onClick={() => connect()} disabled={directBusy}>
                {directBusy ? 'Connecting…' : directAttempt ? 'Try again' : 'Connect this card'}
              </button>
            )}
            {directAttempt?.connected === false && directAttempt.reason === 'direct-unavailable' && (
              <button
                type="button"
                className="btn"
                onClick={() => window.location.assign(directAttempt.recovery.localStudioUrl)}
              >
                Open local Studio
              </button>
            )}
            {directAttempt?.connected === false && directAttempt.reason === 'direct-unavailable' && (
              <button type="button" className="btn primary" onClick={onOpenFirmwareUpdate || openInstall}>Check or update firmware</button>
            )}
            {incompatibleFirmware && (
              <button type="button" className="btn primary" onClick={onOpenFirmwareUpdate || openInstall}>Install current firmware</button>
            )}
          </div>
          {directIdentity?.id && (
            <dl className="card-acknowledged-facts card-direct-firmware-facts" data-testid="direct-card-identity">
              <div className="card-fact-row">
                <dt>Card</dt><dd>{directIdentity.id}</dd>
              </div>
              <div className="card-fact-row">
                <dt>Installed</dt>
                <dd className="card-fact-value-with-action">
                  <span className="card-firmware-version">{directIdentity.firmwareVersion ? `v${directIdentity.firmwareVersion}` : 'Version unknown'}{cardBuildLabel(directIdentity) ? ` · ${cardBuildLabel(directIdentity)}` : ''}</span>
                  <span className="card-inline-firmware-slot" aria-hidden="true" />
                </dd>
              </div>
              <div className="card-fact-row">
                <dt>Current</dt>
                <dd className="card-fact-value-with-action">
                  <span className="card-firmware-version">{firmwareRelease?.firmwareVersion ? `v${firmwareRelease.firmwareVersion}` : 'Version unknown'}{cardBuildLabel(firmwareRelease) ? ` · ${cardBuildLabel(firmwareRelease)}` : ''}</span>
                  {showDirectFirmwareUpdate ? (
                    <button type="button" className="btn card-inline-firmware-update" onClick={onOpenFirmwareUpdate || openInstall}>Update firmware</button>
                  ) : <span className="card-inline-firmware-slot" aria-hidden="true" />}
                </dd>
              </div>
            </dl>
          )}
          {directAttempt?.reason === 'wrong-card' && (
            <p role="alert">Expected {directAttempt.expectedCardId || 'the paired card'}; found {directAttempt.observedCardId || 'a different card'}. No card changes are available.</p>
          )}
        </div>
      )}

      {usbInspection ? null : bridgeResult ? (
        <BridgeResumePanel
          result={bridgeResult}
          link={link}
          onReconnect={(reconnectHost = '') => connect(reconnectHost || link?.handoffCorrelation?.host || link?.host || 'lightweaver.local')}
          onRetry={launchBridge}
          onDismiss={onClearBridgeResult}
          onComplete={() => onClearBridgeResult?.('complete')}
          recoverLights={recoverLights}
        />
      ) : incompatibleFirmware ? null : initialChoice ? (
        <div className="card-condition-choices">
          <p>Look at the card and its LEDs, then choose what you see.</p>
          <button type="button" className="card-condition-choice" onClick={chooseWorkingCard}>
            <strong>My card already lights up</strong>
            <span>The artwork is playing a normal moving or steady light pattern.</span>
          </button>
          <button type="button" className="card-condition-choice" onClick={chooseFactoryBeacon}>
            <strong>Eight lights flash twice, then pause</strong>
            <span>The card is alive and waiting for setup.</span>
          </button>
          <button type="button" className="card-condition-choice" onClick={chooseBlankCard}>
            <strong>Blank or not responding</strong>
            <span>The card is new, dark, or does not react after power is connected.</span>
          </button>
        </div>
      ) : (
        <div className="card-connection-action" data-action-id={effectiveActionId} aria-live="polite" aria-busy={(action.busy || bridgeBusy) || undefined}>
          <h3>{bridgeLifecycleState === 'opening' || bridgeLifecycleState === 'waiting-for-bridge' ? 'Waiting for Lightweaver Bridge' : bridgeLifecycleState === 'return-pending' ? 'Return pending' : bridgeLifecycleState === 'installer-unavailable' ? 'Signed Bridge installer unavailable' : setupRecovery ? 'Join the Lightweaver setup network' : action.title}</h3>
          <p>{bridgeLifecycleState === 'opening' || bridgeLifecycleState === 'waiting-for-bridge' ? 'Studio sent the launch request but cannot confirm whether Bridge opened. Keep this tab available for the result, or paste the return code below.' : bridgeLifecycleState === 'return-pending' ? 'Studio is validating the one-time return. Bridge will clear its saved result only after this tab accepts it.' : setupRecovery ? `If the card is pulsing amber, join ${setupNetworkLabel}, then continue.` : action.explanation}</p>
          {action.id === 'escape-insecure-card-frame' && (
            <p>Your browser only allows USB install from a separate secure top-level tab, so the installer opens in the Lightweaver Studio tab.</p>
          )}
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

          {showSetupSteps && (
            <ol className="card-connection-setup-steps">
              <li>Power the Lightweaver card.</li>
              <li>Join <strong>{setupNetworkLabel}</strong>.</li>
              <li>{setupRecovery ? 'Return to Studio, then press Continue after joining.' : 'Finish setup, return to Studio, then press Continue.'}</li>
            </ol>
          )}

          {action.id === 'ready-local-card' && link.card && (
            <dl className="card-acknowledged-facts">
              {link.card.name && <><dt>Name</dt><dd>{link.card.name}</dd></>}
              {link.card.pixelCount > 0 && <><dt>Pixels</dt><dd>{link.card.pixelCount}</dd></>}
              {link.card.gpioSummary && <><dt>Outputs</dt><dd>{link.card.gpioSummary}</dd></>}
              {link.card.firmwareVersion && <><dt>Firmware</dt><dd>{link.card.firmwareVersion}{cardBuildLabel(link.card) ? ` · ${cardBuildLabel(link.card)}` : ''}</dd></>}
            </dl>
          )}

          {showFirmwareUpdate && (
            <div className="card-firmware-update" role="note">
              <strong>Your card firmware is out of date.</strong>
              <p>Installed build {firmwareStatus.installedBuildNumber}; latest build {firmwareStatus.releaseBuildNumber}.</p>
              <div className="card-connection-actions">
                <button type="button" className="btn primary" onClick={onOpenFirmwareUpdate}>Update firmware</button>
                <button type="button" className="btn" onClick={onClose}>Not now</button>
              </div>
            </div>
          )}

          {!showFirmwareUpdate && (
            <div className="card-connection-actions">
              {renderPrimaryAction()}
              {action.secondaryAction?.id === 'adopt-discovered-card' && (
                <button type="button" className="btn" onClick={useDiscoveredCard}>Use this card instead</button>
              )}
              {action.secondaryAction?.id === 'trust-updated-card' && (
                // Same verified adoption path as "Use this card instead": it
                // re-reads identity at the host, re-checks full status, and only
                // then replaces the remembered firmware identity (ui-repair B1).
                <button type="button" className="btn" data-testid="trust-updated-card" onClick={useDiscoveredCard} disabled={pairingBusy}>
                  {pairingBusy ? 'Re-pairing…' : action.secondaryAction.label}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {failure && <p className="card-connection-failure" role="alert">{failure}</p>}
      {takeoverHost && (
        <div className="card-connection-actions">
          <button type="button" className="btn primary" onClick={takeOverConnection} disabled={pairingBusy}>
            {pairingBusy ? 'Taking over…' : 'Take over connection'}
          </button>
        </div>
      )}

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
        <p>The card-page bridge is retained temporarily as a rollout fallback.</p>
        <button type="button" className="btn" onClick={() => connect(host, { bridge: true })}>Use legacy card-page bridge</button>
      </details>
    </section>
  );
}
