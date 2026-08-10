import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BENCH_INSTALL_EXISTING_PROJECT_MESSAGE,
  BENCH_INSTALL_STAGED_MESSAGE,
  BENCH_INSTALL_STAGED_UNKNOWN_MESSAGE,
  BenchInstallError,
  benchConfigWasStaged,
  installBenchConfig,
  waitForBenchPlayback,
  waitForClearedCard,
} from './benchInstall.js';

const HOST = 'lightweaver.local';
const CONFIG = { piece: { id: 'lightweaver-bench-discovery-v1' } };

// The exact envelope a card returns once it is running a saved project. Every
// field classifyCardReadiness insists on is present, because a partial envelope
// classifies 'checking' and would make a passing test prove nothing.
function readyStatus(overrides = {}) {
  return {
    app: 'Lightweaver',
    provisioningContractVersion: 1,
    cardId: 'lw-bench-1',
    firmwareVersion: '1.4.0',
    buildId: 'build-412',
    bootId: 'boot-2',
    runtimePhase: 'ready',
    mode: 'website-flash',
    source: 'config',
    projectId: 'lightweaver-bench-discovery-v1',
    projectFingerprint: 'a1b2c3d4e5f60718',
    knownGoodProject: true,
    commandReady: true,
    playbackReady: true,
    outputReady: true,
    ...overrides,
  };
}

function blankStatus() {
  return readyStatus({
    runtimePhase: 'factory',
    mode: 'factory-flash',
    source: 'defaults',
    projectId: '',
    projectFingerprint: '',
    knownGoodProject: false,
    commandReady: false,
    playbackReady: false,
    outputReady: false,
  });
}

// A clock that advances only when the code under test waits, so a 40s timeout
// is exercised in microseconds without a real timer.
function fakeClock() {
  let current = 0;
  return {
    now: () => current,
    wait: async ms => { current += ms; },
  };
}

function recordingBridge(response) {
  const calls = [];
  return {
    calls,
    impl: async (type, payload, options) => {
      calls.push({ type, payload, options });
      return response;
    },
  };
}

test('benchConfigWasStaged recognizes the firmware envelope that means "nothing was applied"', () => {
  assert.equal(benchConfigWasStaged({ ok: true, state: 'staged', activationId: 'act-1', requiresConfirmation: true }), true);
  assert.equal(benchConfigWasStaged({ ok: true, requiresConfirmation: true }), true);
  assert.equal(benchConfigWasStaged({ ok: true, requiresReboot: true }), false);
  assert.equal(benchConfigWasStaged({ ok: true, state: 'known-good' }), false);
  assert.equal(benchConfigWasStaged(null), false);
});

test('a staged answer without any project knowledge fails with neutral advice', async () => {
  // ok:true is the whole trap: the old code checked only response.ok and
  // entered the probe phase against a card that had applied nothing.
  // Nobody checked whether the card already held a project, so the message
  // must not guess — and must never tell the owner to reflash (ui-repair B0).
  const bridge = recordingBridge({ ok: true, state: 'staged', activationId: 'act-1', requiresReboot: false, requiresConfirmation: true });
  let rebooted = 0;
  let waited = 0;

  await assert.rejects(
    () => installBenchConfig({
      host: HOST,
      config: CONFIG,
      flowId: 'discoveryabc',
      initial: true,
      direct: false,
      guardImpl: async () => { throw new Error('direct card unavailable'); },
      authorizeImpl: () => ({ ok: true }),
      bridgeRequestImpl: bridge.impl,
      rebootImpl: async () => { rebooted += 1; },
      waitForPlaybackImpl: async () => { waited += 1; },
    }),
    error => {
      assert.ok(error instanceof BenchInstallError);
      assert.equal(error.reason, 'staged-unknown');
      assert.equal(error.message, BENCH_INSTALL_STAGED_UNKNOWN_MESSAGE);
      assert.doesNotMatch(error.message, /firmware/i, 'no firmware advice when nobody checked');
      return true;
    },
  );

  assert.equal(bridge.calls.length, 1, 'exactly one config write is attempted');
  assert.equal(rebooted, 0, 'a staged config must not trigger a reboot');
  assert.equal(waited, 0, 'a staged config must never enter the ready wait');
});

