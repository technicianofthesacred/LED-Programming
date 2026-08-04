function hasSnapshotMarker(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;

  const { marker } = snapshot;
  if (!marker || typeof marker !== 'object') return false;

  return (
    Object.hasOwn(marker, 'generation')
    && marker.generation != null
    && Object.hasOwn(marker, 'revision')
    && marker.revision != null
  );
}

function hasRequiredCallbacks({ flushBrowserRecovery, saveAuthoritative, isSnapshotCurrent }) {
  return [flushBrowserRecovery, saveAuthoritative, isSnapshotCurrent]
    .every((callback) => typeof callback === 'function');
}

function indicatesFailure(result) {
  return result === false || (result && typeof result === 'object' && result.ok === false);
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

  if (!hasSnapshotMarker(snapshot) || !hasRequiredCallbacks({
    flushBrowserRecovery,
    saveAuthoritative,
    isSnapshotCurrent,
  })) {
    return { ok: false, reason: 'invalid-input' };
  }

  try {
    const recoveryResult = flushBrowserRecovery(snapshot);
    if (isThenable(recoveryResult) || indicatesFailure(recoveryResult)) {
      return { ok: false, reason: 'browser-recovery-failed' };
    }
  } catch {
    return { ok: false, reason: 'browser-recovery-failed' };
  }

  let authoritativeResult;
  try {
    authoritativeResult = await saveAuthoritative(snapshot);
  } catch {
    return { ok: false, reason: 'authoritative-save-failed' };
  }

  if (indicatesFailure(authoritativeResult)) {
    return { ok: false, reason: safeFailureReason(authoritativeResult) };
  }

  try {
    const currentness = isSnapshotCurrent(snapshot);
    if (isThenable(currentness) || currentness !== true) {
      return { ok: false, reason: 'workspace-changed' };
    }
  } catch {
    return { ok: false, reason: 'workspace-changed' };
  }

  return { ok: true, result: authoritativeResult };
}
