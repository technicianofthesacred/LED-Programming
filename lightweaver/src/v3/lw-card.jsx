import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AutomaticInstallScreen, TechnicianFlashScreen } from './lw-flash.jsx';
import { InstallerScreen } from './lw-installer.jsx';
import { DeploymentCheckPanel } from '../components/card/DeploymentCheckPanel.jsx';
import { ProductionScreen } from './lw-production.jsx';
import { SettingsScreen } from './lw-settings.jsx';
import { SetupScreen } from './lw-setup.jsx';
import { consumeCardSectionNavigation, DEFAULT_CARD_SECTION } from './cardWorkspaceRoute.js';
import { cardLinkReasonText, getCardLinkState, isCardLinkConnected } from '../lib/cardLink.js';
import {
  CARD_COMMISSIONING_CHANGED_EVENT,
  inspectCardCommissioning,
} from '../lib/cardCommissioningFlow.js';
import { loadProductionJobFromIndexEntry, loadProductionJobIndex } from '../lib/productionJobPackage.js';
import { prepareCardDeployment } from '../lib/cardDeployment.js';
import { prepareCardStoragePayload } from '../lib/cardStoragePayload.js';
import { readCardProjectEvidence, readCardStatusEnvelope } from '../lib/cardPushClient.js';
import { recoverCardLightsVerified, requireExactReadyCardStatus } from '../lib/cardRecoverLights.js';
import { clearCardProject } from '../lib/cardClearProject.js';
import { guardedResolutionRun, resolvedMatchKey } from '../lib/cardProjectAdoption.js';
import { describeResolvedCardProject } from '../lib/cardProjectResolver.js';
import { normalizeCardHost } from '../lib/cardConnection.js';
import { BENCH_PROJECT_ID } from '../lib/benchConfig.js';
import { STRIP_DISCOVERY_LABEL } from '../lib/cardAction.js';
import { deriveSetupJourney } from '../lib/setupJourney.js';
import { deriveCardLifecycle } from '../lib/cardLifecycle.js';
import { cardTaskCopy } from '../lib/cardTaskCopy.js';

// navigateStudio (the `go` prop) takes a bare screen key, not the `screen=…`
// hash fragment that STRIP_DISCOVERY_ROUTE holds — passing the fragment fell
// through normalizeView() and silently landed on Layout.
const STRIP_DISCOVERY_VIEW = 'discovery';
import {
  clearAbandonedCardEditIntent,
  isCardEditIntentAbandoned,
  readCardEditIntent,
} from '../lib/cardEditIntent.js';
import {
  clearCardEditAuthorization,
  issueCardEditAuthorization,
  issueSignedProductionCardEditAuthorization,
} from '../lib/cardEditAuthorization.js';

// Section bar labels. `workshop` is deliberately absent: Batch production is a
// manufacturing surface reached from the overview link, the support tile, or a
// deep link (#screen=production / #screen=card&section=workshop) — never a tab.
// Setup leads: it is the guided ladder every owner meets, and it is the answer
// to "which port, which colour order, how many LEDs, install it". The tabs
// after it are the same hardware, unguided, for anyone who already knows what
// they want to change. `overview` is deliberately no longer called "Hardware" —
// with Setup beside it, two tabs named for the same box read as two setups.
const SECTION_LABELS = Object.freeze({
  setup: 'Setup',
  overview: 'Card status',
  install: 'Install or update',
  settings: 'Hardware settings',
  support: 'Advanced & Support',
  preferences: 'Preferences',
});

function cardEditIntent() {
  return readCardEditIntent(window.location.search);
}

