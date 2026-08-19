/* Studio shell (app.jsx), converted from the v3 mockup to an ES module and
   wired to the real ProjectProvider. The shell chrome (TopBar/Rail/StatusBar)
   keeps the mockup markup; data/handlers are threaded in from project state. */
import React, { Component, lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { ProjectProvider, useProject } from '../state/ProjectContext.jsx';
import { CloudLibraryProvider, useCloudLibrary } from '../state/CloudLibraryContext.jsx';
import { useCardStatus } from '../hooks/useCardStatus.js';
import { CardConnectionCenter } from '../components/card/CardConnectionCenter.jsx';
import { CardControlDrawer } from '../components/card/CardControlDrawer.jsx';
import { cardEditIntentForPattern } from '../lib/cardCustomerControlContract.js';
import { CardStatusControl, cardConnectionStatus } from '../components/card/CardStatusControl.jsx';
import { useFirmwareReleaseIdentity } from '../hooks/useFirmwareReleaseIdentity.js';
import { ProjectLoadDialog, ProjectSaveDialog } from '../components/projects/TopBarProjectDialogs.jsx';
import { WorkspaceNotice } from '../components/projects/WorkspaceNotice.jsx';
import { releaseCardBridge } from '../lib/cardBridge.js';
import { bootstrapCardHostFromLocation, canPushDirectlyToCard, readStoredCardHost } from '../lib/cardConnection.js';
import {
  bootstrapBridgeCallback,
  clearStoredBridgeResult,
  createBridgeResultChannel,
  isBridgeCallbackLocation,
  launchBridgeOperation,
  readStoredBridgeResult,
} from '../lib/bridgeLaunch.js';
import { classifyFooterFirmwareStatus } from '../lib/footerFirmwareStatus.js';
import {
  connectCardLink,
  getCardLinkState,
  isCardLinkConnected,
  reportDirectCardStatus,
  subscribeCardLink,
} from '../lib/cardLink.js';
import { downloadJsonFile } from '../lib/downloadFile.js';
import {
  associateProjectLibraryRecordGuarded,
  clearProjectLibraryAssociationGuarded,
  isProjectLibrarySaveBlocked,
  listProjectLibraryRecords,
  readActiveProjectLibraryRecordId,
  readProjectLibraryRecordSnapshot,
  saveCurrentProjectToLibraryGuarded,
  setProjectLibrarySaveBlocked,
  writeActiveProjectLibraryRecordId,
} from '../lib/projectStorage.js';
import { runProjectSwitchSaveBarrier } from '../lib/projectSwitchSaveBarrier.js';
import { formatBrowserProjectSaveLabel } from '../lib/studioActionStatus.js';
import {
  CARD_COMMISSIONING_CHANGED_EVENT,
  beginCardCommissioning,
  inspectCardCommissioning,
  writeCardCommissioning,
} from '../lib/cardCommissioningFlow.js';
import {
  readTestStrip,
  startTestStripSession,
  stopTestStripSession,
  writeTestStrip,
  TEST_STRIP_CHANGED_EVENT,
} from '../lib/testStrip.js';
import { LayoutScreen } from './lw-layout.jsx';
import { markCardSectionNavigation } from './cardWorkspaceRoute.js';
import {
  canonicalStudioHash,
  cardRouteFromHash,
  createStudioRouteStore,
  DEFAULT_CARD_SECTION,
  FIRST_RUN_CARD_SECTION,
  isCardSection,
  normalizeStudioView,
  studioViewFromHash,
} from '../lib/studioRoute.js';
import { canonicalProjectFileName, PROJECT_IMPORT_ACCEPT } from '../lib/projectFiles.js';
import { clearScreenFailure, rememberScreenFailure } from '../lib/screenRecoveryDiagnostics.js';
import { createStudioFreshnessMonitor } from '../lib/studioFreshness.js';
import { STUDIO_HARDWARE_OPERATION_EVENT } from '../lib/studioHardwareOperation.js';
import { getRunningStudioRelease } from '../lib/studioRelease.js';
import { bootstrapStudioCardConnection } from '../lib/studioCardBootstrap.js';
import { CONNECTED_CARD_LINK_STATES, deriveSetupJourney } from '../lib/setupJourney.js';
import { deriveCardLifecycle } from '../lib/cardLifecycle.js';
import { cardProjectFingerprint } from '../lib/cardProjectResolver.js';
import { currentInstallation, structurallyInstalledRecord } from '../lib/projectLifecycle.js';
import {
  clearFirmwareUpdateSessionIfMatches,
  correlateFirmwareUpdateRecovery,
  readFirmwareUpdateSession,
} from '../lib/cardFirmwareUpdater.js';

const PatternScreen = lazy(() => import('./lw-pattern.jsx').then(module => ({ default: module.PatternScreen })));
const PatternLabScreen = lazy(() => import('../pattern-lab/PatternLabScreen.jsx'));
const PlaylistScreen = lazy(() => import('./lw-playlist.jsx').then(module => ({ default: module.PlaylistScreen })));
const ShowScreen = lazy(() => import('./lw-show.jsx').then(module => ({ default: module.ShowScreen })));
const CardScreen = lazy(() => import('./lw-card.jsx').then(module => ({ default: module.CardScreen })));
const CardSetupOverlay = lazy(() => import('../components/card/CardSetupOverlay.jsx'));

// Setup is no longer a rail destination of its own. It is the first section of
// the card workspace, which is where every other answer about the card already
// lived — see SECTION_LABELS in lw-card.jsx.
const STUDIO_SCREENS = [
  { id: 'card', label: 'Setup', Component: CardScreen },
  { id: 'layout', label: 'Layout', Component: LayoutScreen },
  { id: 'pattern', label: 'Patterns', Component: PatternScreen },
  { id: 'pattern-lab', label: 'Pattern Lab', Component: PatternLabScreen },
  { id: 'playlist', label: 'Playlist', Component: PlaylistScreen },
  { id: 'show', label: 'Show', Component: ShowScreen },
];
// Routable, but deliberately not in the rail: strip discovery is where a blank
// card is SENT, not a place the owner browses to. Its two entrances are the
// connection center and Test & Install — the exact two moments the question
// "which strips does this card even have?" comes up.
const SCREEN_KEYS = [...STUDIO_SCREENS.map(screen => screen.id), 'discovery'];
const SCREEN_BY_ID = Object.fromEntries(STUDIO_SCREENS.map(screen => [screen.id, screen.Component]));
const PROTECTED_COMMISSIONING_STAGES = new Set(['install-safely', 'set-up-card', 'check-lights']);
const SCREEN_RECOVERY_KEY = 'lw_screen_recovery_v1';

function readCommissioningProtection() {
  return PROTECTED_COMMISSIONING_STAGES.has(inspectCardCommissioning().flow?.stage);
}

bootstrapCardHostFromLocation();

function readScreenRecoveryAttempt() {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(SCREEN_RECOVERY_KEY) || 'null');
    if (value && typeof value.route === 'string' && Number.isFinite(value.at)) return value;
  } catch {
    // Fall through to navigation state when browser storage is unavailable.
  }
  const value = window.history.state?.[SCREEN_RECOVERY_KEY];
  return value && typeof value.route === 'string' && Number.isFinite(value.at) ? value : null;
}

function rememberScreenRecoveryAttempt() {
  const value = { route: window.location.hash, at: Date.now() };
  try {
    window.sessionStorage.setItem(SCREEN_RECOVERY_KEY, JSON.stringify(value));
  } catch {
    // Navigation state below still prevents a reload loop.
  }
  try {
    window.history.replaceState({ ...(window.history.state || {}), [SCREEN_RECOVERY_KEY]: value }, '');
  } catch {
    // The normal session storage path above is enough in supported browsers.
  }
}

function clearScreenRecoveryAttempt() {
  try {
    window.sessionStorage.removeItem(SCREEN_RECOVERY_KEY);
  } catch {
    // Nothing else is required when storage is unavailable.
  }
  try {
    const nextState = { ...(window.history.state || {}) };
    delete nextState[SCREEN_RECOVERY_KEY];
    window.history.replaceState(nextState, '');
  } catch {
    // Nothing else is required when navigation state is unavailable.
  }
}

function shouldRecoverScreenAutomatically() {
  const previous = readScreenRecoveryAttempt();
  return !previous || previous.route !== window.location.hash;
}

function ScreenReady() {
  useEffect(() => {
    clearScreenRecoveryAttempt();
    clearScreenFailure();
  }, []);
  return null;
}

class ScreenErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, recovering: false, saveBlocked: false, failure: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Lightweaver screen failed safely', error, info);
    if (shouldRecoverScreenAutomatically()) {
      if (this.props.onBeforeReload?.() === false) {
        const failure = rememberScreenFailure({ error, route: window.location.hash, phase: 'save-blocked' });
        this.setState({ saveBlocked: true, failure });
        return;
      }
      rememberScreenFailure({ error, route: window.location.hash, phase: 'auto-reload' });
      rememberScreenRecoveryAttempt();
      this.setState({ recovering: true }, () => window.location.reload());
      return;
    }
    // The automatic reload already happened for this route — keep a bounded,
    // sanitized record (support code + route + error name only) for the
    // fallback screen and for support conversations.
    const failure = rememberScreenFailure({ error, route: window.location.hash, phase: 'post-reload' });
    this.setState({ failure });
  }

  retryScreen = () => {
    if (this.props.onBeforeReload?.() === false) {
      this.setState({ saveBlocked: true });
      return;
    }
    rememberScreenRecoveryAttempt();
    window.location.reload();
  };

  openLayout = () => {
    clearScreenRecoveryAttempt();
    this.props.onRecover();
  };

  render() {
    if (!this.state.error) return this.props.children;
    if (this.state.recovering) {
      return (
        <div className="screen screen-recovery" role="status" aria-live="polite">
          <div className="screen-recovery-card">
            <span className="screen-recovery-kicker">Lightweaver recovery</span>
            <h1>Restoring your workspace…</h1>
            <p>Lightweaver is reopening this part of your project automatically.</p>
          </div>
        </div>
      );
    }
    return (
      <div className="screen screen-recovery" role="status" aria-live="polite" data-testid="screen-error-fallback">
        <div className="screen-recovery-card">
          <span className="screen-recovery-kicker">Workspace recovery</span>
          <h1>Let’s get you back to your work</h1>
          <p>{this.state.saveBlocked
            ? 'Your project is still open here. Lightweaver did not reload because it could not make a safety copy.'
            : 'Your project is safe. Lightweaver tried reopening this section and needs you to choose what happens next.'}</p>
          <div className="screen-recovery-actions">
            <button type="button" className="btn primary" onClick={this.retryScreen}>Try this screen again</button>
            <button type="button" className="btn" onClick={this.openLayout}>Open Layout</button>
          </div>
          {this.state.failure && (
            <p className="screen-recovery-code" data-testid="screen-recovery-support-code">
              Support code {this.state.failure.code} · {this.state.failure.route || 'unknown screen'} · {this.state.failure.errorName}
            </p>
          )}
          <p className="screen-recovery-help">If this keeps happening, open Layout first and review the item you last changed. Share the support code if you contact support.</p>
        </div>
      </div>
    );
  }
}

// Where a bare URL lands. Setup is the front door for anyone who has not been
// through it — the old fallback dropped a first-time owner onto Layout with a
// placeholder circle and no route to their card. Once the owner has said they
// are done with it, the fallback returns to Layout. Deep links are untouched:
// only the FALLBACK moves, so #screen=layout still opens Layout for everyone.
const SETUP_SKIP_KEY = 'lw_setup_skip_v1';
function defaultView() {
  try {
    return window.localStorage.getItem(SETUP_SKIP_KEY) === '1' ? 'layout' : 'card';
  } catch {
    return 'layout';
  }
}
function viewOptions() {
  return { screenKeys: SCREEN_KEYS, fallbackView: defaultView() };
}

// A first-time owner typing the bare domain should meet the guided ladder.
// Writing that into the hash before React mounts keeps every downstream route
// decision reading from one place — the URL — instead of special-casing an
// empty hash in the view state, the card route and the hash-sync effect.
function bootstrapFirstRunSetupRoute() {
  try {
    if (window.location.hash) return;
    if (window.localStorage.getItem(SETUP_SKIP_KEY) === '1') return;
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#screen=card&section=${FIRST_RUN_CARD_SECTION}`,
    );
  } catch {
    // No hash rewrite is possible without history/storage; the ordinary
    // fallback route still applies.
  }
}
bootstrapFirstRunSetupRoute();

/* ---------- tiny icon set (stroked, 1.6) ---------- */
const I = {
  setup: <svg viewBox="0 0 24 24"><path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="2.2"/><circle cx="15" cy="12" r="2.2"/><circle cx="11" cy="18" r="2.2"/></svg>,
  layout: <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12"/></svg>,
  pattern: <svg viewBox="0 0 24 24"><path d="M4 12c2-5 6-5 8 0s6 5 8 0"/><path d="M4 17c2-3 6-3 8 0s6 3 8 0"/></svg>,
  'pattern-lab': <svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v5l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.8 15h8.4M9.4 12h5.2"/></svg>,
  show: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2 2M16.4 16.4l2 2M18.4 5.6l-2 2M7.6 16.4l-2 2"/></svg>,
  flash: <svg viewBox="0 0 24 24"><path d="M13 3 5 13h6l-1 8 8-10h-6z"/></svg>,
  settings: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"/></svg>,
  playlist: <svg viewBox="0 0 24 24"><path d="M4 7h11M4 12h11M4 17h7"/><circle cx="18" cy="16" r="2.4"/><path d="M20.4 16V9l-3 1"/></svg>,
  installer: <svg viewBox="0 0 24 24"><path d="M3 13l2.5-7.5A1 1 0 0 1 6.5 5h11a1 1 0 0 1 1 .7L21 13v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 13h5l1.5 2.2h5L16 13h5"/></svg>,
  production: <svg viewBox="0 0 24 24"><path d="M4 7h16v12H4zM8 7V4h8v3"/><path d="M8 12h8M12 10v4"/></svg>,
  card: <svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h5M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>,
  newProject: <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>,
  importProject: <svg viewBox="0 0 24 24"><path d="M4 7h6l2 2h8v10H4z"/><path d="M12 11v6M9 14l3 3 3-3"/></svg>,
  preferences: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></svg>,
  exportProject: <svg viewBox="0 0 24 24"><path d="M12 16V5M8 9l4-4 4 4"/><path d="M5 19h14"/></svg>,
  saveProject: <svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7V3M8 15h8v6H8z"/></svg>,
};

/* ---------- Top bar (wired to real project state via props) ---------- */
function TopBar({ projectName, onNew, onLoad, onDownload, onSave, onPreferences }) {
  const action = ({ label, title, icon, primary = false, tooltipAlign, onClick }) => (
    <button
      type="button"
      className={`${primary ? 'btn primary' : 'link-btn'} top-action`}
      aria-label={label}
      title={title}
      data-tooltip={label}
      data-tooltip-align={tooltipAlign}
      onClick={onClick}
    >
      <span className="top-action-icon" aria-hidden="true">{icon}</span>
      <span className="top-action-label">{label}</span>
    </button>
  );
  return (
    <header className="topbar">
      <div className="brand" role="img" aria-label="Lightweaver"><span className="glyph" /><span className="name">Lightweaver</span></div>
      <nav className="crumb">
        <span>Projects</span><span className="sep">/</span><span className="proj">{projectName}</span>
      </nav>
      <div className="top-right">
        {action({ label: 'New project', title: 'Start a new empty project', icon: I.newProject, onClick: onNew })}
        {action({ label: 'Load project', title: 'Open an online project or import from your computer', icon: I.importProject, onClick: onLoad })}
        {action({ label: 'Preferences', title: 'Open Studio preferences', icon: I.preferences, onClick: onPreferences })}
        <span className="top-div" />
        {action({ label: 'Export project', title: 'Download a portable project file to your computer (import it anytime)', icon: I.exportProject, onClick: onDownload })}
        {action({ label: 'Save project', title: 'Save the project in this browser', icon: I.saveProject, primary: true, tooltipAlign: 'end', onClick: onSave })}
      </div>
    </header>
  );
}

/* ---------- Left rail ---------- */
function Rail({ view, navigate, openCard }) {
  const item = ({ id, label }) => (
    <button key={id} aria-label={label} aria-current={view === id ? 'page' : undefined} className={"rail-item" + (view === id ? " active" : "")} onClick={() => id === 'card' ? openCard(FIRST_RUN_CARD_SECTION) : navigate(id)}>
      <span className="ico">{I[id]}</span><span className="lbl">{label}</span>
    </button>
  );
  return (
    <aside className="rail">
      {STUDIO_SCREENS.map(item)}
      <div className="spring" />
      {/* Workshop entry for manufacturing workers who type the bare domain.
          Kept at the bottom, visually secondary, and NOT part of the normal
          artwork journey — it opens Batch production directly. */}
      <button
        aria-label="Workshop — Batch production"
        className="rail-item rail-workshop"
        title="Batch production for manufacturing workers"
        onClick={() => openCard('workshop')}
      >
        <span className="ico">{I.production}</span><span className="lbl">Workshop</span>
      </button>
    </aside>
  );
}

