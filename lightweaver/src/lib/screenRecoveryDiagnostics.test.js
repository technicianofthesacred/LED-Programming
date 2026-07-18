import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCREEN_FAILURE_CODES,
  SCREEN_FAILURE_STORAGE_KEY,
  clearScreenFailure,
  readScreenFailure,
  rememberScreenFailure,
} from './screenRecoveryDiagnostics.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

function fakeHistory() {
  const history = {
    state: null,
    replaceState(nextState) { history.state = nextState; },
  };
  return history;
}

function brokenStorage() {
  return {
    getItem: () => { throw new Error('storage unavailable'); },
    setItem: () => { throw new Error('storage unavailable'); },
    removeItem: () => { throw new Error('storage unavailable'); },
  };
}

test('first failure on a route records LW-UI-101 with a sanitized payload', () => {
  const storage = memoryStorage();
  const history = fakeHistory();
  const error = new TypeError('secret project data: {"name":"Adrian"}');
  const record = rememberScreenFailure(
    { error, route: '#screen=pattern', phase: 'initial' },
    { storage, history, now: 1234 },
  );

  assert.deepEqual(record, {
    code: SCREEN_FAILURE_CODES.FIRST_FAILURE,
    route: '#screen=pattern',
    errorName: 'TypeError',
    at: 1234,
  });
  assert.deepEqual(readScreenFailure({ storage, history }), record);

  const raw = storage.getItem(SCREEN_FAILURE_STORAGE_KEY);
  assert.ok(raw, 'record persisted to session storage');
  assert.ok(!raw.includes('secret'), 'error message must never be stored');
  assert.ok(!raw.includes('Adrian'), 'project data must never be stored');
  assert.ok(!raw.includes('stack'), 'stacks must never be stored');
});

test('post-reload or repeated failures record LW-UI-102', () => {
  const storage = memoryStorage();
  const history = fakeHistory();

  const explicit = rememberScreenFailure(
    { error: new Error('x'), route: '#screen=pattern', phase: 'post-reload' },
    { storage, history, now: 1 },
  );
  assert.equal(explicit.code, SCREEN_FAILURE_CODES.REPEAT_FAILURE);

  clearScreenFailure({ storage, history });
  rememberScreenFailure({ error: new Error('x'), route: '#screen=pattern' }, { storage, history, now: 2 });
  const repeat = rememberScreenFailure({ error: new Error('x'), route: '#screen=pattern' }, { storage, history, now: 3 });
  assert.equal(repeat.code, SCREEN_FAILURE_CODES.REPEAT_FAILURE, 'same route again is a repeat');

  const otherRoute = rememberScreenFailure({ error: new Error('x'), route: '#screen=show' }, { storage, history, now: 4 });
  assert.equal(otherRoute.code, SCREEN_FAILURE_CODES.FIRST_FAILURE, 'a different route starts over at 101');
});

test('save-blocked failures record LW-UI-103', () => {
  const storage = memoryStorage();
  const history = fakeHistory();
  const record = rememberScreenFailure(
    { error: new Error('quota'), route: '#screen=layout', phase: 'save-blocked' },
    { storage, history, now: 9 },
  );
  assert.equal(record.code, SCREEN_FAILURE_CODES.SAVE_BLOCKED);
  assert.equal(readScreenFailure({ storage, history }).code, 'LW-UI-103');
});

test('falls back to history.state when session storage is unavailable', () => {
  const history = fakeHistory();
  const record = rememberScreenFailure(
    { error: new RangeError('boom'), route: '#screen=card' },
    { storage: brokenStorage(), history, now: 55 },
  );
  assert.equal(record.errorName, 'RangeError');
  assert.deepEqual(history.state[SCREEN_FAILURE_STORAGE_KEY], record);
  assert.deepEqual(readScreenFailure({ storage: brokenStorage(), history }), record);

  clearScreenFailure({ storage: brokenStorage(), history });
  assert.equal(readScreenFailure({ storage: brokenStorage(), history }), null);
});

test('degrades gracefully with no storage and no history at all', () => {
  const record = rememberScreenFailure(
    { error: new Error('x'), route: '#screen=layout' },
    { storage: null, history: null, now: 5 },
  );
  assert.equal(record.code, SCREEN_FAILURE_CODES.FIRST_FAILURE);
  assert.equal(readScreenFailure({ storage: null, history: null }), null);
  assert.doesNotThrow(() => clearScreenFailure({ storage: null, history: null }));
});

test('clearScreenFailure removes both copies and corrupt records read as null', () => {
  const storage = memoryStorage();
  const history = fakeHistory();
  rememberScreenFailure({ error: new Error('x'), route: '#a' }, { storage, history, now: 1 });
  clearScreenFailure({ storage, history });
  assert.equal(readScreenFailure({ storage, history }), null);
  assert.equal(storage.getItem(SCREEN_FAILURE_STORAGE_KEY), null);

  storage.setItem(SCREEN_FAILURE_STORAGE_KEY, '{not json');
  assert.equal(readScreenFailure({ storage, history }), null);
  storage.setItem(SCREEN_FAILURE_STORAGE_KEY, JSON.stringify({ code: 'NOT-A-CODE', at: 1 }));
  assert.equal(readScreenFailure({ storage, history }), null);
});

test('non-error inputs still produce a safe errorName', () => {
  const storage = memoryStorage();
  const history = fakeHistory();
  const record = rememberScreenFailure({ error: 'a plain string', route: '#r' }, { storage, history, now: 2 });
  assert.equal(record.errorName, 'Error');
  const missing = rememberScreenFailure({ route: '#r2' }, { storage, history, now: 3 });
  assert.equal(missing.errorName, 'Error');
});
