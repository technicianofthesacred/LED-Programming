function hasSnapshotMarker(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;

  const { marker, project } = snapshot;
  if (!marker || typeof marker !== 'object') return false;
  if (!project || typeof project !== 'object' || typeof project.id !== 'string' || project.id.length === 0) {
    return false;
  }

  return (
    Object.hasOwn(marker, 'generation')
    && Number.isInteger(marker.generation)
    && marker.generation >= 0
    && Object.hasOwn(marker, 'revision')
    && Number.isInteger(marker.revision)
    && marker.revision >= 0
  );
}

function hasRequiredCallbacks({ flushBrowserRecovery, saveAuthoritative, isSnapshotCurrent }) {
  return [flushBrowserRecovery, saveAuthoritative, isSnapshotCurrent]
    .every((callback) => typeof callback === 'function');
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;

  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function acknowledgesBrowserRecovery(result) {
  return result === true || (result && typeof result === 'object' && result.ok === true);
}

function isAuthoritativeSuccess(result) {
  return result && typeof result === 'object' && result.ok === true;
}

function isThenable(value) {
  return value && typeof value.then === 'function';
}

function safeFailureReason(result) {
  return (
    result
    && typeof result === 'object'
    && result.ok === false
    && typeof result.reason === 'string'
    && result.reason.length > 0
  )
    ? result.reason
    : 'authoritative-save-failed';
}

function safeRejectionReason(error) {
  return (
    error
    && typeof error === 'object'
    && typeof error.reason === 'string'
    && error.reason.length > 0
  )
    ? error.reason
    : 'authoritative-save-failed';
}

/**
 * Completes the two persistence steps that must precede a project switch.
 * The caller owns the persistence callbacks; this helper only enforces order
 * and proves that the project snapshot did not change while saving.
 */
export async function runProjectSwitchSaveBarrier(options = {}) {
  const {
    snapshot,
    flushBrowserRecovery,
    saveAuthoritative,
    isSnapshotCurrent,
  } = options || {};

  if (!hasSnapshotMarker(snapshot)) {
    return { ok: false, reason: 'snapshot-invalid' };
  }

  if (!hasRequiredCallbacks({
    flushBrowserRecovery,
    saveAuthoritative,
    isSnapshotCurrent,
  })) {
    return { ok: false, reason: 'invalid-input' };
  }

  let capturedSnapshot;
  try {
    capturedSnapshot = deepFreeze(structuredClone(snapshot));
  } catch {
    return { ok: false, reason: 'snapshot-invalid' };
  }

  try {
    const recoveryResult = flushBrowserRecovery(capturedSnapshot);
    if (isThenable(recoveryResult) || !acknowledgesBrowserRecovery(recoveryResult)) {
      return { ok: false, reason: 'browser-recovery-failed' };
    }
  } catch {
    return { ok: false, reason: 'browser-recovery-failed' };
  }

  let authoritativeResult;
  try {
    authoritativeResult = await saveAuthoritative(capturedSnapshot);
  } catch (error) {
    return { ok: false, reason: safeRejectionReason(error) };
  }

  if (!isAuthoritativeSuccess(authoritativeResult)) {
    return { ok: false, reason: safeFailureReason(authoritativeResult) };
  }

  try {
    const currentness = isSnapshotCurrent(capturedSnapshot);
    if (isThenable(currentness) || currentness !== true) {
      return { ok: false, reason: 'workspace-changed' };
    }
  } catch {
    return { ok: false, reason: 'workspace-changed' };
  }

  return {
    ok: true,
    destination: authoritativeResult.destination,
    snapshot: capturedSnapshot,
  };
}