/* ---------- Status / Card bar (wired to the card-link state machine) ---------- */
/* One compact status control opens the shared Connection Center. Transport and
   host diagnostics stay out of routine chrome. */
/* The beacon shows the build NUMBER, not the commit hash. The number is the
   repository's commit count, which is the same number GitHub prints as
   "N Commits" — so the owner can read GitHub, read this, and know whether the
   site is running the newest code without decoding anything. That comparison
   is the whole question the beacon exists to answer. The exact revision stays
   in the hover title for anyone who needs to match it to a commit. */
function freshnessPresentation(runningRelease, freshness) {
  const running = `Build ${runningRelease.buildNumber} · revision ${runningRelease.sourceRevision}.`;
  if (freshness.status === 'current') return { dot: 'on', title: `Studio is current. ${running}` };
  if (freshness.status === 'update-ready') {
    const target = `Build ${freshness.buildNumber} · revision ${freshness.buildId}.`;
    return { dot: 'warn', title: `Studio ${running} Update ready: ${target} Refresh waits for the active card operation to finish. Reason: ${freshness.reason || 'operation-active'}.` };
  }
  if (freshness.status === 'unknown') return { dot: 'warn', title: `Studio freshness could not be verified. Running ${running} Reason: ${freshness.reason || 'unknown'}.` };
  return { dot: 'off', title: `Checking the current production Studio build. Running ${running}` };
}

function FirmwareStatusControl({ status, installedBuildId, releaseBuildId, releaseError, onOpenFirmwareUpdate }) {
  const details = [
    status.label,
    installedBuildId ? `Installed revision ${installedBuildId}.` : 'No installed card revision is connected.',
    releaseBuildId ? `Signed release revision ${releaseBuildId}.` : `Signed release unavailable: ${releaseError || 'unknown'}.`,
  ].join(' ');
  const common = {
    className: `sb-firmware is-${status.state}`,
    'data-testid': 'footer-firmware-status',
    'data-state': status.state,
    title: details,
    'aria-label': details,
    role: status.actionable ? undefined : 'status',
  };
  return status.actionable
    ? <button type="button" {...common} onClick={onOpenFirmwareUpdate}>{status.label}</button>
    : <span {...common}>{status.label}</span>;
}

function OfflineStatusControl({ state, onActivate }) {
  if (!state || state.status === 'disabled') return null;
  if (state.status === 'update-waiting') {
    return (
      <button
        type="button"
        className="sb-firmware is-update-available"
        data-testid="offline-update-status"
        title={state.reason ? `Update waits for safety: ${state.reason}.` : 'A verified Studio update is ready.'}
        onClick={onActivate}
      >
        Update ready
      </button>
    );
  }
  const label = state.status === 'ready' ? 'Ready offline'
    : state.status === 'error' ? 'Offline unavailable'
      : state.status === 'reloading' ? 'Reopening Studio…'
        : state.status === 'activating' ? 'Applying update…'
          : 'Preparing offline…';
  return <span className={`sb-firmware is-${state.status}`} data-testid="offline-update-status" role="status">{label}</span>;
}

function StatusBar({ link, lifecycle, connectionCenterOpen, cardControlOpen, onOpenCardControl, firmwareStatus, firmwareRelease, firmwareReleaseError, onOpenFirmwareUpdate, offlineUpdateState, onActivateOfflineUpdate, testStrip, onToggleTestStrip, onTestStripLengthChange, runningStudioRelease, freshness }) {
  return (
    <footer className="status-bar">
      <div className="sb-card">
        <CardStatusControl
          link={link}
          lifecycle={lifecycle}
          onOpen={onOpenCardControl}
          open={connectionCenterOpen || cardControlOpen}
          dialogId={cardConnectionStatus(link, lifecycle) === 'Connected' ? 'card-control-drawer' : 'card-connection-center'}
        />
      </div>

      <span className="sb-spring" aria-hidden="true" />

      <OfflineStatusControl state={offlineUpdateState} onActivate={onActivateOfflineUpdate} />

      <FirmwareStatusControl
        status={firmwareStatus}
        installedBuildId={isCardLinkConnected(link) ? link.card?.buildId : ''}
        releaseBuildId={firmwareRelease?.buildId}
        releaseError={firmwareReleaseError}
        onOpenFirmwareUpdate={onOpenFirmwareUpdate}
      />

      {(() => {
        const presentation = freshnessPresentation(runningStudioRelease, freshness);
        return (
          <div
            className={`sb-freshness is-${freshness.status}`}
            data-testid="studio-freshness"
            title={presentation.title}
            aria-label={presentation.title}
            tabIndex={0}
          >
            <span className={`sb-dot ${presentation.dot}`} aria-hidden="true" />
            <span>Studio {runningStudioRelease.buildNumber}</span>
          </div>
        );
      })()}

      <div className={`sb-teststrip${testStrip.enabled ? ' is-active' : ''}`} data-testid="test-strip-control">
        <button
          type="button"
          className={"sb-ts-toggle" + (testStrip.enabled ? " on" : "")}
          onClick={() => onToggleTestStrip(!testStrip.enabled)}
          aria-pressed={testStrip.enabled}
          aria-label={testStrip.enabled ? 'Stop testing strip' : 'Test strip'}
          title="Bench-test on a short strip without changing your saved design"
        >
          {testStrip.enabled ? `Testing ${testStrip.length} LEDs` : 'Test strip'}
        </button>
        {testStrip.enabled && (
          <>
            <input
              className="sb-ts-input"
              type="number"
              min={1}
              max={2000}
              value={testStrip.length}
              onChange={(e) => onTestStripLengthChange(e.target.value)}
              aria-label="Test strip LED count"
            />
          </>
        )}
      </div>
    </footer>
  );
}

/* ---------- Shell (inside ProjectProvider, real data wired in) ---------- */

function applyStoredStudioTheme() {
  try {
    const saved = JSON.parse(localStorage.getItem('lw_tweaks_v2') || '{}');
    document.documentElement.dataset.theme = saved.theme === 'daylight' ? 'daylight' : 'studio';
  } catch {
    document.documentElement.dataset.theme = 'studio';
  }
}

const DISABLED_OFFLINE_UPDATE_STATE = Object.freeze({ status: 'disabled', registration: null });
const subscribeDisabledOfflineUpdate = () => () => {};

