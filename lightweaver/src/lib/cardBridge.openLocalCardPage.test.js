import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CARD_BRIDGE_WINDOW_NAME,
  getCardBridgeState,
  openLocalCardPage,
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
  return {
    closed: false,
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
