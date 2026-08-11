import { correlateFirmwareUpdateRecovery } from './cardFirmwareUpdater.js';
import { isLocalCardHost, normalizeCardHost } from './cardConnection.js';

const TERMINAL_BLOCKERS = new Set(['wrong-card', 'target-mismatch', 'project-changed']);
const DEADLINE_REACHED = Symbol('deadline-reached');

function validRecoveryEnvelope(session) {
  const rawTargetFirmwareVersion = typeof session?.targetFirmwareVersion === 'string'
    ? session.targetFirmwareVersion
    : '';
  const targetFirmwareVersion = rawTargetFirmwareVersion.trim();
  return session?.version === 1
    && rawTargetFirmwareVersion === targetFirmwareVersion
    && rawTargetFirmwareVersion.length > 0
    && rawTargetFirmwareVersion.length <= 48
    && correlateFirmwareUpdateRecovery(session, {}, {}).reason !== 'session-invalid';
}

function defaultWait(milliseconds, { signal } = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

async function runBeforeDeadline(operation, { deadline, now, wait }) {
  const remainingMs = deadline - now();
  if (remainingMs <= 0) return { deadline: true };

  const operationController = new AbortController();
  let settled = false;
  let operationPromise;
  try {
    operationPromise = Promise.resolve(operation(operationController.signal)).then(
      value => {
        settled = true;
        return { value };
      },
      error => {
        settled = true;
        return { error };
      },
    );
  } catch (error) {
    return { error };
  }

  // Avoid creating a deadline timer for synchronous or already-settled work.
  await Promise.resolve();
  if (settled) return operationPromise;

  const timerController = new AbortController();
  const deadlinePromise = Promise.resolve()
    .then(() => wait(remainingMs, { signal: timerController.signal }))
    .then(() => DEADLINE_REACHED, () => DEADLINE_REACHED);
  try {
    const result = await Promise.race([operationPromise, deadlinePromise]);
    if (result === DEADLINE_REACHED) {
      operationController.abort();
      return { deadline: true };
    }
    return result;
  } finally {
    timerController.abort();
  }
}

export async function recoverFirmwareUpdate({
  session,
  hosts = [],
  connect,
  readSnapshot,
  wait = defaultWait,
  now = () => Date.now(),
  timeoutMs = 45_000,
  onState = () => {},
} = {}) {
  if (!session?.cardId || typeof connect !== 'function' || typeof readSnapshot !== 'function'
    || typeof wait !== 'function' || typeof now !== 'function' || typeof onState !== 'function'
    || !Number.isFinite(timeoutMs) || timeoutMs < 0
    || !validRecoveryEnvelope(session)) {
    throw new TypeError('Exact firmware recovery inputs are required.');
  }
  const candidates = [...new Set(
    (Array.isArray(hosts) ? hosts : [])
      .filter(host => String(host || '').trim())
      .map(normalizeCardHost)
      .filter(host => host && isLocalCardHost(host)),
  )];
  if (!candidates.length) throw new TypeError('At least one local recovery host is required.');

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  if (!Number.isFinite(startedAt) || !Number.isFinite(deadline)) {
    throw new TypeError('Exact firmware recovery inputs are required.');
  }
  let intervalMs = 400;
  let attempt = 0;
  while (now() < deadline) {
    const host = candidates[attempt % candidates.length];
    attempt += 1;
    onState({ state: 'reconnecting', host, attempt });
    const connection = await runBeforeDeadline(
      signal => connect(host, { expectedCardId: session.cardId, signal }),
      { deadline, now, wait },
    );
    if (connection.deadline) return { state: 'timeout', reason: 'reconnect-timeout' };

    const snapshotRead = await runBeforeDeadline(
      signal => readSnapshot(host, { signal }),
      { deadline, now, wait },
    );
    if (snapshotRead.deadline) return { state: 'timeout', reason: 'reconnect-timeout' };
    const snapshot = snapshotRead.error ? null : snapshotRead.value;
    if (snapshot?.readiness) {
      const correlation = correlateFirmwareUpdateRecovery(
        session,
        snapshot.updateStatus || {},
        snapshot.readiness,
      );
      if (correlation.ok) return { state: 'reconnected', correlation, snapshot };
      if (correlation.phase === 'rolled-back') return { state: 'rolled-back', correlation, snapshot };
      if (TERMINAL_BLOCKERS.has(correlation.reason)) {
        return { state: 'blocked', reason: correlation.reason, correlation };
      }
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    await wait(Math.min(intervalMs, remainingMs));
    intervalMs = Math.min(2_000, intervalMs * 2);
  }
  return { state: 'timeout', reason: 'reconnect-timeout' };
}
