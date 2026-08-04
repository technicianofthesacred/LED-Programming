import assert from 'node:assert/strict';
import {
  CARD_BRIDGE_CHANGED_EVENT,
  CARD_BRIDGE_WINDOW_NAME,
  acquireCardBridgeFromGesture,
  adoptDiscoveredCardBridgeIdentity,
  buildCardBridgeLaunchUrl,
  bootstrapCardBridgeFromOpener,
  cardBridgeAutoPreviewEnabled,
  clearCardBridgeHandoff,
  getCardBridgeState,
  isCardBridgeLaunch,
  openCardBridge,
  openLocalCardPage,
  retargetCardBridge,
  restoreCardBridgeHandoff,
  sendCardBridgeRequest,
  rePairDiscoveredCardBridgeIdentity,
  verifyCardBridgeIdentity,
} from '../src/lib/cardBridge.js';
import { pushConfigToCard } from '../src/lib/cardPushClient.js';
import { makeCardRuntimePackage } from '../src/lib/cardRuntimeContract.js';

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
assert.equal(new URLSearchParams(handoff.hash.slice(1)).get('studioBridge'), '1');
assert.equal(
  new URLSearchParams(handoff.hash.slice(1)).get('studioOrigin'),
  'https://led.mandalacodes.com',
  'the card ready handshake receives only the allowlisted opener origin',
);
assert.equal(handoff.search, '', 'Studio must not pass an auto-open URL through the card query string');
assert.equal(handoff.searchParams.has('studioAutoOpen'), false);
assert.equal(handoff.searchParams.has('studioUrl'), false);
assert.equal(handoff.href.includes('deployCheck=123'), false, 'arbitrary Studio URL data is never forwarded to the card');

const messages = [];
const storedIdentityValues = new Map([['lw_chip_card_host', '192.168.18.70']]);
let firmwareCardId = 'lw-handoff-test';
let parentStatusOverrides = {};
let delayFirmwareResponse = false;
let releaseFirmwareResponse = null;
const parentBridge = {
  postMessage(message, targetOrigin) {
    messages.push({ message, targetOrigin });
    const respond = () => {
      listeners.get('message')?.({
        origin: 'http://192.168.18.70',
        source: parentBridge,
        data: {
          app: 'LightweaverCardBridge',
          id: message.id,
          ok: true,
          response: message.type === 'firmware-info'
            ? { cardId: firmwareCardId, firmwareVersion: '1.0.0', buildId: 'a'.repeat(40) }
            : message.type === 'status'
              ? {
                  app: 'Lightweaver', provisioningContractVersion: 1,
                  cardId: firmwareCardId, firmwareVersion: '1.0.0', buildId: 'a'.repeat(40),
                  bootId: 'boot-handoff', runtimePhase: 'ready', knownGoodProject: true,
                  commandReady: true, outputReady: true, fromParentBridge: true,
                  ...parentStatusOverrides,
                }
              : { ok: true, fromParentBridge: true },
        },
      });
    };
    if (message.type === 'firmware-info' && delayFirmwareResponse) {
      releaseFirmwareResponse = respond;
      return;
    }
    setTimeout(respond, 0);
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
    getItem: key => storedIdentityValues.get(key) ?? null,
    setItem: (key, value) => storedIdentityValues.set(key, value),
    removeItem: key => storedIdentityValues.delete(key),
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

const discoveredResponse = await sendCardBridgeRequest('firmware-info', {}, {
  host: '192.168.18.70',
  timeoutMs: 1000,
});
assert.equal(discoveredResponse.cardId, 'lw-handoff-test', 'read-only identity discovery succeeds before pairing');
assert.equal(getCardBridgeState().discoveredCard?.id, 'lw-handoff-test', 'pending discovered identity is exposed');
assert.equal(storedIdentityValues.has('lw_card_identity_v1'), false, 'background discovery never adopts a card');
await assert.rejects(
  verifyCardBridgeIdentity('192.168.18.70'),
  error => error?.reason === 'identity-missing',
  'background verification cannot adopt the first discovered card',
);
assert.equal(storedIdentityValues.has('lw_card_identity_v1'), false, 'background verification leaves fresh storage untouched');

const messagesBeforeUnverifiedControl = messages.length;
await assert.rejects(
  sendCardBridgeRequest('control', { patternId: 'fire' }, { host: '192.168.18.70', timeoutMs: 25 }),
  error => error?.reason === 'identity-missing',
  'transport readiness must not authorize a privileged bridge command',
);
assert.equal(messages.length, messagesBeforeUnverifiedControl, 'unverified privileged command never reaches postMessage');
globalThis.localStorage = globalThis.window.localStorage;
await adoptDiscoveredCardBridgeIdentity('192.168.18.70');
assert.equal(JSON.parse(storedIdentityValues.get('lw_card_identity_v1')).id, 'lw-handoff-test', 'explicit first-pair adoption persists identity');
await verifyCardBridgeIdentity('192.168.18.70');

storedIdentityValues.set('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-other-card' }));
const messagesBeforeMismatchedControl = messages.length;
await assert.rejects(
  sendCardBridgeRequest('control', { patternId: 'fire' }, { host: '192.168.18.70', timeoutMs: 25 }),
  error => error?.reason === 'wrong-card',
  'persisted identity mismatch must reject a privileged bridge command',
);
assert.equal(messages.length, messagesBeforeMismatchedControl, 'mismatched privileged command never reaches postMessage');
await rePairDiscoveredCardBridgeIdentity('192.168.18.70');
assert.equal(JSON.parse(storedIdentityValues.get('lw_card_identity_v1')).id, 'lw-handoff-test', 're-pair requires its explicit replacement API');

parentStatusOverrides = {
  runtimePhase: 'factory', knownGoodProject: false, commandReady: false,
};
await sendCardBridgeRequest('status', {}, { host: '192.168.18.70', timeoutMs: 100 });
await assert.rejects(
  sendCardBridgeRequest('config', { project: 'not-commissioning' }, {
    host: '192.168.18.70', timeoutMs: 25,
  }),
  error => error?.reason === 'runtime-not-ready',
  'a noncommissioning blank bridge has no configuration mutation authority',
);
parentStatusOverrides = {};
await sendCardBridgeRequest('status', {}, { host: '192.168.18.70', timeoutMs: 100 });

// The card page can reload without changing its WindowProxy or host. A new
// ready lifecycle must revoke the prior card synchronously while fresh identity
// is still in flight, so no stale command or adoption window exists.
delayFirmwareResponse = true;
firmwareCardId = 'lw-reloaded-different';
listeners.get('message')?.({
  origin: 'http://192.168.18.70',
  source: parentBridge,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: '192.168.18.70', version: 1 },
});
assert.equal(getCardBridgeState().card, null, 'same-target ready synchronously revokes verified identity');
assert.equal(getCardBridgeState().discoveredCard, null, 'same-target ready synchronously clears stale discovery');
const messagesBeforeReloadControl = messages.length;
await assert.rejects(
  sendCardBridgeRequest('control', { patternId: 'fire' }, { host: '192.168.18.70', timeoutMs: 25 }),
  error => error?.reason === 'identity-missing',
);
assert.equal(messages.length, messagesBeforeReloadControl, 'reload lock sends no privileged command');
await assert.rejects(adoptDiscoveredCardBridgeIdentity('192.168.18.70'), error => error?.reason === 'identity-missing');
await assert.rejects(rePairDiscoveredCardBridgeIdentity('192.168.18.70'), error => error?.reason === 'identity-missing');
assert.equal(typeof releaseFirmwareResponse, 'function', 'fresh identity response is delayed by the regression harness');
delayFirmwareResponse = false;
releaseFirmwareResponse();
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(getCardBridgeState().discoveredCard?.id, 'lw-reloaded-different', 'fresh reload identity replaces stale discovery');
assert.equal(getCardBridgeState().card, null, 'mismatched fresh identity remains command-locked');
assert.equal(getCardBridgeState().identityError, 'wrong-card');
await assert.rejects(
  sendCardBridgeRequest('control', { patternId: 'fire' }, { host: '192.168.18.70', timeoutMs: 25 }),
  error => error?.reason === 'wrong-card',
);

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
    if (message.type === 'firmware-info') {
      setTimeout(() => wiringRetryListeners.get('message')?.({
        origin: 'http://192.168.18.70', source: wiringRetryParent,
        data: { app: 'LightweaverCardBridge', id: message.id, ok: true, response: { cardId: 'lw-handoff-test', firmwareVersion: '1.0.0' } },
      }), 0);
      return;
    }
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
  localStorage: {
    getItem: key => key === 'lw_card_identity_v1' ? JSON.stringify({ version: 1, id: 'lw-handoff-test' }) : '192.168.18.70',
    setItem: () => {},
  },
  addEventListener(type, listener) { wiringRetryListeners.set(type, listener); },
  removeEventListener(type, listener) {
    if (wiringRetryListeners.get(type) === listener) wiringRetryListeners.delete(type);
  },
  dispatchEvent: () => {},
};
assert.equal(bootstrapCardBridgeFromOpener(), true);
await verifyCardBridgeIdentity('192.168.18.70');
const wiringRetryResponse = await sendCardBridgeRequest('wiring-status', {}, {
  host: '192.168.18.70',
  timeoutMs: 10,
});
assert.equal(wiringRetryResponse.activationId, 'card-issued-1');
assert.equal(wiringRetryMessages.length, 2);

