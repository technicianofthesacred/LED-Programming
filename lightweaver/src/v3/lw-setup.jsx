import React, { useEffect, useMemo, useRef, useState } from 'react';
import './lw-setup.css';
import { CONNECTED_CARD_LINK_STATES, deriveSetupJourney } from '../lib/setupJourney.js';
import { CARD_COMMISSIONING_CHANGED_EVENT, inspectCardCommissioning } from '../lib/cardCommissioningFlow.js';
import { readCardProjectEvidence, readCardStatusEnvelope } from '../lib/cardPushClient.js';
import { resolveCardProject, describeResolvedCardProject } from '../lib/cardProjectResolver.js';
import { isBenchProjectEvidence } from '../lib/benchConfig.js';
import { projectSkeletonFromCardStatus } from '../lib/discoveryCommit.js';
import { cardConnectionStatus } from '../components/card/CardStatusControl.jsx';
import { useProject } from '../state/ProjectContext.jsx';

function exactCardName(cardLink, cardHost) {
  return cardLink?.card?.name
    || cardLink?.card?.id
    || cardLink?.readiness?.cardId
    || cardLink?.host
    || cardHost
    || 'No exact card yet';
}

function installRelationship(resolution) {
  if (resolution.kind === 'matches-current') return 'Installed project matches';
  if (resolution.kind === 'saved-match') return 'Matching saved project found';
  if (resolution.kind === 'bench') return 'Temporary setup — not installed';
  return 'Project not installed';
}

function discoveryEvidence(project) {
  const outputs = (Array.isArray(project?.portRoles) ? project.portRoles : [])
    .filter(output => output?.role === 'strip' && Number(output.pixelCount) > 0);
  const color = project?.devices?.standaloneController?.led;
  return {
    outputs,
    colorOrder: color?.colorOrderConfirmed === true ? color.colorOrder : '',
    count: outputs.reduce((sum, output) => sum + Number(output.pixelCount || 0), 0),
  };
}

