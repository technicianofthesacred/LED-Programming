import assert from 'node:assert/strict';
import {
  canPushDirectlyToCard,
  cardHostToUrl,
  cardLoadMethodForProtocol,
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

console.log('card-connection-mode tests passed');
