import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CARD_BRIDGE_WINDOW_NAME,
  getCardBridgeState,
  openLocalCardPage,
  retargetCardBridge,
  sendCardBridgeRequest,
} from './cardBridge.js';

// cardBridge.js keeps module-level bridge state, so each test below uses a
// distinct host and installs a fresh stubbed window (same stubbing style as
// tests/card-bridge-handoff.mjs).
function stubWindow({ openResult } = {}) {
  const opened = [];
  const values = new Map();
  const win = {
    location: { search: '' },
    opener: null,
    parent: null,
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    open(url, name) {
      opened.push({ url, name });
      return openResult;
    },
  };
  globalThis.window = win;
  return { win, opened, values };
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
    postMessage() { this.postMessageCalls += 1; },
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

test('repeat visits reuse the one named card tab, same handle, and focus it', () => {
  const tab = fakeCardTab();
  const { opened } = stubWindow({ openResult: tab });

  const first = openLocalCardPage('192.168.50.4');
  assert.equal(first.ok, true);
  assert.equal(first.window, tab);
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0], { url: 'http://192.168.50.4/', name: CARD_BRIDGE_WINDOW_NAME });

  const second = openLocalCardPage('192.168.50.4', { path: '/settings', reason: 'open-card-page' });
  assert.equal(second.ok, true);
  assert.equal(second.window, first.window, 'the same named window handle is reused');
  assert.equal(opened.length, 2);
  assert.deepEqual(opened[1], { url: 'http://192.168.50.4/settings', name: CARD_BRIDGE_WINDOW_NAME });
  assert.equal(tab.focusCalls, 2, 'an already-open tab is focused');
});

test('a plain card-page visit never grants bridge verification or command authority', async () => {
  const tab = fakeCardTab();
  stubWindow({ openResult: tab });

  assert.equal(openLocalCardPage('192.168.50.5').ok, true);
  const state = getCardBridgeState();
  assert.equal(state.open, true, 'the named tab is tracked');
  assert.equal(state.host, '192.168.50.5');
  assert.equal(state.verified, false, 'no handshake means no transport readiness');
  assert.equal(state.identityVerified, false);

  await assert.rejects(
    sendCardBridgeRequest('control', { patternId: 'fire' }, { host: '192.168.50.5', timeoutMs: 25 }),
    error => error?.reason === 'identity-missing',
    'privileged sends stay locked until a fresh verified handshake',
  );
  assert.equal(tab.postMessageCalls, 0, 'no privileged message reaches the plain card page');
});

test('an empty host falls back to the stored local card host', () => {
  const tab = fakeCardTab();
  const { opened, values } = stubWindow({ openResult: tab });
  values.set('lw_chip_card_host', '192.168.50.6');
  assert.equal(openLocalCardPage().ok, true);
  assert.deepEqual(opened[0], { url: 'http://192.168.50.6/', name: CARD_BRIDGE_WINDOW_NAME });
});

const handoffCorrelation = Object.freeze({
  host: '192.168.50.40',
  expectedCardId: 'lw-b0fe81f61b44',
  expectedFirmwareVersion: '1.0.0',
  expectedBuildId: 'build-exact-123',
  expectedBootId: 'boot-current',
  handoffGeneration: 4,
});

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

  const result = retargetCardBridge(handoffCorrelation.host, handoffCorrelation);
  assert.equal(result.ok, true);
  assert.equal(result.state, 'retargeted');
  assert.equal(result.window, tab, 'the same tracked WindowProxy is navigated');
  assert.equal(opened.length, 1, 'retarget never calls window.open again');
  assert.equal((await pendingResult).reason, 'bridge-retargeted', 'pending AP work is rejected');
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].verified, false, 'readiness is revoked before navigation assignment');
  assert.equal(snapshots[0].card, null, 'identity is revoked before navigation assignment');
  assert.equal(snapshots[0].host, handoffCorrelation.host);
  assert.equal(values.get('lw_chip_card_host'), handoffCorrelation.host,
    'the validated station target becomes the stored host');

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
    retargetCardBridge(handoffCorrelation.host, handoffCorrelation),
    { ok: false, state: 'missing-window', reason: 'bridge-missing', retryable: true },
  );

  const closedTab = fakeCardTab();
  closedTab.closed = true;
  stubWindow({ openResult: closedTab });
  openLocalCardPage('192.168.4.1');
  assert.deepEqual(
    retargetCardBridge(handoffCorrelation.host, handoffCorrelation),
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

  assert.equal(retargetCardBridge(handoffCorrelation.host, handoffCorrelation).ok, true);
  const lifecycle = getCardBridgeState().lifecycle;
  const retry = retargetCardBridge(handoffCorrelation.host, handoffCorrelation);
  assert.equal(retry.ok, true);
  assert.equal(retry.repeated, true);
  assert.equal(getCardBridgeState().lifecycle, lifecycle,
    'retrying the same authority does not create another lifecycle');
  assert.equal(assignments, 2, 'the same proxy can retry navigation after the network switch');
  assert.equal(opened.length, 1);

  const stale = retargetCardBridge(handoffCorrelation.host, {
    ...handoffCorrelation,
    handoffGeneration: 3,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale-correlation');
  const changedDuplicate = retargetCardBridge(handoffCorrelation.host, {
    ...handoffCorrelation,
    expectedBootId: 'boot-other',
  });
  assert.equal(changedDuplicate.ok, false);
  assert.equal(changedDuplicate.reason, 'stale-correlation');
  assert.equal(assignments, 2, 'rejected correlations cannot navigate the bridge');
});