const stageTimeoutMessages = [];
const stageTimeoutParent = {
  postMessage(message, targetOrigin) {
    if (message.type === 'firmware-info') {
      setTimeout(() => wiringRetryListeners.get('message')?.({
        origin: 'http://192.168.18.70', source: stageTimeoutParent,
        data: { app: 'LightweaverCardBridge', id: message.id, ok: true, response: { cardId: 'lw-handoff-test', firmwareVersion: '1.0.0' } },
      }), 0);
      return;
    }
    if (message.type === 'status') {
      setTimeout(() => wiringRetryListeners.get('message')?.({
        origin: 'http://192.168.18.70', source: stageTimeoutParent,
        data: { app: 'LightweaverCardBridge', id: message.id, ok: true, response: {
          app: 'Lightweaver', provisioningContractVersion: 1,
          cardId: 'lw-handoff-test', firmwareVersion: '1.0.0', buildId: 'build-stage-timeout',
          bootId: 'boot-stage-timeout', runtimePhase: 'ready', knownGoodProject: true,
          commandReady: true, outputReady: true,
        } },
      }), 0);
      return;
    }
    stageTimeoutMessages.push({ message, targetOrigin });
  },
};
globalThis.window.parent = stageTimeoutParent;
assert.equal(bootstrapCardBridgeFromOpener(), true);
await verifyCardBridgeIdentity('192.168.18.70');
await sendCardBridgeRequest('status', {}, { host: '192.168.18.70', timeoutMs: 100 });
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
  fakeClock = false,
  initialNow = 0,
} = {}) {
  const eventListeners = new Map();
  const documentListeners = new Map();
  const opened = [];
  let now = initialNow;
  let nextTimerId = 1;
  let nextTimerOrder = 1;
  const timers = new Map();
  const addListener = (listeners, type, listener) => {
    const listenersForType = listeners.get(type) || new Set();
    listenersForType.add(listener);
    listeners.set(type, listenersForType);
  };
  const removeListener = (listeners, type, listener) => {
    listeners.get(type)?.delete(listener);
  };
  const emit = (listeners, event) => {
    for (const listener of [...(listeners.get(event.type) || [])]) listener(event);
  };
  const fakeSetTimeout = (callback, delay = 0) => {
    const id = nextTimerId++;
    timers.set(id, {
      callback,
      dueAt: now + Math.max(0, Number(delay) || 0),
      order: nextTimerOrder++,
    });
    return id;
  };
  const fakeClearTimeout = id => timers.delete(id);
  const advance = ms => {
    const end = now + ms;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= end)
        .sort((left, right) => (
          left[1].dueAt - right[1].dueAt || left[1].order - right[1].order
        ))[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id);
      now = timer.dueAt;
      timer.callback();
    }
    now = end;
  };
  const identityId = `lw-${String(host).replace(/[^a-z0-9]/gi, '')}`;
  const storageValues = new Map([
    ['lw_chip_card_host', host],
    ['lw_card_identity_v1', JSON.stringify({ version: 1, id: identityId })],
  ]);
  const sessionValues = new Map();
  const document = {
    visibilityState: 'visible',
    addEventListener(type, listener) {
      addListener(documentListeners, type, listener);
    },
    removeEventListener(type, listener) {
      removeListener(documentListeners, type, listener);
    },
    dispatchEvent(event) {
      emit(documentListeners, event);
    },
  };
  const win = {
    location: {
      href: 'https://led.mandalacodes.com/#screen=patterns',
      search: opener || parent ? `?cardBridge=1&cardHost=${host}` : '',
    },
    document,
    opener,
    parent,
    localStorage: {
      getItem: key => storageValues.get(key) ?? null,
      setItem: (key, value) => storageValues.set(key, value),
      removeItem: key => storageValues.delete(key),
    },
    sessionStorage: {
      getItem: key => sessionValues.get(key) ?? null,
      setItem: (key, value) => sessionValues.set(key, value),
      removeItem: key => sessionValues.delete(key),
    },
    addEventListener(type, listener) {
      addListener(eventListeners, type, listener);
    },
    removeEventListener(type, listener) {
      removeListener(eventListeners, type, listener);
    },
    dispatchEvent(event) {
      emit(eventListeners, event);
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
  if (fakeClock) {
    win.Date = { now: () => now };
    win.setTimeout = fakeSetTimeout;
    win.clearTimeout = fakeClearTimeout;
  }
  return {
    win,
    opened,
    storageValues,
    sessionValues,
    emitMessage(event) {
      emit(eventListeners, { ...event, type: 'message' });
    },
    emitWindow(type) {
      emit(eventListeners, { type });
    },
    emitDocument(type = 'visibilitychange') {
      emit(documentListeners, { type });
    },
    windowListenerCount(type) {
      return eventListeners.get(type)?.size || 0;
    },
    documentListenerCount(type) {
      return documentListeners.get(type)?.size || 0;
    },
    windowListeners(type) {
      return [...(eventListeners.get(type) || [])];
    },
    documentListeners(type) {
      return [...(documentListeners.get(type) || [])];
    },
    clock: fakeClock ? {
      advance,
      now: () => now,
      pendingCount: () => timers.size,
      callbacks: () => [...timers.values()].map(timer => timer.callback),
    } : null,
  };
}

// A verified parent/opener bridge is reused without opening another card page.
const verifiedHost = '192.168.18.71';
let verifiedHarness;
const verifiedParent = {
  postMessage(message) {
    if (message.type !== 'firmware-info') return;
    setTimeout(() => verifiedHarness.emitMessage({
      origin: `http://${verifiedHost}`,
      source: verifiedParent,
      data: {
        app: 'LightweaverCardBridge', id: message.id, ok: true,
        response: { cardId: 'lw-1921681871', firmwareVersion: '1.0.0' },
      },
    }), 0);
  },
};
verifiedHarness = bridgeWindowHarness({ host: verifiedHost, parent: verifiedParent });
globalThis.window = verifiedHarness.win;
assert.equal(bootstrapCardBridgeFromOpener(), true);
verifiedHarness.emitMessage({
  origin: `http://${verifiedHost}`,
  source: verifiedParent,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: verifiedHost, version: 1 },
});
await verifyCardBridgeIdentity(verifiedHost);
const verifiedAttempt = acquireCardBridgeFromGesture(verifiedHost, { timeoutMs: 25 });
assert.equal(verifiedHarness.opened.length, 0);
assert.equal((await verifiedAttempt.ready).verified, true);

// A standalone Studio opens exactly one named bridge synchronously, then waits
// for a verified ready handshake before resolving and refocusing Studio.
const popupHost = '192.168.18.72';
let popupHarness;
const popupBridge = {
  closed: false,
  postMessage(message) {
    if (message.type !== 'firmware-info') return;
    setTimeout(() => popupHarness.emitMessage({
      origin: `http://${popupHost}`,
      source: popupBridge,
      data: {
        app: 'LightweaverCardBridge', id: message.id, ok: true,
        response: { cardId: 'lw-1921681872', firmwareVersion: '1.0.0' },
      },
    }), 0);
  },
};
popupHarness = bridgeWindowHarness({ host: popupHost, openResult: popupBridge });
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

// Pairing takeover is intentionally allowed to stop at fresh read-only card
// discovery. A new Studio profile has no persisted identity yet, so ordinary
// acquisition cannot become identityVerified until the explicit pairing step
// adopts the card. The takeover gesture must still reclaim the named card tab
// and return the freshly discovered identity for that explicit step.
const takeoverHost = '192.168.18.78';
let takeoverHarness;
const takeoverBridge = {
  closed: false,
  postMessage(message) {
    if (message.type !== 'firmware-info') return;
    setTimeout(() => takeoverHarness.emitMessage({
      origin: `http://${takeoverHost}`,
      source: takeoverBridge,
      data: {
        app: 'LightweaverCardBridge', id: message.id, ok: true,
        response: { cardId: 'lw-takeover-card', firmwareVersion: '1.0.0' },
      },
    }), 0);
  },
};
takeoverHarness = bridgeWindowHarness({ host: takeoverHost, openResult: takeoverBridge });
takeoverHarness.storageValues.delete('lw_card_identity_v1');
globalThis.window = takeoverHarness.win;
const takeoverAttempt = acquireCardBridgeFromGesture(takeoverHost, {
  timeoutMs: 100,
  acceptDiscovered: true,
});
assert.equal(takeoverHarness.opened.length, 1, 'takeover reclaims the named card window from the user gesture');
takeoverHarness.emitMessage({
  origin: `http://${takeoverHost}`,
  source: takeoverBridge,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: takeoverHost, version: 1 },
});
const takeoverState = await takeoverAttempt.ready;
assert.equal(takeoverState.verified, true, 'the replacement card page completed a fresh origin handshake');
assert.equal(takeoverState.identityVerified, false, 'discovery alone never grants command authority');
assert.equal(takeoverState.discoveredCard?.id, 'lw-takeover-card', 'takeover returns only the freshly discovered card');
globalThis.window = popupHarness.win;

