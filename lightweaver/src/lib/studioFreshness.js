import { parseStudioRelease } from './studioRelease.js';

export const STUDIO_RELEASE_PATH = '/studio-release.json';
export const STUDIO_FRESHNESS_POLL_MS = 30_000;
export const STUDIO_FRESHNESS_TIMEOUT_MS = 5_000;
export const STUDIO_REFRESH_ATTEMPT_KEY = 'lw_studio_refresh_attempt_v1';

function immutableState(status, buildId, reason = '') {
  return Object.freeze({ status, buildId, reason });
}

function boundedError(reason) {
  return Object.assign(new Error(reason), { freshnessReason: reason });
}

function hasNoStore(response) {
  return /(?:^|,)\s*no-store(?:\s*(?:,|$))/i.test(response.headers.get('cache-control') || '');
}

function sameAttempt(value, from, to) {
  if (!value) return false;
  try {
    const parsed = JSON.parse(value);
    return parsed?.from === from && parsed?.to === to;
  } catch {
    return false;
  }
}

export function createStudioFreshnessMonitor({
  release: releaseInput,
  fetchImpl = fetch,
  flushAutosave,
  reload,
  storage,
  locationOrigin,
  navigatorRef = navigator,
  documentRef = document,
  windowRef = window,
  createTimeoutSignal = milliseconds => AbortSignal.timeout(milliseconds),
  timers = {
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: id => globalThis.clearTimeout(id),
  },
} = {}) {
  const release = parseStudioRelease(releaseInput);
  const releaseUrl = new URL(STUDIO_RELEASE_PATH, locationOrigin).href;
  const listeners = new Set();
  let state = immutableState('checking', release.buildId);
  let started = false;
  let operationActive = false;
  let pendingRelease = null;
  let pollTimer = null;
  let inFlight = null;

  const emit = next => {
    state = next;
    for (const listener of listeners) listener(state);
    return state;
  };

  const unknown = reason => emit(immutableState('unknown', release.buildId, reason));

  const clearPoll = () => {
    if (pollTimer !== null) timers.clearTimeout(pollTimer);
    pollTimer = null;
  };

  const schedulePoll = () => {
    clearPoll();
    if (!started || documentRef.visibilityState !== 'visible') return;
    pollTimer = timers.setTimeout(async () => {
      pollTimer = null;
      await checkNow();
      schedulePoll();
    }, STUDIO_FRESHNESS_POLL_MS);
  };

  const refreshTo = target => {
    const from = release.sourceRevision;
    const to = target.sourceRevision;
    let previous;
    try {
      previous = storage.getItem(STUDIO_REFRESH_ATTEMPT_KEY);
    } catch {
      unknown('storage');
      return;
    }
    if (sameAttempt(previous, from, to)) {
      unknown('reload-loop');
      return;
    }

    let saved = false;
    try {
      saved = flushAutosave() === true;
    } catch {
      saved = false;
    }
    if (!saved) {
      unknown('autosave');
      return;
    }

    try {
      storage.setItem(STUDIO_REFRESH_ATTEMPT_KEY, JSON.stringify({ from, to }));
    } catch {
      unknown('storage');
      return;
    }
    try {
      reload();
    } catch {
      unknown('reload');
    }
  };

  const acceptRelease = target => {
    if (target.sourceRevision === release.sourceRevision) {
      pendingRelease = null;
      try { storage.removeItem(STUDIO_REFRESH_ATTEMPT_KEY); } catch { /* matching code needs no reload guard */ }
      return emit(immutableState('current', release.buildId));
    }
    if (operationActive) {
      pendingRelease = target;
      return emit(immutableState('update-ready', target.buildId, 'operation-active'));
    }
    pendingRelease = null;
    refreshTo(target);
    return state;
  };

  const checkNow = () => {
    if (inFlight) return inFlight;
    if (navigatorRef.onLine === false) return Promise.resolve(unknown('offline'));
    inFlight = (async () => {
      let response;
      try {
        response = await fetchImpl(releaseUrl, {
          cache: 'no-store',
          redirect: 'manual',
          signal: createTimeoutSignal(STUDIO_FRESHNESS_TIMEOUT_MS),
        });
      } catch {
        throw boundedError('request');
      }
      if (response.status !== 200 || response.redirected === true) throw boundedError('response');
      if (!hasNoStore(response)) throw boundedError('cache');
      let target;
      try {
        target = parseStudioRelease(await response.text());
      } catch {
        throw boundedError('invalid');
      }
      return acceptRelease(target);
    })()
      .catch(error => unknown(error?.freshnessReason || 'request'))
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  const onFocus = () => { void checkNow(); };
  const onOnline = () => { void checkNow(); };
  const onVisibilityChange = () => {
    schedulePoll();
    if (documentRef.visibilityState === 'visible') void checkNow();
  };

  return Object.freeze({
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      if (started) return checkNow();
      started = true;
      windowRef.addEventListener('focus', onFocus);
      windowRef.addEventListener('online', onOnline);
      documentRef.addEventListener('visibilitychange', onVisibilityChange);
      schedulePoll();
      return checkNow();
    },
    stop() {
      if (!started) return;
      started = false;
      clearPoll();
      windowRef.removeEventListener('focus', onFocus);
      windowRef.removeEventListener('online', onOnline);
      documentRef.removeEventListener('visibilitychange', onVisibilityChange);
      listeners.clear();
    },
    checkNow,
    setOperationActive(active) {
      operationActive = active === true;
      if (!operationActive && pendingRelease) {
        const target = pendingRelease;
        pendingRelease = null;
        refreshTo(target);
      }
    },
  });
}
