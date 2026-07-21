import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const sourcePath = path.resolve(import.meta.dirname, '../src/LightweaverWeb.cpp');
const source = fs.readFileSync(sourcePath, 'utf8');

assert.match(source, /id='control-error'/, 'visitor page should include a compact inline control error');
assert.match(source, /id='control-retry'[^>]*>Retry</, 'visitor error should offer Retry');
assert.match(source, /\.control-error\{[^}]*display:none/, 'control error should stay compact when idle');
assert.match(source, /\.grid\.pending \.tile\{[^}]*pointer-events:none/, 'pending scene changes should disable scene tiles');
assert.match(source, /'b-slider'\)\.disabled=on/, 'pending brightness changes should disable the slider');
assert.match(source, /'off-btn'\)\.disabled=on/, 'pending blackout changes should disable the blackout button');
assert.match(source, /payload\.ok!==true/, 'controls should commit only after an explicit card acknowledgement');

const visitorInitStart = source.indexOf('"(async()=>{try{', source.indexOf('/*LW_CONFIRMED_CONTROL_END*/'));
const visitorInitEnd = source.indexOf('// Streaming-state poll.', visitorInitStart);
assert.notEqual(visitorInitStart, -1, 'visitor page should define its initial state hydration');
assert.notEqual(visitorInitEnd, -1, 'visitor hydration should end before status polling');
const visitorInit = source.slice(visitorInitStart, visitorInitEnd);
assert.match(visitorInit, /get\('\/api\/zones'\)/,
  'visitor controls should hydrate from the read-only zones snapshot');
assert.doesNotMatch(visitorInit, /post\('\/api\/control',\{\}\)/,
  'visitor hydration must not issue an empty mutating control request');
for (const field of [
  'blackout',
  'brightness',
  'speed',
  'hueShift',
  'customHue',
  'customSaturation',
  'customBreathe',
  'customDrift',
  'driftHueMin',
  'driftHueMax',
]) {
  assert.match(visitorInit, new RegExp(`\\b${field}\\b`),
    `visitor hydration should consume zones.${field}`);
}

const startMarker = '/*LW_CONFIRMED_CONTROL_START*/';
const endMarker = '/*LW_CONFIRMED_CONTROL_END*/';
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker);
assert.notEqual(start, -1, 'embedded visitor page should define the confirmed-control state machine');
assert.notEqual(end, -1, 'embedded visitor confirmed-control state machine should have an extraction boundary');

const cxxFragment = source.slice(start + startMarker.length, end);
const stringParts = [...cxxFragment.matchAll(/"((?:\\.|[^"\\])*)"/g)].map(([, body]) =>
  JSON.parse(`"${body.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1')}"`),
);
const embeddedJs = stringParts.join('');

const errors = [];
const context = {
  showControlError(message, retry) {
    errors.push({ message, retry });
  },
  clearControlError() {
    errors.push({ cleared: true });
  },
};
vm.createContext(context);
vm.runInContext(`${embeddedJs};globalThis.makeConfirmedControl=makeConfirmedControl`, context);

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const makeHarness = (initial, description = 'change scene') => {
  const rendered = [];
  const disabled = [];
  const requests = [];
  const control = context.makeConfirmedControl({
    initial,
    render: value => rendered.push(value),
    setDisabled: value => disabled.push(value),
    send: value => {
      const request = deferred();
      requests.push({ value, ...request });
      return request.promise;
    },
    description,
  });
  return { control, rendered, disabled, requests };
};

const makeSceneHarness = () => {
  const events = [];
  const sceneTiles = [{ 'aria-disabled': 'false' }, { 'aria-disabled': 'false' }];
  let pending = false;
  const requests = [];
  const control = context.makeConfirmedControl({
    initial: 'previous-confirmed',
    description: 'change scene',
    render: value => {
      for (const tile of sceneTiles) tile['aria-disabled'] = String(pending);
      events.push(`render:${value}`);
    },
    setDisabled: value => {
      pending = value;
      events.push(value ? 'disabled' : 'enabled');
    },
    send: value => {
      const request = deferred();
      requests.push({ value, ...request });
      return request.promise;
    },
  });
  return { control, events, sceneTiles, requests };
};