function CardOverview({
  connected,
  cardHost,
  cardLink,
  cardLifecycle,
  onConnectCard,
  onOpenConnectionCenter,
  onOpenSection,
  onOpenSetupTask,
  go,
  replaceProject,
  currentProject,
  projectGeneration,
  activeCloudProjects = [],
  browserProjects = [],
  readBrowserProjects,
  readCloudProject,
  openMatchingCardProject,
  saveBeforeCardProjectSwitch,
  isProjectSwitchSnapshotCurrent,
  onMatchedProjectLoaded,
  onMatchedProjectVerified,
  onStartNewProject,
}) {
  const [commissioningFlow, setCommissioningFlow] = useState(() => inspectCardCommissioning().flow);
  const [matchingProjectState, setMatchingProjectState] = useState({ status: 'idle', message: '' });
  const [hardwareActionState, setHardwareActionState] = useState({ status: 'idle', message: '' });
  const resolutionContextRef = useRef(null);
  const projectSwitchInFlightRef = useRef(false);
  const cardProjectProbeRef = useRef('');
  const pendingCardProjectProbeRef = useRef(null);
  const [cardProjectProbeRevision, requestCardProjectProbe] = React.useReducer(value => value + 1, 0);
  resolutionContextRef.current = {
    browserProjects,
    cardLink,
    currentProject,
    projectGeneration,
    ready: cardLink ? isCardLinkConnected(cardLink) : connected,
  };
  useEffect(() => {
    const syncCommissioning = () => setCommissioningFlow(inspectCardCommissioning().flow);
    window.addEventListener('storage', syncCommissioning);
    window.addEventListener(CARD_COMMISSIONING_CHANGED_EVENT, syncCommissioning);
    return () => {
      window.removeEventListener('storage', syncCommissioning);
      window.removeEventListener(CARD_COMMISSIONING_CHANGED_EVENT, syncCommissioning);
    };
  }, []);

  const identity = cardLink?.identity?.name
    || cardLink?.identity?.id
    || cardLink?.card?.name
    || cardLink?.card?.id
    || cardLink?.cardName
    || cardLink?.cardId
    || cardLink?.host
    || cardHost;
  const ready = cardLink ? isCardLinkConnected(cardLink) : connected;
  const state = cardLink?.state || (ready ? 'connected-direct' : 'disconnected');
  const activity = cardLink?.activity || 'idle';
  const verifiedTransport = Boolean(cardLink?.card?.id && (
    state === 'connected-direct' || state === 'connected-bridge'
  ));
  const blankCard = verifiedTransport && cardLink?.cardBlank === true;
  // Prefer the card's own claim: new firmware reports provisionalSetup on
  // /api/status when the stored config carries "provisional": true
  // (cardLink.readiness is the raw status envelope). Older firmware never
  // sends the field, so the projectId string match stays as the fallback that
  // recognizes bench configs written before the flag existed (finding #5).
  const benchProject = cardLink?.readiness?.provisionalSetup === true
    || cardLink?.readiness?.projectId === BENCH_PROJECT_ID;
  let currentProjectInstallable = false;
  try {
    prepareCardStoragePayload(prepareCardDeployment(currentProject).runtimePackage);
    currentProjectInstallable = true;
  } catch {
    currentProjectInstallable = false;
  }
  const setupJourney = deriveSetupJourney({
    cardLink,
    cardLifecycle,
    commissioningFlow,
    project: currentProject,
    resolution: benchProject ? { provisionalSetup: true } : null,
  });
  const setupTaskCopy = cardTaskCopy(setupJourney.taskId);

  // Detected-state presentation, keyed off the ONE diagnosis authority
  // (deriveCardLifecycle) instead of a private raw-link ladder. Each row
  // reproduces the copy the old ladder showed for the links that produce that
  // lifecycle state; the only extra inputs are the bench/blank/identity
  // evidence this component already probes. The shell passes its lifecycle
  // (computed with the open project and firmware-update evidence); a bare
  // render derives the same diagnosis from the link alone — the rows below
  // treat `ready` and `project-mismatch` identically, so the missing project
  // input cannot change what renders.
  const lifecycle = cardLifecycle || deriveCardLifecycle({ link: cardLink || {} });
  // Legacy shape: a caller with no cardLink object at all only says
  // `connected` — honor it as the ready presentation, as the old ladder did.
  const lifecycleState = !cardLink && connected ? 'ready' : lifecycle.state;
  const lifecycleReason = cardLink ? lifecycle.reason : '';

  const openSupport = { label: 'Open support', section: 'support' };
  const presentations = {
    operationFailed: () => ({
      tone: 'failure',
      message: 'The last card operation failed. Reconnect and inspect the card before retrying it.',
      primary: { label: 'Reconnect card', action: 'connect' },
      secondary: openSupport,
    }),
    cardRestarted: () => ({
      tone: 'connecting',
      message: 'Card restarted — verifying the exact card, firmware, and project before commands resume.',
      primary: { label: 'Card restarted — verifying', disabled: true },
      secondary: openSupport,
    }),
    checkingStability: () => ({
      tone: 'connecting',
      message: 'Checking card. Studio is waiting for two stable exact status checks before commands resume.',
      primary: { label: 'Checking card', disabled: true },
      secondary: openSupport,
    }),
    stoppedResponding: () => ({
      tone: 'connecting',
      message: 'Card stopped responding. Studio is reconnecting and will require fresh status before commands resume.',
      primary: { label: 'Card stopped responding', disabled: true },
      secondary: openSupport,
    }),
    recoveringOperation: () => ({
      tone: 'connecting',
      message: 'Studio is recovering the last card operation. Keep this page open until the result is confirmed.',
      primary: { label: 'Recovery in progress…', disabled: true },
      secondary: openSupport,
    }),
    pendingOperation: () => ({
      tone: 'connecting',
      message: 'A card operation is in progress. Keep this page open until Studio confirms the result.',
      primary: { label: 'Card operation in progress…', disabled: true },
      secondary: openSupport,
    }),
    connecting: () => ({
      tone: 'connecting',
      message: 'Studio is looking for the card. Keep the card page open while its identity is verified.',
      primary: { label: 'Connecting…', disabled: true },
      secondary: openSupport,
    }),
    blank: () => ({
      tone: 'failure',
      message: 'Blank — load a project, or find this card’s strips first.',
      primary: { label: STRIP_DISCOVERY_LABEL, action: 'discovery' },
      secondary: { label: 'Install current project', section: 'settings', disabled: !currentProjectInstallable },
      tertiary: { label: 'Start a new project', action: 'new-project' },
    }),
    bench: () => ({
      tone: 'connecting',
      message: `${identity || 'A Lightweaver card'} is connected, but it is running the temporary Find-my-strips setup — not one of your projects. Install your project to replace it, run Find my strips again, or use Clear temporary setup under Checks & recovery below.`,
      primary: { label: 'Install on card', section: 'settings' },
      secondary: { label: STRIP_DISCOVERY_LABEL, action: 'discovery' },
    }),
    readyForLightCheck: () => ({
      tone: 'connected',
      message: `${identity || 'A Lightweaver card'} is connected and ready for light check.`,
      primary: { label: 'Install on card', section: 'settings' },
    }),
    checkingEvidence: () => ({
      tone: 'connecting',
      message: 'Checking card. Studio is waiting for complete identity, project, and command readiness evidence.',
      primary: { label: 'Checking card', disabled: true },
      secondary: openSupport,
    }),
    foundUnpaired: () => {
      const foundProjectId = cardLink?.discoveredCard?.projectId || '';
      return {
        tone: 'disconnected',
        message: foundProjectId === BENCH_PROJECT_ID
          ? 'Lightweaver found — it is holding an unfinished Find my strips setup, not one of your projects. Tap Connect to pair, then finish setup or install your project.'
          : foundProjectId
            ? `Lightweaver found running “${foundProjectId}” — tap Connect to pair.`
            : 'Lightweaver found — tap Connect to pair.',
        primary: { label: 'Connect card', action: 'connect' },
        secondary: openSupport,
      };
    },
    updateNeeded: failureReason => ({
      tone: 'failure',
      message: `${cardLinkReasonText(failureReason)} Update it before loading changes.`,
      primary: { label: 'Update card', section: 'install' },
      secondary: openSupport,
    }),
    reasonFailure: failureReason => ({
      tone: 'failure',
      message: `${cardLinkReasonText(failureReason)} Reconnect and inspect the card before loading changes.`,
      primary: { label: failureReason === 'wrong-card' ? 'Connect expected card' : 'Reconnect card', action: 'connect' },
      secondary: openSupport,
    }),
    notConnected: () => ({
      tone: 'disconnected',
      message: 'A Lightweaver card is not connected. Connect one to inspect it before installing or loading a project.',
      primary: { label: 'Connect card', action: 'connect' },
      secondary: { label: 'Install Lightweaver', section: 'install' },
    }),
  };

  let presentation;
  switch (lifecycleState) {
    case 'verifying':
      presentation = lifecycleReason === 'card-restarted'
        ? presentations.cardRestarted()
        : presentations.checkingStability();
      break;
    case 'reconnecting':
      presentation = presentations.stoppedResponding();
      break;
    case 'recovering':
      presentation = presentations.recoveringOperation();
      break;
    case 'connecting':
      presentation = activity === 'pending'
        ? presentations.pendingOperation()
        : presentations.connecting();
      break;
    case 'updating':
    case 'update-recovering':
      // A firmware update in flight is an operation in progress on this
      // surface (the old ladder read the link's pending activity here).
      presentation = presentations.pendingOperation();
      break;
    case 'update-rolled-back':
    case 'target-mismatch':
    case 'project-changed':
      // A blocked or rolled-back update is a failed operation to recover
      // from; the guided detail lives in Setup and the install section.
      presentation = presentations.operationFailed();
      break;
    case 'setup-required':
      presentation = presentations.blank();
      break;
    case 'confirming':
      presentation = presentations.checkingEvidence();
      break;
    case 'ready':
    case 'project-mismatch':
      // Both are a command-ready card; which project it holds is the Setup
      // ladder's question, not this surface's — exactly as before.
      presentation = benchProject ? presentations.bench() : presentations.readyForLightCheck();
      break;
    case 'found-unpaired':
      presentation = presentations.foundUnpaired();
      break;
    case 'wrong-card':
      presentation = presentations.reasonFailure('wrong-card');
      break;
    case 'update-required':
      presentation = presentations.updateNeeded(lifecycleReason || 'firmware-too-old');
      break;
    case 'attention-required':
      if (activity === 'failed') presentation = presentations.operationFailed();
      else if (ready) presentation = benchProject ? presentations.bench() : presentations.readyForLightCheck();
      else if (verifiedTransport) presentation = presentations.checkingEvidence();
      else if (lifecycleReason && lifecycleReason !== 'never-connected') presentation = presentations.reasonFailure(lifecycleReason);
      else presentation = presentations.notConnected();
      break;
    case 'disconnected':
    default:
      presentation = lifecycleReason && lifecycleReason !== 'never-connected'
        ? presentations.reasonFailure(lifecycleReason)
        : presentations.notConnected();
      break;
  }

  // Connect actions must be visible: prefer the connection center when the
  // shell provides it, and fall back to the background probe otherwise.
  const openConnection = () => (onOpenConnectionCenter ? onOpenConnectionCenter() : onConnectCard?.());
  const requireExactReadyStatus = (status) => requireExactReadyCardStatus(status, cardLink?.card?.id);
  const verifyHardware = async () => {
    if (hardwareActionState.status === 'loading') return;
    setHardwareActionState({ status: 'loading', message: 'Reading exact card hardware state…' });
    try {
      const status = requireExactReadyStatus(await readCardStatusEnvelope({ host: cardLink?.host || cardHost }));
      const pixels = Number(status.led?.pixels) || Number(cardLink?.card?.pixelCount) || 0;
      setHardwareActionState({
        status: 'ok',
        message: `Hardware readback verified for ${status.cardId}${pixels ? ` · ${pixels} LEDs` : ''}. This confirms card state, not visible light output.`,
      });
    } catch (error) {
      setHardwareActionState({ status: 'error', message: error?.message || 'Hardware readback failed. Reconnect the card and try again.' });
    }
  };
  const recoverLights = async () => {
    if (hardwareActionState.status === 'loading') return;
    setHardwareActionState({ status: 'loading', message: 'Sending safe warm-white recovery…' });
    try {
      const response = await recoverCardLightsVerified(
        { patternId: 'warm-white', brightness: 0.35, syncZones: true },
        {
          host: cardLink?.host || cardHost,
          timeoutMs: 3200,
          verifyReadback: { expectedCardId: cardLink?.card?.id },
        },
      );
      setHardwareActionState({
        status: 'ok',
        // On a bench card the honest headline is what did NOT change: leading
        // with "acknowledged" read as success while the thing the owner wanted
        // fixed stayed broken (ui-repair B4).
        message: benchProject
          ? 'The lights were recovered to warm white, but that is all this did: the card is still running the temporary Find-my-strips setup and will return to it after a restart. Use Clear temporary setup below to actually remove it, or install your project to replace it.'
          : `Recovery command ${response?.restarted ? 'survived restart and was' : 'was'} acknowledged with ready-state readback. Check the real LEDs; visible warm white is not confirmed automatically.`,
      });
    } catch (error) {
      setHardwareActionState({ status: 'error', message: error?.message || 'Recovery was not verified. Keep the card powered, reconnect, and retry.' });
    }
  };
  // The non-destructive way off a stranded Find-my-strips bench project:
  // clears only the temporary setup (the card keeps its WiFi and name), then
  // the card reboots blank and the ordinary blank-card flow takes over. No
  // browser confirm dialog: the temporary setup contains nothing the owner
  // made, and the firmware itself demands the CLEAR token before acting.
  const clearTemporarySetup = async () => {
    if (hardwareActionState.status === 'loading') return;
    setHardwareActionState({ status: 'loading', message: 'Clearing the temporary Find-my-strips setup…' });
    try {
      await clearCardProject({ host: cardLink?.host || cardHost });
      setHardwareActionState({
        status: 'ok',
        message: 'The temporary setup was cleared. The card kept its WiFi and is restarting blank — reconnect in a few seconds, then install your project or run Find my strips.',
      });
    } catch (error) {
      setHardwareActionState({ status: 'error', message: error?.message || 'The card did not confirm the clear. Keep it powered, reconnect, and try again.' });
    }
  };
  // The adoption machine itself lives in lib/cardProjectAdoption.js — the
  // save barrier, exact re-snapshots, drift guards, resolution, and the
  // status-envelope authorization all run there. This binding supplies the
  // component's props, refs, and state setters, so the harness-injected
  // handler contract (tests/card-workspace.spec.ts) is unchanged.
  const loadMatchingCardProject = useCallback(async ({ probeOnly = false, selectionKey = '', autoIntent = '', probeSignature = '' } = {}) => {
    await guardedResolutionRun({
      context: {
        ready,
        cardLink,
        cardHost,
        currentProject,
        projectGeneration,
        activeCloudProjects,
        browserProjects,
      },
      getLatestContext: () => resolutionContextRef.current,
      getSharedCardLink: getCardLinkState,
      isCardLinkConnected,
      io: {
        readCardProjectEvidence,
        readCardStatusEnvelope,
        loadProductionJobIndex,
        loadProductionJobFromIndexEntry,
        readCloudProject,
        readBrowserProjects,
      },
      actions: {
        replaceProject,
        saveBeforeCardProjectSwitch,
        isProjectSwitchSnapshotCurrent,
        openMatchingCardProject,
        onMatchedProjectLoaded,
        onMatchedProjectVerified,
      },
      authorization: {
        clearCardEditAuthorization,
        issueCardEditAuthorization,
        issueSignedProductionCardEditAuthorization,
        clearAbandonedCardEditIntent,
        getCardEditIntent: cardEditIntent,
      },
      ui: {
        report: setMatchingProjectState,
        openPatterns: () => { window.location.hash = '#screen=pattern'; },
      },
      flight: {
        inFlight: projectSwitchInFlightRef,
        pendingProbe: pendingCardProjectProbeRef,
        probeSignature: cardProjectProbeRef,
      },
      requestProbe: requestCardProjectProbe,
    }, { strategy: probeOnly ? 'probe' : 'resolved', selectionKey, autoIntent, probeSignature });
  }, [
    activeCloudProjects,
    browserProjects,
    cardHost,
    cardLink,
    currentProject,
    onMatchedProjectLoaded,
    onMatchedProjectVerified,
    openMatchingCardProject,
    readCloudProject,
    readBrowserProjects,
    ready,
    replaceProject,
    projectGeneration,
    saveBeforeCardProjectSwitch,
    isProjectSwitchSnapshotCurrent,
  ]);
  useEffect(() => {
    if (!ready) return;
    const candidateSourceSignature = [
      activeCloudProjects
        .map(project => `${project?.id || ''}:${project?.revision ?? ''}:${project?.embeddedProjectId || ''}`)
        .sort()
        .join(','),
      browserProjects
        .map(record => `${record?.id || ''}:${record?.updatedAt ?? ''}:${record?.project?.id || ''}`)
        .sort()
        .join(','),
    ].join('::');
    const signature = [
      normalizeCardHost(cardLink?.host || cardHost),
      cardLink?.card?.id,
      cardLink?.card?.buildId,
      cardLink?.readiness?.bootId,
      cardLink?.operationGeneration,
      cardLink?.revalidationGeneration,
      cardLink?.readiness?.projectId,
      cardLink?.readiness?.projectRevision,
      cardLink?.readiness?.projectFingerprint,
      cardLink?.readiness?.productionJobId,
      cardLink?.readiness?.productionJobDigest,
      projectGeneration,
      candidateSourceSignature,
    ].join('|');
    if (cardProjectProbeRef.current === signature) return;
    // An intent Patterns already failed to claim must not be handed over
    // again on our own initiative — that is the loop. It stays in the URL, so
    // the offer below still opens the right thing when the owner asks for it.
    const requestedIntent = cardEditIntent();
    const autoIntent = isCardEditIntentAbandoned(requestedIntent) ? '' : requestedIntent;
    void loadMatchingCardProject({ probeOnly: !autoIntent, autoIntent, probeSignature: signature });
  }, [activeCloudProjects, browserProjects, cardHost, cardLink, cardProjectProbeRevision, loadMatchingCardProject, projectGeneration, ready]);
  return (
    <div className="card-overview">
      <div className="card-overview-state">
        <span className={`card-overview-signal ${presentation.tone}`} aria-hidden="true" />
        <div>
          <span className="card-workspace-kicker">Detected state</span>
          <p data-testid="card-detected-state">{presentation.message}</p>
        </div>
      </div>

      <div className="card-support-panel" data-testid="card-setup-diagnosis">
        <h2>Next setup task</h2>
        <p>{setupTaskCopy}</p>
        <button type="button" className="btn primary" onClick={() => onOpenSetupTask?.(setupJourney.taskId)}>
          Continue setup
        </button>
      </div>

      {ready && (
        <section className="card-support-panel" aria-label="Matching card project">
          <h2>Matching card project</h2>
          <p>Open the exact active Studio project installed on this card before changing patterns, so its LED count, wiring, protocol, and power limit stay aligned.</p>
          {matchingProjectState.status !== 'ambiguous' && (
            <button
              type="button"
              className="btn primary"
              disabled={matchingProjectState.status === 'loading' || matchingProjectState.status === 'saving'}
              onClick={() => void loadMatchingCardProject({ selectionKey: matchingProjectState.selectionKey || '' })}
            >
              {matchingProjectState.status === 'saving'
                ? 'Saving current project…'
                : matchingProjectState.status === 'loading'
                ? 'Verifying project…'
                : matchingProjectState.matchLabel
                  ? `Load ${matchingProjectState.matchLabel}`
                  : 'Load matching card project'}
            </button>
          )}
          {matchingProjectState.status === 'ambiguous' && (
            <div className="card-overview-actions" aria-label="Exact matching projects">
              {matchingProjectState.matches.map(match => (
                <button
                  key={resolvedMatchKey(match)}
                  type="button"
                  className="btn"
                  onClick={() => void loadMatchingCardProject({ selectionKey: resolvedMatchKey(match) })}
                >
                  Load {describeResolvedCardProject(match)}
                </button>
              ))}
            </div>
          )}
          {matchingProjectState.message && (
            <p role={matchingProjectState.status === 'error' ? 'alert' : 'status'}>{matchingProjectState.message}</p>
          )}
        </section>
      )}

      {ready && (
        <section className="card-support-panel" aria-label="Hardware checks and recovery">
          <h2>Checks &amp; recovery</h2>
          <p>These actions report card acknowledgements and state readback. Studio never marks a visual LED or color test passed without your confirmation.</p>
          <div className="card-overview-actions">
            <button type="button" className="btn" disabled={hardwareActionState.status === 'loading'} onClick={() => void verifyHardware()}>Verify hardware</button>
            <button type="button" className="btn" disabled={hardwareActionState.status === 'loading'} onClick={() => void recoverLights()}>Recover lights</button>
            {benchProject && (
              <button type="button" className="btn" disabled={hardwareActionState.status === 'loading'} onClick={() => void clearTemporarySetup()}>Clear temporary setup</button>
            )}
            <button type="button" className="btn" onClick={() => { window.location.hash = '#screen=card&section=settings&tool=color-order'; }}>Color-order test</button>
          </div>
          {hardwareActionState.message && (
            <p role={hardwareActionState.status === 'error' ? 'alert' : 'status'}>{hardwareActionState.message}</p>
          )}
        </section>
      )}

      <p className="card-overview-batch" data-testid="card-batch-link">
        <span style={{ color: 'var(--text-faint)' }}>Making many cards? </span>
        <button type="button" className="link-btn" onClick={() => onOpenSection('workshop')}>Batch production</button>
      </p>
    </div>
  );
}