// A bridge tab that was verified and later closed is not reusable; the next
// gesture must synchronously reopen the named tab and wait for a new handshake.
popupBridge.closed = true;
const replacementBridge = {
  closed: false,
  postMessage(message) {
    if (message.type !== 'firmware-info') return;
    setTimeout(() => popupHarness.emitMessage({
      origin: `http://${popupHost}`,
      source: replacementBridge,
      data: {
        app: 'LightweaverCardBridge', id: message.id, ok: true,
        response: { cardId: 'lw-1921681872', firmwareVersion: '1.0.0' },
      },
    }), 0);
  },
};
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

// A named popup keeps the same WindowProxy when it navigates from card A to B.
// The target switch itself must stale every A request before B emits ready.
const switchHostA = '192.168.18.75';
const switchHostB = '192.168.18.76';
const switchMessages = [];
let switchHarness;
const namedPopup = {
  closed: false,
  postMessage(message, targetOrigin) {
    switchMessages.push({ message, targetOrigin });
  },
};
switchHarness = bridgeWindowHarness({ host: switchHostA, openResult: namedPopup });
globalThis.window = switchHarness.win;
const respondFromSwitchHost = (entry, host, response) => switchHarness.emitMessage({
  origin: `http://${host}`,
  source: namedPopup,
  data: { app: 'LightweaverCardBridge', id: entry.message.id, ok: true, response },
});

openCardBridge(switchHostA);
switchHarness.emitMessage({
  origin: `http://${switchHostA}`,
  source: namedPopup,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: switchHostA, version: 1 },
});
const initialAInfo = switchMessages.at(-1);
respondFromSwitchHost(initialAInfo, switchHostA, { cardId: 'lw-1921681875', firmwareVersion: '1.0.0' });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(getCardBridgeState().card?.id, 'lw-1921681875');

const delayedARequest = sendCardBridgeRequest('firmware-info', {}, { host: switchHostA, timeoutMs: 1000 });
const delayedAInfo = switchMessages.at(-1);
switchHarness.storageValues.set('lw_card_identity_v1', JSON.stringify({ version: 1, id: 'lw-1921681876' }));
openCardBridge(switchHostB);
assert.equal(getCardBridgeState().card, null, 'A→B target switch synchronously revokes A identity');
respondFromSwitchHost(delayedAInfo, switchHostA, { cardId: 'lw-1921681875', firmwareVersion: '1.0.0' });
await assert.rejects(delayedARequest, error => error?.reason === 'bridge-navigated');
assert.equal(getCardBridgeState().card, null, 'delayed A response cannot restore verified identity');
assert.equal(getCardBridgeState().discoveredCard, null, 'delayed A response cannot restore discovered identity');

switchHarness.emitMessage({
  origin: `http://${switchHostB}`,
  source: namedPopup,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: switchHostB, version: 1 },
});
const freshBInfo = switchMessages.at(-1);
const messagesBeforeBIdentity = switchMessages.length;
await assert.rejects(
  sendCardBridgeRequest('control', { patternId: 'fire' }, { host: switchHostB, timeoutMs: 25 }),
  error => error?.reason === 'identity-missing',
);
assert.equal(switchMessages.length, messagesBeforeBIdentity, 'B receives no privileged command before fresh identity');
respondFromSwitchHost(freshBInfo, switchHostB, { cardId: 'lw-1921681876', firmwareVersion: '1.0.0' });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(getCardBridgeState().card?.id, 'lw-1921681876', 'fresh matching B identity restores authority');
const freshBStatus = sendCardBridgeRequest('status', {}, { host: switchHostB, timeoutMs: 1000 });
const bStatusMessage = switchMessages.at(-1);
respondFromSwitchHost(bStatusMessage, switchHostB, {
  app: 'Lightweaver', provisioningContractVersion: 1,
  cardId: 'lw-1921681876', firmwareVersion: '1.0.0', buildId: 'build-switch-b',
  bootId: 'boot-switch-b', runtimePhase: 'ready', knownGoodProject: true,
  commandReady: true, outputReady: true,
});
await freshBStatus;
const allowedBControl = sendCardBridgeRequest('control', { patternId: 'fire' }, { host: switchHostB, timeoutMs: 1000 });
const bControlMessage = switchMessages.at(-1);
respondFromSwitchHost(bControlMessage, switchHostB, { ok: true });
await allowedBControl;

const blockedHost = '192.168.18.73';
const blockedHarness = bridgeWindowHarness({ host: blockedHost, openResult: null });
globalThis.window = blockedHarness.win;
const blockedAttempt = acquireCardBridgeFromGesture(blockedHost, { timeoutMs: 25 });
assert.equal(blockedHarness.opened.length, 1);
await assert.rejects(blockedAttempt.ready, error => (
  error?.reason === 'popup-blocked'
  && error.message === 'Allow the Lightweaver card window, then try the pattern again.'
));

// Popup permission can be granted after the first refusal. The same visible
// user-gesture action must make a fresh synchronous window.open attempt and
// complete onboarding rather than remaining stuck on the rejected promise.
const retryBridge = {
  closed: false,
  postMessage(message) {
    if (message.type !== 'firmware-info') return;
    setTimeout(() => blockedHarness.emitMessage({
      origin: `http://${blockedHost}`,
      source: retryBridge,
      data: {
        app: 'LightweaverCardBridge', id: message.id, ok: true,
        response: { cardId: 'lw-1921681873', firmwareVersion: '1.0.0' },
      },
    }), 0);
  },
};
blockedHarness.win.open = (url, name) => {
  blockedHarness.opened.push({ url, name });
  return retryBridge;
};
const allowedRetry = acquireCardBridgeFromGesture(blockedHost, { timeoutMs: 100 });
assert.equal(blockedHarness.opened.length, 2, 'retry performs a new popup attempt from the new gesture');
blockedHarness.emitMessage({
  origin: `http://${blockedHost}`,
  source: retryBridge,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: blockedHost, version: 1 },
});
assert.equal((await allowedRetry.ready).verified, true, 'popup-blocked onboarding resumes after permission is granted');

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

// openLocalCardPage: every visible card-page click routes through the SAME
// named bridge window and carries the Studio-origin handshake fragment, so at
// most one auxiliary card tab exists and it can become command-ready.
assert.equal(typeof openLocalCardPage, 'function');
assert.equal(CARD_BRIDGE_WINDOW_NAME, 'lightweaver-card-bridge');
const cardPageHost = '192.168.18.77';
const cardPageTab = {
  closed: false,
  focusCalls: 0,
  focus() { this.focusCalls += 1; },
  postMessageCalls: 0,
  postMessage() { this.postMessageCalls += 1; },
};
const cardPageHarness = bridgeWindowHarness({ host: cardPageHost, openResult: cardPageTab });
globalThis.window = cardPageHarness.win;
const firstVisit = openLocalCardPage(cardPageHost);
assert.equal(firstVisit.ok, true);
assert.equal(cardPageHarness.opened.length, 1);
assert.equal(cardPageHarness.opened[0].name, CARD_BRIDGE_WINDOW_NAME, 'plain visits use the named bridge window');
const cardPageLaunch = new URL(cardPageHarness.opened[0].url);
assert.equal(cardPageLaunch.origin, `http://${cardPageHost}`);
assert.equal(cardPageLaunch.pathname, '/');
assert.equal(new URLSearchParams(cardPageLaunch.hash.slice(1)).get('studioBridge'), '1');
assert.equal(new URLSearchParams(cardPageLaunch.hash.slice(1)).get('studioOrigin'), 'https://led.mandalacodes.com');
const secondVisit = openLocalCardPage(cardPageHost, { path: '/', reason: 'open-card-page' });
assert.equal(secondVisit.ok, true);
assert.equal(secondVisit.window, firstVisit.window, 'repeat visits reuse the same named window handle');
assert.equal(cardPageHarness.opened[1].name, CARD_BRIDGE_WINDOW_NAME);
assert.equal(cardPageTab.focusCalls, 2, 'the already-open card tab is refocused');

// A launch fragment alone never grants transport readiness: privileged sends
// stay identity-locked until the freshly loaded page handshakes again.
assert.equal(getCardBridgeState().open, true);
assert.equal(getCardBridgeState().verified, false, 'a plain card-page visit is not a verified handshake');
await assert.rejects(
  sendCardBridgeRequest('control', { patternId: 'fire' }, { host: cardPageHost, timeoutMs: 25 }),
  error => error?.reason === 'identity-missing',
);
assert.equal(cardPageTab.postMessageCalls, 0, 'no privileged command reaches the freshly navigated card tab');

