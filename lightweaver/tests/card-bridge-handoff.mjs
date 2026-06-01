import assert from 'node:assert/strict';
import {
  bootstrapCardBridgeFromOpener,
  cardBridgeAutoPreviewEnabled,
  isCardBridgeLaunch,
  sendCardBridgeRequest,
} from '../src/lib/cardBridge.js';

globalThis.window = {
  location: {
    search: '?cardBridge=1&cardHost=192.168.18.70',
  },
  opener: {},
  localStorage: {
    getItem: () => 'lightweaver.local',
    setItem: () => {},
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
};

assert.equal(isCardBridgeLaunch(), true);
assert.equal(cardBridgeAutoPreviewEnabled(), true);

globalThis.window.location.search = '?cardBridge=1&cardHost=192.168.18.70&studioTakeover=0';
assert.equal(isCardBridgeLaunch(), true);
assert.equal(cardBridgeAutoPreviewEnabled(), false);

globalThis.window.location.search = '?screen=patterns';
assert.equal(isCardBridgeLaunch(), false);
assert.equal(cardBridgeAutoPreviewEnabled(), false);

const messages = [];
const parentBridge = {
  postMessage(message, targetOrigin) {
    messages.push({ message, targetOrigin });
    setTimeout(() => {
      listeners.get('message')?.({
        origin: 'http://192.168.18.70',
        source: parentBridge,
        data: {
          app: 'LightweaverCardBridge',
          id: message.id,
          ok: true,
          response: { ok: true, fromParentBridge: true },
        },
      });
    }, 0);
  },
};
const listeners = new Map();
globalThis.window = {
  location: {
    search: '?cardBridge=1&cardHost=192.168.18.70',
  },
  opener: null,
  parent: parentBridge,
  localStorage: {
    getItem: () => '192.168.18.70',
    setItem: () => {},
  },
  addEventListener(type, listener) {
    listeners.set(type, listener);
  },
  removeEventListener(type, listener) {
    if (listeners.get(type) === listener) listeners.delete(type);
  },
  dispatchEvent: () => {},
};

assert.equal(bootstrapCardBridgeFromOpener(), true);
const parentBridgeResponse = await sendCardBridgeRequest('status', {}, {
  host: '192.168.18.70',
  timeoutMs: 1000,
});
assert.equal(parentBridgeResponse.fromParentBridge, true);
assert.equal(messages[0].targetOrigin, 'http://192.168.18.70');
assert.equal(messages[0].message.app, 'LightweaverStudioBridge');

console.log('card-bridge-handoff tests passed');
