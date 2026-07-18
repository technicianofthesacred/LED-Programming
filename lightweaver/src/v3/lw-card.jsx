import React, { useEffect, useRef, useState } from 'react';
import { AutomaticInstallScreen, TechnicianFlashScreen } from './lw-flash.jsx';
import { InstallerScreen } from './lw-installer.jsx';
import { ProductionScreen } from './lw-production.jsx';
import { SettingsScreen } from './lw-settings.jsx';
import { cardLinkReasonText, isCardLinkConnected } from '../lib/cardLink.js';
import {
  CARD_COMMISSIONING_CHANGED_EVENT,
  inspectCardCommissioning,
} from '../lib/cardCommissioningFlow.js';

const SECTION_LABELS = Object.freeze({
  overview: 'Card',
  install: 'Install or update',
  settings: 'Card settings',
  workshop: 'Workshop setup',
  support: 'Advanced & Support',
  preferences: 'Preferences',
});

function CardOverview({ connected, cardHost, cardLink, onConnectCard, onOpenSection }) {
  const [commissioningFlow, setCommissioningFlow] = useState(() => inspectCardCommissioning().flow);
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
  const setupLabels = ['Connect', 'Install', 'WiFi', 'Load project', 'Test'];
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
      commissioningAction = { label: 'Load saved project', section: 'install' };
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
  } else if (state === 'reconnecting-bridge' || reason === 'card-restarting') {
    presentation = {
      tone: 'connecting',
      message: `${identity || 'The Lightweaver card'} is restarting. Studio is waiting for it to answer again.`,
      primary: { label: 'Card restarting…', disabled: true },
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
  } else if (ready) {
    presentation = {
      tone: 'connected',
      message: `${identity || 'A Lightweaver card'} is connected and available to inspect.`,
      primary: { label: 'Load changes', section: 'settings' },
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

  const renderAction = (action, primary = false) => action && (
    <button
      type="button"
      className={`btn${primary ? ' primary' : ''}`}
      disabled={action.disabled}
      onClick={() => action.action === 'connect' ? onConnectCard?.() : onOpenSection(action.section)}
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
            <button type="button" className="btn" onClick={() => onOpenSection('workshop')}>Verify in workshop</button>
          </>
        ) : (
          <>
            {renderAction(presentation.primary, true)}
            {renderAction(presentation.secondary)}
          </>
        )}
      </div>
    </div>
  );
}

function RecoverySupport({ onConnectCard }) {
  return (
    <section className="card-support-panel">
      <h2>Safe recovery</h2>
      <p>Reconnect and inspect the card before choosing an install or write action. Opening recovery here does not erase firmware, WiFi, or the saved project.</p>
      <button type="button" className="btn primary" onClick={() => onConnectCard?.()}>Reconnect card</button>
    </section>
  );
}

function CardSupport({ initialTool, cardProps, onOpenSection }) {
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
      </div>

      {tool && (
        <div className="card-support-tool">
          {tool === 'technician' && <TechnicianFlashScreen embedded />}
          {tool === 'guide' && <InstallerScreen embedded go={installerGo} cardLink={cardProps.cardLink} />}
          {tool === 'json' && <SettingsScreen embedded mode="advanced" {...cardProps} />}
          {tool === 'recovery' && <RecoverySupport onConnectCard={cardProps.onConnectCard} />}
        </div>
      )}
    </div>
  );
}

export function CardScreen({ connected, cardHost, cardLink, onConnectCard, onOpenSection, route = { section: 'overview', supportTool: '' } }) {
  const headingRef = useRef(null);

  useEffect(() => {
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
  else if (route.section === 'workshop') content = <ProductionScreen embedded cardHost={cardHost} onConnectCard={onConnectCard} />;
  else if (route.section === 'preferences') content = <SettingsScreen embedded mode="preferences" {...cardProps} />;
  else if (route.section === 'support') content = <CardSupport initialTool={route.supportTool} cardProps={cardProps} onOpenSection={onOpenSection} />;
  else content = <CardOverview {...cardProps} onOpenSection={onOpenSection} />;

  const heading = route.section === 'overview' ? 'Your Lightweaver card' : SECTION_LABELS[route.section];
  return (
    <div className="screen card-workspace-screen">
      <div className="card-workspace">
        <nav className="card-section-nav" aria-label="Card sections">
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
            <span className="card-workspace-kicker">Lightweaver card</span>
            <h1 ref={headingRef} tabIndex={-1}>{heading}</h1>
          </header>
          {content}
        </main>
      </div>
    </div>
  );
}
