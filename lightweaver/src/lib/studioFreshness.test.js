import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  STUDIO_FRESHNESS_POLL_MS,
  STUDIO_FRESHNESS_TIMEOUT_MS,
  STUDIO_REFRESH_ATTEMPT_KEY,
  createStudioFreshnessMonitor,
} from './studioFreshness.js';

const release = character => Object.freeze({
  schemaVersion: 1,
  sourceRevision: character.repeat(40),
  buildId: character.repeat(12),
  buildNumber: character.charCodeAt(0),
});

function responseFor(value, options = {}) {
  return new Response(options.body ?? `${JSON.stringify(value)}\n`, {
    status: options.status ?? 200,
    headers: options.headers ?? { 'cache-control': 'private, no-store' },
  });
}

function buildGraphFor(target, assetPaths = ['assets/main-current.js']) {
  const marker = `${JSON.stringify(target)}\n`;
  return {
    schemaVersion: 1,
    files: [
      ...assetPaths.map((path, index) => ({
        path,
        bytes: index + 1,
        sha256: String(index + 1).padStart(64, '0'),
      })),
      { path: 'index.html', bytes: 1, sha256: 'a'.repeat(64) },
      {
        path: 'studio-release.json',
        bytes: Buffer.byteLength(marker),
        sha256: createHash('sha256').update(marker).digest('hex'),
      },
    ].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function readyReleaseFetch(target) {
  const graph = buildGraphFor(target);
  return async url => {
    const pathname = new URL(url).pathname;
    if (pathname === '/studio-release.json') return responseFor(target);
    if (pathname === '/studio-build-graph.json') return responseFor(graph);
    if (pathname.startsWith('/assets/')) return new Response('ready', { status: 200 });
    throw new Error(`Unexpected freshness URL: ${url}`);
  };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
    values,
  };
}

function timerHarness() {
  let sequence = 0;
  let now = 0;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      const id = ++sequence;
      pending.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    async advance(milliseconds) {
      now += milliseconds;
      const due = [...pending.entries()]
        .filter(([, task]) => task.at <= now)
        .sort((left, right) => left[1].at - right[1].at);
      for (const [id, task] of due) {
        pending.delete(id);
        await task.callback();
      }
    },
    count: () => pending.size,
  };
}

function browserHarness() {
  const windowRef = new EventTarget();
  const documentRef = new EventTarget();
  documentRef.visibilityState = 'visible';
  const navigatorRef = { onLine: true };
  return { windowRef, documentRef, navigatorRef };
}

function monitorHarness(options = {}) {
  const running = options.release || release('a');
  const browser = browserHarness();
  const timers = timerHarness();
  const storage = options.storage || memoryStorage();
  const calls = [];
  const monitor = createStudioFreshnessMonitor({
    release: running,
    fetchImpl: options.fetchImpl || (async (url, init) => {
      calls.push({ url, init });
      return responseFor(running);
    }),
    flushAutosave: options.flushAutosave || (() => true),
    reload: options.reload || (() => {}),
    storage,
    locationOrigin: 'https://led.mandalacodes.com',
    createTimeoutSignal: options.createTimeoutSignal || (milliseconds => {
      calls.push({ timeout: milliseconds });
      return new AbortController().signal;
    }),
    timers,
    ...browser,
  });
  return { monitor, running, storage, calls, timers, ...browser };
}

test('freshness checks at startup and every 30 seconds only while visible', async () => {
  const harness = monitorHarness();
  await harness.monitor.start();
  assert.deepEqual(harness.monitor.getState(), {
    status: 'current',
    buildId: harness.running.buildId,
    buildNumber: harness.running.buildNumber,
    reason: '',
  });
  assert.equal(harness.calls.filter(call => call.url).length, 1);
  assert.equal(harness.calls.find(call => call.timeout).timeout, STUDIO_FRESHNESS_TIMEOUT_MS);
  assert.equal(harness.calls.find(call => call.url).url, 'https://led.mandalacodes.com/studio-release.json');
  assert.equal(harness.calls.find(call => call.url).init.cache, 'no-store');
  assert.equal(harness.calls.find(call => call.url).init.redirect, 'manual');

  await harness.timers.advance(STUDIO_FRESHNESS_POLL_MS);
  assert.equal(harness.calls.filter(call => call.url).length, 2);

  harness.documentRef.visibilityState = 'hidden';
  harness.documentRef.dispatchEvent(new Event('visibilitychange'));
  await harness.timers.advance(STUDIO_FRESHNESS_POLL_MS * 2);
  assert.equal(harness.calls.filter(call => call.url).length, 2);

  harness.documentRef.visibilityState = 'visible';
  harness.documentRef.dispatchEvent(new Event('visibilitychange'));
  assert.equal(harness.calls.filter(call => call.url).length, 3);
  await harness.monitor.checkNow();

  harness.windowRef.dispatchEvent(new Event('focus'));
  assert.equal(harness.calls.filter(call => call.url).length, 4);
  await harness.monitor.checkNow();
  harness.monitor.stop();
  assert.equal(harness.timers.count(), 0);
});