test('a staged answer on a card positively seen as blank still blames the firmware', async () => {
  // The one case where old firmware really is the likely explanation: the
  // caller established the card was blank before the write (cardShowsProject:
  // false), so the ordinary "update the card" advice is the honest one.
  let rebooted = 0;
  let waited = 0;
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ ok: true, state: 'staged', activationId: 'act-2', requiresConfirmation: true }),
  });

  await assert.rejects(
    () => installBenchConfig({
      host: HOST,
      config: CONFIG,
      direct: true,
      cardShowsProject: false,
      fetchImpl,
      guardImpl: async () => ({ id: 'lw-bench-1' }),
      rebootImpl: async () => { rebooted += 1; },
      waitForPlaybackImpl: async () => { waited += 1; },
    }),
    error => {
      assert.equal(error.reason, 'staged');
      assert.equal(error.message, BENCH_INSTALL_STAGED_MESSAGE);
      return true;
    },
  );
  assert.equal(rebooted, 0);
  assert.equal(waited, 0);
});

test('an applied config over direct http reboots the card and waits for playback', async () => {
  // The direct branch used to skip /api/reboot entirely, so the card kept
  // running the old buffers and never reached the bench config at all.
  const posted = [];
  const fetchImpl = async url => {
    posted.push(url);
    return { ok: true, json: async () => ({ ok: true, requiresReboot: true }) };
  };
  const rebooted = [];
  const clock = fakeClock();
  const statuses = [blankStatus(), blankStatus(), readyStatus()];

  const response = await installBenchConfig({
    host: HOST,
    config: CONFIG,
    direct: true,
    fetchImpl,
    guardImpl: async () => ({ id: 'lw-bench-1' }),
    rebootImpl: async host => { rebooted.push(host); },
    expectedCard: null,
    statusImpl: async () => statuses.shift() ?? readyStatus(),
    waitImpl: clock.wait,
    now: clock.now,
  });

  assert.deepEqual(response, { ok: true, requiresReboot: true });
  assert.deepEqual(posted, [`http://${HOST}/api/config`]);
  assert.deepEqual(rebooted, [HOST], 'the direct path must POST /api/reboot itself');
  assert.equal(statuses.length, 0, 'the wait polls until the card actually reports ready');
});

test('the bridge path does not double-reboot a card the relay already restarted', async () => {
  // The card page's relay reboots for an applied config and reports it back as
  // rebooting:true (LightweaverWeb.cpp shouldReboot).
  const bridge = recordingBridge({ ok: true, requiresReboot: true, rebooting: true });
  let rebooted = 0;
  const clock = fakeClock();
  const statuses = [blankStatus(), readyStatus()];

  await installBenchConfig({
    host: HOST,
    config: CONFIG,
    flowId: 'discoveryabc',
    initial: true,
    direct: false,
    guardImpl: async () => { throw new Error('direct card unavailable'); },
    authorizeImpl: () => ({ ok: true }),
    bridgeRequestImpl: bridge.impl,
    rebootImpl: async () => { rebooted += 1; },
    expectedCard: null,
    statusImpl: async () => statuses.shift() ?? readyStatus(),
    waitImpl: clock.wait,
    now: clock.now,
  });

  assert.equal(rebooted, 0);
  assert.equal(bridge.calls[0].options.commissioningFlowId, 'discoveryabc', 'the one-shot authority is threaded');
  assert.equal(bridge.calls[0].options.reboot, true);
});

test('HTTPS discovery uses direct HTTP when exact-card preflight succeeds', async () => {
  const bridge = recordingBridge({ ok: true });
  const calls = [];
  let waitedTransport = '';

  const response = await installBenchConfig({
    host: HOST,
    config: CONFIG,
    flowId: 'discoveryabc',
    initial: true,
    transport: 'direct',
    guardImpl: async host => { calls.push(`guard:${host}`); return { id: 'lw-bench-1' }; },
    fetchImpl: async url => {
      calls.push(`post:${url}`);
      return { ok: true, json: async () => ({ ok: true }) };
    },
    bridgeRequestImpl: bridge.impl,
    waitForPlaybackImpl: async ({ transport }) => { waitedTransport = transport; },
  });

  assert.deepEqual(response, { ok: true });
  assert.deepEqual(calls, [`guard:${HOST}`, `post:http://${HOST}/api/config`]);
  assert.equal(bridge.calls.length, 0);
  assert.equal(waitedTransport, 'direct');
});

