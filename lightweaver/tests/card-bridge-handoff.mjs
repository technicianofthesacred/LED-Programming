import assert from 'node:assert/strict';
import {
  acquireCardBridgeFromGesture,
  buildCardBridgeLaunchUrl,
  bootstrapCardBridgeFromOpener,
  cardBridgeAutoPreviewEnabled,
  getCardBridgeState,
  isCardBridgeLaunch,
  sendCardBridgeRequest,
} from '../src/lib/cardBridge.js';

globalThis.CustomEvent = class CustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
  }
};

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

// Wiring status is safe to retry through a reboot; staging is deliberately not
// retried because only the card may mint a transaction activationId.
const wiringRetryMessages = [];
const wiringRetryListeners = new Map();
const wiringRetryParent = {
  postMessage(message, targetOrigin) {
    wiringRetryMessages.push({ message, targetOrigin });
    if (wiringRetryMessages.length === 1) return;
    setTimeout(() => {
      wiringRetryListeners.get('message')?.({
        origin: 'http://192.168.18.70',
        source: wiringRetryParent,
        data: {
          app: 'LightweaverCardBridge',
          id: message.id,
          ok: true,
          response: { ok: true, state: 'testing', activationId: 'card-issued-1' },
        },
      });
    }, 0);
  },
};
globalThis.window = {
  location: { search: '?cardBridge=1&cardHost=192.168.18.70' },
  opener: null,
  parent: wiringRetryParent,
  localStorage: { getItem: () => '192.168.18.70', setItem: () => {} },
  addEventListener(type, listener) { wiringRetryListeners.set(type, listener); },
  removeEventListener(type, listener) {
    if (wiringRetryListeners.get(type) === listener) wiringRetryListeners.delete(type);
  },
  dispatchEvent: () => {},
};
assert.equal(bootstrapCardBridgeFromOpener(), true);
const wiringRetryResponse = await sendCardBridgeRequest('wiring-status', {}, {
  host: '192.168.18.70',
  timeoutMs: 10,
});
assert.equal(wiringRetryResponse.activationId, 'card-issued-1');
assert.equal(wiringRetryMessages.length, 2);

const stageTimeoutMessages = [];
const stageTimeoutParent = {
  postMessage(message, targetOrigin) { stageTimeoutMessages.push({ message, targetOrigin }); },
};
globalThis.window.parent = stageTimeoutParent;
assert.equal(bootstrapCardBridgeFromOpener(), true);
await assert.rejects(
  sendCardBridgeRequest('wiring-candidate', { candidate: {} }, {
    host: '192.168.18.70',
    timeoutMs: 10,
  }),
  error => error?.reason === 'bridge-timeout',
);
assert.equal(stageTimeoutMessages.length, 1, 'candidate staging must not create two activation ids');

for (const type of [
  'wiring-candidate',
  'wiring-activate',
  'wiring-confirm',
  'wiring-rollback',
  'wiring-discover',
]) {
  await assert.rejects(
    sendCardBridgeRequest(type, {}, { host: 'evil.example.com', timeoutMs: 10 }),
    error => error?.reason === 'bridge-untrusted-origin',
    `${type} must be restricted to a verified local card origin`,
  );
}

function bridgeWindowHarness({
  host,
  opener = null,
  parent = null,
  openResult = undefined,
} = {}) {
  const eventListeners = new Map();
  const opened = [];
  const win = {
    location: {
      href: 'https://led.mandalacodes.com/#screen=patterns',
      search: opener || parent ? `?cardBridge=1&cardHost=${host}` : '',
    },
    opener,
    parent,
    localStorage: {
      getItem: () => host,
      setItem: () => {},
    },
    addEventListener(type, listener) {
      const listenersForType = eventListeners.get(type) || new Set();
      listenersForType.add(listener);
      eventListeners.set(type, listenersForType);
    },
    removeEventListener(type, listener) {
      eventListeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of eventListeners.get(event.type) || []) listener(event);
    },
    open(url, name) {
      opened.push({ url, name });
      return openResult;
    },
    focusCalls: 0,
    focus() {
      this.focusCalls += 1;
    },
  };
  return {
    win,
    opened,
    emitMessage(event) {
      for (const listener of eventListeners.get('message') || []) listener(event);
    },
  };
}

