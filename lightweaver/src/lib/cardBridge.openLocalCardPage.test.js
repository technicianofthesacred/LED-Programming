import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CARD_BRIDGE_WINDOW_NAME,
  bootstrapCardBridgeFromOpener,
  getCardBridgeState,
  acquireCardBridgeFromGesture,
  openCardBridge,
  openLocalCardPage,
  reserveCardBridgeWindow,
  retargetCardBridge,
  sendCardBridgeRequest,
} from './cardBridge.js';

// cardBridge.js keeps module-level bridge state, so each test below uses a
// distinct host and installs a fresh stubbed window (same stubbing style as
// tests/card-bridge-handoff.mjs).
function stubWindow({ openResult } = {}) {
  const opened = [];
  const values = new Map();
  const listeners = new Map();
  const win = {
    location: { search: '' },
    opener: null,
    parent: null,
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatchEvent(event) { listeners.get(event.type)?.(event); },
    open(url, name) {
      opened.push({ url, name });
      return openResult;
    },
  };
  globalThis.window = win;
  return {
    win,
    opened,
    values,
    emitMessage({ origin, source, data }) {
      listeners.get('message')?.({ origin, source, data });
    },
  };
}

function fakeCardTab() {
  let href = '';
  return {
    closed: false,
    navigationCalls: [],
    get location() {
      return {
        get href() { return href; },
        set href(value) {
          href = String(value);
        },
      };
    },
    set location(value) {
      href = String(value);
      this.navigationCalls.push(href);
    },
    focusCalls: 0,
    focus() { this.focusCalls += 1; },
    postMessageCalls: 0,
    postMessages: [],
    postMessage(message, targetOrigin) {
      this.postMessageCalls += 1;
      this.postMessages.push({ message, targetOrigin });
    },
  };
}

test('a non-local host is rejected before window.open runs', () => {
  const { opened } = stubWindow({ openResult: fakeCardTab() });
  assert.deepEqual(openLocalCardPage('evil.example.com'), { ok: false, reason: 'invalid-host' });
  assert.deepEqual(
    openLocalCardPage('lightweaver.local', { path: 'https://evil.example/' }),
    { ok: false, reason: 'invalid-host' },
    'an absolute path cannot steer the card tab off the card origin',
  );
  assert.deepEqual(
    openLocalCardPage('192.168.50.2', { path: '//evil.example/' }),
    { ok: false, reason: 'invalid-host' },
    'a protocol-relative path cannot steer the card tab off the card origin',
  );
  assert.equal(opened.length, 0);
});

test('a blocked popup reports popup-blocked so callers can show the visible copy', () => {
  const { opened } = stubWindow({ openResult: null });
  assert.deepEqual(openLocalCardPage('192.168.50.3'), { ok: false, reason: 'popup-blocked' });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].name, CARD_BRIDGE_WINDOW_NAME);
});

test('a gesture-reserved card window navigates to a discovered host without a second popup and waits for verification', async () => {
  const host = '192.168.50.83';
  const tab = fakeCardTab();
  const { opened, emitMessage } = stubWindow({ openResult: tab });
  tab.postMessage = message => {
    if (message.type !== 'firmware-info') return;
    setTimeout(() => emitMessage({
      origin: `http://${host}`,
      source: tab,
      data: {
        app: 'LightweaverCardBridge', id: message.id, ok: true, version: 2,
        response: { cardId: 'lw-discovered-83', firmwareVersion: '1.0.0', buildId: 'build-83' },
      },
    }), 0);
  };

  const reserved = reserveCardBridgeWindow();
  assert.equal(reserved, tab, 'the user gesture reserves the stable named tab');
  assert.deepEqual(opened, [{ url: '', name: CARD_BRIDGE_WINDOW_NAME }]);

  const attempt = acquireCardBridgeFromGesture(host, {
    reservedWindow: reserved,
    acceptDiscovered: true,
    timeoutMs: 100,
  });
  assert.equal(attempt.window, tab);
  assert.equal(opened.length, 1, 'the verified target reuses the gesture-reserved WindowProxy');
  assert.equal(new URL(tab.location.href).origin, `http://${host}`);

  emitMessage({
    origin: `http://${host}`,
    source: tab,
    data: { app: 'LightweaverCardBridge', type: 'ready', host, version: 2 },
  });
  const state = await attempt.ready;
  assert.equal(state.verified, true);
  assert.equal(state.discoveredCard?.id, 'lw-discovered-83');
});

