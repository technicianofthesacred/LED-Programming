import { PORT_ROLE_STRIP } from './portRoles.js';

// Setup is expressed as four owner outcomes. Firmware and Wi-Fi are evidence
// blockers inside connection, never durable numbered work of their own.
export const SETUP_PHASE_IDS = Object.freeze(['connect', 'lights', 'layout', 'verify']);

// Retained while the Setup screen migrates from its old step vocabulary. New
// consumers should use SETUP_PHASE_IDS and `journey.phases`.
export const SETUP_STEP_IDS = SETUP_PHASE_IDS;

export const CONNECTED_CARD_LINK_STATES = Object.freeze(['connected-direct', 'connected-bridge']);

const SETUP_MODE_HOST = '192.168.4.1';

const PHASE_COPY = Object.freeze({
  connect: {
    title: 'Connect and identify exact card',
    detail: 'Find the exact Lightweaver card and resolve firmware or Wi-Fi only when they block connection.',
  },
  lights: {
    title: 'Find and verify the lights',
    detail: 'Verify each output, color order, count, and final-light boundary.',
  },
  layout: {
    title: 'Place lights in the artwork',
    detail: 'Carry the discovered outputs into the artwork and place the lights where they belong.',
  },
  verify: {
    title: 'Test and save to card',
    detail: 'Send the project, verify exact readback, and confirm what the real lights show.',
  },
});

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function connectedExactCard(cardLink) {
  if (!CONNECTED_CARD_LINK_STATES.includes(cardLink?.state)) return false;
  const observedId = String(cardLink?.card?.id || cardLink?.readiness?.cardId || '').trim();
  if (!observedId) return false;
  const expectedId = String(cardLink?.expectedCard?.id || '').trim();
  return !expectedId || expectedId === observedId;
}

function commissioningStage(commissioningFlow) {
  return commissioningFlow?.stage ?? commissioningFlow?.flow?.stage ?? '';
}

function connectBlockers({ cardLink, commissioningFlow }) {
  const stage = commissioningStage(commissioningFlow);
  if (cardLink?.reason === 'firmware-too-old' || stage === 'install-safely') {
    return [{ id: 'firmware', phaseId: 'connect' }];
  }
  if (!connectedExactCard(cardLink)) return [{ id: 'connect-card', phaseId: 'connect' }];
  if (normalizeHost(cardLink?.host) === SETUP_MODE_HOST) return [{ id: 'wifi', phaseId: 'connect' }];
  return [];
}

function stripOutputs(project) {
  return (Array.isArray(project?.portRoles) ? project.portRoles : []).filter(entry => (
    entry
    && entry.role === PORT_ROLE_STRIP
    && Number.isFinite(Number(entry.pin))
  ));
}

function confirmedColor(project) {
  const led = project?.devices?.standaloneController?.led;
  return led?.colorOrderConfirmed === true && Boolean(String(led?.colorOrder || '').trim());
}

function lightProgress(project) {
  const outputs = stripOutputs(project);
  const outputDone = outputs.length > 0;
  const colorDone = outputDone && confirmedColor(project);
  const countDone = colorDone && outputs.every(output => Number(output.pixelCount) > 0);
  // StripDiscovery persists a count only after its final/next-dark marker has
  // been accepted, so the saved count is also the durable boundary evidence.
  const boundaryDone = countDone;
  const states = [
    ['output', outputDone],
    ['color', colorDone],
    ['count', countDone],
    ['boundary', boundaryDone],
  ];
  const currentIndex = states.findIndex(([, done]) => !done);
  return states.map(([id, done], index) => ({
    id,
    status: done ? 'done' : index === currentIndex ? 'current' : 'locked',
  }));
}

function lightsComplete(progress, resolution) {
  if (resolution?.provisionalSetup === true) return false;
  return progress.every(item => item.status === 'done');
}

function layoutProgress(project) {
  const layout = project?.layout;
  const placementDone = layout?.starterPending === false
    && Array.isArray(layout.strips)
    && layout.strips.length > 0;
  const runs = Array.isArray(layout?.wiring?.runs)
    ? layout.wiring.runs.filter(run => run?.type === 'strip')
    : [];
  // Direction is physical evidence owned by Layout/Wire, not another Setup
  // checkbox. The canonical wiring verification is cleared whenever output,
  // count, or direction changes, so it is the durable proof this phase needs.
  const directionDone = placementDone
    && layout?.wiring?.verified === true
    && runs.length > 0
    && runs.every(run => run?.verified === true
      && ['source-forward', 'source-reverse'].includes(run?.physicalDirection));
  return [
    { id: 'placement', status: placementDone ? 'done' : 'current' },
    { id: 'direction', status: directionDone ? 'done' : placementDone ? 'current' : 'locked' },
  ];
}