test('HTTPS discovery falls back to the bridge only when direct preflight fails before mutation', async () => {
  const bridge = recordingBridge({ ok: true, rebooting: true });
  let directPosts = 0;
  let waitedTransport = '';

  await installBenchConfig({
    host: HOST,
    config: CONFIG,
    flowId: 'discoveryabc',
    initial: true,
    transport: 'direct',
    guardImpl: async () => { throw new Error('private network preflight blocked'); },
    fetchImpl: async () => { directPosts += 1; throw new Error('must not POST'); },
    authorizeImpl: () => ({ ok: true }),
    bridgeRequestImpl: bridge.impl,
    waitForPlaybackImpl: async ({ transport }) => { waitedTransport = transport; },
  });

  assert.equal(directPosts, 0);
  assert.equal(bridge.calls.length, 1);
  assert.equal(waitedTransport, 'bridge');
});

test('a direct config refusal never falls back to a second ambiguous bridge mutation', async () => {
  const bridge = recordingBridge({ ok: true });
  await assert.rejects(
    () => installBenchConfig({
      host: HOST,
      config: CONFIG,
      flowId: 'discoveryabc',
      initial: true,
      transport: 'direct',
      guardImpl: async () => ({ id: 'lw-bench-1' }),
      fetchImpl: async () => ({ ok: false, json: async () => ({ ok: false, error: 'config too large' }) }),
      authorizeImpl: () => ({ ok: true }),
      bridgeRequestImpl: bridge.impl,
    }),
    error => error.reason === 'refused',
  );
  assert.equal(bridge.calls.length, 0);
});

test('a re-size never asks for the one-shot blank-card authority again', async () => {
  const bridge = recordingBridge({ ok: true, requiresReboot: true, rebooting: true });
  let authorized = 0;
  const clock = fakeClock();

  await installBenchConfig({
    host: HOST,
    config: CONFIG,
    flowId: 'discoveryabc',
    initial: false,
    direct: false,
    authorizeImpl: () => { authorized += 1; return { ok: true }; },
    bridgeRequestImpl: bridge.impl,
    expectedCard: null,
    statusImpl: async () => readyStatus(),
    waitImpl: clock.wait,
    now: clock.now,
  });

  assert.equal(authorized, 0, 'the authority is spent by design');
  assert.equal(bridge.calls[0].options.commissioningFlowId, undefined);
});

test('a card that never comes back fails with a bounded, plain-language error', async () => {
  const clock = fakeClock();
  let polls = 0;

  await assert.rejects(
    () => installBenchConfig({
      host: HOST,
      config: CONFIG,
      direct: true,
      fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, requiresReboot: true }) }),
      guardImpl: async () => ({ id: 'lw-bench-1' }),
      rebootImpl: async () => {},
      expectedCard: null,
      // The card is unreachable while it restarts; a throwing read must not end
      // the wait early, and must not hang it either.
      statusImpl: async () => { polls += 1; throw new Error('offline'); },
      waitImpl: clock.wait,
      now: clock.now,
      pollIntervalMs: 750,
      timeoutMs: 3000,
    }),
    error => {
      assert.equal(error.reason, 'not-ready');
      assert.match(error.message, /did not come back ready/);
      return true;
    },
  );
  assert.equal(polls, 4, '3000ms / 750ms of polling, then a bounded failure');
});

test('the wait stops immediately when a different card answers', async () => {
  const clock = fakeClock();
  await assert.rejects(
    () => waitForBenchPlayback({
      host: HOST,
      transport: 'direct',
      expectedCard: { id: 'lw-owner-9' },
      statusImpl: async () => readyStatus(),
      waitImpl: clock.wait,
      now: clock.now,
      timeoutMs: 30_000,
    }),
    error => error.reason === 'wrong-card',
  );
});