test('freshness reports bounded unknown state offline and retries immediately online', async () => {
  const harness = monitorHarness();
  harness.navigatorRef.onLine = false;
  await harness.monitor.start();
  assert.deepEqual(harness.monitor.getState(), {
    status: 'unknown',
    buildId: harness.running.buildId,
    buildNumber: harness.running.buildNumber,
    reason: 'offline',
  });
  assert.equal(harness.calls.filter(call => call.url).length, 0);

  harness.navigatorRef.onLine = true;
  harness.windowRef.dispatchEvent(new Event('online'));
  assert.equal(harness.calls.filter(call => call.url).length, 1);
  await harness.monitor.checkNow();
  assert.equal(harness.monitor.getState().status, 'current');
  harness.monitor.stop();
});

test('freshness coalesces requests and rejects timeout, invalid, redirected, or cacheable markers without reload', async () => {
  let resolveFetch;
  let fetches = 0;
  const pending = new Promise(resolve => { resolveFetch = resolve; });
  const harness = monitorHarness({
    fetchImpl: async () => { fetches += 1; return pending; },
  });
  const first = harness.monitor.checkNow();
  const second = harness.monitor.checkNow();
  assert.equal(fetches, 1);
  resolveFetch(responseFor(harness.running));
  await Promise.all([first, second]);
  assert.equal(harness.monitor.getState().status, 'current');

  for (const [responseValue, reason] of [
    [responseFor(harness.running, { status: 302 }), 'response'],
    [responseFor(harness.running, { headers: {} }), 'cache'],
    [responseFor(harness.running, { body: '{broken' }), 'invalid'],
  ]) {
    const failing = monitorHarness({ fetchImpl: async () => responseValue });
    await failing.monitor.checkNow();
    assert.deepEqual(failing.monitor.getState(), {
      status: 'unknown', buildId: failing.running.buildId, buildNumber: failing.running.buildNumber, reason,
    });
  }

  const timeout = monitorHarness({
    createTimeoutSignal: milliseconds => {
      assert.equal(milliseconds, STUDIO_FRESHNESS_TIMEOUT_MS);
      return AbortSignal.abort();
    },
    fetchImpl: async (_url, init) => {
      if (init.signal.aborted) throw new DOMException('aborted', 'AbortError');
      return responseFor(harness.running);
    },
  });
  await timeout.monitor.checkNow();
  assert.equal(timeout.monitor.getState().reason, 'request');
});

test('freshness flushes autosave and records the revision pair before one reload', async () => {
  const running = release('a');
  const remote = release('b');
  const order = [];
  const harness = monitorHarness({
    release: running,
    fetchImpl: readyReleaseFetch(remote),
    flushAutosave: () => { order.push('autosave'); return true; },
    reload: () => order.push('reload'),
  });
  await harness.monitor.checkNow();
  assert.deepEqual(order, ['autosave', 'reload']);
  assert.deepEqual(JSON.parse(harness.storage.getItem(STUDIO_REFRESH_ATTEMPT_KEY)), {
    from: running.sourceRevision,
    to: remote.sourceRevision,
  });
});

test('freshness waits for the current no-store graph and every listed asset before reloading', async () => {
  const running = release('a');
  const remote = release('b');
  const graph = buildGraphFor(remote, ['assets/main-current.js', 'assets/main-current.css']);
  let graphRequests = 0;
  let assetRound = 0;
  let reloads = 0;
  const calls = [];
  const harness = monitorHarness({
    release: running,
    fetchImpl: async (url, init) => {
      const pathname = new URL(url).pathname;
      calls.push({ pathname, init });
      if (pathname === '/studio-release.json') return responseFor(remote);
      if (pathname === '/studio-build-graph.json') {
        graphRequests += 1;
        if (graphRequests === 1) {
          return responseFor(graph, { headers: { 'cache-control': 'public, max-age=60' } });
        }
        assetRound += 1;
        return responseFor(graph);
      }
      if (pathname === '/assets/main-current.css' && assetRound === 1) {
        return new Response('Not found', { status: 404 });
      }
      if (pathname.startsWith('/assets/')) return new Response('ready', { status: 200 });
      throw new Error(`Unexpected freshness URL: ${url}`);
    },
    reload: () => { reloads += 1; },
  });

  await harness.monitor.checkNow();
  assert.equal(reloads, 0, 'a cacheable graph must not authorize reload');

  await harness.monitor.checkNow();
  assert.equal(reloads, 0, 'a graph-listed asset returning 404 must not authorize reload');

  await harness.monitor.checkNow();
  assert.equal(reloads, 1, 'a later fully converged check may reload once');
  assert.equal(graphRequests, 3);
  assert.equal(
    calls.filter(call => call.pathname === '/assets/main-current.js').length,
    2,
    'every graph-listed JavaScript asset is probed on each no-store graph check',
  );
  assert.equal(
    calls.filter(call => call.pathname === '/assets/main-current.css').length,
    2,
    'every graph-listed CSS asset is probed on each no-store graph check',
  );
  assert.ok(
    calls.filter(call => call.pathname === '/studio-build-graph.json')
      .every(call => call.init.cache === 'no-store' && call.init.redirect === 'manual'),
  );
});