// Opening the plain card page over a previously verified bridge revokes the
// stale handshake (the shared named tab navigated) rather than corrupting it.
const revisitHost = '192.168.18.78';
let revisitHarness;
let delayedRevisitStatus = null;
const revisitParent = {
  closed: false,
  postMessageCalls: 0,
  postMessage(message) {
    this.postMessageCalls += 1;
    if (message.type === 'status') {
      delayedRevisitStatus = message;
      return;
    }
    if (message.type !== 'firmware-info') return;
    setTimeout(() => revisitHarness.emitMessage({
      origin: `http://${revisitHost}`,
      source: revisitParent,
      data: {
        app: 'LightweaverCardBridge', id: message.id, ok: true,
        response: { cardId: 'lw-1921681878', firmwareVersion: '1.0.0' },
      },
    }), 0);
  },
  focus() {},
};
revisitHarness = bridgeWindowHarness({ host: revisitHost, parent: revisitParent, openResult: revisitParent });
globalThis.window = revisitHarness.win;
assert.equal(bootstrapCardBridgeFromOpener(), true);
revisitHarness.emitMessage({
  origin: `http://${revisitHost}`,
  source: revisitParent,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: revisitHost, version: 1 },
});
await verifyCardBridgeIdentity(revisitHost);
assert.equal(getCardBridgeState().identityVerified, true);
const preNavigationLifecycle = getCardBridgeState().lifecycle;
const revisitPostsBeforeNavigation = revisitParent.postMessageCalls;
let preNavigationRejection = '';
const delayedPreNavigationRequest = sendCardBridgeRequest('status', {}, {
  host: revisitHost,
  timeoutMs: 1000,
  retryOnTimeout: false,
}).then(() => null, error => {
  preNavigationRejection = error?.reason || '';
  return error;
});
assert.ok(delayedRevisitStatus, 'same-host request is held before navigation');
assert.equal(openLocalCardPage(revisitHost).ok, true);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(preNavigationRejection, 'bridge-navigated',
  'navigation synchronously rejects the prior page lifecycle');
assert.equal((await delayedPreNavigationRequest)?.reason, 'bridge-navigated');
assert.ok(getCardBridgeState().lifecycle > preNavigationLifecycle);
assert.equal(getCardBridgeState().verified, false, 'the plain visit revokes the stale bridge handshake');
assert.equal(getCardBridgeState().card, null, 'verified identity is dropped until the new page re-verifies');
revisitHarness.emitMessage({
  origin: `http://${revisitHost}`,
  source: revisitParent,
  data: {
    app: 'LightweaverCardBridge', id: delayedRevisitStatus.id, ok: true,
    response: { cardId: 'lw-1921681878' },
  },
});
assert.equal(getCardBridgeState().card, null,
  'a delayed reply from the pre-navigation page cannot restore identity');
await assert.rejects(
  sendCardBridgeRequest('control', { patternId: 'fire' }, { host: revisitHost, timeoutMs: 25 }),
  error => error?.reason === 'identity-missing',
);
assert.equal(revisitParent.postMessageCalls, revisitPostsBeforeNavigation + 1,
  'only the intentionally delayed status was posted after verification');

// Blocked popups and non-local hosts fail closed with caller-visible reasons.
const blockedVisitHarness = bridgeWindowHarness({ host: '192.168.18.79', openResult: null });
globalThis.window = blockedVisitHarness.win;
assert.deepEqual(openLocalCardPage('192.168.18.79'), { ok: false, reason: 'popup-blocked' });
assert.equal(blockedVisitHarness.opened.length, 1);
assert.deepEqual(openLocalCardPage('evil.example.com'), { ok: false, reason: 'invalid-host' });
assert.deepEqual(openLocalCardPage('192.168.18.79', { path: '//evil.example/' }), { ok: false, reason: 'invalid-host' });
assert.equal(blockedVisitHarness.opened.length, 1, 'invalid hosts and paths never reach window.open');

// A failed cross-subnet navigation can leave the named card WindowProxy on a
// browser network-error document. Recovery owns only that exact WindowProxy,
// correlation, flow, and station URL for one absolute five-minute window.
const recoveryApHost = '192.168.4.1';
const recoveryStationHost = '192.168.18.91';
const recoveryFlowId = 'flow-navigation-recovery-1234';
const recoveryCorrelation = {
  host: recoveryStationHost,
  expectedCardId: 'lw-navigation-recovery',
  expectedFirmwareVersion: '2.0.0',
  expectedBuildId: 'build-navigation-recovery',
  expectedBootId: 'boot-navigation-recovery',
  handoffGeneration: 11,
};

function recoveryTargetFor(harness, { throwAssignments = 0 } = {}) {
  const target = {
    closed: false,
    navigations: [],
    posts: [],
    postMessage(message, targetOrigin) {
      this.posts.push({ message, targetOrigin });
    },
    focus() {},
  };
  let href = '';
  let throwsRemaining = throwAssignments;
  target.location = {
    get href() { return href; },
    set href(value) {
      target.navigations.push({ at: harness.clock.now(), url: String(value) });
      if (throwsRemaining > 0) {
        throwsRemaining -= 1;
        throw new Error('network-error document rejected navigation');
      }
      href = String(value);
    },
  };
  return target;
}

function beginNavigationRecovery({
  host = recoveryStationHost,
  flowId = recoveryFlowId,
  correlation = recoveryCorrelation,
  throwAssignments = 0,
  initialNow = 0,
} = {}) {
  const harness = bridgeWindowHarness({
    host: recoveryApHost,
    fakeClock: true,
    initialNow,
  });
  const target = recoveryTargetFor(harness, { throwAssignments });
  harness.win.open = (url, name) => {
    harness.opened.push({ url, name });
    return target;
  };
  globalThis.window = harness.win;
  assert.equal(openLocalCardPage(recoveryApHost).ok, true);
  const result = retargetCardBridge(host, correlation, { flowId });
  return { harness, target, result };
}

const initialReentrantHarness = bridgeWindowHarness({
  host: recoveryApHost,
  fakeClock: true,
});
const initialReentrantTarget = recoveryTargetFor(initialReentrantHarness);
initialReentrantHarness.win.open = (url, name) => {
  initialReentrantHarness.opened.push({ url, name });
  return initialReentrantTarget;
};
globalThis.window = initialReentrantHarness.win;
assert.equal(openLocalCardPage(recoveryApHost).ok, true);
const initialReentrantFlow = 'flow-initial-reentrant-1234';
let initialReentrantClearCount = 0;
initialReentrantHarness.win.addEventListener(CARD_BRIDGE_CHANGED_EVENT, event => {
  if (event.detail?.handoffFlowId !== initialReentrantFlow) return;
  if (clearCardBridgeHandoff(initialReentrantFlow)) initialReentrantClearCount += 1;
});
const initialReentrantResult = retargetCardBridge(
  recoveryStationHost,
  { ...recoveryCorrelation, handoffGeneration: 101 },
  { flowId: initialReentrantFlow },
);
assert.equal(initialReentrantClearCount, 1,
  'the harness clears the newly published flow during synchronous dispatch');
assert.equal(initialReentrantResult.ok, false);
assert.equal(initialReentrantResult.reason, 'stale-correlation');
assert.equal(initialReentrantResult.retryable, false);
assert.equal(initialReentrantTarget.navigations.length, 0,
  'initial retarget cannot navigate after its synchronous publish was cleared');
assert.equal(initialReentrantHarness.clock.pendingCount(), 0);
assert.equal(initialReentrantHarness.windowListenerCount('online'), 0);
assert.equal(initialReentrantHarness.windowListenerCount('focus'), 0);
assert.equal(initialReentrantHarness.documentListenerCount('visibilitychange'), 0);
initialReentrantHarness.emitWindow('online');
initialReentrantHarness.emitWindow('focus');
initialReentrantHarness.emitDocument();
initialReentrantHarness.clock.advance(300000);
assert.equal(initialReentrantTarget.navigations.length, 0,
  'later lifecycle signals cannot revive the cleared initial retarget');

const repeatedReentrantRecovery = beginNavigationRecovery({
  flowId: 'flow-repeated-reentrant-1234',
  correlation: { ...recoveryCorrelation, handoffGeneration: 102 },
});
const repeatedOldNavigationCount = repeatedReentrantRecovery.target.navigations.length;
const repeatedSuccessorCorrelation = {
  ...recoveryCorrelation,
  host: '192.168.18.94',
  expectedBootId: 'boot-reentrant-successor',
  handoffGeneration: 103,
};
const repeatedSuccessorFlow = 'flow-reentrant-successor-1234';
const repeatedSuccessorTarget = recoveryTargetFor(repeatedReentrantRecovery.harness);
let repeatedDispatchHandled = false;
let repeatedCapturedCallbacks = [];
repeatedReentrantRecovery.harness.win.addEventListener(CARD_BRIDGE_CHANGED_EVENT, event => {
  if (repeatedDispatchHandled
    || event.detail?.handoffFlowId !== 'flow-repeated-reentrant-1234'
    || event.detail?.verified !== false) return;
  repeatedDispatchHandled = true;
  repeatedCapturedCallbacks = [
    ...repeatedReentrantRecovery.harness.windowListeners('online'),
    ...repeatedReentrantRecovery.harness.windowListeners('focus'),
    ...repeatedReentrantRecovery.harness.documentListeners('visibilitychange'),
    ...repeatedReentrantRecovery.harness.clock.callbacks(),
  ];
  clearCardBridgeHandoff('flow-repeated-reentrant-1234');
  repeatedReentrantRecovery.harness.win.open = (url, name) => {
    repeatedReentrantRecovery.harness.opened.push({ url, name });
    return repeatedSuccessorTarget;
  };
  assert.equal(openLocalCardPage(recoveryApHost).ok, true);
  assert.equal(retargetCardBridge(
    repeatedSuccessorCorrelation.host,
    repeatedSuccessorCorrelation,
    { flowId: repeatedSuccessorFlow },
  ).ok, true);
});
const repeatedReentrantResult = retargetCardBridge(
  recoveryStationHost,
  { ...recoveryCorrelation, handoffGeneration: 102 },
  { flowId: 'flow-repeated-reentrant-1234' },
);
assert.equal(repeatedDispatchHandled, true,
  'the harness installs a successor during repeated retarget revocation');
