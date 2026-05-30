import assert from 'node:assert/strict';
import {
  canPushDirectlyToCard,
  cardHostToUrl,
  cardLoadMethodForProtocol,
  candidateCardHosts,
  discoverCardStatus,
  normalizeCardHost,
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

console.log('card-connection-mode tests passed');
