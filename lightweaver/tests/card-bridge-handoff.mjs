import assert from 'node:assert/strict';
import {
  buildCardBridgeLaunchUrl,
  bootstrapCardBridgeFromOpener,
  cardBridgeAutoPreviewEnabled,
  getCardBridgeState,
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

const handoffUrl = buildCardBridgeLaunchUrl(
  '192.168.18.70',
  'https://led.mandalacodes.com/?deployCheck=123#screen=patterns',
);
const handoff = new URL(handoffUrl);
assert.equal(handoff.origin, 'http://192.168.18.70');
assert.equal(handoff.searchParams.get('studioAutoOpen'), '1');
assert.equal(handoff.hash, '#studioBridge=1');
const embeddedStudio = new URL(handoff.searchParams.get('studioUrl'));
assert.equal(embeddedStudio.origin, 'https://led.mandalacodes.com');
assert.equal(embeddedStudio.searchParams.get('cardBridge'), '1');
assert.equal(embeddedStudio.searchParams.get('cardHost'), '192.168.18.70');
assert.equal(embeddedStudio.searchParams.get('studioTakeover'), '1');
assert.equal(embeddedStudio.hash, '#screen=patterns');

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
const parentBridgeState = getCardBridgeState();
assert.equal(parentBridgeState.open, true);
assert.equal(parentBridgeState.connected, true);
assert.equal(parentBridgeState.host, '192.168.18.70');

const parentBridgeResponse = await sendCardBridgeRequest('status', {}, {
  host: '192.168.18.70',
  timeoutMs: 1000,
});
assert.equal(parentBridgeResponse.fromParentBridge, true);
assert.equal(messages[0].targetOrigin, 'http://192.168.18.70');
assert.equal(messages[0].message.app, 'LightweaverStudioBridge');

const retryMessages = [];
const retryListeners = new Map();
const retryParentBridge = {
  postMessage(message, targetOrigin) {
    retryMessages.push({ message, targetOrigin });
    if (retryMessages.length === 1) return;
    setTimeout(() => {
      retryListeners.get('message')?.({
        origin: 'http://192.168.18.70',
        source: retryParentBridge,
        data: {
          app: 'LightweaverCardBridge',
          id: message.id,
          ok: true,
          response: { ok: true, recoveredAfterDrop: true },
        },
      });
    }, 0);
  },
};
globalThis.window = {
  location: {
    search: '?cardBridge=1&cardHost=192.168.18.70',
  },
  opener: null,
  parent: retryParentBridge,
  localStorage: {
    getItem: () => '192.168.18.70',
    setItem: () => {},
  },
  addEventListener(type, listener) {
    retryListeners.set(type, listener);
  },
  removeEventListener(type, listener) {
    if (retryListeners.get(type) === listener) retryListeners.delete(type);
  },
  dispatchEvent: () => {},
};

assert.equal(bootstrapCardBridgeFromOpener(), true);
const retryResponse = await sendCardBridgeRequest('status', {}, {
  host: '192.168.18.70',
  timeoutMs: 10,
});
assert.equal(retryResponse.recoveredAfterDrop, true);
assert.equal(retryMessages.length, 2);

console.log('card-bridge-handoff tests passed');