assert.equal(repeatedReentrantResult.ok, false);
assert.equal(repeatedReentrantResult.reason, 'stale-correlation');
assert.equal(repeatedReentrantResult.retryable, false);
assert.equal(repeatedReentrantRecovery.target.navigations.length, repeatedOldNavigationCount,
  'repeated retarget cannot navigate its old target after synchronous replacement');
assert.equal(repeatedSuccessorTarget.navigations.length, 1);
assert.equal(getCardBridgeState().handoffFlowId, repeatedSuccessorFlow);
assert.equal(repeatedReentrantRecovery.harness.clock.pendingCount(), 1,
  'only successor recovery retains a timer');
assert.equal(repeatedReentrantRecovery.harness.windowListenerCount('online'), 1);
assert.equal(repeatedReentrantRecovery.harness.windowListenerCount('focus'), 1);
assert.equal(repeatedReentrantRecovery.harness.documentListenerCount('visibilitychange'), 1);
const repeatedSuccessorNavigationCount = repeatedSuccessorTarget.navigations.length;
for (const callback of repeatedCapturedCallbacks) callback();
assert.equal(repeatedReentrantRecovery.target.navigations.length, repeatedOldNavigationCount,
  'captured old callbacks cannot navigate the replaced target');
assert.equal(repeatedSuccessorTarget.navigations.length, repeatedSuccessorNavigationCount,
  'captured old callbacks cannot navigate the successor');
assert.equal(repeatedReentrantRecovery.harness.clock.pendingCount(), 1,
  'old token cleanup cannot clear the successor timer');
assert.equal(repeatedReentrantRecovery.harness.windowListenerCount('online'), 1);
assert.equal(repeatedReentrantRecovery.harness.windowListenerCount('focus'), 1);
assert.equal(repeatedReentrantRecovery.harness.documentListenerCount('visibilitychange'), 1);

const deadlineRecovery = beginNavigationRecovery();
assert.equal(deadlineRecovery.result.ok, true);
const exactRecoveryUrl = deadlineRecovery.result.url;
assert.deepEqual(deadlineRecovery.target.navigations.map(entry => entry.at), [0]);
assert.equal(deadlineRecovery.harness.windowListenerCount('online'), 1);
assert.equal(deadlineRecovery.harness.windowListenerCount('focus'), 1);
assert.equal(deadlineRecovery.harness.documentListenerCount('visibilitychange'), 1);
assert.equal(deadlineRecovery.harness.clock.pendingCount(), 1, 'one retry timer is armed');
deadlineRecovery.harness.clock.advance(130001);
assert.equal(deadlineRecovery.target.navigations.at(-1).at, 130000,
  'retries remain active after the former 130-second cutoff');
assert.equal(deadlineRecovery.harness.clock.pendingCount(), 1);
deadlineRecovery.harness.clock.advance(169998);
assert.deepEqual(
  deadlineRecovery.target.navigations.map(entry => entry.at),
  [0, 4000, 16000, 40000, 70000, 100000, 130000, 160000, 190000, 220000, 250000, 280000],
  'fast retries settle into a 30-second cadence without navigating at the deadline',
);
assert.ok(deadlineRecovery.target.navigations.every(entry => entry.url === exactRecoveryUrl),
  'every recovery attempt uses the one computed station URL');
assert.deepEqual(deadlineRecovery.target.posts, [],
  'navigation recovery never sends config, wifi-handoff-ack, or any other postMessage traffic');
assert.equal(deadlineRecovery.harness.windowListenerCount('online'), 1);
deadlineRecovery.harness.clock.advance(1);
assert.equal(deadlineRecovery.harness.clock.now(), 300000);
assert.equal(deadlineRecovery.harness.clock.pendingCount(), 0,
  'the absolute five-minute deadline releases its final timer');
assert.equal(deadlineRecovery.harness.windowListenerCount('online'), 0);
assert.equal(deadlineRecovery.harness.windowListenerCount('focus'), 0);
assert.equal(deadlineRecovery.harness.documentListenerCount('visibilitychange'), 0);
const navigationCountAtDeadline = deadlineRecovery.target.navigations.length;
const expiredExactDuplicate = retargetCardBridge(recoveryStationHost, recoveryCorrelation, {
  flowId: recoveryFlowId,
});
assert.equal(expiredExactDuplicate.ok, false);
assert.equal(expiredExactDuplicate.reason, 'stale-correlation');
assert.equal(expiredExactDuplicate.retryable, false);
assert.equal(deadlineRecovery.target.navigations.length, navigationCountAtDeadline,
  'an exact duplicate at the absolute deadline cannot navigate');
assert.equal(deadlineRecovery.harness.clock.pendingCount(), 0);
assert.equal(deadlineRecovery.harness.windowListenerCount('online'), 0);
assert.equal(deadlineRecovery.harness.windowListenerCount('focus'), 0);
assert.equal(deadlineRecovery.harness.documentListenerCount('visibilitychange'), 0);
deadlineRecovery.harness.clock.advance(1);
const expiredLaterDuplicate = retargetCardBridge(recoveryStationHost, recoveryCorrelation, {
  flowId: recoveryFlowId,
});
assert.equal(expiredLaterDuplicate.ok, false);
assert.equal(expiredLaterDuplicate.reason, 'stale-correlation');
assert.equal(deadlineRecovery.target.navigations.length, navigationCountAtDeadline,
  'an exact duplicate after the deadline cannot navigate or rearm recovery');
assert.equal(deadlineRecovery.harness.clock.pendingCount(), 0);
assert.equal(deadlineRecovery.harness.windowListenerCount('online'), 0);
assert.equal(deadlineRecovery.harness.windowListenerCount('focus'), 0);
assert.equal(deadlineRecovery.harness.documentListenerCount('visibilitychange'), 0);

const lifecycleRecovery = beginNavigationRecovery();
const lifecycleUrl = lifecycleRecovery.result.url;
lifecycleRecovery.harness.clock.advance(1000);
lifecycleRecovery.harness.emitWindow('online');
assert.deepEqual(lifecycleRecovery.target.navigations.map(entry => entry.at), [0, 1000]);
assert.equal(lifecycleRecovery.harness.clock.pendingCount(), 1,
  'an online retry replaces, rather than duplicates, the pending timer');
lifecycleRecovery.harness.emitWindow('focus');
assert.deepEqual(lifecycleRecovery.target.navigations.map(entry => entry.at), [0, 1000, 1000]);
lifecycleRecovery.harness.win.document.visibilityState = 'hidden';
lifecycleRecovery.harness.emitDocument();
assert.equal(lifecycleRecovery.target.navigations.length, 3,
  'a hidden visibilitychange does not navigate');
lifecycleRecovery.harness.win.document.visibilityState = 'visible';
lifecycleRecovery.harness.emitDocument();
assert.equal(lifecycleRecovery.target.navigations.length, 4,
  'a visible visibilitychange retries immediately');
assert.ok(lifecycleRecovery.target.navigations.every(entry => entry.url === lifecycleUrl));
assert.deepEqual(lifecycleRecovery.target.posts, [], 'lifecycle retries are navigation-only');
lifecycleRecovery.harness.emitMessage({
  origin: `http://${recoveryStationHost}`,
  source: lifecycleRecovery.target,
  data: {
    app: 'LightweaverCardBridge', type: 'ready', host: recoveryStationHost, version: 2,
  },
});
assert.equal(lifecycleRecovery.harness.clock.pendingCount(), 0,
  'an exact verified ready cancels the retry timer');
assert.equal(lifecycleRecovery.harness.windowListenerCount('online'), 0);
assert.equal(lifecycleRecovery.harness.windowListenerCount('focus'), 0);
assert.equal(lifecycleRecovery.harness.documentListenerCount('visibilitychange'), 0);

