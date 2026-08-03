import assert from 'node:assert/strict';
import test from 'node:test';

import * as cardConnection from './cardConnection.js';

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
