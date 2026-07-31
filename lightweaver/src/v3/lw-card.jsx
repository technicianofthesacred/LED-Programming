import React, { useEffect, useRef, useState } from 'react';
import { AutomaticInstallScreen, TechnicianFlashScreen } from './lw-flash.jsx';
import { InstallerScreen } from './lw-installer.jsx';
import { DeploymentCheckPanel } from '../components/card/DeploymentCheckPanel.jsx';
import { ProductionScreen } from './lw-production.jsx';
import { SettingsScreen } from './lw-settings.jsx';
import { consumeCardSectionNavigation } from './cardWorkspaceRoute.js';
import { cardLinkReasonText, isCardLinkConnected } from '../lib/cardLink.js';
import {
  CARD_COMMISSIONING_CHANGED_EVENT,
  inspectCardCommissioning,
} from '../lib/cardCommissioningFlow.js';
import { loadProductionJobFromIndexEntry, loadProductionJobIndex } from '../lib/productionJobPackage.js';
import { createDefaultProject } from '../lib/projectModel.js';
import { readCardStatusEnvelope } from '../lib/cardPushClient.js';
import { recoverCardLights } from '../lib/cardLiveControl.js';

// Section bar labels. `workshop` is deliberately absent: Batch production is a
// manufacturing surface reached from the overview link, the support tile, or a
// deep link (#screen=production / #screen=card&section=workshop) — never a tab.
const SECTION_LABELS = Object.freeze({
  overview: 'Hardware',
  install: 'Install or update',
  settings: 'Hardware settings',
  support: 'Advanced & Support',
  preferences: 'Preferences',
});

