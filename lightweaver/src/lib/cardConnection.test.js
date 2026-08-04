import assert from 'node:assert/strict';
import test from 'node:test';

import * as cardConnection from './cardConnection.js';

function fakeBrowser(search, storedHost = cardConnection.DEFAULT_CARD_HOST) {
  const values = new Map([[cardConnection.CARD_HOST_STORAGE_KEY, storedHost]]);
  const events = [];
  return {
    events,
    window: {
      location: { search },
      localStorage: {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, String(value)),
      },
      dispatchEvent: event => events.push(event),
    },
  };
}

async function withFakeBrowser(browser, run) {
  const previousWindow = globalThis.window;
  const previousCustomEvent = globalThis.CustomEvent;
  globalThis.window = browser.window;
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  };
  try {
    await run();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousCustomEvent === undefined) delete globalThis.CustomEvent;
    else globalThis.CustomEvent = previousCustomEvent;
  }
}

test('ordinary recovery leaves a stale literal address for the paired stable hostname', () => {
  assert.equal(typeof cardConnection.ordinaryCardRecoveryHost, 'function');
  assert.equal(cardConnection.ordinaryCardRecoveryHost('192.168.18.70', {
    id: 'lw-gallery',
    hostname: 'gallery-card.local',
    address: '192.168.18.70',
  }), 'gallery-card.local');
  assert.equal(cardConnection.ordinaryCardRecoveryHost('gallery-card.local', {
    id: 'lw-gallery',
    hostname: 'gallery-card.local',
    address: '192.168.18.70',
  }), 'gallery-card.local');
  assert.equal(cardConnection.ordinaryCardRecoveryHost('192.168.18.70', {
    id: 'lw-gallery',
    hostname: 'card.example.com',
    address: '192.168.18.70',
  }), 'lightweaver.local');
});

test('URL bootstrap adopts a private card IP before mDNS and dispatches one host change', async () => {
  const browser = fakeBrowser('?cardBridge=1&cardHost=192.168.18.70');
  await withFakeBrowser(browser, () => {
    assert.equal(cardConnection.bootstrapCardHostFromLocation(), '192.168.18.70');
    assert.equal(cardConnection.readStoredCardHost(), '192.168.18.70');
    assert.deepEqual(cardConnection.readStoredCardHostHistory(), ['192.168.18.70']);
    assert.deepEqual(browser.events.map(event => ({ type: event.type, detail: event.detail })), [{
      type: cardConnection.CARD_HOST_CHANGED_EVENT,
      detail: { host: '192.168.18.70' },
    }]);
    assert.equal(cardConnection.bootstrapCardHostFromLocation(), '192.168.18.70');
    assert.equal(browser.events.length, 1);
  });
});

test('URL bootstrap rejects a public card host and preserves the stored local host', async () => {
  const browser = fakeBrowser('?cardHost=card.attacker.example');
  await withFakeBrowser(browser, () => {
    assert.equal(cardConnection.bootstrapCardHostFromLocation(), cardConnection.DEFAULT_CARD_HOST);
    assert.equal(cardConnection.readStoredCardHost(), cardConnection.DEFAULT_CARD_HOST);
    assert.deepEqual(cardConnection.readStoredCardHostHistory(), []);
    assert.equal(browser.events.length, 0);
  });
});