function RecoverySupport({ onConnectCard, onOpenConnectionCenter }) {
  return (
    <section className="card-support-panel">
      <h2>Safe recovery</h2>
      <p>Reconnect and inspect the card before choosing an install or write action. Opening recovery here does not erase firmware, WiFi, or the saved project.</p>
      <button
        type="button"
        className="btn primary"
        onClick={() => (onOpenConnectionCenter ? onOpenConnectionCenter() : onConnectCard?.())}
      >
        Reconnect card
      </button>
    </section>
  );
}

function CardSupport({ initialTool, cardProps, onOpenConnectionCenter, onOpenSection }) {
  const [tool, setTool] = useState(initialTool);
  useEffect(() => setTool(initialTool), [initialTool]);

  const installerGo = target => {
    if (target === 'flash') onOpenSection('install');
    else if (target === 'settings') onOpenSection('settings');
  };

  return (
    <div className="card-support">
      <div className="card-support-grid" aria-label="Advanced and support tools">
        <button type="button" aria-label="Technician firmware & logs" className={tool === 'technician' ? 'selected' : ''} aria-pressed={tool === 'technician'} onClick={() => setTool('technician')}>
          <strong>Technician firmware &amp; logs</strong><span>Manual firmware, offsets, erase controls, and serial output.</span>
        </button>
        <button type="button" aria-label="GPIO & install guide" className={tool === 'guide' ? 'selected' : ''} aria-pressed={tool === 'guide'} onClick={() => setTool('guide')}>
          <strong>GPIO &amp; install guide</strong><span>Worker sequence, wiring pins, hard stops, and bench signoff.</span>
        </button>
        <button type="button" aria-label="Designer JSON" className={tool === 'json' ? 'selected' : ''} aria-pressed={tool === 'json'} onClick={() => setTool('json')}>
          <strong>Designer JSON</strong><span>Inspect the exact configuration Studio would write.</span>
        </button>
        <button type="button" aria-label="Recovery" className={tool === 'recovery' ? 'selected' : ''} aria-pressed={tool === 'recovery'} onClick={() => setTool('recovery')}>
          <strong>Recovery</strong><span>Reconnect safely and choose the next evidence-based action.</span>
        </button>
        <button type="button" aria-label="Deployment check" className={tool === 'deployment' ? 'selected' : ''} aria-pressed={tool === 'deployment'} onClick={() => setTool('deployment')}>
          <strong>Deployment check</strong><span>Verify this site's signed release from the browser — no install needed.</span>
        </button>
        <button type="button" aria-label="Batch production" onClick={() => onOpenSection('workshop')}>
          <strong>Batch production</strong><span>Signed-job manufacturing flow with identity binding and pass records.</span>
        </button>
      </div>

      {tool && (
        <div className="card-support-tool">
          {tool === 'technician' && <TechnicianFlashScreen embedded />}
          {tool === 'guide' && <InstallerScreen embedded go={installerGo} cardLink={cardProps.cardLink} />}
          {tool === 'json' && <SettingsScreen embedded mode="advanced" {...cardProps} />}
          {tool === 'recovery' && <RecoverySupport onConnectCard={cardProps.onConnectCard} onOpenConnectionCenter={onOpenConnectionCenter} />}
          {tool === 'deployment' && <DeploymentCheckPanel />}
        </div>
      )}
    </div>
  );
}

