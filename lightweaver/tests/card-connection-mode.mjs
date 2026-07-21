import assert from 'node:assert/strict';
import {
  canPushDirectlyToCard,
  cardHostToUrl,
  cardLoadMethodForProtocol,
  candidateCardHosts,
  CARD_HOST_CHANGED_EVENT,
  CARD_HOST_HISTORY_STORAGE_KEY,
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
  candidateCardHosts('lightweaver.local').slice(0, 2),
  ['lightweaver.local', '192.168.4.1'],
);
assert.deepEqual(
  candidateCardHosts('192.168.18.70').slice(0, 3),
  ['192.168.18.70', 'lightweaver.local', '192.168.4.1'],
);
assert.deepEqual(
  candidateCardHosts('lightweaver.local', {
    id: 'lw-aabbccddeeff',
    hostname: 'lightweaver-ddeeff',
    address: '192.168.18.70',
  }).slice(0, 4),
  ['lightweaver-ddeeff.local', '192.168.18.70', 'lightweaver.local', '192.168.4.1'],
  'the remembered card-specific hostname and replaceable address must precede generic fallbacks',
);
assert.equal(
  candidateCardHosts('lightweaver.local', {
    id: 'lw-tampered',
    hostname: 'example.com',
    address: '203.0.113.10',
  }).some(host => host === 'example.com' || host === '203.0.113.10'),
  false,
  'tampered remembered identity hints must never turn discovery into a public-host probe',
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
    if (String(url).startsWith('http://192.168.4.1/')) {
      return {
        ok: true,
        json: async () => ({ ok: true, wifi: { ip: '192.168.4.1' }, led: { pixels: 44 } }),
      };
    }
    throw new TypeError('unreachable');
  },
});
assert.equal(discovered.connected, true);
assert.equal(discovered.host, '192.168.4.1');
assert.deepEqual(probed.slice(0, 2), [
  'http://lightweaver.local/api/status',
  'http://192.168.4.1/api/status',
]);

const handoffProbe = await discoverCardStatus({
  preferredHost: '192.168.4.1',
  timeoutMs: 25,
  persist: false,
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      wifi: {
        transport: 'ap', transition: 'handoff-ready', transitionPending: true,
        ip: '192.168.18.90', stationIp: '192.168.18.90', handoffGeneration: 9,
      },
    }),
  }),
});
assert.equal(handoffProbe.host, '192.168.4.1', 'handoff-ready keeps the actual probed AP host');

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
    if (String(url).startsWith('http://192.168.4.1/')) {
      return {
        ok: true,
        json: async () => ({ ok: true, wifi: { ip: '192.168.4.1' }, led: { pixels: 44 } }),
      };
    }
    throw new TypeError('unreachable');
  },
});
assert.equal(parallelDiscovered.connected, true);
assert.equal(parallelDiscovered.host, '192.168.4.1');
assert.ok(
  Date.now() - parallelStart < 300,
  'discovery should not wait for a slow .local probe before trying the remembered IP',
);

const prioritizedProbes = [];
const expectedCard = {
  id: 'lw-aabbccddeeff',
  hostname: 'lightweaver-ddeeff',
  address: '192.168.18.70',
};
const prioritizedDiscovery = await discoverCardStatus({
  preferredHost: 'lightweaver.local',
  expectedCard,
  timeoutMs: 100,
  persist: false,
  fetchImpl: async (url) => {
    prioritizedProbes.push(String(url));
    if (String(url).startsWith('http://lightweaver-ddeeff.local/')) {
      throw new TypeError('old hostname is unavailable');
    }
    if (String(url).startsWith('http://192.168.18.70/')) {
      await new Promise(resolve => setTimeout(resolve, 15));
      return {
        ok: true,
        json: async () => ({ ok: true, cardId: expectedCard.id, wifi: { ip: '192.168.18.70' } }),
      };
    }
    return {
      ok: true,
      json: async () => ({ ok: true, cardId: 'lw-some-other-card' }),
    };
  },
});
assert.equal(prioritizedDiscovery.connected, true);
assert.equal(prioritizedDiscovery.host, '192.168.18.70');
assert.equal(prioritizedDiscovery.status.cardId, expectedCard.id);
assert.equal(
  prioritizedProbes.some(url => url.startsWith('http://lightweaver.local/')),
  false,
  'generic fallbacks must not race ahead of successful card-specific candidates',
);