const responseRecovery = beginNavigationRecovery({
  flowId: 'flow-response-recovery-1234',
  correlation: { ...recoveryCorrelation, handoffGeneration: 12 },
});
const responsePromise = sendCardBridgeRequest('status', {}, {
  host: recoveryStationHost,
  timeoutMs: 1000,
  retryOnTimeout: false,
});
const statusRequest = responseRecovery.target.posts.at(-1)?.message;
assert.equal(statusRequest?.type, 'status');
responseRecovery.harness.emitMessage({
  origin: `http://${recoveryStationHost}`,
  source: responseRecovery.target,
  data: {
    app: 'LightweaverCardBridge', version: 2, id: statusRequest.id, ok: true,
    response: {
      app: 'Lightweaver', provisioningContractVersion: 1,
      cardId: recoveryCorrelation.expectedCardId,
      firmwareVersion: recoveryCorrelation.expectedFirmwareVersion,
      buildId: recoveryCorrelation.expectedBuildId,
      bootId: recoveryCorrelation.expectedBootId,
      runtimePhase: 'ready', knownGoodProject: true, commandReady: true, outputReady: true,
      wifi: {
        transport: 'station', transition: 'station', transitionPending: false,
        apActive: false, stationIp: recoveryStationHost, ip: recoveryStationHost,
        handoffGeneration: 12,
      },
    },
  },
});
await responsePromise;
assert.equal(getCardBridgeState().verified, true);
assert.equal(responseRecovery.harness.clock.pendingCount(), 0,
  'a verified exact-origin request response cancels recovery immediately');
assert.equal(responseRecovery.harness.windowListenerCount('online'), 0);
assert.equal(responseRecovery.harness.windowListenerCount('focus'), 0);
assert.equal(responseRecovery.harness.documentListenerCount('visibilitychange'), 0);

const errorResponseRecovery = beginNavigationRecovery({
  flowId: 'flow-error-response-1234',
  correlation: { ...recoveryCorrelation, handoffGeneration: 120 },
});
const errorResponseStaleCallbacks = [
  ...errorResponseRecovery.harness.windowListeners('online'),
  ...errorResponseRecovery.harness.windowListeners('focus'),
  ...errorResponseRecovery.harness.documentListeners('visibilitychange'),
  ...errorResponseRecovery.harness.clock.callbacks(),
];
const errorResponsePromise = sendCardBridgeRequest('status', {}, {
  host: recoveryStationHost,
  timeoutMs: 1000,
  retryOnTimeout: false,
});
const errorStatusRequest = errorResponseRecovery.target.posts.at(-1)?.message;
assert.equal(errorStatusRequest?.type, 'status', 'handoff reachability uses a read-only request');
errorResponseRecovery.harness.emitMessage({
  origin: `http://${recoveryStationHost}`,
  source: errorResponseRecovery.target,
  data: {
    app: 'LightweaverCardBridge', id: errorStatusRequest.id, ok: false,
    reason: 'card-busy', error: 'Card is still starting.',
  },
});
await assert.rejects(errorResponsePromise, error => error?.reason === 'card-busy');
assert.equal(errorResponseRecovery.harness.clock.pendingCount(), 0,
  'an exact card error response proves navigation and cancels the retry timer');
assert.equal(errorResponseRecovery.harness.windowListenerCount('online'), 0);
assert.equal(errorResponseRecovery.harness.windowListenerCount('focus'), 0);
assert.equal(errorResponseRecovery.harness.documentListenerCount('visibilitychange'), 0);
assert.equal(getCardBridgeState().verified, false,
  'an error response does not grant verified bridge readiness');
assert.equal(getCardBridgeState().identityVerified, false);
assert.equal(getCardBridgeState().runtimeCommandReady, false);
assert.equal(getCardBridgeState().initialConfigAuthority, false);
assert.deepEqual(errorResponseRecovery.target.posts.map(entry => entry.message.type), ['status'],
  'error-response recovery sends no mutation, config, or acknowledgement');
const errorResponseNavigationCount = errorResponseRecovery.target.navigations.length;
errorResponseRecovery.harness.emitWindow('online');
errorResponseRecovery.harness.emitWindow('focus');
errorResponseRecovery.harness.emitDocument();
for (const callback of errorResponseStaleCallbacks) callback();
errorResponseRecovery.harness.clock.advance(300000);
assert.equal(errorResponseRecovery.target.navigations.length, errorResponseNavigationCount,
  'later lifecycle signals and stale callbacks cannot navigate after an exact error response');

const malformedIdentityRecovery = beginNavigationRecovery({
  flowId: 'flow-malformed-identity-1234',
  correlation: { ...recoveryCorrelation, handoffGeneration: 121 },
});
const malformedStaleCallbacks = [
  ...malformedIdentityRecovery.harness.windowListeners('online'),
  ...malformedIdentityRecovery.harness.windowListeners('focus'),
  ...malformedIdentityRecovery.harness.documentListeners('visibilitychange'),
  ...malformedIdentityRecovery.harness.clock.callbacks(),
];
const malformedIdentityPromise = sendCardBridgeRequest('firmware-info', {}, {
  host: recoveryStationHost,
  timeoutMs: 1000,
  retryOnTimeout: false,
});
const malformedIdentityRequest = malformedIdentityRecovery.target.posts.at(-1)?.message;
assert.equal(malformedIdentityRequest?.type, 'firmware-info');
malformedIdentityRecovery.harness.emitMessage({
  origin: `http://${recoveryStationHost}`,
  source: malformedIdentityRecovery.target,
  data: {
    app: 'LightweaverCardBridge', version: 2, id: malformedIdentityRequest.id, ok: true,
    response: { firmwareVersion: '2.0.0', buildId: 'build-navigation-recovery' },
  },
});
await assert.rejects(malformedIdentityPromise, error => error?.reason === 'identity-missing');
assert.equal(malformedIdentityRecovery.harness.clock.pendingCount(), 0,
  'malformed exact-origin firmware identity clears the retry timer');
assert.equal(malformedIdentityRecovery.harness.windowListenerCount('online'), 0);
assert.equal(malformedIdentityRecovery.harness.windowListenerCount('focus'), 0);
assert.equal(malformedIdentityRecovery.harness.documentListenerCount('visibilitychange'), 0);
const malformedNavigationCount = malformedIdentityRecovery.target.navigations.length;
for (const callback of malformedStaleCallbacks) callback();
assert.equal(malformedIdentityRecovery.target.navigations.length, malformedNavigationCount,
  'signals and stale timers cannot navigate after malformed identity invalidates handoff recovery');

const staleHostRecovery = beginNavigationRecovery({
  flowId: 'flow-stale-host-restore-1234',
  correlation: { ...recoveryCorrelation, handoffGeneration: 122 },
});
staleHostRecovery.harness.storageValues.set('lw_chip_card_host', '192.168.18.199');
const staleHostRestore = restoreCardBridgeHandoff('flow-stale-host-restore-1234');
assert.equal(staleHostRestore.reason, 'stale-host');
assert.equal(staleHostRecovery.harness.clock.pendingCount(), 0,
  'stale-host restore rejection clears the active navigation timer');
assert.equal(staleHostRecovery.harness.windowListenerCount('online'), 0);
assert.equal(staleHostRecovery.harness.windowListenerCount('focus'), 0);
assert.equal(staleHostRecovery.harness.documentListenerCount('visibilitychange'), 0);

const duplicateRecovery = beginNavigationRecovery({
  flowId: 'flow-duplicate-recovery-1234',
  correlation: { ...recoveryCorrelation, handoffGeneration: 13 },
});
duplicateRecovery.harness.clock.advance(200000);
const duplicateResult = retargetCardBridge(recoveryStationHost, {
  ...recoveryCorrelation,
  handoffGeneration: 13,
}, { flowId: 'flow-duplicate-recovery-1234' });
assert.equal(duplicateResult.ok, true);
duplicateRecovery.harness.clock.advance(99999);
assert.equal(duplicateRecovery.harness.windowListenerCount('online'), 1);
duplicateRecovery.harness.clock.advance(1);
assert.equal(duplicateRecovery.harness.clock.pendingCount(), 0,
  'duplicate exact retarget evidence cannot extend the original absolute deadline');
assert.equal(duplicateRecovery.harness.windowListenerCount('online'), 0);

const staleRecovery = beginNavigationRecovery({
  flowId: 'flow-stale-recovery-1234',
  correlation: { ...recoveryCorrelation, handoffGeneration: 15 },
});
const staleResult = retargetCardBridge(recoveryStationHost, {
  ...recoveryCorrelation,
  handoffGeneration: 14,
}, { flowId: 'flow-stale-recovery-1234' });
assert.equal(staleResult.reason, 'stale-correlation');
assert.equal(staleRecovery.harness.clock.pendingCount(), 0,
  'stale-correlation rejection releases the prior recovery timer');
assert.equal(staleRecovery.harness.windowListenerCount('online'), 0);
assert.equal(staleRecovery.harness.windowListenerCount('focus'), 0);
assert.equal(staleRecovery.harness.documentListenerCount('visibilitychange'), 0);

const throwingRecovery = beginNavigationRecovery({
  flowId: 'flow-throwing-recovery-1234',
  correlation: { ...recoveryCorrelation, handoffGeneration: 16 },
  throwAssignments: 1,
});
assert.equal(throwingRecovery.result.reason, 'bridge-navigation-failed');
assert.equal(throwingRecovery.harness.clock.pendingCount(), 1,
  'bounded recovery is armed before the initial location assignment');
throwingRecovery.harness.clock.advance(4000);
assert.equal(throwingRecovery.target.navigations.length, 2);
assert.equal(throwingRecovery.target.location.href, throwingRecovery.result.url,
  'a later bounded retry succeeds once location assignment is writable');