function Shell({ offlineUpdateController = null }) {
  const [bridgeBooting, setBridgeBooting] = useState(() => isBridgeCallbackLocation());
  const [bridgeResult, setBridgeResult] = useState(readStoredBridgeResult);
  const bridgeResultAcceptedRef = useRef(Boolean(bridgeResult));
  // The URL is the only place the current screen is recorded. `view` and
  // `cardRoute` are read out of it, never stored beside it — see
  // ../lib/studioRoute.js for why the second copy had to go.
  const routeStore = useMemo(() => createStudioRouteStore(window), []);
  const routeHash = useSyncExternalStore(routeStore.subscribe, routeStore.read, routeStore.read);
  const view = useMemo(() => studioViewFromHash(routeHash, viewOptions()), [routeHash]);
  const cardRoute = useMemo(() => cardRouteFromHash(routeHash), [routeHash]);
  const cardSetupReturnHashRef = useRef('#screen=layout');
  useEffect(() => {
    if (view !== 'discovery') cardSetupReturnHashRef.current = routeHash || '#screen=layout';
  }, [routeHash, view]);
  const [installActive, setInstallActive] = useState(false);
  const [hardwareOperationActive, setHardwareOperationActive] = useState(false);
  const [commissioningActive, setCommissioningActive] = useState(readCommissioningProtection);
  const installActiveRef = useRef(false);
  const hardwareOperationActiveRef = useRef(false);
  const commissioningActiveRef = useRef(commissioningActive);
  const installRouteRef = useRef('#screen=card&section=install');
  const [connectionCenterOpen, setConnectionCenterOpen] = useState(false);
  const [cardControlOpen, setCardControlOpen] = useState(false);
  // Every navigation in the shell goes through here: it moves the URL, and the
  // screen follows because it is derived from the URL. Nothing sets the screen
  // on its own, so nothing can leave the two disagreeing.
  const navigateToView = useCallback(nextView => {
    const target = normalizeStudioView(nextView, viewOptions());
    routeStore.replace(canonicalStudioHash(routeStore.read(), target));
  }, [routeStore]);
  const {
    projectName, serializeProject, flushProjectAutosave, replaceProject, replaceWithNewProject, requestReplacementConfirmation,
    projectLifecycle, projectLifecycleLabel, markProjectPersisted, markProjectEdited, markProjectInstalled, isProjectLifecycleMarkerCurrent,
    projectHasUnsavedChanges, reverifyProjectInstallation,
  } = useProject();
  const offlineUpdateState = useSyncExternalStore(
    offlineUpdateController?.subscribe || subscribeDisabledOfflineUpdate,
    offlineUpdateController?.getState || (() => DISABLED_OFFLINE_UPDATE_STATE),
    offlineUpdateController?.getState || (() => DISABLED_OFFLINE_UPDATE_STATE),
  );
  const projectUnsavedRef = useRef(projectHasUnsavedChanges);
  projectUnsavedRef.current = projectHasUnsavedChanges;
  useEffect(() => {
    offlineUpdateController?.setGuards?.({
      hasActiveMutation: () => installActiveRef.current || hardwareOperationActiveRef.current || commissioningActiveRef.current,
      hasUnsavedTransition: () => projectUnsavedRef.current,
    });
  }, [offlineUpdateController]);
  const runningStudioReleaseRef = useRef(null);
  if (!runningStudioReleaseRef.current) runningStudioReleaseRef.current = getRunningStudioRelease();
  const [freshness, setFreshness] = useState(() => ({
    status: 'checking',
    buildId: runningStudioReleaseRef.current.buildId,
    buildNumber: runningStudioReleaseRef.current.buildNumber,
    reason: '',
  }));
  const firmwareReleaseIdentity = useFirmwareReleaseIdentity(
    `${freshness.buildId}:${freshness.buildNumber}`,
  );
  const freshnessMonitorRef = useRef(null);
  const flushProjectAutosaveRef = useRef(flushProjectAutosave);
  flushProjectAutosaveRef.current = flushProjectAutosave;
  const cloudLibrary = useCloudLibrary();
  const browserAssociationRef = useRef(null);
  const latestProjectSaveStateRef = useRef(null);
  latestProjectSaveStateRef.current = {
    project: serializeProject(),
    marker: {
      generation: projectLifecycle.generation,
      revision: projectLifecycle.editedRevision,
    },
    remoteId: cloudLibrary.activeRemoteProject?.id || '',
  };
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [projectAssociationSaveBlocked, setProjectAssociationSaveBlockedState] = useState(isProjectLibrarySaveBlocked);
  const setProjectAssociationSaveBlocked = useCallback(blocked => {
    setProjectLibrarySaveBlocked(blocked);
    setProjectAssociationSaveBlockedState(blocked === true);
  }, []);
  const currentProjectId = latestProjectSaveStateRef.current.project.id;
  useEffect(() => {
    if (browserAssociationRef.current || cloudLibrary.activeRemoteProject?.id) return;
    const activeRecordId = readActiveProjectLibraryRecordId();
    const activeSnapshot = activeRecordId
      ? readProjectLibraryRecordSnapshot(activeRecordId)
      : null;
    if (activeSnapshot?.record?.project?.id === currentProjectId) {
      browserAssociationRef.current = activeSnapshot;
    }
  }, [cloudLibrary.activeRemoteProject?.id, currentProjectId, projectLifecycle.generation]);
  useEffect(() => {
    if (!cloudLibrary.activeRemoteProject?.id) return;
    browserAssociationRef.current = null;
    try {
      writeActiveProjectLibraryRecordId('');
      if (readActiveProjectLibraryRecordId() !== '') throw new Error('browser association clear failed');
      setProjectAssociationSaveBlocked(false);
    } catch {
      setProjectAssociationSaveBlocked(true);
    }
  }, [cloudLibrary.activeRemoteProject?.id, setProjectAssociationSaveBlocked]);
  const [workspaceEvent, setWorkspaceEvent] = useState(null);
  const [dismissedPersistentKey, setDismissedPersistentKey] = useState('');
  const workspaceEventIdRef = useRef(0);
  const recoveryAnnouncedRef = useRef(false);
  const fileInputRef = useRef(null);
  const showWorkspaceEvent = useCallback((message, options = {}) => {
    workspaceEventIdRef.current += 1;
    setWorkspaceEvent({ id: workspaceEventIdRef.current, message, kind: options.kind || 'success', persistent: options.persistent === true, review: options.review === true, source: options.source || '' });
  }, []);
  useEffect(() => {
    const channel = createBridgeResultChannel({
      onResult: result => {
        bridgeResultAcceptedRef.current = true;
        setBridgeResult(result);
        navigateToView('layout');
        setConnectionCenterOpen(true);
      },
    });
    let active = true;
    void bootstrapBridgeCallback({ publish: result => channel.publish(result) }).then(outcome => {
      if (!active) return;
      if (outcome.kind === 'failure') setBridgeResult(outcome);
      if (outcome.kind === 'handoff' && !bridgeResultAcceptedRef.current) setBridgeResult(outcome);
      if (outcome.kind !== 'none') {
        navigateToView('layout');
        setConnectionCenterOpen(true);
      }
      setBridgeBooting(false);
    });
    if (bridgeResultAcceptedRef.current) {
      // A callback location already reads as Layout, and bootstrapBridgeCallback
      // is still reading it — the route is canonicalized above once it resolves.
      if (!isBridgeCallbackLocation()) navigateToView('layout');
      setConnectionCenterOpen(true);
    }
    return () => { active = false; channel.close(); };
  }, []);
  useEffect(() => {
    const syncCommissioning = () => {
      const active = readCommissioningProtection();
      commissioningActiveRef.current = active;
      void freshnessMonitorRef.current?.setOperationActive(
        installActiveRef.current || hardwareOperationActiveRef.current || active,
      );
      setCommissioningActive(active);
    };
    window.addEventListener(CARD_COMMISSIONING_CHANGED_EVENT, syncCommissioning);
    window.addEventListener('storage', syncCommissioning);
    syncCommissioning();
    return () => {
      window.removeEventListener(CARD_COMMISSIONING_CHANGED_EVENT, syncCommissioning);
      window.removeEventListener('storage', syncCommissioning);
    };
  }, []);
  useEffect(() => {
    const onHardwareOperationActive = event => {
      const active = event.detail?.active === true;
      hardwareOperationActiveRef.current = active;
      void freshnessMonitorRef.current?.setOperationActive(
        installActiveRef.current || active || commissioningActiveRef.current,
      );
      setHardwareOperationActive(active);
    };
    window.addEventListener(STUDIO_HARDWARE_OPERATION_EVENT, onHardwareOperationActive);
    return () => window.removeEventListener(STUDIO_HARDWARE_OPERATION_EVENT, onHardwareOperationActive);
  }, []);
  useEffect(() => {
    const monitor = createStudioFreshnessMonitor({
      release: runningStudioReleaseRef.current,
      fetchImpl: window.fetch.bind(window),
      flushAutosave: () => flushProjectAutosaveRef.current(),
      reload: () => {
        const testReload = window.__LW_STUDIO_RELOAD_FOR_TEST__;
        if (typeof testReload === 'function') testReload();
        else window.location.reload();
      },
      storage: window.sessionStorage,
      locationOrigin: window.location.origin,
      navigatorRef: window.navigator,
      documentRef: window.document,
      windowRef: window,
    });
    freshnessMonitorRef.current = monitor;
    void monitor.setOperationActive(
      installActiveRef.current || hardwareOperationActiveRef.current || commissioningActiveRef.current,
    );
    const unsubscribe = monitor.subscribe(setFreshness);
    setFreshness(monitor.getState());
    void monitor.start();
    return () => {
      unsubscribe();
      monitor.stop();
      if (freshnessMonitorRef.current === monitor) freshnessMonitorRef.current = null;
    };
  }, []);
  useEffect(() => {
    void freshnessMonitorRef.current?.setOperationActive(
      installActive || hardwareOperationActive || commissioningActive,
    );
  }, [commissioningActive, hardwareOperationActive, installActive]);
  useEffect(() => {
    applyStoredStudioTheme();
    window.addEventListener('lw-preview-settings', applyStoredStudioTheme);
    return () => window.removeEventListener('lw-preview-settings', applyStoredStudioTheme);
  }, []);
  useEffect(() => {
    const onInstallActive = event => {
      const active = event.detail?.active === true;
      installActiveRef.current = active;
      void freshnessMonitorRef.current?.setOperationActive(
        active || hardwareOperationActiveRef.current || commissioningActiveRef.current,
      );
      if (active) {
        const params = new URLSearchParams(window.location.hash.slice(1));
        const legacyInstall = params.get('screen') === 'flash' && params.get('mode') === 'install';
        const canonicalInstall = params.get('screen') === 'card' && params.get('section') === 'install';
        installRouteRef.current = legacyInstall || canonicalInstall ? window.location.hash : '#screen=card&section=install';
        if (!legacyInstall && !canonicalInstall) routeStore.replace(installRouteRef.current);
      }
      setInstallActive(active);
    };
    window.addEventListener('lw-install-active', onInstallActive);
    return () => window.removeEventListener('lw-install-active', onInstallActive);
  }, []);
  const openCardSection = useCallback((section = DEFAULT_CARD_SECTION) => {
    if (installActiveRef.current) return;
    markCardSectionNavigation();
    flushProjectAutosave();
    const params = new URLSearchParams(routeStore.read().slice(1));
    params.set('screen', 'card');
    params.set('section', isCardSection(section) ? section : DEFAULT_CARD_SECTION);
    params.delete('mode');
    params.delete('task');
    // Replace, not push, so Back behaves the same for screen and section
    // changes as it does for rail navigation.
    routeStore.replace(`#${params.toString()}`);
  }, [flushProjectAutosave, routeStore]);
  const navigateStudio = useCallback((nextView) => {
    if (installActiveRef.current) return;
    const requested = String(nextView || '').toLowerCase();
    if (requested === 'flash') { openCardSection('support'); return; }
    if (requested === 'installer') { openCardSection('support'); return; }
    if (requested === 'production') { openCardSection('workshop'); return; }
    if (requested === 'settings') { openCardSection('preferences'); return; }
    if (requested === 'setup') { openCardSection('setup'); return; }
    if (requested === 'card') { openCardSection(); return; }
    flushProjectAutosave();
    navigateToView(requested);
  }, [flushProjectAutosave, navigateToView, openCardSection]);

  const closeCardSetup = useCallback(() => {
    routeStore.replace(cardSetupReturnHashRef.current || '#screen=layout');
  }, [routeStore]);

  const completeCardSetup = useCallback(() => {
    flushProjectAutosave();
    routeStore.replace('#screen=layout&mode=draw');
  }, [flushProjectAutosave, routeStore]);

  const disconnectCardSetup = useCallback(async () => {
    await releaseCardBridge('disconnected');
    closeCardSetup();
  }, [closeCardSetup]);

  // The one place the route is reconciled. It reads the live URL and derives
  // the screen from that same string — deliberately NOT from the rendered
  // `view`, which is a snapshot of the route as it was when this render began
  // and may already be a navigation behind. Reading both ends from one place
  // is what makes this idempotent and unable to resurrect a screen the owner
  // has left. Layout's `mode` deep link (#screen=layout&mode=draw | &mode=wire,
  // the only two modes — see ModeSwitch.jsx) survives it, so jumps like the
  // Playlist "Adjust LED count" button still land on the right Layout mode.
  useEffect(() => {
    if (bridgeBooting) return;
    // An install owns the route until it finishes: a route change mid-write
    // would swap the screen out from under the card being flashed.
    if (installActiveRef.current) {
      routeStore.replace(installRouteRef.current);
      return;
    }
    const current = routeStore.read();
    routeStore.replace(canonicalStudioHash(current, studioViewFromHash(current, viewOptions())));
  }, [routeHash, bridgeBooting, installActive, routeStore]);

  useEffect(() => {
    if (!workspaceEvent || workspaceEvent.persistent) return undefined;
    const id = workspaceEvent.id;
    const t = setTimeout(() => setWorkspaceEvent(current => current?.id === id ? null : current), 2200);
    return () => clearTimeout(t);
  }, [workspaceEvent]);
  useEffect(() => {
    if (recoveryAnnouncedRef.current || projectLifecycleLabel !== 'Restored from recovery copy') return;
    recoveryAnnouncedRef.current = true;
    showWorkspaceEvent('Restored from recovery copy', { kind: 'recovery' });
  }, [projectLifecycleLabel, showWorkspaceEvent]);
  useEffect(() => {
    if (workspaceEvent?.source === 'cloud-save-waiting' && cloudLibrary.syncState.status === 'saved') {
      setWorkspaceEvent(null);
    }
  }, [cloudLibrary.syncState.status, workspaceEvent?.source]);

  // real card status — every screen and the footer read the cardLink state
  // machine. A reload first restores an existing bridge, then safely retries
  // the exact persisted card over local HTTP when no bridge is available.
  const directCardControl = typeof window === 'undefined' ? false : canPushDirectlyToCard(window.location.protocol);
  const cardStatus = useCardStatus({ enabled: directCardControl });
  const cardLink = useSyncExternalStore(subscribeCardLink, getCardLinkState, getCardLinkState);
  const [firmwareRecoveryState, setFirmwareRecoveryState] = useState(() => {
    const session = readFirmwareUpdateSession();
    if (!session) return null;
    if (session.phase === 'rolled-back') return { phase: 'rolled-back' };
    if (['preflight', 'sending', 'verifying'].includes(session.phase)) return { phase: session.phase };
    return { phase: 'restarting' };
  });
  const retainFirmwareRecoveryState = useCallback(next => {
    setFirmwareRecoveryState(current => {
      if (!next) return current;
      if (next.phase === 'reconnected') return null;
      return next;
    });
  }, []);
  useEffect(() => {
    const session = readFirmwareUpdateSession();
    const readiness = cardLink.readiness;
    if (!session || !readiness?.cardId) return;
    const correlation = correlateFirmwareUpdateRecovery(
      session,
      readiness.firmwareUpdate || {},
      readiness,
    );
    if (correlation.ok && correlation.terminal) {
      if (clearFirmwareUpdateSessionIfMatches(session)) setFirmwareRecoveryState(null);
      return;
    }
    if (correlation.terminal && correlation.phase === 'rolled-back') {
      setFirmwareRecoveryState({ phase: 'rolled-back', reason: correlation.reason });
      return;
    }
    if (['wrong-card', 'target-mismatch', 'project-changed'].includes(correlation.reason)) {
      setFirmwareRecoveryState(current => current?.phase === 'blocked' && current.reason === correlation.reason
        ? current
        : { phase: 'blocked', reason: correlation.reason });
    }
  }, [cardLink.readiness]);
  // A reload restores the installation record unverified (it is a memory, not
  // proof). When the exact card that is connected right now still reports the
  // same project id, revision, and fingerprint the record names, that IS the
  // proof, so the record is promoted back to verified and the card lifecycle can
  // reach `ready` again without a pointless re-install. The match is checked in
  // `reverifyInstallation`, which refuses anything short of an exact three-way
  // agreement — this effect only supplies the live evidence.
  useEffect(() => {
    const readiness = cardLink.readiness;
    if (!CONNECTED_CARD_LINK_STATES.includes(cardLink.state) || !readiness) return;
    reverifyProjectInstallation({
      cardId: cardLink.card?.id || readiness.cardId,
      projectId: readiness.projectId,
      projectRevision: readiness.projectRevision,
      projectFingerprint: readiness.projectFingerprint,
      studioProjectId: serializeProject().id,
      studioProjectFingerprint: cardProjectFingerprint(serializeProject()),
    });
  }, [
    cardLink.state,
    cardLink.card?.id,
    cardLink.readiness,
    projectLifecycle.installation,
    reverifyProjectInstallation,
    serializeProject,
  ]);
  const lifecycleProject = useMemo(() => {
    const project = serializeProject();
    const structureFingerprint = cardProjectFingerprint(project);
    const installation = currentInstallation(projectLifecycle);
    // A card-adopted project is bound by its installation record, not by a
    // fingerprint it cannot recompute — so the record stands in for as long as
    // the structure it named is unchanged, not only until the first look edit.
    const verified = structurallyInstalledRecord(projectLifecycle, structureFingerprint)
      || (installation?.verified === true ? installation : null);
    return {
      ...project,
      revision: Number.isSafeInteger(verified?.projectRevision)
        ? verified.projectRevision
        : projectLifecycle.editedRevision,
      fingerprint: verified?.projectFingerprint || structureFingerprint,
      // A verified record whose card-side fingerprint is empty was bound to a
      // card flashed before fingerprint reporting. The lifecycle needs to know
      // that, or it reports a permanent mismatch against the card's own
      // honest empty answer.
      legacyFingerprintBinding: Boolean(verified) && verified.projectFingerprint === '',
    };
  }, [
    projectLifecycle.editedRevision,
    projectLifecycle.generation,
    projectLifecycle.installation?.projectFingerprint,
    projectLifecycle.installation?.projectRevision,
    projectLifecycle.installation?.verified,
    projectLifecycle.installedRevision,
    serializeProject,
  ]);
  const cardLifecycle = useMemo(() => deriveCardLifecycle({
    link: cardLink,
    project: lifecycleProject,
    update: firmwareRecoveryState,
  }), [cardLink, firmwareRecoveryState, lifecycleProject]);
  useEffect(() => { void bootstrapStudioCardConnection(); }, []);
  useEffect(() => {
    if (!directCardControl) return;
    reportDirectCardStatus({
      connected: cardStatus.connected,
      // "checking" here means searching-while-not-connected: a disconnected
      // re-probe shows "Looking for the card…" again, while a routine poll on
      // a live link (connected=true) can never demote it — the reducer also
      // guards established links against a direct 'connecting' event.
      checking: cardStatus.checking && !cardStatus.connected,
      host: cardStatus.host,
      status: cardStatus.status,
      detectedStatus: cardStatus.detectedStatus,
      reason: cardStatus.reason,
      allowAdopt: cardStatus.allowAdopt,
    });
  }, [
    directCardControl,
    cardStatus.connected,
    cardStatus.checking,
    cardStatus.host,
    cardStatus.status,
    cardStatus.detectedStatus,
    cardStatus.reason,
    cardStatus.allowAdopt,
  ]);
  const connected = isCardLinkConnected(cardLink);
  const firmwareStatus = useMemo(() => classifyFooterFirmwareStatus(
    connected ? cardLink.card : null,
    firmwareReleaseIdentity.state === 'verified' ? firmwareReleaseIdentity.manifest : null,
  ), [cardLink.card, connected, firmwareReleaseIdentity.manifest, firmwareReleaseIdentity.state]);
  const openSetupTask = useCallback(taskId => {
    if (installActiveRef.current) return;
    markCardSectionNavigation();
    flushProjectAutosave();
    const journey = deriveSetupJourney({
      cardLink,
      cardLifecycle,
      commissioningFlow: inspectCardCommissioning().flow,
      project: serializeProject(),
    });
    routeStore.replace(`#screen=card&section=setup&task=${encodeURIComponent(taskId || journey.taskId)}`);
  }, [cardLifecycle, cardLink, flushProjectAutosave, routeStore, serializeProject]);
  const openConnectionCenter = useCallback(() => setConnectionCenterOpen(true), []);
  const closeConnectionCenter = useCallback(() => setConnectionCenterOpen(false), []);
  const openCardControl = useCallback(() => {
    const status = cardConnectionStatus(cardLink, cardLifecycle);
    if (status === 'Connected') setCardControlOpen(true);
    else if (status === 'Needs attention' || status === 'Needs project') {
      setCardControlOpen(false);
      setConnectionCenterOpen(false);
      openSetupTask();
    } else {
      setCardControlOpen(false);
      setConnectionCenterOpen(true);
    }
  }, [cardLifecycle, cardLink, openSetupTask]);
  const closeCardControl = useCallback(() => setCardControlOpen(false), []);
  const reconnectFromCardControl = useCallback(() => {
    setCardControlOpen(false);
    setConnectionCenterOpen(true);
  }, []);
  const openAdvancedPattern = useCallback(pattern => {
    const intent = cardEditIntentForPattern(pattern);
    if (!intent) return;
    const { key: intentKey, id } = intent;
    const url = new URL(window.location.href);
    const alternateKey = intentKey === 'editLook' ? 'editPattern' : 'editLook';
    url.searchParams.delete(alternateKey);
    url.searchParams.set(intentKey, id);
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    setCardControlOpen(false);
    openCardSection('overview');
  }, [openCardSection]);
  const clearBridgeResult = useCallback(outcome => {
    clearStoredBridgeResult();
    bridgeResultAcceptedRef.current = false;
    setBridgeResult(outcome === 'complete' ? { kind: 'complete' } : null);
  }, []);
  const onConnectCard = useCallback((host = '') => {
    if (directCardControl) return cardStatus.connect?.(host);
    return connectCardLink(host);
  }, [directCardControl, cardStatus.connect]);

  const isProjectSwitchSnapshotCurrent = useCallback(captured => {
    const latest = latestProjectSaveStateRef.current;
    return latest?.project?.id === captured?.project?.id
      && latest.marker.generation === captured?.marker?.generation
      && latest.marker.revision === captured?.marker?.revision
      && latest.remoteId === captured?.remoteId;
  }, []);

  const saveProjectToBrowserGuarded = useCallback(async project => {
    if (flushProjectAutosave() !== true) {
      return { ok: false, reason: 'browser-recovery-failed' };
    }
    const expectedAssociationSnapshot = browserAssociationRef.current;
    const result = await saveCurrentProjectToLibraryGuarded(project, expectedAssociationSnapshot
      ? { expectedAssociationSnapshot }
      : {});
    if (result?.ok) browserAssociationRef.current = result.associationSnapshot;
    return result;
  }, [flushProjectAutosave]);

  const saveBeforeCardProjectSwitch = useCallback(async () => {
    const snapshot = latestProjectSaveStateRef.current;
    return runProjectSwitchSaveBarrier({
      snapshot,
      flushBrowserRecovery: () => flushProjectAutosave(),
      saveAuthoritative: async captured => {
        if (projectAssociationSaveBlocked) {
          return { ok: false, reason: 'association-handoff-failed' };
        }
        if (captured.remoteId) {
          const result = await cloudLibrary.saveNow({
            expectedRemoteId: captured.remoteId,
            expectedMarker: captured.marker,
          });
          return result?.ok ? { ok: true, destination: 'cloud' } : result;
        }
        try {
          const result = await saveProjectToBrowserGuarded(captured.project);
          if (!result?.ok) return result;
          if (result.record?.project?.id !== captured.project.id) {
            return { ok: false, reason: 'browser-library-mismatch' };
          }
          markProjectPersisted('browser', captured.marker);
          return { ok: true, destination: 'browser' };
        } catch {
          return { ok: false, reason: 'browser-library-failed' };
        }
      },
      isSnapshotCurrent: isProjectSwitchSnapshotCurrent,
    });
  }, [cloudLibrary, flushProjectAutosave, isProjectSwitchSnapshotCurrent, markProjectPersisted, projectAssociationSaveBlocked, saveProjectToBrowserGuarded]);

  // Test strip mode (src/lib/testStrip.js) — a bench/session-only override,
  // never part of the saved project. Read fresh at mount, then kept in sync
  // with any other write (e.g. another tab) via its changed event.
  const [testStrip, setTestStripState] = useState(readTestStrip);
  useEffect(() => {
    const sync = () => setTestStripState(readTestStrip());
    window.addEventListener(TEST_STRIP_CHANGED_EVENT, sync);
    return () => window.removeEventListener(TEST_STRIP_CHANGED_EVENT, sync);
  }, []);
  const onToggleTestStrip = useCallback((enabled) => {
    if (enabled) {
      setTestStripState(startTestStripSession({ length: readTestStrip().length }));
      return;
    }
    void stopTestStripSession({ host: readStoredCardHost() })
      .catch(() => {
        // The override is already disabled. A candidate that cannot be proven
        // as ours is deliberately left for the card's normal safety flow.
      });
    setTestStripState(readTestStrip());
  }, []);
  const onTestStripLengthChange = useCallback((rawLength) => {
    const length = Number(rawLength);
    setTestStripState(writeTestStrip({ enabled: readTestStrip().enabled, length }));
  }, []);

  // real project actions
  const onSave = useCallback(async () => {
    if (projectAssociationSaveBlocked) {
      showWorkspaceEvent('Saving is blocked because Studio could not establish a safe destination for this project. Open another project or restore browser storage before retrying.', { kind: 'error', persistent: true, review: true });
      return;
    }
    if (cloudLibrary.session.status === 'authenticated' && cloudLibrary.activeRemoteProject) {
      const result = await cloudLibrary.saveNow();
      if (result.ok) showWorkspaceEvent('Saved online');
      else if (result.reason === 'queued' || Number(result.error?.status) >= 500) {
        showWorkspaceEvent('Save queued — waiting to retry online.', { kind: 'offline', persistent: true, review: true, source: 'cloud-save-waiting' });
      } else if (result.reason === 'stale-session' || [401, 403].includes(Number(result.error?.status))) {
        showWorkspaceEvent('Your session changed. Sign in again from Preferences.', { kind: 'error', persistent: true, review: true, source: 'cloud-save-session' });
      }
      return;
    }
    if (cloudLibrary.session.status === 'authenticated' && cloudLibrary.session.role !== 'customer') {
      setSaveDialogOpen(true);
      return;
    }
    try {
      const result = await saveProjectToBrowserGuarded(serializeProject());
      if (!result?.ok) {
        const error = new Error(result?.reason === 'browser-conflict'
          ? 'Another tab saved a newer browser copy. Reopen that copy before saving again.'
          : 'Browser save failed');
        error.reason = result?.reason;
        throw error;
      }
      markProjectPersisted('browser');
      showWorkspaceEvent(formatBrowserProjectSaveLabel(result.record));
    } catch (error) {
      showWorkspaceEvent(error?.message || 'Browser save failed', { kind: 'error', persistent: true, review: true });
    }
  }, [cloudLibrary, markProjectPersisted, projectAssociationSaveBlocked, saveProjectToBrowserGuarded, serializeProject, showWorkspaceEvent]);
  const onLaunchBridge = useCallback(async operation => {
    await launchBridgeOperation(operation, {
      persistProject: async () => {
        const result = await saveProjectToBrowserGuarded(serializeProject());
        if (!result?.ok) {
          const error = new Error('Studio could not safely save this project in the browser before opening the Bridge.');
          error.reason = result?.reason;
          throw error;
        }
        const record = result.record;
        markProjectPersisted('browser');
        if (operation === 'install-current-release' || operation === 'recover-current-release') {
          await writeCardCommissioning(beginCardCommissioning({
            source: 'native-bridge',
            operation,
            strategy: 'clean-recovery',
            projectRecord: record,
            projectRevision: projectLifecycle.editedRevision,
            projectGeneration: projectLifecycle.generation,
          }));
        }
      },
      navigate: url => {
        const testNavigate = window.__LW_BRIDGE_NAVIGATE_FOR_TEST__;
        if (typeof testNavigate === 'function') testNavigate(url);
        else window.location.assign(url);
      },
    });
  }, [markProjectPersisted, projectLifecycle.editedRevision, projectLifecycle.generation, saveProjectToBrowserGuarded, serializeProject]);
  const onDownload = useCallback(async () => {
    const ok = await downloadJsonFile(
      canonicalProjectFileName(projectName),
      serializeProject(),
    );
    if (ok) markProjectPersisted('file');
    else showWorkspaceEvent('Download failed', { kind: 'error', persistent: true, review: true });
  }, [markProjectPersisted, projectName, serializeProject, showWorkspaceEvent]);
  const onLoad = useCallback(() => setLoadDialogOpen(true), []);
  const onMatchedCardProjectLoaded = useCallback(async ({ source, recordId, recordSnapshot, expectedMarker }) => {
    const markerPresent = Number.isSafeInteger(expectedMarker?.generation)
      && Number.isSafeInteger(expectedMarker?.revision);
    if (source === 'browser' && !markerPresent) {
      return { ok: false, reason: 'lifecycle-marker-required' };
    }
    const associationIsCurrent = () => !markerPresent || isProjectLifecycleMarkerCurrent(expectedMarker);
    if (source === 'cloud') {
      if (!associationIsCurrent()) return { ok: false, reason: 'superseded' };
      try {
        writeActiveProjectLibraryRecordId('');
        if (readActiveProjectLibraryRecordId() !== '') {
          throw new Error('browser project association was not cleared');
        }
        browserAssociationRef.current = null;
        setProjectAssociationSaveBlocked(false);
        return { ok: true };
      } catch {
        browserAssociationRef.current = null;
        setProjectAssociationSaveBlocked(true);
        return { ok: false, reason: 'association-handoff-failed' };
      }
    }
    if (!['browser', 'production', 'unassociated'].includes(source)) return { ok: true };
    // Detach cloud first and clear the old browser association before selecting
    // the new destination. If browser storage fails at either step, manual and
    // card-switch saves remain blocked so the previous project cannot be overwritten.
    cloudLibrary.detachProject();
    try {
      if (source === 'browser') {
        if (!recordId || !recordSnapshot || recordSnapshot.recordId !== recordId) {
          throw new Error('missing browser project record snapshot');
        }
        const association = await associateProjectLibraryRecordGuarded(recordSnapshot);
        if (!associationIsCurrent()) {
          if (association?.ok) {
            await clearProjectLibraryAssociationGuarded({
              recordId,
              ownershipToken: association.associationOwnershipToken,
            });
          }
          return { ok: false, reason: 'superseded' };
        }
        if (!association?.ok) throw new Error(association?.reason || 'browser project association failed');
        browserAssociationRef.current = association.associationSnapshot;
        markProjectPersisted('browser', expectedMarker);
      } else {
        if (!associationIsCurrent()) return { ok: false, reason: 'superseded' };
        writeActiveProjectLibraryRecordId('');
        if (readActiveProjectLibraryRecordId() !== '') {
          throw new Error('browser project association was not cleared');
        }
        browserAssociationRef.current = null;
      }
      setProjectAssociationSaveBlocked(false);
      return { ok: true };
    } catch {
      if (!associationIsCurrent()) return { ok: false, reason: 'superseded' };
      cloudLibrary.detachProject();
      browserAssociationRef.current = null;
      if (source === 'browser') markProjectEdited();
      setProjectAssociationSaveBlocked(true);
      return { ok: false, reason: 'association-handoff-failed' };
    }
  }, [cloudLibrary, isProjectLifecycleMarkerCurrent, markProjectEdited, markProjectPersisted]);
  const onMatchedCardProjectVerified = useCallback(({ evidence, expectedMarker }) => {
    if (!Number.isSafeInteger(expectedMarker?.generation)
      || !Number.isSafeInteger(expectedMarker?.revision)
      || !evidence?.cardId
      || !Number.isSafeInteger(evidence?.projectRevision)
      || evidence.projectRevision < 0
      || !/^[a-f0-9]{16,64}$/.test(String(evidence?.projectFingerprint || ''))) {
      return { ok: false, reason: 'exact-installation-evidence-required' };
    }
    const next = markProjectInstalled({
      generation: expectedMarker.generation,
      revision: expectedMarker.revision,
      cardId: evidence.cardId,
      projectRevision: evidence.projectRevision,
      projectFingerprint: evidence.projectFingerprint,
      verified: true,
    });
    return next?.installedRevision === expectedMarker.revision
      && next?.installation?.verified === true
      ? { ok: true }
      : { ok: false, reason: 'superseded' };
  }, [markProjectInstalled]);
  const openBrowserProject = useCallback(async project => {
    const recordId = String(project?.id || '');
    const recordSnapshot = readProjectLibraryRecordSnapshot(recordId);
    if (!recordSnapshot.record || recordSnapshot.record.project?.id !== project?.project?.id) {
      return { ok: false, reason: 'browser-conflict' };
    }
    const replacement = await replaceProject(recordSnapshot.record.project);
    if (!replacement.ok) return replacement;
    const association = await onMatchedCardProjectLoaded({
      source: 'browser',
      recordId,
      recordSnapshot,
      expectedMarker: replacement.marker,
    });
    return association.ok ? replacement : { ...association, replacementCommitted: true };
  }, [onMatchedCardProjectLoaded, replaceProject]);
  const onImport = useCallback(() => fileInputRef.current?.click(), []);
  const onNew = useCallback(async () => {
    const result = await replaceWithNewProject();
    if (result.ok) {
      browserAssociationRef.current = null;
      writeActiveProjectLibraryRecordId('');
      cloudLibrary.detachProject();
      setProjectAssociationSaveBlocked(false);
    }
    return result;
  }, [cloudLibrary, replaceWithNewProject]);
  const onStartNewProject = useCallback(async () => {
    const result = await onNew();
    if (result?.ok) navigateStudio('layout');
    return result;
  }, [navigateStudio, onNew]);
  const onFile = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        const result = await replaceProject(data);
        if (result.ok) {
          browserAssociationRef.current = null;
          writeActiveProjectLibraryRecordId('');
          cloudLibrary.detachProject();
          setProjectAssociationSaveBlocked(false);
          setLoadDialogOpen(false);
        }
        if (result.reason === 'invalid') alert('Invalid project file (version mismatch).');
      } catch { alert('Could not parse project file.'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [cloudLibrary, replaceProject]);

  const cardSetupOpen = view === 'discovery';
  const underlyingView = cardSetupOpen
    ? studioViewFromHash(cardSetupReturnHashRef.current, viewOptions())
    : view;
  const underlyingCardRoute = cardSetupOpen
    ? cardRouteFromHash(cardSetupReturnHashRef.current)
    : cardRoute;
  const Screen = SCREEN_BY_ID[underlyingView];
  let persistentNotice = null;
  if (cloudLibrary.activeRemoteProject && cloudLibrary.syncState.conflict) {
    persistentNotice = {
      key: `conflict:${cloudLibrary.activeRemoteProject.id}:${cloudLibrary.syncState.conflict.error?.requestId || 'active'}`,
      kind: 'conflict',
      message: 'Online conflict — choose which revision to keep.',
      persistent: true,
      review: true,
    };
  } else if (cloudLibrary.activeRemoteProject && cloudLibrary.syncState.status === 'error') {
    persistentNotice = {
      key: `error:${cloudLibrary.activeRemoteProject.id}:${cloudLibrary.syncState.error?.code || cloudLibrary.syncState.error?.message || 'active'}`,
      kind: 'error',
      message: 'Online save needs attention.',
      persistent: true,
      review: true,
    };
  } else if (cloudLibrary.activeRemoteProject && !cloudLibrary.syncState.online) {
    persistentNotice = {
      key: `offline:${cloudLibrary.activeRemoteProject.id}`,
      kind: 'offline',
      message: 'Offline — browser recovery continues until the online project can sync.',
      persistent: true,
      review: false,
    };
  }
  useEffect(() => {
    if (!persistentNotice) setDismissedPersistentKey('');
  }, [persistentNotice?.key]);
  const visiblePersistentNotice = persistentNotice?.key === dismissedPersistentKey ? null : persistentNotice;
  const visibleWorkspaceNotice = visiblePersistentNotice || workspaceEvent;

  return (
    <div className="app">
      <TopBar
        projectName={projectName || 'Untitled'}
        onNew={onNew} onLoad={onLoad} onDownload={onDownload} onSave={onSave}
        onPreferences={() => openCardSection('preferences')}
      />
      <Rail view={underlyingView} navigate={navigateStudio} openCard={openCardSection} />

      <ScreenErrorBoundary key={underlyingView} onBeforeReload={flushProjectAutosave} onRecover={() => navigateStudio('layout')}>
        <Suspense fallback={<div className="screen route-loading" role="status" aria-live="polite">Loading Studio screen…</div>}>
          {Screen ? <>
            <Screen
              connected={connected}
              cardHost={cardLink.host || cardStatus.host}
              cardLink={cardLink}
              cardLifecycle={cardLifecycle}
              onConnectCard={onConnectCard}
              onOpenConnectionCenter={openConnectionCenter}
              go={navigateStudio}
              onOpenSection={openCardSection}
              onOpenSetupTask={openSetupTask}
              onFirmwareRecoveryState={retainFirmwareRecoveryState}
              replaceProject={replaceProject}
              currentProject={serializeProject()}
              projectGeneration={projectLifecycle.generation}
              activeCloudProjects={cloudLibrary.activeProjects}
              browserProjects={cloudLibrary.browserProjects}
              readBrowserProjects={listProjectLibraryRecords}
              readCloudProject={cloudLibrary.readCardProjectCandidate}
              openMatchingCardProject={cloudLibrary.openMatchingCardProject}
              confirmProjectReplacement={requestReplacementConfirmation}
              saveBeforeCardProjectSwitch={saveBeforeCardProjectSwitch}
              saveProjectToBrowserGuarded={saveProjectToBrowserGuarded}
              isProjectSwitchSnapshotCurrent={isProjectSwitchSnapshotCurrent}
              onMatchedProjectLoaded={onMatchedCardProjectLoaded}
              onMatchedProjectVerified={onMatchedCardProjectVerified}
              onStartNewProject={onStartNewProject}
              onSaveProject={onSave}
              route={underlyingCardRoute}
            />
            <ScreenReady />
          </> : null}
        </Suspense>
      </ScreenErrorBoundary>

      {cardSetupOpen && (
        <Suspense fallback={<div className="card-setup-backdrop"><div className="card-setup-loading" role="status">Opening the light check…</div></div>}>
          <CardSetupOverlay
            cardHost={cardLink.host || cardStatus.host}
            cardLink={cardLink}
            go={navigateStudio}
            onDismiss={closeCardSetup}
            onDisconnect={disconnectCardSetup}
            onComplete={completeCardSetup}
          />
        </Suspense>
      )}

      <WorkspaceNotice
        notice={visibleWorkspaceNotice}
        onDismiss={() => {
          if (visiblePersistentNotice) setDismissedPersistentKey(visiblePersistentNotice.key);
          else setWorkspaceEvent(null);
        }}
        onReview={() => openCardSection('preferences')}
      />

      <StatusBar
        link={cardLink}
        lifecycle={cardLifecycle}
        connectionCenterOpen={connectionCenterOpen}
        cardControlOpen={cardControlOpen}
        onOpenCardControl={openCardControl}
        firmwareStatus={firmwareStatus}
        firmwareRelease={firmwareReleaseIdentity.manifest}
        firmwareReleaseError={firmwareReleaseIdentity.error}
        onOpenFirmwareUpdate={() => openCardSection('install')}
        offlineUpdateState={offlineUpdateState}
        onActivateOfflineUpdate={() => offlineUpdateController?.activateUpdate?.()}
        testStrip={testStrip}
        onToggleTestStrip={onToggleTestStrip}
        onTestStripLengthChange={onTestStripLengthChange}
        runningStudioRelease={runningStudioReleaseRef.current}
        freshness={freshness}
      />
      <CardConnectionCenter
        open={connectionCenterOpen}
        link={cardLink}
        lifecycle={cardLifecycle}
        onOpenSetup={() => {
          closeConnectionCenter();
          openSetupTask();
        }}
        onClose={closeConnectionCenter}
        onConnectCard={onConnectCard}
        onLaunchBridge={onLaunchBridge}
        bridgeResult={bridgeResult}
        onClearBridgeResult={clearBridgeResult}
        recoverLights={typeof window.__LW_RECOVER_LIGHTS_FOR_TEST__ === 'function' ? window.__LW_RECOVER_LIGHTS_FOR_TEST__ : undefined}
        firmwareStatus={firmwareStatus}
        firmwareRelease={firmwareReleaseIdentity.state === 'verified' ? firmwareReleaseIdentity.manifest : null}
        onOpenFirmwareUpdate={() => {
          closeConnectionCenter();
          openCardSection('install');
        }}
        setupEvidence={{
          host: cardLink.host || cardStatus.host,
          mode: cardStatus.status?.setupMode || cardStatus.status?.mode,
          setupNetwork: cardStatus.status?.setupNetwork,
        }}
      />
      <CardControlDrawer
        open={cardControlOpen}
        link={cardLink}
        lifecycle={cardLifecycle}
        host={cardLink.host || cardStatus.host}
        onClose={closeCardControl}
        onAdvanced={openAdvancedPattern}
        onReconnect={reconnectFromCardControl}
      />
      {loadDialogOpen && (
        <ProjectLoadDialog
          browserProjects={listProjectLibraryRecords()}
          onClose={() => setLoadDialogOpen(false)}
          onImport={onImport}
          onOpenBrowserProject={openBrowserProject}
          onOpenFailure={result => showWorkspaceEvent(
            result?.error?.message || (result?.reason === 'stale-session'
              ? 'Your session changed. Sign in again from Preferences.'
              : 'The online project could not be opened.'),
            { kind: 'error', persistent: true, review: true },
          )}
          onOpenPreferences={() => openCardSection('preferences')}
        />
      )}
      {saveDialogOpen && (
        <ProjectSaveDialog
          projectName={projectName}
          onClose={result => {
            setSaveDialogOpen(false);
            if (result?.saved) showWorkspaceEvent('Saved online');
          }}
        />
      )}
      <input ref={fileInputRef} type="file" accept={PROJECT_IMPORT_ACCEPT} style={{ display: 'none' }} onChange={onFile} />
    </div>
  );
}

function App({ projectRepository = null, initialProjectEnvelope = null, offlineUpdateController = null }) {
  return (
    <ProjectProvider repository={projectRepository} initialProjectEnvelope={initialProjectEnvelope}>
      <CloudLibraryProvider>
        <Shell offlineUpdateController={offlineUpdateController} />
      </CloudLibraryProvider>
    </ProjectProvider>
  );
}

export default App;
