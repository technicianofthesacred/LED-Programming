import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_FLOW_INTENTS,
  OPEN_CONNECT_PANEL_EVENT,
  openCardFlow,
  resolveCardIntent,
} from './cardFlowEntry.js';

// Three representative derived states. The lifecycle shapes mirror
// deriveCardLifecycle's output; the journeys mirror deriveSetupJourney's.
const READY = {
  lifecycle: { state: 'ready', commandReady: true, setupTaskId: 'open-patterns' },
  journey: { taskId: 'open-patterns', blockers: [], setupComplete: true },
};
const DISCONNECTED = {
  lifecycle: { state: 'disconnected', commandReady: false, setupTaskId: 'connect-card' },
  journey: { taskId: 'connect-card', blockers: [{ id: 'connect-card', phaseId: 'connect' }], setupComplete: false },
};
const NEEDS_PROJECT = {
  lifecycle: { state: 'setup-required', commandReady: false, setupTaskId: 'install-project' },
  journey: { taskId: 'install-project', blockers: [{ id: 'install-project', phaseId: 'connect' }], setupComplete: false },
};

const SETUP_TASK = task => `#screen=card&section=setup&task=${task}`;

// The golden table: every intent, in every representative state.
const GOLDEN = {
  connect: {
    ready: { action: 'proceed' },
    disconnected: { action: 'connect-panel', connectIntent: 'connect-card' },
    needsProject: { action: 'route', hash: SETUP_TASK('install-project') },
  },
  fix: {
    ready: { action: 'route', hash: SETUP_TASK('open-patterns') },
    disconnected: { action: 'route', hash: SETUP_TASK('connect-card') },
    needsProject: { action: 'route', hash: SETUP_TASK('install-project') },
  },
  'adopt-project': {
    ready: { action: 'route', hash: SETUP_TASK('load-matching-project') },
    disconnected: { action: 'route', hash: SETUP_TASK('load-matching-project') },
    needsProject: { action: 'route', hash: SETUP_TASK('load-matching-project') },
  },
  push: {
    ready: { action: 'proceed' },
    disconnected: { action: 'route', hash: SETUP_TASK('connect-card') },
    needsProject: { action: 'route', hash: SETUP_TASK('install-project') },
  },
  'update-firmware': {
    ready: { action: 'route', hash: '#screen=card&section=install' },
    disconnected: { action: 'route', hash: '#screen=card&section=install' },
    needsProject: { action: 'route', hash: '#screen=card&section=install' },
  },
  'install-project': {
    ready: { action: 'route', hash: '#screen=card&section=install' },
    disconnected: { action: 'route', hash: '#screen=card&section=install' },
    needsProject: { action: 'route', hash: '#screen=card&section=install' },
  },
  'configure-wifi': {
    ready: { action: 'route', hash: '#screen=card&section=install' },
    disconnected: { action: 'route', hash: '#screen=card&section=install' },
    needsProject: { action: 'route', hash: '#screen=card&section=install' },
  },
  'discover-strips': {
    ready: { action: 'route', hash: '#screen=discovery' },
    disconnected: { action: 'route', hash: '#screen=discovery' },
    needsProject: { action: 'route', hash: '#screen=discovery' },
  },
  'recover-lights': {
    ready: { action: 'route', hash: SETUP_TASK('recover-operation') },
    disconnected: { action: 'route', hash: SETUP_TASK('recover-operation') },
    needsProject: { action: 'route', hash: SETUP_TASK('recover-operation') },
  },
  'recover-operation': {
    ready: { action: 'route', hash: SETUP_TASK('recover-operation') },
    disconnected: { action: 'route', hash: SETUP_TASK('recover-operation') },
    needsProject: { action: 'route', hash: SETUP_TASK('recover-operation') },
  },
  'edit-on-card': {
    ready: { action: 'route', hash: '#screen=card&section=overview' },
    disconnected: { action: 'route', hash: '#screen=card&section=overview' },
    needsProject: { action: 'route', hash: '#screen=card&section=overview' },
  },
  batch: {
    ready: { action: 'route', hash: '#screen=card&section=workshop' },
    disconnected: { action: 'route', hash: '#screen=card&section=workshop' },
    needsProject: { action: 'route', hash: '#screen=card&section=workshop' },
  },
};