const closedSameOwnerRecovery = beginNavigationRecovery({
  flowId: 'flow-closed-same-owner-1234',
  correlation: { ...recoveryCorrelation, handoffGeneration: 161 },
});
const closedSameOwnerNavigationCount = closedSameOwnerRecovery.target.navigations.length;
closedSameOwnerRecovery.target.closed = true;
closedSameOwnerRecovery.harness.emitWindow('online');
assert.equal(closedSameOwnerRecovery.target.navigations.length, closedSameOwnerNavigationCount,
  'a closed active target cannot navigate on the same owner');
assert.equal(closedSameOwnerRecovery.harness.clock.pendingCount(), 0);
assert.equal(closedSameOwnerRecovery.harness.windowListenerCount('online'), 0);
assert.equal(closedSameOwnerRecovery.harness.windowListenerCount('focus'), 0);
assert.equal(closedSameOwnerRecovery.harness.documentListenerCount('visibilitychange'), 0);

const sameOwnerOldRecovery = beginNavigationRecovery({
  flowId: 'flow-same-owner-old-1234',
  correlation: { ...recoveryCorrelation, handoffGeneration: 162 },
});
const sameOwnerOldCallbacks = [
  ...sameOwnerOldRecovery.harness.windowListeners('online'),
  ...sameOwnerOldRecovery.harness.windowListeners('focus'),
  ...sameOwnerOldRecovery.harness.documentListeners('visibilitychange'),
  ...sameOwnerOldRecovery.harness.clock.callbacks(),
];
const sameOwnerSuccessorCorrelation = {
  ...recoveryCorrelation,
  host: '192.168.18.93',
  expectedBootId: 'boot-same-owner-successor',
  handoffGeneration: 163,
};
const sameOwnerSuccessorTarget = recoveryTargetFor(sameOwnerOldRecovery.harness);
sameOwnerOldRecovery.harness.win.open = (url, name) => {
  sameOwnerOldRecovery.harness.opened.push({ url, name });
  return sameOwnerSuccessorTarget;
};
assert.equal(openLocalCardPage(recoveryApHost).ok, true);
const sameOwnerSuccessorResult = retargetCardBridge(
  sameOwnerSuccessorCorrelation.host,
  sameOwnerSuccessorCorrelation,
  { flowId: 'flow-same-owner-successor-1234' },
);
assert.equal(sameOwnerSuccessorResult.ok, true);
assert.equal(sameOwnerOldRecovery.harness.clock.pendingCount(), 1,
  'same-owner successor leaves exactly its one timer');
assert.equal(sameOwnerOldRecovery.harness.windowListenerCount('online'), 1);
assert.equal(sameOwnerOldRecovery.harness.windowListenerCount('focus'), 1);
assert.equal(sameOwnerOldRecovery.harness.documentListenerCount('visibilitychange'), 1);
const sameOwnerOldNavigationCount = sameOwnerOldRecovery.target.navigations.length;
const sameOwnerSuccessorNavigationCount = sameOwnerSuccessorTarget.navigations.length;
for (const callback of sameOwnerOldCallbacks) callback();
assert.equal(sameOwnerOldRecovery.target.navigations.length, sameOwnerOldNavigationCount,
  'stale same-owner callbacks cannot navigate their replaced target');
assert.equal(sameOwnerSuccessorTarget.navigations.length, sameOwnerSuccessorNavigationCount,
  'stale same-owner callbacks cannot navigate the accepted successor');
assert.equal(sameOwnerOldRecovery.harness.clock.pendingCount(), 1,
  'stale same-owner callbacks cannot clear the successor timer');
assert.equal(sameOwnerOldRecovery.harness.windowListenerCount('online'), 1);
assert.equal(sameOwnerOldRecovery.harness.windowListenerCount('focus'), 1);
assert.equal(sameOwnerOldRecovery.harness.documentListenerCount('visibilitychange'), 1);

const oldRecovery = beginNavigationRecovery({
  flowId: 'flow-old-owner-recovery-1234',
  correlation: { ...recoveryCorrelation, handoffGeneration: 17 },
});
const staleWindowCallbacks = [
  ...oldRecovery.harness.windowListeners('online'),
  ...oldRecovery.harness.windowListeners('focus'),
];
const staleDocumentCallbacks = oldRecovery.harness.documentListeners('visibilitychange');
const staleTimerCallbacks = oldRecovery.harness.clock.callbacks();
oldRecovery.target.closed = true;
const successorCorrelation = {
  ...recoveryCorrelation,
  host: '192.168.18.92',
  expectedBootId: 'boot-successor-recovery',
  handoffGeneration: 18,
};
const successorRecovery = beginNavigationRecovery({
  host: successorCorrelation.host,
  flowId: 'flow-successor-recovery-1234',
  correlation: successorCorrelation,
});
assert.equal(oldRecovery.harness.clock.pendingCount(), 0,
  'replacing the listener owner releases the old owner recovery resources');
assert.equal(oldRecovery.harness.windowListenerCount('online'), 0);
assert.equal(oldRecovery.harness.windowListenerCount('focus'), 0);
assert.equal(oldRecovery.harness.documentListenerCount('visibilitychange'), 0);
const successorNavigationCount = successorRecovery.target.navigations.length;
for (const callback of [...staleWindowCallbacks, ...staleDocumentCallbacks, ...staleTimerCallbacks]) callback();
assert.equal(oldRecovery.target.navigations.length, 1,
  'stale callbacks cannot navigate their closed former target');
assert.equal(successorRecovery.target.navigations.length, successorNavigationCount,
  'stale owner/flow/correlation callbacks cannot navigate the successor target');
assert.equal(successorRecovery.harness.clock.pendingCount(), 1,
  'stale callbacks cannot clear the successor timer');
assert.equal(successorRecovery.harness.windowListenerCount('online'), 1,
  'stale callbacks cannot clear successor lifecycle listeners');

// A station page reached through the correlated WiFi handoff cannot restore
// command authority with a wrong/stale status envelope. Only an exact fresh
// station status for the card, boot, generation, firmware, and build unlocks it.
const apHost = '192.168.4.1';
const stationHost = '192.168.18.90';
const handoffIdentity = {
  id: 'lw-handoff090',
  firmwareVersion: '1.2.3',
  buildId: 'build-handoff-090',
};
const handoffCorrelation = {
  host: stationHost,
  expectedCardId: handoffIdentity.id,
  expectedFirmwareVersion: handoffIdentity.firmwareVersion,
  expectedBuildId: handoffIdentity.buildId,
  expectedBootId: 'boot-handoff-090',
  handoffGeneration: 9,
};
let stationStatus = null;
let stationFirmwareIdentity = handoffIdentity;
let suppressStationStatus = false;
let handoffHarness;
const handoffMessages = [];
let handoffNavigationCount = 0;
let handoffHref = '';
const handoffTab = {
  closed: false,
  location: {
    get href() { return handoffHref; },
    set href(value) { handoffHref = String(value); handoffNavigationCount += 1; },
  },
  postMessage(message) {
    handoffMessages.push({ message });
    if (message.type === 'status' && suppressStationStatus) return;
    const response = message.type === 'firmware-info'
      ? {
        cardId: stationFirmwareIdentity.id,
        firmwareVersion: stationFirmwareIdentity.firmwareVersion,
        buildId: stationFirmwareIdentity.buildId,
      }
      : message.type === 'status'
        ? stationStatus
        : { ok: true };
    setTimeout(() => handoffHarness.emitMessage({
      origin: `http://${stationHost}`,
      source: handoffTab,
      data: { app: 'LightweaverCardBridge', version: 2, id: message.id, ok: true, response },
    }), 0);
  },
  focus() {},
};
handoffHarness = bridgeWindowHarness({ host: apHost, openResult: handoffTab });
handoffHarness.win.location.href = 'https://led.mandalacodes.com/#screen=production';
handoffHarness.win.location.origin = 'https://led.mandalacodes.com';
handoffHarness.storageValues.set('lw_card_identity_v1', JSON.stringify({
  version: 1,
  id: 'lw-prior-card-a', firmwareVersion: '1.2.3', buildId: 'build-prior-card-a',
}));
globalThis.window = handoffHarness.win;
assert.equal(openLocalCardPage(apHost).ok, true);
await assert.rejects(
  sendCardBridgeRequest('wifi-handoff-ack', {}, { host: apHost, timeoutMs: 25 }),
  error => error?.reason === 'handoff-correlation',
  'the AP page can never relay a handoff acknowledgement',
);
const commissioningFlowId = 'flow-card-b-commission-1234';
assert.equal(retargetCardBridge(stationHost, handoffCorrelation, { flowId: commissioningFlowId }).ok, true);
assert.equal(handoffHarness.opened.length, 1, 'handoff reuses the AP WindowProxy');
assert.notEqual(handoffHarness.storageValues.get('lw_chip_card_host'), stationHost,
  'AP handoff evidence alone cannot persist the preferred station host');