function layoutComplete(progress) {
  return progress.every(item => item.status === 'done');
}

function exactVerificationComplete(verification) {
  return verification?.sent === true
    && verification?.exactReadback === true
    && verification?.visibleConfirmed === true;
}

function nextVerificationAction(verification) {
  if (verification?.sent === true && verification?.exactReadback === true && verification?.visibleConfirmed !== true) {
    return { id: 'confirm-visible-lights', phaseId: 'verify' };
  }
  return { id: 'test-and-save', phaseId: 'verify' };
}

function phasesFor(currentPhaseId, lightsProgress, currentLayoutProgress, complete = false) {
  const currentIndex = complete ? SETUP_PHASE_IDS.length : SETUP_PHASE_IDS.indexOf(currentPhaseId);
  return SETUP_PHASE_IDS.map((id, index) => ({
    id,
    ...PHASE_COPY[id],
    status: complete || index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming',
    ...(id === 'lights' ? { progress: lightsProgress } : {}),
    ...(id === 'layout' ? { progress: currentLayoutProgress } : {}),
  }));
}

export function deriveSetupJourney({
  cardLink,
  commissioningFlow,
  project,
  resolution,
  verification,
} = {}) {
  const blockers = connectBlockers({ cardLink, commissioningFlow });
  const progress = lightProgress(project);
  const currentLayoutProgress = layoutProgress(project);

  const installedMatch = blockers.length === 0
    && resolution?.matchesCurrentProject === true
    && resolution?.playbackAccess === 'ready'
    && resolution?.provisionalSetup !== true;
  if (installedMatch) {
    return {
      diagnosis: { state: 'installed-match' },
      phases: phasesFor(null, progress, currentLayoutProgress, true),
      blockers: [],
      currentPhaseId: null,
      nextAction: { id: 'open-patterns' },
      resumeDestination: 'patterns',
      setupComplete: true,
    };
  }

  const savedMatch = blockers.length === 0
    && resolution?.savedProjectMatch === true
    && resolution?.provisionalSetup !== true;
  if (savedMatch) {
    return {
      diagnosis: { state: 'saved-match' },
      phases: phasesFor('connect', progress, currentLayoutProgress),
      blockers: [],
      currentPhaseId: null,
      nextAction: { id: 'load-matching-project' },
      resumeDestination: null,
      setupComplete: false,
    };
  }

  let currentPhaseId;
  let nextAction;
  if (blockers.length > 0) {
    currentPhaseId = 'connect';
    nextAction = {
      id: blockers[0].id === 'connect-card'
        ? 'connect-card'
        : blockers[0].id === 'firmware'
          ? 'install-firmware'
          : 'configure-wifi',
      phaseId: 'connect',
    };
  } else if (!lightsComplete(progress, resolution)) {
    currentPhaseId = 'lights';
    nextAction = { id: 'discover-lights', phaseId: 'lights' };
  } else if (!layoutComplete(currentLayoutProgress)) {
    currentPhaseId = 'layout';
    nextAction = {
      id: currentLayoutProgress[0].status === 'done' ? 'verify-direction' : 'place-lights',
      phaseId: 'layout',
    };
  } else if (!exactVerificationComplete(verification)) {
    currentPhaseId = 'verify';
    nextAction = nextVerificationAction(verification);
  } else {
    return {
      diagnosis: { state: 'setup-complete' },
      phases: phasesFor(null, progress, currentLayoutProgress, true),
      blockers: [],
      currentPhaseId: null,
      nextAction: { id: 'open-patterns' },
      resumeDestination: 'patterns',
      setupComplete: true,
    };
  }

  return {
    diagnosis: {
      state: blockers[0]?.id === 'connect-card' ? 'needs-card' : currentPhaseId === 'connect' ? 'connect-blocked' : 'setup-required',
    },
    phases: phasesFor(currentPhaseId, progress, currentLayoutProgress),
    blockers,
    currentPhaseId,
    nextAction,
    resumeDestination: null,
    setupComplete: false,
  };
}

export function isSetupComplete(journey) {
  return journey?.setupComplete === true;
}