test('discovery acquisition rejects a valid wrong-card identity before accepting discovered evidence', async () => {
  const host = '192.168.50.86';
  const tab = fakeCardTab();
  const { values, emitMessage } = stubWindow({ openResult: tab });
  values.set('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-expected-86' }));
  tab.postMessage = message => {
    if (message.type !== 'firmware-info') return;
    setTimeout(() => emitMessage({
      origin: `http://${host}`,
      source: tab,
      data: {
        app: 'LightweaverCardBridge', id: message.id, ok: true, version: 2,
        response: { cardId: 'lw-wrong-86', firmwareVersion: '1.0.0', buildId: 'build-wrong-86' },
      },
    }), 0);
  };

  const reserved = reserveCardBridgeWindow();
  const attempt = acquireCardBridgeFromGesture(host, {
    reservedWindow: reserved,
    acceptDiscovered: true,
    timeoutMs: 100,
  });
  emitMessage({
    origin: `http://${host}`,
    source: tab,
    data: { app: 'LightweaverCardBridge', type: 'ready', host, version: 2 },
  });

  await assert.rejects(attempt.ready, error => error?.reason === 'wrong-card');
  assert.equal(getCardBridgeState().discoveredCard?.id, 'lw-wrong-86');
  assert.equal(getCardBridgeState().identityVerified, false);
});

test('discovery acquisition re-reads identity paired after reservation before accepting the ready card', async () => {
  const host = '192.168.50.87';
  const tab = fakeCardTab();
  const { values, emitMessage } = stubWindow({ openResult: tab });
  tab.postMessage = message => {
    if (message.type !== 'firmware-info') return;
    setTimeout(() => emitMessage({
      origin: `http://${host}`,
      source: tab,
      data: {
        app: 'LightweaverCardBridge', id: message.id, ok: true, version: 2,
        response: { cardId: 'lw-found-87', firmwareVersion: '1.0.0', buildId: 'build-found-87' },
      },
    }), 0);
  };

  const reserved = reserveCardBridgeWindow();
  const attempt = acquireCardBridgeFromGesture(host, {
    reservedWindow: reserved,
    acceptDiscovered: true,
    timeoutMs: 100,
  });
  values.set('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-newly-paired-elsewhere' }));
  emitMessage({
    origin: `http://${host}`,
    source: tab,
    data: { app: 'LightweaverCardBridge', type: 'ready', host, version: 2 },
  });

  await assert.rejects(attempt.ready, error => error?.reason === 'wrong-card');
  assert.equal(getCardBridgeState().discoveredCard?.id, 'lw-found-87');
});

test('reserving the named card window revokes prior bridge command authority', async () => {
  const host = '192.168.50.84';
  const tab = fakeCardTab();
  const { values, emitMessage } = stubWindow({ openResult: tab });
  values.set('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-reserved-84' }));
  tab.postMessage = message => {
    if (message.type !== 'firmware-info') return;
    setTimeout(() => emitMessage({
      origin: `http://${host}`,
      source: tab,
      data: {
        app: 'LightweaverCardBridge', id: message.id, ok: true, version: 2,
        response: { cardId: 'lw-reserved-84', firmwareVersion: '1.0.0', buildId: 'build-84' },
      },
    }), 0);
  };
  openLocalCardPage(host);
  emitMessage({
    origin: `http://${host}`,
    source: tab,
    data: { app: 'LightweaverCardBridge', type: 'ready', host, version: 2 },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(getCardBridgeState().identityVerified, true);

  reserveCardBridgeWindow();
  assert.equal(getCardBridgeState().identityVerified, false);
  assert.equal(getCardBridgeState().verified, false);

  emitMessage({
    origin: `http://${host}`,
    source: tab,
    data: { app: 'LightweaverCardBridge', type: 'ready', host, version: 2 },
  });
  assert.equal(getCardBridgeState().verified, false,
    'a late ready from the outgoing page cannot reauthorize the blank reservation');
});

test('a reserved window closed during discovery reports bridge-closed instead of popup-blocked', async () => {
  const tab = fakeCardTab();
  stubWindow({ openResult: tab });
  const reserved = reserveCardBridgeWindow();
  tab.closed = true;
  const attempt = acquireCardBridgeFromGesture('192.168.50.85', {
    reservedWindow: reserved,
    acceptDiscovered: true,
    timeoutMs: 25,
  });
  await assert.rejects(attempt.ready, error => error?.reason === 'bridge-closed');
});

