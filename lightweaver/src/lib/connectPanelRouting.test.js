import test from 'node:test';
import assert from 'node:assert/strict';

import { CONNECT_PANEL_ROUTE_OUT, connectPanelRouteOut } from './connectPanelRouting.js';
import { deriveCardAction } from './cardActionAuthority.js';
import { deriveCardLifecycle } from './cardLifecycle.js';
import { detectPlatformCapabilities } from './platformCapabilities.js';
import { setupTaskRoute } from './setupJourney.js';
import { resolveCardIntent } from './cardFlowEntry.js';

const FP = 'a'.repeat(64);
const CARD_ID = 'lw-connect-panel';
const COMPLETE_READINESS = Object.freeze({
  app: 'Lightweaver',
  provisioningContractVersion: 1,
  cardId: CARD_ID,
  firmwareVersion: '1.0.0',
  buildId: 'b'.repeat(40),
  bootId: 'boot-1',
  runtimePhase: 'ready',
  knownGoodProject: true,
  commandReady: true,
  outputReady: true,
  playbackReady: true,
  projectId: 'piece-a',
  projectRevision: 3,
  projectFingerprint: FP,
});
const VERIFIED_LINK = Object.freeze({
  state: 'connected-bridge',
  card: { id: CARD_ID },
  expectedCard: { id: CARD_ID },
  readiness: COMPLETE_READINESS,
});

const CAPABILITIES = detectPlatformCapabilities({
  secureContext: true,
  topLevel: true,
  serial: {},
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120.0',
  platform: 'MacIntel',
});

// One fixture per lifecycle state the old Connection Center shim owned
// (LIFECYCLE_OWNED_ACTIONS). Each must collapse to an action id the panel can
// ONLY render as a route-out to Card Home — never as its own remedy body.
const LIFECYCLE_OWNED_FIXTURES = Object.freeze({
  recovering: { link: { state: 'connecting', activity: 'recovering' } },
  updating: { link: VERIFIED_LINK, update: { phase: 'sending' } },
  'update-recovering': { link: VERIFIED_LINK, update: { phase: 'restarting' } },
  'update-rolled-back': { link: VERIFIED_LINK, update: { phase: 'rolled-back', reason: 'boot-health-failed' } },
  'target-mismatch': { link: VERIFIED_LINK, update: { phase: 'blocked', reason: 'target-mismatch' } },
  'project-changed': { link: VERIFIED_LINK, update: { phase: 'blocked', reason: 'project-changed' } },
  'project-mismatch': { link: VERIFIED_LINK, project: { id: 'piece-b', revision: 3, fingerprint: 'c'.repeat(64) } },
  'attention-required': { link: { ...VERIFIED_LINK, readiness: { ...COMPLETE_READINESS, commandReady: false } } },
});

test('loop-breaker: every lifecycle-owned state renders a route-out, never a panel remedy', () => {
  for (const [state, input] of Object.entries(LIFECYCLE_OWNED_FIXTURES)) {
    const lifecycle = deriveCardLifecycle({
      link: input.link,
      update: input.update || null,
      project: input.project || null,
    });
    assert.equal(lifecycle.state, state, `fixture for ${state} derives ${lifecycle.state}`);
    const verdict = deriveCardAction({ lifecycle, link: input.link, capabilities: CAPABILITIES });
    assert.equal(verdict.actionId, 'lifecycle-attention', `${state} collapses to lifecycle-attention`);
    const routeOut = connectPanelRouteOut(verdict.actionId);
    assert.ok(routeOut, `${state} has a route-out`);
    // One line, one button, one destination — no remedy machinery (no
    // secondary offers, no routes back into the panel's own flows).
    assert.deepEqual(Object.keys(routeOut).sort(), ['destination', 'label', 'line']);
    assert.ok(['setup-task', 'recover-operation'].includes(routeOut.destination), state);
  }
});

test('the blank-card and uncertain-recovery verdicts are route-outs too', () => {
  const blank = connectPanelRouteOut('card-needs-project');
  assert.equal(blank.destination, 'setup-task');
  assert.equal(blank.line, 'Connected — this card has no project. Set one up from Card Home.');
  const recovery = connectPanelRouteOut('needs-safe-recovery');
  assert.equal(recovery.destination, 'recover-operation');
  // The route-out line reuses the shared task copy, not a new remedy string.
  assert.equal(recovery.line, 'Recover the unfinished card operation safely.');
  // The pinned destination is Card Home's recover task.
  assert.equal(setupTaskRoute('recover-operation'), '#screen=card&section=setup&task=recover-operation');
  assert.deepEqual(resolveCardIntent('recover-operation', {}), {
    action: 'route',
    hash: '#screen=card&section=setup&task=recover-operation',
  });
});

test('transport verdicts stay in the panel — they are NOT route-outs', () => {
  for (const actionId of [
    'ready-local-card',
    'pair-local-card',
    'ready-browser-usb',
    'escape-insecure-card-frame',
    'needs-card-update',
    'launch-native-bridge',
    'install-native-bridge',
    'handoff-supported-device',
    'wrong-card',
    'recoverable-failure',
  ]) {
    assert.equal(connectPanelRouteOut(actionId), null, actionId);
  }
  assert.deepEqual(
    Object.keys(CONNECT_PANEL_ROUTE_OUT).sort(),
    ['card-needs-project', 'lifecycle-attention', 'needs-safe-recovery'],
  );
});

test('the authority never yields the connection-center surface for load-matching-project on a connected exact card', () => {
  // Phase 3's pin, kept green here beside the panel's own loop-breaker.
  for (const input of [
    { link: VERIFIED_LINK, project: { id: 'piece-b', revision: 3, fingerprint: 'c'.repeat(64) } },
    { link: VERIFIED_LINK, update: { phase: 'blocked', reason: 'project-changed' } },
  ]) {
    const lifecycle = deriveCardLifecycle(input);
    assert.equal(lifecycle.setupTaskId, 'load-matching-project');
    const verdict = deriveCardAction({ lifecycle, link: input.link, capabilities: CAPABILITIES });
    assert.notEqual(verdict.surface, 'connection-center');
  }
});