const staleHintStart = Date.now();
const staleHintProbes = [];
const recoveredFromStaleHints = await discoverCardStatus({
  preferredHost: 'lightweaver.local',
  expectedCard,
  timeoutMs: 700,
  persist: false,
  fetchImpl: async (url) => {
    staleHintProbes.push(String(url));
    if (String(url).startsWith('http://lightweaver.local/')) {
      return {
        ok: true,
        json: async () => ({ ok: true, cardId: expectedCard.id }),
      };
    }
    await new Promise(resolve => setTimeout(resolve, 650));
    throw new TypeError('stale remembered hint');
  },
});
assert.equal(recoveredFromStaleHints.connected, true);
assert.equal(recoveredFromStaleHints.host, 'lightweaver.local');
assert.ok(staleHintProbes.some(url => url.startsWith('http://lightweaver.local/')));
assert.ok(
  Date.now() - staleHintStart < 350,
  'stale card-specific hints receive priority without delaying a safe generic fallback for the full probe timeout',
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

storage.set('lw_card_identity_v1', JSON.stringify({
  version: 1,
  id: expectedCard.id,
  hostname: expectedCard.hostname,
  address: '192.168.18.55',
}));
const numericHintDiscovery = await discoverCardStatus({
  preferredHost: 'lightweaver.local',
  expectedCard,
  timeoutMs: 25,
  persist: true,
  fetchImpl: async (url) => {
    if (!String(url).startsWith('http://192.168.18.70/')) throw new TypeError('unreachable');
    return {
      ok: true,
      json: async () => ({ ok: true, cardId: expectedCard.id, wifi: { ip: '192.168.18.70' } }),
    };
  },
});
assert.equal(numericHintDiscovery.connected, true);
assert.equal(storage.get(CARD_HOST_STORAGE_KEY), '192.168.18.70');
assert.equal(
  JSON.parse(storage.get('lw_card_identity_v1')).id,
  expectedCard.id,
  'a successful numeric address may update the address hint but never the stable card ID',
);
assert.equal(
  JSON.parse(storage.get('lw_card_identity_v1')).address,
  '192.168.18.70',
  'the verified winner updates only the expected card address hint',
);

const mismatchDiscovery = await discoverCardStatus({
  preferredHost: '192.168.18.70',
  expectedCard,
  timeoutMs: 25,
  persist: true,
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({ ok: true, cardId: 'lw-wrong-card', wifi: { ip: '192.168.18.88' } }),
  }),
});
assert.equal(mismatchDiscovery.connected, false, 'a detected identity mismatch is never a connection');
assert.equal(mismatchDiscovery.reason, 'wrong-card');
assert.equal(mismatchDiscovery.detectedStatus.cardId, 'lw-wrong-card');
assert.equal(storage.get(CARD_HOST_STORAGE_KEY), '192.168.18.70', 'a wrong card never replaces the address hint');

storage.set(CARD_HOST_STORAGE_KEY, 'example.com');
storage.set(CARD_HOST_HISTORY_STORAGE_KEY, JSON.stringify([
  'evil.example.com',
  '203.0.113.10',
  '192.168.18.90',
]));
assert.deepEqual(
  candidateCardHosts('', null),
  ['lightweaver.local', '192.168.18.90', '192.168.4.1'],
  'stored preferred and history values are sanitized before any probe is created',
);

storage.set(CARD_HOST_STORAGE_KEY, 'lightweaver.local');
storage.set(CARD_HOST_HISTORY_STORAGE_KEY, '[]');
storage.set('lw_card_identity_v1', JSON.stringify({
  version: 1,
  id: expectedCard.id,
  hostname: expectedCard.hostname,
  address: expectedCard.address,
}));
const raceWinner = await discoverCardStatus({
  preferredHost: 'lightweaver.local',
  expectedCard,
  timeoutMs: 100,
  persist: true,
  fetchImpl: async (url) => {
    if (String(url).startsWith('http://192.168.18.70/')) {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { ok: true, json: async () => ({ cardId: expectedCard.id, wifi: { ip: '192.168.18.70' } }) };
    }
    if (String(url).startsWith('http://lightweaver-ddeeff.local/')) {
      await new Promise(resolve => setTimeout(resolve, 35));
      return { ok: true, json: async () => ({ cardId: expectedCard.id, wifi: { ip: '192.168.18.99' } }) };
    }
    throw new TypeError('unreachable');
  },
});
assert.equal(raceWinner.host, '192.168.18.70');
await new Promise(resolve => setTimeout(resolve, 50));
assert.equal(
  storage.get(CARD_HOST_STORAGE_KEY),
  '192.168.18.70',
  'only the selected verified winner may persist; a slower losing probe has no side effects',
);

let releaseStaleDiscovery;
const staleDiscoveryGate = new Promise(resolve => { releaseStaleDiscovery = resolve; });
const pairingA = { id: 'lw-pairing-a' };
storage.set('lw_card_identity_v1', JSON.stringify({ version: 1, id: pairingA.id }));
storage.set(CARD_HOST_STORAGE_KEY, 'lightweaver.local');
const delayedPairingA = discoverCardStatus({
  preferredHost: 'lightweaver.local',
  expectedCard: pairingA,
  timeoutMs: 500,
  persist: true,
  fetchImpl: async () => {
    await staleDiscoveryGate;
    return {
      ok: true,
      json: async () => ({ cardId: pairingA.id, wifi: { ip: '192.168.18.101' } }),
    };
  },
});
storage.set('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-pairing-b', address: '192.168.18.202' }));
storage.set(CARD_HOST_STORAGE_KEY, '192.168.18.202');
releaseStaleDiscovery();
await delayedPairingA;
assert.equal(
  JSON.parse(storage.get('lw_card_identity_v1')).id,
  'lw-pairing-b',
  'a delayed discovery for pairing A cannot overwrite the newer pairing B generation',
);
assert.equal(storage.get(CARD_HOST_STORAGE_KEY), '192.168.18.202');

events.length = 0;
storage.set(CARD_HOST_STORAGE_KEY, '192.168.18.71');
writeStoredCardHost('192.168.18.70');
writeStoredCardHost('192.168.18.70');
assert.equal(storage.get(CARD_HOST_STORAGE_KEY), '192.168.18.70');
assert.equal(events.filter(event => event.type === CARD_HOST_CHANGED_EVENT).length, 1);
assert.deepEqual(events[0].detail, { host: '192.168.18.70' });

console.log('card-connection-mode tests passed');
