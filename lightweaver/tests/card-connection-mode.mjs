import assert from 'node:assert/strict';
import {
  canPushDirectlyToCard,
  cardHostToUrl,
  cardLoadMethodForProtocol,
  candidateCardHosts,
  CARD_HOST_CHANGED_EVENT,
  CARD_HOST_STORAGE_KEY,
  discoverCardStatus,
  normalizeCardHost,
  reduceCardConnectionState,
  writeStoredCardHost,
} from '../src/lib/cardConnection.js';

assert.equal(normalizeCardHost(''), 'lightweaver.local');
assert.equal(normalizeCardHost('lightweaver'), 'lightweaver.local');
assert.equal(normalizeCardHost('lightweaver.local'), 'lightweaver.local');
assert.equal(normalizeCardHost('http://lightweaver.local/settings'), 'lightweaver.local');
assert.equal(normalizeCardHost('192.168.4.1'), '192.168.4.1');

assert.equal(cardHostToUrl('lightweaver'), 'http://lightweaver.local');
assert.equal(cardHostToUrl('http://lightweaver.local/settings'), 'http://lightweaver.local');
assert.equal(cardHostToUrl('192.168.4.1'), 'http://192.168.4.1');

assert.deepEqual(
  candidateCardHosts('lightweaver.local').slice(0, 3),
  ['lightweaver.local', '192.168.18.70', '192.168.4.1'],
);
assert.deepEqual(
  candidateCardHosts('192.168.18.70').slice(0, 3),
  ['192.168.18.70', 'lightweaver.local', '192.168.4.1'],
);

assert.equal(canPushDirectlyToCard('https:'), false);
assert.equal(canPushDirectlyToCard('http:'), true);
assert.equal(canPushDirectlyToCard('file:'), true);

assert.deepEqual(cardLoadMethodForProtocol('https:'), {
  mode: 'copy-download',
  directPush: false,
  label: 'Copy or download',
});
assert.deepEqual(cardLoadMethodForProtocol('http:'), {
  mode: 'local-direct',
  directPush: true,
  label: 'Direct push available',
});

const probed = [];
const discovered = await discoverCardStatus({
  preferredHost: 'lightweaver.local',
  timeoutMs: 25,
  persist: false,
  fetchImpl: async (url) => {
    probed.push(url);
    if (String(url).startsWith('http://192.168.18.70/')) {
      return {
        ok: true,
        json: async () => ({ ok: true, wifi: { ip: '192.168.18.70' }, led: { pixels: 44 } }),
      };
    }
    throw new TypeError('unreachable');
  },
});
assert.equal(discovered.connected, true);
assert.equal(discovered.host, '192.168.18.70');
assert.deepEqual(probed.slice(0, 2), [
  'http://lightweaver.local/api/status',
  'http://192.168.18.70/api/status',
]);

const parallelStart = Date.now();
const parallelDiscovered = await discoverCardStatus({
  preferredHost: 'lightweaver.local',
  timeoutMs: 700,
  persist: false,
  fetchImpl: async (url) => {
    if (String(url).startsWith('http://lightweaver.local/')) {
      await new Promise(resolve => setTimeout(resolve, 650));
      throw new TypeError('slow mdns');
    }
    if (String(url).startsWith('http://192.168.18.70/')) {
      return {
        ok: true,
        json: async () => ({ ok: true, wifi: { ip: '192.168.18.70' }, led: { pixels: 44 } }),
      };
    }
    throw new TypeError('unreachable');
  },
});
assert.equal(parallelDiscovered.connected, true);
assert.equal(parallelDiscovered.host, '192.168.18.70');
assert.ok(
  Date.now() - parallelStart < 300,
  'discovery should not wait for a slow .local probe before trying the remembered IP',
);

const connectedState = reduceCardConnectionState({
  connected: false,
  host: 'lightweaver.local',
  status: null,
  missCount: 0,
  checkedAt: 10,
}, {
  connected: true,
  host: '192.168.18.70',
  status: { ok: true },
}, { now: 20 });
assert.equal(connectedState.connected, true);
assert.equal(connectedState.reconnecting, false);
assert.equal(connectedState.missCount, 0);
assert.equal(connectedState.lastConnectedAt, 20);

const firstMissState = reduceCardConnectionState(connectedState, {
  connected: false,
  host: '192.168.18.70',
  error: new Error('timeout'),
}, { now: 30, missLimit: 3 });
assert.equal(firstMissState.connected, true);
assert.equal(firstMissState.reconnecting, true);
assert.equal(firstMissState.missCount, 1);
assert.equal(firstMissState.host, '192.168.18.70');
assert.deepEqual(firstMissState.status, { ok: true });

const secondMissState = reduceCardConnectionState(firstMissState, {
  connected: false,
  host: 'lightweaver.local',
  error: new Error('timeout'),
}, { now: 40, missLimit: 3 });
assert.equal(secondMissState.connected, true);
assert.equal(secondMissState.reconnecting, true);
assert.equal(secondMissState.missCount, 2);
assert.equal(secondMissState.host, '192.168.18.70');

const droppedState = reduceCardConnectionState(secondMissState, {
  connected: false,
  host: 'lightweaver.local',
  error: new Error('timeout'),
}, { now: 50, missLimit: 3 });
assert.equal(droppedState.connected, false);
assert.equal(droppedState.reconnecting, true);
assert.equal(droppedState.missCount, 3);
assert.equal(droppedState.host, '192.168.18.70');

const storage = new Map();
const events = [];
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};
globalThis.window = {
  localStorage: {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  },
  dispatchEvent: event => events.push(event),
};

writeStoredCardHost('192.168.18.70');
writeStoredCardHost('192.168.18.70');
assert.equal(storage.get(CARD_HOST_STORAGE_KEY), '192.168.18.70');
assert.equal(events.filter(event => event.type === CARD_HOST_CHANGED_EVENT).length, 1);
assert.deepEqual(events[0].detail, { host: '192.168.18.70' });

console.log('card-connection-mode tests passed');
