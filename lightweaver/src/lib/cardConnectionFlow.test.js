import test from 'node:test';
import assert from 'node:assert/strict';

import { nextCardConnectionAction } from './cardConnectionFlow.js';

const actionCases = [
  ['connected', { link: { state: 'connected-bridge', card: { id: 'lw-a' } } }, 'connected'],
  ['reconnecting', { link: { state: 'connecting', activity: 'pending' }, intent: 'blank-card', capabilities: { canWebSerialInstall: true } }, 'reconnect-known-card'],
  ['choose condition', {}, 'choose-card-condition'],
  ['setup network', { intent: 'working-card', setupMode: true }, 'open-setup-network'],
  ['open card page', { intent: 'working-card' }, 'open-card-page'],
  ['retry card page', { link: { state: 'disconnected', reason: 'popup-blocked' }, intent: 'working-card' }, 'retry-card-page'],
  ['install', { intent: 'blank-card', capabilities: { canWebSerialInstall: true } }, 'web-serial-install'],
  ['browser handoff', { intent: 'blank-card', capabilities: { canWebSerialInstall: false, handoffKind: 'supported-browser-handoff' } }, 'supported-browser-handoff'],
  ['device handoff', { intent: 'blank-card', capabilities: { canWebSerialInstall: false, handoffKind: 'supported-device-handoff' } }, 'supported-device-handoff'],
  ['connector fallback', { intent: 'deep-recovery', capabilities: { canWebSerialInstall: false, platform: 'macos', isMobile: false } }, 'connector-fallback'],
];

test('returns the closed action vocabulary with one primary action', () => {
  for (const [name, input, expectedId] of actionCases) {
    const action = nextCardConnectionAction(input);
    assert.equal(action.id, expectedId, name);
    assert.equal(typeof action.title, 'string', `${name}: title`);
    assert.ok(action.title.length > 0, `${name}: title content`);
    assert.equal(typeof action.explanation, 'string', `${name}: explanation`);
    assert.ok(action.explanation.length > 0, `${name}: explanation content`);
    assert.equal(typeof action.primaryLabel, 'string', `${name}: primary label`);
    assert.ok(action.primaryLabel.length > 0, `${name}: primary label content`);
  }
});

test('requires a verified identity before reporting a connection', () => {
  assert.equal(nextCardConnectionAction({
    link: { state: 'connected-direct', card: { id: 'lw-a' } },
  }).id, 'connected');
  assert.notEqual(nextCardConnectionAction({
    link: { state: 'connected-bridge', card: null },
    intent: 'working-card',
  }).id, 'connected');
});

test('keeps in-flight links busy instead of offering a competing connection path', () => {
  for (const state of ['connecting', 'reconnecting-bridge']) {
    const action = nextCardConnectionAction({
      link: { state },
      intent: 'blank-card',
      capabilities: { canWebSerialInstall: true },
    });
    assert.equal(action.id, 'reconnect-known-card');
    assert.equal(action.busy, true);
    assert.equal(action.primaryDisabled, true);
  }
});

test('routes known disconnection reasons to honest recovery actions', () => {
  const cases = [
    ['wrong-card', 'reconnect-known-card'],
    ['identity-missing', 'open-card-page'],
    ['firmware-too-old', 'open-card-page'],
    ['popup-blocked', 'retry-card-page'],
    ['no-answer', 'retry-card-page'],
    ['card-page-closed', 'retry-card-page'],
  ];

  for (const [reason, expectedId] of cases) {
    const action = nextCardConnectionAction({
      link: { state: 'disconnected', reason },
      intent: 'working-card',
    });
    assert.equal(action.id, expectedId, reason);
    assert.notEqual(action.id, 'connected', reason);
  }
});

test('working-card intent prefers known cards, then setup evidence, then the card page', () => {
  assert.equal(nextCardConnectionAction({ intent: 'working-card', expectedCard: { id: 'lw-a' } }).id, 'reconnect-known-card');
  assert.equal(nextCardConnectionAction({ intent: 'working-card', discoveredCard: { id: 'lw-b' } }).id, 'reconnect-known-card');
  assert.equal(nextCardConnectionAction({ intent: 'working-card', setupNetwork: { available: true } }).id, 'open-setup-network');
  assert.equal(nextCardConnectionAction({ intent: 'working-card' }).id, 'open-card-page');
});

test('unsupported install and recovery paths use capability handoff guidance', () => {
  assert.equal(nextCardConnectionAction({
    intent: 'blank-card',
    capabilities: { canWebSerialInstall: false, platform: 'macos', handoffKind: 'supported-browser-handoff' },
  }).id, 'supported-browser-handoff');
  assert.equal(nextCardConnectionAction({
    intent: 'blank-card',
    capabilities: { canWebSerialInstall: false, platform: 'ios', handoffKind: 'supported-device-handoff' },
  }).id, 'supported-device-handoff');
  assert.equal(nextCardConnectionAction({
    intent: 'deep-recovery',
    capabilities: { canWebSerialInstall: false, platform: 'android', isMobile: true },
  }).id, 'supported-device-handoff');
  assert.notEqual(nextCardConnectionAction({
    intent: 'blank-card',
    capabilities: { canWebSerialInstall: false, platform: 'macos' },
  }).id, 'connector-fallback');
});

test('unexpected inputs fall back to choosing the card condition', () => {
  for (const input of [null, [], 'working-card', { intent: 'surprise' }, { capabilities: null }]) {
    assert.equal(nextCardConnectionAction(input).id, 'choose-card-condition');
  }
});

test('customer-facing action copy contains no implementation jargon', () => {
  const forbidden = /mixed content|postMessage|bridge|Web Serial|localhost|(?:\d{1,3}\.){3}\d{1,3}/i;
  for (const [name, input] of actionCases) {
    const { title, explanation, primaryLabel, secondaryAction } = nextCardConnectionAction(input);
    const copy = [title, explanation, primaryLabel, secondaryAction?.label, secondaryAction?.explanation]
      .filter(Boolean)
      .join(' ');
    assert.doesNotMatch(copy, forbidden, name);
  }
});
