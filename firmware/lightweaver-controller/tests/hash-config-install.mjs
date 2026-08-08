import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = readFileSync(resolve(here, '../src/LightweaverWeb.cpp'), 'utf8');

const installLiterals = [...web.matchAll(/"const installFromHash=.*?;"/g)]
  .map(match => JSON.parse(match[0]));
assert.equal(installLiterals.length, 2,
  'both card page variants should embed the config-hash installer');
assert.equal(installLiterals[0], installLiterals[1],
  'both card page variants should use the same config-hash transaction behavior');

assert.equal(
  (web.match(/window\.addEventListener\('hashchange',installFromHash\);installFromHash\(\);/g) || []).length,
  2,
  'both pages should process the initial hash and later hashes in a reused named card window',
);

function encoded(value) {
  return Buffer.from(value).toString('base64url');
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function harness() {
  const fetches = [];
  const handoffs = [];
  const historyCalls = [];
  const timers = [];
  const context = {
    URLSearchParams,
    Promise,
    Map,
    location: { hash: '', pathname: '/', search: '' },
    history: { replaceState: (...args) => historyCalls.push(args) },
    showHandoff: (...args) => handoffs.push(args),
    b64urlDecode: value => Buffer.from(value, 'base64url').toString(),
    fetch: (...args) => {
      const response = deferred();
      fetches.push({ args, response });
      return response.promise;
    },
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    post: async () => ({ ok: true }),
  };
  vm.createContext(context);
  vm.runInContext(
    `let hashInstallTail=Promise.resolve();const hashInstallFlights=new Map();${installLiterals[0]};globalThis.runHashInstall=installFromHash`,
    context,
  );
  return { context, fetches, handoffs, historyCalls, timers };
}

const firstConfig = JSON.stringify({ project: 'first' });
const secondConfig = JSON.stringify({ project: 'second' });
const firstHash = `#lwconfig=${encoded(firstConfig)}&reboot=1`;
const secondHash = `#lwconfig=${encoded(secondConfig)}`;

{
  const h = harness();
  h.context.location.hash = firstHash;
  const first = h.context.runHashInstall();
  const duplicate = h.context.runHashInstall();
  await Promise.resolve();
  assert.equal(first, duplicate,
    'the same payload should share one in-flight installation promise');
  assert.equal(h.fetches.length, 1,
    'the same in-flight payload should only POST once');

  h.context.location.hash = secondHash;
  const second = h.context.runHashInstall();
  await Promise.resolve();
  assert.equal(h.fetches.length, 1,
    'a later hash should wait for the current card write to settle');

  h.fetches[0].response.resolve({ ok: true, json: async () => ({ ok: true, state: 'staged' }) });
  await first;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.historyCalls.length, 0,
    'completion of an older install must not erase a newer hash');
  assert.equal(h.timers.length, 0,
    'staged wiring must never auto-reboot or advance the safety transaction');
  assert.equal(h.fetches.length, 2,
    'the queued hash should POST after the first transaction settles');

  h.fetches[1].response.resolve({ ok: true, json: async () => ({ ok: true, requiresReboot: false }) });
  await second;
  assert.equal(h.fetches[1].args[1].body, secondConfig,
    'hashchange installation should send the new payload');
}

{
  const h = harness();
  h.context.location.hash = firstHash;
  const install = h.context.runHashInstall();
  await Promise.resolve();
  h.fetches[0].response.resolve({ ok: true, json: async () => ({ ok: true, requiresReboot: true }) });
  await install;
  const savedAt = h.handoffs.findIndex(([message]) => message === 'Saved on the card.');
  assert.ok(savedAt >= 0, 'successful non-staged installs should be acknowledged');
  assert.equal(h.timers.length, 1, 'an explicitly requested reboot should remain deferred');
  assert.equal(h.timers[0].delay, 300, 'the existing reboot settle delay should remain exact');
  assert.equal(h.historyCalls.length, 1, 'the consumed hash should be cleared after success');
}

{
  const h = harness();
  const payload = encoded(firstConfig);
  h.context.location.hash = `#lwconfig=${payload}`;
  const first = h.context.runHashInstall();
  await Promise.resolve();
  h.context.location.hash = `#lwconfig=${payload}&reboot=1`;
  const changedParams = h.context.runHashInstall();
  assert.equal(changedParams, first,
    'changed hash parameters should still deduplicate the same in-flight config');
  h.fetches[0].response.resolve({ ok: true, json: async () => ({ ok: true, requiresReboot: true }) });
  await first;
  assert.equal(h.fetches.length, 1,
    'changed parameters must not POST identical config bytes twice');
  assert.equal(h.historyCalls.length, 1,
    'success should consume the current hash when its lwconfig payload was accepted');
  assert.equal(h.timers.length, 1,
    'success should honor reboot intent from the current matching hash');
}

{
  const h = harness();
  h.context.location.hash = firstHash;
  const rejected = h.context.runHashInstall();
  await Promise.resolve();
  h.fetches[0].response.resolve({
    ok: false,
    status: 409,
    json: async () => ({ ok: false, error: 'transaction active', requiresReboot: true }),
  });
  await rejected;
  assert.equal(h.context.location.hash, firstHash,
    'a non-OK card response should retain the hash for retry');
  assert.equal(h.historyCalls.length, 0,
    'a non-OK card response must return before consuming the hash');
  assert.equal(h.timers.length, 0,
    'a non-OK card response must return before scheduling reboot');
  await new Promise(resolve => setImmediate(resolve));
  h.context.runHashInstall();
  await Promise.resolve();
  assert.equal(h.fetches.length, 2,
    'a later invocation should retry after a non-OK response');
}

{
  const h = harness();
  h.context.location.hash = firstHash;
  const failed = h.context.runHashInstall();
  await Promise.resolve();
  h.fetches[0].response.reject(new Error('network down'));
  await failed;
  assert.equal(h.context.location.hash, firstHash,
    'a rejected fetch should retain the hash for retry');
  assert.equal(h.historyCalls.length, 0,
    'a rejected fetch should not consume the hash');
  assert.equal(h.timers.length, 0,
    'a rejected fetch should not schedule reboot');
  await new Promise(resolve => setImmediate(resolve));
  h.context.runHashInstall();
  await Promise.resolve();
  assert.equal(h.fetches.length, 2,
    'a later invocation should retry after a rejected fetch');
}

assert.doesNotMatch(
  installLiterals[0],
  /wiring\/(?:activate|confirm|rollback)/,
  'hash installation must only stage wiring; activation remains an explicit Studio action',
);

console.log('hash-config-install tests passed');
