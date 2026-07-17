import React, { useEffect, useRef, useState } from 'react';
import { AutomaticInstallScreen, TechnicianFlashScreen } from './lw-flash.jsx';
import { InstallerScreen } from './lw-installer.jsx';
import { ProductionScreen } from './lw-production.jsx';
import { SettingsScreen } from './lw-settings.jsx';

const SECTION_LABELS = Object.freeze({
  overview: 'Card',
  install: 'Install or update',
  settings: 'Card settings',
  workshop: 'Workshop setup',
  support: 'Advanced & Support',
  preferences: 'Preferences',
});

const SECTION_KEYS = new Set(Object.keys(SECTION_LABELS));

function readCardRoute() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const screen = String(params.get('screen') || '').toLowerCase();
  if (screen === 'flash') {
    return params.get('mode') === 'install'
      ? { section: 'install', supportTool: '' }
      : { section: 'support', supportTool: 'technician' };
  }
  if (screen === 'installer') return { section: 'support', supportTool: 'guide' };
  if (screen === 'production') return { section: 'workshop', supportTool: '' };
  if (screen === 'settings') return { section: 'preferences', supportTool: '' };
  const section = params.get('section');
  return { section: SECTION_KEYS.has(section) ? section : 'overview', supportTool: '' };
}

function CardOverview({ connected, cardHost, cardLink, onConnectCard, onOpenSection }) {
  const identity = cardLink?.identity?.name
    || cardLink?.identity?.id
    || cardLink?.card?.name
    || cardLink?.card?.id
    || cardLink?.cardName
    || cardLink?.cardId
    || cardLink?.host
    || cardHost;
  return (
    <div className="card-overview">
      <div className="card-overview-state">
        <span className={`card-overview-signal${connected ? ' connected' : ''}`} aria-hidden="true" />
        <div>
          <span className="card-workspace-kicker">Detected state</span>
          <p data-testid="card-detected-state">
            {connected
              ? `${identity || 'A Lightweaver card'} is connected and available to inspect.`
              : 'A Lightweaver card is not connected. Connect one to inspect it before installing or loading a project.'}
          </p>
        </div>
      </div>

      <ol className="card-setup-steps" data-testid="card-setup-steps" aria-label="Card setup order">
        {['Connect', 'Install', 'WiFi', 'Load project', 'Test'].map((label, index) => (
          <li key={label}><span className="card-setup-number">{index + 1}</span><span className="card-setup-label">{label}</span></li>
        ))}
      </ol>

      <div className="card-overview-actions">
        {connected ? (
          <>
            <button type="button" className="btn primary" onClick={() => onOpenSection('settings')}>Load changes</button>
            <button type="button" className="btn" onClick={() => onOpenSection('install')}>Check for update</button>
            <button type="button" className="btn" onClick={() => onOpenSection('workshop')}>Verify in workshop</button>
          </>
        ) : (
          <>
            <button type="button" className="btn primary" onClick={() => onConnectCard?.()}>Connect card</button>
            <button type="button" className="btn" onClick={() => onOpenSection('install')}>Install Lightweaver</button>
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

export function CardScreen({ connected, cardHost, cardLink, onConnectCard, onOpenSection }) {
  const [route, setRoute] = useState(readCardRoute);
  const headingRef = useRef(null);

  useEffect(() => {
    const sync = () => setRoute(readCardRoute());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => headingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [route.section]);

  const cardProps = { connected, cardHost, cardLink, onConnectCard };
  let content;
  if (route.section === 'install') content = <AutomaticInstallScreen embedded cardLink={cardLink} onConnectCard={onConnectCard} />;
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