{
  const h = makeSceneHarness();
  const operation = h.control.request('confirmed');
  h.requests[0].resolve({ ok: true });
  await operation;
  const successEvents = h.events;
  assert.deepEqual(successEvents.slice(-2), ['enabled', 'render:confirmed']);
  assert.deepEqual(h.sceneTiles.map(tile => tile['aria-disabled']), ['false', 'false'], 'scene tiles should be enabled after confirmation');
}

{
  const h = makeSceneHarness();
  const operation = h.control.request('failed-intent');
  h.requests[0].reject(new Error('offline'));
  await operation;
  const failureEvents = h.events;
  assert.deepEqual(failureEvents.slice(-2), ['enabled', 'render:previous-confirmed']);
  assert.deepEqual(h.sceneTiles.map(tile => tile['aria-disabled']), ['false', 'false'], 'scene tiles should be enabled after rollback');

  const retry = errors.at(-1).retry;
  const retryOperation = retry();
  h.requests[1].resolve({ ok: true });
  await retryOperation;
  assert.deepEqual(h.sceneTiles.map(tile => tile['aria-disabled']), ['false', 'false'], 'scene tiles should be enabled after Retry succeeds');
}

for (const [name, initial, next] of [
  ['scene', 'aurora', 'ocean'],
  ['brightness', 0.8, 0.35],
  ['blackout', false, true],
]) {
  const h = makeHarness(initial, `change ${name}`);
  const operation = h.control.request(next);
  assert.equal(h.control.snapshot().state, 'pending', `${name} should enter pending state`);
  assert.equal(h.rendered.at(-1), next, `${name} should optimistically preview the requested value`);
  assert.equal(h.disabled.at(-1), true, `${name} should disable its conflicting control while pending`);
  h.requests[0].resolve({ ok: true });
  await operation;
  assert.deepEqual(
    { ...h.control.snapshot() },
    { state: 'confirmed', confirmed: next, failed: null, activeRequest: 1 },
    `${name} should commit the acknowledged value`,
  );
  assert.equal(h.disabled.at(-1), false, `${name} should re-enable its control after confirmation`);
}

for (const [name, initial, next] of [
  ['scene', 'aurora', 'ocean'],
  ['brightness', 0.8, 0.35],
  ['blackout', false, true],
]) {
  const h = makeHarness(initial, `change ${name}`);
  const operation = h.control.request(next);
  h.requests[0].reject(new Error('offline'));
  await operation;
  assert.equal(h.rendered.at(-1), initial, `${name} should roll back to its last confirmed value on failure`);
  assert.equal(h.control.snapshot().state, 'failed', `${name} should retain failed state for recovery`);
  assert.equal(h.control.snapshot().failed, next, `${name} should retain failed intent for Retry`);
  assert.equal(h.disabled.at(-1), false, `${name} should re-enable its control after rollback`);
  assert.match(errors.at(-1).message, new RegExp(`change ${name}`, 'i'), `${name} error should name the failed action`);
}

{
  const h = makeHarness('aurora');
  const operation = h.control.request('fire');
  h.requests[0].reject(new Error('offline'));
  await operation;
  assert.equal(h.rendered.at(-1), 'aurora', 'failed optimistic scene should roll back to last confirmed scene');
  assert.equal(h.control.snapshot().state, 'failed', 'failed request should remain visibly failed');
  assert.equal(h.control.snapshot().failed, 'fire', 'failed request should retain the value for Retry');
  assert.match(errors.at(-1).message, /change scene/i, 'inline error should name the failed action');

  const retry = errors.at(-1).retry;
  const retryOperation = retry();
  assert.equal(h.requests[1].value, 'fire', 'Retry should resend the failed intent');
  h.requests[1].resolve({ ok: true });
  await retryOperation;
  assert.equal(h.control.snapshot().confirmed, 'fire', 'successful Retry should confirm the retained intent');
}

{
  const h = makeHarness(1, 'change brightness');
  const older = h.control.request(0.4);
  const newer = h.control.request(0.7);
  h.requests[1].resolve({ ok: true });
  await newer;
  h.requests[0].reject(new Error('late failure'));
  await older;
  assert.equal(h.control.snapshot().confirmed, 0.7, 'superseded failure must not overwrite newer confirmed intent');
  assert.equal(h.rendered.at(-1), 0.7, 'stale response must not roll the visible control back');
  assert.equal(h.control.snapshot().activeRequest, 2, 'responses should be associated with the active request');
}

console.log('visitor-control-rollback tests passed');
