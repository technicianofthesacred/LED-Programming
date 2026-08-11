const CONNECTED_STATES = new Set(['connected-direct', 'connected-bridge']);

const LABELS = Object.freeze({
  disconnected: 'Not connected',
  connecting: 'Connecting',
  reconnecting: 'Card stopped responding',
  verifying: 'Card restarted — verifying',
  'wrong-card': 'Wrong card',
  'update-rolled-back': 'Update rolled back',
  'update-required': 'Needs attention',
  'setup-required': 'Needs project',
  'project-mismatch': 'Needs attention',
  'attention-required': 'Needs attention',
  ready: 'Connected',
});

const SETUP_TASKS = Object.freeze({
  disconnected: 'connect-card',
  connecting: 'connect-card',
  reconnecting: 'reconnect-card',
  verifying: 'reconnect-card',
  'wrong-card': 'connect-card',
  'update-rolled-back': 'recover-operation',
  'update-required': 'update-firmware',
  'setup-required': 'install-project',
  'project-mismatch': 'load-matching-project',
  'attention-required': 'recover-operation',
  ready: 'open-patterns',
});

function normalized(value) {
  return String(value || '').trim();
}

function normalizedFingerprint(value) {
  return normalized(value).toLowerCase();
}

function lifecycleLabel(state) {
  return LABELS[state] || LABELS.disconnected;
}

function lifecycleSetupTask(state) {
  return SETUP_TASKS[state] || SETUP_TASKS.disconnected;
}

export function deriveCardLifecycle({ link = {}, update = null, project = null } = {}) {
  const readiness = link.readiness || {};
  const observedId = normalized(link.card?.id || readiness.cardId);
  const expectedId = normalized(link.expectedCard?.id);
  const exactCard = Boolean(observedId) && (!expectedId || observedId === expectedId);
  const studioProjectId = normalized(project?.id || project?.projectId);
  const cardProjectId = normalized(readiness.projectId || readiness.piece?.id);
  const studioFingerprint = normalizedFingerprint(project?.fingerprint || project?.projectFingerprint);
  const cardFingerprint = normalizedFingerprint(readiness.projectFingerprint);
  const exactProject = Boolean(studioProjectId && cardProjectId && studioProjectId === cardProjectId)
    && (!studioFingerprint || studioFingerprint === cardFingerprint);
  const verifiedTransport = exactCard && CONNECTED_STATES.has(link.state);
  const commandReady = verifiedTransport
    && readiness.runtimePhase === 'ready'
    && readiness.knownGoodProject === true
    && readiness.commandReady === true
    && readiness.outputReady === true
    && readiness.playbackReady === true
    && readiness.provisionalSetup !== true;

  let state = 'disconnected';
  if (update?.phase === 'rolled-back') state = 'update-rolled-back';
  else if (link.reason === 'wrong-card' || (observedId && expectedId && !exactCard)) state = 'wrong-card';
  else if (link.state === 'revalidating') state = 'verifying';
  else if (link.state === 'reconnecting' || link.state === 'reconnecting-bridge') state = 'reconnecting';
  else if (link.reason === 'firmware-too-old' || link.reason === 'identity-missing') state = 'update-required';
  else if (exactCard && link.cardBlank === true) state = 'setup-required';
  else if (link.activity === 'failed' || link.reason === 'operation-uncertain') state = 'attention-required';
  else if (commandReady && !exactProject) state = 'project-mismatch';
  else if (commandReady && exactProject) state = 'ready';
  else if (verifiedTransport) state = 'attention-required';
  else if (link.state === 'connecting' || link.activity === 'pending') state = 'connecting';

  return Object.freeze({
    state,
    exactCard,
    exactProject,
    commandReady,
    safeControlAccess: state === 'ready' ? 'ready' : state,
    label: lifecycleLabel(state),
    setupTaskId: lifecycleSetupTask(state),
    reason: normalized(update?.reason || link.reason),
  });
}