test('an ordinary card-page click opens the visible page in bridge mode for the current Studio origin', () => {
  const tab = fakeCardTab();
  const { win, opened } = stubWindow({ openResult: tab });
  win.location.href = 'https://led.mandalacodes.com/#screen=patterns';
  win.location.origin = 'https://led.mandalacodes.com';

  assert.equal(openLocalCardPage('192.168.50.30').ok, true);
  const url = new URL(opened[0].url);
  assert.equal(url.origin, 'http://192.168.50.30');
  assert.equal(url.pathname, '/');
  const fragment = new URLSearchParams(url.hash.slice(1));
  assert.equal(fragment.get('studioBridge'), '1');
  assert.equal(fragment.get('studioOrigin'), 'https://led.mandalacodes.com');
});

test('ordinary navigation persists only after paired identity and readiness are accepted', async () => {
  const tab = fakeCardTab();
  const { values, emitMessage } = stubWindow({ openResult: tab });
  values.set('lw_chip_card_host', '192.168.50.29');
  values.set('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-paired-card' }));

  assert.equal(openCardBridge('192.168.50.30'), tab);
  assert.equal(values.get('lw_chip_card_host'), '192.168.50.29');
  assert.equal(getCardBridgeState().host, '192.168.50.30', 'the in-flight target is still tracked');
  assert.equal(getCardBridgeState().verified, false);

  emitMessage({
    origin: 'http://192.168.50.30',
    source: tab,
    data: { app: 'LightweaverCardBridge', type: 'ready', host: '192.168.50.30', version: 2 },
  });
  assert.equal(values.get('lw_chip_card_host'), '192.168.50.29', 'ready alone is not accepted identity/readiness');
  const identityRequest = tab.postMessages.at(-1).message;
  emitMessage({
    origin: 'http://192.168.50.30',
    source: tab,
    data: {
      app: 'LightweaverCardBridge', id: identityRequest.id, ok: true, version: 2,
      response: { cardId: 'lw-paired-card', firmwareVersion: '1.0.0', buildId: 'build-paired' },
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(values.get('lw_chip_card_host'), '192.168.50.29', 'matching identity still waits for readiness');

  const statusPromise = sendCardBridgeRequest('status', {}, { host: '192.168.50.30', timeoutMs: 100 });
  const statusRequest = tab.postMessages.at(-1).message;
  emitMessage({
    origin: 'http://192.168.50.30',
    source: tab,
    data: {
      app: 'LightweaverCardBridge', id: statusRequest.id, ok: true, version: 2,
      response: {
        app: 'Lightweaver', provisioningContractVersion: 1,
        cardId: 'lw-paired-card', firmwareVersion: '1.0.0', buildId: 'build-paired',
        bootId: 'boot-paired', runtimePhase: 'ready', knownGoodProject: true,
        commandReady: true, outputReady: true,
      },
    },
  });
  await statusPromise;
  assert.equal(values.get('lw_chip_card_host'), '192.168.50.30');
});

test('a wrong-card identity response never persists the speculative candidate', async () => {
  const tab = fakeCardTab();
  const { values, emitMessage } = stubWindow({ openResult: tab });
  values.set('lw_chip_card_host', '192.168.50.33');
  values.set('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-expected-card' }));

  openCardBridge('192.168.50.34');
  emitMessage({
    origin: 'http://192.168.50.34', source: tab,
    data: { app: 'LightweaverCardBridge', type: 'ready', host: '192.168.50.34', version: 2 },
  });
  const identityRequest = tab.postMessages.at(-1).message;
  emitMessage({
    origin: 'http://192.168.50.34', source: tab,
    data: {
      app: 'LightweaverCardBridge', id: identityRequest.id, ok: true, version: 2,
      response: { cardId: 'lw-wrong-card', firmwareVersion: '1.0.0', buildId: 'build-wrong' },
    },
  });
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(values.get('lw_chip_card_host'), '192.168.50.33');
  assert.equal(getCardBridgeState().identityError, 'wrong-card');
});

test('bridge launch parameters preserve an existing card-installer payload', () => {
  const tab = fakeCardTab();
  const { win, opened } = stubWindow({ openResult: tab });
  win.location.href = 'https://led.mandalacodes.com/#screen=patterns';
  win.location.origin = 'https://led.mandalacodes.com';

  assert.equal(openLocalCardPage('192.168.50.32', {
    path: '/#lwconfig=YWJj&reboot=1',
    reason: 'card-installer',
  }).ok, true);
  const fragment = new URLSearchParams(new URL(opened[0].url).hash.slice(1));
  assert.equal(fragment.get('lwconfig'), 'YWJj');
  assert.equal(fragment.get('reboot'), '1');
  assert.equal(fragment.get('studioBridge'), '1');
  assert.equal(fragment.get('studioOrigin'), 'https://led.mandalacodes.com');
});