test('the golden table covers exactly the published intent vocabulary', () => {
  assert.deepEqual(Object.keys(GOLDEN).sort(), [...CARD_FLOW_INTENTS].sort());
});

test('every intent resolves the golden table in every representative state', () => {
  for (const intent of CARD_FLOW_INTENTS) {
    assert.deepEqual(resolveCardIntent(intent, READY), GOLDEN[intent].ready, `${intent} × ready`);
    assert.deepEqual(resolveCardIntent(intent, DISCONNECTED), GOLDEN[intent].disconnected, `${intent} × disconnected`);
    assert.deepEqual(resolveCardIntent(intent, NEEDS_PROJECT), GOLDEN[intent].needsProject, `${intent} × needs-project`);
  }
});

test('a connected card with a project question never re-opens the connect panel', () => {
  // The loop-breaker pin. A connected exact card whose remaining work is
  // load-matching-project is a PROJECT question; sending it back to the
  // Connection Center is the "Find my card" ping-pong (see setupJourney.js).
  const context = {
    lifecycle: { state: 'project-mismatch', commandReady: true, setupTaskId: 'load-matching-project' },
    journey: { taskId: 'load-matching-project', blockers: [], setupComplete: false },
  };
  const connect = resolveCardIntent('connect', context);
  const fix = resolveCardIntent('fix', context);
  assert.notEqual(connect.action, 'connect-panel');
  assert.notEqual(fix.action, 'connect-panel');
  assert.deepEqual(connect, { action: 'route', hash: SETUP_TASK('load-matching-project') });
  assert.deepEqual(fix, { action: 'route', hash: SETUP_TASK('load-matching-project') });
});

test('a caller with no derived state gets the connect panel, matching the footer chip it replaced', () => {
  assert.deepEqual(resolveCardIntent('connect', {}), { action: 'connect-panel', connectIntent: 'connect-card' });
  assert.deepEqual(resolveCardIntent('connect'), { action: 'connect-panel', connectIntent: 'connect-card' });
  // fix with nothing derived still lands on the Setup front door.
  assert.deepEqual(resolveCardIntent('fix', {}), { action: 'route', hash: '#screen=card&section=setup' });
});

test('an unknown intent throws instead of guessing a destination', () => {
  assert.throws(() => resolveCardIntent('reboot'), /Unknown card flow intent/);
  assert.throws(() => resolveCardIntent(''), /Unknown card flow intent/);
  assert.throws(() => resolveCardIntent(undefined), /Unknown card flow intent/);
});

test('openCardFlow executes the resolution and always returns it', () => {
  const originalWindow = globalThis.window;
  const originalCustomEvent = globalThis.CustomEvent;
  const dispatched = [];
  globalThis.CustomEvent = class {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  };
  globalThis.window = {
    location: { hash: '#screen=pattern' },
    dispatchEvent: event => { dispatched.push(event); return true; },
  };
  try {
    const routed = openCardFlow('fix', DISCONNECTED);
    assert.deepEqual(routed, { action: 'route', hash: SETUP_TASK('connect-card') });
    assert.equal(globalThis.window.location.hash, SETUP_TASK('connect-card'));
    assert.equal(dispatched.length, 0);

    const panel = openCardFlow('connect', DISCONNECTED);
    assert.deepEqual(panel, { action: 'connect-panel', connectIntent: 'connect-card' });
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].type, OPEN_CONNECT_PANEL_EVENT);
    assert.deepEqual(dispatched[0].detail, { connectIntent: 'connect-card' });
    // The panel opens without moving the URL.
    assert.equal(globalThis.window.location.hash, SETUP_TASK('connect-card'));

    globalThis.window.location.hash = '#screen=pattern';
    const proceeded = openCardFlow('push', READY);
    assert.deepEqual(proceeded, { action: 'proceed' });
    assert.equal(globalThis.window.location.hash, '#screen=pattern');
    assert.equal(dispatched.length, 1);
  } finally {
    globalThis.window = originalWindow;
    globalThis.CustomEvent = originalCustomEvent;
  }
});