export function CardScreen({ connected, cardHost, cardLink, cardLifecycle, onConnectCard, onOpenConnectionCenter, onOpenSection, onOpenSetupTask, onFirmwareRecoveryState, go, replaceProject, currentProject, projectGeneration, activeCloudProjects, browserProjects, readBrowserProjects, readCloudProject, openMatchingCardProject, confirmProjectReplacement, saveBeforeCardProjectSwitch, saveProjectToBrowserGuarded, isProjectSwitchSnapshotCurrent, onMatchedProjectLoaded, onMatchedProjectVerified, onStartNewProject, onSaveProject, route = { section: DEFAULT_CARD_SECTION, supportTool: '' } }) {
  const headingRef = useRef(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    // Focus the section heading after in-app section navigation (required
    // a11y behavior), but never on a direct page load — mount-time focus
    // steals whatever the user or a keyboard test is about to activate.
    const navigated = consumeCardSectionNavigation();
    if (!mountedRef.current) {
      mountedRef.current = true;
      if (!navigated) return undefined;
    }
    const frame = requestAnimationFrame(() => headingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [route.section]);

  const cardProps = { connected, cardHost, cardLink, cardLifecycle, onConnectCard };
  let content;
  if (route.section === 'setup') content = (
    <SetupScreen
      {...cardProps}
      onOpenConnectionCenter={onOpenConnectionCenter}
      currentProject={currentProject}
      activeCloudProjects={activeCloudProjects}
      browserProjects={browserProjects}
      replaceProject={replaceProject}
      onSaveProject={onSaveProject}
    />
  );
  else if (route.section === 'install') content = (
    <AutomaticInstallScreen
      embedded
      cardLink={cardLink}
      cardLifecycle={cardLifecycle}
      onFirmwareRecoveryState={onFirmwareRecoveryState}
      onConnectCard={onConnectCard}
      persistCurrentProjectToBrowser={saveProjectToBrowserGuarded}
      onCommissioningComplete={() => onOpenSection('overview')}
    />
  );
  else if (route.section === 'settings') content = <SettingsScreen embedded mode="card" {...cardProps} />;
  else if (route.section === 'workshop') content = <ProductionScreen embedded cardHost={cardHost} cardLink={cardLink} onConnectCard={onConnectCard} />;
  else if (route.section === 'preferences') content = <SettingsScreen embedded mode="preferences" {...cardProps} />;
  else if (route.section === 'support') content = <CardSupport initialTool={route.supportTool} cardProps={cardProps} onOpenConnectionCenter={onOpenConnectionCenter} onOpenSection={onOpenSection} />;
  else content = <CardOverview {...cardProps} onOpenConnectionCenter={onOpenConnectionCenter} onOpenSection={onOpenSection} onOpenSetupTask={onOpenSetupTask} go={go} replaceProject={replaceProject} currentProject={currentProject} projectGeneration={projectGeneration} activeCloudProjects={activeCloudProjects} browserProjects={browserProjects} readBrowserProjects={readBrowserProjects} readCloudProject={readCloudProject} openMatchingCardProject={openMatchingCardProject} confirmProjectReplacement={confirmProjectReplacement} saveBeforeCardProjectSwitch={saveBeforeCardProjectSwitch} isProjectSwitchSnapshotCurrent={isProjectSwitchSnapshotCurrent} onMatchedProjectLoaded={onMatchedProjectLoaded} onMatchedProjectVerified={onMatchedProjectVerified} onStartNewProject={onStartNewProject} />;

  // Batch production (route.section === 'workshop') renders outside the tab
  // set: its own heading and kicker, no section tab highlighted.
  const workshop = route.section === 'workshop';
  const setup = route.section === 'setup';
  const heading = setup
    ? 'Set up your Lightweaver'
    : route.section === 'overview'
      ? 'Your Lightweaver hardware'
      : workshop ? 'Batch production' : SECTION_LABELS[route.section];
  return (
    <div className="screen card-workspace-screen">
      <div className="card-workspace">
        <nav className="card-section-nav" aria-label="Hardware sections">
          <div className="card-section-mobile">
            <span className="card-section-mobile-label" aria-hidden="true">Hardware</span>
            <label className="card-section-select-wrap">
              <select
                aria-label="Hardware section"
                value={SECTION_LABELS[route.section] ? route.section : ''}
                onChange={event => event.target.value && onOpenSection(event.target.value)}
              >
                <option value="" disabled>Choose a section</option>
                {Object.entries(SECTION_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>{label}</option>
                ))}
              </select>
              <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16">
                <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </label>
          </div>
          <div className="card-section-tabs">
            {Object.entries(SECTION_LABELS).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-current={route.section === key ? 'page' : undefined}
                onClick={() => onOpenSection(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </nav>
        <main className={`card-workspace-body${setup ? ' lw-setup-body' : ''}`}>
          <header className="card-workspace-header">
            <span className="card-workspace-kicker">{workshop ? 'Manufacturing mode' : 'Lightweaver hardware'}</span>
            <h1 ref={headingRef} tabIndex={-1}>{heading}</h1>
            {workshop && (
              <button type="button" className="btn" onClick={() => onOpenSection('overview')}>Back to Hardware</button>
            )}
          </header>
          {content}
        </main>
      </div>
    </div>
  );
}