test('a blocked repeat click reuses the tracked card window without revoking its lifecycle', () => {
  const tab = fakeCardTab();
  const { win } = stubWindow({ openResult: null });
  win.location.search = '?cardBridge=1&cardHost=192.168.50.31';
  win.parent = tab;
  assert.equal(bootstrapCardBridgeFromOpener(), true);
  const lifecycle = getCardBridgeState().lifecycle;

  const repeated = openLocalCardPage('192.168.50.31');
  assert.equal(repeated.ok, true);
  assert.equal(repeated.window, tab);
  assert.equal(getCardBridgeState().lifecycle, lifecycle);
  assert.equal(tab.focusCalls, 1);

  assert.equal(openCardBridge('192.168.50.31'), tab,
    'pattern-click acquisition reuses the same surviving bridge target');
  assert.equal(getCardBridgeState().lifecycle, lifecycle);
  assert.equal(tab.focusCalls, 2);
});

test('repeat visits reuse the one named card tab, same handle, and focus it', () => {
  const tab = fakeCardTab();
  const { opened } = stubWindow({ openResult: tab });

  const first = openLocalCardPage('192.168.50.4');
  assert.equal(first.ok, true);
  assert.equal(first.window, tab);
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0], { url: 'http://192.168.50.4/#studioBridge=1', name: CARD_BRIDGE_WINDOW_NAME });
  const firstLifecycle = getCardBridgeState().lifecycle;

  const second = openLocalCardPage('192.168.50.4', { path: '/settings', reason: 'open-card-page' });
  assert.equal(second.ok, true);
  assert.equal(second.window, first.window, 'the same named window handle is reused');
  assert.equal(opened.length, 2);
  assert.deepEqual(opened[1], { url: 'http://192.168.50.4/settings#studioBridge=1', name: CARD_BRIDGE_WINDOW_NAME });
  assert.equal(tab.focusCalls, 2, 'an already-open tab is focused');
  assert.ok(getCardBridgeState().lifecycle > firstLifecycle,
    'same-window same-host navigation starts a new revoked lifecycle');
});

test('a newly opened card page never grants command authority before its handshake', async () => {
  const tab = fakeCardTab();
  stubWindow({ openResult: tab });

  assert.equal(openLocalCardPage('192.168.50.5').ok, true);
  const state = getCardBridgeState();
  assert.equal(state.open, true, 'the named tab is tracked');
  assert.equal(state.host, '192.168.50.5');
  assert.equal(state.verified, false, 'the launch fragment alone is not transport readiness');
  assert.equal(state.identityVerified, false);

  await assert.rejects(
    sendCardBridgeRequest('control', { patternId: 'fire' }, { host: '192.168.50.5', timeoutMs: 25 }),
    error => error?.reason === 'identity-missing',
    'privileged sends stay locked until the new page performs its verified handshake',
  );
  assert.equal(tab.postMessageCalls, 0, 'no privileged message reaches the plain card page');
});

test('an empty host falls back to the stored local card host', () => {
  const tab = fakeCardTab();
  const { opened, values } = stubWindow({ openResult: tab });
  values.set('lw_chip_card_host', '192.168.50.6');
  assert.equal(openLocalCardPage().ok, true);
  assert.deepEqual(opened[0], { url: 'http://192.168.50.6/#studioBridge=1', name: CARD_BRIDGE_WINDOW_NAME });
});

const handoffCorrelation = Object.freeze({
  host: '192.168.50.40',
  expectedCardId: 'lw-b0fe81f61b44',
  expectedFirmwareVersion: '1.0.0',
  expectedBuildId: 'build-exact-123',
  expectedBootId: 'boot-current',
  handoffGeneration: 4,
});
const handoffFlowId = 'flow-open-local-card-1234';