// A verified parent/opener bridge is reused without opening another card page.
const verifiedHost = '192.168.18.71';
const verifiedParent = {};
const verifiedHarness = bridgeWindowHarness({ host: verifiedHost, parent: verifiedParent });
globalThis.window = verifiedHarness.win;
assert.equal(bootstrapCardBridgeFromOpener(), true);
verifiedHarness.emitMessage({
  origin: `http://${verifiedHost}`,
  source: verifiedParent,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: verifiedHost, version: 1 },
});
const verifiedAttempt = acquireCardBridgeFromGesture(verifiedHost, { timeoutMs: 25 });
assert.equal(verifiedHarness.opened.length, 0);
assert.equal((await verifiedAttempt.ready).verified, true);

// A standalone Studio opens exactly one named bridge synchronously, then waits
// for a verified ready handshake before resolving and refocusing Studio.
const popupHost = '192.168.18.72';
const popupBridge = { closed: false, postMessage: () => {} };
const popupHarness = bridgeWindowHarness({ host: popupHost, openResult: popupBridge });
globalThis.window = popupHarness.win;
const popupAttempt = acquireCardBridgeFromGesture(popupHost, {
  studioUrl: 'https://led.mandalacodes.com/#screen=patterns',
  timeoutMs: 100,
});
assert.equal(popupHarness.opened.length, 1, 'window.open must run before the user gesture returns');
assert.equal(popupHarness.opened[0].name, 'lightweaver-card-bridge');
const duplicateAttempt = acquireCardBridgeFromGesture(popupHost, { timeoutMs: 100 });
assert.equal(popupHarness.opened.length, 1, 'concurrent acquisition reuses the named popup');
assert.equal(duplicateAttempt.ready, popupAttempt.ready, 'concurrent acquisition reuses one promise');
popupHarness.emitMessage({
  origin: `http://${popupHost}`,
  source: popupBridge,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: popupHost, version: 1 },
});
const popupState = await popupAttempt.ready;
assert.equal(popupState.verified, true);
assert.equal(popupState.host, popupHost);
assert.equal(popupHarness.win.focusCalls, 1);

// A bridge tab that was verified and later closed is not reusable; the next
// gesture must synchronously reopen the named tab and wait for a new handshake.
popupBridge.closed = true;
const replacementBridge = { closed: false, postMessage: () => {} };
popupHarness.win.open = (url, name) => {
  popupHarness.opened.push({ url, name });
  return replacementBridge;
};
const reopenedAttempt = acquireCardBridgeFromGesture(popupHost, { timeoutMs: 100 });
assert.equal(popupHarness.opened.length, 2);
popupHarness.emitMessage({
  origin: `http://${popupHost}`,
  source: replacementBridge,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: popupHost, version: 1 },
});
await reopenedAttempt.ready;

const blockedHost = '192.168.18.73';
const blockedHarness = bridgeWindowHarness({ host: blockedHost, openResult: null });
globalThis.window = blockedHarness.win;
const blockedAttempt = acquireCardBridgeFromGesture(blockedHost, { timeoutMs: 25 });
assert.equal(blockedHarness.opened.length, 1);
await assert.rejects(blockedAttempt.ready, error => (
  error?.reason === 'popup-blocked'
  && error.message === 'Allow the Lightweaver card window, then try the pattern again.'
));

const timeoutHost = '192.168.18.74';
const timeoutHarness = bridgeWindowHarness({
  host: timeoutHost,
  openResult: { closed: false, postMessage: () => {} },
});
globalThis.window = timeoutHarness.win;
const timeoutAttempt = acquireCardBridgeFromGesture(timeoutHost, { timeoutMs: 10 });
await assert.rejects(timeoutAttempt.ready, error => (
  error?.reason === 'bridge-timeout'
  && error.message === "The card page opened but did not answer. Check that this device is on the card's Wi-Fi."
));

console.log('card-bridge-handoff tests passed');
