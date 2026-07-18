// Sanitized screen-failure diagnostics for the recovery screen.
//
// The ScreenErrorBoundary reload marker (`lw_screen_recovery_v1` in
// src/v3/app.jsx) only prevents reload loops — the error itself is lost across
// the automatic reload, so the recovery screen has nothing to show a helper.
// This module persists a deliberately tiny, sanitized record the shell can
// surface as a support code:
//
//   { code, route, errorName, at }
//
// Codes:
//   LW-UI-101 — first failure on a route
//   LW-UI-102 — failure after the automatic reload (or a repeat on the route)
//   LW-UI-103 — save-blocked: the pre-reload safety copy could not be written
//
// PRIVACY RULE: never store error.message, stacks, or project data. Only the
// error's constructor/name (`error.name`) is kept, so a support code can say
// "TypeError on #screen=pattern" without ever capturing what was typed into
// the project.
//
// Storage: sessionStorage first, mirrored into history.state so the record
// survives when browser storage is unavailable (same fallback strategy as the
// existing reload marker). All storage access is best-effort try/catch.

export const SCREEN_FAILURE_STORAGE_KEY = 'lw_screen_failure_v1';

export const SCREEN_FAILURE_CODES = {
  FIRST_FAILURE: 'LW-UI-101',
  REPEAT_FAILURE: 'LW-UI-102',
  SAVE_BLOCKED: 'LW-UI-103',
};

function defaultSessionStorage() {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) return window.sessionStorage;
  } catch {
    // Storage access itself can throw (e.g. blocked third-party context).
  }
  return null;
}

function defaultHistory() {
  try {
    if (typeof window !== 'undefined' && window.history) return window.history;
  } catch {
    // Ignore — the caller degrades to in-memory only.
  }
  return null;
}

function resolveStores(options = {}) {
  return {
    storage: 'storage' in options ? options.storage : defaultSessionStorage(),
    history: 'history' in options ? options.history : defaultHistory(),
  };
}

function sanitizeRecord(value) {
  if (!value || typeof value !== 'object') return null;
  const code = String(value.code || '');
  if (!/^LW-UI-\d{3}$/.test(code)) return null;
  const at = Number(value.at);
  if (!Number.isFinite(at)) return null;
  return {
    code,
    route: String(value.route || '').slice(0, 256),
    errorName: String(value.errorName || 'Error').slice(0, 64),
    at,
  };
}

function sanitizeErrorName(error) {
  const name = error && typeof error.name === 'string' ? error.name.trim() : '';
  // Only the constructor-style name, never message content.
  return (name || 'Error').slice(0, 64);
}

function defaultRoute(route) {
  if (typeof route === 'string') return route.slice(0, 256);
  try {
    if (typeof window !== 'undefined' && window.location) return String(window.location.hash || '').slice(0, 256);
  } catch {
    // Fall through.
  }
  return '';
}

export function readScreenFailure(options = {}) {
  const { storage, history } = resolveStores(options);
  try {
    const raw = storage?.getItem(SCREEN_FAILURE_STORAGE_KEY);
    if (raw) {
      const record = sanitizeRecord(JSON.parse(raw));
      if (record) return record;
    }
  } catch {
    // Fall through to navigation state.
  }
  try {
    return sanitizeRecord(history?.state?.[SCREEN_FAILURE_STORAGE_KEY]);
  } catch {
    return null;
  }
}

export function rememberScreenFailure({ error, route, phase } = {}, options = {}) {
  const { storage, history } = resolveStores(options);
  const at = Number.isFinite(options.now) ? options.now : Date.now();
  const resolvedRoute = defaultRoute(route);
  const previous = readScreenFailure(options);

  let code = SCREEN_FAILURE_CODES.FIRST_FAILURE;
  if (phase === 'save-blocked') {
    code = SCREEN_FAILURE_CODES.SAVE_BLOCKED;
  } else if (
    phase === 'post-reload' ||
    phase === 'repeat' ||
    (previous && previous.route === resolvedRoute)
  ) {
    code = SCREEN_FAILURE_CODES.REPEAT_FAILURE;
  }

  const record = { code, route: resolvedRoute, errorName: sanitizeErrorName(error), at };

  try {
    storage?.setItem(SCREEN_FAILURE_STORAGE_KEY, JSON.stringify(record));
  } catch {
    // history.state mirror below still carries the record.
  }
  try {
    history?.replaceState?.({ ...(history.state || {}), [SCREEN_FAILURE_STORAGE_KEY]: record }, '');
  } catch {
    // Best effort — sessionStorage above is enough in supported browsers.
  }
  return record;
}

export function clearScreenFailure(options = {}) {
  const { storage, history } = resolveStores(options);
  try {
    storage?.removeItem(SCREEN_FAILURE_STORAGE_KEY);
  } catch {
    // Nothing else required when storage is unavailable.
  }
  try {
    if (history?.replaceState && history.state && SCREEN_FAILURE_STORAGE_KEY in history.state) {
      const nextState = { ...history.state };
      delete nextState[SCREEN_FAILURE_STORAGE_KEY];
      history.replaceState(nextState, '');
    }
  } catch {
    // Nothing else required when navigation state is unavailable.
  }
}
