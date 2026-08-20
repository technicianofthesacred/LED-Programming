import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveCardAction, cardSurfaceForLifecycle } from './cardActionAuthority.js';
import { deriveCardLifecycle } from './cardLifecycle.js';
import { nextCardConnectionAction } from './cardConnectionFlow.js';
import { detectPlatformCapabilities } from './platformCapabilities.js';

const FP = 'a'.repeat(64);
const CARD_ID = 'lw-authority';
const IDENTITY = Object.freeze({
  app: 'Lightweaver',
  provisioningContractVersion: 1,
  cardId: CARD_ID,
  firmwareVersion: '1.0.0',
  buildId: 'b'.repeat(40),
});
const COMPLETE_READINESS = Object.freeze({
  ...IDENTITY,
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
const MATCHING_PROJECT = Object.freeze({ id: 'piece-a', revision: 3, fingerprint: FP });
const REMEMBERED = Object.freeze({ id: CARD_ID, firmwareVersion: '1.0.0', buildId: 'b'.repeat(40) });

const CAPABILITY_SETS = Object.freeze({
  'webserial-capable': detectPlatformCapabilities({
    secureContext: true,
    topLevel: true,
    serial: {},
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120.0',
    platform: 'MacIntel',
  }),
  mobile: detectPlatformCapabilities({
    secureContext: true,
    topLevel: true,
    serial: null,
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile',
    platform: 'Linux armv8l',
  }),
  'insecure-frame': detectPlatformCapabilities({
    secureContext: false,
    topLevel: false,
    serial: null,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120.0',
    platform: 'MacIntel',
  }),
});

// One fixture per lifecycle state. `expected` is either a single
// {actionId, surface, busy, retryable} verdict (identical across every
// capability set) or a per-capability-set map where the routing genuinely
// depends on the platform.
const GOLDEN = [
  {
    state: 'disconnected',
    input: { link: { state: 'disconnected', reason: 'never-connected' } },
    expected: { actionId: 'recoverable-failure', surface: 'connection-center', busy: false, retryable: true },
  },
  {
    state: 'connecting',
    input: { link: { state: 'connecting' } },
    expected: { actionId: 'recoverable-failure', surface: 'connection-center', busy: true, retryable: false },
  },
  {
    state: 'recovering',
    input: { link: { state: 'connecting', activity: 'recovering' } },
    expected: { actionId: 'lifecycle-attention', surface: 'connection-center', busy: false, retryable: false },
  },
  {
    state: 'reconnecting',
    input: { link: { state: 'reconnecting' }, evidence: { rememberedCard: REMEMBERED } },
    expected: { actionId: 'recoverable-failure', surface: 'connection-center', busy: true, retryable: false },
  },
  {
    state: 'verifying',
    input: { link: { state: 'revalidating', reason: 'card-restarted' } },
    expected: { actionId: 'recoverable-failure', surface: 'connection-center', busy: true, retryable: false },
  },
  {
    state: 'found-unpaired',
    input: { link: { state: 'disconnected', reason: 'found-unpaired', discoveredCard: { id: CARD_ID } } },
    expected: { actionId: 'pair-local-card', surface: 'connection-center', busy: false, retryable: false },
  },
  {
    state: 'updating',
    input: { link: VERIFIED_LINK, update: { phase: 'sending' } },
    expected: { actionId: 'lifecycle-attention', surface: 'connection-center', busy: false, retryable: false },
  },
  {
    state: 'update-recovering',
    input: { link: VERIFIED_LINK, update: { phase: 'restarting' } },
    expected: { actionId: 'lifecycle-attention', surface: 'connection-center', busy: false, retryable: false },
  },
  {
    state: 'update-rolled-back',
    input: { link: VERIFIED_LINK, update: { phase: 'rolled-back', reason: 'boot-health-failed' } },
    expected: { actionId: 'lifecycle-attention', surface: 'connection-center', busy: false, retryable: false },
  },
  {
    state: 'wrong-card',
    input: { link: { state: 'disconnected', reason: 'wrong-card', card: { id: 'lw-other' } }, evidence: { rememberedCard: REMEMBERED } },
    expected: { actionId: 'wrong-card', surface: 'connection-center', busy: false, retryable: false },
  },
  {
    state: 'target-mismatch',
    input: { link: VERIFIED_LINK, update: { phase: 'blocked', reason: 'target-mismatch' } },
    expected: { actionId: 'lifecycle-attention', surface: 'setup', busy: false, retryable: false },
  },
  {
    state: 'project-changed',
    input: { link: VERIFIED_LINK, update: { phase: 'blocked', reason: 'project-changed' } },
    expected: { actionId: 'lifecycle-attention', surface: 'setup', busy: false, retryable: false },
  },
  {
    state: 'update-required',
    input: { link: { state: 'disconnected', reason: 'firmware-too-old' }, evidence: { rememberedCard: REMEMBERED } },
    expected: {
      'webserial-capable': { actionId: 'needs-card-update', surface: 'setup', busy: false, retryable: false },
      mobile: { actionId: 'needs-card-update', surface: 'setup', busy: false, retryable: false },
      'insecure-frame': { actionId: 'escape-insecure-card-frame', surface: 'setup', busy: false, retryable: false },
    },
  },
  {
    state: 'setup-required',
    input: {
      link: {
        ...VERIFIED_LINK,
        cardBlank: true,
        readiness: {
          ...IDENTITY,
          bootId: 'boot-1',
          runtimePhase: 'factory',
          knownGoodProject: false,
          commandReady: false,
          outputReady: true,
          mode: 'factory-flash',
          source: 'defaults',
        },
      },
    },
    expected: { actionId: 'card-needs-project', surface: 'setup', busy: false, retryable: false },
  },
  {
    state: 'project-mismatch',
    input: { link: VERIFIED_LINK, project: { id: 'piece-b', revision: 3, fingerprint: 'c'.repeat(64) } },
    expected: { actionId: 'lifecycle-attention', surface: 'setup', busy: false, retryable: false },
  },
  {
    state: 'attention-required',
    input: { link: { ...VERIFIED_LINK, readiness: { ...COMPLETE_READINESS, commandReady: false } } },
    expected: { actionId: 'lifecycle-attention', surface: 'setup', busy: false, retryable: false },
  },
  {
    state: 'confirming',
    input: {
      link: { state: 'connected-bridge', card: { id: CARD_ID }, expectedCard: { id: CARD_ID }, readiness: { cardId: CARD_ID } },
      evidence: { rememberedCard: REMEMBERED },
    },
    expected: { actionId: 'recoverable-failure', surface: 'connection-center', busy: true, retryable: false },
  },
  {
    state: 'ready',
    input: { link: VERIFIED_LINK, project: MATCHING_PROJECT },
    expected: { actionId: 'ready-local-card', surface: 'card-control', busy: false, retryable: false },
  },
];

test('golden table: every lifecycle state × platform capability set', () => {
  const covered = new Set();
  for (const row of GOLDEN) {
    const lifecycle = deriveCardLifecycle({
      link: row.input.link,
      update: row.input.update || null,
      project: row.input.project || null,
    });
    assert.equal(lifecycle.state, row.state, `fixture for ${row.state} derives ${lifecycle.state}`);
    covered.add(lifecycle.state);
    for (const [name, capabilities] of Object.entries(CAPABILITY_SETS)) {
      const expected = row.expected[name] || row.expected;
      const verdict = deriveCardAction({
        lifecycle,
        link: row.input.link,
        capabilities,
        evidence: row.input.evidence || {},
      });
      assert.deepEqual(
        {
          actionId: verdict.actionId,
          surface: verdict.surface,
          busy: verdict.busy,
          retryable: verdict.retryable,
        },
        expected,
        `${row.state} × ${name}`,
      );
      assert.equal(Object.isFrozen(verdict), true);
    }
  }
  // Every lifecycle state the diagnosis can produce has a golden row.
  assert.equal(covered.size, 18, `covered ${covered.size} lifecycle states`);
});

test('loop-breaker pin: a connected exact card asking for load-matching-project resolves in Setup', () => {
  for (const input of [
    { link: VERIFIED_LINK, project: { id: 'piece-b', revision: 3, fingerprint: 'c'.repeat(64) } },
    { link: VERIFIED_LINK, update: { phase: 'blocked', reason: 'project-changed' } },
  ]) {
    const lifecycle = deriveCardLifecycle(input);
    assert.equal(lifecycle.setupTaskId, 'load-matching-project');
    assert.equal(lifecycle.exactCard, true);
    const verdict = deriveCardAction({
      lifecycle,
      link: input.link,
      capabilities: CAPABILITY_SETS['webserial-capable'],
    });
    assert.equal(verdict.surface, 'setup');
    assert.notEqual(verdict.surface, 'connection-center');
  }
});

test('Fork 2 pin: popup-blocked stays attention-required but retryable', () => {
  const link = { state: 'disconnected', reason: 'popup-blocked' };
  const lifecycle = deriveCardLifecycle({ link });
  assert.equal(lifecycle.state, 'attention-required');
  const verdict = deriveCardAction({
    lifecycle,
    link,
    capabilities: CAPABILITY_SETS['webserial-capable'],
    evidence: { rememberedCard: REMEMBERED },
  });
  assert.equal(verdict.diagnosis, 'attention-required');
  assert.equal(verdict.retryable, true);
  // The rendered copy is still the lifecycle collapse — no new strings.
  assert.equal(verdict.actionId, 'lifecycle-attention');
  assert.equal(verdict.title, 'Needs attention');
});

test('Fork 1 pin: confirming renders the flow connecting copy, never attention', () => {
  const link = {
    state: 'connected-bridge',
    card: { id: CARD_ID },
    expectedCard: { id: CARD_ID },
    readiness: { cardId: CARD_ID },
  };
  const lifecycle = deriveCardLifecycle({ link });
  assert.equal(lifecycle.state, 'confirming');
  const verdict = deriveCardAction({
    lifecycle,
    link,
    capabilities: CAPABILITY_SETS['webserial-capable'],
    evidence: { rememberedCard: REMEMBERED },
  });
  assert.equal(verdict.title, 'Connecting to the Lightweaver card');
  assert.equal(verdict.explanation, 'Keep the card powered and leave its page open while Studio checks it.');
  assert.equal(verdict.primaryLabel, 'Connecting…');
  assert.equal(verdict.busy, true);
  assert.equal(verdict.pending, true);
  assert.equal(verdict.primaryDisabled, true);
  assert.notEqual(verdict.title, 'Needs attention');
});

test('escape hatch pin: the wrong-firmware-build re-pair offer survives verbatim', () => {
  const link = {
    state: 'disconnected',
    reason: 'wrong-firmware-build',
    discoveredCard: { id: CARD_ID, firmwareVersion: '9.9.9', buildId: 'x'.repeat(40) },
  };
  const lifecycle = deriveCardLifecycle({ link });
  const verdict = deriveCardAction({
    lifecycle,
    link,
    capabilities: CAPABILITY_SETS['webserial-capable'],
    evidence: { rememberedCard: REMEMBERED },
  });
  assert.equal(verdict.actionId, 'needs-card-update');
  assert.equal(verdict.secondaryAction?.id, 'trust-updated-card');
  assert.equal(verdict.secondaryAction?.label, 'Keep the new firmware on this card');
});

test('the authority reuses the flow verdict and its copy, never a duplicate', () => {
  const link = { state: 'disconnected', reason: 'firmware-too-old' };
  const flow = nextCardConnectionAction({
    link,
    intent: 'working-card',
    capabilities: CAPABILITY_SETS['webserial-capable'],
    rememberedCard: REMEMBERED,
  });
  const verdict = deriveCardAction({
    lifecycle: deriveCardLifecycle({ link }),
    link,
    capabilities: CAPABILITY_SETS['webserial-capable'],
    evidence: { rememberedCard: REMEMBERED },
  });
  assert.equal(verdict.actionId, flow.id);
  assert.equal(verdict.title, flow.title);
  assert.equal(verdict.explanation, flow.explanation);
  assert.equal(verdict.primaryLabel, flow.primaryLabel);
});

test('surface routing helper mirrors the shell footer routing', () => {
  assert.equal(cardSurfaceForLifecycle(null), 'connection-center');
  assert.equal(cardSurfaceForLifecycle({ state: 'ready' }), 'card-control');
  for (const state of ['target-mismatch', 'project-changed', 'update-required', 'setup-required', 'project-mismatch', 'attention-required']) {
    assert.equal(cardSurfaceForLifecycle({ state }), 'setup', state);
  }
  for (const state of ['disconnected', 'connecting', 'recovering', 'reconnecting', 'verifying', 'found-unpaired', 'updating', 'update-recovering', 'update-rolled-back', 'wrong-card', 'confirming']) {
    assert.equal(cardSurfaceForLifecycle({ state }), 'connection-center', state);
  }
});