stationStatus = {
  app: 'Lightweaver', provisioningContractVersion: 1,
  cardId: handoffIdentity.id,
  firmwareVersion: handoffIdentity.firmwareVersion,
  buildId: handoffIdentity.buildId,
  bootId: handoffCorrelation.expectedBootId, runtimePhase: 'factory', knownGoodProject: false,
  mode: 'factory-flash', source: 'defaults',
  commandReady: false, outputReady: true,
  wifi: {
    transport: 'ap', transition: 'handoff-ready', transitionPending: true,
    apActive: true, stationIp: stationHost, ip: stationHost, handoffGeneration: 9,
  },
};
handoffHarness.emitMessage({
  origin: `http://${stationHost}`,
  source: handoffTab,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: stationHost, version: 2 },
});
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(getCardBridgeState().identityVerified, false,
  'handoff-ready proof grants only acknowledgement authority');
assert.equal(getCardBridgeState().handoffAckReady, true);
await assert.rejects(
  sendCardBridgeRequest('control', {}, { host: stationHost, timeoutMs: 25 }),
  error => error?.reason === 'handoff-awaiting-ack',
  'normal commands remain locked before final station state',
);
const messagesBeforeAckTimeout = handoffMessages.length;
suppressStationStatus = true;
await assert.rejects(
  sendCardBridgeRequest('status', {}, { host: stationHost, timeoutMs: 15, retryOnTimeout: false }),
  error => error?.reason === 'bridge-timeout',
);
assert.equal(getCardBridgeState().handoffAckReady, false,
  'any bridge timeout revokes the current-lifecycle acknowledgement latch');
suppressStationStatus = false;
await sendCardBridgeRequest('ping', {}, { host: stationHost, timeoutMs: 100 });
await sendCardBridgeRequest('firmware-info', {}, { host: stationHost, timeoutMs: 100 });
await assert.rejects(
  sendCardBridgeRequest('wifi-handoff-ack', {}, { host: stationHost, timeoutMs: 25 }),
  error => error?.reason === 'handoff-correlation',
  'identity-free transport recovery cannot restore acknowledgement authority',
);
assert.equal(
  handoffMessages.slice(messagesBeforeAckTimeout).filter(entry => entry.message.type === 'wifi-handoff-ack').length,
  0,
  'no acknowledgement is posted after timeout without fresh exact status evidence',
);
handoffHarness.emitMessage({
  origin: `http://${stationHost}`,
  source: handoffTab,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: stationHost, version: 2 },
});
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(getCardBridgeState().handoffAckReady, true,
  'fresh exact handoff status in the current lifecycle can grant a new acknowledgement latch');
await sendCardBridgeRequest('wifi-handoff-ack', {}, { host: stationHost, timeoutMs: 100 });

stationStatus = {
  ...stationStatus,
  wifi: {
    ...stationStatus.wifi,
    transport: 'station',
    transition: 'station',
    transitionPending: false,
    apActive: false,
    ip: stationHost,
  },
};
await sendCardBridgeRequest('status', {}, { host: stationHost, timeoutMs: 100 });
assert.equal(getCardBridgeState().identityVerified, true,
  'exact blank final station verifies identity without granting runtime write authority');
assert.equal(getCardBridgeState().runtimeCommandReady, false);
assert.equal(getCardBridgeState().initialConfigAuthority, true);
await sendCardBridgeRequest('firmware-info', {}, { host: stationHost, timeoutMs: 100 });
assert.equal(getCardBridgeState().identityVerified, true,
  'an exact same-card firmware read preserves current-lifecycle station identity authority');
assert.equal(getCardBridgeState().initialConfigAuthority, true,
  'an exact same-card firmware read preserves current-lifecycle blank config authority');

const blankRuntimePackage = makeCardRuntimePackage({
  projectName: 'Commissioned card B',
  mode: 'website-flash',
  led: {
    pixels: 44,
    colorOrder: 'GRB',
    brightnessLimit: 0.5,
    outputs: [{ id: 'main', name: 'Main', pin: 16, pixels: 44 }],
  },
});
const messagesBeforeInitialPush = handoffMessages.length;
const initialConfig = await pushConfigToCard(blankRuntimePackage, {
  host: stationHost, timeoutMs: 100, reboot: 'if-needed',
  commissioningFlowId, allowProjectChange: true, allowLayoutChange: true,
});
assert.equal(initialConfig.ok, true,
  'exact blank final station authority permits the one initial commissioning config');
const initialPushTypes = handoffMessages
  .slice(messagesBeforeInitialPush)
  .map(entry => entry.message.type);
assert.deepEqual(initialPushTypes, ['config'],
  'blank commissioning sends one complete config without firmware/layout or wiring-candidate probes');
assert.equal(
  JSON.parse(handoffHarness.sessionValues.get('lw_wifi_handoff_recovery_v1')).configAttempted,
  true,
  'the one-way config attempt is durable before the response can be trusted',
);
await assert.rejects(
  sendCardBridgeRequest('config', { project: 'duplicate' }, {
    host: stationHost, timeoutMs: 25, commissioningFlowId,
  }),
  error => error?.reason === 'runtime-not-ready',
  'blank-card config authority is consumed before the first write response',
);
await assert.rejects(
  sendCardBridgeRequest('control', {}, { host: stationHost, timeoutMs: 25 }),
  error => error?.reason === 'runtime-not-ready',
  'the lower bridge write guard remains locked until commandReady is explicitly true',
);
await assert.rejects(
  sendCardBridgeRequest('frame', {}, { host: stationHost, timeoutMs: 25 }),
  error => error?.reason === 'runtime-not-ready',
  'blank-card commissioning authority never grants light/frame mutation authority',
);

stationStatus = { ...stationStatus, bootId: 'boot-stale-after-config' };
await sendCardBridgeRequest('status', {}, { host: stationHost, timeoutMs: 100 });
assert.equal(getCardBridgeState().identityVerified, false,
  'a stale station boot immediately revokes current-lifecycle authority');
stationStatus = { ...stationStatus, bootId: handoffCorrelation.expectedBootId };
await sendCardBridgeRequest('status', {}, { host: stationHost, timeoutMs: 100 });

stationFirmwareIdentity = { ...handoffIdentity, buildId: 'hostile-partial-build' };
await sendCardBridgeRequest('firmware-info', {}, { host: stationHost, timeoutMs: 100 });
assert.equal(getCardBridgeState().identityVerified, false,
  'mismatched read-only identity evidence revokes station authority');
assert.equal(getCardBridgeState().initialConfigAuthority, false,
  'mismatched read-only identity evidence revokes config authority');
stationFirmwareIdentity = handoffIdentity;
await sendCardBridgeRequest('status', {}, { host: stationHost, timeoutMs: 100 });

stationStatus = {
  ...stationStatus,
  runtimePhase: 'ready', knownGoodProject: true,
  commandReady: true,
};
await sendCardBridgeRequest('status', {}, { host: stationHost, timeoutMs: 100 });
assert.equal(getCardBridgeState().identityVerified, true,
  'an exact fresh station status restores the expected card authority');
assert.equal(getCardBridgeState().runtimeCommandReady, true);
assert.equal(handoffHarness.storageValues.get('lw_chip_card_host'), stationHost,
  'preferred host persists only after exact final station verification');
await sendCardBridgeRequest('control', {}, { host: stationHost, timeoutMs: 100 });
const messagesBeforeTimeout = handoffMessages.length;
suppressStationStatus = true;
await assert.rejects(
  sendCardBridgeRequest('status', {}, { host: stationHost, timeoutMs: 15, retryOnTimeout: false }),
  error => error?.reason === 'bridge-timeout',
);
assert.equal(getCardBridgeState().connected, false);
assert.equal(getCardBridgeState().identityVerified, false,
  'status timeout synchronously revokes station identity authority');
assert.equal(getCardBridgeState().runtimeCommandReady, false,
  'status timeout synchronously revokes runtime command authority');
assert.equal(getCardBridgeState().initialConfigAuthority, false,
  'status timeout synchronously revokes initial config authority');
await assert.rejects(
  sendCardBridgeRequest('control', {}, { host: stationHost, timeoutMs: 15 }),
  error => ['identity-missing', 'runtime-not-ready', 'bridge-timeout'].includes(error?.reason),
);
await assert.rejects(
  sendCardBridgeRequest('config', {}, {
    host: stationHost, timeoutMs: 15, commissioningFlowId,
  }),
  error => ['identity-missing', 'runtime-not-ready', 'bridge-timeout'].includes(error?.reason),
);
assert.deepEqual(
  handoffMessages.slice(messagesBeforeTimeout).map(entry => entry.message.type),
  ['status'],
  'no mutation is posted after liveness loss',
);
suppressStationStatus = false;
stationStatus = { ...stationStatus, commandReady: false };
await sendCardBridgeRequest('status', {}, { host: stationHost, timeoutMs: 100 });
assert.equal(getCardBridgeState().runtimeCommandReady, false);
await assert.rejects(
  sendCardBridgeRequest('control', {}, { host: stationHost, timeoutMs: 25 }),
  error => error?.reason === 'runtime-not-ready',
  'a later commandReady:false status immediately revokes runtime mutation authority',
);
const completedRepeat = retargetCardBridge(stationHost, handoffCorrelation, { flowId: commissioningFlowId });
assert.equal(completedRepeat.state, 'already-retargeted');
assert.equal(handoffNavigationCount, 1,
  'duplicate AP evidence cannot reload a station bridge that already answered');

console.log('card-bridge-handoff tests passed');
