import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BENCH_INSTALL_EXISTING_PROJECT_MESSAGE,
  BENCH_INSTALL_STAGED_MESSAGE,
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

test('a staged answer fails the install — it never reboots, waits, or resolves', async () => {
  // ok:true is the whole trap: the old code checked only response.ok and
  // entered the probe phase against a card that had applied nothing.
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
      authorizeImpl: () => ({ ok: true }),
      bridgeRequestImpl: bridge.impl,
      rebootImpl: async () => { rebooted += 1; },
      waitForPlaybackImpl: async () => { waited += 1; },
    }),
    error => {
      assert.ok(error instanceof BenchInstallError);
      assert.equal(error.reason, 'staged');
      assert.equal(error.message, BENCH_INSTALL_STAGED_MESSAGE);
      assert.match(error.message, /Update the card firmware/);
      return true;
    },
  );

  assert.equal(bridge.calls.length, 1, 'exactly one config write is attempted');
  assert.equal(rebooted, 0, 'a staged config must not trigger a reboot');
  assert.equal(waited, 0, 'a staged config must never enter the ready wait');
});

test('a staged answer over direct http fails the same way', async () => {
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
      fetchImpl,
      guardImpl: async () => ({ id: 'lw-bench-1' }),
      rebootImpl: async () => { rebooted += 1; },
      waitForPlaybackImpl: async () => { waited += 1; },
    }),
    error => error.reason === 'staged',
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
      authorizeImpl: () => ({ ok: false, reason: 'card-not-blank' }),
      bridgeRequestImpl: bridge.impl,
    }),
    error => error.reason === 'authority',
  );
  assert.equal(bridge.calls.length, 0);
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