test('freshness defers one target until all protected hardware operations clear', async () => {
  const running = release('a');
  const remote = release('b');
  let reloads = 0;
  const harness = monitorHarness({
    release: running,
    fetchImpl: readyReleaseFetch(remote),
    reload: () => { reloads += 1; },
  });
  harness.monitor.setOperationActive(true);
  await harness.monitor.checkNow();
  assert.deepEqual(harness.monitor.getState(), {
    status: 'update-ready', buildId: remote.buildId, buildNumber: remote.buildNumber, reason: 'operation-active',
  });
  assert.equal(reloads, 0);
  await harness.monitor.setOperationActive(false);
  assert.equal(reloads, 1);
});

test('ending a protected operation revalidates the newest marker instead of reloading a stale pending release', async () => {
  const running = release('a');
  const firstRemote = release('b');
  const newestRemote = release('c');
  let target = firstRemote;
  let assetsReady = true;
  let reloads = 0;
  const harness = monitorHarness({
    release: running,
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === '/studio-release.json') return responseFor(target);
      if (pathname === '/studio-build-graph.json') return responseFor(buildGraphFor(target));
      if (pathname.startsWith('/assets/')) {
        return new Response(assetsReady ? 'ready' : 'not found', { status: assetsReady ? 200 : 404 });
      }
      throw new Error(`Unexpected freshness URL: ${url}`);
    },
    reload: () => { reloads += 1; },
  });

  harness.monitor.setOperationActive(true);
  await harness.monitor.checkNow();
  assert.equal(harness.monitor.getState().status, 'update-ready');

  target = newestRemote;
  assetsReady = false;
  await harness.monitor.checkNow();
  assert.equal(harness.monitor.getState().reason, 'convergence');

  await harness.monitor.setOperationActive(false);
  assert.equal(reloads, 0, 'ending protection must not reload the older pending release');

  assetsReady = true;
  await harness.monitor.checkNow();
  assert.equal(reloads, 1);
  assert.deepEqual(JSON.parse(harness.storage.getItem(STUDIO_REFRESH_ATTEMPT_KEY)), {
    from: running.sourceRevision,
    to: newestRemote.sourceRevision,
  });
});

test('an unchanged pending marker is not re-probed until protected work ends', async () => {
  const running = release('a');
  const remote = release('b');
  const graph = buildGraphFor(remote);
  let graphRequests = 0;
  let reloads = 0;
  const harness = monitorHarness({
    release: running,
    fetchImpl: async url => {
      const pathname = new URL(url).pathname;
      if (pathname === '/studio-release.json') return responseFor(remote);
      if (pathname === '/studio-build-graph.json') {
        graphRequests += 1;
        return responseFor(graph);
      }
      if (pathname.startsWith('/assets/')) return new Response('ready', { status: 200 });
      throw new Error(`Unexpected freshness URL: ${url}`);
    },
    reload: () => { reloads += 1; },
  });

  harness.monitor.setOperationActive(true);
  await harness.monitor.checkNow();
  await harness.monitor.checkNow();
  assert.equal(graphRequests, 1, 'the same pending release should reuse its convergence proof');
  assert.equal(reloads, 0);

  await harness.monitor.setOperationActive(false);
  assert.equal(graphRequests, 2, 'ending protection must obtain a fresh convergence proof');
  assert.equal(reloads, 1);
});

test('freshness refuses reload on autosave/storage failure and prevents a same-pair reload loop', async () => {
  const running = release('a');
  const remote = release('b');
  const pair = JSON.stringify({ from: running.sourceRevision, to: remote.sourceRevision });
  for (const options of [
    { flushAutosave: () => false },
    { storage: { getItem: () => null, setItem: () => { throw new Error('blocked'); }, removeItem() {} } },
    { storage: memoryStorage({ [STUDIO_REFRESH_ATTEMPT_KEY]: pair }) },
  ]) {
    let reloads = 0;
    const harness = monitorHarness({
      release: running,
      fetchImpl: readyReleaseFetch(remote),
      reload: () => { reloads += 1; },
      ...options,
    });
    await harness.monitor.checkNow();
    assert.equal(reloads, 0);
    assert.equal(harness.monitor.getState().status, 'unknown');
  }
});

test('a matching production build clears stale reload-loop protection', async () => {
  const running = release('a');
  const storage = memoryStorage({
    [STUDIO_REFRESH_ATTEMPT_KEY]: JSON.stringify({
      from: release('b').sourceRevision,
      to: running.sourceRevision,
    }),
  });
  const harness = monitorHarness({ release: running, storage });
  await harness.monitor.checkNow();
  assert.equal(storage.getItem(STUDIO_REFRESH_ATTEMPT_KEY), null);
  assert.equal(harness.monitor.getState().status, 'current');
});