export function SetupScreen({
  connected,
  cardHost,
  onOpenConnectionCenter,
  cardLink,
  currentProject = {},
  activeCloudProjects = [],
  browserProjects = [],
  replaceProject,
}) {
  const { setProjectId, setPortRoles, setStandaloneController } = useProject();
  const [commissioningFlow, setCommissioningFlow] = useState(() => inspectCardCommissioning().flow);
  const [cardState, setCardState] = useState({ evidence: null, status: null, read: false });
  const [resolution, setResolution] = useState({ kind: 'unknown' });
  const importRef = useRef(null);
  const resolveInputsRef = useRef({ currentProject, activeCloudProjects, browserProjects });
  const previousPhaseRef = useRef('');
  resolveInputsRef.current = { currentProject, activeCloudProjects, browserProjects };

  const exactTransport = CONNECTED_CARD_LINK_STATES.includes(cardLink?.state);
  const cardReachable = exactTransport || connected;

  useEffect(() => {
    const sync = () => setCommissioningFlow(inspectCardCommissioning().flow);
    window.addEventListener('storage', sync);
    window.addEventListener(CARD_COMMISSIONING_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CARD_COMMISSIONING_CHANGED_EVENT, sync);
    };
  }, []);

  const applyCardParts = (parts, status = null) => {
    if (status?.projectId) setProjectId(status.projectId);
    if (Array.isArray(parts?.portRoles)) setPortRoles(parts.portRoles);
    if (Array.isArray(parts?.outputs) || parts?.colorOrder) {
      setStandaloneController(previous => ({
        ...previous,
        ...(Array.isArray(parts.outputs) ? { outputs: parts.outputs } : {}),
        led: {
          ...(previous?.led || {}),
          ...(parts.colorOrder ? { colorOrder: parts.colorOrder, colorOrderConfirmed: true } : {}),
          ...(Array.isArray(parts.outputs) ? {
            outputs: parts.outputs,
            pixels: parts.outputs.reduce((sum, output) => sum + Number(output.pixels || 0), 0),
          } : {}),
        },
      }));
    }
  };

  const adoptedCardRef = useRef('');
  const adoptWiringFromCard = status => {
    const signature = `${status?.cardId || ''}:${status?.projectId || ''}:${status?.bootId || ''}`;
    if (!signature.replace(/:/g, '') || adoptedCardRef.current === signature) return;
    const skeleton = projectSkeletonFromCardStatus(status || {});
    if (!skeleton.portRoles.some(output => output?.role === 'strip' && Number(output.pixelCount) > 0)) return;
    const alreadyDescribed = (currentProject?.portRoles || [])
      .some(output => output?.role === 'strip' && Number(output.pixelCount) > 0);
    adoptedCardRef.current = signature;
    if (!alreadyDescribed) applyCardParts(skeleton, status);
  };

  useEffect(() => {
    if (!cardReachable) {
      setCardState({ evidence: null, status: null, read: false });
      setResolution({ kind: 'unknown' });
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const readHost = cardLink?.host || cardHost || '';
      const readTransport = cardLink?.transport;
      const [projectResult, statusResult] = await Promise.allSettled([
        readCardProjectEvidence({ host: readHost, transport: readTransport }),
        readCardStatusEnvelope({ host: readHost, transport: readTransport }),
      ]);
      if (cancelled) return;
      const evidence = projectResult.status === 'fulfilled' ? projectResult.value : null;
      const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
      setCardState({ evidence, status, read: true });
      adoptWiringFromCard(status);
      if (!evidence) {
        setResolution({ kind: 'none' });
        return;
      }
      if (isBenchProjectEvidence(evidence)) {
        setResolution({ kind: 'bench' });
        return;
      }
      const inputs = resolveInputsRef.current;
      const resolved = resolveCardProject({
        evidence,
        currentProject: inputs.currentProject,
        productionJobs: [],
        cloudProjects: Array.isArray(inputs.activeCloudProjects) ? inputs.activeCloudProjects : [],
        browserProjects: Array.isArray(inputs.browserProjects) ? inputs.browserProjects : [],
      });
      if (resolved.status === 'match') {
        setResolution(resolved.source === 'current'
          ? { kind: 'matches-current', resolved }
          : { kind: 'saved-match', resolved });
      } else {
        setResolution({ kind: 'none' });
      }
    })();
    return () => { cancelled = true; };
  }, [cardReachable, cardLink?.host, cardLink?.transport, cardHost, currentProject?.id, currentProject?.projectRevision]);

  const journeyResolution = resolution.kind === 'matches-current'
    ? { matchesCurrentProject: true, playbackAccess: 'ready', provisionalSetup: false }
    : resolution.kind === 'saved-match'
      ? { savedProjectMatch: true, playbackAccess: 'ready', provisionalSetup: false }
      : resolution.kind === 'bench'
        ? { provisionalSetup: true }
        : null;
  const journey = useMemo(() => deriveSetupJourney({
    cardLink,
    commissioningFlow,
    project: currentProject,
    resolution: journeyResolution,
  }), [cardLink, commissioningFlow, currentProject, resolution.kind]);

  useEffect(() => {
    const previous = previousPhaseRef.current;
    previousPhaseRef.current = journey.currentPhaseId || '';
    if (!previous || !journey.currentPhaseId || previous === journey.currentPhaseId) return undefined;
    const frame = requestAnimationFrame(() => {
      document.querySelector(`[data-testid="setup-phase-${journey.currentPhaseId}"] h2`)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [journey.currentPhaseId]);

  const go = hash => { window.location.hash = hash; };

  const startFromCard = () => applyCardParts(
    projectSkeletonFromCardStatus(cardState.status || cardLink?.readiness || {}),
    cardState.status,
  );

  const loadResolvedProject = async () => {
    if (!resolution?.resolved?.project) return;
    try { await replaceProject?.(resolution.resolved.project, { confirmDiscard: () => true }); } catch { /* keep current */ }
  };

  const onImportFile = event => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async loadEvent => {
      try { await replaceProject?.(JSON.parse(String(loadEvent.target.result))); } catch { /* keep current */ }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const evidence = discoveryEvidence(currentProject);
  const identityStatus = cardConnectionStatus(cardLink || {});
  const renderActiveTask = phase => {
    if (phase.id === 'connect') {
      const blocker = journey.blockers[0]?.id;
      return (
        <div className="lw-setup-task" data-testid="setup-active-task">
          {blocker === 'firmware' && <p role="status">This exact card needs Lightweaver firmware before setup can continue.</p>}
          {blocker === 'wifi' && <p role="status">The exact card is on its setup network. Finish Wi-Fi, then return here.</p>}
          <button type="button" className="btn primary" data-testid="setup-connect-card" onClick={() => onOpenConnectionCenter?.()}>
            Find my card
          </button>
          <button type="button" className="btn" data-testid="setup-connect-manual" onClick={() => onOpenConnectionCenter?.()}>Connect by address</button>
          {blocker === 'firmware' && <button type="button" className="btn" onClick={() => go('#screen=card&section=install')}>Install or update firmware</button>}
          {blocker === 'wifi' && <button type="button" className="btn" onClick={() => onOpenConnectionCenter?.()}>Continue Wi-Fi setup</button>}
        </div>
      );
    }
    if (phase.id === 'lights') {
      return (
        <div className="lw-setup-task" data-testid="setup-active-task">
          <p>Find every light output, establish color before counting, and confirm the final light with the next position dark.</p>
          <ul className="lw-setup-subprogress" aria-label="Light discovery progress">
            {phase.progress.map(item => <li key={item.id} data-status={item.status}>{item.status === 'done' ? '✓' : '·'} {item.id === 'color' ? 'Color order' : item.id === 'count' ? 'Light count' : item.id === 'boundary' ? 'Final and next-dark boundary' : 'Output'}</li>)}
          </ul>
          <button type="button" className="btn primary" data-testid="setup-lights-action" onClick={() => go('#screen=discovery')}>
            {evidence.count > 0 ? 'Review the connected lights' : 'Find and count the lights'}
          </button>
        </div>
      );
    }
    if (phase.id === 'layout') {
      const placementDone = phase.progress.some(item => item.id === 'placement' && item.status === 'done');
      return (
        <div className="lw-setup-task" data-testid="setup-active-task">
          <p>Place the discovered outputs in the artwork, then confirm their physical direction in Layout.</p>
          <ul className="lw-setup-subprogress" aria-label="Artwork placement progress">
            {phase.progress.map(item => <li key={item.id} data-status={item.status}>{item.status === 'done' ? '✓' : '·'} {item.id === 'placement' ? 'Artwork placement' : 'Light direction'}</li>)}
          </ul>
          <button
            type="button"
            className="btn primary"
            data-testid="setup-layout-action"
            onClick={() => go(placementDone ? '#screen=layout&mode=wire' : '#screen=layout&mode=draw')}
          >
            {placementDone ? 'Verify light direction' : 'Place lights in the artwork'}
          </button>
        </div>
      );
    }
    return (
      <div className="lw-setup-task" data-testid="setup-active-task">
        <dl className="lw-setup-summary">
          <div><dt>Card</dt><dd>{exactCardName(cardLink, cardHost)}</dd></div>
          <div><dt>Project</dt><dd>{currentProject?.name || currentProject?.id || 'Untitled project'}</dd></div>
          <div><dt>Outputs</dt><dd>{evidence.outputs.length || 'None'}</dd></div>
          <div><dt>Lights</dt><dd>{evidence.count || 'None counted'}</dd></div>
          <div><dt>Color</dt><dd>{evidence.colorOrder || 'Not confirmed'}</dd></div>
          <div><dt>Power</dt><dd>{currentProject?.devices?.standaloneController?.power?.maxMilliamps ? `${currentProject.devices.standaloneController.power.maxMilliamps} mA limit` : 'Review in Hardware settings'}</dd></div>
        </dl>
        <p>The existing Test &amp; Install surface sends the candidate, verifies exact readback, and waits for your explicit visible confirmation.</p>
        <button type="button" className="btn primary" data-testid="setup-verify-action" onClick={() => go('#screen=layout&mode=wire')}>Test and save to card</button>
      </div>
    );
  };

  return (
    <>
      <div className="lw-setup-lede">
        <p className="lw-setup-intro">Four outcomes take this exact card from first connection to a physically checked project. Setup advances from evidence, not a saved checklist.</p>
      </div>

      <section className="lw-setup-identity" data-testid="setup-identity-row" aria-label="Current card and project" aria-live="polite">
        <div><span>Card</span><strong>{exactCardName(cardLink, cardHost)}</strong></div>
        <div><span>Connection</span><strong>{identityStatus}</strong></div>
        <div><span>Project</span><strong>{currentProject?.name || currentProject?.id || 'Untitled project'}</strong></div>
        <div><span>Installed</span><strong>{installRelationship(resolution)}</strong></div>
      </section>

      <div className="card-status-area" data-testid="setup-card-status" aria-live="polite">
        {resolution.kind === 'bench' && (
          <section className="card-support-panel lw-setup-banner">
            <h2>Temporary light setup detected</h2>
            <p>This is discovery evidence, not a finished installation. Continue through artwork placement and the visible final test.</p>
          </section>
        )}
        {resolution.kind === 'matches-current' && (
          <section className="card-support-panel lw-setup-banner">
            <h2>This exact card is already set up</h2>
            <p>Its installed project matches the project open in Studio. The verified card bridge remains available for controls.</p>
            <button type="button" className="btn primary" data-testid="setup-open-patterns" onClick={() => go('#screen=pattern')}>Open Patterns</button>
          </section>
        )}
        {resolution.kind === 'saved-match' && (
          <section className="card-support-panel lw-setup-banner">
            <h2>A saved project matches this exact card</h2>
            <p>Load the matching project instead of replaying blank-card setup.</p>
            <button type="button" className="btn primary" data-testid="setup-load-matched" onClick={() => void loadResolvedProject()}>
              {resolution.resolved ? `Load ${describeResolvedCardProject(resolution.resolved)}` : 'Load matching project'}
            </button>
          </section>
        )}
        {resolution.kind === 'none' && cardState.read && cardState.status?.projectId && (
          <section className="card-support-panel lw-setup-banner">
            <h2>Resolve this card&rsquo;s project</h2>
            <div className="lw-setup-banner-actions">
              <button type="button" className="btn" data-testid="setup-import-project" onClick={() => importRef.current?.click()}>Import project file</button>
              <button type="button" className="btn" data-testid="setup-start-from-card" onClick={startFromCard}>Start from card wiring</button>
            </div>
          </section>
        )}
      </div>

      <section className="lw-setup-phases" aria-label="Setup outcomes">
        <p className="lw-setup-progress" data-testid="setup-progress">
          {journey.setupComplete ? 'Setup complete' : `Phase ${journey.phases.findIndex(phase => phase.id === journey.currentPhaseId) + 1} of 4`}
        </p>
        <ol className="lw-setup-phase-list">
          {journey.phases.map((phase, index) => {
            const active = phase.id === journey.currentPhaseId;
            return (
              <li
                key={phase.id}
                className={`lw-setup-phase is-${phase.status}${active ? ' is-active' : ''}`}
                data-testid={`setup-phase-${phase.id}`}
                data-phase-id={phase.id}
                data-status={phase.status}
                aria-current={active ? 'step' : undefined}
              >
                <div className="lw-setup-phase-head">
                  <span className="lw-setup-phase-marker" aria-hidden="true">{phase.status === 'done' ? '✓' : index + 1}</span>
                  <div>
                    <h2 tabIndex={-1}>{phase.title}</h2>
                    {!active && <p>{phase.detail}</p>}
                  </div>
                </div>
                {active && renderActiveTask(phase)}
              </li>
            );
          })}
        </ol>
      </section>

      <input ref={importRef} className="lw-setup-import" type="file" accept="application/json" hidden data-testid="setup-import-input" onChange={onImportFile} />
    </>
  );
}
