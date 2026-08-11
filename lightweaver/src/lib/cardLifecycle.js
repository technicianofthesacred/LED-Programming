const CONNECTED_STATES = new Set(['connected-direct', 'connected-bridge']);

const LABELS = Object.freeze({
  disconnected: 'Not connected',
  connecting: 'Connecting',
  recovering: 'Recovering',
  reconnecting: 'Card stopped responding',
  verifying: 'Card restarted — verifying',
  'found-unpaired': 'Found — pair',
  updating: 'Updating card',
  'update-recovering': 'Restarting card',
  'wrong-card': 'Wrong card',
  'target-mismatch': 'Needs attention',
  'project-changed': 'Needs attention',
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
  recovering: 'recover-operation',
  reconnecting: 'reconnect-card',
  verifying: 'reconnect-card',
  'found-unpaired': 'pair-card',
  updating: 'recover-operation',
  'update-recovering': 'recover-operation',
  'wrong-card': 'connect-card',
  'target-mismatch': 'update-firmware',
  'project-changed': 'load-matching-project',
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
  const updateEvidence = update || readiness.firmwareUpdate || null;
  const observedId = normalized(link.card?.id || readiness.cardId);
  const expectedId = normalized(link.expectedCard?.id);
  const exactCard = Boolean(observedId) && (!expectedId || observedId === expectedId);
  const studioProjectId = normalized(project?.id || project?.projectId);
  const cardProjectId = normalized(readiness.projectId || readiness.piece?.id);
  const studioFingerprint = normalizedFingerprint(project?.fingerprint || project?.projectFingerprint);
  const cardFingerprint = normalizedFingerprint(readiness.projectFingerprint);
  const studioRevision = Number(project?.revision ?? project?.projectRevision);
  const cardRevision = Number(readiness.projectRevision);
  const exactRevision = Number.isSafeInteger(studioRevision) && studioRevision >= 0
    && Number.isSafeInteger(cardRevision) && cardRevision >= 0
    && studioRevision === cardRevision;
  const exactProject = Boolean(studioProjectId && cardProjectId && studioProjectId === cardProjectId)
    && Boolean(studioFingerprint && studioFingerprint === cardFingerprint)
    && exactRevision;
  const verifiedTransport = exactCard && CONNECTED_STATES.has(link.state);
  const commandReady = verifiedTransport
    && readiness.runtimePhase === 'ready'
    && readiness.knownGoodProject === true
    && readiness.commandReady === true
    && readiness.outputReady === true
    && readiness.playbackReady === true
    && readiness.provisionalSetup !== true;

  let state = 'disconnected';
  if (updateEvidence?.phase === 'rolled-back') state = 'update-rolled-back';
  else if (['preflight', 'sending', 'verifying'].includes(updateEvidence?.phase)) state = 'updating';
  else if (['restarting', 'probation', 'recovering'].includes(updateEvidence?.phase)) state = 'update-recovering';
  else if (updateEvidence?.phase === 'blocked' && updateEvidence?.reason === 'wrong-card') state = 'wrong-card';
  else if (updateEvidence?.phase === 'blocked' && updateEvidence?.reason === 'target-mismatch') state = 'target-mismatch';
  else if (updateEvidence?.phase === 'blocked' && updateEvidence?.reason === 'project-changed') state = 'project-changed';
  else if (['blocked', 'timeout'].includes(updateEvidence?.phase)) state = 'attention-required';
  else if (link.reason === 'wrong-card' || (observedId && expectedId && !exactCard)) state = 'wrong-card';
  else if (link.reason === 'found-unpaired') state = 'found-unpaired';
  else if (link.activity === 'recovering') state = 'recovering';
  else if (link.activity === 'pending') state = 'connecting';
  else if (link.state === 'revalidating') state = 'verifying';
  else if (link.state === 'reconnecting' || link.state === 'reconnecting-bridge') state = 'reconnecting';
  else if (link.reason === 'firmware-too-old' || link.reason === 'identity-missing') state = 'update-required';
  else if (exactCard && link.cardBlank === true) state = 'setup-required';
  else if (link.activity === 'failed' || link.reason === 'operation-uncertain' || link.reason === 'popup-blocked') state = 'attention-required';
  else if (commandReady && !exactProject) state = 'project-mismatch';
  else if (commandReady && exactProject) state = 'ready';
  else if (verifiedTransport) state = 'attention-required';
  else if (link.state === 'connecting') state = 'connecting';

  return Object.freeze({
    state,
    exactCard,
    exactProject,
    exactRevision,
    commandReady,
    safeControlAccess: state === 'ready' ? 'ready' : state,
    label: lifecycleLabel(state),
    setupTaskId: lifecycleSetupTask(state),
    reason: normalized(updateEvidence?.reason || updateEvidence?.rollbackReason || link.reason),
  });
}