test('a card reporting playback while the command gate is still shut is ready enough for frames', async () => {
  // playbackAccess is exactly what cardBridge.js gates 'frame' messages on, so
  // waiting for the narrower 'connected' state would stall a card that is lit
  // and healthy while its radio reassociates.
  const clock = fakeClock();
  const readiness = await waitForBenchPlayback({
    host: HOST,
    transport: 'direct',
    expectedCard: null,
    statusImpl: async () => readyStatus({ runtimePhase: 'recovering', commandReady: false }),
    waitImpl: clock.wait,
    now: clock.now,
  });
  assert.equal(readiness.playbackAccess, 'ready');
});

test('there is nothing to install when the builder could not provision a port', async () => {
  await assert.rejects(
    () => installBenchConfig({ host: HOST, config: null, direct: true }),
    error => {
      assert.equal(error.reason, 'no-config');
      assert.match(error.message, /nothing to install/);
      return true;
    },
  );
});

test('a refused config surfaces the card’s own error', async () => {
  await assert.rejects(
    () => installBenchConfig({
      host: HOST,
      config: CONFIG,
      direct: true,
      fetchImpl: async () => ({ ok: false, json: async () => ({ ok: false, error: 'config too large' }) }),
      guardImpl: async () => ({ id: 'lw-bench-1' }),
      waitForPlaybackImpl: async () => { throw new Error('must not wait on a refused config'); },
    }),
    error => {
      assert.equal(error.reason, 'refused');
      assert.equal(error.message, 'config too large');
      return true;
    },
  );
});

test('a blank card that cannot prove itself over the bridge is refused before any write', async () => {
  const bridge = recordingBridge({ ok: true });
  await assert.rejects(
    () => installBenchConfig({
      host: HOST,
      config: CONFIG,
      flowId: 'discoveryabc',
      initial: true,
      direct: false,
      guardImpl: async () => { throw new Error('direct card unavailable'); },
      authorizeImpl: () => ({ ok: false, reason: 'card-not-blank' }),
      bridgeRequestImpl: bridge.impl,
    }),
    error => error.reason === 'authority',
  );
  assert.equal(bridge.calls.length, 0);
});

test('bridge authority failures preserve the actionable reason', async () => {
  const expected = {
    'bridge-missing': /local card page is not connected/i,
    'identity-missing': /identity/i,
    'stale-host': /different card address/i,
    'handoff-active': /Wi-Fi setup is already in progress/i,
    'authority-spent': /setup write was already used/i,
    'card-not-blank': /already has a project/i,
  };
  for (const [reason, message] of Object.entries(expected)) {
    await assert.rejects(
      () => installBenchConfig({
        host: HOST,
        config: CONFIG,
        flowId: 'discoveryabc',
        initial: true,
        direct: false,
        guardImpl: async () => { throw new Error('direct unavailable'); },
        authorizeImpl: () => ({ ok: false, reason }),
      }),
      error => error.reason === 'authority' && message.test(error.message),
      reason,
    );
  }
});

test('verified direct transport is allowed from HTTPS and falls back to the bridge only when its preflight fails', async () => {
  const bridge = recordingBridge({ ok: true, requiresReboot: true, rebooting: true });
  let directPosts = 0;
  await installBenchConfig({
    host: HOST, config: CONFIG, flowId: 'discoveryabc', initial: true, transport: 'direct',
    guardImpl: async () => { throw new Error('direct card HTTP blocked'); },
    fetchImpl: async () => { directPosts += 1; throw new Error('must not POST after failed preflight'); },
    authorizeImpl: () => ({ ok: true }), bridgeRequestImpl: bridge.impl,
    waitForPlaybackImpl: async ({ transport }) => assert.equal(transport, 'bridge'),
  });
  assert.equal(directPosts, 0);
  assert.equal(bridge.calls.length, 1);
});

