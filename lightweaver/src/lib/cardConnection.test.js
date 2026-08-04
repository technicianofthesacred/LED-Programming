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
    assert.deepEqual(cardConnection.candidateCardHosts('', {
      id: 'lw-gallery',
      hostname: 'lightweaver.local',
      address: '192.168.4.1',
    }).slice(0, 3), [
      '192.168.18.70',
      'lightweaver.local',
      '192.168.4.1',
    ]);
    assert.equal(cardConnection.bootstrapCardHostFromLocation(), '192.168.18.70');
    assert.equal(browser.events.length, 1);
  });
});

test('a stalled URL card hint gets only a bounded head start before mDNS fallback', async () => {
  const browser = fakeBrowser('?cardHost=192.168.18.70');
  await withFakeBrowser(browser, async () => {
    cardConnection.bootstrapCardHostFromLocation();
    const startedAt = Date.now();
    const requested = [];
    const found = await cardConnection.discoverCardStatus({
      expectedCard: { id: 'lw-gallery', hostname: 'lightweaver.local' },
      timeoutMs: 5_000,
      persist: false,
      fetchImpl: (url, { signal } = {}) => {
        const host = new URL(url).hostname;
        requested.push(host);
        if (host === '192.168.18.70') {
          return new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ cardId: 'lw-gallery' }),
        });
      },
    });
    assert.equal(requested[0], '192.168.18.70');
    assert.equal(found.host, 'lightweaver.local');
    assert.ok(Date.now() - startedAt < 1_000, 'fallback should start after the bounded head start, not the fetch timeout');
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

test('direct transport permits local development and same-origin card pages only', () => {
  assert.equal(cardConnection.canPushDirectlyToCard('http:', 'http://localhost:5173'), true);
  assert.equal(cardConnection.canPushDirectlyToCard('http:', 'http://127.0.0.1:4173'), true);
  assert.equal(cardConnection.canPushDirectlyToCard('http:', 'http://192.168.4.1'), true);
  assert.equal(cardConnection.canPushDirectlyToCard('http:', 'http://192.168.18.70'), true);
  assert.equal(cardConnection.canPushDirectlyToCard('http:', 'http://lightweaver.local'), true);
  assert.equal(cardConnection.canPushDirectlyToCard('https:', 'https://led.mandalacodes.com'), false);
  assert.equal(cardConnection.canPushDirectlyToCard('file:', 'null'), false);
  assert.equal(cardConnection.canPushDirectlyToCard('http:', 'http://studio.lan'), false);
  assert.equal(cardConnection.canPushDirectlyToCard('http:', 'http://studio.example.com'), false);
});

test('legacy browser fixtures without location.origin retain protocol-only direct behavior', async () => {
  const browser = fakeBrowser('');
  browser.window.location.protocol = 'http:';
  await withFakeBrowser(browser, () => {
    assert.equal(cardConnection.canPushDirectlyToCard(), true);
    assert.equal(cardConnection.canPushDirectlyToCard('file:', 'null'), false);
  });
});
