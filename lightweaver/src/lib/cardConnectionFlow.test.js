import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_CONNECTION_ACTION_IDS,
  nextCardConnectionAction,
} from './cardConnectionFlow.js';

const secureBrowserUsb = {
  secureContext: true,
  topLevel: true,
  embedded: false,
  canWebSerialInstall: true,
  mustEscapeToSecureInstaller: false,
  platform: 'macos',
  isMobile: false,
};

const insecureChromeFrame = {
  secureContext: false,
  topLevel: false,
  embedded: true,
  canWebSerialInstall: false,
  mustEscapeToSecureInstaller: true,
  platform: 'macos',
  isMobile: false,
};

test('exports the exact approved orchestrator vocabulary', () => {
  assert.deepEqual(CARD_CONNECTION_ACTION_IDS, [
    'ready-browser-usb',
    'escape-insecure-card-frame',
    'ready-local-card',
    'needs-card-update',
    'launch-native-bridge',
    'install-native-bridge',
    'handoff-supported-device',
    'wrong-card',
    'recoverable-failure',
    'needs-safe-recovery',
  ]);
  assert.equal(Object.isFrozen(CARD_CONNECTION_ACTION_IDS), true);
});

test('routes a secure top-level Web Serial page to browser USB', () => {
  assert.equal(nextCardConnectionAction({
    intent: 'blank-card',
    capabilities: secureBrowserUsb,
  }).id, 'ready-browser-usb');
});

test('escapes an insecure embedded card frame before considering desktop fallback', () => {
  const action = nextCardConnectionAction({
    intent: 'blank-card',
    capabilities: insecureChromeFrame,
  });

  assert.equal(action.id, 'escape-insecure-card-frame');
  assert.doesNotMatch(`${action.title} ${action.explanation}`, /unsupported|supported browser/i);
  assert.match(`${action.title} ${action.explanation}`, /open|Studio|secure/i);
});

test('launches the desktop native bridge when browser USB is unavailable', () => {
  for (const intent of ['blank-card', 'deep-recovery']) {
    assert.equal(nextCardConnectionAction({
      intent,
      capabilities: {
        secureContext: true,
        topLevel: true,
        canWebSerialInstall: false,
        platform: 'windows',
        isMobile: false,
      },
    }).id, 'launch-native-bridge', intent);
  }
});

test('offers native bridge installation after an exact missing-bridge failure', () => {
  assert.equal(nextCardConnectionAction({
    intent: 'blank-card',
    link: { state: 'disconnected', reason: 'native-bridge-missing' },
    capabilities: { secureContext: true, topLevel: true, platform: 'linux', isMobile: false },
  }).id, 'install-native-bridge');
});

test('hands mobile installation and recovery to a supported device', () => {
  for (const intent of ['blank-card', 'deep-recovery']) {
    assert.equal(nextCardConnectionAction({
      intent,
      capabilities: { secureContext: true, topLevel: true, platform: 'ios', isMobile: true },
    }).id, 'handoff-supported-device', intent);
  }
});

test('routes identity-missing and firmware-too-old cards to card update', () => {
  for (const reason of ['identity-missing', 'firmware-too-old']) {
    assert.equal(nextCardConnectionAction({
      intent: 'working-card',
      link: { state: 'disconnected', reason },
      capabilities: secureBrowserUsb,
    }).id, 'needs-card-update', reason);
  }
});

test('escapes an insecure embedded update before selecting an update transport', () => {
  assert.equal(nextCardConnectionAction({
    intent: 'working-card',
    link: { state: 'disconnected', reason: 'firmware-too-old' },
    capabilities: insecureChromeFrame,
  }).id, 'escape-insecure-card-frame');
});

test('reports an exact wrong-card result without silently adopting it', () => {
  const action = nextCardConnectionAction({
    intent: 'working-card',
    link: { state: 'disconnected', reason: 'wrong-card' },
    expectedCard: { id: 'lw-expected', name: 'Gallery Mandala' },
    detectedCard: { id: 'lw-detected', name: 'Workshop Ring' },
  });

  assert.equal(action.id, 'wrong-card');
  assert.match(action.explanation, /Gallery Mandala/);
  assert.match(action.explanation, /Workshop Ring/);
  assert.deepEqual(action.secondaryAction, {
    id: 'adopt-discovered-card',
    label: 'Use this card instead',
  });
});

test('turns bounded transient link failures into a retryable state', () => {
  for (const reason of ['popup-blocked', 'no-answer', 'card-page-closed']) {
    assert.equal(nextCardConnectionAction({
      intent: 'working-card',
      link: { state: 'disconnected', reason },
    }).id, 'recoverable-failure', reason);
  }
});

test('requires safe recovery when a write or recovery result is uncertain', () => {
  for (const reason of ['preview-unconfirmed', 'recovery-unconfirmed']) {
    assert.equal(nextCardConnectionAction({
      intent: 'deep-recovery',
      link: { state: 'disconnected', reason },
      capabilities: secureBrowserUsb,
    }).id, 'needs-safe-recovery', reason);
  }
});

test('reports ready-local-card only after a verified local connection', () => {
  assert.equal(nextCardConnectionAction({
    link: { state: 'connected-direct', card: { id: 'lw-a' } },
  }).id, 'ready-local-card');
  assert.notEqual(nextCardConnectionAction({
    link: { state: 'connected-direct', card: null },
    intent: 'working-card',
  }).id, 'ready-local-card');
});

test('all action copy is physical-action oriented and avoids implementation jargon', () => {
  const inputs = [
    { intent: 'blank-card', capabilities: secureBrowserUsb },
    { intent: 'blank-card', capabilities: insecureChromeFrame },
    { link: { state: 'connected-direct', card: { id: 'lw-a' } } },
    { link: { reason: 'firmware-too-old' }, capabilities: secureBrowserUsb },
    { intent: 'blank-card', capabilities: { secureContext: true, topLevel: true, platform: 'macos' } },
    { link: { reason: 'native-bridge-missing' }, capabilities: { secureContext: true, topLevel: true, platform: 'macos' } },
    { intent: 'blank-card', capabilities: { platform: 'android', isMobile: true } },
    { link: { reason: 'wrong-card' } },
    { link: { reason: 'no-answer' } },
    { link: { reason: 'preview-unconfirmed' } },
  ];
  const forbidden = /mixed content|postMessage|Web Serial|localhost|(?:\d{1,3}\.){3}\d{1,3}|Chrome is unsupported/i;

  for (const input of inputs) {
    const action = nextCardConnectionAction(input);
    assert.equal(typeof action.title, 'string', action.id);
    assert.equal(typeof action.explanation, 'string', action.id);
    assert.equal(typeof action.primaryLabel, 'string', action.id);
    assert.doesNotMatch(`${action.title} ${action.explanation} ${action.primaryLabel}`, forbidden, action.id);
  }
});