test('a direct config POST with an uncertain outcome is never retried over the bridge', async () => {
  const bridge = recordingBridge({ ok: true });
  let directPosts = 0;
  await assert.rejects(() => installBenchConfig({
    host: HOST, config: CONFIG, flowId: 'discoveryabc', initial: true, transport: 'direct',
    guardImpl: async () => ({ id: 'lw-bench-1' }),
    fetchImpl: async () => { directPosts += 1; throw new Error('connection closed after send'); },
    authorizeImpl: () => ({ ok: true }), bridgeRequestImpl: bridge.impl,
  }), /connection closed after send/);
  assert.equal(directPosts, 1);
  assert.equal(bridge.calls.length, 0);
});

test('blank-card authority refusals explain their distinct causes', async () => {
  const cases = [
    ['card-not-blank', /already has a project/], ['bridge-missing', /card page is not connected/],
    ['identity-missing', /identity/], ['stale-host', /different card address/],
    ['authority-spent', /already used/], ['handoff-active', /Wi-Fi setup/], ['invalid-flow', /discovery session/],
  ];
  for (const [reason, pattern] of cases) {
    await assert.rejects(() => installBenchConfig({
      host: HOST, config: CONFIG, flowId: 'discoveryabc', initial: true, direct: false,
      guardImpl: async () => { throw new Error('direct card unavailable'); },
      authorizeImpl: () => ({ ok: false, reason }), bridgeRequestImpl: async () => { throw new Error('must not write'); },
    }), error => error.reason === 'authority' && pattern.test(error.message), reason);
  }
});

test('a staged answer on a card that showed a project blames the project, not the firmware', async () => {
  // ui-repair B0: the observed misdiagnosis. The card held the bench project
  // from an earlier run, staged the new config as a wiring change, and Studio
  // told the owner to reflash — which cannot help.
  const bridge = recordingBridge({ ok: true, state: 'staged', activationId: 'act-3', requiresReboot: false, requiresConfirmation: true });
  let rebooted = 0;
  let waited = 0;
  await assert.rejects(
    () => installBenchConfig({
      host: HOST,
      config: CONFIG,
      flowId: 'discoveryabc',
      initial: true,
      direct: false,
      guardImpl: async () => { throw new Error('direct card unavailable'); },
      cardShowsProject: true,
      authorizeImpl: () => ({ ok: true }),
      bridgeRequestImpl: bridge.impl,
      rebootImpl: async () => { rebooted += 1; },
      waitForPlaybackImpl: async () => { waited += 1; },
    }),
    error => {
      assert.ok(error instanceof BenchInstallError);
      assert.equal(error.reason, 'staged-existing-project');
      assert.equal(error.message, BENCH_INSTALL_EXISTING_PROJECT_MESSAGE);
      assert.doesNotMatch(error.message, /firmware/i, 'the wrong diagnosis was the bug: no firmware advice here');
      return true;
    },
  );
  assert.equal(rebooted, 0);
  assert.equal(waited, 0);
});

test('waitForClearedCard resolves once the card itself answers as blank', async () => {
  const clock = fakeClock();
  let calls = 0;
  const readiness = await waitForClearedCard({
    host: HOST,
    transport: 'direct',
    expectedCard: null,
    statusImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('rebooting');
      if (calls === 2) return readyStatus();
      return blankStatus();
    },
    waitImpl: clock.wait,
    now: clock.now,
  });
  assert.equal(readiness.state, 'blank');
  assert.equal(calls, 3, 'a throwing read and a still-project read both keep waiting');
});

test('waitForClearedCard is bounded and honest when the card never comes back blank', async () => {
  const clock = fakeClock();
  await assert.rejects(
    () => waitForClearedCard({
      host: HOST,
      transport: 'direct',
      expectedCard: null,
      statusImpl: async () => readyStatus(),
      waitImpl: clock.wait,
      now: clock.now,
      pollIntervalMs: 750,
      timeoutMs: 3000,
    }),
    error => error.reason === 'not-cleared',
  );
});

test('waitForClearedCard stops immediately when a different card answers', async () => {
  const clock = fakeClock();
  await assert.rejects(
    () => waitForClearedCard({
      host: HOST,
      transport: 'direct',
      expectedCard: { id: 'lw-owner-9' },
      statusImpl: async () => blankStatus(),
      waitImpl: clock.wait,
      now: clock.now,
    }),
    error => error.reason === 'wrong-card',
  );
});