test('retarget reuses the tracked WindowProxy, revokes AP state, and rejects pending AP requests', async () => {
  const tab = fakeCardTab();
  const snapshots = [];
  let href = '';
  Object.defineProperty(tab, 'location', {
    configurable: true,
    value: {
      get href() { return href; },
      set href(value) {
        snapshots.push(getCardBridgeState());
        href = String(value);
      },
    },
  });
  const { opened, values } = stubWindow({ openResult: tab });
  window.location.href = 'https://led.mandalacodes.com/#screen=production';
  window.location.origin = 'https://led.mandalacodes.com';

  assert.equal(openLocalCardPage('192.168.4.1').ok, true);
  const pendingAp = sendCardBridgeRequest('status', {}, {
    host: '192.168.4.1',
    timeoutMs: 1000,
    retryOnTimeout: false,
  });
  const pendingResult = pendingAp.catch(error => error);

  const result = retargetCardBridge(handoffCorrelation.host, handoffCorrelation, { flowId: handoffFlowId });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'retargeted');
  assert.equal(result.window, tab, 'the same tracked WindowProxy is navigated');
  assert.equal(opened.length, 1, 'retarget never calls window.open again');
  assert.equal((await pendingResult).reason, 'bridge-retargeted', 'pending AP work is rejected');
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].verified, false, 'readiness is revoked before navigation assignment');
  assert.equal(snapshots[0].card, null, 'identity is revoked before navigation assignment');
  assert.equal(snapshots[0].host, handoffCorrelation.host);
  assert.notEqual(values.get('lw_chip_card_host'), handoffCorrelation.host,
    'retarget alone cannot persist a station host before final verification');

  const target = new URL(href);
  assert.equal(target.origin, `http://${handoffCorrelation.host}`);
  assert.equal(target.pathname, '/');
  assert.equal(target.search, '');
  const fragment = new URLSearchParams(target.hash.slice(1));
  assert.deepEqual([...fragment.keys()].sort(), [
    'expectedBootId',
    'expectedCardId',
    'studioBridge',
    'studioOrigin',
    'wifiHandoff',
  ]);
  assert.equal(fragment.get('studioBridge'), '1');
  assert.equal(fragment.get('wifiHandoff'), '4');
  assert.equal(fragment.get('expectedCardId'), handoffCorrelation.expectedCardId);
  assert.equal(fragment.get('expectedBootId'), handoffCorrelation.expectedBootId);
  assert.equal(fragment.get('studioOrigin'), 'https://led.mandalacodes.com');
  assert.equal(href.includes('password'), false);
  assert.equal(href.includes('screen=production'), false);
});

test('retarget reports retryable missing and closed WindowProxy states', () => {
  stubWindow({ openResult: null });
  assert.deepEqual(
    retargetCardBridge(handoffCorrelation.host, handoffCorrelation, { flowId: handoffFlowId }),
    { ok: false, state: 'missing-window', reason: 'bridge-missing', retryable: true },
  );

  const closedTab = fakeCardTab();
  closedTab.closed = true;
  stubWindow({ openResult: closedTab });
  openLocalCardPage('192.168.4.1');
  assert.deepEqual(
    retargetCardBridge(handoffCorrelation.host, handoffCorrelation, { flowId: handoffFlowId }),
    { ok: false, state: 'closed-window', reason: 'bridge-closed', retryable: true },
  );
});

test('same correlation can retry through one WindowProxy while stale or changed duplicates gain no authority', () => {
  const tab = fakeCardTab();
  let assignments = 0;
  Object.defineProperty(tab, 'location', {
    configurable: true,
    value: {
      set href(_) { assignments += 1; },
    },
  });
  const { opened } = stubWindow({ openResult: tab });
  window.location.href = 'https://led.mandalacodes.com/';
  window.location.origin = 'https://led.mandalacodes.com';
  openLocalCardPage('192.168.4.1');

  assert.equal(retargetCardBridge(handoffCorrelation.host, handoffCorrelation, { flowId: handoffFlowId }).ok, true);
  const lifecycle = getCardBridgeState().lifecycle;
  const retry = retargetCardBridge(handoffCorrelation.host, handoffCorrelation, { flowId: handoffFlowId });
  assert.equal(retry.ok, true);
  assert.equal(retry.repeated, true);
  assert.ok(getCardBridgeState().lifecycle > lifecycle,
    'retry navigation revokes the prior page lifecycle without changing correlation authority');
  assert.equal(assignments, 2, 'the same proxy can retry navigation after the network switch');
  assert.equal(opened.length, 1);

  const stale = retargetCardBridge(handoffCorrelation.host, {
    ...handoffCorrelation,
    handoffGeneration: 3,
  }, { flowId: handoffFlowId });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale-correlation');
  const changedDuplicate = retargetCardBridge(handoffCorrelation.host, {
    ...handoffCorrelation,
    expectedBootId: 'boot-other',
  }, { flowId: handoffFlowId });
  assert.equal(changedDuplicate.ok, false);
  assert.equal(changedDuplicate.reason, 'stale-correlation');
  assert.equal(assignments, 2, 'rejected correlations cannot navigate the bridge');
});
