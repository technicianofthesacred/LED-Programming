import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CARD_CONNECTION_ACTION_IDS,
  isCardLinkConnected,
  nextCardConnectionAction,
} from './cardConnectionFlow.js';

const CARD_ID = 'lw-aabbccddeeff';

function readyEnvelope(overrides = {}) {
  return {
    app: 'Lightweaver',
    provisioningContractVersion: 1,
    cardId: CARD_ID,
    firmwareVersion: '1.0.0',
    buildId: 'a'.repeat(40),
    bootId: 'boot-1',
    runtimePhase: 'ready',
    knownGoodProject: true,
    commandReady: true,
    outputReady: true,
    ...overrides,
  };
}

function readyLink(overrides = {}) {
  return {
    state: 'connected-direct',
    card: { id: CARD_ID },
    readiness: readyEnvelope(),
    ...overrides,
  };
}

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
    'pair-local-card',
    'card-needs-project',
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

test('provides explicit legacy behavior metadata while live consumers migrate', () => {
  const cases = [
    [{ intent: 'blank-card', capabilities: secureBrowserUsb }, 'web-serial-install'],
    [{ intent: 'blank-card', capabilities: insecureChromeFrame }, 'supported-browser-handoff'],
    [{ link: readyLink() }, 'connected'],
    [{ link: { reason: 'firmware-too-old' }, capabilities: secureBrowserUsb }, 'web-serial-install'],
    [{ intent: 'blank-card', capabilities: { platform: 'macos' } }, 'supported-browser-handoff'],
    [{ link: { reason: 'native-bridge-missing' } }, 'connector-fallback'],
    [{ intent: 'blank-card', capabilities: { platform: 'ios', isMobile: true } }, 'supported-device-handoff'],
    [{ link: { reason: 'wrong-card' } }, 'reconnect-known-card'],
    [{ link: { reason: 'no-answer' } }, 'retry-card-page'],
    [{ link: { reason: 'preview-unconfirmed' } }, 'connector-fallback'],
  ];

  for (const [input, legacyId] of cases) {
    assert.equal(nextCardConnectionAction(input).legacyId, legacyId);
  }
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
  assert.equal(action.title, 'Open secure installer');
  assert.equal(action.primaryLabel, 'Open secure installer');
  assert.match(action.explanation, /inside the local card page/i);
  assert.doesNotMatch(`${action.title} ${action.explanation}`, /unsupported|supported browser/i);
  assert.match(`${action.title} ${action.explanation}`, /open|Studio|secure/i);
});

test('explicit install and recovery intents outrank stale transient connection reasons', () => {
  for (const intent of ['blank-card', 'deep-recovery']) {
    for (const reason of ['never-connected', 'card-unreachable']) {
      assert.equal(nextCardConnectionAction({
        intent,
        link: { state: 'disconnected', reason },
        capabilities: secureBrowserUsb,
      }).id, 'ready-browser-usb', `${intent}: ${reason}`);
    }
  }
});