function CardOverview({ connected, cardHost, cardLink, onConnectCard, onOpenConnectionCenter, onOpenSection, replaceProject }) {
  const [commissioningFlow, setCommissioningFlow] = useState(() => inspectCardCommissioning().flow);
  const [matchingProjectState, setMatchingProjectState] = useState({ status: 'idle', message: '' });
  const [hardwareActionState, setHardwareActionState] = useState({ status: 'idle', message: '' });
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
  const reason = cardLink?.reason || '';
  const activity = cardLink?.activity || 'idle';
  const verifiedTransport = Boolean(cardLink?.card?.id && (
    state === 'connected-direct' || state === 'connected-bridge'
  ));
  const productionJobId = String(cardLink?.card?.productionJobId || '').trim();
  const setupLabels = ['Connect', 'Install firmware', 'WiFi', 'Install on card', 'Test lights'];
  let currentSetupIndex = ready ? 3 : 0;
  if (commissioningFlow?.stage === 'install-safely') currentSetupIndex = 1;
  else if (commissioningFlow?.stage === 'set-up-card') {
    currentSetupIndex = ['setup-required', 'setup-joined'].includes(commissioningFlow.networkState) ? 2 : 3;
  } else if (commissioningFlow?.stage === 'check-lights') currentSetupIndex = 4;

  let commissioningAction = null;
  if (commissioningFlow?.stage === 'install-safely') {
    commissioningAction = { label: 'Continue installation', section: 'install' };
  } else if (commissioningFlow?.stage === 'set-up-card') {
    if (['setup-required', 'setup-joined'].includes(commissioningFlow.networkState)) {
      commissioningAction = { label: 'Continue WiFi setup', section: 'install' };
    } else if (commissioningFlow.cardAcknowledgedAt) {
      commissioningAction = { label: 'Install project on card', section: 'install' };
    } else {
      commissioningAction = { label: 'Reconnect installed card', section: 'install' };
    }
  } else if (commissioningFlow?.stage === 'check-lights') {
    commissioningAction = { label: 'Test lights', section: 'install' };
  }

  let presentation;
  if (activity === 'failed') {
    presentation = {
      tone: 'failure',
      message: 'The last card operation failed. Reconnect and inspect the card before retrying it.',
      primary: { label: 'Reconnect card', action: 'connect' },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (state === 'revalidating' && reason === 'card-restarted') {
    presentation = {
      tone: 'connecting',
      message: 'Card restarted — verifying the exact card, firmware, and project before commands resume.',
      primary: { label: 'Card restarted — verifying', disabled: true },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (state === 'revalidating') {
    presentation = {
      tone: 'connecting',
      message: 'Checking card. Studio is waiting for two stable exact status checks before commands resume.',
      primary: { label: 'Checking card', disabled: true },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (state === 'reconnecting-bridge' || state === 'reconnecting') {
    presentation = {
      tone: 'connecting',
      message: 'Card stopped responding. Studio is reconnecting and will require fresh status before commands resume.',
      primary: { label: 'Card stopped responding', disabled: true },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (activity === 'recovering') {
    presentation = {
      tone: 'connecting',
      message: 'Studio is recovering the last card operation. Keep this page open until the result is confirmed.',
      primary: { label: 'Recovery in progress…', disabled: true },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (state === 'connecting' || activity === 'pending') {
    presentation = {
      tone: 'connecting',
      message: activity === 'pending'
        ? 'A card operation is in progress. Keep this page open until Studio confirms the result.'
        : 'Studio is looking for the card. Keep the card page open while its identity is verified.',
      primary: { label: activity === 'pending' ? 'Card operation in progress…' : 'Connecting…', disabled: true },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (verifiedTransport && cardLink?.cardBlank === true) {
    presentation = {
      tone: 'failure',
      message: 'Blank — load a project before using this card.',
      primary: { label: 'Load a project', section: 'install' },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (ready) {
    presentation = {
      tone: 'connected',
      message: `${identity || 'A Lightweaver card'} is connected and ready for light check.`,
      primary: { label: 'Install on card', section: 'settings' },
    };
  } else if (verifiedTransport) {
    presentation = {
      tone: 'connecting',
      message: 'Checking card. Studio is waiting for complete identity, project, and command readiness evidence.',
      primary: { label: 'Checking card', disabled: true },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else if (reason && reason !== 'never-connected') {
    const updateNeeded = reason === 'firmware-too-old' || reason === 'identity-missing';
    presentation = {
      tone: 'failure',
      message: updateNeeded
        ? `${cardLinkReasonText(reason)} Update it before loading changes.`
        : `${cardLinkReasonText(reason)} Reconnect and inspect the card before loading changes.`,
      primary: updateNeeded
        ? { label: 'Update card', section: 'install' }
        : { label: reason === 'wrong-card' ? 'Connect expected card' : 'Reconnect card', action: 'connect' },
      secondary: { label: 'Open support', section: 'support' },
    };
  } else {
    presentation = {
      tone: 'disconnected',
      message: 'A Lightweaver card is not connected. Connect one to inspect it before installing or loading a project.',
      primary: { label: 'Connect card', action: 'connect' },
      secondary: { label: 'Install Lightweaver', section: 'install' },
    };
  }

  // Connect actions must be visible: prefer the connection center when the
  // shell provides it, and fall back to the background probe otherwise.
  const openConnection = () => (onOpenConnectionCenter ? onOpenConnectionCenter() : onConnectCard?.());
  const requireExactReadyStatus = (status) => {
    const expectedCardId = String(cardLink?.card?.id || '').trim();
    if (!status || status.cardId !== expectedCardId) throw new Error('A different card answered the hardware check. Reconnect the expected card.');
    if (status.runtimePhase !== 'ready' || status.commandReady !== true || status.outputReady !== true) {
      throw new Error('The card answered, but its runtime or LED output is not ready. Open support before retrying.');
    }
    return status;
  };
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
      const response = await recoverCardLights(
        { patternId: 'warm-white', brightness: 0.35, syncZones: true },
        { host: cardLink?.host || cardHost, timeoutMs: 3200 },
      );
      requireExactReadyStatus(await readCardStatusEnvelope({ host: cardLink?.host || cardHost }));
      setHardwareActionState({
        status: 'ok',
        message: `Recovery command ${response?.restarted ? 'survived restart and was' : 'was'} acknowledged with ready-state readback. Check the real LEDs; visible warm white is not confirmed automatically.`,
      });
    } catch (error) {
      setHardwareActionState({ status: 'error', message: error?.message || 'Recovery was not verified. Keep the card powered, reconnect, and retry.' });
    }
  };
  const loadMatchingCardProject = async () => {
    if (!productionJobId || matchingProjectState.status === 'loading') return;
    setMatchingProjectState({ status: 'loading', message: 'Verifying the published project for this exact card…' });
    try {
      const index = await loadProductionJobIndex();
      const entry = index.jobs.find(candidate => candidate.jobId === productionJobId);
      if (!entry) throw new Error(`No published Studio project matches card job ${productionJobId}.`);
      const job = await loadProductionJobFromIndexEntry(entry);
      if (job.jobId !== productionJobId) {
        throw new Error('The verified project identity changed while loading. Nothing was replaced.');
      }
      const snapshot = job.project.restoreSnapshot;
      const defaults = createDefaultProject();
      const studioProject = {
        ...defaults,
        id: snapshot.id,
        name: snapshot.name,
        layout: {
          ...defaults.layout,
          ...snapshot.layout,
          starterPending: false,
        },
        devices: {
          ...defaults.devices,
          ...snapshot.devices,
        },
      };
      const result = await replaceProject(studioProject);
      if (!result.ok) {
        setMatchingProjectState({
          status: result.reason === 'cancelled' ? 'idle' : 'error',
          message: result.reason === 'cancelled' ? 'The current Studio project was kept.' : 'The matching card project could not be opened.',
        });
        return;
      }
      window.location.hash = '#screen=pattern';
    } catch (error) {
      setMatchingProjectState({ status: 'error', message: error?.message || 'The matching card project could not be loaded.' });
    }
  };
  const renderAction = (action, primary = false) => action && (
    <button
      type="button"
      className={`btn${primary ? ' primary' : ''}`}
      disabled={action.disabled}
      onClick={() => action.action === 'connect' ? openConnection() : onOpenSection(action.section)}
    >
      {action.label}
    </button>
  );

  return (
    <div className="card-overview">
      <div className="card-overview-state">
        <span className={`card-overview-signal ${presentation.tone}`} aria-hidden="true" />
        <div>
          <span className="card-workspace-kicker">Detected state</span>
          <p data-testid="card-detected-state">{presentation.message}</p>
        </div>
      </div>

      <ol className="card-setup-steps" data-testid="card-setup-steps" aria-label="Card setup order">
        {setupLabels.map((label, index) => {
          const stepState = index < currentSetupIndex ? 'complete' : index === currentSetupIndex ? 'current' : 'upcoming';
          return (
            <li key={label} data-step-state={stepState} aria-current={stepState === 'current' ? 'step' : undefined}>
              <span className="card-setup-number" aria-hidden="true">{stepState === 'complete' ? '✓' : index + 1}</span>
              <span className="card-setup-label">{label}</span>
            </li>
          );
        })}
      </ol>

      <div className="card-overview-actions">
        {commissioningAction ? (
          <>
            {renderAction(commissioningAction, true)}
            <button type="button" className="btn" onClick={() => onOpenSection('support')}>Open support</button>
          </>
        ) : ready && activity === 'idle' ? (
          <>
            {renderAction(presentation.primary, true)}
            <button type="button" className="btn" onClick={() => onOpenSection('install')}>Check for update</button>
          </>
        ) : (
          <>
            {renderAction(presentation.primary, true)}
            {renderAction(presentation.secondary)}
          </>
        )}
      </div>

      {ready && productionJobId && (
        <section className="card-support-panel" aria-label="Matching card project">
          <h2>Matching card project</h2>
          <p>This card reports <strong>{productionJobId}</strong>. Load the latest verified release of that project before changing patterns so Studio keeps the exact LED count, wiring, protocol, and power limit.</p>
          <button
            type="button"
            className="btn primary"
            disabled={matchingProjectState.status === 'loading'}
            onClick={() => void loadMatchingCardProject()}
          >
            {matchingProjectState.status === 'loading' ? 'Verifying project…' : 'Load matching card project'}
          </button>
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

export function CardScreen({ connected, cardHost, cardLink, onConnectCard, onOpenConnectionCenter, onOpenSection, replaceProject, route = { section: 'overview', supportTool: '' } }) {
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

  const cardProps = { connected, cardHost, cardLink, onConnectCard };
  let content;
  if (route.section === 'install') content = (
    <AutomaticInstallScreen
      embedded
      cardLink={cardLink}
      onConnectCard={onConnectCard}
      onCommissioningComplete={() => onOpenSection('overview')}
    />
  );
  else if (route.section === 'settings') content = <SettingsScreen embedded mode="card" {...cardProps} />;
  else if (route.section === 'workshop') content = <ProductionScreen embedded cardHost={cardHost} cardLink={cardLink} onConnectCard={onConnectCard} />;
  else if (route.section === 'preferences') content = <SettingsScreen embedded mode="preferences" {...cardProps} />;
  else if (route.section === 'support') content = <CardSupport initialTool={route.supportTool} cardProps={cardProps} onOpenConnectionCenter={onOpenConnectionCenter} onOpenSection={onOpenSection} />;
  else content = <CardOverview {...cardProps} onOpenConnectionCenter={onOpenConnectionCenter} onOpenSection={onOpenSection} replaceProject={replaceProject} />;

  // Batch production (route.section === 'workshop') renders outside the tab
  // set: its own heading and kicker, no section tab highlighted.
  const workshop = route.section === 'workshop';
  const heading = route.section === 'overview'
    ? 'Your Lightweaver hardware'
    : workshop ? 'Batch production' : SECTION_LABELS[route.section];
  return (
    <div className="screen card-workspace-screen">
      <div className="card-workspace">
        <nav className="card-section-nav" aria-label="Hardware sections">
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
        </nav>
        <main className="card-workspace-body">
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
