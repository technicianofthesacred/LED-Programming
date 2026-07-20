import assert from 'node:assert/strict';
import {
  CARD_BRIDGE_WINDOW_NAME,
  acquireCardBridgeFromGesture,
  adoptDiscoveredCardBridgeIdentity,
  buildCardBridgeLaunchUrl,
  bootstrapCardBridgeFromOpener,
  cardBridgeAutoPreviewEnabled,
  getCardBridgeState,
  isCardBridgeLaunch,
  openCardBridge,
  openLocalCardPage,
  sendCardBridgeRequest,
  rePairDiscoveredCardBridgeIdentity,
  verifyCardBridgeIdentity,
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
assert.equal(handoff.hash, '#studioBridge=1');
assert.equal(handoff.search, '', 'Studio must not pass an auto-open URL through the card query string');
assert.equal(handoff.searchParams.has('studioAutoOpen'), false);
assert.equal(handoff.searchParams.has('studioUrl'), false);
assert.equal(handoff.href.includes('deployCheck=123'), false, 'arbitrary Studio URL data is never forwarded to the card');

const messages = [];
const storedIdentityValues = new Map([['lw_chip_card_host', '192.168.18.70']]);
let firmwareCardId = 'lw-handoff-test';
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
        data: { app: 'LightweaverCardBridge', id: message.id, ok: true, response: { ok: true } },
      }), 0);
      return;
    }
    stageTimeoutMessages.push({ message, targetOrigin });
  },
};
globalThis.window.parent = stageTimeoutParent;
assert.equal(bootstrapCardBridgeFromOpener(), true);
await verifyCardBridgeIdentity('192.168.18.70');
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
  const identityId = `lw-${String(host).replace(/[^a-z0-9]/gi, '')}`;
  const storageValues = new Map([
    ['lw_chip_card_host', host],
    ['lw_card_identity_v1', JSON.stringify({ version: 1, id: identityId })],
  ]);
  const win = {
    location: {
      href: 'https://led.mandalacodes.com/#screen=patterns',
      search: opener || parent ? `?cardBridge=1&cardHost=${host}` : '',
    },
    opener,
    parent,
    localStorage: {
      getItem: key => storageValues.get(key) ?? null,
      setItem: (key, value) => storageValues.set(key, value),
      removeItem: key => storageValues.delete(key),
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
    storageValues,
    emitMessage(event) {
      for (const listener of eventListeners.get('message') || []) listener(event);
    },
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
await assert.rejects(delayedARequest, error => error?.reason === 'stale-host');
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

// openLocalCardPage: every plain "open the card page" click routes through the
// SAME named window the bridge uses, so at most one auxiliary card tab exists.
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
assert.equal(cardPageHarness.opened[0].url, `http://${cardPageHost}/`);
const secondVisit = openLocalCardPage(cardPageHost, { path: '/', reason: 'open-card-page' });
assert.equal(secondVisit.ok, true);
assert.equal(secondVisit.window, firstVisit.window, 'repeat visits reuse the same named window handle');
assert.equal(cardPageHarness.opened[1].name, CARD_BRIDGE_WINDOW_NAME);
assert.equal(cardPageTab.focusCalls, 2, 'the already-open card tab is refocused');

// A plain visit tracks the tab but never grants transport readiness: privileged
// sends stay identity-locked until the freshly loaded page handshakes again.
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
const revisitParent = {
  postMessage(message) {
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
};
const revisitTab = { closed: false, postMessageCalls: 0, postMessage() { this.postMessageCalls += 1; }, focus() {} };
revisitHarness = bridgeWindowHarness({ host: revisitHost, parent: revisitParent, openResult: revisitTab });
globalThis.window = revisitHarness.win;
assert.equal(bootstrapCardBridgeFromOpener(), true);
revisitHarness.emitMessage({
  origin: `http://${revisitHost}`,
  source: revisitParent,
  data: { app: 'LightweaverCardBridge', type: 'ready', host: revisitHost, version: 1 },
});
await verifyCardBridgeIdentity(revisitHost);
assert.equal(getCardBridgeState().identityVerified, true);
assert.equal(openLocalCardPage(revisitHost).ok, true);
assert.equal(getCardBridgeState().verified, false, 'the plain visit revokes the stale bridge handshake');
assert.equal(getCardBridgeState().card, null, 'verified identity is dropped until the new page re-verifies');
await assert.rejects(
  sendCardBridgeRequest('control', { patternId: 'fire' }, { host: revisitHost, timeoutMs: 25 }),
  error => error?.reason === 'identity-missing',
);
assert.equal(revisitTab.postMessageCalls, 0);

// Blocked popups and non-local hosts fail closed with caller-visible reasons.
const blockedVisitHarness = bridgeWindowHarness({ host: '192.168.18.79', openResult: null });
globalThis.window = blockedVisitHarness.win;
assert.deepEqual(openLocalCardPage('192.168.18.79'), { ok: false, reason: 'popup-blocked' });
assert.equal(blockedVisitHarness.opened.length, 1);
assert.deepEqual(openLocalCardPage('evil.example.com'), { ok: false, reason: 'invalid-host' });
assert.deepEqual(openLocalCardPage('192.168.18.79', { path: '//evil.example/' }), { ok: false, reason: 'invalid-host' });
assert.equal(blockedVisitHarness.opened.length, 1, 'invalid hosts and paths never reach window.open');

console.log('card-bridge-handoff tests passed');