test('uncertain writes and wrong-card failures still outrank explicit install intent', () => {
  assert.equal(nextCardConnectionAction({
    intent: 'blank-card',
    link: { reason: 'preview-unconfirmed' },
    capabilities: secureBrowserUsb,
  }).id, 'needs-safe-recovery');
  assert.equal(nextCardConnectionAction({
    intent: 'deep-recovery',
    link: { reason: 'wrong-card' },
    capabilities: secureBrowserUsb,
  }).id, 'wrong-card');
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

test('native bridge states do not promise an app action that is not built', () => {
  for (const input of [
    { intent: 'blank-card', capabilities: { platform: 'macos', isMobile: false } },
    { link: { reason: 'native-bridge-missing' }, capabilities: { platform: 'windows', isMobile: false } },
  ]) {
    const result = nextCardConnectionAction(input);
    assert.match(result.explanation, /not available yet/i);
    assert.doesNotMatch(`${result.title} ${result.primaryLabel}`, /open USB helper|install USB helper/i);
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

test('keeps setup-network compatibility as an explicit recoverable route', () => {
  for (const input of [
    { intent: 'working-card', setupMode: true },
    { intent: 'working-card', setupNetwork: { available: true, ssid: 'Lightweaver-1234' } },
  ]) {
    const result = nextCardConnectionAction(input);
    assert.equal(result.id, 'recoverable-failure');
    assert.equal(result.route, 'setup-network');
    assert.equal(result.primaryLabel, 'Continue');
    assert.match(result.explanation, /setup network/i);
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
    link: readyLink(),
  }).id, 'ready-local-card');
  assert.notEqual(nextCardConnectionAction({
    link: { state: 'connected-direct', card: null },
    intent: 'working-card',
  }).id, 'ready-local-card');
});

test('offers one-tap pairing for a reachable-but-unpaired card', () => {
  const byReason = nextCardConnectionAction({
    link: { state: 'disconnected', reason: 'found-unpaired', discoveredCard: { id: 'lw-found' } },
    discoveredCard: { id: 'lw-found' },
  });
  assert.equal(byReason.id, 'pair-local-card');
  assert.equal(byReason.secondaryAction?.id, 'adopt-discovered-card');

  const byDiscovery = nextCardConnectionAction({
    link: { state: 'disconnected', reason: 'card-unreachable' },
    discoveredCard: { id: 'lw-found' },
    rememberedCard: null,
  });
  assert.equal(byDiscovery.id, 'pair-local-card');
});

test('routes classified factory evidence to install, not ready-local-card', () => {
  const action = nextCardConnectionAction({
    link: readyLink({
      readiness: readyEnvelope({ runtimePhase: 'factory', knownGoodProject: false }),
      cardBlank: true,
    }),
  });
  assert.equal(action.id, 'card-needs-project');
  assert.notEqual(action.id, 'ready-local-card');
});

test('a classified configured card is still ready-local-card', () => {
  assert.equal(nextCardConnectionAction({
    link: readyLink({ cardBlank: false }),
  }).id, 'ready-local-card');
});

test('unknown blank state and transport-only links never become connected', () => {
  const transportOnly = { state: 'connected-direct', card: { id: CARD_ID } };
  const oldStatus = {
    state: 'connected-direct',
    card: { id: CARD_ID },
    readiness: { app: 'Lightweaver', cardId: CARD_ID, mode: 'run' },
  };

  assert.equal(isCardLinkConnected(transportOnly), false);
  assert.equal(isCardLinkConnected(oldStatus), false);
  assert.notEqual(nextCardConnectionAction({ link: transportOnly }).id, 'ready-local-card');
  assert.notEqual(nextCardConnectionAction({ link: oldStatus }).id, 'ready-local-card');
});

test('card link connection consumes classified fresh evidence', () => {
  assert.equal(isCardLinkConnected(readyLink()), true);
  assert.equal(isCardLinkConnected(readyLink({
    readiness: readyEnvelope({ bootId: 'boot-2' }),
    previousBootId: 'boot-1',
  })), false);
  assert.equal(isCardLinkConnected(readyLink({
    readiness: readyEnvelope({ cardId: 'lw-other' }),
  })), false);
});

test('all action copy is physical-action oriented and avoids implementation jargon', () => {
  const inputs = [
    { intent: 'blank-card', capabilities: secureBrowserUsb },
    { intent: 'blank-card', capabilities: insecureChromeFrame },
    { link: readyLink() },
    { link: { reason: 'firmware-too-old' }, capabilities: secureBrowserUsb },
    { intent: 'blank-card', capabilities: { secureContext: true, topLevel: true, platform: 'macos' } },
    { link: { reason: 'native-bridge-missing' }, capabilities: { secureContext: true, topLevel: true, platform: 'macos' } },
    { intent: 'blank-card', capabilities: { platform: 'android', isMobile: true } },
    { link: { reason: 'wrong-card' } },
    { link: { reason: 'no-answer' } },
    { link: { reason: 'preview-unconfirmed' } },
    { link: { state: 'disconnected', reason: 'found-unpaired', discoveredCard: { id: 'lw-a' } }, discoveredCard: { id: 'lw-a' } },
    { link: readyLink({ readiness: readyEnvelope({ runtimePhase: 'factory', knownGoodProject: false }), cardBlank: true }) },
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
